//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// fillPaneStepName 往对话框里某一阶段第 n 行（从 1 开始）的名称框里打字。
func fillPaneStepName(t *testing.T, phase string, index int, name string) {
	t.Helper()
	title := "前置操作"
	if phase == "post" {
		title = "后置操作"
	}
	script := fmt.Sprintf(`(() => {
  const sub = [...document.querySelectorAll('.settings-sub')].find(node => (node.querySelector('h4') || {}).textContent === %s);
  const input = sub && sub.querySelectorAll('.step-row')[%d]?.querySelector('.step-name');
  if (!input) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, %s);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`, jsString(title), index-1, jsString(name))
	var ok bool
	h.eval(t, script, &ok)
	if !ok {
		t.Fatalf("找不到「%s」的第 %d 行名称框", title, index)
	}
}

// 内联脚本可以起名：名字进列表摘要，也进执行日志的步骤名（留空时仍是代码首行）。
func TestScriptStepName(t *testing.T) {
	const name = "全局前置-取时间戳"

	clearGlobalSteps(t)
	h.clearOverlays(t)

	openGlobalSettings(t)
	openStepsPane(t, "pre")
	addPaneStep(t, "pre", "脚本")
	fillPaneStepName(t, "pre", 1, name)
	fillPaneSource(t, "pre", 1, `console.log("named-pre");`)

	// 摘要是名字，不再是代码首行。
	h.wait(t, "行摘要显示脚本名", `(() => {
  const hint = document.querySelector('.settings-sub .step-row .step-hint');
  return !!hint && hint.textContent.trim() === `+jsString(name)+`;
})()`)

	// 两种主题都看一眼：名称框用的是输入框令牌，浅色下不能与行底色糊在一起。
	waitSettled(t)
	h.shot(t, "69-step-name-dark")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="light"]`) {
		t.Fatalf("没能切到浅色主题")
	}
	waitSettled(t)
	h.shot(t, "70-step-name-light")
	h.click(t, `[data-role="theme"]`)
	h.wait(t, "回到深色主题", `document.documentElement.dataset.theme === "dark"`)

	// 名字写进了工作区：关掉弹窗再打开还在。
	h.clearOverlays(t)
	openGlobalSettings(t)
	openStepsPane(t, "pre")
	h.wait(t, "重开后名称还在", `(() => {
  const input = document.querySelector('.settings-sub .step-name');
  return !!input && input.value === `+jsString(name)+`;
})()`)
	h.clearOverlays(t)

	// 真发一次请求：日志里的步骤名用的就是这个名字。
	typeURL(t, "{{baseUrl}}/echo")
	h.clearToasts(t)
	h.send(t)
	heads := scriptLogHeads(t)
	if len(heads) == 0 {
		t.Fatalf("脚本没有执行，控制台里没有记录")
	}
	wantHead := name + " · 前置脚本|named-pre"
	if strings.TrimSpace(heads[0]) != wantHead {
		t.Fatalf("执行日志里的步骤名不对：\n实际：%q\n期望：%q", strings.TrimSpace(heads[0]), wantHead)
	}
	h.clearToasts(t)

	// 清空名字后摘要退回代码首行，说明名字是可选的一层。
	openGlobalSettings(t)
	openStepsPane(t, "pre")
	fillPaneStepName(t, "pre", 1, "")
	h.wait(t, "清空名字后摘要回到代码首行", `(() => {
  const hint = document.querySelector('.settings-sub .step-row .step-hint');
  return !!hint && hint.textContent.trim() === 'console.log("named-pre");';
})()`)
	h.clearOverlays(t)
}
