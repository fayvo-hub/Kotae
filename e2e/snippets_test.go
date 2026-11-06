//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

// 代码片段面板：四种语言都能按当前请求生成，并且复制出来就是生成的那段。
func TestSnippetDialog(t *testing.T) {
	h.clearOverlays(t)
	h.openRequest(t, "POST JSON 回显")

	h.pressKeys(t, "g", true, true)
	h.wait(t, "代码片段面板打开", `!!document.querySelector('.snippet-code')`)

	read := func() string {
		var text string
		h.eval(t, `document.querySelector('.snippet-code').textContent`, &text)
		return text
	}

	fetchCode := read()
	for _, want := range []string{`await fetch(`, `method: "POST"`, `"Authorization": "Bearer `} {
		if !strings.Contains(fetchCode, want) {
			t.Fatalf("fetch 片段缺少 %q：\n%s", want, fetchCode)
		}
	}

	h.clickText(t, ".segmented-item", "axios")
	h.wait(t, "切到 axios", `document.querySelector('.snippet-code').textContent.includes('axios.request')`)

	h.clickText(t, ".segmented-item", "requests")
	h.wait(t, "切到 requests", `document.querySelector('.snippet-code').textContent.includes('import requests')`)
	var py string
	h.eval(t, `document.querySelector('.snippet-code').textContent`, &py)
	if !strings.Contains(py, "requests.post(") {
		t.Fatalf("Python 片段没按 POST 生成：\n%s", py)
	}

	// 复制按钮要复制当前语言的那一份，而不是默认的 fetch。
	h.clickText(t, "button", "复制代码")
	h.wait(t, "提示复制成功", `document.body.textContent.includes('已复制代码片段')`)
	got := clipboard(t)
	if !strings.Contains(got, "import requests") {
		t.Fatalf("复制的不是当前语言的片段：%q", got)
	}

	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "面板关闭", `!document.querySelector('.snippet-code')`)
}
