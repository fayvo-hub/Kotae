//go:build e2e

package e2e

import (
	"encoding/json"
	"strings"
	"testing"
)

type chipInfo struct {
	Text  string `json:"t"`
	Title string `json:"title"`
}

// statusChips 读响应状态条上的所有 chip（文本 + title）。
func statusChips(t *testing.T) []chipInfo {
	t.Helper()
	var raw string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.status-meta .chip')].map(c => ({t: (c.textContent || '').trim(), title: c.getAttribute('title') || ''})))`, &raw)
	var out []chipInfo
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析状态条 chip 失败：%v（原始值 %s）", err, raw)
	}
	return out
}

// 耗时拆成「等待响应」与「下载正文」两段，鼠标悬停能看到拆分。
func TestTimingBreakdown(t *testing.T) {
	h.clearOverlays(t)
	h.openRequest(t, "GET 查询参数")
	h.typeInto(t, ".url-input", "{{baseUrl}}/slow?ms=200")
	blurURL(t)
	h.wait(t, "地址已写入", `document.querySelector('.url-input').value.includes('/slow')`)
	h.send(t)

	chips := statusChips(t)
	var timing *chipInfo
	for i := range chips {
		if strings.Contains(chips[i].Text, "耗时") {
			timing = &chips[i]
			break
		}
	}
	if timing == nil {
		t.Fatalf("状态条里没有耗时 chip：%+v", chips)
	}
	if !strings.Contains(timing.Title, "等待响应") || !strings.Contains(timing.Title, "下载正文") {
		t.Fatalf("耗时 chip 没有拆分说明：title=%q", timing.Title)
	}
	if !strings.Contains(timing.Text, "200") && !strings.Contains(timing.Text, "2") {
		t.Fatalf("耗时应该不小于 200ms，实际 %q", timing.Text)
	}
	// 跟随重定向时给最终地址提示。
	h.typeInto(t, ".url-input", "{{baseUrl}}/redirect")
	blurURL(t)
	h.wait(t, "地址已写入", `document.querySelector('.url-input').value.includes('/redirect')`)
	h.send(t)

	chips = statusChips(t)
	var redirect *chipInfo
	for i := range chips {
		if strings.Contains(chips[i].Text, "重定向") {
			redirect = &chips[i]
			break
		}
	}
	if redirect == nil {
		t.Fatalf("跟随重定向后没有重定向 chip：%+v", chips)
	}
	if !strings.Contains(redirect.Title, "/json") {
		t.Fatalf("重定向 chip 应该带上最终地址，实际 title=%q", redirect.Title)
	}

	// 这个标签页是固定用例里的公共数据，改回原地址，别影响后面的用例。
	h.typeInto(t, ".url-input", "{{baseUrl}}/echo")
	blurURL(t)
	h.wait(t, "地址已改回", `document.querySelector('.url-input').value.includes('/echo')`)
}
