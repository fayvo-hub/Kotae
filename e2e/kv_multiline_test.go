//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// 表单 / urlencoded 的值列是多行文本域：内容超过自动增高上限后能拖右下角拉高看全，
// 而且拖出来的高度在表格重绘后仍然保留（每次输入都会重建整块请求面板）。
func TestFormValueTextareaResizable(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	h.clickText(t, ".subtab", "请求体")
	h.wait(t, "请求体面板出现", `!!document.querySelector('.segmented')`)
	h.clickText(t, ".segmented-item", "表单（可含文件）")
	h.wait(t, "表单表格渲染", `!!document.querySelector('.kv-foot')`)
	h.clickText(t, ".kv-foot .link-btn", "添加一行")
	h.wait(t, "出现一行表单字段", `document.querySelectorAll('.kv-row').length > 0`)

	// 值列必须是能垂直拖拽的文本域：改之前是 resize:none + overflow:hidden，高度封在 160px。
	var style string
	h.eval(t, `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		const cs = getComputedStyle(area);
		return JSON.stringify({ tag: area.tagName, resize: cs.resize, overflowY: cs.overflowY });
	})()`, &style)
	if !strings.Contains(style, `"tag":"TEXTAREA"`) {
		t.Fatalf("表单值列不是文本域，用例没测到目标：%s", style)
	}
	if !strings.Contains(style, `"resize":"vertical"`) || !strings.Contains(style, `"overflowY":"auto"`) {
		t.Fatalf("值文本域不可拖拽：%s", style)
	}

	// 长内容：自动增高的上限生效，超出的部分靠框内滚动查看。
	long := strings.Repeat("abcdefghij0123456789\n", 40)
	h.eval(t, fmt.Sprintf(`(() => {
		const area = document.querySelector('.kv-row .kv-value');
		area.value = %s;
		area.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`, jsString(long)), nil)
	h.wait(t, "长内容超出自动增高上限", `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		return !!area && area.value.length > 0 && area.scrollHeight > area.clientHeight + 1;
	})()`)

	// 换成短内容，高度回落到内容高度，逼出「拖高后会不会被压回去」的对比基线。
	h.eval(t, `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		area.value = 'short';
		area.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`, nil)
	h.wait(t, "短内容高度回落", `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		return !!area && area.getBoundingClientRect().height < 100;
	})()`)

	// 模拟拖右下角手柄到 300px：原生拖拽只改内联高度、不派发事件。
	h.eval(t, `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		const rect = area.getBoundingClientRect();
		area.dispatchEvent(new PointerEvent('pointerdown', {
			bubbles: true,
			clientX: Math.round(rect.right - 4),
			clientY: Math.round(rect.bottom - 4),
		}));
		area.style.height = '300px';
		document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		area.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`, nil)
	h.wait(t, "拖出来的高度在重绘后保留", `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		return !!area && area.getBoundingClientRect().height >= 300;
	})()`)

	// 再敲字符：内容没变长，高度不能被自动增高改回内容高度。
	h.eval(t, `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		area.value = 'shortx';
		area.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`, nil)
	h.wait(t, "继续输入仍保持拖出来的高度", `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		return !!area && area.getBoundingClientRect().height >= 300;
	})()`)

	// 带 {{变量}} 的值会有镜像高亮层：拖高后镜像必须跟着长，否则彩色变量文字错位。
	h.eval(t, `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		area.value = 'x {{baseUrl}} y';
		area.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`, nil)
	h.wait(t, "变量高亮层跟上了值框高度", `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		const mirror = area?.previousElementSibling;
		if (!area || !mirror || !mirror.classList.contains('var-mirror')) return false;
		if (!mirror.classList.contains('on')) return false;
		return Math.abs(mirror.offsetHeight - area.offsetHeight) <= 2;
	})()`)
	h.shot(t, "60-form-value-resizable")

	// 两种主题都要看：主题切换会把整页重建一遍，顺便验证拖出来的高度在重建后依然保留。
	var themeBefore string
	h.eval(t, `document.documentElement.dataset.theme`, &themeBefore)
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	h.wait(t, "浅色主题", `document.documentElement.dataset.theme === "light"`)
	h.wait(t, "浅色下拖出来的高度仍保留", `(() => {
		const area = document.querySelector('.kv-row .kv-value');
		return !!area && area.getBoundingClientRect().height >= 300;
	})()`)
	h.shot(t, "60-form-value-resizable-light")
	for i := 0; i < 4; i++ {
		var current string
		h.eval(t, `document.documentElement.dataset.theme`, &current)
		if current == themeBefore {
			break
		}
		h.click(t, `[data-role="theme"]`)
	}
	h.wait(t, "主题恢复到初始", fmt.Sprintf(`document.documentElement.dataset.theme === %s`, jsString(themeBefore)))
}
