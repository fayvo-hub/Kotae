//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// ---- 脚本库浮层 ----

// openScriptLibrary 打开脚本库浮层。
func openScriptLibrary(t *testing.T) {
	t.Helper()
	h.clearOverlays(t)
	h.click(t, `[data-role="scripts"]`)
	h.wait(t, "脚本库打开", `!!document.querySelector('.script-lib')`)
}

// addLibraryScript 在脚本库里新建一条脚本并填好名字与源码。
// 脚本库只存「可复用的代码」，它在哪一层、哪个阶段跑由引用它的那一行决定。
func addLibraryScript(t *testing.T, name, source string) {
	t.Helper()
	before := h.count(t, ".script-lib-item")
	h.click(t, `[data-role="script-new"]`)
	h.wait(t, "新建的脚本出现在列表", fmt.Sprintf(
		`document.querySelectorAll('.script-lib-item').length === %d`, before+1,
	))
	h.typeInto(t, `.script-lib-editor [data-field="name"]`, name)
	if source != "" {
		h.typeInto(t, ".script-lib-editor .script-input", source)
	}
	h.wait(t, "脚本名写进列表", fmt.Sprintf(
		`[...document.querySelectorAll('.script-lib-item .script-lib-name')].some(n => (n.textContent || '').trim() === %s)`,
		jsString(name),
	))
}

// selectLibraryScript 在列表里点中某一条脚本。
func selectLibraryScript(t *testing.T, name string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const row = [...document.querySelectorAll('.script-lib-item')].find(el => (el.querySelector('.script-lib-name')?.textContent || '').trim() === %s);
  if (!row) return false;
  row.click();
  return true;
})()`, jsString(name))
	var ok bool
	h.eval(t, script, &ok)
	if !ok {
		t.Fatalf("脚本库里没有名为「%s」的脚本：%s", name, h.text(t, ".script-lib-list"))
	}
}

// libraryScriptNames 读列表里的脚本名。
func libraryScriptNames(t *testing.T) []string {
	t.Helper()
	var joined string
	h.eval(t, `[...document.querySelectorAll('.script-lib-item .script-lib-name')].map(n => (n.textContent || '').trim()).join('\n')`, &joined)
	if joined == "" {
		return nil
	}
	return strings.Split(joined, "\n")
}

// cleanupScripts 在本用例结束时清空脚本库。
// 脚本库是全局的：留着会污染后面所有用例的发送流程。
func cleanupScripts(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		openScriptLibrary(t)
		for i := 0; i < 30; i++ {
			before := h.count(t, ".script-lib-item")
			if before == 0 {
				break
			}
			h.click(t, ".script-lib-item")
			h.click(t, `[data-role="script-delete"]`)
			h.wait(t, "删除确认框出现", `!!document.querySelector('.prompt-dialog')`)
			h.clickContaining(t, ".prompt-dialog .btn", "删除")
			h.wait(t, "脚本被删掉", fmt.Sprintf(
				`document.querySelectorAll('.script-lib-item').length === %d`, before-1,
			))
		}
		h.clearOverlays(t)
	})
}

// ---- 前置 / 后置操作 ----

// openStepsTab 切到请求页签的「前置操作 / 后置操作」。
func openStepsTab(t *testing.T, phase string) {
	t.Helper()
	label := "前置操作"
	if phase == "post" {
		label = "后置操作"
	}
	h.activateSubtab(t, label)
	h.wait(t, "操作列表就绪", `!!document.querySelector('.step-panel')`)
}

// clickMenuItem 点开着的菜单里文字完全匹配的那一项。
func clickMenuItem(t *testing.T, label string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const el = [...document.querySelectorAll('.ctx-menu .env-menu-item')].find(
    node => ((node.querySelector('.env-menu-name') || {}).textContent || '').trim() === %s,
  );
  if (!el) return false;
  el.click();
  return true;
})()`, jsString(label))
	var ok bool
	h.eval(t, script, &ok)
	if !ok {
		t.Fatalf("菜单里没有「%s」这一项：%s", label, h.text(t, ".ctx-menu"))
	}
}

// addStep 在某一阶段末尾加一步操作（脚本 / 脚本库 / 等待时间）。
// 返回加完之后的行数。
func addStep(t *testing.T, phase, kind string) int {
	t.Helper()
	before := h.count(t, ".step-row")
	h.click(t, ".step-add")
	h.wait(t, "添加操作菜单展开", `!!document.querySelector('.ctx-menu .env-menu-item')`)
	clickMenuItem(t, kind)
	h.wait(t, "操作行出现", fmt.Sprintf(`document.querySelectorAll('.step-row').length === %d`, before+1))
	return before + 1
}

// addRequestStep 在请求页签的某一阶段加一步操作并等它就地展开。
func addRequestStep(t *testing.T, phase, kind string) int {
	t.Helper()
	openStepsTab(t, phase)
	return addStep(t, phase, kind)
}

// fillStepSource 往第 index 行（从 1 开始）的代码框里写源码。
func fillStepSource(t *testing.T, index int, code string) {
	t.Helper()
	sel := fmt.Sprintf(".step-row:nth-child(%d) .script-input", index)
	h.wait(t, "代码框就绪", fmt.Sprintf(`!!document.querySelector(%s)`, jsString(sel)))
	h.typeInto(t, sel, code)
}

// pickStepLibrary 在第 index 行里选中脚本库中的某条脚本。
func pickStepLibrary(t *testing.T, index int, name string) {
	t.Helper()
	row := fmt.Sprintf(".step-row:nth-child(%d)", index)
	// 下拉框收起是同步的，但行摘要靠 store 改动后的重绘才更新（重绘走 requestAnimationFrame），
	// 所以这里要等摘要真的变过来，不能收起就断言。
	h.wait(t, "脚本库下拉就绪", fmt.Sprintf(`!!document.querySelector(%s)`, jsString(row+" .step-picker .select")))
	h.pickSelect(t, row+" .step-picker .select", name)
	h.wait(t, "行摘要显示所选脚本", fmt.Sprintf(`(() => {
  const hint = document.querySelector(%s);
  return !!hint && (hint.textContent || '').trim() === %s;
})()`, jsString(row+" .step-hint"), jsString(name)))
}

// stepToggles 关掉 / 打开第 index 行（从 1 开始）。
func stepToggles(t *testing.T, index int) {
	t.Helper()
	h.click(t, fmt.Sprintf(".step-row:nth-child(%d) .step-switch", index))
}

// stepMenu 对第 index 行选「上移 / 下移 / 复制一份 / 删除」。
func stepMenu(t *testing.T, index int, label string) {
	t.Helper()
	h.click(t, fmt.Sprintf(".step-row:nth-child(%d) .step-more", index))
	h.wait(t, "行菜单展开", `!!document.querySelector('.ctx-menu .env-menu-item')`)
	clickMenuItem(t, label)
}

// stepRows 读每行的「类型|摘要」，用来断言顺序与内容。
func stepRows(t *testing.T) []string {
	t.Helper()
	var joined string
	h.eval(t, `[...document.querySelectorAll('.step-row')].map(row => {
  const kind = ((row.querySelector('.step-kind') || {}).textContent || '').trim();
  const hint = ((row.querySelector('.step-hint') || {}).textContent || '').trim();
  return kind + '|' + hint;
}).join('\n')`, &joined)
	if joined == "" {
		return nil
	}
	return strings.Split(joined, "\n")
}

// openConsoleTab 切到响应区的「控制台」页签：脚本输出、断言与报错都收在这里。
func openConsoleTab(t *testing.T) {
	t.Helper()
	if !h.exists(t, ".console-view") {
		clickIn(t, ".response-subtabs", "控制台")
		h.wait(t, "控制台页签生效", `!!document.querySelector('.console-view')`)
	}
}

// 前置脚本算 HMAC 签名：桩服务用同一个密钥验签，验不过会回 401。
func TestPreScriptSignsRequest(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	newTab(t)
	typeURL(t, "{{baseUrl}}/signed")
	addRequestStep(t, "pre", "脚本")
	fillStepSource(t, 1, strings.Join([]string{
		`const ts = String(pm.utils.now());`,
		`pm.request.headers.upsert("X-Ts", ts);`,
		`pm.request.headers.upsert("X-Sign", await pm.utils.hmacSha256("e2e-secret", "/signed|" + ts));`,
		`console.log("已签名 ts=" + ts);`,
	}, "\n"))
	h.send(t)

	if got := h.status(t); got != "200" {
		t.Fatalf("签名没通过，状态码是 %q，响应：%s", got, h.responseText(t))
	}
	if body := h.responseText(t); !strings.Contains(body, "verified") {
		t.Fatalf("响应体里没有验签结果：%s", body)
	}
	openConsoleTab(t)
	if log := h.text(t, ".script-log-line"); !strings.Contains(log, "已签名") {
		t.Fatalf("前置脚本的 console.log 没显示出来：%q", log)
	}
	h.clearToasts(t)
	h.shot(t, "50-pre-script-sign")
}

// 后置脚本把 base64 响应体解成中文，响应区要显示改写后的内容。
func TestPostScriptRewritesBody(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	newTab(t)
	typeURL(t, "{{baseUrl}}/b64")
	addRequestStep(t, "post", "脚本")
	fillStepSource(t, 1, `pm.response.setBody(pm.utils.base64Decode(pm.response.text()));`)
	h.send(t)

	if got := h.status(t); got != "200" {
		t.Fatalf("状态码不对：%q，区域文本：%s，toast：%s", got, h.text(t, ".response"), h.text(t, ".toasts"))
	}
	body := h.responseText(t)
	if !strings.Contains(body, "解码后的响应体：中文正常。") {
		t.Fatalf("响应体没有被后置脚本改写：%s", body)
	}
	openConsoleTab(t)
	if tag := h.text(t, ".script-log-tag"); tag != "已改写响应体" {
		t.Fatalf("没有标记响应体被改写：%q", tag)
	}
	h.clearToasts(t)
	h.shot(t, "51-post-script-body")
}

// 脚本库引用：同一段代码被引用后能跑，关掉开关就不跑。
func TestStepLibraryReference(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	openScriptLibrary(t)
	addLibraryScript(t, "库里的标记", `console.log("来自脚本库");`)
	h.clearOverlays(t)

	newTab(t)
	typeURL(t, "{{baseUrl}}/json")
	addRequestStep(t, "pre", "脚本库")
	if rows := stepRows(t); len(rows) != 1 || rows[0] != "脚本库|请选择" {
		t.Fatalf("新加的脚本库行应当是空的待选状态：%v", rows)
	}
	pickStepLibrary(t, 1, "库里的标记")
	if rows := stepRows(t); len(rows) != 1 || rows[0] != "脚本库|库里的标记" {
		t.Fatalf("选中之后行摘要应当是脚本名：%v", rows)
	}

	h.send(t)
	openConsoleTab(t)
	if logs := h.text(t, ".script-log-line"); !strings.Contains(logs, "来自脚本库") {
		t.Fatalf("引用的库脚本没执行：%q", logs)
	}

	// 关掉这一行：引用还在，但这次发送不该跑它。
	stepToggles(t, 1)
	h.wait(t, "行标记为停用", `document.querySelector('.step-row').classList.contains('off')`)
	h.send(t)
	openConsoleTab(t)
	if logs := h.text(t, ".script-log"); strings.Contains(logs, "来自脚本库") {
		t.Fatalf("停用的操作不该执行：%q", logs)
	}
	h.clearToasts(t)
	h.shot(t, "55-script-step-library")
}

// 等待时间：一步步停顿再继续，日志里的顺序与耗时都要对得上。
func TestWaitStepDelays(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	newTab(t)
	typeURL(t, "{{baseUrl}}/json")
	addRequestStep(t, "pre", "脚本")
	fillStepSource(t, 1, `console.log("第一步");`)
	addStep(t, "pre", "等待时间")
	h.typeInto(t, ".step-row:nth-child(2) .wait-input", "300")
	addStep(t, "pre", "脚本")
	fillStepSource(t, 3, `console.log("第三步");`)

	h.send(t)
	if rows := stepRows(t); len(rows) != 3 || rows[1] != "等待时间|300 毫秒" {
		t.Fatalf("等待行没记住毫秒数：%v", rows)
	}
	openConsoleTab(t)
	var heads string
	h.eval(t, `[...document.querySelectorAll('.script-log-run')].map(run => {
  const line = ((run.querySelector('.script-log-line') || {}).textContent || '').trim();
  const ms = ((run.querySelector('.script-log-ms') || {}).textContent || '').trim();
  return ms + '|' + line;
}).join('\n')`, &heads)
	if !strings.Contains(heads, "第一步") || !strings.Contains(heads, "第三步") {
		t.Fatalf("三段操作的日志不全：%q", heads)
	}
	if strings.Index(heads, "第一步") > strings.Index(heads, "等待") || strings.Index(heads, "等待") > strings.Index(heads, "第三步") {
		t.Fatalf("日志顺序应当是 脚本 → 等待 → 脚本：%q", heads)
	}
	if !strings.Contains(heads, "300 ms|") {
		t.Fatalf("等待那一步应当记下 300 ms：%q", heads)
	}
	h.clearToasts(t)
	h.shot(t, "56-script-wait-step")
}

// 导入来的脚本进脚本库但不执行，点「信任并启用」之后才跑。
func TestImportedScriptNeedsTrust(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	before := collectionCount(t)

	sample := `{
  "info": { "name": "带脚本的集合", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "item": [
    {
      "name": "带前置脚本的请求",
      "request": { "method": "GET", "url": "{{baseUrl}}/json" },
      "event": [
        { "listen": "prerequest", "script": { "exec": ["console.log('导入的前置脚本跑了');"] } }
      ]
    }
  ]
}`
	h.pressKeys(t, "i", true, true)
	h.wait(t, "导入面板打开", `!!document.querySelector('.curl-input')`)
	fillImportBox(t, sample)
	h.clickText(t, ".dialog-foot button, .tools-row button", "解析")
	h.wait(t, "解析出预览", `!!document.querySelector('.import-preview')`)
	h.clickText(t, ".dialog-foot button", "导入到工作区")
	h.wait(t, "集合数量增加", fmt.Sprintf(`document.querySelectorAll('.tree-row.folder-row.root').length > %s`, before))
	if got := collectionCount(t); got == before {
		t.Fatalf("集合数量没有变化：%s", got)
	}

	// 导入的脚本落到脚本库，处于「未信任」状态。
	openScriptLibrary(t)
	names := libraryScriptNames(t)
	if len(names) != 1 || !strings.Contains(names[0], "带前置脚本的请求") {
		t.Fatalf("导入的脚本没有进脚本库：%v", names)
	}
	selectLibraryScript(t, names[0])
	if meta := h.text(t, ".script-lib-item .script-lib-meta"); !strings.Contains(meta, "未信任") {
		t.Fatalf("导入的脚本应当标成未信任：%q", meta)
	}
	h.clearOverlays(t)

	h.openRequest(t, "带前置脚本的请求")
	h.send(t)
	openConsoleTab(t)
	logs := h.text(t, ".script-log")
	if !strings.Contains(logs, "还没被信任") {
		t.Fatalf("未信任的脚本应该只提示不执行，日志：%q", logs)
	}
	if strings.Contains(logs, "导入的前置脚本跑了") {
		t.Fatalf("未信任的脚本被执行了：%q", logs)
	}

	openScriptLibrary(t)
	selectLibraryScript(t, names[0])
	if !h.exists(t, ".script-untrusted .btn") {
		t.Fatal("未信任的脚本没有出现「信任并启用」按钮")
	}
	h.click(t, ".script-untrusted .btn")
	h.wait(t, "信任后横幅消失", `!document.querySelector('.script-untrusted')`)
	h.clearOverlays(t)

	h.send(t)
	openConsoleTab(t)
	if logs := h.text(t, ".script-log"); !strings.Contains(logs, "导入的前置脚本跑了") {
		t.Fatalf("信任之后脚本没执行：%q", logs)
	}
	h.shot(t, "52-script-trust")

	deleteCollectionViaMenu(t, "带脚本的集合")
}
