//go:build e2e

package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 正式构建把前端 embed 进二进制，页面地址变成 mygo://localhost/。这条用例验证打包
// 产物本身：不连 dev server 也能把界面画出来。它要跑一次 mygo build（约 1 分钟），
// 因此默认跳过，设置 MYGO_E2E_PACKAGING=1 才跑。
func TestPackagedBuildLoadsEmbeddedFrontend(t *testing.T) {
	if os.Getenv("MYGO_E2E_PACKAGING") != "1" {
		t.Skip("设置 MYGO_E2E_PACKAGING=1 才验证打包产物")
	}
	if runtime.GOOS != "windows" {
		t.Skip("打包校验目前只覆盖 Windows 产物")
	}
	out := t.TempDir()
	// 两个开关缺一不可：mygo build 默认加 mygo_noinspector，自动化插件会被换成一段
	// 「本构建不含自动化」的警告，所以用 -debug 留住 inspector；GOFLAGS 里的 e2e 标签
	// 才把插件链接进来（项目只在 e2e 构建里 import 它）。
	build := exec.Command("npx", "mygo-cli", "build", "-debug", "-skip-installer", "-o", out)
	build.Dir = h.root
	build.Env = append(os.Environ(), "GOFLAGS=-tags=e2e")
	if b, err := build.CombinedOutput(); err != nil {
		t.Fatalf("打包失败：%v\n%s", err, tail(string(b), 4000))
	}
	exe := filepath.Join(out, "windows-amd64", "Kotae.exe")
	if _, err := os.Stat(exe); err != nil {
		t.Fatalf("没找到打包产物：%v", exe)
	}

	// 打包版是 production 构建：没有 MYGO_DEV_URL 也该能起来。
	sock := filepath.Join(t.TempDir(), "packaged.sock")
	app := exec.Command(exe)
	app.Env = append(os.Environ(),
		"MYGO_AUTOMATION="+sock,
		// 与日常开发测试同一套隔离：改名 + 独立数据目录，不然会和
		// 本机正在运行的正式版撞单实例锁，第二个实例会把参数转交过去然后退出。
		"MYGO_E2E=1",
		"MYGO_E2E_USER_DATA="+filepath.Join(t.TempDir(), "userdata"),
		"NO_COLOR=1",
	)
	logPath := filepath.Join(out, "packaged.log")
	logs, _ := os.Create(logPath)
	if logs != nil {
		defer logs.Close()
		app.Stdout, app.Stderr = logs, logs
	}
	if err := app.Start(); err != nil {
		t.Fatalf("启动打包产物失败：%v", err)
	}
	defer func() {
		_ = app.Process.Kill()
		_, _ = app.Process.Wait()
	}()

	var client *Client
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		c, err := Dial(sock)
		if err == nil {
			client = c
			break
		}
		time.Sleep(120 * time.Millisecond)
	}
	if client == nil {
		t.Fatalf("打包产物没有打开自动化 socket\n%s", tail(readFileBestEffort(logPath), 4000))
	}
	defer client.Close()

	win, err := client.PageWindow()
	if err != nil {
		t.Fatalf("打包产物没有页面窗口：%v", err)
	}
	if err := client.WaitFor(win.ID, 30*time.Second, "打包版首屏", `!!document.querySelector('.topbar .brand-name')`); err != nil {
		t.Fatalf("%v\n%s", err, tail(readFileBestEffort(logPath), 4000))
	}
	// 界面来自二进制内部：地址是 mygo.localhost（mygo 用自定义协议，WebView2 里
	// 呈现为 http://mygo.localhost/），不是任何本地端口上的服务。
	var href string
	if err := client.Eval(win.ID, `location.href`, &href); err != nil {
		t.Fatalf("读地址失败：%v", err)
	}
	if !strings.Contains(href, "mygo.localhost") {
		t.Fatalf("打包产物还在加载外部地址，说明前端没有 embed：%q", href)
	}
	var title string
	if err := client.Eval(win.ID, `document.title`, &title); err != nil {
		t.Fatalf("读标题失败：%v", err)
	}
	if !strings.HasPrefix(title, "Kotae") {
		t.Fatalf("界面没跑起来，标题是 %q", title)
	}
	t.Logf("打包产物：%s，地址 %s，标题 %q", filepath.Base(exe), href, title)
}

func readFileBestEffort(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return fmt.Sprintf("(读不到日志：%v)", err)
	}
	return string(b)
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}
