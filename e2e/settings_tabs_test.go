//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// 设置改成「左栏分类页签 + 右栏内容」后的几何与内容契约：
// 每页只挂自己的内容、两栏各自滚动（不再整页往下滚）、重建弹窗后页签不丢。

// settingsLayout 读设置弹窗的分栏几何（列数、两栏滚动容器、对话框本体是否还在滚）。
func settingsLayout(t *testing.T) string {
	t.Helper()
	var raw string
	h.eval(t, `(() => {
  const tabs = document.querySelector('.settings-tabs');
  const body = document.querySelector('.dialog-body');
  const nav = document.querySelector('.settings-nav');
  const content = document.querySelector('.settings-content');
  if (!tabs || !body || !nav || !content) return '';
  return JSON.stringify({
    cols: getComputedStyle(tabs).gridTemplateColumns.trim().split(/\s+/).length,
    bodyScroll: body.scrollHeight - body.clientHeight,
    navOverflow: getComputedStyle(nav).overflowY,
    contentOverflow: getComputedStyle(content).overflowY,
    navLeft: Math.round(nav.getBoundingClientRect().left),
    contentLeft: Math.round(content.getBoundingClientRect().left),
  });
})()`, &raw)
	return raw
}

// TestSettingsTabs 覆盖七个页签的内容、只挂当前页、以及两栏独立滚动。
func TestSettingsTabs(t *testing.T) {
	h.openSettingsTab(t, "appearance")

	h.wait(t, "七个分类页签", `document.querySelectorAll('.settings-tab').length === 7`)
	h.wait(t, "默认落在外观页", `(() => {
  const active = [...document.querySelectorAll('.settings-tab.active')];
  return active.length === 1 && active[0].dataset.tab === 'appearance' &&
    active[0].getAttribute('aria-selected') === 'true' &&
    document.querySelector('.settings-content').dataset.tab === 'appearance';
})()`)
	// 外观页：主题三选一 + 缩放/字号两个档位。
	h.wait(t, "外观页内容", `document.querySelectorAll('.settings-content .segmented-item').length === 3 &&
  document.querySelectorAll('.settings-content .stepper-field').length === 2`)

	// 只挂当前页签的内容：别的页的元素压根不在 DOM 里。
	h.wait(t, "别的页没有挂上来", `document.querySelectorAll('.shortcut-row').length === 0 &&
  document.querySelectorAll('.desktop-toggle').length === 0 &&
  document.querySelectorAll('.settings-sub').length === 0`)

	layout := settingsLayout(t)
	if layout == "" {
		t.Fatalf("读不到设置弹窗的分栏结构\n应用日志：\n%s", h.appLog())
	}
	want := `"cols":2`
	if !strings.Contains(layout, want) {
		t.Fatalf("设置应该是「左页签 + 右内容」两栏，实际布局：%s", layout)
	}
	// 对话框本体不再整页滚：滚动条下放到两栏里，左栏因此始终可见。
	if !strings.Contains(layout, `"bodyScroll":0`) {
		t.Fatalf("设置对话框本体不该再整页滚动，实际：%s", layout)
	}
	for _, key := range []string{`"navOverflow":"auto"`, `"contentOverflow":"auto"`, `"navLeft":`, `"contentLeft":`} {
		if !strings.Contains(layout, key) {
			t.Fatalf("分栏样式不对（缺 %s）：%s", key, layout)
		}
	}
	waitSettled(t)
	h.shot(t, "65-settings-tabs-appearance")

	cases := []struct {
		id    string
		label string
		ready string
	}{
		{"shortcuts", "快捷键", `document.querySelectorAll('.settings-content .shortcut-row').length > 0`},
		{"desktop", "桌面", `document.querySelectorAll('.settings-content .desktop-toggle').length === 3`},
		{"vars", "变量", `document.querySelectorAll('.settings-content .settings-section').length === 2 &&
  document.querySelector('.settings-content .var-row code') !== null`},
		{"steps", "全局操作", `document.querySelectorAll('.settings-content .settings-sub').length === 2 &&
  document.querySelectorAll('.settings-content .settings-sub h4').length === 2`},
		{"data", "数据与备份", `[...document.querySelectorAll('.settings-content .btn')].some(b => (b.textContent || '').includes('导出为 Postman'))`},
		{"about", "关于", `document.querySelector('.info-box .info-row .info-key') !== null &&
  document.querySelector('.settings-content .update-box') !== null`},
	}
	for _, c := range cases {
		h.clickSettingsTab(t, c.id)
		h.wait(t, "「"+c.label+"」页内容", c.ready)
		if c.id == "shortcuts" {
			// 最长的一页：内容超出一行高度，滚动落在右栏里（左栏不动）。
			waitSettled(t)
			h.shot(t, "68-settings-tabs-shortcuts")
		}
		// 切页签后外观页的控件必须已经卸掉，否则说明内容只是被藏起来而不是换掉。
		if c.id != "appearance" {
			if n := h.count(t, ".stepper-field"); n != 0 {
				t.Fatalf("切到「%s」后外观页的档位仍然在 DOM 里：%d 个", c.label, n)
			}
		}
	}

	// 主题、缩放改动会整块重建设置弹窗：重建后要停在原来那一页。
	h.clickSettingsTab(t, "steps")
	h.wait(t, "回到全局操作页", `document.querySelectorAll('.settings-sub').length === 2`)
	h.eval(t, `(() => { window.dispatchEvent(new CustomEvent('mygo:rerender-settings')); return true })()`, nil)
	h.wait(t, "重建后仍停在全局操作页", `(() => {
  const pane = document.querySelector('.settings-content');
  const active = [...document.querySelectorAll('.settings-tab.active')];
  return !!pane && pane.dataset.tab === 'steps' && active.length === 1 && active[0].dataset.tab === 'steps' &&
    document.querySelectorAll('.settings-sub').length === 2;
})()`)
	waitSettled(t)
	h.shot(t, "66-settings-tabs-steps")

	// 浅色主题也要看一眼：两栏的分隔线、选中态的底色不能糊成一片。
	h.clickSettingsTab(t, "appearance")
	var originTheme, originMode string
	h.eval(t, `document.documentElement.dataset.theme`, &originTheme)
	h.eval(t, `(() => { const el = document.querySelector('.settings-content .segmented-item.active'); return el ? el.textContent.trim() : '' })()`, &originMode)
	h.clickText(t, ".settings-content .segmented-item", "浅色")
	h.wait(t, "切到浅色主题", `document.documentElement.dataset.theme === 'light'`)
	waitSettled(t)
	h.shot(t, "67-settings-tabs-light")
	h.clickText(t, ".settings-content .segmented-item", originMode)
	h.wait(t, "主题改回原来的档位", fmt.Sprintf(`(() => {
  const el = document.querySelector('.settings-content .segmented-item.active');
  return !!el && el.textContent.trim() === %s && document.documentElement.dataset.theme === %s;
})()`, jsString(originMode), jsString(originTheme)))

	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "设置浮层关闭", `!document.querySelector('.settings-tabs')`)
}

// waitSettled 等弹窗的入场动画跑完再截图。
// 弹窗重建（切主题、缩放）会重放 pop-in，动画中途截到的是半透明的一帧。
func waitSettled(t *testing.T) {
	t.Helper()
	h.wait(t, "弹窗动画结束", `(() => {
  const dialog = document.querySelector('.dialog');
  if (!dialog) return false;
  const runs = dialog.getAnimations({ subtree: true }).filter((a) => a.playState === 'running');
  return runs.length === 0;
})()`)
}
