//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// 环境级公共参数：当前环境配好的查询参数与请求头，发送时自动附加到每个请求。
// 覆盖两条落地路径、请求优先、未定义变量拦下、停用行不附加、cURL 导出、SSE 握手。

const (
	commonQuerySection  = ".env-section-query"
	commonHeaderSection = ".env-section-header"
)

// openEnvCommon 打开环境对话框，并等到公共参数的两个分组都渲染出来。
func openEnvCommon(t *testing.T) {
	t.Helper()
	if h.exists(t, commonQuerySection+" .kv-foot") && h.exists(t, commonHeaderSection+" .kv-foot") {
		return
	}
	h.clearOverlays(t)
	h.pressKeys(t, "e", true, false)
	h.wait(t, "环境对话框里的公共参数分组", `!!document.querySelector('.env-section-query .kv-foot') && !!document.querySelector('.env-section-header .kv-foot')`)
}

// addCommonRow 往某个公共参数分组里加一行，并填好键与值（走真实 input 事件，和手输一致）。
func addCommonRow(t *testing.T, section, key, value string) {
	t.Helper()
	openEnvCommon(t)
	before := h.count(t, section+" .kv-row")
	var clicked bool
	h.eval(t, fmt.Sprintf(`(() => {
  const root = document.querySelector(%s);
  if (!root) return false;
  const btn = [...root.querySelectorAll('.kv-foot .link-btn')].find((b) => (b.textContent || '').trim().startsWith('添加一行'));
  if (!btn) return false;
  btn.click();
  return true;
})()`, jsString(section)), &clicked)
	if !clicked {
		t.Fatalf("公共参数分组里找不到「添加一行」：%s", section)
	}
	h.wait(t, "公共参数多出一行", fmt.Sprintf(`document.querySelectorAll(%s).length === %d`, jsString(section+" .kv-row"), before+1))
	h.eval(t, fmt.Sprintf(`(() => {
  const rows = [...document.querySelectorAll(%s)];
  const row = rows[rows.length - 1];
  const put = (selector, text) => {
    const input = row.querySelector(selector);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  put('.kv-key', %s);
  put('.kv-value', %s);
  return true;
})()`, jsString(section+" .kv-row"), jsString(key), jsString(value)), nil)
}

// setCommonRowEnabled 点某一条公共参数的启停开关（关掉表示这次不想带）。
func setCommonRowEnabled(t *testing.T, section string, enabled bool) {
	t.Helper()
	openEnvCommon(t)
	var done bool
	h.eval(t, fmt.Sprintf(`(() => {
  const row = document.querySelector(%s);
  if (!row) return false;
  const check = row.querySelector('.kv-check');
  if (check.checked === %t) return false;
  check.click();
  return true;
})()`, jsString(section+" .kv-row"), enabled), &done)
	if !done {
		t.Fatalf("没有可切换的公共参数行：%s（期望 enabled=%v）", section, enabled)
	}
}

// resetCommonParams 清空两个分组的公共参数并关了对话框。
// e2e 全程只有一个应用实例，环境是全局的，用例之间必须互相收拾干净。
func resetCommonParams(t *testing.T) {
	t.Helper()
	openEnvCommon(t)
	h.eval(t, `(() => {
  for (let guard = 0; guard < 50; guard += 1) {
    const del = document.querySelector('.env-section .kv-del');
    if (!del) break;
    del.click();
  }
  return true;
})()`, nil)
	h.wait(t, "公共参数已清空", `document.querySelectorAll('.env-section .kv-row').length === 0`)
	closeDialog(t)
}

// withCommonEnv 给一个用例准备干净的环境面板，并在结束时把公共参数清掉。
// e2e 全程只有一个应用实例，环境的公共参数是全局的：不收拾会把后面的用例带脏
// （历史用例就是这么发现「莫名多出一个 appId=web」的）。
func withCommonEnv(t *testing.T) {
	t.Helper()
	h.clearOverlays(t)
	resetCommonParams(t)
	t.Cleanup(func() { clearCommonParams(t) })
}

// clearCommonParams 只把两个分组的行删干净（不做断言，用例收尾用）。
func clearCommonParams(t *testing.T) {
	t.Helper()
	openEnvCommon(t)
	h.eval(t, `(() => {
  for (let guard = 0; guard < 50; guard += 1) {
    const del = document.querySelector('.env-section .kv-del');
    if (!del) break;
    del.click();
  }
  return true;
})()`, nil)
	h.wait(t, "公共参数已清空", `document.querySelectorAll('.env-section .kv-row').length === 0`)
	closeDialog(t)
}

// addRequestParam 往请求面板的「查询参数」表里加一行。
func addRequestParam(t *testing.T, key, value string) {
	t.Helper()
	clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数")
	h.wait(t, "查询参数面板", `!!document.querySelector('.pane .kv-foot')`)
	var clicked bool
	h.eval(t, `(() => {
  const btn = [...document.querySelectorAll('.pane .kv-foot .link-btn')].find((b) => (b.textContent || '').trim().startsWith('添加一行'));
  if (!btn) return false;
  btn.click();
  return true;
})()`, &clicked)
	if !clicked {
		t.Fatalf("查询参数面板里找不到「添加一行」")
	}
	h.eval(t, fmt.Sprintf(`(() => {
  const rows = [...document.querySelectorAll('.pane .kv-row')];
  const row = rows[rows.length - 1];
  const put = (selector, text) => {
    const input = row.querySelector(selector);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  put('.kv-key', %s);
  put('.kv-value', %s);
  return true;
})()`, jsString(key), jsString(value)), nil)
}

// TestCommonParamsAttach 公共查询参数与公共请求头都要真的发出去，并出现在「请求」页签里。
func TestCommonParamsAttach(t *testing.T) {
	withCommonEnv(t)
	addCommonRow(t, commonQuerySection, "appId", "web")
	addCommonRow(t, commonHeaderSection, "X-Channel", "e2e")
	closeDialog(t)

	newTab(t)
	typeURL(t, "{{baseUrl}}/common")
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("状态码不对：%q\n应用日志：\n%s", got, h.appLog())
	}

	body := h.responseText(t)
	for _, want := range []string{"q:appId=web", "h:x-channel=e2e"} {
		if !strings.Contains(body, want) {
			t.Fatalf("桩服务没收到 %q：\n%s", want, body)
		}
	}

	// 「请求」页签看的是实际发出的快照：地址里有公共参数，请求头里也有。
	clickIn(t, ".response-subtabs", "请求")
	h.wait(t, "请求页签渲染", `!!document.querySelector('.sent-url')`)
	if url := h.text(t, ".sent-url"); !strings.Contains(url, "appId=web") {
		t.Fatalf("实际发送地址里没有公共参数：%q", url)
	}
	headers := text(t, h, `[...document.querySelectorAll('.headers-view .header-row')]
  .map((row) => (row.querySelector('.header-key')?.textContent || '').trim() + ': ' + (row.querySelector('.header-value')?.textContent || '').trim())
  .join('\n')`)
	if !strings.Contains(headers, "x-channel: e2e") {
		t.Fatalf("实际发出的请求头里没有公共请求头：\n%s", headers)
	}

	// 两种主题都看一眼：环境面板右侧新增了两段公共参数。
	openEnvCommon(t)
	// 弾入动画未跑完就截图会把遮罩拍成半透明，等一下再拍。
	time.Sleep(300 * time.Millisecond)
	h.shot(t, "70-env-common-dark")
	closeDialog(t)
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i += 1 {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="light"]`) {
		t.Fatalf("没能切到浅色主题")
	}
	openEnvCommon(t)
	time.Sleep(300 * time.Millisecond)
	h.shot(t, "71-env-common-light")
	closeDialog(t)
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="dark"]`); i += 1 {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="dark"]`) {
		t.Fatalf("没能切回深色主题（后续用例默认深色）")
	}
}

// TestCommonParamsRequestWins 请求自己写了同名参数时以请求为准，而且只发一份。
func TestCommonParamsRequestWins(t *testing.T) {
	withCommonEnv(t)
	addCommonRow(t, commonQuerySection, "appId", "web")
	closeDialog(t)

	newTab(t)
	typeURL(t, "{{baseUrl}}/common")
	addRequestParam(t, "appId", "own")
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("状态码不对：%q\n应用日志：\n%s", got, h.appLog())
	}

	body := h.responseText(t)
	if !strings.Contains(body, "q:appId=own") {
		t.Fatalf("请求自己的参数没生效：\n%s", body)
	}
	// 桩服务把多值用逗号连起来：出现「q:appId=web」就说明两个都发出去了。
	if strings.Contains(body, "q:appId=web") {
		t.Fatalf("同名时不应再附加公共参数：\n%s", body)
	}
}

// TestCommonParamsUndefinedVar 公共参数里的未定义变量同样要在发送前拦下。
func TestCommonParamsUndefinedVar(t *testing.T) {
	withCommonEnv(t)
	addCommonRow(t, commonQuerySection, "appId", "{{nope}}")
	closeDialog(t)

	newTab(t)
	typeURL(t, "{{baseUrl}}/common")
	h.send(t)
	h.wait(t, "未定义变量的提示", `[...document.querySelectorAll('.toast')].some((el) => (el.textContent || '').includes('未定义的变量') && (el.textContent || '').includes('nope'))`)
	// 被拦下就不会有响应：状态栏空着，「请求」页签也没有快照。
	if got := h.status(t); got != "" {
		t.Fatalf("未定义变量应当拦下请求，却收到了响应：%q", got)
	}
	if h.exists(t, ".sent-url") {
		t.Fatalf("拦下的请求不该留下发送快照")
	}
	h.clearToasts(t)
}

// TestCommonParamsDisabled 关掉启停开关的行不参与附加。
func TestCommonParamsDisabled(t *testing.T) {
	withCommonEnv(t)
	addCommonRow(t, commonQuerySection, "appId", "web")
	setCommonRowEnabled(t, commonQuerySection, false)
	closeDialog(t)

	newTab(t)
	typeURL(t, "{{baseUrl}}/common")
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("状态码不对：%q\n应用日志：\n%s", got, h.appLog())
	}
	if body := h.responseText(t); strings.Contains(body, "appId") {
		t.Fatalf("停用的公共参数仍然发出去了：\n%s", body)
	}
}

// TestCommonParamsCurlExport 复制成 cURL 时公共参数要带上，粘出去能直接跑。
func TestCommonParamsCurlExport(t *testing.T) {
	withCommonEnv(t)
	addCommonRow(t, commonQuerySection, "appId", "web")
	addCommonRow(t, commonHeaderSection, "X-Channel", "e2e")
	closeDialog(t)

	newTab(t)
	typeURL(t, "{{baseUrl}}/common")
	h.clearToasts(t)
	h.pressKeys(t, "c", true, true)
	h.wait(t, "出现复制结果提示", `document.querySelectorAll('.toast').length > 0 && [...document.querySelectorAll('.toast')].some((el) => (el.textContent || '').includes('已复制'))`)

	curl := clipboard(t)
	for _, want := range []string{"appId=web", "X-Channel", "e2e"} {
		if !strings.Contains(curl, want) {
			t.Fatalf("导出的 cURL 里缺少 %q：\n%s", want, curl)
		}
	}
}

// TestCommonParamsStreamHandshake SSE 握手地址同样要带上公共查询参数。
func TestCommonParamsStreamHandshake(t *testing.T) {
	withCommonEnv(t)
	addCommonRow(t, commonQuerySection, "appId", "web")
	closeDialog(t)

	newStreamTab(t, "sse", "{{baseUrl}}/sse?n=1")
	h.click(t, ".send-btn")
	h.wait(t, "收到事件流", `document.querySelectorAll('.stream-row').length >= 3`)

	joined := strings.Join(streamRows(t), "\n")
	if !strings.Contains(joined, "appId=web") {
		t.Fatalf("SSE 握手地址里没有公共参数：\n%s", joined)
	}
}
