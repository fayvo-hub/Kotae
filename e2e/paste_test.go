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

// 打开批量粘贴时要预填表格里已有的行，并能用 # 前缀批量启停，避免每次粘贴都把原数据刷掉。
func TestPastePrefill(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	h.clickText(t, ".subtab", "请求头")
	h.wait(t, "请求头页签激活", `[...document.querySelectorAll('.subtab')].some(s => s.classList.contains('active') && s.textContent.trim() === '请求头')`)
	h.wait(t, "请求头表格出现", `!!document.querySelector('.kv-foot')`)

	// 造两行：第一行启用，第二行禁用。
	h.eval(t, `(() => {
		const add = [...document.querySelectorAll('.kv-foot .link-btn')].find(b => b.textContent.trim() === '添加一行');
		add.click();
		add.click();
		const rows = [...document.querySelectorAll('.kv-row')];
		const fill = (row, key, value) => {
			const k = row.querySelector('.kv-key');
			const v = row.querySelector('.kv-value');
			k.value = key; k.dispatchEvent(new Event('input', { bubbles: true }));
			v.value = value; v.dispatchEvent(new Event('input', { bubbles: true }));
		};
		fill(rows[rows.length - 2], 'X-On', '1');
		fill(rows[rows.length - 1], 'X-Off', '2');
		document.querySelectorAll('.kv-check')[rows.length - 1].click();
		return true;
	})()`, nil)
	h.wait(t, "两行就位", `document.querySelectorAll('.kv-row').length >= 2 && document.querySelectorAll('.kv-check:not(:checked)').length === 1`)

	h.clickText(t, ".kv-foot .link-btn", "批量粘贴")
	h.wait(t, "粘贴框打开", `!!document.querySelector('.prompt-textarea')`)

	var prefilled string
	h.eval(t, `document.querySelector('.prompt-textarea').value`, &prefilled)
	if !strings.Contains(prefilled, "X-On: 1") {
		t.Fatalf("打开时没有预填已有参数：%q", prefilled)
	}
	if !strings.Contains(prefilled, "# X-Off: 2") {
		t.Fatalf("禁用的行没有用 # 前缀标出来：%q", prefilled)
	}

	// 在已有内容上批量改：第一行改值、第二行保持禁用、再加一行。
	h.eval(t, `(() => {
		const area = document.querySelector('.prompt-textarea');
		area.value = 'X-On: 9\n# X-Off: 2\nX-New: 3';
		area.focus();
		return true;
	})()`, nil)
	h.pressKeysOn(t, ".prompt-textarea", "Enter", true, false)
	h.wait(t, "粘贴框关闭", `!document.querySelector('.prompt-backdrop')`)
	h.wait(t, "表格变成三行", `document.querySelectorAll('.kv-row').length === 3`)

	var state string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.kv-row')].map(r => ({
		key: r.querySelector('.kv-key').value,
		value: r.querySelector('.kv-value').value,
		enabled: r.querySelector('.kv-check') ? r.querySelector('.kv-check').checked : true,
	})))`, &state)
	for _, want := range []string{
		`{"key":"X-On","value":"9","enabled":true}`,
		`{"key":"X-Off","value":"2","enabled":false}`,
		`{"key":"X-New","value":"3","enabled":true}`,
	} {
		if !strings.Contains(state, want) {
			t.Fatalf("批量修改后不符合预期，缺少 %s\n实际：%s", want, state)
		}
	}
	h.shot(t, "36-paste-prefill")
}
