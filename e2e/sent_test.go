//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// 响应区的「请求」页签要展示实际发出去的东西：变量已插值、认证头已合并、
// 自动 Content-Type 已补上——排查问题时看的必须是这份快照，而不是编辑区当前内容。
func TestSentRequestTab(t *testing.T) {
	h.clearOverlays(t)
	h.openRequest(t, "POST JSON 回显")
	h.send(t)

	// 先把编辑区改脏：页签里显示的必须是发出去的那份，不受之后编辑影响。
	h.clickContaining(t, ".subtabs:not(.response-subtabs) .subtab", "请求头")
	h.wait(t, "请求头表格就绪", `[...document.querySelectorAll('.subtab')].some(s => s.classList.contains('active') && (s.textContent || '').includes('请求头')) && !!document.querySelector('.kv-key')`)
	h.eval(t, `(() => { const n = document.querySelector('.kv-key'); n.value = 'X-After-Send'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`, nil)

	tabs := text(t, h, `JSON.stringify([...document.querySelectorAll('.response-subtabs .subtab')].map(n => n.textContent.trim()))`)
	for _, want := range []string{"响应体", "响应头", "请求"} {
		if !strings.Contains(tabs, want) {
			t.Fatalf("响应区页签里没有「%s」：%s", want, tabs)
		}
	}

	h.eval(t, `(() => { const b = [...document.querySelectorAll('.response-subtabs .subtab')].find(n => (n.textContent || '').trim().startsWith('请求')); b.click(); return true; })()`, nil)
	h.wait(t, "请求页签渲染", `!!document.querySelector('.sent-head')`)

	method := text(t, h, `document.querySelector('.sent-head .method-tag').textContent.trim()`)
	if method != "POST" {
		t.Fatalf("方法不对：%q", method)
	}
	url := text(t, h, `document.querySelector('.sent-url').textContent.trim()`)
	if !strings.Contains(url, "/echo") || strings.Contains(url, "{{") {
		t.Fatalf("地址没有按变量解析后展示：%q", url)
	}

	// 请求头：变量要插值成实际值，认证头要合并进来。头名会被 Headers 规范化成小写，这是真实发出行为。
	headers := strings.ToLower(text(t, h, `[...document.querySelectorAll('.headers-view .headers-list')[0].querySelectorAll('.header-row')].map(r => r.querySelector('.header-key').textContent + ': ' + r.querySelector('.header-value').textContent).join('\n')`))
	for _, want := range []string{"x-fixture: yes", "authorization: bearer fixture-token-123", "content-type: application/json"} {
		if !strings.Contains(headers, want) {
			t.Fatalf("请求头里缺少「%s」：\n%s", want, headers)
		}
	}
	if strings.Contains(headers, "x-after-send") {
		t.Fatalf("请求页签跟着编辑区变了，应该是发送时的快照：\n%s", headers)
	}
	if strings.Contains(headers, "超时") {
		t.Fatalf("请求头区混进了选项行：\n%s", headers)
	}

	// 请求体：显示实际发出的文本。
	body := text(t, h, `(document.querySelector('.sent-body')||{}).textContent || ''`)
	if !strings.Contains(body, `"name": "mygo"`) || !strings.Contains(body, `"n": 42`) {
		t.Fatalf("请求体没有展示实际发出的内容：%q", body)
	}

	// 选项：超时、重定向、Cookie、认证都在。
	opts := text(t, h, `[...document.querySelectorAll('.headers-view .headers-list')[1].querySelectorAll('.header-row')].map(r => r.querySelector('.header-key').textContent + ': ' + r.querySelector('.header-value').textContent).join('\n')`)
	for _, want := range []string{"超时: 5000 ms", "重定向: 自动跟随", "认证: Bearer Token"} {
		if !strings.Contains(opts, want) {
			t.Fatalf("本次选项里缺少「%s」：\n%s", want, opts)
		}
	}
	h.shot(t, "40-sent-request")

	// 这个标签页在用例里被故意改脏了。openRequest 会复用同来源的标签页，
	// 不关掉它，后面读同一个集合请求的用例会拿到这份脏数据。
	before := h.count(t, ".tab")
	h.click(t, ".tab.active .tab-close")
	h.wait(t, "标签页已关闭", fmt.Sprintf(`document.querySelectorAll('.tab').length < %d`, before))
}

// 没发过请求的新标签页，响应区只有占位提示，不会出现空的「请求」页签。
func TestSentRequestTabAbsentBeforeSend(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	if h.exists(t, ".response-subtabs .subtab") {
		t.Fatalf("还没发送就出现了响应区页签")
	}
}

// text 读一段页面文本。
func text(t *testing.T, h *harness, script string) string {
	t.Helper()
	var out string
	h.eval(t, script, &out)
	return out
}
