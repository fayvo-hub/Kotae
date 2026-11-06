//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

// 环境变量可以标成敏感：界面上把值遮住，但发送与导出仍用真实值。
func TestEnvSecretMask(t *testing.T) {
	h.clearOverlays(t)
	h.pressKeys(t, "e", true, false)
	h.wait(t, "环境面板打开", `!!document.querySelector('.env-layout .kv-row')`)

	// 第一行的 baseUrl 是 fixture 里的真实值，记下来对比遮住前后。
	var before string
	h.eval(t, `(() => {
		const input = document.querySelector('.env-layout .kv-value');
		return JSON.stringify({ type: input.type, value: input.value });
	})()`, &before)
	if !strings.Contains(before, `"type":"text"`) {
		t.Fatalf("环境变量默认应该是明文：%s", before)
	}

	h.click(t, ".env-layout .kv-secret")
	h.wait(t, "值被遮住", `document.querySelector('.env-layout .kv-value').type === 'password'`)
	if !h.exists(t, ".env-layout .kv-secret.active") {
		t.Fatal("遮住后按钮应该是点亮状态")
	}
	var masked string
	h.eval(t, `document.querySelector('.env-layout .kv-value').value`, &masked)
	if strings.Contains(masked, `"`) || masked == "" {
		t.Fatalf("遮住只是改显示，不该清空真实值：%q", masked)
	}
	if !strings.Contains(before, masked) {
		t.Fatalf("遮住后值被改动了：遮住前 %s，遮住后 %q", before, masked)
	}

	// 关掉面板重新打开：遮住状态要能从数据里恢复（不是只活了一次渲染）。
	h.clearOverlays(t)
	h.wait(t, "浮层关闭", `!document.querySelector('.backdrop')`)
	h.pressKeys(t, "e", true, false)
	h.wait(t, "环境面板重新打开", `!!document.querySelector('.env-layout .kv-row')`)
	h.wait(t, "遮住状态恢复", `document.querySelector('.env-layout .kv-value').type === 'password'`)

	// 再点一次恢复明文。
	h.click(t, ".env-layout .kv-secret")
	h.wait(t, "值恢复明文", `document.querySelector('.env-layout .kv-value').type === 'text'`)
	if h.exists(t, ".env-layout .kv-secret.active") {
		t.Fatal("恢复明文后按钮不该还是点亮状态")
	}
	h.clearOverlays(t)
	h.wait(t, "浮层关闭", `!document.querySelector('.backdrop')`)
}
