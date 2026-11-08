//go:build e2e

package e2e

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 脚本分层：全局 → 集合 → 文件夹 → 请求，前置由外到内、后置由内到外。
// 三层都挂一条前置/后置脚本，用日志顺序与累加的请求头证明执行次序。

// setDialogScript 在已打开的弹窗里写某一段脚本（前置 / 后置）。
func setDialogScript(t *testing.T, phase, source string) {
	t.Helper()
	label := "前置脚本"
	if phase == "post" {
		label = "后置脚本"
	}
	h.clickText(t, ".dialog .script-switch .segmented-item", label)
	sel := fmt.Sprintf(`.dialog .script-input[data-phase="%s"]`, phase)
	h.wait(t, "弹窗里的脚本编辑器就绪", fmt.Sprintf(`!!document.querySelector(%s)`, jsString(sel)))
	h.typeInto(t, sel, source)
}

// dialogScript 读弹窗里当前那一段脚本的文本。
func dialogScript(t *testing.T, phase string) string {
	t.Helper()
	var value string
	h.eval(t, fmt.Sprintf(`(document.querySelector(%s) || {}).value || ''`,
		jsString(fmt.Sprintf(`.dialog .script-input[data-phase="%s"]`, phase))), &value)
	return value
}

// openSettings 打开设置弹窗并等到全局脚本编辑器就绪。
func openSettings(t *testing.T) {
	t.Helper()
	h.clearOverlays(t)
	h.pressKeys(t, ",", true, false)
	h.wait(t, "设置面板打开", `!!document.querySelector('.dialog .script-input[data-phase="pre"]')`)
}

// appendOrderScript 生成一段往 X-Order 头里追加标记的前置脚本，并打一条日志。
func appendOrderScript(mark string) string {
	return strings.Join([]string{
		fmt.Sprintf(`console.log("%s-pre");`, mark),
		fmt.Sprintf(`pm.request.headers.upsert("X-Order", (pm.request.headers.get("X-Order") || "") + "%s,");`, mark),
	}, "\n")
}

func TestScriptLayersOrder(t *testing.T) {
	const (
		colName = "分层脚本集合"
		reqName = "分层脚本请求"
	)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/echo")
	saveTabInto(t, reqName, colName, "")

	// 全局脚本：最先跑前置、最后跑后置。
	openSettings(t)
	setDialogScript(t, "pre", appendOrderScript("g"))
	setDialogScript(t, "post", `console.log("g-post");`)
	closeDialog(t)

	// 集合脚本：夹在全局与本请求之间。
	openSharedSettings(t, colName)
	setDialogScript(t, "pre", appendOrderScript("c"))
	setDialogScript(t, "post", `console.log("c-post");`)
	closeDialog(t)

	// 本请求脚本。
	h.openRequest(t, reqName)
	openScriptPane(t, "pre")
	h.typeInto(t, `.script-input[data-phase="pre"]`, appendOrderScript("r"))
	openScriptPane(t, "post")
	h.typeInto(t, `.script-input[data-phase="post"]`, `console.log("r-post");`)

	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("发送失败：状态 %q，提示：%s\n应用日志：\n%s", got, h.text(t, ".toasts"), h.appLog())
	}

	// 三层前置依次追加 g → c → r，桩服务回显的头里就是这么串的。
	if body := h.responseText(t); !strings.Contains(body, "g,c,r") {
		t.Fatalf("前置脚本的执行顺序不对，桩服务收到的 X-Order 不是 g,c,r：%s", body)
	}

	var order string
	h.eval(t, `[...document.querySelectorAll('.script-log-run')].map(run => {
  const head = (run.querySelector('.script-log-phase') || {}).textContent || '';
  const line = (run.querySelector('.script-log-line') || {}).textContent || '';
  return head + '|' + line;
}).join(' ; ')`, &order)
	colLabel := "集合「" + colName + "」"
	want := strings.Join([]string{
		"前置脚本 · 全局|g-pre",
		"前置脚本 · " + colLabel + "|c-pre",
		"前置脚本|r-pre",
		"后置脚本|r-post",
		"后置脚本 · " + colLabel + "|c-post",
		"后置脚本 · 全局|g-post",
	}, " ; ")
	if order != want {
		t.Fatalf("脚本执行顺序不对：\n实际：%s\n期望：%s", order, want)
	}

	// 收尾：全局脚本会作用于之后所有用例，必须清掉。
	openSettings(t)
	setDialogScript(t, "pre", "")
	setDialogScript(t, "post", "")
	closeDialog(t)
	deleteCollectionViaMenu(t, colName)
}

// 401 → 前置脚本拿环境里的 token → 后置脚本发现 401 就调登录接口、写环境变量并重发。
func TestScriptResendAfterLogin(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	openScriptPane(t, "pre")
	h.typeInto(t, `.script-input[data-phase="pre"]`, strings.Join([]string{
		`const tok = pm.environment.get("e2eToken");`,
		`if (tok) pm.request.headers.upsert("Authorization", "Bearer " + tok);`,
		`console.log(tok ? "带上已有 token" : "还没有 token");`,
	}, "\n"))

	openScriptPane(t, "post")
	h.typeInto(t, `.script-input[data-phase="post"]`, strings.Join([]string{
		`console.log("响应码 " + pm.response.code);`,
		`if (pm.response.code === 401) {`,
		`  const login = await pm.sendRequest({ url: "{{baseUrl}}/login", method: "GET" });`,
		`  pm.environment.set("e2eToken", login.json().token);`,
		`  console.log("登录拿到 token，重发原请求");`,
		`  pm.execution.resend();`,
		`}`,
	}, "\n"))

	typeURL(t, "{{baseUrl}}/protected")
	h.send(t)

	if got := h.status(t); got != "200" {
		t.Fatalf("重发之后仍然失败：状态 %q，响应：%s，提示：%s\n应用日志：\n%s",
			got, h.text(t, ".response"), h.text(t, ".toasts"), h.appLog())
	}
	body := h.responseText(t)
	if !strings.Contains(body, "fixture") {
		t.Fatalf("响应体不是受保护接口的内容：%s", body)
	}
	// 两次发送各有前置 + 后置，脚本记录应当攒成四段。
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

// 全局脚本与集合脚本都要跨重启保留：一个在 settings 表，一个在 collections.settings 列。
func TestScriptsPersistAcrossRestart(t *testing.T) {
	const (
		colName = "持久脚本集合"
		reqName = "持久脚本请求"
		global  = `console.log("persist-global");`
		shared  = `console.log("persist-collection");`
	)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/json")
	saveTabInto(t, reqName, colName, "")

	openSettings(t)
	setDialogScript(t, "pre", global)
	closeDialog(t)
	openSharedSettings(t, colName)
	setDialogScript(t, "pre", shared)
	closeDialog(t)

	waitForCommit(t, filepath.Join(h.userData, "workspace.db"), time.Now())
	h.restart(t)

	openSettings(t)
	if got := dialogScript(t, "pre"); !strings.Contains(got, "persist-global") {
		t.Fatalf("重启后全局脚本丢了：%q", got)
	}
	setDialogScript(t, "pre", "")
	closeDialog(t)

	h.openRequest(t, reqName)
	openSharedSettings(t, colName)
	if got := dialogScript(t, "pre"); !strings.Contains(got, "persist-collection") {
		t.Fatalf("重启后集合脚本丢了：%q", got)
	}
	setDialogScript(t, "pre", "")
	closeDialog(t)
	deleteCollectionViaMenu(t, colName)
}
