//go:build e2e

package e2e

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 单条请求自己的代理与 TLS 选项：都靠 transport.go 里的内部请求头切换 Transport。

// openOptions 切到「选项」子页签。
//
// 只点一次不够：点之前界面可能刚重绘过一次，点到的还是旧节点。这里点完等
// 页签真的变成 active，没变成就再点一次（最多三次）。
func openOptions(t *testing.T) {
	t.Helper()
	const active = `(() => {
	  const on = [...document.querySelectorAll('.subtabs:not(.response-subtabs) .subtab')]
	    .find(el => el.classList.contains('active'));
	  return (on ? on.textContent.trim() : '') === '选项';
	})()`
	for i := 0; i < 3; i++ {
		var ok bool
		h.eval(t, active, &ok)
		if ok {
			return
		}
		clickIn(t, ".subtabs:not(.response-subtabs)", "选项")
		time.Sleep(150 * time.Millisecond)
	}
	var ok bool
	h.eval(t, active, &ok)
	if !ok {
		t.Fatalf("切不到「选项」子页签")
	}
}

// setInsecureTLS 勾上 / 取消「跳过 TLS 证书校验」。
func setInsecureTLS(t *testing.T, on bool) {
	t.Helper()
	var ok bool
	h.eval(t, fmt.Sprintf(`(() => {
  const label = [...document.querySelectorAll('.pane .checkbox-inline')]
    .find(el => (el.textContent || '').includes('跳过 TLS 证书校验'));
  if (!label) return false;
  const box = label.querySelector('input[type="checkbox"]');
  if (!box) return false;
  if (box.checked === %t) return true;
  label.click();
  return true;
})()`, on), &ok)
	if !ok {
		t.Fatalf("选项页签里找不到「跳过 TLS 证书校验」")
	}
	var checked bool
	h.eval(t, `(() => {
  const label = [...document.querySelectorAll('.pane .checkbox-inline')]
    .find(el => (el.textContent || '').includes('跳过 TLS 证书校验'));
  return !!(label && label.querySelector('input[type="checkbox"]').checked);
})()`, &checked)
	if checked != on {
		t.Fatalf("「跳过 TLS 证书校验」应变为 %v", on)
	}
}

// 用代理发一条请求：代理把目标地址回显出来，证明请求确实被代理转发了。
func TestRequestGoesThroughProxy(t *testing.T) {
	base := baseURL(t)
	openNewTab(t)
	typeURL(t, "http://example.invalid/proxied?x=1")
	openOptions(t)
	h.typeInto(t, `.pane input[aria-label="代理地址"]`, base)
	h.pressKeysOn(t, `.pane input[aria-label="代理地址"]`, "Enter", false, false)
	h.send(t)

	if status := h.status(t); status != "200" {
		t.Fatalf("走代理的请求应返回 200，实际 %q\n%s", status, h.responseText(t))
	}
	body := h.responseText(t)
	if !strings.Contains(body, "proxied") || !strings.Contains(body, "true") {
		t.Fatalf("响应应来自代理桩，实际：%s", body)
	}
	if !strings.Contains(body, "example.invalid/proxied?x=1") {
		t.Fatalf("代理应收到原始目标地址，实际：%s", body)
	}
}

// 自签证书的服务：不勾选时失败，勾选后能拿到 200。
func TestInsecureTLS(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"tls": true})
	}))
	defer server.Close()

	openNewTab(t)
	typeURL(t, server.URL+"/tls")
	openOptions(t)
	setInsecureTLS(t, false)

	h.send(t)
	if status := h.status(t); status != "失败" {
		t.Fatalf("自签证书默认应失败，实际状态 %q", status)
	}
	if text := h.responseText(t); !strings.Contains(text, "证书") {
		t.Fatalf("失败原因应提到证书，实际：%s", text)
	}

	setInsecureTLS(t, true)
	h.send(t)
	if status := h.status(t); status != "200" {
		t.Fatalf("勾选跳过证书校验后应返回 200，实际 %q\n%s", status, h.responseText(t))
	}
	if body := h.responseText(t); !strings.Contains(body, "tls") {
		t.Fatalf("响应体应来自 TLS 桩，实际：%s", body)
	}

	// 还原，别把选项留给后面的用例。
	setInsecureTLS(t, false)
}
