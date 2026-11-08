//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// tabMenuLabels 在指定标签页上派发一次右键，返回菜单项文字。
func tabMenuLabels(t *testing.T, index int) []string {
	t.Helper()
	var raw string
	h.eval(t, fmt.Sprintf(`(() => {
  const tabs = [...document.querySelectorAll('.tab')];
  const t = tabs[%d];
  if (!t) return "ERR:no-tab";
  const r = t.getBoundingClientRect();
  t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 10) }));
  return JSON.stringify([...document.querySelectorAll('.ctx-menu .env-menu-name')].map((n) => (n.textContent || '').trim()));
})()`, index), &raw)
	if strings.HasPrefix(raw, "ERR:") {
		t.Fatalf("右键菜单打不开：%s", raw)
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析右键菜单项失败：%v（原始值 %s）", err, raw)
	}
	return out
}

// activeTabIndex 当前激活标签页的下标。
func activeTabIndex(t *testing.T) int {
	t.Helper()
	var index int
	h.eval(t, `[...document.querySelectorAll('.tab')].findIndex((t) => t.classList.contains('active'))`, &index)
	if index < 0 {
		t.Fatalf("找不到激活的标签页")
	}
	return index
}

// activeTabMenuLabels 在当前激活标签页上右键，返回菜单项文字。
func activeTabMenuLabels(t *testing.T) []string {
	t.Helper()
	return tabMenuLabels(t, activeTabIndex(t))
}

// clickTabMenu 在指定标签页上右键，并在同一次脚本里点菜单项。
// 拆成两次 RPC 会偶发失败：两步之间的重绘和滚动会把菜单收起来。
func clickTabMenu(t *testing.T, index int, label string) {
	t.Helper()
	var ok bool
	h.eval(t, fmt.Sprintf(`(() => {
  const tab = [...document.querySelectorAll('.tab')][%d];
  if (!tab) return false;
  const r = tab.getBoundingClientRect();
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 10) }));
  const item = [...document.querySelectorAll('.ctx-menu .env-menu-item')].find((b) => (b.textContent || '').trim().includes(%q));
  if (!item) return false;
  item.click();
  return true;
})()`, index, label), &ok)
	if !ok {
		t.Fatalf("右键菜单里点不到「%s」", label)
	}
}

func TestTabContextMenu(t *testing.T) {
	h.clearOverlays(t)
	h.openRequest(t, "GET 查询参数")
	newTab(t)
	newTab(t)

	labels := tabMenuLabels(t, 1)
	want := []string{"刷新", "关闭", "关闭其他", "关闭全部"}
	if strings.Join(labels, "|") != strings.Join(want, "|") {
		t.Fatalf("右键菜单项应该是 %v，实际 %v", want, labels)
	}
	h.shot(t, "42-tab-menu")

	// 关闭其他：只剩右键点中的那一个。
	clickTabMenu(t, 1, "关闭其他")
	h.wait(t, "只剩一个标签页", `document.querySelectorAll('.tab').length === 1`)
	if n := h.count(t, ".tab"); n != 1 {
		t.Fatalf("「关闭其他」之后应该只剩 1 个标签页，实际 %d", n)
	}

	// 关闭全部：清空后再开一个空白请求。
	newTab(t)
	newTab(t)
	labels = tabMenuLabels(t, 0)
	if len(labels) != 4 {
		t.Fatalf("第二次右键菜单项异常：%v", labels)
	}
	clickTabMenu(t, 0, "关闭全部")
	h.wait(t, "只剩空白标签页", `document.querySelectorAll('.tab').length === 1`)
	if name := h.text(t, ".tab.active .tab-name"); name != "未命名请求" {
		t.Fatalf("「关闭全部」之后应该是一个空白请求，实际 %q", name)
	}

	// 刷新：重新发一次请求，响应区出现状态码。
	h.openRequest(t, "GET 查询参数")
	h.clearOverlays(t)
	if name := h.text(t, ".tab.active .tab-name"); name != "GET 查询参数" {
		t.Fatalf("刷新前激活的应该是「GET 查询参数」，实际 %q", name)
	}
	if labels := activeTabMenuLabels(t); len(labels) != 4 {
		t.Fatalf("激活标签页的右键菜单项异常：%v", labels)
	}
	clickTabMenu(t, activeTabIndex(t), "刷新")
	h.wait(t, "刷新后拿到响应", `!!document.querySelector('.status-code')`)
	h.shot(t, "43-tab-menu-refresh")
}
