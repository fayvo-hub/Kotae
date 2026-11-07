//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

// openNewTab 保证当前有一个空的「未命名请求」标签页可以用。
//
// 两个坑都在这里：①不能拿「标签数 + 1」当判据，DOM 是异步重绘的，读到的数可能
// 比 state 早一帧，读到偏大的旧值时永远等不到；②当前标签已经是空标签时按 Ctrl+N
// 会多开一个，紧接着 typeURL 可能写进正在被替换的旧标签。所以先判断能不能直接
// 用当前标签，只有确实需要时才新开。
func openNewTab(t *testing.T) {
	t.Helper()
	h.wait(t, "界面就绪", `!!document.querySelector('.tab.active')`)
	const emptyActive = `(() => {
	  const active = document.querySelector('.tab.active');
	  const url = document.querySelector('.url-input');
	  if (!active || !url) return false;
	  const label = active.querySelector('.tab-title') || active;
	  return label.textContent.includes('未命名请求') && url.value === '';
	})()`
	var reuse bool
	h.eval(t, emptyActive, &reuse)
	if reuse {
		return
	}
	h.pressKeys(t, "n", true, false)
	h.wait(t, "新标签页成为当前标签", emptyActive)
}

// cookieRowLabels 读当前 Cookie 管理器里的「名字 = 值」清单。
func cookieRowLabels(t *testing.T) []string {
	t.Helper()
	var rows []string
	h.eval(t, `[...document.querySelectorAll('.cookie-row')].map(row => {
	  const name = row.querySelector('.cookie-name');
	  const value = row.querySelector('.cookie-value');
	  return (name ? name.textContent : '') + '=' + (value ? value.textContent : '');
	})`, &rows)
	return rows
}

// TestCookieManager 走一遍「请求写入 Cookie → 管理器里看到 → 删掉 → 列表变空」。
func TestCookieManager(t *testing.T) {
	h.clearOverlays(t)
	openNewTab(t)
	typeURL(t, "{{baseUrl}}/cookie")
	commitURL(t)
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("桩服务没返回 200：%q", got)
	}

	clickIn(t, ".subtabs:not(.response-subtabs)", "选项")
	h.wait(t, "选项面板", `!!document.querySelector('.cookie-field')`)
	h.clickText(t, ".cookie-field .link-btn", "管理 Cookie")
	h.wait(t, "Cookie 管理器", `!!document.querySelector('.cookie-list')`)

	h.wait(t, "Cookie 列表里出现 fixture_session", `[...document.querySelectorAll('.cookie-name')].some(el => el.textContent === 'fixture_session')`)
	rows := cookieRowLabels(t)
	if len(rows) == 0 || !strings.HasPrefix(rows[0], "fixture_session=") {
		t.Fatalf("Cookie 列表内容不对：%v", rows)
	}
	if !strings.Contains(rows[0], "abc123") {
		t.Fatalf("Cookie 值没显示出来：%q", rows[0])
	}
	// 域名分组标题要能看出是哪个站点。
	if domain := h.text(t, ".cookie-domain"); !strings.HasPrefix(domain, "127.0.0.1") {
		t.Fatalf("域名分组是 %q，期望 127.0.0.1", domain)
	}

	// 筛选：命中保留，没命中的话列表显示空态。
	h.typeInto(t, ".cookie-search", "session")
	if got := len(cookieRowLabels(t)); got != 1 {
		t.Fatalf("筛选 session 后应该只剩 1 条，实际 %d 条", got)
	}
	h.eval(t, `(() => {
	  const el = document.querySelector('.cookie-search');
	  el.value = 'no-such-cookie';
	  el.dispatchEvent(new Event('input', { bubbles: true }));
	  return true;
	})()`, nil)
	h.wait(t, "筛选无结果", `document.querySelectorAll('.cookie-row').length === 0`)
	if hint := h.text(t, ".cookie-list .pane-empty"); !strings.Contains(hint, "没有匹配") {
		t.Fatalf("筛选无结果时的提示不对：%q", hint)
	}
	h.eval(t, `(() => {
	  const el = document.querySelector('.cookie-search');
	  el.value = '';
	  el.dispatchEvent(new Event('input', { bubbles: true }));
	  return true;
	})()`, nil)
	h.wait(t, "清空筛选", `document.querySelectorAll('.cookie-row').length > 0`)

	// 逐条删除。
	h.eval(t, `(() => {
	  const btn = document.querySelector('.cookie-row .icon-btn');
	  btn.click();
	  return true;
	})()`, nil)
	h.wait(t, "删掉后列表变空", `document.querySelectorAll('.cookie-row').length === 0`)
	if hint := h.text(t, ".cookie-list .pane-empty"); !strings.Contains(hint, "还没有 Cookie") {
		t.Fatalf("清空后的空态文案不对：%q", hint)
	}

	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "管理器关闭", `!document.querySelector('.cookie-list')`)
}

// TestClearAllCookies 验「清空全部」按钮。
func TestClearAllCookies(t *testing.T) {
	h.clearOverlays(t)
	openNewTab(t)
	typeURL(t, "{{baseUrl}}/cookie")
	commitURL(t)
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("桩服务没返回 200：%q", got)
	}
	clickIn(t, ".subtabs:not(.response-subtabs)", "选项")
	h.wait(t, "选项面板", `!!document.querySelector('.cookie-field')`)
	h.clickText(t, ".cookie-field .link-btn", "管理 Cookie")
	h.wait(t, "有 Cookie 可清", `document.querySelectorAll('.cookie-row').length > 0`)
	h.clickText(t, ".pane-toolbar .btn.danger", "清空全部")
	h.wait(t, "清空后列表为空", `document.querySelectorAll('.cookie-row').length === 0`)
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "管理器关闭", `!document.querySelector('.cookie-list')`)
}
