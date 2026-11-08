//go:build e2e

package e2e

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 分层操作列表：同一个阶段里按 全局 → 集合 → 文件夹 → 请求 的顺序执行，
// 后置反着来（请求 → 文件夹 → 集合 → 全局）；层内按行的顺序。

// appendOrderScript 生成一段往 X-Order 头里追加标记的前置脚本，并打一条日志。
func appendOrderScript(mark string) string {
	return strings.Join([]string{
		fmt.Sprintf(`console.log("%s-pre");`, mark),
		fmt.Sprintf(`pm.request.headers.upsert("X-Order", (pm.request.headers.get("X-Order") || "") + "%s,");`, mark),
	}, "\n")
}

// scriptLogHeads 按顺序读每条脚本记录的表头（脚本名 · 来源 · 阶段）与首行日志。
func scriptLogHeads(t *testing.T) []string {
	t.Helper()
	openConsoleTab(t)
	var joined string
	h.eval(t, `[...document.querySelectorAll('.script-log-run')].map(run => {
  const head = (run.querySelector('.script-log-phase') || {}).textContent || '';
  const line = (run.querySelector('.script-log-line') || {}).textContent || '';
  return head.trim() + '|' + line.trim();
}).join('\n')`, &joined)
	if joined == "" {
		return nil
	}
	return strings.Split(joined, "\n")
}

// openGlobalSettings 打开设置弹窗。
func openGlobalSettings(t *testing.T) {
	t.Helper()
	h.clearOverlays(t)
	h.click(t, `[data-role="settings"]`)
	h.wait(t, "设置弹窗打开", `!!document.querySelector('.settings-section')`)
}

// openStepsPane 在当前可见的对话框里切到某一阶段的操作列表。
// 设置弹窗里两段是并排的（各带自己的标题），共享设置弹窗同理，按阶段标题定位。
func openStepsPane(t *testing.T, phase string) {
	t.Helper()
	title := "前置操作"
	if phase == "post" {
		title = "后置操作"
	}
	h.wait(t, "操作面板就绪", fmt.Sprintf(
		`[...document.querySelectorAll('.settings-sub')].some(sub => (sub.querySelector('h4') || {}).textContent === %s && !!sub.querySelector('.step-panel'))`,
		jsString(title),
	))
}

// addPaneStep 在对话框里某一阶段的列表末尾加一步（块作用域按阶段标题定位）。
func addPaneStep(t *testing.T, phase, kind string) {
	t.Helper()
	title := "前置操作"
	if phase == "post" {
		title = "后置操作"
	}
	before := h.count(t, ".step-row")
	script := fmt.Sprintf(`(() => {
  const sub = [...document.querySelectorAll('.settings-sub')].find(node => (node.querySelector('h4') || {}).textContent === %s);
  const btn = sub && sub.querySelector('.step-add');
  if (!btn) return false;
  btn.click();
  return true;
})()`, jsString(title))
	var ok bool
	h.eval(t, script, &ok)
	if !ok {
		t.Fatalf("找不到「%s」的添加按钮", title)
	}
	h.wait(t, "添加操作菜单展开", `!!document.querySelector('.ctx-menu')`)
	clickMenuItem(t, kind)
	h.wait(t, "操作行出现", fmt.Sprintf(`document.querySelectorAll('.step-row').length === %d`, before+1))
}

// fillPaneSource 往对话框里某一阶段第 n 行（从 1 开始）写源码。
func fillPaneSource(t *testing.T, phase string, index int, code string) {
	t.Helper()
	title := "前置操作"
	if phase == "post" {
		title = "后置操作"
	}
	script := fmt.Sprintf(`(() => {
  const sub = [...document.querySelectorAll('.settings-sub')].find(node => (node.querySelector('h4') || {}).textContent === %s);
  const area = sub && sub.querySelectorAll('.step-row')[%d]?.querySelector('.script-input');
  if (!area) return false;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, %s);
  area.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`, jsString(title), index-1, jsString(code))
	var ok bool
	h.eval(t, script, &ok)
	if !ok {
		t.Fatalf("找不到「%s」的第 %d 行代码框", title, index)
	}
}

// clearGlobalSteps 清掉设置里「全局操作」的所有行。
// 全局操作对所有请求生效：本用例建的必须自己删干净，否则会污染后面每个用例的发送。
func clearGlobalSteps(t *testing.T) {
	t.Cleanup(func() {
		openGlobalSettings(t)
		for i := 0; i < 40; i++ {
			before := h.count(t, ".settings-sub .step-row")
			if before == 0 {
				break
			}
			h.click(t, ".settings-sub .step-row .step-more")
			h.wait(t, "行菜单展开", `!!document.querySelector('.ctx-menu')`)
			clickMenuItem(t, "删除")
			if h.exists(t, ".prompt-dialog") {
				h.clickContaining(t, ".prompt-dialog .btn", "删除")
			}
			h.wait(t, "全局操作行被删掉", fmt.Sprintf(
				`document.querySelectorAll('.settings-sub .step-row').length === %d`, before-1,
			))
		}
		h.clearOverlays(t)
	})
}

func TestScriptStepOrderAcrossLayers(t *testing.T) {
	const (
		colName = "分层脚本集合"
		reqName = "分层脚本请求"
	)
	cleanupScripts(t)
	clearGlobalSteps(t)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/echo")
	saveTabInto(t, reqName, colName, "")
	h.openRequest(t, reqName)

	// 全局：设置 → 全局操作 → 前置一步。
	openGlobalSettings(t)
	openStepsPane(t, "pre")
	addPaneStep(t, "pre", "脚本")
	fillPaneSource(t, "pre", 1, appendOrderScript("g"))
	h.clearOverlays(t)

	// 集合：共享设置 → 前置一步。
	openSharedSettings(t, colName)
	openStepsPane(t, "pre")
	addPaneStep(t, "pre", "脚本")
	fillPaneSource(t, "pre", 1, appendOrderScript("c"))
	h.clearOverlays(t)

	// 请求：前置两步（r1、r2），用来验证层内顺序与上移。
	addRequestStep(t, "pre", "脚本")
	fillStepSource(t, 1, appendOrderScript("r1"))
	addStep(t, "pre", "脚本")
	fillStepSource(t, 2, appendOrderScript("r2"))

	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("发送失败：状态 %q，提示：%s\n应用日志：\n%s", got, h.text(t, ".toasts"), h.appLog())
	}
	// 前置按 全局 → 集合 → 请求(1,2) 追加。
	if body := h.responseText(t); !strings.Contains(body, "g,c,r1,r2") {
		t.Fatalf("前置的执行顺序不对，桩服务收到的 X-Order 不是 g,c,r1,r2：%s", body)
	}

	// 上移请求层的第二行：层内顺序变成 r2 → r1。
	stepMenu(t, 2, "上移")
	if rows := stepRows(t); strings.Join(rows, ",") != "脚本|console.log(\"r2-pre\");,脚本|console.log(\"r1-pre\");" {
		t.Fatalf("上移之后请求层顺序不对：%v", rows)
	}
	h.send(t)
	if body := h.responseText(t); !strings.Contains(body, "g,c,r2,r1") {
		t.Fatalf("上移之后执行顺序没变：%s", body)
	}

	// 后置反着来：先建三层，再发一次。
	openGlobalSettings(t)
	openStepsPane(t, "post")
	addPaneStep(t, "post", "脚本")
	fillPaneSource(t, "post", 1, `console.log("g-post");`)
	h.clearOverlays(t)
	openSharedSettings(t, colName)
	openStepsPane(t, "post")
	addPaneStep(t, "post", "脚本")
	fillPaneSource(t, "post", 1, `console.log("c-post");`)
	h.clearOverlays(t)
	openStepsTab(t, "post")
	addStep(t, "post", "脚本")
	fillStepSource(t, 1, `console.log("r-post");`)

	h.clearToasts(t)
	h.send(t)
	want := strings.Join([]string{
		"内联脚本 · 前置脚本|g-pre",
		"内联脚本 · " + colName + " · 前置脚本|c-pre",
		"内联脚本 · " + reqName + " · 前置脚本|r2-pre",
		"内联脚本 · " + reqName + " · 前置脚本|r1-pre",
		"内联脚本 · " + reqName + " · 后置脚本|r-post",
		"内联脚本 · " + colName + " · 后置脚本|c-post",
		"内联脚本 · 后置脚本|g-post",
	}, "\n")
	if got := strings.Join(scriptLogHeads(t), "\n"); got != want {
		t.Fatalf("脚本执行顺序不对：\n实际：\n%s\n期望：\n%s", got, want)
	}
	h.clearToasts(t)
	h.shot(t, "54-script-step-order")

	deleteCollectionViaMenu(t, colName)
}

// 401 → 后置脚本发现 401 就调登录接口、写环境变量并重发，重发那一轮带上新 token。
func TestScriptResendAfterLogin(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	openScriptLibrary(t)
	addLibraryScript(t, "带 token", strings.Join([]string{
		`const tok = pm.environment.get("e2eToken");`,
		`if (tok) pm.request.headers.upsert("Authorization", "Bearer " + tok);`,
		`console.log(tok ? "带上已有 token" : "还没有 token");`,
	}, "\n"))
	addLibraryScript(t, "登录后重发", strings.Join([]string{
		`console.log("响应码 " + pm.response.code);`,
		`if (pm.response.code === 401) {`,
		`  const login = await pm.sendRequest({ url: "{{baseUrl}}/login", method: "GET" });`,
		`  pm.environment.set("e2eToken", login.json().token);`,
		`  console.log("登录拿到 token，重发原请求");`,
		`  pm.execution.resend();`,
		`}`,
	}, "\n"))
	h.clearOverlays(t)

	newTab(t)
	typeURL(t, "{{baseUrl}}/protected")
	addRequestStep(t, "pre", "脚本库")
	pickStepLibrary(t, 1, "带 token")
	openStepsTab(t, "post")
	addStep(t, "post", "脚本库")
	pickStepLibrary(t, 1, "登录后重发")

	h.send(t)

	if got := h.status(t); got != "200" {
		t.Fatalf("重发之后仍然失败：状态 %q，响应：%s，提示：%s\n应用日志：\n%s",
			got, h.text(t, ".response"), h.text(t, ".toasts"), h.appLog())
	}
	if body := h.responseText(t); !strings.Contains(body, "fixture") {
		t.Fatalf("响应体不是受保护接口的内容：%s", body)
	}
	// 两轮发送各有前置 + 后置，脚本记录应当攒成四段。
	openConsoleTab(t)
	if got := h.count(t, ".script-log-run"); got != 4 {
		t.Fatalf("脚本记录应该有 4 段（重发一轮），实际 %d 段：%s", got, h.text(t, ".script-log"))
	}
	logs := h.text(t, ".script-log")
	if !strings.Contains(logs, "响应码 401") || !strings.Contains(logs, "响应码 200") {
		t.Fatalf("两轮响应码不对：%q", logs)
	}
	if !strings.Contains(logs, "登录拿到 token，重发原请求") {
		t.Fatalf("重发日志缺失：%q", logs)
	}
	h.clearToasts(t)
	h.shot(t, "53-script-resend")
}

// 脚本库与分层操作要跨重启保留：库在 settings 的 scriptLibrary，
// 全局操作在 globalScripts，请求自己的操作随 request 一起存。
func TestScriptsPersistAcrossRestart(t *testing.T) {
	const (
		colName = "持久脚本集合"
		reqName = "持久脚本请求"
	)
	cleanupScripts(t)
	clearGlobalSteps(t)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/json")
	saveTabInto(t, reqName, colName, "")

	openScriptLibrary(t)
	addLibraryScript(t, "持久库脚本", `console.log("persist-library");`)
	h.clearOverlays(t)
	h.openRequest(t, reqName)

	openGlobalSettings(t)
	openGlobalSettings(t)
	openStepsPane(t, "pre")
	addPaneStep(t, "pre", "脚本库")
	h.wait(t, "全局脚本库行就绪", `!!document.querySelector('.settings-sub .step-picker .select')`)
	var picked bool
	h.eval(t, `(() => {
  const row = document.querySelector('.settings-sub .step-picker .select');
  const trigger = row && row.querySelector('.select-trigger');
  if (!trigger) return false;
  trigger.click();
  return true;
})()`, &picked)
	if !picked {
		t.Fatal("全局操作的脚本库下拉没有触发器")
	}
	h.wait(t, "下拉展开", `!!document.querySelector('.select-menu .select-option')`)
	h.clickContaining(t, ".select-menu .select-option", "持久库脚本")
	h.wait(t, "下拉收起", `!document.querySelector('.select-menu')`)
	h.clearOverlays(t)

	// 集合层的操作写在库里的 settings 列，也要跟着重启活下来。
	openSharedSettings(t, colName)
	openStepsPane(t, "pre")
	addPaneStep(t, "pre", "脚本")
	fillPaneSource(t, "pre", 1, `console.log("persist-collection");`)
	h.clearOverlays(t)

	openStepsTab(t, "pre")
	addStep(t, "pre", "脚本")
	fillStepSource(t, 1, `console.log("persist-request");`)
	// 保存过的请求，改动要按 Ctrl+S 写回集合树才会落库。
	saveTabInto(t, reqName, colName, "")

	waitForCommit(t, filepath.Join(h.userData, "workspace.db"), time.Now())
	h.restart(t)

	openScriptLibrary(t)
	names := strings.Join(libraryScriptNames(t), ",")
	if !strings.Contains(names, "持久库脚本") {
		t.Fatalf("重启后脚本库丢了：%q", names)
	}
	selectLibraryScript(t, "持久库脚本")
	var source string
	h.eval(t, `(document.querySelector('.script-lib-editor .script-input') || {}).value || ''`, &source)
	if !strings.Contains(source, "persist-library") {
		t.Fatalf("重启后脚本源码丢了：%q", source)
	}
	h.clearOverlays(t)

	h.openRequest(t, reqName)
	openGlobalSettings(t)
	openStepsPane(t, "pre")
	var globalRows string
	h.eval(t, `[...document.querySelectorAll('.settings-sub .step-row')].map(row => (row.querySelector('.step-hint') || {}).textContent || '').join('|')`, &globalRows)
	if !strings.Contains(globalRows, "持久库脚本") {
		t.Fatalf("重启后全局的前置操作丢了：%q", globalRows)
	}
	h.clearOverlays(t)

	openSharedSettings(t, colName)
	openStepsPane(t, "pre")
	var colRows string
	h.eval(t, `[...document.querySelectorAll('.settings-sub .step-row')].map(row => (row.querySelector('.step-hint') || {}).textContent || '').join('|')`, &colRows)
	if !strings.Contains(colRows, "persist-collection") {
		t.Fatalf("重启后集合的前置操作丢了：%q", colRows)
	}
	h.clearOverlays(t)

	// 重启后默认激活的是第一个标签页，先切回要检查的那个请求。
	h.openRequest(t, reqName)
	openStepsTab(t, "pre")
	if rows := stepRows(t); len(rows) != 1 || !strings.Contains(rows[0], "persist-request") {
		t.Fatalf("重启后请求自己的前置操作丢了：%v", rows)
	}

	deleteCollectionViaMenu(t, colName)
}

// 脚本输出收在响应区的「控制台」页签里：默认停在响应体，徽标提示有输出，
// 输出再长也只在自己的滚动区里滚，不挪动页签行。
func TestScriptConsoleTab(t *testing.T) {
	cleanupScripts(t)
	clearGlobalSteps(t)
	h.clearOverlays(t)
	newTab(t)
	typeURL(t, "{{baseUrl}}/json")

	// 没有脚本时也有这个页签，点开是一句空态，而不是空白。
	h.send(t)
	openConsoleTab(t)
	if text := h.text(t, ".console-view"); !strings.Contains(text, "还没有脚本输出") {
		t.Fatalf("没有脚本时控制台应当给空态提示，实际 %q", text)
	}
	clickIn(t, ".response-subtabs", "响应体")
	h.wait(t, "回到响应体", `!!document.querySelector('.response-body') && !document.querySelector('.console-view')`)

	openStepsTab(t, "pre")
	addRequestStep(t, "pre", "脚本")
	fillStepSource(t, 1, `for (let i = 0; i < 60; i++) console.log("line " + i);`)
	h.send(t)
	h.wait(t, "控制台徽标出现", `[...document.querySelectorAll('.response-subtabs .subtab')]
		.some(el => (el.textContent || '').trim().startsWith('控制台') && !!el.querySelector('.subtab-badge'))`)

	// 发送后仍停在响应体：脚本输出要自己点「控制台」看，不再抢正文的位置。
	if !h.exists(t, ".response-body") || h.exists(t, ".console-view") {
		t.Fatalf("发送后应当停在响应体页签，实际区域：%s", h.text(t, ".response-subtabs"))
	}
	var badge string
	h.eval(t, `(() => {
  const tab = [...document.querySelectorAll('.response-subtabs .subtab')]
    .find(el => (el.textContent || '').trim().startsWith('控制台'));
  if (!tab) return 'missing';
  const b = tab.querySelector('.subtab-badge');
  return (b ? b.textContent.trim() : '') + '/' + (b ? b.className : '');
})()`, &badge)
	if badge != "1/subtab-badge" {
		t.Fatalf("控制台徽标应当是有 1 段记录的普通徽标，实际 %q", badge)
	}

	openConsoleTab(t)
	if got, want := h.count(t, ".script-log-line"), 60; got != want {
		t.Fatalf("控制台里应有 %d 行日志，实际 %d", want, got)
	}
	// 输出区跟着正文区滚：长日志撑满后自己溢出滚动，而不是把响应区顶长。
	var scrolls bool
	h.eval(t, `(() => {
  const box = document.querySelector('.console-view');
  return box.scrollHeight > box.clientHeight + 4;
})()`, &scrolls)
	if !scrolls {
		t.Fatalf("长日志应当在控制台页签里滚动，实际没有溢出")
	}

	// 页签行的屏幕纵坐标：切页签时不能上下动。
	stripTop := func() float64 {
		t.Helper()
		var top float64
		h.eval(t, `document.querySelector('.response-subtabs').getBoundingClientRect().top`, &top)
		return top
	}
	first := stripTop()
	for _, label := range []string{"响应头", "链路", "请求", "响应体", "控制台"} {
		clickIn(t, ".response-subtabs", label)
		h.wait(t, "页签生效", fmt.Sprintf(
			`[...document.querySelectorAll('.response-subtabs .subtab.active')]
				.some(el => (el.textContent || '').includes(%s))`,
			jsString(label),
		))
		if top := stripTop(); top-first > 0.5 || first-top > 0.5 {
			t.Fatalf("切到「%s」后页签行从 %.1f 挪到了 %.1f", label, first, top)
		}
	}
	h.shot(t, "57-script-console-tab")

	// 断言没过时徽标变红，用户扫一眼就知道要去看控制台。
	openStepsTab(t, "pre")
	fillStepSource(t, 1, `pm.test("故意失败", () => { throw new Error("预期失败"); });`)
	h.send(t)
	h.wait(t, "徽标变红", `!!document.querySelector('.response-subtabs .subtab-badge.bad')`)
	openConsoleTab(t)
	if text := h.text(t, ".script-test.fail .script-test-error"); !strings.Contains(text, "预期失败") {
		t.Fatalf("控制台里应该能看到失败原因，实际 %q", text)
	}

	// 两种主题都要看过：浅色、深色各拍一张，再把主题还给后续用例。
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="light"]`) {
		t.Fatalf("没能切到浅色主题")
	}
	h.shot(t, "58-script-console-tab-light")
	h.click(t, `[data-role="theme"]`)
	h.wait(t, "回到深色主题", `document.documentElement.dataset.theme === "dark"`)
	h.clearToasts(t)
}
