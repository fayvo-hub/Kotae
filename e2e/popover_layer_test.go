//go:build e2e

package e2e

import (
	"fmt"
	"testing"
)

// 对话框里的弹出层（「添加前置操作」菜单、脚本库下拉）必须盖在遮罩之上。
//
// 遮罩 `.backdrop` 是 z-index 100，这两个弹出层挂在 body 上；只要它们的层级低于遮罩，
// 菜单就只是「存在于 DOM 里」而用鼠标点不到——e2e 的 el.click() 绕过命中检测，
// 所以必须用 elementFromPoint 判断这一层错位（这正是真实点击命中的规则）。

// hitOwner 返回某选择器中心点真正会吃到点击的元素：自己就是 "self"。
func hitOwner(t *testing.T, selector string) string {
	t.Helper()
	var got string
	h.eval(t, fmt.Sprintf(`(() => {
  const node = document.querySelector(%s);
  if (!node) return 'missing';
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return 'zero-size';
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + Math.min(rect.height / 2, 12),
  );
  if (!hit) return 'none';
  if (hit === node || node.contains(hit)) return 'self';
  const cls = typeof hit.className === 'string' ? hit.className.trim().split(/\s+/).join('.') : '';
  return hit.tagName.toLowerCase() + (cls ? '.' + cls : '');
})()`, jsString(selector)), &got)
	return got
}

// openSubStepMenu 点开某一阶段（按标题定位）的「添加操作」菜单。
func openSubStepMenu(t *testing.T, title string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const sub = [...document.querySelectorAll('.settings-sub')].find(node => (node.querySelector('h4') || {}).textContent === %s);
  const btn = sub && sub.querySelector('.step-add');
  if (!btn) return false;
  btn.click();
  return true;
})()`, jsString(title))
	var ok bool
	h.eval(t, script, &ok)
	if !ok {
		t.Fatalf("找不到「%s」的添加按钮", title)
	}
	h.wait(t, "添加操作菜单展开", `!!document.querySelector('.ctx-menu .env-menu-item')`)
}

// deleteSubRow 删掉对话框里某一阶段的第一行。
func deleteSubRow(t *testing.T) {
	t.Helper()
	before := h.count(t, ".settings-sub .step-row")
	h.click(t, ".settings-sub .step-row .step-more")
	h.wait(t, "行菜单展开", `!!document.querySelector('.ctx-menu .env-menu-item')`)
	clickMenuItem(t, "删除")
	if h.exists(t, ".prompt-dialog") {
		h.clickContaining(t, ".prompt-dialog .btn", "删除")
	}
	h.wait(t, "操作行被删掉", fmt.Sprintf(
		`document.querySelectorAll('.settings-sub .step-row').length === %d`, before-1,
	))
}

func TestDialogPopoverAboveBackdrop(t *testing.T) {
	const colName = "弹出层集合"
	clearGlobalSteps(t)
	h.clearOverlays(t)

	// ---- 设置弹窗（全局操作） ----
	openGlobalSettings(t)
	openStepsPane(t, "pre")
	openSubStepMenu(t, "前置操作")
	if got := hitOwner(t, ".ctx-menu"); got != "self" {
		t.Fatalf("设置弹窗里的「添加前置操作」菜单被遮住了，点击点在 %s 上", got)
	}
	clickMenuItem(t, "等待时间")
	h.wait(t, "全局操作行出现", `document.querySelectorAll('.settings-sub .step-row').length === 1`)
	deleteSubRow(t)
	h.clearOverlays(t)

	// ---- 集合共享设置：添加菜单与脚本库下拉 ----
	newCollection(t, colName)
	t.Cleanup(func() { deleteCollectionViaMenu(t, colName) })
	h.clearOverlays(t)
	openSharedSettings(t, colName)
	openStepsPane(t, "post")
	openSubStepMenu(t, "后置操作")
	if got := hitOwner(t, ".ctx-menu"); got != "self" {
		t.Fatalf("共享设置里的「添加后置操作」菜单被遮住了，点击点在 %s 上", got)
	}
	h.shot(t, "59-dialog-step-menu")
	clickMenuItem(t, "脚本库")
	h.wait(t, "脚本库行出现", `!!document.querySelector('.settings-sub .step-picker .select-trigger')`)
	h.click(t, ".settings-sub .step-picker .select-trigger")
	h.wait(t, "脚本库下拉展开", `!!document.querySelector('.select-menu .select-option')`)
	if got := hitOwner(t, ".select-menu"); got != "self" {
		t.Fatalf("共享设置里的脚本库下拉被遮住了，点击点在 %s 上", got)
	}
	h.shot(t, "60-dialog-select-menu")
	// 下拉里能真的选中「请选择」之外的项才算可用：这里只校验命中层级，收起它。
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "脚本库下拉收起", `!document.querySelector('.select-menu')`)
	deleteSubRow(t)
	h.clearOverlays(t)
}
