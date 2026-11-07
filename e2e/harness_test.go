//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// harness 是一个跑起来的真实应用：真实二进制、真实窗口、真实 Go 侧 HTTP 请求，
// 但前端来自 dist（生产构建）、用户数据在临时目录、后端是本机桩服务。
// 启动一次，所有用例复用它。
type harness struct {
	client *Client
	win    int
	root   string
	tmp    string
	echo   *Echo
	web    *httptest.Server
	cmd    *exec.Cmd
	logs   string
	bin    string
	env    []string
	// userData 是本次 e2e 的临时用户数据目录（workspace.db 就落在这里）。
	userData string
	// launches 记录第几次启动，用来给每次启动换一个自动化 socket 路径
	// （上一个进程被杀掉后 socket 文件仍留在磁盘上，同一路径会 bind 失败）。
	launches int
}

var (
	h      *harness
	artDir string
)

func TestMain(m *testing.M) {
	root, err := repoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e：找不到项目根目录：", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Join(root, "e2e", "artifacts"), 0o755); err == nil {
		artDir = filepath.Join(root, "e2e", "artifacts")
	}
	h, err = start(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e：启动被测应用失败：", err)
		if h != nil {
			h.stop()
		}
		os.Exit(1)
	}
	code := m.Run()
	h.stop()
	os.Exit(code)
}

// repoRoot 从当前目录往上找 go.mod，避免测试依赖调用时的工作目录。
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if b, err := os.ReadFile(filepath.Join(dir, "go.mod")); err == nil && strings.Contains(string(b), "module mygo-api") {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("从 %s 往上没有找到 mygo-api 的 go.mod", dir)
		}
		dir = parent
	}
}

func start(root string) (*harness, error) {
	hb := &harness{root: root}

	if os.Getenv("MYGO_E2E_SKIP_BUILD") != "1" {
		if out, err := runIn(root, "npm", "run", "build:web"); err != nil {
			return nil, fmt.Errorf("前端构建失败：%v\n%s", err, out)
		}
	} else if _, err := os.Stat(filepath.Join(root, "dist", "index.html")); err != nil {
		return nil, fmt.Errorf("跳过了构建但没有 dist/index.html：%w", err)
	}

	tmp, err := os.MkdirTemp("", "mygo-api-e2e-")
	if err != nil {
		return nil, err
	}
	hb.tmp = tmp

	bin := filepath.Join(tmp, "app")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	hb.bin = bin
	hb.logs = filepath.Join(tmp, "app.log")
	if out, err := runIn(root, "go", "build", "-tags", "e2e", "-o", bin, "."); err != nil {
		return hb, fmt.Errorf("编译带自动化插件的应用失败：%v\n%s", err, out)
	}

	// 桩服务与前端静态服务器都开在 127.0.0.1 的随机端口上。
	hb.echo = StartEcho()
	hb.web = httptest.NewServer(fileServer(filepath.Join(root, "dist")))

	// 固定测试数据只在 e2e 里用：写进临时 userData，占位符换成真实地址。
	hb.userData = filepath.Join(tmp, "userdata")
	userData := hb.userData
	if err := os.MkdirAll(userData, 0o755); err != nil {
		return hb, err
	}
	seed, err := os.ReadFile(filepath.Join(root, "e2e", "fixtures", "workspace.json"))
	if err != nil {
		return hb, err
	}
	seed = []byte(strings.NewReplacer(
		placeholderBaseURL, hb.echo.URL(),
		placeholderToken, "fixture-token-123",
	).Replace(string(seed)))
	if err := os.WriteFile(filepath.Join(userData, "workspace.json"), seed, 0o644); err != nil {
		return hb, err
	}

	hb.env = append(os.Environ(),
		"MYGO_API_E2E=1",
		// 应用名带上本轮标识：单实例锁按名字区分，上一轮残留的进程不会挡住这一轮。
		"MYGO_API_E2E_NAME=MyGo API E2E "+strconv.FormatInt(time.Now().UnixNano(), 36),
		"MYGO_API_USER_DATA="+userData,
		"MYGO_DEV_URL="+hb.web.URL,
		"NO_COLOR=1",
	)
	if err := hb.launch(); err != nil {
		return hb, err
	}

	// 等固定数据从 workspace.json 进来（集合名出现在侧边栏）。
	if err := hb.client.WaitFor(hb.win, 20*time.Second, "固定测试数据加载", `[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === '固定用例')`); err != nil {
		return hb, err
	}
	return hb, nil
}

// launch 用当前 hb.env 起一个应用进程并等到页面画完，可重复调用（重启验证用）。
func (hb *harness) launch() error {
	if hb.tmp == "" || hb.bin == "" {
		return fmt.Errorf("harness 还没准备好二进制")
	}
	hb.launches++
	sock := filepath.Join(hb.tmp, fmt.Sprintf("automation-%d.sock", hb.launches))
	cmd := exec.Command(hb.bin)
	cmd.Dir = hb.root
	cmd.Env = append(append([]string{}, hb.env...), "MYGO_AUTOMATION="+sock)
	logFile, err := os.OpenFile(hb.logs, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动应用失败：%w", err)
	}
	hb.cmd = cmd

	// 等自动化 socket 出现，再等页面把自己画出来。
	deadline := time.Now().Add(60 * time.Second)
	for {
		client, err := Dial(sock)
		if err == nil {
			hb.client = client
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("等应用打开自动化 socket 超时：%w", err)
		}
		time.Sleep(120 * time.Millisecond)
	}

	if err := hb.waitWindow(60 * time.Second); err != nil {
		return err
	}
	// 页面脚本就绪：首屏画完了才算可用。
	if err := hb.client.WaitFor(hb.win, 60*time.Second, "首屏渲染", `!!document.querySelector('.topbar .brand-name')`); err != nil {
		return err
	}
	// 收集页面错误，最后一个用例统一检查。
	return hb.client.Eval(hb.win, `(() => {
  window.__e2eErrors = [];
  addEventListener('error', ev => window.__e2eErrors.push(String(ev.message || ev.error)));
  addEventListener('unhandledrejection', ev => window.__e2eErrors.push('unhandledrejection: ' + String(ev.reason && ev.reason.message || ev.reason)));
  return true;
})()`, nil)
}

// restart 杀掉进程再用同一个用户数据目录启动一次，用来验证数据真的落了盘。
func (hb *harness) restart(t *testing.T) {
	t.Helper()
	if hb.client != nil {
		_ = hb.client.Close()
		hb.client = nil
	}
	if hb.cmd != nil && hb.cmd.Process != nil {
		killTree(hb.cmd.Process)
		_, _ = hb.cmd.Process.Wait()
		hb.cmd = nil
	}
	if err := hb.launch(); err != nil {
		t.Fatalf("重启应用失败：%v\n应用日志：\n%s", err, hb.appLog())
	}
}

func (hb *harness) waitWindow(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		w, err := hb.client.PageWindow()
		if err == nil {
			hb.win = w.ID
			return nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			return fmt.Errorf("等被测窗口出现超时：%w", lastErr)
		}
		time.Sleep(120 * time.Millisecond)
	}
}

func (hb *harness) stop() {
	if hb.client != nil {
		_ = hb.client.Close()
	}
	if hb.cmd != nil && hb.cmd.Process != nil {
		killTree(hb.cmd.Process)
		_, _ = hb.cmd.Process.Wait()
	}
	// 兜底：重启过的用例会留下不止一个进程，按可执行文件路径把它们全清掉，
	// 免得跑完一轮还挂着一个 app.exe 占着内存和全局快捷键。
	killStrays(hb.bin)
	if hb.echo != nil {
		hb.echo.Close()
	}
	if hb.web != nil {
		hb.web.Close()
	}
	if hb.tmp == "" {
		return
	}
	if os.Getenv("MYGO_E2E_KEEP") == "1" {
		fmt.Println("e2e：保留临时目录与日志：", hb.tmp)
		return
	}
	_ = os.RemoveAll(hb.tmp)
}

// runIn 在目录里跑一条命令，返回合并后的输出。
func runIn(dir, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// appLog 读出应用的 stdout/stderr，断言失败时贴到报告里。
func (hb *harness) appLog() string {
	f, err := os.Open(hb.logs)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, _ := io.ReadAll(f)
	if len(b) > 8000 {
		b = b[len(b)-8000:]
	}
	return string(b)
}

// ---- 断言与操作小工具 ----

func (hb *harness) eval(t *testing.T, script string, out any) {
	t.Helper()
	if err := hb.client.Eval(hb.win, script, out); err != nil {
		t.Fatalf("执行页面脚本失败：%v\n脚本：%s", err, script)
	}
}

func (hb *harness) text(t *testing.T, selector string) string {
	t.Helper()
	var v string
	hb.eval(t, fmt.Sprintf(`(document.querySelector(%s)?.textContent || '').trim()`, jsString(selector)), &v)
	return v
}

func (hb *harness) count(t *testing.T, selector string) int {
	t.Helper()
	var v int
	hb.eval(t, fmt.Sprintf(`document.querySelectorAll(%s).length`, jsString(selector)), &v)
	return v
}

func (hb *harness) exists(t *testing.T, selector string) bool {
	t.Helper()
	var v bool
	hb.eval(t, fmt.Sprintf(`!!document.querySelector(%s)`, jsString(selector)), &v)
	return v
}

func (hb *harness) wait(t *testing.T, what, script string) {
	t.Helper()
	if err := hb.client.WaitFor(hb.win, 20*time.Second, what, script); err != nil {
		t.Fatalf("%v\n应用日志：\n%s", err, hb.appLog())
	}
}

func (hb *harness) click(t *testing.T, selector string) {
	t.Helper()
	var ok bool
	hb.eval(t, fmt.Sprintf(`(() => { const el = document.querySelector(%s); if (!el) return false; el.click(); return true })()`, jsString(selector)), &ok)
	if !ok {
		t.Fatalf("要点击的元素不存在：%s\n应用日志：\n%s", selector, hb.appLog())
	}
}

// clickText 点击文本匹配的元素（按钮、页签、树节点都可用）。
func (hb *harness) clickText(t *testing.T, selector, label string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const el = [...document.querySelectorAll(%s)].find(node => (node.textContent || '').trim() === %s);
  if (!el) return false;
  el.click();
  return true;
})()`, jsString(selector), jsString(label))
	var ok bool
	hb.eval(t, script, &ok)
	if !ok {
		t.Fatalf("找不到文本为「%s」的 %s\n应用日志：\n%s", label, selector, hb.appLog())
	}
}

// clickContaining 点击文本包含某段文字的元素（带计数徽标的页签这类）。
func (hb *harness) clickContaining(t *testing.T, selector, label string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const el = [...document.querySelectorAll(%s)].find(node => (node.textContent || '').includes(%s));
  if (!el) return false;
  el.click();
  return true;
})()`, jsString(selector), jsString(label))
	var ok bool
	hb.eval(t, script, &ok)
	if !ok {
		t.Fatalf("找不到文本包含「%s」的 %s\n应用日志：\n%s", label, selector, hb.appLog())
	}
}

// clearOverlays 关掉可能残留的浮层，让每个用例从干净的界面开始。
func (hb *harness) clearOverlays(t *testing.T) {
	t.Helper()
	var open bool
	hb.eval(t, `!!document.querySelector('.backdrop')`, &open)
	if open {
		hb.pressKeys(t, "Escape", false, false)
		hb.eval(t, `!!document.querySelector('.backdrop')`, &open)
		if open {
			hb.pressKeys(t, "Escape", false, false)
		}
	}
	// 清掉残留的右键菜单与就地重命名框，免得后续用例点不到底层控件。
	hb.eval(t, `(() => {
  document.querySelectorAll('.ctx-menu').forEach(el => el.remove());
  const box = document.querySelector('.tree-rename');
  if (box) box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`, nil)
	// 侧边栏切回「集合」：用例若停在「历史」面板，后面的用例全都在历史列表里找请求，
	// 报「侧边栏里没有名为 XX 的请求」这种看起来毫不相干的错。
	hb.eval(t, `(() => {
  const tab = [...document.querySelectorAll('.sidebar-tab')].find(el => el.textContent.trim().startsWith('集合'));
  if (tab && !tab.classList.contains('active')) tab.click();
  return true;
})()`, nil)
	// 清掉残留的搜索词：树被过滤后集合数量、请求列表都会对不上。
	hb.eval(t, `(() => {
  const s = document.querySelector('.search-input');
  if (s && s.value) {
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
})()`, nil)
	// 清掉残留的提示条：上一条「共 N 条请求」的 toast 会让后续等待条件立刻成立，掩盖真实导入结果。
	hb.clearToasts(t)
}

// clearToasts 清空提示条区域，截图前也能用来去掉上一用例的残留。
func (hb *harness) clearToasts(t *testing.T) {
	t.Helper()
	hb.eval(t, `(() => { const host = document.querySelector('.toasts'); if (host) host.replaceChildren(); return true })()`, nil)
}

// openRequest 在侧边栏里点开一条固定用例。
func (hb *harness) openRequest(t *testing.T, name string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const rows = [...document.querySelectorAll('.tree-row')];
  const row = rows.find(r => (r.querySelector('.tree-label')?.textContent || '').trim() === %s);
  if (!row) return false;
  row.click();
  return true;
})()`, jsString(name))
	var ok bool
	hb.eval(t, script, &ok)
	if !ok {
		t.Fatalf("侧边栏里没有名为「%s」的请求", name)
	}
	// 等的是「这个请求成为当前标签」——只看地址栏非空会被上一个标签骗过去。
	hb.wait(t, "请求成为当前标签", fmt.Sprintf(`[...document.querySelectorAll('.tab.active .tab-name')].some(el => (el.textContent || '').trim() === %s)`, jsString(name)))
}

// send 点发送并等这一次请求结束。
//
// 可靠的终点是「响应状态条重新出现」：发送期间响应区被「正在发送请求…」占位替换，
// `.status-num` 会先消失、结束后再出现。只靠「取消」按钮不行——桩服务几毫秒就返回，
// 轮询常常错过那一帧；只看状态条文本变化也不行——发送中它变空，容易被误判成已完成。
func (hb *harness) send(t *testing.T) {
	t.Helper()
	beforeNum := hb.text(t, ".status-num")
	beforeToasts := hb.text(t, ".toasts")
	hb.click(t, ".send-btn")
	start := time.Now()
	started := false
	for {
		status := hb.text(t, ".status-num")
		bar := hb.text(t, ".status-bar")
		sending := strings.Contains(hb.text(t, ".send-btn"), "取消")
		if sending {
			started = true
		}
		if started && !sending {
			time.Sleep(60 * time.Millisecond)
			return
		}
		if status != "" && !sending {
			// 未进入发送态就看到了响应：要么本轮极快（可能不到一帧），
			// 要么结果和上一轮完全相同（同一状态码、同一耗时）。
			// 两种情况都只要给渲染留一点时间就够了。
			if !started && time.Since(start) > 300*time.Millisecond {
				return
			}
		}
		// 被前置校验拦下（未定义变量等）时不会有响应，只会新增一条提示。
		// 必须比对发送前的提示：上一个用例残留的 toast 会直接把这里骗过去。
		if !started && !sending && status == "" && time.Since(start) > 300*time.Millisecond {
			toasts := hb.text(t, ".toasts")
			if toasts != "" && toasts != beforeToasts {
				t.Logf("发送被拦下，提示：%s", toasts)
				return
			}
		}
		if time.Since(start) > 20*time.Second {
			var url, toasts, scene string
			hb.eval(t, `(document.querySelector('.url-input') || {}).value || ''`, &url)
			hb.eval(t, `[...document.querySelectorAll('.toast')].map(n => n.textContent).join(' | ')`, &toasts)
			hb.eval(t, `JSON.stringify({body: document.body.innerHTML.length, btn: (document.querySelector('.send-btn')||{}).textContent || ''})`, &scene)
			t.Fatalf("等请求结束超时\n地址：%s\n状态栏：%s\n提示：%s\n上一步状态码：%s\n现场：%s\n应用日志：\n%s", url, bar, toasts, beforeNum, scene, hb.appLog())
		}
		time.Sleep(30 * time.Millisecond)
	}
}

// status 读响应状态码文本（失败时是「失败」）。
func (hb *harness) status(t *testing.T) string {
	t.Helper()
	return hb.text(t, ".status-num")
}

// responseText 读响应体区域的文本。
func (hb *harness) responseText(t *testing.T) string {
	t.Helper()
	return hb.text(t, ".response-body")
}

// shot 截图存到 e2e/artifacts，作为交付时的视觉证据。
func (hb *harness) shot(t *testing.T, name string) {
	t.Helper()
	if artDir == "" {
		return
	}
	png, err := hb.client.Capture(hb.win)
	if err != nil {
		t.Logf("截图失败（不影响用例）：%v", err)
		return
	}
	path := filepath.Join(artDir, name+".png")
	if err := os.WriteFile(path, png, 0o644); err != nil {
		t.Logf("写截图失败（不影响用例）：%v", err)
	}
}

// typeInto 往输入框里写值并触发 input 事件，模拟用户输入。
func (hb *harness) typeInto(t *testing.T, selector, value string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const input = document.querySelector(%s);
  if (!input) return false;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, %s);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`, jsString(selector), jsString(value))
	var ok bool
	hb.eval(t, script, &ok)
	if !ok {
		t.Fatalf("要输入的元素不存在：%s", selector)
	}
}

// pressKeys 在页面里派发一次组合键，走真实快捷键处理路径。
func (hb *harness) pressKeys(t *testing.T, key string, ctrl, shift bool) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const ev = new KeyboardEvent('keydown', {
    key: %s, ctrlKey: %t, shiftKey: %t, bubbles: true, cancelable: true,
  });
  document.dispatchEvent(ev);
  return true;
})()`, jsString(key), ctrl, shift)
	var ok bool
	hb.eval(t, script, &ok)
}

// pressKeysOn 把按键事件派发到指定元素上（元素自己的 keydown 监听才会收到）。
func (hb *harness) pressKeysOn(t *testing.T, selector, key string, ctrl, shift bool) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const node = document.querySelector(%s);
  if (!node) return false;
  node.focus();
  node.dispatchEvent(new KeyboardEvent('keydown', {
    key: %s, ctrlKey: %t, shiftKey: %t, bubbles: true, cancelable: true,
  }));
  return true;
})()`, jsString(selector), jsString(key), ctrl, shift)
	var ok bool
	hb.eval(t, script, &ok)
	if !ok {
		t.Fatalf("按键目标不存在：%s", selector)
	}
}

// jsString 把字符串安全地嵌进页面脚本。
func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// killTree 结束被测应用整棵树：Windows 上 WebView2 会拉起子进程，
// 只 Kill 主进程偶尔会留下还在跑的 app.exe，它持有单实例锁，下一轮就跑不起来。
func killTree(p *os.Process) {
	if p == nil {
		return
	}
	if runtime.GOOS == "windows" {
		_ = exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(p.Pid)).Run()
	}
	_ = p.Kill()
}

// killStrays 结束所有从本轮临时目录启动的被测进程（只按完整路径匹配，不会误伤别的程序）。
func killStrays(bin string) {
	if bin == "" || runtime.GOOS != "windows" {
		return
	}
	script := fmt.Sprintf(
		`Get-Process | Where-Object { $_.Path -eq '%s' } | Stop-Process -Force -ErrorAction SilentlyContinue`,
		strings.ReplaceAll(bin, "'", "''"),
	)
	_ = exec.Command("powershell", "-NoProfile", "-Command", script).Run()
}
