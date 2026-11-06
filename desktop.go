package main

import (
	_ "embed"
	"log"
	"net/url"
	"runtime"
	"strings"
	"sync"

	"github.com/egoist/mygo"
)

// 托盘图标编进二进制，安装包里不必带额外文件。
//
//go:embed resources/tray.png
var trayPNG []byte

// 本文件把应用接成「桌面应用」而不是一个网页：应用菜单、托盘图标、
// 单实例、关闭到托盘、深链导入。前端只负责界面，桌面集成的入口都在这里，
// 通过 desktop:command 事件把动作转给页面执行。

// DesktopCommand 是桌面集成发给页面的指令。
type DesktopCommand struct {
	// Action 是页面要执行的动作：new-request、import-curl、save、
	// toggle-sidebar、command-palette、open-env、open-settings、
	// toggle-theme、about。
	Action string `json:"action"`
	// Text 是随动作带过去的内容，例如深链里的 cURL 命令。
	Text string `json:"text,omitempty"`
}

// desktopEvent 声明桌面指令事件，`mygo generate` 会在 src/mygo.ts 里生成
// 对应的类型与订阅入口。
var desktopEvent = mygo.NewEvent[DesktopCommand]("desktop:command")

// DesktopPrefs 是桌面外壳的偏好，和业务数据一起存在 SQLite 的 settings 表里：
// Go 侧只保留内存里的当前值，真正的持久化由页面写库完成。
type DesktopPrefs struct {
	CloseToTray bool `json:"closeToTray"`
}

// desktopPrefsEvent 把用户在图钉菜单里改过的偏好通知给页面，由页面写库。
var desktopPrefsEvent = mygo.NewEvent[DesktopPrefs]("desktop:prefs")

var (
	deskMu         sync.Mutex
	prefs          = DesktopPrefs{CloseToTray: true}
	mainWin        *mygo.Window
	tray           *mygo.Tray
	trayReady      bool
	trayItem       *mygo.MenuItem
	quitting       bool
	desktopReady   bool
	desktopInitErr error
)

// sendDesktop 把指令发给主窗口的页面。窗口还没建好（例如深链在启动时到达）
// 时先丢掉，页面启动后会自己从命令行参数里再取一次。
func sendDesktop(cmd DesktopCommand) {
	win := currentWindow()
	if win == nil {
		return
	}
	if err := desktopEvent.Emit(win, cmd); err != nil {
		log.Printf("发送桌面指令失败：%v", err)
	}
}

// currentWindow 返回主窗口，没有或已销毁时返回 nil。
func currentWindow() *mygo.Window {
	deskMu.Lock()
	defer deskMu.Unlock()
	if mainWin == nil || mainWin.IsDestroyed() {
		return nil
	}
	return mainWin
}

// showMainWindow 把主窗口带到前台：没有窗口就新建一个，最小化则还原。
func showMainWindow() {
	win := currentWindow()
	if win == nil {
		openMainWindow()
		return
	}
	if win.IsMinimized() {
		win.Restore()
	}
	win.Show()
	win.Focus()
}

// openMainWindow 创建主窗口，并接管「关闭」：开启「关闭到托盘」时改为隐藏，
// 这样托盘里的「显示主窗口」还能把它带回来。
func openMainWindow() {
	win := mygo.NewWindow(mygo.WindowOptions{
		Title:           "MyGo API",
		Width:           1320,
		Height:          860,
		MinWidth:        920,
		MinHeight:       580,
		BackgroundColor: "light-dark(#f4f5f7, #0d0e12)",
		// 记住上次的窗口位置与大小。
		StateKey: "main",
		URL:      "/",
	})
	deskMu.Lock()
	mainWin = win
	deskMu.Unlock()
	// 关闭策略只有一处：是否拦下关闭在事件里现读，托盘开关改完立即生效。
	win.OnClose(func(e *mygo.CloseEvent) {
		if shouldHideOnClose() {
			e.PreventDefault()
			win.Hide()
		}
	})
}

func isQuitting() bool {
	deskMu.Lock()
	defer deskMu.Unlock()
	return quitting
}

// shouldHideOnClose 报告这次关闭是否应该退到托盘：正在退出、没有托盘可回、
// 或用户关掉了这个选项时都返回 false，关闭照常进行。
func shouldHideOnClose() bool {
	deskMu.Lock()
	defer deskMu.Unlock()
	return !quitting && trayReady && prefs.CloseToTray
}

// setCloseToTray 切换「关闭窗口时最小化到托盘」。窗口的关闭处理现读这个值，
// 所以不需要重新注册监听；勾选项同时同步到托盘的 checkbox，并通知页面写库。
func setCloseToTray(on bool) {
	deskMu.Lock()
	prefs.CloseToTray = on
	item := trayItem
	ready := desktopReady
	win := mainWin
	deskMu.Unlock()
	if item != nil {
		item.SetChecked(on)
	}
	if ready && win != nil {
		if err := desktopPrefsEvent.Emit(win, DesktopPrefs{CloseToTray: on}); err != nil {
			log.Printf("同步桌面偏好失败：%v", err)
		}
	}
}

// ApplyDesktopPrefs 由页面在启动时调用，把 SQLite 里存的偏好交给桌面外壳。
// 不写库、也不再回发事件，避免启动时自激。
func (s *System) ApplyDesktopPrefs(closeToTray bool) error {
	deskMu.Lock()
	prefs.CloseToTray = closeToTray
	item := trayItem
	deskMu.Unlock()
	if item != nil {
		item.SetChecked(closeToTray)
	}
	return nil
}

// quitApp 真正退出应用，绕过「关闭到托盘」的拦截。
func quitApp() {
	deskMu.Lock()
	quitting = true
	deskMu.Unlock()
	mygo.App.Quit()
}

// buildAppMenu 构造中文应用菜单。角色项负责编辑与窗口行为，本应用自己的
// 动作统一发给页面执行，保证菜单、快捷键、界面三处行为只有一份实现。
func buildAppMenu() *mygo.Menu {
	items := []*mygo.MenuItem{{Role: mygo.RoleAppMenu}}
	// macOS 的应用菜单已含「关于」与「退出」，其他平台放在文件与帮助菜单里。
	if runtime.GOOS != "darwin" {
		items = append(items, &mygo.MenuItem{Label: "文件", Submenu: []*mygo.MenuItem{
			{Label: "新建请求", Accelerator: "CmdOrCtrl+N", Click: cmdItem("new-request", "")},
			{Label: "导入 cURL…", Accelerator: "CmdOrCtrl+I", Click: cmdItem("import-curl", "")},
			{Label: "保存到集合…", Accelerator: "CmdOrCtrl+S", Click: cmdItem("save", "")},
			mygo.Separator(),
			{Label: "收起 / 展开侧边栏", Accelerator: "CmdOrCtrl+B", Click: cmdItem("toggle-sidebar", "")},
			mygo.Separator(),
			// Ctrl+W 留给「关标签页」：这是浏览器与各类编辑器里最牢固的肌肉记忆，
			// 关窗口必须另找组合键，否则用户关标签总会把整个窗口收进托盘。
			{Label: "关闭当前标签页", Accelerator: "CmdOrCtrl+W", Click: cmdItem("close-tab", "")},
			{Role: mygo.RoleClose, Label: "关闭窗口", Accelerator: "CmdOrCtrl+Shift+W"},
			{Label: "退出 MyGo API", Click: func(*mygo.MenuItem, *mygo.Window) { quitApp() }},
		}})
	}
	items = append(items,
		&mygo.MenuItem{Label: "编辑", Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleUndo, Label: "撤销"},
			{Role: mygo.RoleRedo, Label: "重做"},
			mygo.Separator(),
			{Role: mygo.RoleCut, Label: "剪切"},
			{Role: mygo.RoleCopy, Label: "复制"},
			{Role: mygo.RolePaste, Label: "粘贴"},
			{Role: mygo.RoleDelete, Label: "删除"},
			mygo.Separator(),
			{Role: mygo.RoleSelectAll, Label: "全选"},
		}},
		&mygo.MenuItem{Label: "视图", Submenu: []*mygo.MenuItem{
			{Label: "命令面板…", Accelerator: "CmdOrCtrl+K", Click: cmdItem("command-palette", "")},
			{Label: "管理环境…", Accelerator: "CmdOrCtrl+E", Click: cmdItem("open-env", "")},
			{Label: "设置…", Accelerator: "CmdOrCtrl+,", Click: cmdItem("open-settings", "")},
			{Label: "切换深色 / 浅色", Click: cmdItem("toggle-theme", "")},
			mygo.Separator(),
			{Role: mygo.RoleReload, Label: "重新加载界面"},
			{Role: mygo.RoleToggleDevTools, Label: "开发者工具"},
			mygo.Separator(),
			{Role: mygo.RoleResetZoom, Label: "实际大小"},
			{Role: mygo.RoleZoomIn, Label: "放大"},
			{Role: mygo.RoleZoomOut, Label: "缩小"},
			mygo.Separator(),
			{Role: mygo.RoleToggleFullScreen, Label: "全屏"},
		}},
	)
	if runtime.GOOS == "darwin" {
		items = append(items, &mygo.MenuItem{Role: mygo.RoleWindowMenu})
	}
	items = append(items, &mygo.MenuItem{Label: "帮助", Submenu: []*mygo.MenuItem{
		{Label: "关于 MyGo API", Click: func(*mygo.MenuItem, *mygo.Window) {
			showAbout()
		}},
		{Label: "打开数据目录", Click: func(*mygo.MenuItem, *mygo.Window) {
			openDataDir()
		}},
	}})
	return mygo.NewMenu(items)
}

// cmdItem 把菜单项变成一条发给页面的指令。
func cmdItem(action, text string) func(*mygo.MenuItem, *mygo.Window) {
	return func(*mygo.MenuItem, *mygo.Window) {
		sendDesktop(DesktopCommand{Action: action, Text: text})
	}
}

// showAbout 打开系统标准的「关于」面板。
func showAbout() {
	mygo.App.ShowAboutPanel(mygo.AboutPanelOptions{
		ApplicationName:    mygo.App.Name(),
		ApplicationVersion: mygo.App.Version(),
		Copyright:          "本地轻量级 HTTP 调试工具",
		Credits:            "纯本地运行，数据只保存在这台机器上。",
	})
}

// buildTrayMenu 构造托盘菜单：常用动作 + 「关闭到托盘」开关 + 退出。
func buildTrayMenu() *mygo.Menu {
	deskMu.Lock()
	checked := prefs.CloseToTray
	deskMu.Unlock()
	trayItem = &mygo.MenuItem{
		Label:   "关闭窗口时最小化到托盘",
		Type:    mygo.MenuItemCheckbox,
		Checked: checked,
		Click: func(item *mygo.MenuItem, _ *mygo.Window) {
			setCloseToTray(item.Checked)
		},
	}
	return mygo.NewMenu([]*mygo.MenuItem{
		{Label: "显示主窗口", Click: func(*mygo.MenuItem, *mygo.Window) { showMainWindow() }},
		mygo.Separator(),
		{Label: "新建请求", Click: func(*mygo.MenuItem, *mygo.Window) {
			sendDesktop(DesktopCommand{Action: "new-request"})
		}},
		{Label: "导入 cURL…", Click: func(*mygo.MenuItem, *mygo.Window) {
			sendDesktop(DesktopCommand{Action: "import-curl"})
		}},
		mygo.Separator(),
		trayItem,
		mygo.Separator(),
		{Label: "退出 MyGo API", Click: func(*mygo.MenuItem, *mygo.Window) { quitApp() }},
	})
}

// setupTray 创建托盘图标。系统不支持时（例如 Linux 缺少 AppIndicator），
// 应用照常使用，只是没有托盘，也随之关掉「关闭到托盘」。
func setupTray() {
	var err error
	tray, err = mygo.NewTray(mygo.TrayOptions{
		ID:             "main",
		Icon:           trayPNG,
		IconIsTemplate: false,
		ToolTip:        "MyGo API",
		Menu:           buildTrayMenu(),
	})
	if err != nil {
		log.Printf("创建托盘失败：%v", err)
		tray = nil
		return
	}
	// Windows 上左键单击图标只上报点击、不弹菜单（菜单走右键），所以直接单击就能回到窗口；
	// macOS 有菜单时由系统先弹菜单，用户从菜单里选「显示主窗口」。
	tray.OnClick(func() { showMainWindow() })
	trayReady = true
}

// openDataDir 用系统文件管理器打开用户数据目录。
func openDataDir() {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		log.Printf("打开数据目录失败：%v", err)
		return
	}
	if err := mygo.Shell.OpenPath(dir); err != nil {
		log.Printf("打开数据目录失败：%v", err)
	}
}

// parseDeepLink 把 mygo-api:// 深链转成一条页面指令：
//
//	mygo-api://import?curl=<URL 编码的 cURL 命令>
//	mygo-api://new
//	mygo-api://settings
func parseDeepLink(raw string) (DesktopCommand, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !strings.EqualFold(u.Scheme, "mygo-api") {
		return DesktopCommand{}, false
	}
	switch strings.ToLower(u.Host) {
	case "import":
		curlText := u.Query().Get("curl")
		if strings.TrimSpace(curlText) == "" {
			return DesktopCommand{}, false
		}
		return DesktopCommand{Action: "import-curl", Text: curlText}, true
	case "new":
		return DesktopCommand{Action: "new-request"}, true
	case "settings":
		return DesktopCommand{Action: "open-settings"}, true
	}
	return DesktopCommand{}, false
}

// handleDeepLink 处理从浏览器「用 MyGo API 打开」或第二个实例传来的深链。
func handleDeepLink(raw string) {
	cmd, ok := parseDeepLink(raw)
	if !ok {
		return
	}
	// 先把窗口带到前面，再把命令交给页面，浮层才有地方出现。
	showMainWindow()
	enqueueDesktop(cmd)
}

// 深链可能比页面更早到（首次启动），先排队，页面就绪后统一发送。
var pendingDesktop []DesktopCommand

func enqueueDesktop(cmd DesktopCommand) {
	deskMu.Lock()
	ready := desktopReady
	if !ready {
		pendingDesktop = append(pendingDesktop, cmd)
	}
	deskMu.Unlock()
	if ready {
		sendDesktop(cmd)
	}
}

// markDesktopReady 通知桌面层页面已经加载，可以接收排队的指令。
func markDesktopReady() {
	deskMu.Lock()
	desktopReady = true
	queued := pendingDesktop
	pendingDesktop = nil
	deskMu.Unlock()
	for _, cmd := range queued {
		sendDesktop(cmd)
	}
}

// setupDesktop 装配桌面集成：菜单、托盘、关闭行为、深链与单实例回调。
// 在应用就绪后调用一次。
func setupDesktop() {
	mygo.App.SetMenu(buildAppMenu())
	setupTray()
}

// setupAppHooks 注册应用级监听，必须在 Run 之前调用。
func setupAppHooks() {
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) {
		deskMu.Lock()
		quitting = true
		deskMu.Unlock()
	})
	mygo.App.OnSecondInstance(func(args []string, workingDir string) {
		// 第二个实例的命令行参数里可能带深链或文件，转成页面的动作。
		showMainWindow()
		for _, arg := range args {
			handleDeepLink(arg)
		}
		_ = workingDir
	})
	mygo.App.OnOpenURL(func(raw string) {
		handleDeepLink(raw)
	})
	mygo.App.OnActivate(func(hasVisible bool) {
		if !hasVisible {
			showMainWindow()
		}
	})
}
