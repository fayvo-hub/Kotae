//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// openScriptLibrary 打开脚本库浮层。
func openScriptLibrary(t *testing.T) {
	t.Helper()
	h.clearOverlays(t)
	h.click(t, `[data-role="scripts"]`)
	h.wait(t, "脚本库打开", `!!document.querySelector('.script-lib')`)
}

// pickLibrarySelect 点开脚本库里的下拉框并选中某一项。
// 等的是「目标选项出现」而不是「菜单出现」：菜单可能是上一次操作留下的，
// 只等菜单会点到过期的选项。
func pickLibrarySelect(t *testing.T, trigger, label string) {
	t.Helper()
	h.click(t, trigger+" .select-trigger")
	want := fmt.Sprintf(
		`[...document.querySelectorAll('.select-menu .select-option')].some(o => (o.textContent || '').includes(%s))`,
		jsString(label),
	)
	h.wait(t, "下拉框里出现「"+label+"」", want)
	h.clickContaining(t, ".select-menu .select-option", label)
	h.wait(t, "下拉框收起", `!document.querySelector('.select-menu')`)
}

// addLibraryScript 在脚本库里新建一条脚本并填好名字、阶段、作用范围与源码。
// phase 为空表示用默认的前置；scopeLabel 为空表示用默认作用范围。
func addLibraryScript(t *testing.T, name, phase, scopeLabel, source string) {
	t.Helper()
	before := h.count(t, ".script-lib-item")
	h.clickContaining(t, ".script-lib-side .tools-row .btn", "新建")
	h.wait(t, "新建的脚本出现在列表", fmt.Sprintf(
		`document.querySelectorAll('.script-lib-item').length === %d`, before+1,
	))

	const nameSel = ".script-lib-editor .text-input"
	h.wait(t, "脚本编辑框就绪", fmt.Sprintf(`!!document.querySelector(%s)`, jsString(nameSel)))
	h.typeInto(t, nameSel, name)

	if phase != "" {
		label := "前置脚本"
		if phase == "post" {
			label = "后置脚本"
		}
		pickLibrarySelect(t, ".script-lib-editor .form-grid > .field:nth-child(1) .select", label)
	}
	if scopeLabel != "" {
		pickLibrarySelect(t, ".script-lib-editor .form-grid > .field:nth-child(2) .select", scopeLabel)
	}
	if source != "" {
		sel := fmt.Sprintf(`.script-lib-editor .script-input[data-phase="%s"]`, phaseOrDefault(phase))
		h.wait(t, "脚本源码框就绪", fmt.Sprintf(`!!document.querySelector(%s)`, jsString(sel)))
		h.typeInto(t, sel, source)
	}
}

func phaseOrDefault(phase string) string {
	if phase == "post" {
		return "post"
	}
	return "pre"
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

// libraryScriptNames 读列表里的脚本名，顺序即执行顺序。
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
			h.clickContaining(t, ".script-lib-side .tools-row .btn", "删除")
			h.wait(t, "删除确认框出现", `!!document.querySelector('.prompt-dialog')`)
			h.clickContaining(t, ".prompt-dialog .btn", "删除")
			h.wait(t, "脚本被删掉", fmt.Sprintf(
				`document.querySelectorAll('.script-lib-item').length === %d`, before-1,
			))
		}
		h.clearOverlays(t)
	})
}

// 前置脚本算 HMAC 签名：桩服务用同一个密钥验签，验不过会回 401。
func TestPreScriptSignsRequest(t *testing.T) {
	cleanupScripts(t)
	openScriptLibrary(t)
	addLibraryScript(t, "签名", "pre", "全局（所有请求）", strings.Join([]string{
		`const ts = String(pm.utils.now());`,
		`pm.request.headers.upsert("X-Ts", ts);`,
		`pm.request.headers.upsert("X-Sign", await pm.utils.hmacSha256("e2e-secret", "/signed|" + ts));`,
		`console.log("已签名 ts=" + ts);`,
	}, "\n"))
	h.clearOverlays(t)

	newTab(t)
	typeURL(t, "{{baseUrl}}/signed")
	h.send(t)

	if got := h.status(t); got != "200" {
		t.Fatalf("签名没通过，状态码是 %q，响应：%s", got, h.responseText(t))
	}
	if body := h.responseText(t); !strings.Contains(body, "verified") {
		t.Fatalf("响应体里没有验签结果：%s", body)
	}
	if log := h.text(t, ".script-log-line"); !strings.Contains(log, "已签名") {
		t.Fatalf("前置脚本的 console.log 没显示出来：%q", log)
	}
	h.clearToasts(t)
	h.shot(t, "50-pre-script-sign")
}

// 后置脚本把 base64 响应体解成中文，响应区要显示改写后的内容。
func TestPostScriptRewritesBody(t *testing.T) {
	cleanupScripts(t)
	openScriptLibrary(t)
	addLibraryScript(t, "解码响应", "post", "全局（所有请求）",
		`pm.response.setBody(pm.utils.base64Decode(pm.response.text()));`)
	h.clearOverlays(t)

	newTab(t)
	typeURL(t, "{{baseUrl}}/b64")
	h.send(t)

	if got := h.status(t); got != "200" {
		t.Fatalf("状态码不对：%q，区域文本：%s，toast：%s", got, h.text(t, ".response"), h.text(t, ".toasts"))
	}
	body := h.responseText(t)
	if !strings.Contains(body, "解码后的响应体：中文正常。") {
		t.Fatalf("响应体没有被后置脚本改写：%s", body)
	}
	if tag := h.text(t, ".script-log-tag"); tag != "已改写响应体" {
		t.Fatalf("没有标记响应体被改写：%q", tag)
	}
	h.clearToasts(t)
	h.shot(t, "51-post-script-body")
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
	if meta := h.text(t, ".script-lib-item .script-lib-meta"); !strings.Contains(meta, "未信任") {
		t.Fatalf("导入的脚本应当标成未信任：%q", meta)
	}
	h.clearOverlays(t)

	h.openRequest(t, "带前置脚本的请求")
	h.send(t)
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
	if logs := h.text(t, ".script-log"); !strings.Contains(logs, "导入的前置脚本跑了") {
		t.Fatalf("信任之后脚本没执行：%q", logs)
	}
	h.shot(t, "52-script-trust")

	deleteCollectionViaMenu(t, "带脚本的集合")
}
