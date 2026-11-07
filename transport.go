// 单条请求自己的网络出口：代理与 TLS 校验是请求级选项，但 fetch 插件只有一个
// 共享 http.Client，所以用两个内部请求头把选项带进来，在这里剥掉并换上对应的
// Transport。这两个头不会出现在发往服务器的请求里。

package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
)

const (
	// proxyHeader 是每条请求自己的代理地址，空表示跟随系统代理。
	proxyHeader = "X-Mygo-Proxy"
	// insecureHeader 为 "1" 时跳过证书校验。
	insecureHeader = "X-Mygo-Insecure-Tls"
)

// routingTransport 按请求头挑选 Transport，其余请求直接走默认那条。
type routingTransport struct {
	base http.RoundTripper

	mu    sync.Mutex
	cache map[string]*http.Transport
}

func newRoutingTransport(base http.RoundTripper) *routingTransport {
	return &routingTransport{base: base, cache: map[string]*http.Transport{}}
}

func (rt *routingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// 复制一份再动头：原始请求还留在 http.Client 的重定向链里，改它会污染 via。
	out := req.Clone(req.Context())
	proxy := strings.TrimSpace(out.Header.Get(proxyHeader))
	insecure := out.Header.Get(insecureHeader) == "1"
	traceID := out.Header.Get(traceIDHeader)
	// 内部头一律不下发：它们只是页面和这一层之间的约定。
	out.Header.Del(proxyHeader)
	out.Header.Del(insecureHeader)
	out.Header.Del(traceIDHeader)

	transport := rt.base
	if proxy != "" || insecure {
		next, err := rt.transportFor(proxy, insecure)
		if err != nil {
			return nil, err
		}
		transport = next
	}

	timer := newHopTimer()
	if traceID != "" {
		out = out.WithContext(httptrace.WithClientTrace(out.Context(), timer.trace()))
	}

	res, err := transport.RoundTrip(out)
	if err != nil {
		return nil, err
	}
	if traceID != "" {
		hop := traceHop{Method: out.Method, URL: out.URL.String(), Status: res.StatusCode}
		if blob := traces.addHop(traceID, hop, timer.timing()); blob != "" {
			res.Header.Set(traceResultHeader, blob)
		}
	}
	return res, nil
}

func (rt *routingTransport) transportFor(proxy string, insecure bool) (*http.Transport, error) {
	var target *url.URL
	if proxy != "" {
		parsed, err := url.Parse(proxy)
		if err != nil || parsed.Host == "" {
			return nil, fmt.Errorf("代理地址 %q 不合法，示例：http://127.0.0.1:7897", proxy)
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" && parsed.Scheme != "socks5" {
			return nil, errors.New("代理只支持 http、https 与 socks5 协议")
		}
		target = parsed
	}

	key := "direct"
	if insecure {
		key = "insecure"
	}
	if target != nil {
		key = target.String() + "|" + key
	}

	rt.mu.Lock()
	defer rt.mu.Unlock()
	if cached, ok := rt.cache[key]; ok {
		return cached, nil
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	if target != nil {
		transport.Proxy = http.ProxyURL(target)
	} else {
		transport.Proxy = nil
	}
	if insecure {
		// 用户显式勾了「跳过证书校验」，这里按他的选择放宽，不做二次确认。
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // 由界面选项显式开启
	}
	rt.cache[key] = transport
	return transport, nil
}
