//go:build e2e

package e2e

import (
	"encoding/json"
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

// 超长值（URL 编码、内嵌 JSON 串）不得把 key 挤成单字一列：key 保持一行、
// 值在剩余宽度里折行，响应区不出现横向滚动。
func TestJSONTreeLongValueKeepsKeyReadable(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	h.typeInto(t, ".url-input", h.echo.URL()+"/longvalue")
	blurURL(t)
	h.send(t)
	h.wait(t, "长值那一行出现", `[...document.querySelectorAll('.json-host .json-key')].some((k) => k.textContent === 'command')`)

	var raw string
	h.eval(t, `(() => {
  const key = [...document.querySelectorAll('.json-host .json-key')].find((k) => k.textContent === 'command');
  const r = key.getBoundingClientRect();
  const host = document.querySelector('.body-view');
  return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), overflow: host.scrollWidth - host.clientWidth });
})()`, &raw)
	var got struct {
		W        int
		H        int
		Overflow int
	}
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("读取 key 尺寸失败：%v（%s）", err, raw)
	}
	// 被超长值挤压时，key 宽度只剩一个字符（约 7px），高度会到上百像素。
	if got.H > 30 || got.W < 30 {
		t.Fatalf("key 被超长值挤压：宽 %dpx、高 %dpx，应保持单行（约 50×21）", got.W, got.H)
	}
	if got.Overflow > 0 {
		t.Fatalf("响应区横向溢出 %dpx，长值应当在剩余宽度内折行", got.Overflow)
	}

	// 两种主题都看一眼：本次只动布局，但折行后的观感得两边都确认。
	h.shot(t, "60-json-long-value-dark")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="light"]`) {
		t.Fatalf("没能切到浅色主题")
	}
	h.shot(t, "61-json-long-value-light")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="dark"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="dark"]`) {
		t.Fatalf("没能切回深色主题（后续用例默认深色）")
	}
}
