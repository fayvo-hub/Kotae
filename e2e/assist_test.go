//go:build e2e

package e2e

import (
	"fmt"
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

// 键值表（查询参数 / 请求头 / 环境面板）里同样是「开着补全层时 Enter 归补全用」：
// 以前这里漏了这条约定，↓ 选候选后按 Enter 变成了新增一行。
func TestVarAssistInKeyValueTable(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数")
	h.wait(t, "查询参数面板", `!!document.querySelector('.pane .kv-foot')`)
	addRequestParam(t, "page", "")
	rows := h.count(t, ".pane .kv-row")

	const valueInput = ".pane .kv-row:last-child .kv-value"

	// 只打两个 {{ 就回车（不按 ↓）：落第一项，也不该新增行。
	h.click(t, valueInput)
	h.typeInto(t, valueInput, "{{")
	h.wait(t, "键值表补全弹出", `!!document.querySelector('.assist.open')`)
	var first string
	h.eval(t, `(document.querySelector('.assist.open .assist-item code') || {}).textContent || ''`, &first)
	if first == "" {
		t.Fatal("补全层应有候选")
	}
	h.pressKeysOn(t, valueInput, "Enter", false, false)
	h.wait(t, "回车直接落第一项", fmt.Sprintf(`document.querySelector(%s).value === %s`, jsString(valueInput), jsString(first)))
	if got := h.count(t, ".pane .kv-row"); got != rows {
		t.Fatalf("直选补全不该新增行：%d → %d", rows, got)
	}

	// ↓ 换到第二项再回车，同一个补全层也要接住。
	h.click(t, valueInput)
	h.typeInto(t, valueInput, "{{")
	h.wait(t, "键值表补全又弹出", `!!document.querySelector('.assist.open')`)
	var second string
	h.eval(t, `(document.querySelectorAll('.assist.open .assist-item code')[1] || {}).textContent || ''`, &second)
	if second == "" {
		t.Fatal("补全层应有第二项")
	}
	h.pressKeysOn(t, valueInput, "ArrowDown", false, false)
	h.pressKeysOn(t, valueInput, "Enter", false, false)
	h.wait(t, "↓ 后回车落第二项", fmt.Sprintf(`document.querySelector(%s).value === %s`, jsString(valueInput), jsString(second)))
	if got := h.count(t, ".pane .kv-row"); got != rows {
		t.Fatalf("确认补全不该新增行：%d → %d", rows, got)
	}
}
