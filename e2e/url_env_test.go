//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// 环境下拉的交互：展开、点外部收起、编辑入口直达变量面板。
func TestEnvMenu(t *testing.T) {
	h.clearOverlays(t)

	h.click(t, ".env-pill-btn")
	h.wait(t, "环境下拉展开", `!!document.querySelector('.env-menu')`)

	var report string
	h.eval(t, `(() => {
		const menu = document.querySelector('.env-menu');
		const active = menu.querySelector('.env-menu-item.active');
		return JSON.stringify({
			items: [...menu.querySelectorAll('.env-menu-item[role="option"]')].length,
			active: active ? active.getAttribute('aria-selected') : 'none',
			name: active ? active.querySelector('.env-menu-name').textContent : '',
			expanded: document.querySelector('.env-pill-btn').getAttribute('aria-expanded'),
		});
	})()`, &report)
	if !strings.Contains(report, `"active":"true"`) || !strings.Contains(report, `"expanded":"true"`) {
		t.Fatalf("下拉状态不对：%s", report)
	}
	if !strings.Contains(report, "固定环境") {
		t.Fatalf("下拉里没有当前环境：%s", report)
	}

	// 点空白处收起。
	h.eval(t, `(document.querySelector('.search-input') || document.querySelector('.sidebar')).click(); true`, nil)
	h.wait(t, "点外部收起下拉", `!document.querySelector('.env-menu')`)

	// 胶囊上的编辑按钮直达环境对话框。
	h.click(t, ".env-pill-edit")
	h.wait(t, "环境对话框打开", `!!document.querySelector('.env-layout')`)
	h.clearOverlays(t)
	h.wait(t, "浮层关闭", `!document.querySelector('.backdrop')`)
}

// blurURL 真实触发一次失焦：事件派发而不是 blur()，后者在没有窗口焦点时不冒事件。
func blurURL(t *testing.T) {
	t.Helper()
	h.eval(t, `(() => {
		const i = document.querySelector('.url-input');
		i.focus();
		i.dispatchEvent(new Event('blur'));
		return true;
	})()`, nil)
	time.Sleep(120 * time.Millisecond)
}

// typeURL 在一个 eval 里写完地址并提交（输入 + blur）。
// 分两次 RPC 做会偶发丢掉编辑：中间若插入一次重渲染，地址栏被换成 store 的空值，
// 随后读到的就是空串，发送时提示「请先填写请求地址」。
func typeURL(t *testing.T, value string) {
	t.Helper()
	h.eval(t, fmt.Sprintf(`(() => {
		const i = document.querySelector('.url-input');
		i.focus();
		i.value = %s;
		i.dispatchEvent(new Event('input', { bubbles: true }));
		i.dispatchEvent(new Event('blur'));
		return i.value;
	})()`, jsString(value)), nil)
	time.Sleep(120 * time.Millisecond)
}

// newTab 开一个干净标签页并返回。
func newTab(t *testing.T) {
	t.Helper()
	before := h.count(t, ".tab")
	h.pressKeys(t, "n", true, false)
	h.wait(t, "新标签页就绪", fmt.Sprintf(`document.querySelectorAll('.tab').length > %d`, before))
	h.waitFreshPanel(t)
}

// 地址栏：不再自动补协议；变量上色、悬停看到解析值、预览实时更新。
func TestURLTemplate(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	// 1) 只写 host 时失焦不改写。
	h.typeInto(t, ".url-input", "api.example.com/v1/ping")
	blurURL(t)
	var value string
	h.eval(t, `document.querySelector('.url-input').value`, &value)
	if value != "api.example.com/v1/ping" {
		t.Fatalf("失焦后地址被改写：%q", value)
	}

	// 2) 变量高亮：{{}} 由镜像层单独上色，悬停出解析值浮层。
	h.typeInto(t, ".url-input", "{{baseUrl}}/echo/{{nope}}")
	assertVarsHighlighted(t, ".url-input", 2, "{{nope}}")
	assertVarTip(t, ".url-input", 0, "{{baseUrl}}", "环境变量", "http://127.0.0.1:")
	assertVarTip(t, ".url-input", 1, "{{nope}}", "未定义", "发送时会原样保留")
}

// 协议写在变量外面的旧数据：发送时按变量值纠正，不拼出双协议。
func TestURLSchemeFix(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	h.typeInto(t, ".url-input", "http://{{baseUrl}}/echo")
	blurURL(t)
	h.send(t)
	if got := h.status(t); got != "200" {
		scene := h.text(t, ".status-bar") + " || " + h.text(t, ".response-panel")
		t.Fatalf("带变量的地址发送失败：%q\n现场：%s\n应用日志：\n%s", got, scene, h.appLog())
	}
	// 实际发出的地址（「请求」页签）不能出现双协议。
	clickIn(t, ".response-subtabs", "请求")
	h.wait(t, "请求页签渲染", `!!document.querySelector('.sent-url')`)
	sent := h.text(t, ".sent-url")
	if strings.Contains(sent, "http://http") {
		t.Fatalf("实际地址里出现了双协议：%q", sent)
	}
	if !strings.Contains(sent, "http://127.0.0.1:") {
		t.Fatalf("实际地址不对：%q", sent)
	}
}

// 表单（可含文件）的行尾同时有「改为文件字段」按钮和删除按钮，两者不得重叠，
// 值输入框也不能被按钮盖住。
func TestFormFileRowLayout(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	h.clickText(t, ".subtab", "请求体")
	h.wait(t, "请求体面板出现", `!!document.querySelector('.segmented')`)
	h.clickText(t, ".segmented-item", "表单（可含文件）")
	h.wait(t, "表单表格渲染", `!!document.querySelector('.kv-foot')`)
	h.clickText(t, ".kv-foot .link-btn", "添加一行")
	h.wait(t, "出现一行表单字段", `document.querySelectorAll('.kv-row').length > 0`)

	var report string
	h.eval(t, `(() => {
		const row = document.querySelector('.kv-row');
		const rect = (el) => (el ? el.getBoundingClientRect() : null);
		const value = rect(row.querySelector('.kv-value'));
		const del = rect(row.querySelector('.kv-del'));
		const extra = rect(row.querySelector('.file-btn, .icon-btn:not(.kv-del)'));
		const overlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
		return JSON.stringify({
			valueRight: Math.round(value.right),
			delLeft: Math.round(del.left),
			delPosition: getComputedStyle(row.querySelector('.kv-del')).position,
			valueCoversDel: value.right > del.left + 0.5,
			extraOverlapsDel: overlap(extra, del),
			extra: extra ? Math.round(extra.width) : 0,
		});
	})()`, &report)

	if strings.Contains(report, `"delPosition":"absolute"`) {
		t.Fatalf("有额外控件的行里删除按钮仍在绝对定位：%s", report)
	}
	if strings.Contains(report, `"valueCoversDel":true`) {
		t.Fatalf("值输入框压到了删除按钮：%s", report)
	}
	if strings.Contains(report, `"extraOverlapsDel":true`) {
		t.Fatalf("「改为文件字段」按钮与删除按钮重叠：%s", report)
	}
	if strings.Contains(report, `"extra":0`) {
		t.Fatalf("这一行没有渲染额外控件，用例没测到目标：%s", report)
	}
	h.shot(t, "33-form-file-row")
}

// 地址栏的内容原本只在失焦、回车时才提交（见 urlBar 的 blur 处理）：焦点还停在
// 输入框里按 Ctrl+S，集合里写进去的还是上一次提交的旧地址，界面却提示「已保存」，
// 用户的改动就这么没了。输入后标签条要立刻标出未保存，Ctrl+S 存的必须是屏幕上这份。
func TestSaveCommitsURLWhileFocused(t *testing.T) {
	const (
		colName = "焦点保存集合"
		reqName = "焦点保存请求"
	)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/json")
	saveTabInto(t, reqName, colName, "")

	// 只输入、不失焦：焦点留在地址栏里，标签条要立刻标出未保存。
	var focused bool
	h.eval(t, `(() => {
		const i = document.querySelector('.url-input');
		i.focus();
		i.value = '{{baseUrl}}/echo';
		i.dispatchEvent(new Event('input', { bubbles: true }));
		return document.activeElement === i;
	})()`, &focused)
	if !focused {
		t.Fatal("地址栏没拿到焦点，用例没测到「焦点不移开」的场景")
	}
	h.wait(t, "输入后标签条立刻标出未保存", `!!document.querySelector('.tab.active .tab-dirty')`)

	// 焦点不动直接 Ctrl+S：存进集合的必须是屏幕上这份地址。
	saveTabInPlace(t)

	// 关掉标签页再从集合打开：读到的必须是刚输入的地址。
	before := h.count(t, ".tab")
	h.pressKeys(t, "w", true, false)
	h.wait(t, "标签页关闭", fmt.Sprintf(`document.querySelectorAll('.tab').length === %d`, before-1))
	h.openRequest(t, reqName)
	var url string
	h.eval(t, `document.querySelector('.url-input').value`, &url)
	if url != "{{baseUrl}}/echo" {
		t.Fatalf("焦点没移开时按 Ctrl+S，集合里存的还是旧地址：%q", url)
	}
}

// 地址栏逐字落库之后，失焦仍得把查询参数从地址里拆进「参数」表格：
// 这条路径不能被「已经同步过文本」的捷径吃掉，否则粘贴完整 URL 就不再生成参数行。
func TestURLBlurSplitsQuery(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	h.typeInto(t, ".url-input", "{{baseUrl}}/echo?a=1&b=2")
	blurURL(t)
	h.wait(t, "参数拆进表格", `[...document.querySelectorAll('.kv-row')].filter(r => (r.querySelector('.kv-key') || {}).value).length === 2`)

	var report string
	h.eval(t, `JSON.stringify({
		url: document.querySelector('.url-input').value,
		rows: [...document.querySelectorAll('.kv-row')].map(r => r.querySelector('.kv-key').value + '=' + r.querySelector('.kv-value').value),
	})`, &report)
	if !strings.Contains(report, `"url":"{{baseUrl}}/echo"`) {
		t.Fatalf("失焦后地址栏没去掉查询串：%s", report)
	}
	if !strings.Contains(report, "a=1") || !strings.Contains(report, "b=2") {
		t.Fatalf("查询参数没拆进表格：%s", report)
	}
}

// 地址栏失焦不该动参数表里的空行：地址里没有查询串时，那张表没被地址合并过，
// 空行是用户刚点「添加一行」加出来、正要填的。这条路径在真实使用里一定走到——
// 点「添加一行」时新行抢焦点，地址栏立刻 blur。
func TestURLBlurKeepsEmptyParamRow(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	typeURL(t, "{{baseUrl}}/echo")
	h.activateSubtab(t, "查询参数")
	h.wait(t, "查询参数面板", `!!document.querySelector('.pane .kv-foot')`)
	var clicked bool
	h.eval(t, `(() => {
		const btn = [...document.querySelectorAll('.pane .kv-foot .link-btn')].find(b => (b.textContent || '').trim().startsWith('添加一行'));
		if (!btn) return false;
		btn.click();
		return true;
	})()`, &clicked)
	if !clicked {
		t.Fatalf("查询参数面板里找不到「添加一行」")
	}
	h.wait(t, "参数行已添加", `document.querySelectorAll('.pane .kv-row').length === 1`)

	blurURL(t)
	h.settleFrames(t)
	if got := h.count(t, ".pane .kv-row"); got != 1 {
		t.Fatalf("地址栏失焦把刚加的空行吞掉了：现在有 %d 行", got)
	}
}
