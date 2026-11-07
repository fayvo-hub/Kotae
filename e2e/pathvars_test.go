//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

// 路径变量：地址里写 :id，参数页签自动列出变量表，发送时替换进路径。
func TestPathVariables(t *testing.T) {
	h.clearOverlays(t)
	openNewTab(t)
	typeURL(t, "{{baseUrl}}/users/:id")

	clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数")
	h.wait(t, "路径变量表", `[...document.querySelectorAll('.pane .kv-key')]
		.some(el => el.value === 'id')`)

	// 表里那一行是 `id`，值填 42。
	h.wait(t, "路径变量提示", `(document.querySelector('.pane .pane-hint') || {}).textContent?.includes('路径变量')`)
	h.eval(t, `(() => {
	  const row = [...document.querySelectorAll('.pane .kv-row')]
	    .find(el => (el.querySelector('.kv-key') || {}).value === 'id');
	  if (!row) return false;
	  const value = row.querySelector('.kv-value');
	  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
	  setter.call(value, '42');
	  value.dispatchEvent(new Event('input', { bubbles: true }));
	  return true;
	})()`, nil)

	h.wait(t, "实际地址已替换", `(document.querySelector('.pane-preview-url') || {}).textContent?.endsWith('/users/42')`)

	h.send(t)
	if status := h.status(t); status != "200" {
		t.Fatalf("路径变量请求应返回 200，实际 %q\n%s", status, h.responseText(t))
	}
	body := h.responseText(t)
	if !strings.Contains(body, "/users/42") || !strings.Contains(body, "userId") || !strings.Contains(body, `"42"`) {
		t.Fatalf("桩服务应收到 /users/42，实际：%s", body)
	}
}

// 从 cURL 导入带 `:id` 的地址时，也自动列出路径变量。
func TestPathVariablesFromCurl(t *testing.T) {
	h.clearOverlays(t)
	openNewTab(t)
	h.pressKeys(t, "i", true, false)
	h.wait(t, "cURL 导入浮层", `!!document.querySelector('.curl-input')`)
	h.typeInto(t, ".curl-input", `curl '{{baseUrl}}/users/:id?page=2'`)
	h.clickText(t, ".dialog .btn", "解析")
	h.wait(t, "解析结果预览", `!!document.querySelector('.preview-card')`)
	h.clickText(t, ".dialog-foot .btn", "替换当前请求")
	h.wait(t, "导入完成", `!document.querySelector('.curl-input')`)

	clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数")
	h.wait(t, "路径变量表", `[...document.querySelectorAll('.pane .kv-key')]
		.some(el => el.value === 'id')`)
	h.wait(t, "查询参数仍在", `[...document.querySelectorAll('.pane .kv-key')]
		.some(el => el.value === 'page')`)
}
