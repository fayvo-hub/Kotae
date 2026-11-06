//go:build e2e

package e2e

import (
	"context"
	"encoding/json"
	"net/url"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// 桌面外壳（菜单、托盘、单实例、深链）的用例。Web 前端驱动不了这些，
// 只能从进程外面来：再启动一个实例把参数交给已经在跑的那个，或者点系统菜单。

// launchSecondInstance 用同一份二进制、同一套环境再启动一次，模拟用户双击图标
// 或从浏览器点链接。它应当立刻把参数交给第一个实例然后退出。
func (hb *harness) launchSecondInstance(t *testing.T, args ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, hb.bin, args...)
	cmd.Dir = hb.root
	cmd.Env = hb.env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("第二个实例没能正常退出：%v\n%s\n首个实例日志：\n%s", err, out, hb.appLog())
	}
}

func TestDeepLinkImportFromSecondInstance(t *testing.T) {
	h.clearOverlays(t)
	curl := `curl -X POST '{{baseUrl}}/echo' -H 'X-Deep-Link: yes' -d 'a=1'`
	h.launchSecondInstance(t, "mygo-api://import?curl="+url.QueryEscape(curl))
	h.wait(t, "深链把命令送进导入浮层", `!!document.querySelector('.curl-input')`)
	var value string
	h.eval(t, `document.querySelector('.curl-input').value`, &value)
	if !strings.Contains(value, "X-Deep-Link") {
		t.Fatalf("浮层里没有深链带的命令：%q", value)
	}
	// 深链换来的请求直接可解析、可预览。
	h.wait(t, "深链内容自动解析出预览", `!!document.querySelector('.preview-card')`)
	h.shot(t, "15-deep-link")
	h.clearOverlays(t)
}

func TestCloseToTrayAndRestore(t *testing.T) {
	h.clearOverlays(t)
	// 走页面里暴露的窗口控制，和点标题栏的关闭按钮是同一条路径（Window.Close → OnClose）。
	var ok bool
	h.eval(t, `(() => {
  const w = globalThis.mygo && globalThis.mygo.window;
  if (!w || typeof w.close !== 'function') return false;
  void w.close();
  return true;
})()`, &ok)
	if !ok {
		t.Skip("页面里没有暴露窗口控制")
	}

	// 关闭后进程还在、窗口只是隐藏——这就是「关闭到托盘」。
	deadline := time.Now().Add(15 * time.Second)
	hidden := false
	for time.Now().Before(deadline) {
		ws, err := h.client.Windows()
		if err != nil || len(ws) == 0 {
			t.Fatalf("窗口被销毁了，应用跟着退出（托盘没有接管关闭）\n应用日志：\n%s", h.appLog())
		}
		if !ws[0].Visible {
			hidden = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !hidden {
		t.Fatalf("点了关闭之后窗口仍然可见")
	}

	// 再从托盘 / 第二个实例把窗口叫回来，隐藏的窗口还能用。
	h.launchSecondInstance(t, "mygo-api://new")
	shown := false
	for time.Now().Before(time.Now().Add(15 * time.Second)) {
		ws, err := h.client.Windows()
		if err == nil && len(ws) > 0 && ws[0].Visible {
			shown = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !shown {
		t.Fatalf("窗口没有恢复显示\n应用日志：\n%s", h.appLog())
	}
	h.wait(t, "恢复后页面仍然可用", `!!document.querySelector('.topbar')`)
	h.shot(t, "17-restored")
}

// readDesktopToggles 读设置面板里两个桌面开关的勾选状态。
func readDesktopToggles(t *testing.T, out *[]bool) {
	t.Helper()
	var raw string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.desktop-toggle input')].map(i => i.checked))`, &raw)
	if err := json.Unmarshal([]byte(raw), out); err != nil {
		t.Fatalf("解析开关状态失败：%v（原始值 %s）", err, raw)
	}
}

// 设置面板里的桌面开关要能改、能落库、重启后保持。
func TestDesktopPrefsToggle(t *testing.T) {
	h.clearOverlays(t)
	h.pressKeys(t, ",", true, false)
	h.wait(t, "设置面板打开", `document.querySelectorAll('.desktop-toggle').length === 2`)

	var states []bool
	readDesktopToggles(t, &states)
	if len(states) != 2 || !states[0] || !states[1] {
		t.Fatalf("两个桌面开关默认都该勾选，实际：%v", states)
	}

	// 关掉全局快捷键，等写库。
	since := time.Now()
	h.eval(t, `(() => { document.querySelectorAll('.desktop-toggle input')[1].click(); return true; })()`, new(bool))
	readDesktopToggles(t, &states)
	if len(states) != 2 || !states[0] || states[1] {
		t.Fatalf("点击后开关没变化，实际：%v", states)
	}
	waitForCommit(t, h.userData+"/workspace.db", since)

	h.restart(t)
	h.pressKeys(t, ",", true, false)
	h.wait(t, "重启后设置面板打开", `document.querySelectorAll('.desktop-toggle').length === 2`)
	readDesktopToggles(t, &states)
	if len(states) != 2 || !states[0] || states[1] {
		t.Fatalf("重启后应该是「关闭到托盘=开、全局快捷键=关」，实际：%v", states)
	}

	// 改回来，避免影响后续用例。
	since = time.Now()
	h.eval(t, `(() => { document.querySelectorAll('.desktop-toggle input')[1].click(); return true; })()`, new(bool))
	waitForCommit(t, h.userData+"/workspace.db", since)
	h.clearOverlays(t)
}
