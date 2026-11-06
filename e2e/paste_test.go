//go:build e2e

package e2e

import (
	"strings"
	"testing"
	"time"
)

// 批量粘贴对话框：多行输入、Enter 换行不提交、点遮罩不关闭、Ctrl+Enter 提交。
func TestPasteDialog(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	h.clickText(t, ".subtab", "请求头")
	// 子页签切换会重绘表格，必须等「请求头」真的成为激活页签再点表格底部的按钮，
	// 否则可能点到上一次渲染留下的、已经脱离文档的按钮。
	h.wait(t, "请求头页签激活", `[...document.querySelectorAll('.subtab')].some(s => s.classList.contains('active') && s.textContent.trim() === '请求头')`)
	h.wait(t, "请求头表格出现", `!!document.querySelector('.kv-foot')`)
	h.clickText(t, ".kv-foot .link-btn", "批量粘贴")
	// 用例中途失败也要把对话框收掉，避免残留的 Esc 监听影响后面的用例。
	t.Cleanup(func() {
		h.eval(t, `(() => {
			const btn = [...document.querySelectorAll('.prompt-dialog .btn')].find(b => b.textContent.trim() === '取消');
			if (btn) btn.click();
			return true;
		})()`, nil)
	})
	h.wait(t, "粘贴对话框打开", `!!document.querySelector('.prompt-textarea')`)

	// 多行内容：三种分隔符各一条。
	h.eval(t, `(() => {
		const area = document.querySelector('.prompt-textarea');
		area.value = 'X-One: 1\nX-Two=2\nX-Three\t3';
		area.focus();
		return true;
	})()`, nil)

	// Enter 只换行，不提交（事件要打在 textarea 上，对话框的键盘监听挂在元素本身）。
	h.pressKeysOn(t, ".prompt-textarea", "Enter", false, false)
	time.Sleep(120 * time.Millisecond)
	if !h.exists(t, ".prompt-backdrop") {
		t.Fatalf("按 Enter 就把粘贴框关掉了，多行内容没法输入")
	}

	// 点遮罩不关闭（以前误点外部会丢数据）。
	h.eval(t, `(() => { const b = document.querySelector('.prompt-backdrop'); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`, nil)
	time.Sleep(120 * time.Millisecond)
	if !h.exists(t, ".prompt-backdrop") {
		t.Fatalf("点遮罩把粘贴框关了，刚粘贴的内容会丢")
	}

	// Ctrl+Enter 提交，三行都落进表格。
	h.pressKeysOn(t, ".prompt-textarea", "Enter", true, false)
	h.wait(t, "粘贴框关闭", `!document.querySelector('.prompt-backdrop')`)
	h.wait(t, "表格出现三行", `document.querySelectorAll('.kv-row').length >= 3`)

	var keys string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.kv-key')].map(n => n.value))`, &keys)
	for _, want := range []string{"X-One", "X-Two", "X-Three"} {
		if !strings.Contains(keys, want) {
			t.Fatalf("粘贴后缺少 %s：%s", want, keys)
		}
	}

	var values string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.kv-value')].map(n => n.value))`, &values)
	if !strings.Contains(values, `"1"`) || !strings.Contains(values, `"2"`) || !strings.Contains(values, `"3"`) {
		t.Fatalf("粘贴后值不对：%s", values)
	}
	h.shot(t, "34-paste-dialog")
}
