//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// 这些用例就是一份可执行的验收清单：每个都在真实窗口里点真实控件，
// 请求真的从 Go 侧发出，打到本机桩服务上。

func TestBoot(t *testing.T) {
	var title string
	h.eval(t, `document.title`, &title)
	if !strings.Contains(title, "Kotae") {
		t.Fatalf("窗口标题不对：%q", title)
	}
	if brand := h.text(t, ".brand-name"); brand != "Kotae" {
		t.Fatalf("品牌名不对：%q", brand)
	}
	// 固定数据里的集合、环境都到位了。
	if n := h.count(t, ".tree-row"); n < 3 {
		t.Fatalf("侧边栏只有 %d 行，固定数据没加载", n)
	}
	h.click(t, ".env-pill-btn")
	h.wait(t, "环境下拉展开", `!!document.querySelector('.env-menu')`)
	if n := h.count(t, ".env-menu-item[role=option]"); n < 1 {
		t.Fatalf("环境下拉里没有环境")
	}
	h.click(t, ".env-pill-btn")
	h.wait(t, "环境下拉收起", `!document.querySelector('.env-menu')`)
	// 状态栏显示环境名与统计。
	if status := h.text(t, ".status-left"); !strings.Contains(status, "固定环境") {
		t.Fatalf("状态栏没有显示当前环境：%q", status)
	}
	h.shot(t, "01-boot")
}

// 启动预热节点必须自己拆干净：它覆盖全屏，留着会挡住点击。
func TestPaintWarmupCleansUp(t *testing.T) {
	h.wait(t, "预热节点已移除", `!document.querySelector('.paint-warmup')`)
	if n := h.count(t, ".paint-warmup"); n != 0 {
		t.Fatalf("预热节点残留 %d 个，会盖住整个界面", n)
	}
}

func TestSendGET(t *testing.T) {
	h.openRequest(t, "GET 查询参数")
	// 地址栏保留 {{baseUrl}} 模板；解析后的完整地址只在发送后的「请求」页签里看。
	var url string
	h.eval(t, `document.querySelector('.url-input').value`, &url)
	if !strings.Contains(url, "{{baseUrl}}/echo") {
		t.Fatalf("地址栏应保留变量模板：%q", url)
	}

	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("状态码不对：%q\n应用日志：\n%s", got, h.appLog())
	}
	body := h.responseText(t)
	// 桩服务把方法、路径、查询串、请求头、请求体都回显出来——一次发送验证四件事。
	if !strings.Contains(body, "/echo") || !strings.Contains(body, "GET") {
		t.Fatalf("回显里没有方法或路径：%q", body)
	}
	// 耗时 / 大小 / 类型三个 chip 都在。
	if n := h.count(t, ".status-meta .chip"); n < 3 {
		t.Fatalf("响应状态条只显示了 %d 个指标", n)
	}
	// 查询参数带到了服务端：桩服务把 query 回显在 body 里。
	if !strings.Contains(body, "mygo") {
		t.Fatalf("查询参数没有发出去：%q", body)
	}
	h.shot(t, "02-send-get")
}

func TestPOSTJSONWithHeaderAndAuth(t *testing.T) {
	h.openRequest(t, "POST JSON 回显")
	h.clickText(t, ".subtab", "请求体")
	h.wait(t, "请求体编辑区出现", `!!document.querySelector('.code-input')`)

	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("状态码不对：%q", got)
	}
	body := h.responseText(t)
	for _, want := range []string{"x-fixture", "yes", "Bearer", "mygo"} {
		if !strings.Contains(body, want) {
			t.Fatalf("回显里缺少 %q：%q", want, body)
		}
	}
	// method 与 body 也应当原样到达服务端。
	if !strings.Contains(body, "POST") {
		t.Fatalf("服务端收到的不是 POST：%q", body)
	}
	h.shot(t, "03-post-json")
}

func TestRedirectFollowed(t *testing.T) {
	h.openRequest(t, "重定向跟随")
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("跟随重定向后状态码应为 200，实际 %q", got)
	}
	if body := h.responseText(t); !strings.Contains(body, "fixture") {
		t.Fatalf("重定向目标没有返回固定字段：%q", body)
	}
}

func TestErrorStatus(t *testing.T) {
	h.openRequest(t, "500 错误状态")
	h.send(t)
	if got := h.status(t); got != "500" {
		t.Fatalf("状态码应为 500，实际 %q", got)
	}
	// 500 也要能读到响应体。
	if body := h.responseText(t); !strings.Contains(body, "msg") && !strings.Contains(body, "message") {
		t.Fatalf("错误状态下的响应体没有渲染：%q", body)
	}
	h.shot(t, "04-error-status")
}

func TestTimeoutShowsChineseHint(t *testing.T) {
	h.openRequest(t, "超时 300ms")
	h.click(t, ".send-btn")
	h.wait(t, "超时提示出现", `(document.querySelector('.error-text')?.textContent || '').includes('超时')`)
	var text string
	h.eval(t, `document.querySelector('.error-text').textContent.trim()`, &text)
	if !strings.Contains(text, "请求超时") {
		t.Fatalf("超时提示不是中文文案：%q", text)
	}
	h.shot(t, "05-timeout")
}

func TestUndefinedVariableBlocked(t *testing.T) {
	h.openRequest(t, "未定义变量")
	h.click(t, ".send-btn")
	h.wait(t, "未定义变量提示", `[...document.querySelectorAll('.toast')].some(t => (t.textContent || '').includes('未定义的变量'))`)
	var toastText string
	h.eval(t, `[...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).join(' | ')`, &toastText)
	if !strings.Contains(toastText, "undefinedBase") {
		t.Fatalf("提示里没有指出缺失的变量名：%q", toastText)
	}
	h.shot(t, "06-undefined-variable")
}

func TestTextAndBinaryResponses(t *testing.T) {
	h.openRequest(t, "纯文本")
	h.send(t)
	if body := h.responseText(t); !strings.Contains(body, "纯文本响应") {
		t.Fatalf("文本响应没有按文本渲染：%q", body)
	}

	h.openRequest(t, "二进制响应")
	h.send(t)
	body := h.responseText(t)
	if !strings.Contains(body, "二进制响应") {
		t.Fatalf("二进制响应没有给出提示：%q", body)
	}
	h.shot(t, "07-binary")
}

func TestCookieJarKeepsSession(t *testing.T) {
	h.openRequest(t, "Cookie 回显")
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("第一次请求失败：%q", got)
	}
	// 第二次请求应当带上第一次种下的 Cookie（Go 侧 Cookie 罐）。
	h.send(t)
	body := h.responseText(t)
	if !strings.Contains(body, "fixture_session=abc123") {
		t.Fatalf("Cookie 没有保持住：%q", body)
	}
}

func TestCurlImport(t *testing.T) {
	h.pressKeys(t, "i", true, false)
	h.wait(t, "cURL 导入浮层出现", `!!document.querySelector('.curl-input')`)
	curl := `curl -X PUT '{{baseUrl}}/echo' -H 'X-Test: 1' -d '{"a":1}'`
	h.typeInto(t, ".curl-input", curl)
	h.clickText(t, ".dialog .btn", "解析")
	h.wait(t, "解析结果预览出现", `!!document.querySelector('.preview-card')`)
	if preview := h.text(t, ".preview-card"); !strings.Contains(preview, "/echo") {
		t.Fatalf("预览卡里没有解析出的地址：%q", preview)
	}
	h.shot(t, "08-curl-import")
	h.clickText(t, ".dialog-foot .btn", "替换当前请求")
	h.wait(t, "浮层关闭", `!document.querySelector('.curl-input')`)
	var method, url string
	method = h.selectValue(t, ".method-select")
	h.eval(t, `document.querySelector('.url-input').value`, &url)
	if method != "PUT" {
		t.Fatalf("导入后方法应为 PUT，实际 %q", method)
	}
	if !strings.Contains(url, "/echo") {
		t.Fatalf("导入后地址不对：%q", url)
	}
}

func TestSendImportedCurl(t *testing.T) {
	// 上一条用例留下的 PUT 请求直接发出去，验证导入 → 发送是通的。
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("导入的请求发送失败：%q\n应用日志：\n%s", got, h.appLog())
	}
	body := h.responseText(t)
	if !strings.Contains(body, "PUT") {
		t.Fatalf("服务端没有收到 PUT：%q", body)
	}
	// 桩服务回显的 content-length 是 7，正好是 {"a":1} 的长度。
	if !strings.Contains(body, "content-length") || !strings.Contains(body, "x-test") {
		t.Fatalf("服务端没有收到请求体与自定义请求头：%q", body)
	}
}

func TestSaveDialogAndNewCollection(t *testing.T) {
	// 新建一个标签页，它没有来源集合，Ctrl+S 应当打开保存对话框。
	h.pressKeys(t, "n", true, false)
	h.wait(t, "出现新的空标签页", `document.querySelectorAll('.tab').length >= 2`)
	h.pressKeys(t, "s", true, false)
	h.wait(t, "保存对话框出现", `!!document.querySelector('.dialog .dialog-head')`)
	if fields := h.count(t, ".dialog .field"); fields < 3 {
		t.Fatalf("保存对话框只有 %d 个字段", fields)
	}
	h.shot(t, "09-save-dialog")
	h.clickText(t, ".dialog-foot .btn", "取消")
	h.wait(t, "对话框关闭", `!document.querySelector('.dialog')`)

	// 侧边栏新建集合走应用内输入框（不是浏览器 prompt）。
	h.click(t, ".sidebar-foot .btn")
	h.wait(t, "输入框出现", `!!document.querySelector('.prompt-dialog .text-input')`)
	h.typeInto(t, ".prompt-dialog .text-input", "E2E 新建集合")
	h.shot(t, "10-prompt")
	h.clickText(t, ".prompt-dialog .btn", "创建")
	h.wait(t, "新集合出现在侧边栏", `[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === 'E2E 新建集合')`)
}

// 已经存进集合的请求再按 Ctrl+S 只覆盖那一条，不再弹「保存到哪个集合」；
// 没存过的请求仍然弹对话框让用户选集合与名称。
func TestSaveUpdatesExistingRequest(t *testing.T) {
	const (
		colName = "原地保存集合"
		reqName = "原地保存请求"
	)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/json")
	saveTabInto(t, reqName, colName, "")

	// 改掉地址再保存：原地覆盖，不弹框，集合里也不该多出一条同名请求。
	typeURL(t, "{{baseUrl}}/echo")
	saveTabInPlace(t)
	var nodes int
	h.eval(t, fmt.Sprintf(`[...document.querySelectorAll('.tree-label')].filter(el => (el.textContent || '').trim() === %s).length`, jsString(reqName)), &nodes)
	if nodes != 1 {
		t.Fatalf("集合里应有 1 条「%s」，实际 %d 条", reqName, nodes)
	}

	// 关掉标签页再从集合打开：读到的必须是覆盖后的地址，证明写回了集合节点。
	before := h.count(t, ".tab")
	h.pressKeys(t, "w", true, false)
	h.wait(t, "标签页关闭", fmt.Sprintf(`document.querySelectorAll('.tab').length === %d`, before-1))
	h.openRequest(t, reqName)
	var url string
	h.eval(t, `document.querySelector('.url-input').value`, &url)
	if url != "{{baseUrl}}/echo" {
		t.Fatalf("集合里存的地址没被覆盖：%q", url)
	}
}

// 原地保存只刷新标签条与集合树：请求面板里显示的就是刚存进集合的那份内容，
// 整页重绘会把输入框与变量高亮镜像层重建一遍，视觉上就是每按一次 Ctrl+S 闪一下。
func TestSaveInPlaceKeepsRequestPanel(t *testing.T) {
	const (
		colName = "保存不重建集合"
		reqName = "保存不重建请求"
	)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/json")
	saveTabInto(t, reqName, colName, "")

	typeURL(t, "{{baseUrl}}/echo")
	// 在输入框与请求面板上各存一个标记：保存后标记还在，说明 DOM 没被重建。
	h.eval(t, `(() => {
		document.querySelector('.url-input').__keep = 'url';
		document.querySelector('.request-panel').__keep = 'panel';
		return true;
	})()`, nil)
	saveTabInPlace(t)
	var kept bool
	h.eval(t, `document.querySelector('.url-input').__keep === 'url' && document.querySelector('.request-panel').__keep === 'panel'`, &kept)
	if !kept {
		t.Fatal("原地保存把请求面板整块重建了：输入框被换掉，界面会闪一下")
	}
	// 局部刷新不能漏掉未保存标记与集合树里的名字。
	if h.exists(t, ".tab.active .tab-dirty") {
		t.Fatal("原地保存后未保存标记还在")
	}
	h.wait(t, "集合树里仍有这条请求", fmt.Sprintf(`[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === %s)`, jsString(reqName)))
}

func TestEnvDialogShowsVariables(t *testing.T) {
	h.pressKeys(t, "e", true, false)
	h.wait(t, "环境浮层出现", `!!document.querySelector('.env-layout')`)
	text := h.text(t, ".env-layout")
	if !strings.Contains(text, "固定环境") {
		t.Fatalf("环境浮层里没有当前环境名：%q", text)
	}
	// 变量表是输入框，读 value 而不是文本。
	var values []string
	h.eval(t, `[...document.querySelectorAll('.env-detail .kv-row')].map(r => [...r.querySelectorAll('input')].map(i => i.value).join('='))`, &values)
	joined := strings.Join(values, " | ")
	for _, want := range []string{"baseUrl=", "token="} {
		if !strings.Contains(joined, want) {
			t.Fatalf("变量表里缺少 %q：%q", want, joined)
		}
	}
	h.shot(t, "11-env-dialog")
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "环境浮层关闭", `!document.querySelector('.env-layout')`)
}

func TestCommandPalette(t *testing.T) {
	h.pressKeys(t, "k", true, false)
	h.wait(t, "命令面板出现", `!!document.querySelector('.palette')`)
	if items := h.count(t, ".palette-item"); items < 8 {
		t.Fatalf("命令面板只有 %d 条", items)
	}
	h.shot(t, "12-palette")
	// 搜索过滤：输入请求名后只剩匹配项。
	h.typeInto(t, ".palette-input input, .palette-search", "重定向")
	h.wait(t, "过滤生效", `document.querySelectorAll('.palette-item').length < 8`)
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "命令面板关闭", `!document.querySelector('.palette')`)
}

func TestThemeToggle(t *testing.T) {
	var before string
	h.eval(t, `document.documentElement.dataset.theme || 'auto'`, &before)
	h.click(t, `[data-role="theme"]`)
	h.wait(t, "主题发生变化", `(document.documentElement.dataset.theme || 'auto') !== `+jsString(before))
	var after string
	h.eval(t, `document.documentElement.dataset.theme`, &after)
	if after == before {
		t.Fatalf("主题没有切换：%q → %q", before, after)
	}
	h.shot(t, "13-theme-"+after)
}

func TestHistoryRecordsRequests(t *testing.T) {
	h.clickContaining(t, ".sidebar-tab", "历史")
	h.wait(t, "历史列表出现记录", `document.querySelectorAll('.history-row').length >= 3`)
	rows := h.count(t, ".history-row")
	if rows < 3 {
		t.Fatalf("历史里只有 %d 条记录", rows)
	}
	h.shot(t, "14-history")
	h.clickContaining(t, ".sidebar-tab", "集合")
}

func TestNoPageErrors(t *testing.T) {
	// 前面的用例都在真实窗口里跑过，这里检查页面有没有报错。
	var errs []string
	h.eval(t, `(window.__e2eErrors || []).slice(0, 10)`, &errs)
	if len(errs) > 0 {
		t.Fatalf("页面出现了 %d 个错误：%v\n应用日志：\n%s", len(errs), errs, h.appLog())
	}
}

// 系统默认右键菜单（WebView2 的刷新 / 检查 / 另存为 / 复制粘贴）整个窗口都关掉了，
// 应用自绘的 .ctx-menu 照旧打开。
type ctxMenuProbe struct {
	Prevented bool `json:"prevented"`
	Menus     int  `json:"menus"`
}

func TestNativeContextMenuDisabled(t *testing.T) {
	h.clearOverlays(t)
	var probe ctxMenuProbe
	h.eval(t, `(() => {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 });
  const target = document.querySelector('.response-panel') || document.body;
  target.dispatchEvent(ev);
  return { prevented: ev.defaultPrevented, menus: document.querySelectorAll('.ctx-menu').length };
})()`, &probe)
	if !probe.Prevented {
		t.Fatalf("空白处右键没有拦下系统默认菜单")
	}
	if probe.Menus != 0 {
		t.Fatalf("空白处右键弹出了 %d 个自绘菜单，应该一个都不弹", probe.Menus)
	}
	// 自绘菜单不受影响：标签页右键照旧出四个菜单项。
	if labels := tabMenuLabels(t, 0); len(labels) != 4 {
		t.Fatalf("标签页右键菜单项异常：%v", labels)
	}
	h.clearOverlays(t)
}
