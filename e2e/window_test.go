//go:build e2e

package e2e

import (
	"os"
	"testing"
)

// e2e 跑的时候窗口默认被挪到屏幕外（见 desktop.go 的 placeE2EWindow），
// 目的有两个：不挡使用者正在做的事情，同时保证渲染没有被节流到跑不动。
// 这两个用例就是那两条要求的守卫。

// 窗口必须真的在屏幕外：可见窗口会盖住用户正在用的东西。
func TestWindowStaysOffscreen(t *testing.T) {
	if windowMode() == "visible" {
		t.Skip("MYGO_E2E_WINDOW=visible，本轮刻意让窗口留在原位")
	}
	wins, err := h.client.Windows()
	if err != nil {
		t.Fatalf("读取窗口列表失败：%v", err)
	}
	if len(wins) == 0 {
		t.Fatal("没有窗口")
	}
	for _, w := range wins {
		if w.Bounds.X > -1000 {
			t.Fatalf("窗口没有挪出屏幕：x=%.0f（窗口会被用户看到）", w.Bounds.X)
		}
	}
}

// 挪出屏幕后渲染仍要活着：rAF 还在跑、点击能改 DOM、还能截图。
// 这挡住「把窗口最小化/隐藏来静音」的退化——那样 WebView2 会节流，用例全都假绿。
func TestRenderingAliveOffscreen(t *testing.T) {
	var frames int
	h.eval(t, `new Promise(resolve => {
		const start = performance.now();
		let n = 0;
		const tick = () => {
			n++;
			if (performance.now() - start < 400) requestAnimationFrame(tick);
			else resolve(n);
		};
		requestAnimationFrame(tick);
	})`, &frames)
	if frames < 10 {
		t.Fatalf("渲染被节流：400ms 只有 %d 帧", frames)
	}

	h.clearOverlays(t)
	h.clickContaining(t, ".subtabs:not(.response-subtabs) .subtab", "请求头")
	h.wait(t, "子页签切换生效", `[...document.querySelectorAll('.subtabs:not(.response-subtabs) .subtab')].some(el => el.classList.contains('active') && el.textContent.includes('请求头'))`)

	png, err := h.client.Capture(h.win)
	if err != nil {
		t.Fatalf("截图失败：%v", err)
	}
	if len(png) < 1000 {
		t.Fatalf("截图太小，窗口可能没在渲染：%d 字节", len(png))
	}
}

// 页面自己看到的可见性，以及当前的 MYGO_E2E_WINDOW 取值（空=默认挪出屏幕）。
func windowMode() string {
	return os.Getenv("MYGO_E2E_WINDOW")
}
