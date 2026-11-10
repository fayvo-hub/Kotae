package e2e

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// sseHandler 按 n 条（默认 3）推事件然后关掉连接：每条之间隔几毫秒，
// 用来验证「边收边追加」而不是一次读完好。
func sseHandler(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	if n <= 0 || n > 20 {
		n = 3
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "不支持流式响应", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Fixture", "sse")
	w.WriteHeader(http.StatusOK)
	// 先发一条注释行当心跳：客户端应当忽略它，不产生消息。
	fmt.Fprint(w, ": ping\n\n")
	flusher.Flush()
	for i := 1; i <= n; i++ {
		// q 里带的是这次握手的原始查询串：用来断言公共参数真的进了 SSE 握手地址。
		fmt.Fprintf(w, "event: tick\nid: %d\ndata: {\"seq\":%d,\"text\":\"第 %d 条\",\"q\":%q}\n\n", i, i, i, r.URL.RawQuery)
		flusher.Flush()
		time.Sleep(20 * time.Millisecond)
	}
	// 多行 data 拼成一条消息，最后一条用来验证拼接规则。
	fmt.Fprint(w, "event: done\ndata: 第一行\ndata: 第二行\n\n")
	flusher.Flush()
}

// wsWebSocketGUID 是 RFC 6455 握手固定用的魔术串。
const wsWebSocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// wsHandler 是最小的 RFC 6455 回显服务：不引第三方依赖，够 e2e 用。
// 连上先推一条问候，之后把收到的文本原样发回，收到 close 就关闭。
func wsHandler(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "需要 WebSocket 握手", http.StatusBadRequest)
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "缺少 Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}

	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))

	accept := base64.StdEncoding.EncodeToString(sha1Sum(key + wsWebSocketGUID))
	handshake := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n"
	// 客户端带了子协议就回第一个，验证子协议协商。
	if proto := r.Header.Get("Sec-WebSocket-Protocol"); proto != "" {
		first := strings.TrimSpace(strings.Split(proto, ",")[0])
		if first != "" {
			handshake += "Sec-WebSocket-Protocol: " + first + "\r\n"
		}
	}
	// 自定义响应头 + Cookie：验证握手阶段能带上服务端给的头与 Cookie。
	handshake += "Set-Cookie: ws_fixture=1; Path=/\r\n"
	handshake += "X-Fixture: ws\r\n\r\n"
	if _, err := io.WriteString(conn, handshake); err != nil {
		return
	}

	if err := writeFrame(conn, 0x1, []byte("hello from fixture")); err != nil {
		return
	}

	for {
		opcode, payload, err := readFrame(brw.Reader)
		if err != nil {
			return
		}
		switch opcode {
		case 0x1, 0x2:
			if string(payload) == "bye" {
				_ = writeFrame(conn, 0x8, closePayload(1000, "fixture 关闭"))
				return
			}
			if err := writeFrame(conn, opcode, payload); err != nil {
				return
			}
		case 0x8:
			_ = writeFrame(conn, 0x8, closePayload(1000, ""))
			return
		case 0x9:
			if err := writeFrame(conn, 0xa, payload); err != nil {
				return
			}
		}
	}
}

func sha1Sum(text string) []byte {
	sum := sha1.Sum([]byte(text))
	return sum[:]
}

func closePayload(code int, reason string) []byte {
	buf := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(buf, uint16(code))
	copy(buf[2:], reason)
	return buf
}

// readFrame 读一个完整的客户端帧（客户端发的帧一定带掩码）。
func readFrame(br *bufio.Reader) (byte, []byte, error) {
	head := make([]byte, 2)
	if _, err := io.ReadFull(br, head); err != nil {
		return 0, nil, err
	}
	opcode := head[0] & 0x0f
	masked := head[1]&0x80 != 0
	length := int(head[1] & 0x7f)
	switch length {
	case 126:
		ext := make([]byte, 2)
		if _, err := io.ReadFull(br, ext); err != nil {
			return 0, nil, err
		}
		length = int(binary.BigEndian.Uint16(ext))
	case 127:
		ext := make([]byte, 8)
		if _, err := io.ReadFull(br, ext); err != nil {
			return 0, nil, err
		}
		length = int(binary.BigEndian.Uint64(ext))
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(br, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(br, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return opcode, payload, nil
}

// writeFrame 发一个服务端帧（不带掩码）。
func writeFrame(w io.Writer, opcode byte, payload []byte) error {
	buf := []byte{0x80 | opcode}
	switch {
	case len(payload) < 126:
		buf = append(buf, byte(len(payload)))
	case len(payload) <= 0xffff:
		buf = append(buf, 126, byte(len(payload)>>8), byte(len(payload)))
	default:
		buf = append(buf, 127, 0, 0, 0, 0, byte(len(payload)>>24), byte(len(payload)>>16), byte(len(payload)>>8), byte(len(payload)))
	}
	buf = append(buf, payload...)
	_, err := w.Write(buf)
	return err
}
