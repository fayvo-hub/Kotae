//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// SSE 与 WebSocket：协议下拉、连接/断开、消息面板、WebSocket 发送回显。

// setProtocol 把请求协议下拉切到 http / sse / ws。
func setProtocol(t *testing.T, protocol string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const sel = document.querySelector('.protocol-select');
  if (!sel) return false;
  sel.value = %s;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`, jsString(protocol))
	var ok bool
	h.eval(t, script, &ok)
	if !ok {
		t.Fatalf("页面上没有协议下拉")
	}
	// 渲染是异步批处理的，等重渲染后的 class（由 state 推导）而不是等 select.value。
	h.wait(t, "协议切换生效", fmt.Sprintf(`(document.querySelector('.protocol-select')?.className || '').includes('proto-%s')`, protocol))
}

// commitURL 触发地址栏 blur，把输入框里的地址写进请求（与真实交互一致）。
func commitURL(t *testing.T) {
	t.Helper()
	h.eval(t, `(() => {
  const input = document.querySelector('.url-input');
  if (!input) return false;
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
})()`, nil)
	time.Sleep(40 * time.Millisecond)
}

// streamRows 返回流式面板里每行「方向|类型|文本」。
func streamRows(t *testing.T) []string {
	t.Helper()
	var raw string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.stream-row')].map((row) => [
  (row.querySelector('.stream-dir')?.textContent || '').trim(),
  (row.querySelector('.stream-kind')?.textContent || '').trim(),
  (row.querySelector('.stream-text')?.textContent || ''),
].join('|')))`, &raw)
	var rows []string
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		t.Fatalf("解析流式消息失败：%v（原文 %s）", err, raw)
	}
	return rows
}

// newStreamTab 开一个新标签页并把协议与地址都设好。
func newStreamTab(t *testing.T, protocol, url string) {
	t.Helper()
	h.clearOverlays(t)
	h.pressKeys(t, "n", true, false)
	h.wait(t, "新标签页打开", `document.querySelectorAll('.tab').length >= 2`)
	setProtocol(t, protocol)
	h.typeInto(t, ".url-input", url)
	commitURL(t)
}

// TestStreamSSE 验 SSE：逐条追加事件、多行 data 拼成一条、心跳注释不产生消息。
func TestStreamSSE(t *testing.T) {
	newStreamTab(t, "sse", "{{baseUrl}}/sse?n=3")

	if label := h.text(t, ".send-btn"); label != "连接" {
		t.Fatalf("SSE 下发送按钮文案应为「连接」，实际是「%s」", label)
	}
	h.click(t, ".send-btn")
	h.wait(t, "收到完整的事件流", `document.querySelectorAll('.stream-row').length >= 5`)

	rows := streamRows(t)
	joined := strings.Join(rows, "\n")
	for _, want := range []string{"第 1 条", "第 2 条", "第 3 条", "done"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("流式面板里缺少 %q，实际：%v", want, rows)
		}
	}
	if strings.Contains(joined, "ping") {
		t.Fatalf("心跳注释被当成了消息：%v", rows)
	}
	// 多行 data 按 SSE 规范用换行拼成一条。
	var doneText string
	for _, row := range rows {
		if strings.Contains(row, "done") {
			doneText = row
		}
	}
	if !strings.Contains(doneText, "第一行\n第二行") {
		t.Fatalf("多行 data 没有拼成一条消息：%q", doneText)
	}
	if errText := h.text(t, ".stream-error"); errText != "" {
		t.Fatalf("正常结束的流不该显示错误：%s", errText)
	}
	h.wait(t, "服务端关闭后状态变成已断开", `(document.querySelector('.stream-state')?.textContent || '').includes('已断开')`)
	h.clearOverlays(t)
}

// TestStreamWebSocket 验 WebSocket：握手 GET 固定、收问候、发消息回显、点断开后收尾。
func TestStreamWebSocket(t *testing.T) {
	newStreamTab(t, "ws", "{{baseUrl}}/ws")

	if label := h.text(t, ".send-btn"); label != "连接" {
		t.Fatalf("WebSocket 下发送按钮文案应为「连接」，实际是「%s」", label)
	}
	var disabled bool
	h.eval(t, `!!document.querySelector('.method-select')?.disabled`, &disabled)
	if !disabled {
		t.Fatalf("WebSocket 下方法下拉应当禁用（握手固定 GET）")
	}

	h.click(t, ".send-btn")
	h.wait(t, "连接建立并收到问候", `[...document.querySelectorAll('.stream-row')].some(r => (r.textContent || '').includes('hello from fixture'))`)
	h.wait(t, "状态变成已连接", `(document.querySelector('.stream-state')?.textContent || '').includes('已连接')`)
	if label := h.text(t, ".send-btn"); label != "断开" {
		t.Fatalf("连接状态下按钮文案应为「断开」，实际是「%s」", label)
	}

	h.typeInto(t, ".stream-composer-input", "你好 WS")
	h.click(t, ".stream-send")
	h.wait(t, "发出的消息被服务端回显", `[...document.querySelectorAll('.stream-row.dir-in')].some(r => (r.textContent || '').includes('你好 WS'))`)

	rows := streamRows(t)
	sent, echoed := 0, 0
	for _, row := range rows {
		if !strings.Contains(row, "你好 WS") {
			continue
		}
		if strings.HasPrefix(row, "发|") {
			sent++
		} else if strings.HasPrefix(row, "收|") {
			echoed++
		}
	}
	if sent != 1 || echoed != 1 {
		t.Fatalf("发出与回显应各 1 条，实际 发=%d 收=%d：%v", sent, echoed, rows)
	}

	var leftover string
	h.eval(t, `document.querySelector('.stream-composer-input').value`, &leftover)
	if leftover != "" {
		t.Fatalf("发送后输入框应清空，实际还有：%q", leftover)
	}

	h.click(t, ".send-btn")
	h.wait(t, "点断开后状态变成已断开", `(document.querySelector('.stream-state')?.textContent || '').includes('已断开')`)
	if errText := h.text(t, ".stream-error"); errText != "" {
		t.Fatalf("正常断开不该显示错误：%s", errText)
	}
	if label := h.text(t, ".send-btn"); label != "连接" {
		t.Fatalf("断开后按钮应回到「连接」，实际是「%s」", label)
	}
	h.clearOverlays(t)
}

// TestStreamProtocolSwitch 验协议切回 HTTP 后响应区回到普通响应占位，不残留流式面板。
func TestStreamProtocolSwitch(t *testing.T) {
	newStreamTab(t, "sse", "{{baseUrl}}/sse?n=1")
	h.click(t, ".send-btn")
	h.wait(t, "流式面板出现", `!!document.querySelector('.stream-log')`)
	h.wait(t, "流结束后状态收尾", `(document.querySelector('.stream-state')?.textContent || '').includes('已断开')`)

	setProtocol(t, "http")
	h.wait(t, "切回 HTTP 后没有流式面板", `!document.querySelector('.stream-panel')`)
	h.wait(t, "回到普通响应占位", `(document.querySelector('.response-empty')?.textContent || '').includes('还没有响应')`)
	h.clearOverlays(t)
}
