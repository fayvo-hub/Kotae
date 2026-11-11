// 链路记录里「实际连到哪台机器」的采集与回传：对端地址要写进发给页面
// 的快照里，否则前端没法在响应区显示服务器 IP。

package main

import (
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http/httptrace"
	"testing"
)

// fakeConn 只提供 RemoteAddr：GotConn 回调只需要它。
type fakeConn struct{ net.Conn }

func (fakeConn) RemoteAddr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8080} }

func TestHopTimerRecordsRemoteAddrAndDNS(t *testing.T) {
	timer := newHopTimer()
	tr := timer.trace()
	tr.DNSStart(httptrace.DNSStartInfo{Host: "example.test"})
	tr.DNSDone(httptrace.DNSDoneInfo{
		Addrs: []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}, {IP: net.ParseIP("::1")}},
	})
	tr.GotConn(httptrace.GotConnInfo{Conn: fakeConn{}})

	timing := timer.timing()
	if timing.Reused {
		t.Fatalf("新建连接不应标成复用")
	}
	if timer.remoteAddr != "127.0.0.1:8080" {
		t.Fatalf("对端地址应来自 GotConn，实际 %q", timer.remoteAddr)
	}
	if len(timing.DNSAddrs) != 2 || timing.DNSAddrs[0] != "127.0.0.1" || timing.DNSAddrs[1] != "::1" {
		t.Fatalf("DNS 解析结果不对：%v", timing.DNSAddrs)
	}
	if timing.DNSMs < 0 {
		t.Fatalf("DNS 耗时不应该是负数，实际 %v", timing.DNSMs)
	}
}

// 复用连接时不会重新解析：页面上要能看出「连的还是建立时那台机器」。
func TestHopTimerReusedKeepsRemoteAddr(t *testing.T) {
	timer := newHopTimer()
	tr := timer.trace()
	tr.GotConn(httptrace.GotConnInfo{Conn: fakeConn{}, Reused: true})

	timing := timer.timing()
	if !timing.Reused {
		t.Fatalf("复用的连接应标成 reused")
	}
	if len(timing.DNSAddrs) != 0 {
		t.Fatalf("复用连接不应有解析结果，实际 %v", timing.DNSAddrs)
	}
	if timer.remoteAddr != "127.0.0.1:8080" {
		t.Fatalf("复用连接也要给出对端地址，实际 %q", timer.remoteAddr)
	}
}

// 回传给页面的快照必须带 addr / viaProxy / dnsAddrs，否则前端拿不到。
func TestAddHopCarriesAddr(t *testing.T) {
	blob := traces.addHop(
		"test-addr-hop",
		traceHop{Method: "GET", URL: "http://example.test/", Status: 200, Addr: "10.0.0.2:443", ViaProxy: true},
		traceTiming{TotalMs: 1, DNSAddrs: []string{"10.0.0.2"}},
	)
	if blob == "" {
		t.Fatalf("快照不该为空")
	}
	raw, err := base64.StdEncoding.DecodeString(blob)
	if err != nil {
		t.Fatalf("快照不是 base64：%v", err)
	}
	var rec traceRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatalf("快照不是 JSON：%v", err)
	}
	if len(rec.Hops) != 1 || rec.Hops[0].Addr != "10.0.0.2:443" || !rec.Hops[0].ViaProxy {
		t.Fatalf("对端地址没进快照：%+v", rec.Hops)
	}
	if len(rec.Timings) != 1 || len(rec.Timings[0].DNSAddrs) != 1 || rec.Timings[0].DNSAddrs[0] != "10.0.0.2" {
		t.Fatalf("解析结果没进快照：%+v", rec.Timings)
	}
}
