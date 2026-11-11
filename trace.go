// 重定向逐跳链路、实际对端地址与分阶段耗时。
//
// fetch 插件只有一个共享 http.Client，跳转由 Client 自己完成，所以逐跳信息只能在
// Transport 里采：前端给每条请求带一个 trace id，这里把每一跳的状态码、实际连上的
// 对端地址与 DNS / 连接 / TLS / 首字节耗时记下来，最后用响应头把结果回传给页面。
// 这些内部头都带 X-Mygo- 前缀，页面渲染响应头时会过滤掉。
//
// 采对端地址是为了回答「这条请求到底打到哪台机器」：域名只是输入，改了 hosts 或 DNS
// 之后，页面上的记录还是那个域名，只有对端地址能看出实际连的是新地址还是旧地址
// （连接被复用时连的还是旧地址，见 traceTiming.Reused）。

package main

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"net/http/httptrace"
	"sync"
	"time"
)

const (
	traceIDHeader     = "X-Mygo-Trace-Id"
	traceResultHeader = "X-Mygo-Trace"
	// traceLimit 是同时保留的链路记录上限，超出后丢最早的（页面没取走也不会涨）。
	traceLimit = 64
)

// traceHop 是链路里的一跳。
type traceHop struct {
	Method string `json:"method"`
	URL    string `json:"url"`
	Status int    `json:"status"`
	// Addr 是这一跳实际连上的对端（ip:port）。经代理时它是代理的地址，
	// 不是目标服务器的地址，所以要和 ViaProxy 一起看。
	Addr     string `json:"addr,omitempty"`
	ViaProxy bool   `json:"viaProxy,omitempty"`
}

// traceTiming 是一跳的分阶段耗时（毫秒）。没有发生的阶段为 0。
type traceTiming struct {
	DNSMs     float64 `json:"dnsMs"`
	ConnectMs float64 `json:"connectMs"`
	TLSMs     float64 `json:"tlsMs"`
	TTFBMs    float64 `json:"ttfbMs"`
	TotalMs   float64 `json:"totalMs"`
	Reused    bool    `json:"reused"`
	// DNSAddrs 是这一跳真的做过解析时的结果（复用连接时为空）：同一个域名在
	// hosts 里写了多条时，能看出这次用的是哪几个地址。
	DNSAddrs []string `json:"dnsAddrs,omitempty"`
}

// traceRecord 是一条请求的完整链路。
type traceRecord struct {
	Hops    []traceHop    `json:"hops"`
	Timings []traceTiming `json:"timings"`
}

type traceStore struct {
	mu    sync.Mutex
	items map[string]*traceRecord
	order []string
}

var traces = &traceStore{items: map[string]*traceRecord{}}

// addHop 记下一跳，并返回当前快照（base64 的 JSON）。
func (s *traceStore) addHop(id string, hop traceHop, timing traceTiming) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.items[id]
	if !ok {
		rec = &traceRecord{}
		s.items[id] = rec
		s.order = append(s.order, id)
		for len(s.order) > traceLimit {
			oldest := s.order[0]
			s.order = s.order[1:]
			delete(s.items, oldest)
		}
	}
	rec.Hops = append(rec.Hops, hop)
	rec.Timings = append(rec.Timings, timing)
	blob, err := json.Marshal(rec)
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(blob)
}

// hopTimer 用 httptrace 采集一跳的各阶段耗时。
type hopTimer struct {
	start time.Time

	dnsStart, dnsDone   time.Time
	connStart, connDone time.Time
	tlsStart, tlsDone   time.Time
	firstByte           time.Time
	reused              bool
	remoteAddr          string
	dnsAddrs            []string
}

func newHopTimer() *hopTimer { return &hopTimer{start: time.Now()} }

// trace 返回挂到请求上的 httptrace.ClientTrace。
func (t *hopTimer) trace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) { t.dnsStart = time.Now() },
		DNSDone: func(info httptrace.DNSDoneInfo) {
			t.dnsDone = time.Now()
			for _, addr := range info.Addrs {
				t.dnsAddrs = append(t.dnsAddrs, addr.String())
			}
		},
		GetConn: func(string) { t.connStart = time.Now() },
		GotConn: func(info httptrace.GotConnInfo) {
			t.connDone = time.Now()
			t.reused = info.Reused
			// 复用的连接也会走到这里：对端地址是它建立时连上的那个，正好用来
			// 说明「改了 hosts 为什么还是连到旧机器」。
			if info.Conn != nil {
				if addr := info.Conn.RemoteAddr(); addr != nil {
					t.remoteAddr = addr.String()
				}
			}
		},
		TLSHandshakeStart: func() { t.tlsStart = time.Now() },
		TLSHandshakeDone:  func(cs tls.ConnectionState, err error) { t.tlsDone = time.Now() },
		GotFirstResponseByte: func() {
			if t.firstByte.IsZero() {
				t.firstByte = time.Now()
			}
		},
	}
}

// timing 汇总本跳的耗时。首字节只统计到它到达为止，正文下载由页面自己计时。
func (t *hopTimer) timing() traceTiming {
	span := func(from, to time.Time) float64 {
		if from.IsZero() || to.IsZero() || to.Before(from) {
			return 0
		}
		return float64(to.Sub(from).Microseconds()) / 1000
	}
	end := t.firstByte
	if end.IsZero() {
		end = time.Now()
	}
	return traceTiming{
		DNSMs:     span(t.dnsStart, t.dnsDone),
		ConnectMs: span(t.connStart, t.connDone),
		TLSMs:     span(t.tlsStart, t.tlsDone),
		TTFBMs:    span(t.start, t.firstByte),
		TotalMs:   span(t.start, end),
		Reused:    t.reused,
		DNSAddrs:  t.dnsAddrs,
	}
}
