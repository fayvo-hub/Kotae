//go:build e2e

package e2e

import (
	"testing"
	"time"
)

// 响应体搜索的命中计数与 Enter 跳转：输入后显示「第几个/共几个」，当前命中有独立样式，
// Enter 往后跳一个，跳到末尾再回到第一个。
func TestBodySearchHitCount(t *testing.T) {
	h.clearOverlays(t)
	openNewTab(t)
	t.Cleanup(func() {
		h.eval(t, `(() => {
			const close = document.querySelector('.tab.active .tab-close');
			if (close) close.click();
			return true;
		})()`, nil)
	})

	// 用回显接口把同一段文字重复三遍塞进响应体，命中数才是确定的。
	typeURL(t, "{{baseUrl}}/echo")
	h.pickSelect(t, ".method-select", "POST")
	clickIn(t, ".subtabs:not(.response-subtabs)", "请求体")
	h.wait(t, "请求体面板", `!!document.querySelector('.segmented[aria-label="请求体类型"]')`)
	clickIn(t, `.segmented[aria-label="请求体类型"]`, "纯文本")
	h.wait(t, "请求体输入框", `!!document.querySelector('.code-input')`)
	h.typeInto(t, ".code-input", "zqx zqx zqx")
	h.send(t)
	h.wait(t, "响应体渲染出来", `!!document.querySelector('.response-body .code-view')`)

	const count = `document.querySelector('[data-role="body-search-count"]').textContent`
	const current = `document.querySelectorAll('.response-body .code-view mark.mark-current').length`

	// 第一次搜索：从第一处命中开始，计数是 1/3。
	h.typeInto(t, `[data-role="body-search"]`, "zqx")
	h.wait(t, "命中计数是 1/3", count+` === '1/3'`)
	h.wait(t, "只有一处命中被标成当前", current+` === 1`)

	// Enter 往后跳：2/3、3/3，再按一次回到 1/3。
	h.pressKeysOn(t, `[data-role="body-search"]`, "Enter", false, false)
	h.wait(t, "跳到第二处命中", count+` === '2/3'`)
	h.pressKeysOn(t, `[data-role="body-search"]`, "Enter", false, false)
	h.wait(t, "跳到第三处命中", count+` === '3/3'`)
	h.pressKeysOn(t, `[data-role="body-search"]`, "Enter", false, false)
	h.wait(t, "从末尾回到第一处命中", count+` === '1/3'`)

	// Shift+Enter 往前跳，且同样回环：1/3 往前是 3/3，再往前是 2/3。
	h.pressKeysOn(t, `[data-role="body-search"]`, "Enter", false, true)
	h.wait(t, "从开头回环到最后一处命中", count+` === '3/3'`)
	h.pressKeysOn(t, `[data-role="body-search"]`, "Enter", false, true)
	h.wait(t, "往前跳到第二处命中", count+` === '2/3'`)
	h.wait(t, "往回跳后仍只有一处命中被标成当前", current+` === 1`)

	// 两种主题都拍一张：当前命中换了强调色，深浅主题下都要一眼能认出。
	h.shot(t, "search-hit-count-dark")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i += 1 {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="light"]`) {
		t.Fatalf("没能切到浅色主题")
	}
	// 背景色有过渡，切完主题立刻拍会拍到半途的底色。
	time.Sleep(300 * time.Millisecond)
	h.shot(t, "search-hit-count-light")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="dark"]`); i += 1 {
		h.click(t, `[data-role="theme"]`)
	}

	// 换个搜不到的词：不给数字，直接说无匹配。
	h.typeInto(t, `[data-role="body-search"]`, "zqx-none")
	h.wait(t, "搜不到时提示无匹配", count+` === '无匹配'`)
}
