//go:build e2e

package e2e

import (
	"strings"
	"testing"
	"time"
)

// TestBinaryBodyUpload 验二进制直传：把文件拖进请求体面板，整个文件按原始字节发出。
// e2e 不能弹系统文件对话框，所以走「拖拽」这条路——它同时也是真实用法。
func TestBinaryBodyUpload(t *testing.T) {
	h.clearOverlays(t)
	openNewTab(t)
	typeURL(t, "{{baseUrl}}/echo")

	// 方法改成 POST：二进制请求体不会跟在 GET 上。
	h.eval(t, `(() => {
	  const sel = document.querySelector('.method-select');
	  sel.value = 'POST';
	  sel.dispatchEvent(new Event('change', { bubbles: true }));
	  return true;
	})()`, nil)

	clickIn(t, ".subtabs:not(.response-subtabs)", "请求体")
	h.wait(t, "请求体面板", `!!document.querySelector('.segmented[aria-label="请求体类型"]')`)
	clickIn(t, `.segmented[aria-label="请求体类型"]`, "二进制文件")
	h.wait(t, "二进制面板", `!!document.querySelector('.binary-pane')`)

	// 拖一个文件进去：FileReader 异步读完才会出现 .binary-file。
	var dropped bool
	h.eval(t, `(() => {
	  const pane = document.querySelector('.binary-pane');
	  if (!pane) return false;
	  const file = new File([new TextEncoder().encode('二进制直传 ok')], 'fixture.bin', { type: 'application/octet-stream' });
	  const dt = new DataTransfer();
	  dt.items.add(file);
	  pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
	  return true;
	})()`, &dropped)
	if !dropped {
		t.Fatalf("没有找到二进制请求体面板")
	}
	h.wait(t, "文件出现在面板里", `!!document.querySelector('.binary-file')`)
	if name := h.text(t, ".binary-name"); name != "fixture.bin" {
		t.Fatalf("面板里显示的文件名是 %q，期望 fixture.bin", name)
	}

	commitURL(t)
	time.Sleep(60 * time.Millisecond)
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("二进制直传失败：状态 %q\n应用日志：\n%s", got, h.appLog())
	}
	if body := h.text(t, ".response-body"); !strings.Contains(body, "二进制直传 ok") {
		t.Fatalf("服务端收到的正文不对：%q", body)
	}
	h.eval(t, `(() => {
	  const el = document.querySelector('.tab.active .tab-close');
	  if (el) el.click();
	  return true;
	})()`, nil)
	h.wait(t, "标签页关掉", `document.querySelectorAll('.tab').length >= 1`)
}

// TestCurlBinaryImport 验 -T 导入：只记住文件名，内容需要用户重新选。
func TestCurlBinaryImport(t *testing.T) {
	h.clearOverlays(t)
	openNewTab(t)
	h.pressKeys(t, "i", true, false)
	h.wait(t, "cURL 导入浮层", `!!document.querySelector('.curl-input')`)
	h.typeInto(t, ".curl-input", `curl -T 'C:\tmp\fixture.bin' '{{baseUrl}}/echo'`)
	h.clickText(t, ".dialog .btn", "解析")
	h.wait(t, "解析结果预览", `!!document.querySelector('.preview-card')`)
	h.clickText(t, ".dialog-foot .btn", "替换当前请求")
	h.wait(t, "浮层关闭", `!document.querySelector('.curl-input')`)

	clickIn(t, ".subtabs:not(.response-subtabs)", "请求体")
	h.wait(t, "二进制面板", `!!document.querySelector('.binary-pane')`)
	if name := h.text(t, ".binary-name"); name != "fixture.bin" {
		t.Fatalf("-T 导入后文件名是 %q，期望 fixture.bin", name)
	}
	var method string
	h.eval(t, `document.querySelector('.method-select').value`, &method)
	if method != "PUT" {
		t.Fatalf("-T 导入后方法应为 PUT，实际 %q", method)
	}
	if !strings.Contains(h.text(t, ".binary-pane"), "内容还没读进来") {
		t.Fatalf("缺内容时没有提示：%q", h.text(t, ".binary-pane"))
	}
}
