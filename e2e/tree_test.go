//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"testing"
)

// 集合树的右键菜单与就地重命名。
// 右键以前直接弹出 WebView2 自带的英文菜单，现在统一成应用自己的中文菜单。

// rightClick 在某一行上派发右键菜单事件：selector 是行选择器，label 是行里名字文字。
func rightClick(t *testing.T, selector, label string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const rows = [...document.querySelectorAll(%s)];
  const row = rows.find(r => {
    const name = r.querySelector('.tree-label');
    return name && name.textContent.trim() === %s;
  });
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true,
    clientX: Math.round(rect.left + 40), clientY: Math.round(rect.top + rect.height / 2),
  }));
  return true;
})()`, jsString(selector), jsString(label))
	var ok bool
	h.eval(t, script, &ok)
	if !ok {
		t.Fatalf("侧边栏里没有叫 %q 的行：%s", label, selector)
	}
}

// menuLabels 读出当前右键菜单的条目文字。
func menuLabels(t *testing.T) []string {
	t.Helper()
	var raw string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.ctx-menu .env-menu-name')].map(e => e.textContent.trim()))`, &raw)
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		t.Fatalf("解析菜单项失败：%v（原文 %s）", err, raw)
	}
	return list
}

func expectMenu(t *testing.T, screen string, want []string) {
	t.Helper()
	h.wait(t, screen+"的右键菜单", `!!document.querySelector('.ctx-menu')`)
	got := menuLabels(t)
	if len(got) != len(want) {
		t.Fatalf("%s的菜单项数量不对：想要 %v，实际 %v", screen, want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s的菜单第 %d 项不对：想要 %q，实际 %q（全部：%v）", screen, i+1, want[i], got[i], got)
		}
	}
}

// treeLabelExists 判断侧边栏里有没有这个名字的节点。
func treeLabelExists(t *testing.T, name string) bool {
	t.Helper()
	var ok bool
	h.eval(t, fmt.Sprintf(`[...document.querySelectorAll('.tree-label')].some(e => e.textContent.trim() === %s)`, jsString(name)), &ok)
	return ok
}

// renameViaMenu 右键某行 → 点「重命名」→ 输入新名字 → 回车。
func renameViaMenu(t *testing.T, selector, oldName, newName string) {
	t.Helper()
	rightClick(t, selector, oldName)
	h.wait(t, "重命名菜单", `!!document.querySelector('.ctx-menu')`)
	clickIn(t, ".ctx-menu", "重命名")
	h.wait(t, "就地重命名框", `!!document.querySelector('.tree-rename')`)
	var value string
	h.eval(t, `(document.querySelector('.tree-rename') || {}).value || ''`, &value)
	if value != oldName {
		t.Fatalf("重命名框应预填当前名字 %q，实际 %q", oldName, value)
	}
	h.typeInto(t, ".tree-rename", newName)
	h.pressKeysOn(t, ".tree-rename", "Enter", false, false)
	h.wait(t, "名字已更新", fmt.Sprintf(
		`[...document.querySelectorAll('.tree-label')].some(e => e.textContent.trim() === %s)`, jsString(newName)))
	if treeLabelExists(t, oldName) {
		t.Fatalf("改名后旧名字 %q 还在树上", oldName)
	}
}

func TestTreeRequestMenuAndRename(t *testing.T) {
	h.clearOverlays(t)

	rightClick(t, ".tree-row", "GET 查询参数")
	expectMenu(t, "请求", []string{"打开", "重命名", "复制请求", "复制为 cURL", "删除请求"})
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "Esc 收起菜单", `!document.querySelector('.ctx-menu')`)

	// 先打开这个请求，改名时标签页标题应该跟着变。
	h.openRequest(t, "GET 查询参数")
	renameViaMenu(t, ".tree-row", "GET 查询参数", "GET 查询参数-改名")
	title := h.text(t, ".tab.active .tab-name")
	if title != "GET 查询参数-改名" {
		t.Fatalf("改名后标签页标题应同步，实际 %q", title)
	}

	// 还原，后面的用例还要按原名找它。
	renameViaMenu(t, ".tree-row", "GET 查询参数-改名", "GET 查询参数")
}

func TestTreeFolderMenuAndRename(t *testing.T) {
	h.clearOverlays(t)

	rightClick(t, ".tree-row", "响应类型")
	expectMenu(t, "文件夹", []string{"新建请求", "新建子文件夹", "重命名", "复制文件夹", "删除文件夹"})
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "Esc 收起菜单", `!document.querySelector('.ctx-menu')`)

	// 文件夹以前没有任何改名入口，这里补上（菜单 + 双击都能改）。
	renameViaMenu(t, ".tree-row", "响应类型", "响应类型-改名")
	renameViaMenu(t, ".tree-row", "响应类型-改名", "响应类型")
}

func TestTreeCollectionMenu(t *testing.T) {
	h.clearOverlays(t)

	rightClick(t, ".tree-row", "固定用例")
	expectMenu(t, "集合", []string{"新建请求", "新建文件夹", "重命名", "删除集合"})

	// 点菜单外面要收起来（和系统菜单一致）。
	h.eval(t, `(() => { document.querySelector('.search-input').click(); return true })()`, nil)
	h.wait(t, "点外部收起菜单", `!document.querySelector('.ctx-menu')`)
}

// 双击也能进就地重命名（和资源管理器一致），Esc 取消不改名字。
func TestTreeDoubleClickRenameEsc(t *testing.T) {
	h.clearOverlays(t)

	var found bool
	h.eval(t, `(() => {
  const row = [...document.querySelectorAll('.tree-row')].find(r => {
    const n = r.querySelector('.tree-label');
    return n && n.textContent.trim() === 'POST JSON 回显';
  });
  if (!row) return false;
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  return true;
})()`, &found)
	if !found {
		t.Fatal("侧边栏里没有 POST JSON 回显 这一行")
	}
	h.wait(t, "双击进入重命名", `!!document.querySelector('.tree-rename')`)
	h.typeInto(t, ".tree-rename", "不该生效的名字")
	h.pressKeysOn(t, ".tree-rename", "Escape", false, false)
	h.wait(t, "Esc 退出改名", `!document.querySelector('.tree-rename')`)
	if !treeLabelExists(t, "POST JSON 回显") {
		t.Fatal("按 Esc 取消后名字应保持不变")
	}
}
