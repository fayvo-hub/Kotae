// 设置里的「忽略系统代理（直连）」：页面用内部头把选项带进来，这一层必须
// 换成一条不做系统代理判定的 transport，并且不能把这个头下发给服务器。

package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// countingTransport 记录自己被调用了几次，用来分辨请求走了 base（跟随系统代理）
// 还是走了这一层自己建的 transport。
type countingTransport struct {
	used int
	next http.RoundTripper
}

func (c *countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	c.used++
	return c.next.RoundTrip(req)
}

// stubProxyTransport 冒充 netproxy 那条 base：Proxy 恒指向一个本地地址，用来验证
// 「跳过证书校验」这类选项不会顺手把系统代理也丢掉。
func stubProxyTransport(t *testing.T) *http.Transport {
	t.Helper()
	base := http.DefaultTransport.(*http.Transport).Clone()
	target, err := url.Parse("http://127.0.0.1:7897")
	if err != nil {
		t.Fatalf("构造代理地址失败：%v", err)
	}
	base.Proxy = http.ProxyURL(target)
	return base
}

func TestDirectHeaderBypassesBaseTransport(t *testing.T) {
	var gotDirect string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotDirect = r.Header.Get(directHeader)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	base := &countingTransport{next: http.DefaultTransport}
	rt := newRoutingTransport(base)
	send := func(direct bool) {
		t.Helper()
		req, err := http.NewRequest("GET", srv.URL, nil)
		if err != nil {
			t.Fatalf("构造请求失败：%v", err)
		}
		if direct {
			req.Header.Set(directHeader, "1")
		}
		res, err := rt.RoundTrip(req)
		if err != nil {
			t.Fatalf("请求失败（direct=%v）：%v", direct, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNoContent {
			t.Fatalf("状态码不对：%d", res.StatusCode)
		}
	}

	send(false)
	if base.used != 1 {
		t.Fatalf("没开直连时应该跟随系统代理（走 base），实际 base 被调用 %d 次", base.used)
	}

	send(true)
	if base.used != 1 {
		t.Fatalf("开了直连仍走了 base（系统代理），base 被调用 %d 次", base.used)
	}
	if gotDirect != "" {
		t.Fatalf("%s 是内部头，不该发给服务器，实际收到 %q", directHeader, gotDirect)
	}
}

// 直连 transport 按选项各留一条，同一档要复用同一条连接池。
func TestTransportForReusesConnPools(t *testing.T) {
	rt := newRoutingTransport(http.DefaultTransport)
	first, err := rt.transportFor("", false, true)
	if err != nil {
		t.Fatalf("建直连 transport 失败：%v", err)
	}
	second, err := rt.transportFor("", false, true)
	if err != nil {
		t.Fatalf("再次取直连 transport 失败：%v", err)
	}
	if first != second {
		t.Fatalf("同样的选项应该复用同一条 transport，否则每次请求都新建连接池")
	}
	if first.Proxy != nil {
		t.Fatalf("直连时这条 transport 必须直连，Proxy 不该有值")
	}
}

// 「跳过证书校验」只放宽 TLS，不该顺带把系统代理也关掉（直连是另一个开关）。
func TestInsecureKeepsSystemProxy(t *testing.T) {
	base := stubProxyTransport(t)
	rt := newRoutingTransport(base)

	insecure, err := rt.transportFor("", true, false)
	if err != nil {
		t.Fatalf("建跳过校验的 transport 失败：%v", err)
	}
	req, err := http.NewRequest("GET", "http://example.com/", nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	proxyURL, perr := insecure.Proxy(req)
	if perr != nil || proxyURL == nil {
		t.Fatalf("跳过校验时仍应跟随系统代理，实际 Proxy=%v err=%v", proxyURL, perr)
	}
	if insecure.TLSClientConfig == nil || !insecure.TLSClientConfig.InsecureSkipVerify {
		t.Fatalf("跳过校验的 transport 应该关掉证书校验")
	}

	direct, err := rt.transportFor("", true, true)
	if err != nil {
		t.Fatalf("建「跳过校验 + 直连」的 transport 失败：%v", err)
	}
	if direct == insecure {
		t.Fatalf("直连与跟随代理是两条不同的出口，不能共用缓存")
	}
	if direct.Proxy != nil {
		t.Fatalf("同时开了直连时不能再带代理判定")
	}
}
