//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// 重定向逐跳链路与分阶段耗时：/redirect 会 302 到 /json，链路里应有两跳。
func TestRedirectChainAndTimings(t *testing.T) {
	openNewTab(t)
	typeURL(t, "{{baseUrl}}/redirect")
	h.send(t)

	if status := h.status(t); status != "200" {
		t.Fatalf("跟随后应拿到 200，实际 %q\n%s", status, h.responseText(t))
	}

	h.wait(t, "链路页签出现", `[...document.querySelectorAll('.response-subtabs .subtab')]
		.some(el => (el.textContent || '').includes('链路'))`)
	clickIn(t, ".response-subtabs", "链路")
	h.wait(t, "链路面板", `!!document.querySelector('.trace-view')`)

	type hop struct {
		Method string `json:"method"`
		URL    string `json:"url"`
		Status string `json:"status"`
	}
	var hops []hop
	h.eval(t, `[...document.querySelectorAll('.trace-hop')].map(row => ({
		method: (row.querySelector('.method-tag') || {}).textContent || '',
		url: (row.querySelector('.trace-url') || {}).textContent || '',
		status: (row.querySelector('.trace-status') || {}).textContent || '',
	}))`, &hops)
	if len(hops) != 2 {
		t.Fatalf("302 再 200 应是两跳，实际 %d 跳：%+v", len(hops), hops)
	}
	if hops[0].Status != "302" || hops[1].Status != "200" {
		t.Fatalf("跳链状态码应是 302 → 200，实际 %q → %q", hops[0].Status, hops[1].Status)
	}
	if !strings.HasSuffix(hops[0].URL, "/redirect") || !strings.HasSuffix(hops[1].URL, "/json") {
		t.Fatalf("跳链地址不对：%q → %q", hops[0].URL, hops[1].URL)
	}

	// 耗时拆解：本机回环通常没有 DNS/连接/TLS 开销，至少要有「总计」一行。
	if count := h.count(t, ".trace-phase"); count < 1 {
		t.Fatalf("耗时拆解至少要有总计一行，实际 %d", count)
	}
	h.wait(t, "总计行", `!!document.querySelector('.trace-phase.strong .trace-phase-ms')`)
	var total string
	h.eval(t, `(document.querySelector('.trace-phase.strong .trace-phase-ms') || {}).textContent || ''`, &total)
	if !strings.Contains(total, "ms") && !strings.Contains(total, "s") {
		t.Fatalf("总计耗时格式不对：%q", total)
	}

	// 页面内部头不能漏进响应头列表。
	clickIn(t, ".response-subtabs", "响应头")
	h.wait(t, "响应头列表", `!!document.querySelector('.headers-list')`)
	var leaked bool
	h.eval(t, fmt.Sprintf(`[...document.querySelectorAll('.header-key')]
		.some(el => (el.textContent || '').toLowerCase().startsWith('x-mygo-'))`), &leaked)
	if leaked {
		t.Fatalf("X-Mygo-* 内部头不应出现在响应头列表里")
	}
}

// 页签在响应区里可来回切换：链路 → 响应体 → 链路。
func TestTraceTabSwitchable(t *testing.T) {
	openNewTab(t)
	typeURL(t, "{{baseUrl}}/json")
	h.send(t)
	h.wait(t, "链路页签出现", `[...document.querySelectorAll('.response-subtabs .subtab')]
		.some(el => (el.textContent || '').includes('链路'))`)

	clickIn(t, ".response-subtabs", "链路")
	h.wait(t, "链路面板", `!!document.querySelector('.trace-view')`)
	if count := h.count(t, ".trace-hop"); count != 1 {
		t.Fatalf("没有重定向时应只有一跳，实际 %d", count)
	}

	clickIn(t, ".response-subtabs", "响应体")
	h.wait(t, "回到响应体", `!document.querySelector('.trace-view') && !!document.querySelector('.response-body')`)
}
