//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

// assistNames 读补全层里当前展示的变量名。
func assistNames(t *testing.T) []string {
	t.Helper()
	var out string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.assist.open .assist-item code')].map(el => el.textContent))`, &out)
	out = strings.Trim(out, `[]"`)
	if out == "" {
		return nil
	}
	parts := strings.Split(out, `","`)
	for i := range parts {
		parts[i] = strings.Trim(parts[i], `"`)
	}
	return parts
}

// 变量补全不只在大表格里生效：地址栏、请求体、cURL 导入框输入 {{ 都要弹补全，
// 并且在补全层开着时 Enter 归补全用，不会把请求发出去。
func TestVarAssistEverywhere(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	// 1. 地址栏。
	h.click(t, ".url-input")
	h.typeInto(t, ".url-input", "{{base")
	h.wait(t, "地址栏补全弹出", `!!document.querySelector('.assist.open')`)
	if names := assistNames(t); len(names) == 0 || !strings.Contains(strings.Join(names, ","), "{{baseUrl}}") {
		t.Fatalf("地址栏补全里没有 baseUrl：%v", names)
	}
	h.pressKeysOn(t, ".url-input", "Enter", false, false)
	h.wait(t, "Enter 选中变量", `document.querySelector('.url-input').value === '{{baseUrl}}'`)
	// Enter 不该顺手把请求发出去（没写完整地址，发送会报「请先填写请求地址」）。
	if toasts := h.count(t, ".toast"); toasts > 0 {
		var text string
		h.eval(t, `[...document.querySelectorAll('.toast')].map(el => el.textContent).join('|')`, &text)
		if strings.Contains(text, "请先填写请求地址") {
			t.Fatalf("补全层的 Enter 被当成发送了：%q", text)
		}
	}

	// 2. 请求体。
	h.clickContaining(t, ".subtabs:not(.response-subtabs) .subtab", "请求体")
	h.wait(t, "请求体面板就绪", `[...document.querySelectorAll('.segmented-item')].some(el => el.textContent.trim() === '纯文本')`)
	h.clickText(t, ".segmented-item", "纯文本")
	h.wait(t, "请求体输入框出现", `!!document.querySelector('.code-input')`)
	h.click(t, ".code-input")
	h.typeInto(t, ".code-input", "token={{tok")
	h.wait(t, "请求体补全弹出", `!!document.querySelector('.assist.open')`)
	h.pressKeysOn(t, ".code-input", "Enter", false, false)
	h.wait(t, "请求体里补全成 token 变量", `document.querySelector('.code-input').value === 'token={{token}}'`)

	// 3. cURL 导入框。
	h.clearOverlays(t)
	h.pressKeys(t, "i", true, false)
	h.wait(t, "cURL 对话框打开", `!!document.querySelector('.curl-input')`)
	h.click(t, ".curl-input")
	h.typeInto(t, ".curl-input", "curl '{{base")
	h.wait(t, "cURL 框补全弹出", `!!document.querySelector('.assist.open')`)
	if names := assistNames(t); len(names) == 0 {
		t.Fatal("cURL 导入框没有补全候选")
	}
	h.pressKeysOn(t, ".curl-input", "Escape", false, false)
	h.clearOverlays(t)
}
