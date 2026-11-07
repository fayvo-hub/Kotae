//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// openScriptPane 切到请求区的「脚本」子页签，并选中前置或后置那一段。
func openScriptPane(t *testing.T, phase string) {
	t.Helper()
	h.clickContaining(t, ".subtabs:not(.response-subtabs) .subtab", "脚本")
	h.wait(t, "脚本页签就绪", `document.querySelector('.script-switch') !== null`)
	label := "前置"
	if phase == "post" {
		label = "后置"
	}
	h.clickContaining(t, ".script-switch .segmented-item", label)
	want := fmt.Sprintf(`document.querySelector('.script-input[data-phase="%s"]') !== null`, phase)
	h.wait(t, "脚本编辑器就绪", want)
}

// 前置脚本算 HMAC 签名：桩服务用同一个密钥验签，验不过会回 401。
func TestPreScriptSignsRequest(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	openScriptPane(t, "pre")

	script := strings.Join([]string{
		`const ts = String(pm.utils.now());`,
		`pm.request.headers.upsert("X-Ts", ts);`,
		`pm.request.headers.upsert("X-Sign", await pm.utils.hmacSha256("e2e-secret", "/signed|" + ts));`,
		`console.log("已签名 ts=" + ts);`,
	}, "\n")
	h.typeInto(t, `.script-input[data-phase="pre"]`, script)
	h.typeInto(t, ".url-input", "{{baseUrl}}/signed")
	blurURL(t)
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
	h.clearOverlays(t)
	newTab(t)
	openScriptPane(t, "post")

	h.typeInto(t, `.script-input[data-phase="post"]`, `pm.response.setBody(pm.utils.base64Decode(pm.response.text()));`)
	h.typeInto(t, ".url-input", "{{baseUrl}}/b64")
	blurURL(t)
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

// 导入来的脚本默认不执行，点「信任并启用」之后才跑。
func TestImportedScriptNeedsTrust(t *testing.T) {
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

	h.openRequest(t, "带前置脚本的请求")
	openScriptPane(t, "pre")
	if !h.exists(t, ".script-untrusted .btn") {
		t.Fatal("导入的脚本没有出现「信任并启用」按钮")
	}

	h.send(t)
	logs := h.text(t, ".script-log")
	if !strings.Contains(logs, "还没被信任") {
		t.Fatalf("未信任的脚本应该只提示不执行，日志：%q", logs)
	}
	if strings.Contains(logs, "导入的前置脚本跑了") {
		t.Fatalf("未信任的脚本被执行了：%q", logs)
	}

	h.click(t, ".script-untrusted .btn")
	h.wait(t, "信任后按钮消失", `!document.querySelector('.script-untrusted')`)
	h.send(t)
	if logs := h.text(t, ".script-log"); !strings.Contains(logs, "导入的前置脚本跑了") {
		t.Fatalf("信任之后脚本没执行：%q", logs)
	}
	h.shot(t, "52-script-trust")
}
