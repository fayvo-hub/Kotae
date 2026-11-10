//go:build e2e

package e2e

import (
	"fmt"
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

// 打开批量粘贴后什么都不改：点「取消」应当安静退出，点「确定」也不该报「没有识别出键值对」。
func TestPasteCancel(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	h.clickText(t, ".subtab", "请求头")
	h.wait(t, "请求头页签激活", `[...document.querySelectorAll('.subtab')].some(s => s.classList.contains('active') && s.textContent.trim() === '请求头')`)
	h.wait(t, "请求头表格出现", `!!document.querySelector('.kv-foot')`)

	h.eval(t, `(() => {
		const add = [...document.querySelectorAll('.kv-foot .link-btn')].find(b => b.textContent.trim() === '添加一行');
		add.click();
		const row = [...document.querySelectorAll('.kv-row')].pop();
		const k = row.querySelector('.kv-key');
		const v = row.querySelector('.kv-value');
		k.value = 'X-Keep'; k.dispatchEvent(new Event('input', { bubbles: true }));
		v.value = 'kept'; v.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`, nil)
	h.wait(t, "行已填好", `[...document.querySelectorAll('.kv-key')].some(n => n.value === 'X-Keep')`)

	// 1) 不改内容直接取消：不弹任何提示，数据保持原样。
	h.clickText(t, ".kv-foot .link-btn", "批量粘贴")
	h.wait(t, "粘贴框打开", `!!document.querySelector('.prompt-textarea')`)
	h.clickText(t, ".prompt-dialog .btn", "取消")
	h.wait(t, "粘贴框关闭", `!document.querySelector('.prompt-backdrop')`)
	time.Sleep(150 * time.Millisecond)
	if h.exists(t, ".prompt-backdrop") {
		t.Fatalf("点取消后弹出了提示框（%s），取消应当是安静退出", h.text(t, ".prompt-dialog"))
	}
	var afterCancel string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.kv-key')].map(n => n.value))`, &afterCancel)
	if !strings.Contains(afterCancel, "X-Keep") {
		t.Fatalf("取消把原有行弄丢了：%s", afterCancel)
	}

	// 2) 不改内容直接确定：同样不该报「没有识别出键值对」。
	h.clickText(t, ".kv-foot .link-btn", "批量粘贴")
	h.wait(t, "粘贴框再次打开", `!!document.querySelector('.prompt-textarea')`)
	h.clickText(t, ".prompt-dialog .btn", "确定")
	h.wait(t, "粘贴框关闭", `!document.querySelector('.prompt-backdrop')`)
	time.Sleep(150 * time.Millisecond)
	if h.exists(t, ".prompt-backdrop") {
		t.Fatalf("没改内容直接确定也弹出了提示框（%s）", h.text(t, ".prompt-dialog"))
	}
	var afterOk string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.kv-key')].map(n => n.value))`, &afterOk)
	if !strings.Contains(afterOk, "X-Keep") {
		t.Fatalf("直接确定把原有行弄丢了：%s", afterOk)
	}
	h.shot(t, "37-paste-cancel")
}

// 从浏览器地址栏复制的参数是「name=1&age=12」这种一行串：粘进批量粘贴框要直接裂成多行，
// 值里的 percent 编码也要解开，整条 URL 同样认。
func TestPasteQueryString(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数")
	h.wait(t, "查询参数表格出现", `!!document.querySelector('.pane .kv-foot')`)
	// 这条标签页最后要关掉：它带着参数行，而 openNewTab 会复用「空白的未命名请求」，
	// 留着会被后面的用例当成本地空白页接着用。
	t.Cleanup(func() {
		h.eval(t, `(() => {
			document.querySelector('.tab.active .tab-close')?.click();
			return true;
		})()`, nil)
	})
	// 中途失败也要把对话框收掉，否则残留的键盘监听会影响后面的用例。
	t.Cleanup(func() {
		h.eval(t, `(() => {
			const btn = [...document.querySelectorAll('.prompt-dialog .btn')].find(b => b.textContent.trim() === '取消');
			if (btn) btn.click();
			return true;
		})()`, nil)
	})

	pasteText := func(text string) {
		h.clickText(t, ".pane .kv-foot .link-btn", "批量粘贴")
		h.wait(t, "粘贴对话框打开", `!!document.querySelector('.prompt-textarea')`)
		h.eval(t, fmt.Sprintf(`(() => {
			const area = document.querySelector('.prompt-textarea');
			area.value = %s;
			area.focus();
			return true;
		})()`, jsString(text)), nil)
		h.pressKeysOn(t, ".prompt-textarea", "Enter", true, false)
		h.wait(t, "粘贴框关闭", `!document.querySelector('.prompt-backdrop')`)
	}

	// 1) 带 ? 前缀与 percent 编码的查询串。
	pasteText("?appId=web&q=%E4%B8%AD%E6%96%87&page=2")
	h.wait(t, "查询串裂成三行", `document.querySelectorAll('.pane .kv-row').length === 3`)
	var got string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.pane .kv-row')].map(r => r.querySelector('.kv-key').value + '=' + r.querySelector('.kv-value').value))`, &got)
	for _, want := range []string{`appId=web`, `q=中文`, `page=2`} {
		if !strings.Contains(got, want) {
			t.Fatalf("查询串没拆对，缺 %s：%s", want, got)
		}
	}

	// 2) 整条 URL 也认：只取 ? 后面那段。
	pasteText("https://api.example.com/v1/list?from=1&to=9")
	h.wait(t, "整条 URL 裂成两行", `document.querySelectorAll('.pane .kv-row').length === 2`)
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.pane .kv-row')].map(r => r.querySelector('.kv-key').value + '=' + r.querySelector('.kv-value').value))`, &got)
	for _, want := range []string{`from=1`, `to=9`} {
		if !strings.Contains(got, want) {
			t.Fatalf("整条 URL 没拆对，缺 %s：%s", want, got)
		}
	}
	if strings.Contains(got, "api.example.com") {
		t.Fatalf("域名字段被当成参数了：%s", got)
	}

	// 3) 「名: 值」形态（请求头、Cookie）不能被当成查询串拆开。
	h.clickText(t, ".subtab", "请求头")
	h.wait(t, "请求头页签激活", `[...document.querySelectorAll('.subtab')].some(s => s.classList.contains('active') && s.textContent.trim() === '请求头')`)
	h.wait(t, "请求头表格出现", `!!document.querySelector('.kv-foot')`)
	pasteText("Cookie: a=1&b=2")
	h.wait(t, "请求头只落一行", `document.querySelectorAll('.kv-row').length === 1`)
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.kv-row')].map(r => r.querySelector('.kv-key').value + '=' + r.querySelector('.kv-value').value))`, &got)
	if !strings.Contains(got, "Cookie=a=1&b=2") {
		t.Fatalf("带 & 的请求头被拆成了多行：%s", got)
	}
}
