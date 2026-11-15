// 更新源的取法：直连被重置时重试、重试完给出能照着做的提示、404 这类确定性失败不重试。

package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// noBackoff 把重试间隔清零，让用例不必真的等。
func noBackoff(t *testing.T) {
	t.Helper()
	old := updateBackoff
	updateBackoff = make([]time.Duration, len(old))
	t.Cleanup(func() { updateBackoff = old })
}

// sourceFor 返回指向测试服务器的更新源。
func sourceFor(server *httptest.Server) updateSource {
	return updateSource{feed: server.URL + "/", client: server.Client()}
}

// resetConnection 模拟「连接在传输中被重置」：不回任何响应就把连接关掉。
func resetConnection(t *testing.T, w http.ResponseWriter) {
	t.Helper()
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		t.Fatal("测试服务器不支持 Hijack")
	}
	conn, _, err := hijacker.Hijack()
	if err != nil {
		t.Fatalf("接管连接失败：%v", err)
	}
	conn.Close()
}

func TestUpdateSourceRetriesResetConnection(t *testing.T) {
	noBackoff(t)
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			resetConnection(t, w)
			return
		}
		io.WriteString(w, `{"version":"9.9.9"}`)
	}))
	defer server.Close()

	body, err := sourceFor(server).Manifest(context.Background(), false)
	if err != nil {
		t.Fatalf("第一次被重置后应当重试成功，却报错：%v", err)
	}
	defer body.Close()
	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("读响应失败：%v", err)
	}
	if !strings.Contains(string(got), "9.9.9") {
		t.Fatalf("拿到的内容不是重试那次的响应：%q", got)
	}
	if n := hits.Load(); n != 2 {
		t.Fatalf("应当只重试一次就成功，实际请求了 %d 次", n)
	}
}

func TestUpdateSourceExplainsPersistentFailure(t *testing.T) {
	noBackoff(t)
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		resetConnection(t, w)
	}))
	defer server.Close()

	_, err := sourceFor(server).Manifest(context.Background(), false)
	if err == nil {
		t.Fatal("一直连不上时应当报错")
	}
	if !strings.Contains(err.Error(), "连不上 GitHub 更新服务") {
		t.Fatalf("错误应当是用户看得懂的说明，实际：%v", err)
	}
	if want := int32(len(updateBackoff) + 1); hits.Load() != want {
		t.Fatalf("应当试 %d 次，实际 %d 次", want, hits.Load())
	}
}

func TestUpdateSourceDoesNotRetryMissingFile(t *testing.T) {
	noBackoff(t)
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer server.Close()

	_, err := sourceFor(server).Manifest(context.Background(), false)
	if err == nil {
		t.Fatal("404 应当报错")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Fatalf("错误里应当带上状态码，实际：%v", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("404 是确定性失败，不该重试，实际请求了 %d 次", hits.Load())
	}
}

func TestUpdateSourceAsksForTheManifestOfThisTarget(t *testing.T) {
	noBackoff(t)
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		io.WriteString(w, `{}`)
	}))
	defer server.Close()

	body, err := sourceFor(server).Manifest(context.Background(), false)
	if err != nil {
		t.Fatalf("取清单失败：%v", err)
	}
	body.Close()
	if want := "/update-" + updateTarget() + ".json"; len(paths) != 1 || paths[0] != want {
		t.Fatalf("应当只请求 %s，实际 %v", want, paths)
	}
}
