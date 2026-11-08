package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/netproxy"
	"github.com/egoist/mygo/plugins/fetch"
	"github.com/egoist/mygo/plugins/sqlite"
	"github.com/egoist/mygo/plugins/updater"
	"github.com/egoist/mygo/plugins/websocket"
	"github.com/egoist/mygo/transfer"
)

// maxFileSize 是本地读文件（multipart 文件字段、导入备份）的上限。
const maxFileSize = 32 << 20

// legacyStateFileName 是早期版本用 JSON 文件保存工作区的文件名。现在的数据都
// 存在 userData 目录下的 SQLite 库里，这个文件只在启动时被读一次并改名归档，
// 之后不再读写。
const legacyStateFileName = "workspace.json"

// System 暴露给前端的桌面能力：应用信息、剪贴板、文件选择与保存、系统通知、
// Cookie 开关与管理。全部是纯本地操作，不产生网络请求。
type System struct {
	jar *toggleJar
}

// Info 描述应用本身与运行环境。
type Info struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Platform string `json:"platform"`
	Arch     string `json:"arch"`
	DataDir  string `json:"dataDir"`
}

// Info 返回应用信息，供「关于」与设置面板展示。
func (s *System) Info() Info {
	dir, _ := mygo.App.Path(mygo.PathUserData)
	return Info{
		Name:     mygo.App.Name(),
		Version:  mygo.App.Version(),
		Platform: runtime.GOOS,
		Arch:     runtime.GOARCH,
		DataDir:  dir,
	}
}

// CopyText 把文本写入系统剪贴板。自定义协议下 webview 的剪贴板 API 不可靠，
// 统一走 Go 侧。
func (s *System) CopyText(text string) error {
	return mygo.Clipboard.Write(transfer.TextData(text))
}

// PasteText 读取系统剪贴板里的文本，剪贴板中没有文本时返回空字符串。
func (s *System) PasteText(ctx context.Context) (string, error) {
	data, err := mygo.Clipboard.Read(transfer.Text)
	if err != nil {
		return "", err
	}
	b, err := data.Read(transfer.Text)
	if err != nil {
		// 剪贴板里不是文本，视为空，不算错误。
		return "", nil
	}
	return string(b), nil
}

// OpenedFile 是用户选中的本地文件内容（base64 编码）。
type OpenedFile struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Content string `json:"content"`
}

// SaveText 弹出「另存为」对话框，把文本写入用户选择的位置，返回保存路径；
// 用户取消时返回空字符串。
func (s *System) SaveText(ctx context.Context, suggestedName string, content string) (string, error) {
	return saveBytes(ctx, suggestedName, []byte(content))
}

// SaveBase64 同 SaveText，但把 base64 内容解码成原始字节再写盘，
// 用于下载二进制响应（图片、压缩包）而不损坏内容。
func (s *System) SaveBase64(ctx context.Context, suggestedName string, data string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return "", err
	}
	return saveBytes(ctx, suggestedName, raw)
}

func saveBytes(ctx context.Context, suggestedName string, content []byte) (string, error) {
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
		Parent:      mygo.CallerWindow(ctx),
		Title:       "保存文件",
		DefaultPath: sanitizeName(suggestedName),
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// OpenText 弹出「打开文件」对话框并读取文件内容（用于导入工作区备份）。
func (s *System) OpenText(ctx context.Context, title string) (OpenedFile, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:  mygo.CallerWindow(ctx),
		Title:   pickTitle(title, "打开文件"),
		Filters: []mygo.FileFilter{{Name: "JSON 文件", Extensions: []string{"json"}}, {Name: "所有文件", Extensions: []string{"*"}}},
	})
	if err != nil || len(paths) == 0 {
		return OpenedFile{}, err
	}
	return readFile(paths[0])
}

// PickedFile 是被选中的本地文件，供 multipart 表单的文件字段使用。
type PickedFile struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	Data string `json:"data"`
}

// PickFile 弹出文件对话框并读取选中的文件；用户取消时 Path 为空。
func (s *System) PickFile(ctx context.Context, title string) (PickedFile, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:  mygo.CallerWindow(ctx),
		Title:   pickTitle(title, "选择文件"),
		Filters: []mygo.FileFilter{{Name: "所有文件", Extensions: []string{"*"}}},
	})
	if err != nil || len(paths) == 0 {
		return PickedFile{}, err
	}
	info, err := os.Stat(paths[0])
	if err != nil {
		return PickedFile{}, err
	}
	file, err := readFile(paths[0])
	if err != nil {
		return PickedFile{}, err
	}
	return PickedFile{Path: file.Path, Name: file.Name, Size: info.Size(), Data: file.Content}, nil
}

func readFile(path string) (OpenedFile, error) {
	info, err := os.Stat(path)
	if err != nil {
		return OpenedFile{}, err
	}
	if info.Size() > maxFileSize {
		return OpenedFile{}, errors.New("文件超过 32 MB，暂不支持读取")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return OpenedFile{}, err
	}
	return OpenedFile{Path: path, Name: filepath.Base(path), Content: base64.StdEncoding.EncodeToString(b)}, nil
}

// TakeLegacyState 返回早期 JSON 工作区文件的内容，并把文件改名成
// workspace.json.bak：内容由页面导入 SQLite，导入成功前不会丢掉原始数据，
// 导入后也不会被再次读取。
func (s *System) TakeLegacyState() (string, error) {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, legacyStateFileName)
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if err := os.Rename(path, path+".bak"); err != nil {
		// 改名失败也把内容交出去：页面导入成功后不会再写这个文件。
		log.Printf("归档旧的工作区文件失败：%v", err)
	}
	return string(b), nil
}

// OpenDataDir 用系统文件管理器打开数据目录。
func (s *System) OpenDataDir() error {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return err
	}
	return mygo.Shell.OpenPath(dir)
}

// Notify 用系统通知提示请求完成（窗口不在前台时的长请求）。
func (s *System) Notify(title string, body string) error {
	if !mygo.NotificationsSupported() {
		return errors.New("当前系统不支持桌面通知")
	}
	return mygo.NewNotification(mygo.NotificationOptions{
		Title:  title,
		Body:   body,
		Silent: true,
	}).Show()
}

// SetCookies 开关 Cookie 会话保持，关闭时清空已记录的 Cookie。
func (s *System) SetCookies(open bool) {
	s.jar.setOpen(open)
}

// ClearCookies 清空已记录的 Cookie。
func (s *System) ClearCookies() {
	s.jar.reset()
}

// sanitizeName 让默认文件名在各平台上都合法。
func sanitizeName(name string) string {
	name = strings.Map(func(r rune) rune {
		switch r {
		case '\\', '/', ':', '*', '?', '"', '<', '>', '|':
			return '-'
		}
		return r
	}, name)
	if strings.TrimSpace(name) == "" {
		return "response.txt"
	}
	return name
}

func pickTitle(given, fallback string) string {
	if strings.TrimSpace(given) == "" {
		return fallback
	}
	return given
}

func main() {
	applyDataDirOverride()

	// 第二个实例不再开窗，而是把深链和文件转给已经运行的那个实例。
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}

	jar := newToggleJar()

	// 请求全部由 Go 发出：不受 CORS 限制，可写任意请求头（Origin/Cookie/User-Agent…），
	// 可读除 Set-Cookie 之外的全部响应头；Transport 跟随系统代理与 HTTPS_PROXY/NO_PROXY。
	// 超时不放在 http.Client 上，由前端按请求设置 AbortSignal 计时，这样每条请求可以
	// 用不同的超时。
	client := &http.Client{Transport: newRoutingTransport(netproxy.Transport()), Jar: jar}

	mygo.Use(fetch.New(fetch.Options{Client: client}))
	// 存储层是 SQLite：插件把预编译的 sqlite3 通过 purego 加载，不需要 cgo。
	mygo.Use(sqlite.Plugin)
	// WebSocket 连接由 Go 建立：可以带握手请求头（Authorization / Cookie），
	// 也不受页面同源策略限制，和 Postman 的行为一致。
	mygo.Use(websocket.New(websocket.Options{Client: client}))
	// 自动更新：后台每天检查一次，发现新版本时弹 mygo 自带的更新窗口（发布说明 /
	// 跳过此版本 / 下载进度 / 重启进入新版本）。界面语言固定中文。
	mygo.Use(updater.New(updater.Options{Language: "zh"}))
	mygo.Bind(&System{jar: jar})

	setupAppHooks()

	mygo.App.WhenReady(func() {
		openMainWindow()
		setupDesktop()
		// 冷启动时命令行里就可能带深链（例如从浏览器点「用 Kotae 打开」）。
		for _, arg := range os.Args[1:] {
			handleDeepLink(arg)
		}
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// applyDataDirOverride 允许把用户数据目录指到别处，端到端测试用它在临时目录里
// 跑一份完全隔离的实例，不碰真实数据。
func applyDataDirOverride() {
	// 测试实例换一个应用名：单实例锁按名字区分，真实应用开着时也能同时启动。
	if os.Getenv(e2eAppEnv) == "1" {
		name := strings.TrimSpace(os.Getenv(e2eNameEnv))
		if name == "" {
			name = "Kotae E2E"
		}
		mygo.App.SetName(name)
	}
	dir := strings.TrimSpace(os.Getenv("MYGO_E2E_USER_DATA"))
	if dir == "" {
		return
	}
	mygo.App.SetPath(mygo.PathUserData, dir)
}

// DesktopReady 由页面在首次渲染完成后调用，表示可以接收菜单与深链发来的指令。
func (s *System) DesktopReady() error {
	markDesktopReady()
	return nil
}
