//go:build e2e

package e2e

import (
	"fmt"
	"testing"
)

// 设置页的外观（界面缩放 / 代码字号）与快捷键自定义。

// stepperValue 读设置页某一档位的当前值（界面缩放 → 索引 0，代码字号 → 索引 1）。
func stepperValue(t *testing.T, index int) string {
	t.Helper()
	var v string
	h.eval(t, fmt.Sprintf(`([...document.querySelectorAll('.stepper-field .stepper-value')][%d]?.textContent || '').trim()`, index), &v)
	return v
}

// shortcutCombo 读某一行动作当前显示的键位。
func shortcutCombo(t *testing.T, label string) string {
	t.Helper()
	var v string
	h.eval(t, fmt.Sprintf(`(() => {
  const row = [...document.querySelectorAll('.shortcut-row')].find(r => (r.querySelector('.shortcut-label')?.textContent || '').trim() === %s);
  return ((row?.querySelector('.shortcut-key')?.textContent) || '').trim();
})()`, jsString(label)), &v)
	return v
}

// clickShortcutEdit 点某一行右侧的「修改」按钮。
func clickShortcutEdit(t *testing.T, label string) {
	t.Helper()
	var ok bool
	h.eval(t, fmt.Sprintf(`(() => {
  const row = [...document.querySelectorAll('.shortcut-row')].find(r => (r.querySelector('.shortcut-label')?.textContent || '').trim() === %s);
  const btn = row?.querySelector('.link-btn');
  if (!btn) return false;
  btn.click();
  return true;
})()`, jsString(label)), &ok)
	if !ok {
		t.Fatalf("快捷键列表里没有「%s」这一行\n应用日志：\n%s", label, h.appLog())
	}
}

// 界面缩放走的是 WebView 的真实缩放，可视区域（CSS px）会随之变大变小；
// 代码字号只影响代码区，通过 --fs-code 变量检查。
func TestZoomAndCodeFontSize(t *testing.T) {
	h.clearOverlays(t)
	h.pressKeys(t, ",", true, false)
	h.wait(t, "设置面板打开", `document.querySelectorAll('.stepper-field').length === 2`)

	if got := stepperValue(t, 0); got != "100%" {
		t.Fatalf("界面缩放默认应为 100%%，实际 %q", got)
	}
	if got := stepperValue(t, 1); got != "12px" {
		t.Fatalf("代码字号默认应为 12px，实际 %q", got)
	}

	var before int
	h.eval(t, `window.innerWidth`, &before)
	h.click(t, `button[aria-label="减小界面缩放"]`)
	h.wait(t, "界面缩放到 90%", `[...document.querySelectorAll('.stepper-field .stepper-value')][0].textContent.trim() === "90%"`)

	// 缩小后同一块屏幕能容纳更多 CSS px，可视宽度必须变大。
	scaled := false
	for i := 0; i < 40; i++ {
		var now int
		h.eval(t, `window.innerWidth`, &now)
		if now > before {
			scaled = true
			break
		}
	}
	if !scaled {
		t.Fatalf("界面缩放没有真正生效：缩放前 %d px，缩放后仍然没有变大", before)
	}

	h.click(t, `button[aria-label="增大代码字号"]`)
	h.wait(t, "代码字号到 13px", `[...document.querySelectorAll('.stepper-field .stepper-value')][1].textContent.trim() === "13px"`)
	var codeFS string
	h.eval(t, `getComputedStyle(document.documentElement).getPropertyValue('--fs-code').trim()`, &codeFS)
	if codeFS != "13px" {
		t.Fatalf("代码字号没有落到 --fs-code：%q", codeFS)
	}

	// 复位：两档都回到默认，后面的用例不受影响。
	h.clickText(t, ".stepper-field .link-btn", "复位")
	h.wait(t, "界面缩放复位", `[...document.querySelectorAll('.stepper-field .stepper-value')][0].textContent.trim() === "100%"`)
	h.eval(t, `(() => {
  const row = [...document.querySelectorAll('.stepper-field')][1];
  row.querySelector('.link-btn').click();
  return true;
})()`, nil)
	h.wait(t, "代码字号复位", `[...document.querySelectorAll('.stepper-field .stepper-value')][1].textContent.trim() === "12px"`)
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "设置浮层关闭", `!document.querySelector('.stepper-field')`)
}

// 改一个快捷键应该立刻生效（不需要重启），「全部恢复默认」能撤回。
func TestShortcutCustomize(t *testing.T) {
	h.clearOverlays(t)
	h.pressKeys(t, ",", true, false)
	h.wait(t, "设置面板打开", `document.querySelectorAll('.shortcut-row').length > 0`)

	if got := shortcutCombo(t, "新建请求"); got != "Ctrl+N" {
		t.Fatalf("新建请求默认键位应为 Ctrl+N，实际 %q", got)
	}

	// 录制新键位：Ctrl+Shift+Q。
	clickShortcutEdit(t, "新建请求")
	h.wait(t, "进入录制状态", `!!document.querySelector('.shortcut-key.recording')`)
	h.pressKeys(t, "Q", true, true)
	h.wait(t, "键位改成 Ctrl+Shift+Q", `(() => {
  const row = [...document.querySelectorAll('.shortcut-row')].find(r => (r.querySelector('.shortcut-label')?.textContent || '').trim() === '新建请求');
  return ((row?.querySelector('.shortcut-key')?.textContent) || '').trim() === 'Ctrl+Shift+Q';
})()`)

	// 关掉设置，新键位在主界面直接可用。
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "设置浮层关闭", `!document.querySelector('.shortcut-row')`)
	before := h.count(t, ".tab")
	h.pressKeys(t, "Q", true, true)
	h.wait(t, "新键位新建了标签页", fmt.Sprintf(`document.querySelectorAll('.tab').length === %d`, before+1))
	// 旧键位已经让位：Ctrl+N 不该再新建标签页。
	h.pressKeys(t, "N", true, false)
	h.pressKeys(t, "Escape", false, false)
	if now := h.count(t, ".tab"); now != before+1 {
		t.Fatalf("Ctrl+N 已经改成别的动作，却仍然新建了标签页：%d → %d", before+1, now)
	}

	// 全部恢复默认。
	h.pressKeys(t, ",", true, false)
	h.wait(t, "设置面板再次打开", `document.querySelectorAll('.shortcut-row').length > 0`)
	h.clickText(t, ".link-btn", "全部恢复默认")
	h.wait(t, "键位恢复默认", `(() => {
  const row = [...document.querySelectorAll('.shortcut-row')].find(r => (r.querySelector('.shortcut-label')?.textContent || '').trim() === '新建请求');
  return ((row?.querySelector('.shortcut-key')?.textContent) || '').trim() === 'Ctrl+N';
})()`)
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "设置浮层关闭", `!document.querySelector('.shortcut-row')`)
}
