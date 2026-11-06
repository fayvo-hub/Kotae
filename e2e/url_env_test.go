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
