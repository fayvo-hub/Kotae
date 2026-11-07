package e2e

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"time"
)

// Echo 是测试用的本地桩服务：所有断言都打在这里，不依赖外网、不受对方
// 服务变动影响。启动在 127.0.0.1 的随机端口上。
type Echo struct {
	Server *httptest.Server
}

// StartEcho 启动桩服务。
func StartEcho() *Echo {
	e := &Echo{}
	mux := http.NewServeMux()
	mux.HandleFunc("/json", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"source": "fixture",
			"items":  []any{map[string]any{"id": 1, "name": "示例"}, map[string]any{"id": 2, "name": "第二条"}},
		})
	})
	// /deep 用来验证响应体结构化视图的展开层级：五层嵌套，默认应当全部展开。
	mux.HandleFunc("/deep", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"l1": map[string]any{
				"l2": map[string]any{
					"l3": map[string]any{
						"l4":  map[string]any{"leaf": "深", "count": 4},
						"arr": []any{map[string]any{"deep": true}},
					},
				},
			},
		})
	})
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		headers := map[string]string{}
		for k, v := range r.Header {
			headers[strings.ToLower(k)] = strings.Join(v, ", ")
		}
		query := map[string]string{}
		for k, v := range r.URL.Query() {
			query[k] = strings.Join(v, ", ")
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"method":  r.Method,
			"path":    r.URL.Path,
			"query":   query,
			"headers": headers,
			"body":    string(body),
		})
	})
	mux.HandleFunc("/text", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "纯文本响应：中文可以正常显示。\n第二行。\n")
	})
	mux.HandleFunc("/binary", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte{0x00, 0x01, 0x02, 0xfe, 0xff, 'P', 'N', 'G'})
	})
	// 1×1 的 PNG，用来验证图片响应直接预览。
	mux.HandleFunc("/image", func(w http.ResponseWriter, r *http.Request) {
		png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	})
	// /signed 校验 HMAC-SHA256(secret, 路径+"|"+时间戳)，用来验证前置脚本算的签名头。
	mux.HandleFunc("/signed", func(w http.ResponseWriter, r *http.Request) {
		ts := r.Header.Get("X-Ts")
		sign := r.Header.Get("X-Sign")
		mac := hmac.New(sha256.New, []byte("e2e-secret"))
		_, _ = mac.Write([]byte(r.URL.Path + "|" + ts))
		want := hex.EncodeToString(mac.Sum(nil))
		if ts == "" || sign != want {
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"verified": false,
				"reason":   "签名不匹配",
				"want":     want,
				"got":      sign,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"verified": true, "ts": ts})
	})
	// /b64 返回 base64 文本，后置脚本负责解成中文。
	mux.HandleFunc("/b64", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, base64.StdEncoding.EncodeToString([]byte("解码后的响应体：中文正常。")))
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		ms, _ := strconv.Atoi(r.URL.Query().Get("ms"))
		if ms <= 0 || ms > 5000 {
			ms = 300
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
		writeJSON(w, http.StatusOK, map[string]any{"slept": ms})
	})
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/json", http.StatusFound)
	})
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		code, _ := strconv.Atoi(r.URL.Query().Get("code"))
		if code < 200 || code > 599 {
			code = 418
		}
		writeJSON(w, code, map[string]any{"status": code, "message": "桩服务返回的固定状态码"})
	})
	mux.HandleFunc("/cookie", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "fixture_session", Value: "abc123", Path: "/"})
		writeJSON(w, http.StatusOK, map[string]any{"cookie": r.Header.Get("Cookie")})
	})
	// 流式接口：SSE 推送与最小 WebSocket 回显。
	mux.HandleFunc("/sse", sseHandler)
	mux.HandleFunc("/ws", wsHandler)
	e.Server = httptest.NewServer(mux)
	return e
}

// URL 是桩服务的根地址。
func (e *Echo) URL() string { return e.Server.URL }

// Close 关闭桩服务。
func (e *Echo) Close() { e.Server.Close() }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// fixture 里的占位符，harness 在写进临时目录前替换成真实地址。
const (
	placeholderBaseURL = "__BASE_URL__"
	placeholderToken   = "__TOKEN__"
)

// fileServer 用当前构建产物当「前端服务器」：测试跑的是生产构建的页面，
// 与安装包里的那份完全一致，只多了一层本地静态服务。
func fileServer(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		fs.ServeHTTP(w, r)
	})
}
