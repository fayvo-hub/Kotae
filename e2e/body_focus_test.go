//go:build e2e

package e2e

import (
	"fmt"
	"testing"
)

// 逐字输入不能重建请求面板：请求体的 JSON / 纯文本 / GraphQL 两个框、以及表格行内输入框，
// 以前每敲一个字都会 emit 重绘整块面板——输入框被换成新节点，焦点靠 DOM 路径找回，
// 输入法组合态、撤销栈与选区一起丢（详情见 store.mutateDraft 的注释）。
// 现在的契约是：打字路径只写状态、刷标签条与徽标，输入框节点原地不动。
func TestBodyFocusKept(t *testing.T) {
	h.clearOverlays(t)
	h.clearToasts(t)
	openNewTab(t)
	h.waitFreshPanel(t)

	clickIn(t, ".subtabs:not(.response-subtabs)", "请求体")
	h.wait(t, "请求体面板", `!!document.querySelector('.segmented[aria-label="请求体类型"]')`)

	// JSON 请求体。
	clickIn(t, `.segmented[aria-label="请求体类型"]`, "JSON")
	h.wait(t, "JSON 输入框", `(() => {
	  const area = document.querySelector('.pane .code-input');
	  return !!area && area.getAttribute('aria-label') === '请求体' && (area.getAttribute('placeholder') || '').includes('"name"');
	})()`)
	typeKeepingFocus(t, "JSON 请求体", ".pane .code-input", "{\n  \"name\": \"{{baseUrl}}\"\n}",
		`node.getAttribute('aria-label') === '请求体'`)

	// 纯文本请求体。
	clickIn(t, `.segmented[aria-label="请求体类型"]`, "纯文本")
	h.wait(t, "纯文本输入框", `(() => {
	  const area = document.querySelector('.pane .code-input');
	  return !!area && area.getAttribute('aria-label') === '请求体' && (area.getAttribute('placeholder') || '').includes('请求体正文');
	})()`)
	typeKeepingFocus(t, "纯文本请求体", ".pane .code-input", "hello {{baseUrl}}",
		`node.getAttribute('aria-label') === '请求体'`)

	// GraphQL 的查询与变量各一个框。
	clickIn(t, `.segmented[aria-label="请求体类型"]`, "GraphQL")
	h.wait(t, "GraphQL 面板", `!!document.querySelector('.graphql-query')`)
	typeKeepingFocus(t, "GraphQL 查询", ".graphql-query", "query Ping($id: Int) {\n  ping(id: $id)\n}",
		`node.getAttribute('aria-label') === 'GraphQL 查询'`)
	typeKeepingFocus(t, "GraphQL 变量", ".graphql-vars", `{"id": 7}`,
		`node.getAttribute('aria-label') === 'GraphQL 变量'`)

	// 请求头表格的行内输入框：焦点必须留在刚敲的那一格，不能跳到相邻的值输入框。
	clickIn(t, ".subtabs:not(.response-subtabs)", "请求头")
	h.wait(t, "请求头表格", `!!document.querySelector('.kv-foot .link-btn')`)
	clickIn(t, ".kv-foot", "添加一行")
	h.wait(t, "多出一行请求头", `document.querySelectorAll('.kv-row').length === 1`)
	typeKeepingFocus(t, "请求头的键", ".kv-row .kv-key", "X-Probe",
		`node.classList.contains('kv-key')`)
	typeKeepingFocus(t, "请求头的值", ".kv-row .kv-value", "{{baseUrl}}",
		`node.classList.contains('kv-value')`)
	// 子页签徽标跟着敲出来的头一起变（打字不重建面板，徽标由局部刷新负责）。
	var badge string
	h.eval(t, `(() => {
	  const btn = [...document.querySelectorAll('.subtabs:not(.response-subtabs) .subtab')]
	    .find(n => (n.textContent || '').includes('请求头'));
	  return btn?.querySelector('.subtab-badge')?.textContent || '';
	})()`, &badge)
	if badge != "1" {
		t.Fatalf("敲完一条请求头后「请求头」徽标是 %q，期望 \"1\"", badge)
	}
}

// typeKeepingFocus 聚焦某个输入框、写入值并派发 input，等重绘的机会过去之后断言：
// 节点还是原来那个（dataset.focusProbe 标记还在）、值在里面、焦点没跑。
// 重绘走 requestAnimationFrame 批处理，所以等三帧再断言，而不是靠 sleep。
// activeMatches 是作用在 document.activeElement 上的 JS 布尔表达式。
func typeKeepingFocus(t *testing.T, what, selector, value, activeMatches string) {
	t.Helper()
	var ok bool
	h.eval(t, fmt.Sprintf(`(() => {
	  const input = document.querySelector(%s);
	  if (!input) return false;
	  input.focus();
	  if (document.activeElement !== input) return false;
	  // 打标记：这一轮要是重绘换了新节点，标记会跟着消失。
	  input.dataset.focusProbe = 'old';
	  window.__probeFrames = 0;
	  const tick = () => {
	    window.__probeFrames += 1;
	    if (window.__probeFrames < 3) requestAnimationFrame(tick);
	  };
	  requestAnimationFrame(tick);
	  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, %s);
	  input.dispatchEvent(new Event('input', { bubbles: true }));
	  return true;
	})()`, jsString(selector), jsString(value)), &ok)
	if !ok {
		t.Fatalf("%s：找不到可聚焦的输入框 %s", what, selector)
	}
	h.wait(t, what+" 输入后的重绘机会已过去", `window.__probeFrames >= 3`)

	var state struct {
		Same  bool   `json:"same"`
		Value string `json:"value"`
		Focus bool   `json:"focus"`
	}
	h.eval(t, fmt.Sprintf(`(() => {
	  const now = document.querySelector(%s);
	  const node = document.activeElement;
	  return {
	    same: !!now && now.dataset.focusProbe === 'old',
	    value: now ? now.value : '',
	    focus: !!node && (%s),
	  };
	})()`, jsString(selector), activeMatches), &state)
	if !state.Same {
		t.Fatalf("%s：输入后输入框被重绘换掉了（焦点与输入法组合态会跟着丢）", what)
	}
	if state.Value != value {
		t.Fatalf("%s：输入框里的值是 %q，期望 %q", what, state.Value, value)
	}
	if !state.Focus {
		var where string
		h.eval(t, `(() => {
		  const node = document.activeElement;
		  if (!node) return '无';
		  return JSON.stringify({ tag: node.tagName, cls: String(node.className), label: node.getAttribute('aria-label') || '' });
		})()`, &where)
		t.Fatalf("%s：输入后焦点跑了，当前焦点 %s", what, where)
	}
}
