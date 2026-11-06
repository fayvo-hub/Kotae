//go:build e2e

package e2e

import (
	"fmt"
	"testing"
)

// 响应体的结构化视图默认全部展开；「收起全部 / 展开全部」两个按钮能一键切换。
func TestJSONTreeDefaultExpanded(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	h.typeInto(t, ".url-input", h.echo.URL()+"/deep")
	blurURL(t)
	h.send(t)
	h.wait(t, "响应体树出现", `document.querySelectorAll('.json-host .json-node').length > 0`)

	counts := func() (all int, open int) {
		var text string
		h.eval(t, `JSON.stringify([document.querySelectorAll('.json-host .json-node').length, document.querySelectorAll('.json-host .json-node.open').length])`, &text)
		_, err := fmt.Sscanf(text, "[%d,%d]", &all, &open)
		if err != nil {
			t.Fatalf("读取节点数量失败：%v（%s）", err, text)
		}
		return all, open
	}

	all, open := counts()
	if all < 6 {
		t.Fatalf("用例数据层数不够，无法验证默认展开：只有 %d 个可折叠节点", all)
	}
	if all != open {
		t.Fatalf("结构化视图应当默认全部展开：共 %d 个节点，只展开了 %d 个", all, open)
	}

	h.clickText(t, ".link-btn", "收起全部")
	h.wait(t, "全部收起", `document.querySelectorAll('.json-host .json-node.open').length === 0`)
	h.shot(t, "38-json-collapsed")

	h.clickText(t, ".link-btn", "展开全部")
	h.wait(t, "全部展开", fmt.Sprintf(`document.querySelectorAll('.json-host .json-node.open').length === %d`, all))
	h.shot(t, "39-json-expanded")
}
