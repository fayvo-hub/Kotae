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

	// 2) 变量上色 + 悬停提示（变量放路径里，别污染查询参数表格）。
	h.typeInto(t, ".url-input", "{{baseUrl}}/echo/{{nope}}")
	var report string
	h.eval(t, `(() => {
		const vars = [...document.querySelectorAll('.url-var')];
		return JSON.stringify({
			text: vars.map(v => v.textContent),
			missing: vars.filter(v => v.classList.contains('missing')).map(v => v.textContent),
			title: document.querySelector('.url-input').title,
		});
	})()`, &report)
	if !strings.Contains(report, `"text":["{{baseUrl}}","{{nope}}"]`) {
		t.Fatalf("变量没有单独高亮：%s", report)
	}
	if !strings.Contains(report, `"missing":["{{nope}}"]`) {
		t.Fatalf("未定义变量没有标红：%s", report)
	}
	if !strings.Contains(report, "{{baseUrl}} = http://127.0.0.1:") {
		t.Fatalf("悬停提示缺解析值：%s", report)
	}
	// 输入时预览就跟着更新，不用等失焦。
	if preview := h.text(t, ".pane-preview"); !strings.Contains(preview, "http://127.0.0.1:") {
		t.Fatalf("输入过程中预览没有更新：%q", preview)
	}
}

// 协议写在变量外面的旧数据：预览与发送都按变量值纠正。
func TestURLSchemeFix(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	h.typeInto(t, ".url-input", "http://{{baseUrl}}/echo")
	blurURL(t)
	preview := h.text(t, ".pane-preview")
	if strings.Contains(preview, "http://http") {
		t.Fatalf("预览里出现双协议：%q", preview)
	}
	if !strings.Contains(preview, "http://127.0.0.1:") {
		t.Fatalf("预览地址不对：%q", preview)
	}
	h.send(t)
	if got := h.status(t); got != "200" {
		scene := h.text(t, ".status-bar") + " || " + h.text(t, ".response-panel")
		t.Fatalf("带变量的地址发送失败：%q\n现场：%s\n应用日志：\n%s", got, scene, h.appLog())
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
