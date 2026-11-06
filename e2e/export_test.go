//go:build e2e

package e2e

import (
	"os/exec"
	"strings"
	"testing"
	"time"
)

// clipboard 读系统剪贴板：导出结果只落在剪贴板里，这是唯一能验证内容的方式。
func clipboard(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw").Output()
	if err != nil {
		t.Fatalf("读剪贴板失败：%v", err)
	}
	return string(out)
}

// 导出 cURL 时，放在查询参数里的 API Key 必须拼进地址，否则复制出去的
// 命令换个环境就是 401。
func TestExportCurlKeepsApiKeyInQuery(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	h.typeInto(t, ".url-input", "api.example.com/v1/search?q=mygo")
	blurURL(t)

	h.clickContaining(t, ".subtabs:not(.response-subtabs) .subtab", "认证")
	h.wait(t, "认证面板出现", `[...document.querySelectorAll('.segmented-item')].some(el => el.textContent.trim() === 'API Key')`)
	h.clickText(t, ".segmented-item", "API Key")
	h.wait(t, "API Key 名称输入框出现", `[...document.querySelectorAll('.field-label')].some(el => el.textContent.trim() === '名称')`)

	h.typeInto(t, ".form-grid > .field:nth-of-type(1) .text-input", "api_key")
	h.typeInto(t, ".form-grid > .field:nth-of-type(2) .text-input", "secret-123")
	h.wait(t, "查询参数选项出现", `[...document.querySelectorAll('.segmented-item')].some(el => el.textContent.trim() === '放在查询参数')`)
	h.clickText(t, ".segmented-item", "放在查询参数")
	time.Sleep(200 * time.Millisecond)

	// 行内「复制为 cURL」按钮已去重（顶栏导入 + 代码片段 + 快捷键），这里走快捷键。
	h.pressKeys(t, "c", true, true)
	// 剪贴板写失败时也超时，所以等「任何提示」再把文案打出来，便于定位是复制失败还是别的原因。
	h.wait(t, "出现复制结果提示", `document.querySelectorAll('.toast').length > 0`)
	if got := h.text(t, ".toast"); !strings.Contains(got, "已复制") {
		t.Fatalf("复制 cURL 失败：%q", got)
	}

	got := clipboard(t)
	if !strings.Contains(got, "curl") {
		t.Fatalf("剪贴板内容不像 cURL 命令：%q", got)
	}
	if !strings.Contains(got, "api_key=secret-123") {
		t.Fatalf("查询参数里的 API Key 没有导出：\n%s", got)
	}
	if !strings.Contains(got, "q=mygo") {
		t.Fatalf("原有的查询参数丢了：\n%s", got)
	}
}
