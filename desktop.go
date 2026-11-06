package main

import (
	_ "embed"
	"log"
	"net/url"
	"os"
	"path/filepath"
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
	// Action 是页面要执行的动作：new-request、import-curl、save、close-tab、
	// toggle-sidebar、command-palette、open-env、open-settings、snippets、
	// import-postman、toggle-theme。
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
	// GlobalShortcut 控制是否注册系统级快捷键；关掉后快捷键完全不占用。
	GlobalShortcut bool `json:"globalShortcut"`
}

// globalShortcutAcc 是唤起/收起主窗口的系统级快捷键。它在应用失去焦点时也生效。
const globalShortcutAcc = "CmdOrCtrl+Shift+M"

// desktopPrefsEvent 把用户在图钉菜单里改过的偏好通知给页面，由页面写库。
var desktopPrefsEvent = mygo.NewEvent[DesktopPrefs]("desktop:prefs")

var (
	deskMu         sync.Mutex
	prefs          = DesktopPrefs{CloseToTray: true, GlobalShortcut: true}
	mainWin        *mygo.Window
	tray           *mygo.Tray
	trayReady      bool
	trayItem       *mygo.MenuItem
	shortcutItem   *mygo.MenuItem
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
		if err := desktopPrefsEvent.Emit(win, prefs); err != nil {
			log.Printf("同步桌面偏好失败：%v", err)
		}
	}
}

// ApplyDesktopPrefs 由页面在启动时调用，把 SQLite 里存的偏好交给桌面外壳。
// 不写库、也不再回发事件，避免启动时自激。
func (s *System) ApplyDesktopPrefs(closeToTray bool, globalShortcut bool) error {
	deskMu.Lock()
	prefs.CloseToTray = closeToTray
	prefs.GlobalShortcut = globalShortcut
	item := trayItem
	shortcutItem := shortcutItem
	deskMu.Unlock()
	if item != nil {
		item.SetChecked(closeToTray)
	}
	if shortcutItem != nil {
		shortcutItem.SetChecked(globalShortcut)
	}
	applyGlobalShortcut(globalShortcut)
	return nil
}

// applyGlobalShortcut 按需注册或注销系统级快捷键。注册失败（例如被别的程序占了）
// 只记日志：快捷键是便利功能，不该拦住应用启动。
func applyGlobalShortcut(on bool) {
	if on {
		if mygo.GlobalShortcut.IsRegistered(globalShortcutAcc) {
			return
		}
		if err := mygo.GlobalShortcut.Register(globalShortcutAcc, toggleMainWindow); err != nil {
			log.Printf("注册全局快捷键 %s 失败：%v", globalShortcutAcc, err)
		}
		return
	}
	mygo.GlobalShortcut.Unregister(globalShortcutAcc)
}

// toggleMainWindow 是全局快捷键的行为：窗口已经在前面就收起，否则叫出来。
func toggleMainWindow() {
	win := currentWindow()
	if win != nil && win.IsVisible() && win.IsFocused() {
		win.Hide()
		return
	}
	showMainWindow()
}

// setGlobalShortcut 切换系统级快捷键，同时同步托盘勾选并通知页面写库。
func setGlobalShortcut(on bool) {
	deskMu.Lock()
	prefs.GlobalShortcut = on
	item := shortcutItem
	ready := desktopReady
	win := mainWin
	current := prefs
	deskMu.Unlock()
	if item != nil {
		item.SetChecked(on)
	}
	applyGlobalShortcut(on)
	if ready && win != nil {
		if err := desktopPrefsEvent.Emit(win, current); err != nil {
			log.Printf("同步桌面偏好失败：%v", err)
		}
	}
}

// quitApp 真正退出应用，绕过「关闭到托盘」的拦截。
func quitApp() {
	deskMu.Lock()
	quitting = true
	deskMu.Unlock()
	mygo.App.Quit()
}

// cmdItem 把菜单项变成一条发给页面的指令。
func cmdItem(action, text string) func(*mygo.MenuItem, *mygo.Window) {
	return func(*mygo.MenuItem, *mygo.Window) {
		sendDesktop(DesktopCommand{Action: action, Text: text})
	}
}

// buildTrayMenu 构造托盘菜单：常用动作 + 两个偏好开关 + 退出。
func buildTrayMenu() *mygo.Menu {
	deskMu.Lock()
	checked := prefs.CloseToTray
	shortcutOn := prefs.GlobalShortcut
	deskMu.Unlock()
	trayItem = &mygo.MenuItem{
		Label:   "关闭窗口时最小化到托盘",
		Type:    mygo.MenuItemCheckbox,
		Checked: checked,
		Click: func(item *mygo.MenuItem, _ *mygo.Window) {
			setCloseToTray(item.Checked)
		},
	}
	shortcutItem = &mygo.MenuItem{
		Label:   "全局快捷键 " + globalShortcutAcc,
		Type:    mygo.MenuItemCheckbox,
		Checked: shortcutOn,
		Click: func(item *mygo.MenuItem, _ *mygo.Window) {
			setGlobalShortcut(item.Checked)
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
		shortcutItem,
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

// setupDesktop 装配桌面集成：托盘、关闭行为、深链与单实例回调。
// 在应用就绪后调用一次。不设置应用菜单栏 —— 界面里的按钮与快捷键是唯一入口，
// 系统托盘承担「没有窗口时也能操作」的那部分职责。
func setupDesktop() {
	setupTray()
	// 页面调用 ApplyDesktopPrefs 时会按库里的值再对一次；这里先按默认值注册，
	// 免得到页面就绪前那段时间快捷键不可用。
	deskMu.Lock()
	shortcutOn := prefs.GlobalShortcut
	deskMu.Unlock()
	applyGlobalShortcut(shortcutOn)
}

// importFileLimit 是双击文件导入的大小上限：HAR 可能很大，整份塞进事件里会卡住页面。
const importFileLimit = 16 << 20

// handleOpenFile 把用户双击的文件读成文本，交给页面直接解析成集合。
func handleOpenFile(path string) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		log.Printf("打开文件失败：%v", err)
		sendDesktop(DesktopCommand{Action: "import-file-error", Text: path})
		return
	}
	if info.Size() > importFileLimit {
		log.Printf("文件太大，跳过导入：%s（%d 字节）", path, info.Size())
		sendDesktop(DesktopCommand{Action: "import-file-too-big", Text: filepath.Base(path)})
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("读取文件失败：%v", err)
		sendDesktop(DesktopCommand{Action: "import-file-error", Text: path})
		return
	}
	showMainWindow()
	enqueueDesktop(DesktopCommand{Action: "import-postman", Text: string(data)})
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
	// 双击 .har 文件的路径会走到这里（配置里的 fileAssociations 负责关联）。
	mygo.App.OnOpenFile(func(path string) {
		handleOpenFile(path)
	})
	mygo.App.OnActivate(func(hasVisible bool) {
		if !hasVisible {
			showMainWindow()
		}
	})
}
