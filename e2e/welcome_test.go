//go:build e2e

package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 首次启动引导只在空工作区出现，所以这里换一个空的数据目录启动一次，
// 检查这一屏的三个入口与「开始使用」都能用，最后恢复回固定测试数据。
func TestWelcomeOnboardingButtons(t *testing.T) {
	fresh := filepath.Join(h.tmp, "welcome-userdata")
	if err := os.MkdirAll(fresh, 0o755); err != nil {
		t.Fatalf("建空数据目录失败：%v", err)
	}

	prevEnv := h.env
	h.env = withUserData(prevEnv, fresh)
	defer func() {
		h.env = prevEnv
		h.restart(t)
		h.wait(t, "固定测试数据回来", `[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === '固定用例')`)
	}()

	h.restart(t)
	h.wait(t, "首次启动引导", `!!document.querySelector('.welcome')`)
	if n := assertControls(t, "首次启动引导", ".welcome"); n < 4 {
		t.Fatalf("引导屏只有 %d 个可点控件，应该有 3 张卡片 + 开始使用", n)
	}

	// 载入示例集合：引导消失，侧边栏出现集合。
	clickIn(t, ".welcome", "载入示例集合")
	h.wait(t, "引导关闭", `!document.querySelector('.welcome')`)
	h.wait(t, "示例集合出现", `document.querySelectorAll('.folder-row, .tree-row').length > 0`)
}

// withUserData 换掉环境里的数据目录，其余变量原样保留。
func withUserData(env []string, dir string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if strings.HasPrefix(kv, "MYGO_API_USER_DATA=") {
			continue
		}
		out = append(out, kv)
	}
	return append(out, "MYGO_API_USER_DATA="+dir)
}
