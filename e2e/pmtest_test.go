//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

// pm.test 断言：通过记绿的、抛错记红的，响应区头部的「断言 x/y」要对得上。
func TestPmTestAssertions(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	newTab(t)

	script := strings.Join([]string{
		`pm.test("状态码是 200", () => {`,
		`  if (pm.response.code !== 200) throw new Error("状态码不是 200：" + pm.response.code);`,
		`});`,
		`pm.test("响应里有 fixture 标记", () => {`,
		`  const body = pm.response.json();`,
		`  if (!body) throw new Error("响应体不是 JSON");`,
		`});`,
		`pm.test("这个断言故意失败", () => {`,
		`  throw new Error("预期失败");`,
		`});`,
	}, "\n")
	openScriptLibrary(t)
	addLibraryScript(t, "断言", "post", "全局（所有请求）", script)
	h.clearOverlays(t)

	typeURL(t, "{{baseUrl}}/json")
	h.send(t)

	h.wait(t, "断言结果", `document.querySelectorAll('.script-test').length === 3`)
	if badge := h.text(t, ".script-log-tag.bad"); !strings.Contains(badge, "2/3") {
		t.Fatalf("断言汇总应是 2/3，实际 %q", badge)
	}

	var results []string
	h.eval(t, `[...document.querySelectorAll('.script-test')].map(el => el.className.includes('pass') ? 'pass' : 'fail')`, &results)
	if len(results) != 3 || results[0] != "pass" || results[1] != "pass" || results[2] != "fail" {
		t.Fatalf("断言顺序不对：%v", results)
	}
	if text := h.text(t, ".script-test.fail .script-test-error"); !strings.Contains(text, "预期失败") {
		t.Fatalf("失败断言应显示错误原因，实际 %q", text)
	}
}
