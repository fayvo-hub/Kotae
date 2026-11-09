//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

const postmanSample = `{
  "info": {
    "name": "导入测试集合",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "列出用户",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/users?page=1",
        "header": [
          { "key": "X-One", "value": "1" },
          { "key": "X-Off", "value": "2", "disabled": true }
        ],
        "auth": { "type": "bearer", "bearer": [{ "key": "token", "value": "t-123" }] }
      }
    },
    {
      "name": "分组",
      "item": [
        {
          "name": "创建用户",
          "request": {
            "method": "POST",
            "url": { "raw": "https://api.example.com/users" },
            "body": {
              "mode": "raw",
              "raw": "{\"name\":\"张三\"}",
              "options": { "raw": { "language": "json" } }
            },
            "auth": {
              "type": "basic",
              "basic": [
                { "key": "username", "value": "demo" },
                { "key": "password", "value": "secret" }
              ]
            }
          }
        }
      ]
    }
  ]
}`

const harSample = `{
  "log": {
    "creator": { "name": "Chrome" },
    "entries": [
      {
        "request": {
          "method": "PUT",
          "url": "https://api.example.com/items/1",
          "headers": [{ "name": "Content-Type", "value": "application/json" }],
          "postData": { "mimeType": "application/json", "text": "{\"name\":\"har-item\"}" }
        }
      }
    ]
  }
}`

func collectionCount(t *testing.T) string {
	t.Helper()
	var n string
	h.eval(t, `String(document.querySelectorAll('.tree-row.folder-row.root').length)`, &n)
	return n
}

func fillImportBox(t *testing.T, text string) {
	t.Helper()
	script := fmt.Sprintf(`(() => {
  const ta = document.querySelector('.curl-input');
  if (!ta) return false;
  ta.value = %s;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`, jsString(text))
	var ok bool
	h.eval(t, script, &ok)
	if !ok {
		t.Fatal("导入面板里没有输入框")
	}
}

// 导入外部集合：Postman Collection 与 HAR 都能解析成集合，并且字段映射正确。
func TestImportPostmanAndHar(t *testing.T) {
	h.clearOverlays(t)
	before := collectionCount(t)

	// ---- Postman ----
	h.pressKeys(t, "i", true, true)
	h.wait(t, "导入面板打开", `!!document.querySelector('.curl-input')`)
	fillImportBox(t, postmanSample)
	h.clickText(t, ".dialog-foot button, .tools-row button", "解析")
	h.wait(t, "解析出预览", `!!document.querySelector('.import-preview')`)

	var preview string
	h.eval(t, `document.querySelector('.import-preview').textContent`, &preview)
	for _, want := range []string{"导入测试集合", "2 条请求"} {
		if !strings.Contains(preview, want) {
			t.Fatalf("预览里缺少 %q：%s", want, preview)
		}
	}

	h.clickText(t, ".dialog-foot button", "导入到工作区")
	h.wait(t, "导入完成", `document.body.textContent.includes('共 2 条请求')`)
	if got := collectionCount(t); got == before {
		t.Fatalf("集合数量没有变化：%s", got)
	}

	// 打开导入进来的 GET：地址、查询参数、认证都要对上。
	h.openRequest(t, "列出用户")
	var urlValue string
	h.eval(t, `document.querySelector('.url-input').value`, &urlValue)
	if !strings.Contains(urlValue, "https://api.example.com/users") {
		t.Fatalf("地址没导进来：%q", urlValue)
	}
	var params string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.kv-row')].map(r => [r.querySelector('.kv-key')?.value, r.querySelector('.kv-value')?.value]))`, &params)
	if !strings.Contains(params, `"page","1"`) {
		t.Fatalf("查询参数没导进来：%s", params)
	}
	h.clickContaining(t, ".subtab", "认证")
	h.wait(t, "认证页签", `!!document.querySelector('.auth-token, .field input')`)
	var token string
	h.eval(t, `(document.querySelector('.field input[type="text"], .field input:not([type])') || {}).value || ''`, &token)
	if !strings.Contains(token, "t-123") {
		t.Fatalf("Bearer token 没导进来：%q", token)
	}

	// ---- HAR ----
	h.pressKeys(t, "i", true, true)
	h.wait(t, "导入面板重新打开", `!!document.querySelector('.curl-input')`)
	fillImportBox(t, harSample)
	h.clickText(t, ".tools-row button", "解析")
	h.wait(t, "HAR 解析出预览", `!!document.querySelector('.import-preview')`)
	var harPreview string
	h.eval(t, `document.querySelector('.import-preview').textContent`, &harPreview)
	if !strings.Contains(harPreview, "HAR 导入（Chrome）") || !strings.Contains(harPreview, "1 条请求") {
		t.Fatalf("HAR 预览不对：%s", harPreview)
	}

	h.clickText(t, ".dialog-foot button", "导入到工作区")
	h.wait(t, "HAR 导入完成", `document.body.textContent.includes('共 1 条请求')`)
	h.openRequest(t, "PUT api.example.com")
	var body string
	h.eval(t, `(() => {
		const tab = [...document.querySelectorAll('.subtab')].find(el => (el.textContent || '').trim() === '请求体');
		tab?.click();
		return 'ok';
	})()`, new(string))
	h.wait(t, "请求体面板", `!!document.querySelector('.code-input')`)
	h.eval(t, `document.querySelector('.code-input').value`, &body)
	if !strings.Contains(body, "har-item") {
		t.Fatalf("HAR 的请求体没导进来：%q", body)
	}
}

// 地址栏粘贴整条 curl：导入浮层打开后，输入框里要带着那段命令，别让用户再粘一次。
func TestUrlPasteCurlPrefillsDialog(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	curl := `curl -X POST 'https://httpbin.org/post' -H 'X-Paste: 1' --data-raw '{"a":1}'`
	h.eval(t, fmt.Sprintf(`(() => {
		const input = document.querySelector('.url-input');
		const dt = new DataTransfer();
		dt.setData('text/plain', %s);
		input.focus();
		input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
		return true;
	})()`, jsString(curl)), nil)

	h.wait(t, "cURL 导入浮层打开", `!!document.querySelector('.curl-input')`)

	var value string
	h.eval(t, `document.querySelector('.curl-input').value`, &value)
	if value != curl {
		t.Fatalf("浮层输入框里没有带命令：%q", value)
	}

	// 有原文也要有解析结果，否则用户点不了「替换当前请求」。
	if !h.exists(t, ".curl-result .preview-card") {
		t.Fatalf("浮层里没有解析预览")
	}

	// 地址栏本身不该被塞进整条命令。
	var url string
	h.eval(t, `document.querySelector('.url-input').value`, &url)
	if strings.Contains(url, "curl") {
		t.Fatalf("地址栏被写入了整条命令：%q", url)
	}

	h.clearOverlays(t)
}

// 导出入口在设置面板里（真正的写文件走系统保存对话框，交给手动验证）。
func TestExportPostmanEntry(t *testing.T) {
	h.openSettingsTab(t, "data")
	h.wait(t, "设置面板打开", `!!document.querySelector('.settings-tabs')`)
	var found bool
	h.eval(t, `[...document.querySelectorAll('.btn')].some(b => (b.textContent || '').includes('导出为 Postman'))`, &found)
	if !found {
		t.Fatal("设置面板里没有「导出为 Postman」按钮")
	}
	h.clearOverlays(t)
}
