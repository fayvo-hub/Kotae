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

	// 状态栏要显示实际连上的服务器地址：域名只是输入，改过 hosts / DNS
	// 之后只有对端地址能看出请求还连着旧机器。
	h.wait(t, "服务器地址", `[...document.querySelectorAll('.status-meta .chip-label')]
		.some(el => (el.textContent || '') === '服务器')`)
	var serverAddr string
	h.eval(t, `(() => {
		const chip = [...document.querySelectorAll('.status-meta .chip')]
			.find(c => (c.querySelector('.chip-label') || {}).textContent === '服务器');
		return chip ? (chip.querySelector('.chip-value') || {}).textContent || '' : '';
	})()`, &serverAddr)
	if !strings.HasPrefix(serverAddr, "127.0.0.1:") {
		t.Fatalf("服务器地址应指向本机桩服务 127.0.0.1:端口，实际 %q", serverAddr)
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

	// 每跳行里也要写出对端地址，且和状态栏（最后一跳）一致。
	var hopAddrs []string
	h.eval(t, `[...document.querySelectorAll('.trace-hop .trace-addr')].map(el => (el.textContent || '').trim())`, &hopAddrs)
	if len(hopAddrs) != len(hops) {
		t.Fatalf("每跳都要有对端地址，实际 %d 个地址 / %d 跳：%v", len(hopAddrs), len(hops), hopAddrs)
	}
	for i, addr := range hopAddrs {
		if addr != serverAddr {
			t.Fatalf("第 %d 跳的对端地址应与状态栏一致：%q vs %q", i+1, addr, serverAddr)
		}
	}

	// 两种主题都看一眼：每跳多了一列对端地址，窄窗口下不能把状态码挤出去。
	h.shot(t, "72-trace-addrs-dark")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="light"]`) {
		t.Fatalf("没能切到浅色主题")
	}
	h.shot(t, "73-trace-addrs-light")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="dark"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="dark"]`) {
		t.Fatalf("没能切回深色主题（后续用例默认深色）")
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

	// 每次发送都重新建连接：连发两次同一地址，第二次不能标成「复用了已有连接」，
	// 否则改完 hosts / DNS 还连着旧机器。
	connText := `[...document.querySelectorAll('.trace-view .muted.small')]
  .map(el => (el.textContent || '').trim())
  .find(t => t === '新建连接' || t === '复用了已有连接') || ''`
	h.wait(t, "连接状态就位", "("+connText+") !== ''")
	var firstConn string
	h.eval(t, connText, &firstConn)
	if firstConn != "新建连接" {
		t.Fatalf("首次发送应新建连接，实际 %q", firstConn)
	}

	// 换一个带查询串的地址再发一次：URL 变化当作「这次响应已渲染」的锦点，
	// 不能拿上一份结果当新的。
	typeURL(t, "{{baseUrl}}/json?again=1")
	h.send(t)
	clickIn(t, ".response-subtabs", "链路")
	h.wait(t, "第二次发送完成", `(() => {
  const url = document.querySelector('.trace-hop .trace-url');
  return document.querySelectorAll('.trace-hop').length === 1 &&
    !!url && (url.textContent || '').includes('again=1');
})()`)
	var secondConn string
	h.eval(t, connText, &secondConn)
	if secondConn != "新建连接" {
		t.Fatalf("换一次发送也必须新建连接（改 hosts 才能立刻生效），实际 %q", secondConn)
	}

	clickIn(t, ".response-subtabs", "响应体")
	h.wait(t, "回到响应体", `!document.querySelector('.trace-view') && !!document.querySelector('.response-body')`)
}
