//go:build e2e

package e2e

import (
	"fmt"
	"testing"
)

// 侧边栏树里所有可见标签的顺序（集合名、文件夹、请求都算）。
func treeLabels(t *testing.T) string {
	t.Helper()
	var out string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.tree-group .tree-row .tree-label')].map(el => (el.textContent || '').trim()))`, &out)
	return out
}

// dragRow 合成一次拖放：mode 决定落点在行的上半（before）、下半（after）还是中间（inside）。
func dragRow(t *testing.T, srcLabel, dstLabel, mode string) {
	t.Helper()
	var y string
	switch mode {
	case "before":
		y = "rect.top + 2"
	case "after":
		y = "rect.bottom - 2"
	default:
		y = "rect.top + rect.height / 2"
	}
	script := fmt.Sprintf(`(() => {
  const rows = [...document.querySelectorAll('.tree-row')];
  const name = (r) => (r.querySelector('.tree-label')?.textContent || '').trim();
  const src = rows.find(r => name(r) === %s);
  const dst = rows.find(r => name(r) === %s);
  if (!src || !dst || src === dst) return 'missing';
  const rect = dst.getBoundingClientRect();
  const y = %s;
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return 'ok';
})()`, jsString(srcLabel), jsString(dstLabel), y)
	var status string
	h.eval(t, script, &status)
	if status != "ok" {
		t.Fatalf("拖拽 %s → %s 失败：元素没找到（%s）", srcLabel, dstLabel, status)
	}
	// 拖放后 store 会同步 persist + emit，调用方紧跟 h.wait 断言即可。
}

// indexOfLabel 返回标签在树里的位置，-1 表示没找到。
func indexOfLabel(t *testing.T, label string) int {
	t.Helper()
	var idx int
	h.eval(t, fmt.Sprintf(`[...document.querySelectorAll('.tree-group .tree-row .tree-label')].findIndex(el => (el.textContent || '').trim() === %s)`, jsString(label)), &idx)
	return idx
}

func TestDragReorderInCollection(t *testing.T) {
	h.clearOverlays(t)
	before := treeLabels(t)
	if indexOfLabel(t, "GET 查询参数") < 0 || indexOfLabel(t, "POST JSON 回显") < 0 {
		t.Fatalf("固定用例集合缺少请求，树内容：%s", before)
	}

	// 把第二个请求拖到第一个之前：顺序互换。
	dragRow(t, "POST JSON 回显", "GET 查询参数", "before")
	h.wait(t, "拖拽后顺序互换", `(() => {
  const names = [...document.querySelectorAll('.tree-group .tree-row .tree-label')].map(el => (el.textContent || '').trim());
  return names.indexOf('POST JSON 回显') < names.indexOf('GET 查询参数') && names.indexOf('POST JSON 回显') >= 0;
})()`)

	// 再拖回去（放到「GET 查询参数」后面），整棵树应回到初始顺序。
	dragRow(t, "POST JSON 回显", "GET 查询参数", "after")
	h.wait(t, "拖回后恢复原顺序", `(() => {
  const names = [...document.querySelectorAll('.tree-group .tree-row .tree-label')].map(el => (el.textContent || '').trim());
  return names.indexOf('GET 查询参数') + 1 === names.indexOf('POST JSON 回显');
})()`)
	if after := treeLabels(t); after != before {
		t.Fatalf("拖回来之后顺序没完全恢复\n之前：%s\n之后：%s", before, after)
	}
}

func TestDragIntoFolderAndBack(t *testing.T) {
	h.clearOverlays(t)
	before := treeLabels(t)
	if indexOfLabel(t, "响应类型") < 0 || indexOfLabel(t, "Cookie 回显") < 0 {
		t.Fatalf("固定用例集合缺少文件夹或请求，树内容：%s", before)
	}

	// 把顶层请求拖进文件夹：落点 inside 会追加到文件夹末尾，也就是排在「Cookie 回显」之后。
	dragRow(t, "GET 查询参数", "响应类型", "inside")
	h.wait(t, "拖进文件夹", `(() => {
  const names = [...document.querySelectorAll('.tree-group .tree-row .tree-label')].map(el => (el.textContent || '').trim());
  const moved = names.indexOf('GET 查询参数');
  return moved > names.indexOf('响应类型') && moved === names.indexOf('Cookie 回显') + 1;
})()`)

	// 再拖回最前面，恢复初始顺序。
	dragRow(t, "GET 查询参数", "POST JSON 回显", "before")
	h.wait(t, "拖回顶层", `(() => {
  const names = [...document.querySelectorAll('.tree-group .tree-row .tree-label')].map(el => (el.textContent || '').trim());
  return names.indexOf('GET 查询参数') + 1 === names.indexOf('POST JSON 回显');
})()`)
	if after := treeLabels(t); after != before {
		t.Fatalf("从文件夹拖回来之后顺序没恢复\n之前：%s\n之后：%s", before, after)
	}

	// 文件夹不能拖进自己的子树：顺序应原样不动。
	dragRow(t, "响应类型", "纯文本", "inside")
	if after := treeLabels(t); after != before {
		t.Fatalf("文件夹被拖进了自己的子树\n之前：%s\n之后：%s", before, after)
	}
}
