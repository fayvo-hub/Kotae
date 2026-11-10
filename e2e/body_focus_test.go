//go:build e2e

package e2e

import (
	"fmt"
	"testing"
)

// 逐字输入不能丢焦点：请求体的 JSON / 纯文本 / GraphQL 两个框、以及表格行内输入框，
// 每敲一个字都会 emit 重绘整块请求面板，重绘后靠 DOM 路径找回焦点。
// 变量高亮的镜像层（.var-mirror）是建好输入框之后才异步插进去的，重绘瞬间的新面板里
// 还没有它——路径若不排除这类节点，下标就会错位，焦点落到旁边的元素上。
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
	  return !!area && area.getAttribute('aria-label') === '请求体';
	})()`)
	typeKeepingFocus(t, "JSON 请求体", ".pane .code-input", "{\n  \"name\": \"{{baseUrl}}\"\n}",
		`node.getAttribute('aria-label') === '请求体'`)

	// 纯文本请求体。
	clickIn(t, `.segmented[aria-label="请求体类型"]`, "纯文本")
	h.wait(t, "纯文本输入框", `(() => {
	  const area = document.querySelector('.pane .code-input');
	  return !!area && area.getAttribute('aria-label') === '请求体';
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
}

// typeKeepingFocus 聚焦某个输入框、写入值并派发 input，等这一轮重绘把输入框换掉之后，
// 断言焦点还在原处（而不是掉到 body 或旁边的元素上）。activeMatches 是作用在
// document.activeElement 上的 JS 布尔表达式。
func typeKeepingFocus(t *testing.T, what, selector, value, activeMatches string) {
	t.Helper()
	var ok bool
	h.eval(t, fmt.Sprintf(`(() => {
	  const input = document.querySelector(%s);
	  if (!input) return false;
	  input.focus();
	  if (document.activeElement !== input) return false;
	  // 打标记：标记消失就说明这一轮重绘真的换了新的输入框。
	  input.dataset.focusProbe = 'old';
	  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, %s);
	  input.dispatchEvent(new Event('input', { bubbles: true }));
	  return true;
	})()`, jsString(selector), jsString(value)), &ok)
	if !ok {
		t.Fatalf("%s：找不到可聚焦的输入框 %s", what, selector)
	}
	h.wait(t, what+"输入后重绘完成", fmt.Sprintf(`(() => {
	  const now = document.querySelector(%s);
	  return !!now && now.dataset.focusProbe !== 'old';
	})()`, jsString(selector)))

	var kept bool
	h.eval(t, fmt.Sprintf(`(() => {
	  const node = document.activeElement;
	  return !!node && (%s);
	})()`, activeMatches), &kept)
	if !kept {
		var where string
		h.eval(t, `(() => {
		  const node = document.activeElement;
		  if (!node) return '无';
		  return JSON.stringify({ tag: node.tagName, cls: String(node.className), label: node.getAttribute('aria-label') || '' });
		})()`, &where)
		t.Fatalf("%s：输入后焦点丢了，当前焦点 %s", what, where)
	}
}
