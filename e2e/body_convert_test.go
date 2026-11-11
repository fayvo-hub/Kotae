//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

// 读请求体面板的键值表，返回换行拼接的 [[key, value], …] 便于整段断言。
func bodyFormRows(t *testing.T) string {
	t.Helper()
	var rows string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.kv-row')].map(r => [
		r.querySelector('.kv-key')?.value ?? '',
		r.querySelector('.kv-value')?.value ?? '',
	]))`, &rows)
	return rows
}

// curl 里 `-d 'name=张三&age=12'` 是表单编码，导入后应当直接落在键值表里，
// 而不是给一段需要用户手抄进「表单编码」的原文。
func TestCurlDataImportsAsFormEncoded(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	pasteURL(t, `curl -X POST 'https://httpbin.org/post' -d 'name=张三&age=12'`)
	h.wait(t, "地址栏填入 curl 里的地址", `document.querySelector('.url-input').value === 'https://httpbin.org/post'`)

	h.activateSubtab(t, "请求体")
	h.wait(t, "请求体面板切到表单编码", `(() => {
		const active = document.querySelector('.segmented-item.active');
		return !!active && (active.textContent || '').trim() === '表单编码';
	})()`)
	h.wait(t, "两行表单字段渲染出来", `document.querySelectorAll('.kv-row').length === 2`)
	if got := bodyFormRows(t); !strings.Contains(got, `"name","张三"`) || !strings.Contains(got, `"age","12"`) {
		t.Fatalf("表单编码没拆对：%s", got)
	}

	// 复制回 cURL 不能丢正文：表单编码模式下正文只存在键值表里。
	h.pressKeys(t, "c", true, true)
	h.wait(t, "已复制 cURL", `document.body.textContent.includes('已复制 cURL 命令')`)
	curl := clipboard(t)
	if !strings.Contains(curl, "name=%E5%BC%A0%E4%B8%89") || !strings.Contains(curl, "age=12") {
		t.Fatalf("导出的 cURL 里没有表单正文：%q", curl)
	}

	// -G 拿 -d 当查询串时，字段要挪到参数表，请求体变回「无」。
	newTab(t)
	pasteURL(t, `curl -G 'https://httpbin.org/get' -d 'a=1&b=2'`)
	h.wait(t, "参数表拿到两项", `document.querySelectorAll('.kv-row').length === 2`)
	var params string
	h.eval(t, `JSON.stringify([...document.querySelectorAll('.kv-row')].map(r => [r.querySelector('.kv-key')?.value, r.querySelector('.kv-value')?.value]))`, &params)
	if !strings.Contains(params, `"a","1"`) || !strings.Contains(params, `"b","2"`) {
		t.Fatalf("-G 的 -d 内容没进查询参数：%s", params)
	}
	h.activateSubtab(t, "请求体")
	h.wait(t, "请求体变回无", `(() => {
		const active = document.querySelector('.segmented-item.active');
		return !!active && (active.textContent || '').trim() === '无' && !document.querySelector('.kv-row');
	})()`)
}

// 请求体类型切换要搬运内容：纯文本里粘了 `a=1&b=2`，切到表单编码就该是两行字段，
// 再切回纯文本还是同一段文本。拆不出来的自由文本保持不动。
func TestBodyModeSwitchCarriesContent(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	h.activateSubtab(t, "请求体")

	const encoded = `name=张三&age=12`
	h.clickText(t, ".segmented-item", "纯文本")
	h.wait(t, "纯文本编辑框出现", `!!document.querySelector('.code-input')`)
	h.eval(t, `(() => {
		const area = document.querySelector('.code-input');
		area.value = 'name=张三&age=12';
		area.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`, nil)
	h.wait(t, "纯文本内容写进去了", `document.querySelector('.code-input').value === 'name=张三&age=12'`)

	h.clickText(t, ".segmented-item", "表单编码")
	h.wait(t, "切到表单编码后自动拆成两行", `document.querySelectorAll('.kv-row').length === 2`)
	if got := bodyFormRows(t); !strings.Contains(got, `"name","张三"`) || !strings.Contains(got, `"age","12"`) {
		t.Fatalf("切到表单编码没搬运内容：%s", got)
	}

	h.clickText(t, ".segmented-item", "纯文本")
	h.wait(t, "切回纯文本内容还在", `document.querySelector('.code-input').value === 'name=张三&age=12'`)
	var body string
	h.eval(t, `document.querySelector('.code-input').value`, &body)
	if body != encoded {
		t.Fatalf("来回切换后纯文本变了：%q", body)
	}

	// 不像表单编码的自由文本：不拆字段（表格空着，不拿旧字段冒充正文），
	// 切回纯文本也不把原文吃掉。
	h.eval(t, `(() => {
		const area = document.querySelector('.code-input');
		area.value = '{"msg":"你好"}';
		area.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`, nil)
	h.wait(t, "JSON 文本写入", `document.querySelector('.code-input').value === '{"msg":"你好"}'`)
	h.clickText(t, ".segmented-item", "表单编码")
	h.wait(t, "切到表单编码", `document.querySelector('.segmented-item.active')?.textContent?.trim() === '表单编码'`)
	if got := bodyFormRows(t); got != "[]" {
		t.Fatalf("自由文本被拆进了字段：%s", got)
	}
	h.clickText(t, ".segmented-item", "纯文本")
	h.wait(t, "切回纯文本还是原文", `document.querySelector('.code-input').value === '{"msg":"你好"}'`)
}
