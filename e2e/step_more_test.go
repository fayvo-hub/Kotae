//go:build e2e

package e2e

import (
	"testing"
)

// 操作行行尾的「更多操作」入口必须一眼能认出来：三点图标，且按 16px 渲染。
//
// 之前用的是状态标记用的单点（`icon("dot")`），塞进 13px 的 mini 按钮后只剩一个色块，
// 用户看不出这是「上移/下移/复制/删除」的菜单入口。这里量的是真实渲染结果：
// 点数（结构）+ 图标的实际像素边长（会不会被压成一团），不看 DOM 里写了哪个图标名。

type stepMoreIcon struct {
	Dots     int     `json:"dots"`
	Box      float64 `json:"box"`
	MenuIcon bool    `json:"menuIcon"`
}

// readStepMoreIcon 量当前对话框里第一行操作的行尾入口。
func readStepMoreIcon(t *testing.T) stepMoreIcon {
	t.Helper()
	var got stepMoreIcon
	h.eval(t, `(() => {
  const btn = document.querySelector('.settings-sub .step-row .step-more');
  const ic = btn && btn.querySelector('.ic');
  const svg = ic && ic.querySelector('svg');
  const rect = ic ? ic.getBoundingClientRect() : { width: 0, height: 0 };
  return {
    dots: svg ? svg.querySelectorAll('circle').length : -1,
    box: Math.round(Math.min(rect.width, rect.height) * 10) / 10,
    menuIcon: !!btn && !!btn.getAttribute('title'),
  };
})()`, &got)
	return got
}

// scrollStepIntoView 把操作行滚到视口里，截图才看得到行尾入口。
func scrollStepIntoView(t *testing.T) {
	t.Helper()
	h.eval(t, `(() => {
  const row = document.querySelector('.settings-sub .step-row');
  if (row) row.scrollIntoView({ block: 'center' });
  return true;
})()`, nil)
}

func TestStepMoreIconReadable(t *testing.T) {
	clearGlobalSteps(t)
	h.clearOverlays(t)
	openGlobalSettings(t)
	openStepsPane(t, "pre")
	openSubStepMenu(t, "前置操作")
	clickMenuItem(t, "等待时间")
	h.wait(t, "全局操作行出现", `document.querySelectorAll('.settings-sub .step-row').length === 1`)

	const want = 16
	got := readStepMoreIcon(t)
	if got.Dots != 3 {
		t.Fatalf("「更多操作」入口应该是三点图标，实际 %d 个点", got.Dots)
	}
	if !got.MenuIcon {
		t.Fatal("「更多操作」入口缺 title，悬停看不出它是什么")
	}
	if got.Box < want-0.5 || got.Box > want+0.5 {
		t.Fatalf("图标渲染成 %.1fpx，应为 %dpx：太小会挤成一团色块", got.Box, want)
	}
	scrollStepIntoView(t)
	h.shot(t, "61-step-more-dark")
	// 浅色下同样是描边/填充走 currentColor，量一遍确认没被主题改小或改没。
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="light"]`) {
		t.Fatal("没能切到浅色主题")
	}
	h.wait(t, "浅色主题下操作行还在", `!!document.querySelector('.settings-sub .step-row .step-more .ic svg')`)
	light := readStepMoreIcon(t)
	if light.Dots != 3 || light.Box < want-0.5 || light.Box > want+0.5 {
		t.Fatalf("浅色主题下入口读不出来：dots=%d box=%.1fpx", light.Dots, light.Box)
	}
	scrollStepIntoView(t)
	h.shot(t, "62-step-more-light")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="dark"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="dark"]`) {
		t.Fatal("没能切回深色主题（后续用例默认深色）")
	}
	h.clearOverlays(t)
}
