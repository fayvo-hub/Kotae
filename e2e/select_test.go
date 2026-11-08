//go:build e2e

package e2e

import (
	"strings"
	"testing"
	"time"
)

// 统一下拉框：协议、方法、重定向都走同一套 .select-trigger + .select-menu。

// TestSelectDropdown 验下拉框的展开、点选、Esc 收起、点外面收起与键盘操作。
func TestSelectDropdown(t *testing.T) {
	h.clearOverlays(t)
	openNewTab(t)

	// 默认就是 HTTP。
	if value := h.selectValue(t, ".protocol-select"); value != "http" {
		t.Fatalf("默认协议应为 http，实际 %q", value)
	}

	h.pickSelect(t, ".protocol-select", "SSE")
	h.wait(t, "协议切到 SSE", `(document.querySelector('.protocol-select')?.className || '').includes('proto-sse')`)
	if value := h.selectValue(t, ".protocol-select"); value != "sse" {
		t.Fatalf("选中 SSE 后 data-value 应为 sse，实际 %q", value)
	}
	// 选项带中文说明，用户能看懂 SSE 与 WebSocket 的区别。
	h.click(t, ".protocol-select .select-trigger")
	h.wait(t, "下拉框重新展开", `!!document.querySelector('.select-menu')`)
	var hints string
	h.eval(t, `[...document.querySelectorAll('.select-menu .select-option')].map(o => o.textContent).join('|')`, &hints)
	if !strings.Contains(hints, "服务端事件流") || !strings.Contains(hints, "双向长连接") {
		t.Fatalf("协议选项应带中文说明，实际 %q", hints)
	}

	// Esc 只收起下拉框，不改协议。
	h.eval(t, `(() => {
	  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
	  document.querySelector('.protocol-select .select-trigger').dispatchEvent(ev);
	  return true;
	})()`, nil)
	h.wait(t, "Esc 收起下拉框", `!document.querySelector('.select-menu')`)
	if value := h.selectValue(t, ".protocol-select"); value != "sse" {
		t.Fatalf("Esc 不应改协议，实际 %q", value)
	}

	// 点外面的空白处收起。
	h.click(t, ".method-select .select-trigger")
	h.wait(t, "方法下拉框展开", `!!document.querySelector('.select-menu')`)
	h.eval(t, `(() => {
	  const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 });
	  (document.querySelector('.status-left') || document.body).dispatchEvent(ev);
	  return true;
	})()`, nil)
	h.wait(t, "点外面收起下拉框", `!document.querySelector('.select-menu')`)

	// 键盘：方向键移动 + 回车选中。
	h.eval(t, `(() => {
	  const trigger = document.querySelector('.method-select .select-trigger');
	  trigger.focus();
	  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	  return true;
	})()`, nil)
	h.wait(t, "方向键选中下一项", `document.querySelector('.method-select')?.dataset.value === 'POST'`)

	// 收起协议，避免影响后面的用例。
	h.pickSelect(t, ".protocol-select", "HTTP")
}

// TestVarAssistStaysOpen 回归：输入 {{ 弹出的变量提示以前会一闪而过、点不中。
// 请求面板每次 emit 都会重建输入框，补全必须跟着新元素重新挂上。
func TestVarAssistStaysOpen(t *testing.T) {
	h.clearOverlays(t)
	// 开新页签再操作：这里要键入并保存一个头，不能污染集合里的固定用例。
	h.eval(t, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true })); return true; })()`, nil)
	h.wait(t, "新页签就绪", `!!document.querySelector('.tab.active') && (document.querySelector('.url-input')?.value ?? '') === ''`)
	h.activateSubtab(t, "请求头")
	h.wait(t, "请求头面板", `!!document.querySelector('.kv-foot .link-btn')`)
	h.clickText(t, ".kv-foot .link-btn", "添加一行")
	h.wait(t, "出现空行", `!!document.querySelector('.kv-row .kv-value')`)

	// 聚焦值输入框，键入 {{（真实用户操作：输入 → input 事件 → 落库重绘）。
	h.eval(t, `(() => {
	  const input = [...document.querySelectorAll('.kv-row .kv-value')].pop();
	  input.focus();
	  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
	  setter.call(input, '{{');
	  input.dispatchEvent(new Event('input', { bubbles: true }));
	  return input.value;
	})()`, nil)
	h.wait(t, "变量提示弹出", `document.querySelector('.assist')?.classList.contains('open')`)

	// 重绘之后再等一会：修好之前这里会因为输入框被替换而收起。
	time.Sleep(500 * time.Millisecond)
	if !h.exists(t, ".assist.open") {
		t.Fatalf("键入 {{ 后补全层应当保持展开，实际已收起")
	}

	// 点选一个变量，值应被替换成 {{baseUrl}}。
	h.clickContaining(t, ".assist-item", "baseUrl")
	h.wait(t, "变量已写入输入框", `[...document.querySelectorAll('.kv-row .kv-value')].pop()?.value === '{{baseUrl}}'`)
	h.wait(t, "补全层收起", `!document.querySelector('.assist.open')`)
}

// TestSelectStaysOpenForLongList 回归：选项很多、选中项在列表靠下时，
// 展开菜单会先把选中项滚进可视区，那次滚动以前会被当成「页面滚了」而把菜单立刻收起。
func TestSelectStaysOpenForLongList(t *testing.T) {
	const (
		colName = "长列表集合"
		reqName = "长列表请求"
	)
	cleanupScripts(t)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/echo")
	saveTabInto(t, reqName, colName, "")
	h.openRequest(t, reqName)

	// 新建的脚本默认挂在这个请求上，作用范围下拉框的选中项因此排在集合与请求之后。
	openScriptLibrary(t)
	h.clickContaining(t, ".script-lib-side .tools-row .btn", "新建")
	h.wait(t, "新建出一条脚本", `document.querySelectorAll('.script-lib-item').length === 1`)
	h.click(t, `.script-lib-editor .form-grid > .field:nth-child(2) .select .select-trigger`)
	h.wait(t, "作用范围下拉框展开", `!!document.querySelector('.select-menu')`)
	time.Sleep(400 * time.Millisecond)
	if !h.exists(t, ".select-menu") {
		t.Fatalf("选项列表很长时下拉框也不该自己收起")
	}
	// 点选靠下的选项：菜单已展开，直接点，别再用触发器切一次。
	h.clickContaining(t, ".select-menu .select-option", "全局（所有请求）")
	h.wait(t, "作用范围改到全局", `document.querySelector('.script-lib-editor .form-grid > .field:nth-child(2) .select')?.dataset.value === 'global'`)
	h.clearOverlays(t)
	deleteCollectionViaMenu(t, colName)
}
