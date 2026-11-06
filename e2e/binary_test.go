//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

// 二进制响应不该只剩一个「无法预览」的空态：图片直接显示，其他类型给十六进制片段。
func TestBinaryResponsePreview(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	// 1. 图片：用 data URL 直接渲染，并且浏览器真的解码成功（naturalWidth > 0）。
	h.typeInto(t, ".url-input", h.echo.URL()+"/image")
	blurURL(t)
	h.send(t)
	h.wait(t, "图片预览出现", `(() => {
		const img = document.querySelector('.binary-image');
		return !!img && img.complete && img.naturalWidth > 0;
	})()`)
	var src string
	h.eval(t, `document.querySelector('.binary-image').getAttribute('src').slice(0, 22)`, &src)
	if !strings.HasPrefix(src, "data:image/png;base64,") {
		t.Fatalf("图片预览的 src 不对：%q", src)
	}

	// 2. application/octet-stream：给十六进制与 ASCII 对照。
	h.typeInto(t, ".url-input", h.echo.URL()+"/binary")
	blurURL(t)
	h.send(t)
	h.wait(t, "十六进制视图出现", `!!document.querySelector('.hex-view')`)
	var dump string
	h.eval(t, `document.querySelector('.hex-view').textContent`, &dump)
	if !strings.Contains(dump, "00 01 02 fe ff 50 4e 47") {
		t.Fatalf("十六进片段不对：%q", dump)
	}
	if !strings.Contains(dump, ".PNG") {
		t.Fatalf("ASCII 对照列没显示出来：%q", dump)
	}
	var meta string
	h.eval(t, `[...document.querySelectorAll('.binary-meta')].map(el => el.textContent).join('|')`, &meta)
	if !strings.Contains(meta, "application/octet-stream") {
		t.Fatalf("没有说明二进制响应的类型与大小：%q", meta)
	}
}
