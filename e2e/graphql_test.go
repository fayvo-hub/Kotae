//go:build e2e

package e2e

import (
	"strings"
	"testing"
	"time"
)

// GraphQL 请求体：query 与 variables 分栏编辑，发送时拼成 {query, variables} 的 JSON。
func TestGraphQLBody(t *testing.T) {
	h.clearOverlays(t)
	openNewTab(t)
	typeURL(t, "{{baseUrl}}/echo")

	// GraphQL 走 POST。
	h.eval(t, `(() => {
	  const sel = document.querySelector('.method-select');
	  sel.value = 'POST';
	  sel.dispatchEvent(new Event('change', { bubbles: true }));
	  return true;
	})()`, nil)
	time.Sleep(120 * time.Millisecond)

	clickIn(t, ".subtabs:not(.response-subtabs)", "请求体")
	h.wait(t, "请求体面板", `!!document.querySelector('.segmented[aria-label="请求体类型"]')`)
	clickIn(t, `.segmented[aria-label="请求体类型"]`, "GraphQL")
	h.wait(t, "GraphQL 面板", `!!document.querySelector('.graphql-pane')`)

	const query = "query Ping($id: Int) {\n  ping(id: $id)\n}"
	h.typeInto(t, ".graphql-query", query)
	h.typeInto(t, ".graphql-vars", `{"id": 7}`)
	h.wait(t, "变量语法提示", `(document.querySelector('.graphql-pane .pane-status') || {}).textContent === '变量 JSON 语法正确'`)

	h.send(t)
	if status := h.status(t); status != "200" {
		t.Fatalf("GraphQL 请求应返回 200，实际 %q\n%s", status, h.responseText(t))
	}
	body := h.responseText(t)
	// /echo 会把收到的正文原样回显，正文应是 {query, variables} 的 JSON。
	for _, want := range []string{"query", "variables", "Ping", "id"} {
		if !strings.Contains(body, want) {
			t.Fatalf("回显的请求体里应有 %q，实际：%s", want, body)
		}
	}

	// 变量写坏了要当场提示，但发送时按空变量处理，不阻断请求。
	h.typeInto(t, ".graphql-vars", `{"id": }`)
	h.wait(t, "变量语法错误提示", `(document.querySelector('.graphql-pane .pane-status .bad') || {}).textContent !== undefined`)
	// 还原，别把坏 JSON 留给后面的用例。
	h.typeInto(t, ".graphql-vars", `{"id": 7}`)

	// 换回 JSON 再换回来，内容要保留。
	clickIn(t, `.segmented[aria-label="请求体类型"]`, "JSON")
	h.wait(t, "切换到 JSON", `!document.querySelector('.graphql-pane')`)
	var body2 string
	h.eval(t, `(document.querySelector('.code-input') || {}).value || ''`, &body2)
	if body2 != query {
		t.Fatalf("切回 JSON 时 query 应原样留在请求体里，实际 %q", body2)
	}
	clickIn(t, `.segmented[aria-label="请求体类型"]`, "GraphQL")
	h.wait(t, "切回 GraphQL", `!!document.querySelector('.graphql-vars')`)
	var vars string
	h.eval(t, `(document.querySelector('.graphql-vars') || {}).value || ''`, &vars)
	if !strings.Contains(vars, `"id": 7`) {
		t.Fatalf("变量应保留，实际 %q", vars)
	}
}
