//go:build e2e

package e2e

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 脚本库：多条脚本按列表顺序执行，前置全部跑完再跑后置。
// 用日志顺序与累加的请求头证明「顺序就是执行顺序」，并验证上移能改掉它。

// appendOrderScript 生成一段往 X-Order 头里追加标记的前置脚本，并打一条日志。
func appendOrderScript(mark string) string {
	return strings.Join([]string{
		fmt.Sprintf(`console.log("%s-pre");`, mark),
		fmt.Sprintf(`pm.request.headers.upsert("X-Order", (pm.request.headers.get("X-Order") || "") + "%s,");`, mark),
	}, "\n")
}

// scriptLogHeads 按顺序读每条脚本记录的表头（脚本名 · 来源 · 阶段）。
func scriptLogHeads(t *testing.T) []string {
	t.Helper()
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

func TestScriptLibraryOrder(t *testing.T) {
	const (
		colName = "脚本库集合"
		reqName = "脚本库请求"
	)
	cleanupScripts(t)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/echo")
	saveTabInto(t, reqName, colName, "")
	h.openRequest(t, reqName)

	colScope := "集合「" + colName + "」"
	reqScope := "请求「" + reqName + "」"
	globalScope := "全局（所有请求）"

	openScriptLibrary(t)
	addLibraryScript(t, "全局签名", "pre", globalScope, appendOrderScript("g"))
	addLibraryScript(t, "集合标记", "pre", colScope, appendOrderScript("c"))
	addLibraryScript(t, "本请求标记", "pre", reqScope, appendOrderScript("r"))
	addLibraryScript(t, "全局收尾", "post", globalScope, `console.log("g-post");`)
	addLibraryScript(t, "集合收尾", "post", colScope, `console.log("c-post");`)
	addLibraryScript(t, "本请求收尾", "post", reqScope, `console.log("r-post");`)
	if names := libraryScriptNames(t); len(names) != 6 {
		t.Fatalf("脚本库里应有 6 条脚本，实际 %v", names)
	}
	h.clearOverlays(t)

	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("发送失败：状态 %q，提示：%s\n应用日志：\n%s", got, h.text(t, ".toasts"), h.appLog())
	}

	// 三条前置按库里的顺序追加 g → c → r。
	if body := h.responseText(t); !strings.Contains(body, "g,c,r") {
		t.Fatalf("前置脚本的执行顺序不对，桩服务收到的 X-Order 不是 g,c,r：%s", body)
	}

	want := strings.Join([]string{
		"全局签名 · 前置脚本|g-pre",
		"集合标记 · " + colName + " · 前置脚本|c-pre",
		"本请求标记 · " + reqName + " · 前置脚本|r-pre",
		"全局收尾 · 后置脚本|g-post",
		"集合收尾 · " + colName + " · 后置脚本|c-post",
		"本请求收尾 · " + reqName + " · 后置脚本|r-post",
	}, "\n")
	if got := strings.Join(scriptLogHeads(t), "\n"); got != want {
		t.Fatalf("脚本执行顺序不对：\n实际：\n%s\n期望：\n%s", got, want)
	}

	// 上移「本请求标记」：顺序变成 全局 → 本请求 → 集合，桩服务收到的头也跟着变。
	openScriptLibrary(t)
	selectLibraryScript(t, "本请求标记")
	h.clickContaining(t, ".script-lib-side .tools-row .btn", "上移")
	wantOrder := []string{"全局签名", "本请求标记", "集合标记", "全局收尾", "集合收尾", "本请求收尾"}
	if names := libraryScriptNames(t); strings.Join(names, ",") != strings.Join(wantOrder, ",") {
		t.Fatalf("上移之后列表顺序不对：%v", names)
	}
	h.clearOverlays(t)

	h.send(t)
	if body := h.responseText(t); !strings.Contains(body, "g,r,c") {
		t.Fatalf("上移之后执行顺序没变，X-Order 不是 g,r,c：%s", body)
	}
	h.clearToasts(t)
	h.shot(t, "54-script-library-order")

	deleteCollectionViaMenu(t, colName)
}

// 401 → 后置脚本发现 401 就调登录接口、写环境变量并重发，重发那一轮带上新 token。
func TestScriptResendAfterLogin(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	openScriptLibrary(t)
	addLibraryScript(t, "带 token", "pre", "全局（所有请求）", strings.Join([]string{
		`const tok = pm.environment.get("e2eToken");`,
		`if (tok) pm.request.headers.upsert("Authorization", "Bearer " + tok);`,
		`console.log(tok ? "带上已有 token" : "还没有 token");`,
	}, "\n"))
	addLibraryScript(t, "登录后重发", "post", "全局（所有请求）", strings.Join([]string{
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
	h.send(t)

	if got := h.status(t); got != "200" {
		t.Fatalf("重发之后仍然失败：状态 %q，响应：%s，提示：%s\n应用日志：\n%s",
			got, h.text(t, ".response"), h.text(t, ".toasts"), h.appLog())
	}
	if body := h.responseText(t); !strings.Contains(body, "fixture") {
		t.Fatalf("响应体不是受保护接口的内容：%s", body)
	}
	// 两轮发送各有前置 + 后置，脚本记录应当攒成四段。
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

// 脚本库要跨重启保留：全局脚本、集合脚本都在 settings 表的 scripts 里。
func TestScriptsPersistAcrossRestart(t *testing.T) {
	const (
		colName = "持久脚本集合"
		reqName = "持久脚本请求"
	)
	cleanupScripts(t)
	h.clearOverlays(t)
	newCollection(t, colName)
	newRequestVia(t, colName)
	typeURL(t, "{{baseUrl}}/json")
	saveTabInto(t, reqName, colName, "")

	openScriptLibrary(t)
	addLibraryScript(t, "持久全局", "pre", "全局（所有请求）", `console.log("persist-global");`)
	addLibraryScript(t, "持久集合", "pre", "集合「"+colName+"」", `console.log("persist-collection");`)
	h.clearOverlays(t)

	waitForCommit(t, filepath.Join(h.userData, "workspace.db"), time.Now())
	h.restart(t)

	openScriptLibrary(t)
	names := strings.Join(libraryScriptNames(t), ",")
	if !strings.Contains(names, "持久全局") || !strings.Contains(names, "持久集合") {
		t.Fatalf("重启后脚本库丢了：%q", names)
	}
	selectLibraryScript(t, "持久集合")
	var source string
	h.eval(t, `(document.querySelector('.script-lib-editor .script-input') || {}).value || ''`, &source)
	if !strings.Contains(source, "persist-collection") {
		t.Fatalf("重启后集合脚本的源码丢了：%q", source)
	}
	selectLibraryScript(t, "持久全局")
	h.eval(t, `(document.querySelector('.script-lib-editor .script-input') || {}).value || ''`, &source)
	if !strings.Contains(source, "persist-global") {
		t.Fatalf("重启后全局脚本的源码丢了：%q", source)
	}
	h.clearOverlays(t)

	deleteCollectionViaMenu(t, colName)
}
