//go:build e2e

package e2e

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 集合 / 文件夹级共享设置：请求自己没设认证时继承上层的，
// 文件夹比集合更近，变量按「环境 > 文件夹 > 集合 > 全局」取值。

// openSharedSettings 右键某个集合 / 文件夹行，点「共享认证与变量…」。
func openSharedSettings(t *testing.T, label string) {
	t.Helper()
	rightClick(t, ".tree-row", label)
	h.clickText(t, ".env-menu-item", "共享设置…")
	h.wait(t, "共享设置弹窗", `!!document.querySelector('.dialog .auth-editor')`)
}

// setSharedAuth 把弹窗里的认证方式与 Token 改成给定值。
func setSharedAuth(t *testing.T, kind, token string) {
	t.Helper()
	clickIn(t, `.dialog .segmented[aria-label="认证方式"]`, kind)
	if kind == "无认证" {
		h.wait(t, "认证清空", `!!document.querySelector('.dialog .pane-empty')`)
		return
	}
	h.wait(t, "认证表单", `!!document.querySelector('.dialog .auth-editor .form-grid input')`)
	h.typeInto(t, ".dialog .auth-editor .form-grid input", token)
}

// setSharedVar 在弹窗里加一行变量。
func setSharedVar(t *testing.T, key, value string) {
	t.Helper()
	clickIn(t, ".dialog .kv", "添加一行")
	h.wait(t, "变量行", `!!document.querySelector('.dialog .kv-row')`)
	h.typeInto(t, ".dialog .kv-row .kv-key", key)
	h.typeInto(t, ".dialog .kv-row .kv-value", value)
}

// closeDialog 关掉当前浮层。
func closeDialog(t *testing.T) {
	t.Helper()
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "弹窗关闭", `!document.querySelector('.dialog')`)
}

// newCollection 新建一个空集合。
func newCollection(t *testing.T, name string) {
	t.Helper()
	h.clearOverlays(t)
	h.click(t, ".sidebar-foot .btn")
	h.wait(t, "新建集合输入框", `!!document.querySelector('.prompt-dialog .text-input')`)
	h.typeInto(t, ".prompt-dialog .text-input", name)
	h.clickText(t, ".prompt-dialog .btn", "创建")
	h.wait(t, "集合出现在侧边栏", fmt.Sprintf(`[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === %s)`, jsString(name)))
}

// newRequestVia 右键某行 → 新建请求，并等到新标签页成为当前标签
// （只看「有没有 .url-input」会被上一个标签骗过去，地址会写进别人家）。
func newRequestVia(t *testing.T, label string) {
	t.Helper()
	before := h.count(t, ".tab")
	rightClick(t, ".tree-row", label)
	h.clickText(t, ".env-menu-item", "新建请求")
	h.wait(t, "新标签页", fmt.Sprintf(`document.querySelectorAll('.tab').length === %d`, before+1))
	h.wait(t, "新标签页已激活", `(document.querySelector('.url-input') || {}).value === ''`)
}

// saveTabInto 用保存对话框把当前标签页存进集合（folder 为空表示集合根目录）。
func saveTabInto(t *testing.T, name, collection, folder string) {
	t.Helper()
	h.pressKeys(t, "S", true, false)
	h.wait(t, "保存对话框", `!!document.querySelector('.dialog .dialog-head')`)
	h.typeInto(t, ".dialog input[placeholder='请求名称']", name)

	// 第 1 个 select 是集合，第 2 个是文件夹。切集合会重绘文件夹下拉，
	// 所以必须分步做、每步都等界面重绘完，否则后面设的文件夹会被重绘冲掉。
	var ok bool
	h.eval(t, fmt.Sprintf(`(() => {
  const select = document.querySelectorAll('.dialog select')[0];
  const hit = [...select.options].find(o => (o.textContent || '').trim() === %s);
  if (!hit) return false;
  select.value = hit.value;
  select.dispatchEvent(new Event('change'));
  return true;
})()`, jsString(collection)), &ok)
	if !ok {
		t.Fatalf("保存对话框里找不到集合「%s」", collection)
	}

	if folder != "" {
		h.wait(t, "文件夹下拉里出现目标文件夹", fmt.Sprintf(`(() => {
  const select = document.querySelectorAll('.dialog select')[1];
  return !!select && [...select.options].some(o => (o.textContent || '').trim() === %s);
})()`, jsString(folder)))
		h.eval(t, fmt.Sprintf(`(() => {
  const select = document.querySelectorAll('.dialog select')[1];
  const hit = [...select.options].find(o => (o.textContent || '').trim() === %s);
  if (!hit) return false;
  select.value = hit.value;
  select.dispatchEvent(new Event('change'));
  return true;
})()`, jsString(folder)), &ok)
		if !ok {
			t.Fatalf("保存对话框里找不到文件夹「%s」", folder)
		}
	}

	// 保存前复核一次：重绘会把下拉恢复到默认值，值不对就会存到集合根目录。
	// 根目录那项的文案是「（集合根目录）」，不是空串。
	want := folder
	if want == "" {
		want = "（集合根目录）"
	}
	h.wait(t, "文件夹已选中", fmt.Sprintf(`(() => {
  const select = document.querySelectorAll('.dialog select')[1];
  if (!select) return false;
  const chosen = select.options[select.selectedIndex];
  return (chosen ? (chosen.textContent || '').trim() : '') === %s;
})()`, jsString(want)))

	h.clickText(t, ".dialog-foot .btn", "保存")
	h.wait(t, "对话框关闭", `!document.querySelector('.dialog')`)
	h.wait(t, "请求进了集合树", fmt.Sprintf(`[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === %s)`, jsString(name)))
}

// deleteCollectionViaMenu 右键删除集合（确认文案是「删除」）。
func deleteCollectionViaMenu(t *testing.T, name string) {
	t.Helper()
	rightClick(t, ".tree-row", name)
	h.clickText(t, ".env-menu-item", "删除集合")
	h.wait(t, "删除确认框", `!!document.querySelector('.confirm-box')`)
	h.clickText(t, ".dialog-foot .btn", "删除")
	h.wait(t, "集合已删除", fmt.Sprintf(`![...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === %s)`, jsString(name)))
}

// baseURL 从固定用例里读桩服务地址（去掉后面的路径）。
func baseURL(t *testing.T) string {
	t.Helper()
	h.openRequest(t, "GET 查询参数")
	clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数")
	preview := h.text(t, ".pane-preview-url")
	base := strings.TrimSuffix(preview, "/echo?q=mygo")
	if base == preview || !strings.HasPrefix(base, "http") {
		t.Fatalf("读不到桩服务地址：%q", preview)
	}
	return base
}

// 集合级认证与变量都要真的作用到子请求上，并在请求的认证页签里标出来源。
func TestCollectionSharedSettings(t *testing.T) {
	const (
		colName = "共享设置集合"
		reqName = "继承请求"
		token   = "collection-token-123"
	)
	base := baseURL(t)
	newCollection(t, colName)

	// 集合里建一条请求并保存回集合：只有存进集合的请求才有继承。
	newRequestVia(t, colName)
	typeURL(t, "{{sharedBase}}/echo")
	saveTabInto(t, reqName, colName, "")

	// 集合级：Bearer 认证 + sharedBase 变量。
	openSharedSettings(t, colName)
	setSharedAuth(t, "Bearer Token", token)
	setSharedVar(t, "sharedBase", base)
	closeDialog(t)

	// 认证页签要指出这份认证来自哪个集合。
	h.openRequest(t, reqName)
	clickIn(t, ".subtabs:not(.response-subtabs)", "认证")
	h.wait(t, "继承提示", fmt.Sprintf(`(() => {
  const note = document.querySelector('.inherit-note');
  return !!note && note.textContent.includes(%s) && note.textContent.includes('Bearer Token');
})()`, jsString(colName)))

	// 地址里的集合变量能解析成真实地址。
	clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数")
	h.wait(t, "查询参数面板", `!!document.querySelector('.pane-preview-url')`)
	if got := h.text(t, ".pane-preview-url"); got != base+"/echo" {
		t.Fatalf("集合变量没有参与解析：%q，期望 %q", got, base+"/echo")
	}

	// 真的发出去了：桩服务回显的请求头里带着集合的 Token。
	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("发送失败：状态 %q\n应用日志：\n%s", got, h.appLog())
	}
	if body := h.responseText(t); !strings.Contains(body, token) {
		t.Fatalf("服务端没收到集合级认证：%q", body)
	}

	// 清掉集合级设置并删掉这个集合，别影响后面的用例。
	openSharedSettings(t, colName)
	setSharedAuth(t, "无认证", "")
	closeDialog(t)
	deleteCollectionViaMenu(t, colName)
}

// 文件夹级认证比集合级更近：两层都设了时，文件夹里的请求用文件夹那份。
func TestFolderAuthOverridesCollection(t *testing.T) {
	const (
		colName   = "共享设置文件夹集合"
		foldName  = "子文件夹"
		reqName   = "文件夹请求"
		colToken  = "collection-token-123"
		foldToken = "folder-token-456"
	)
	newCollection(t, colName)
	rightClick(t, ".tree-row", colName)
	h.clickText(t, ".env-menu-item", "新建文件夹")
	h.wait(t, "文件夹出现", fmt.Sprintf(`[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === %s)`, jsString("新建文件夹")))
	renameViaMenu(t, ".tree-row", "新建文件夹", foldName)

	// 文件夹里建请求并保存到文件夹。
	newRequestVia(t, foldName)
	typeURL(t, "{{baseUrl}}/echo")
	saveTabInto(t, reqName, colName, foldName)

	// 集合与文件夹各设一份认证。
	openSharedSettings(t, colName)
	setSharedAuth(t, "Bearer Token", colToken)
	closeDialog(t)
	openSharedSettings(t, foldName)
	setSharedAuth(t, "Bearer Token", foldToken)
	closeDialog(t)

	// 请求看到的应该是文件夹那份。
	h.openRequest(t, reqName)
	clickIn(t, ".subtabs:not(.response-subtabs)", "认证")
	h.wait(t, "提示指向文件夹", fmt.Sprintf(`(() => {
  const note = document.querySelector('.inherit-note');
  return !!note && note.textContent.includes(%s);
})()`, jsString(foldName)))

	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("发送失败：状态 %q\n应用日志：\n%s", got, h.appLog())
	}
	body := h.responseText(t)
	if !strings.Contains(body, foldToken) {
		t.Fatalf("没有用文件夹级认证：%q", body)
	}
	if strings.Contains(body, colToken) {
		t.Fatalf("集合级认证不该覆盖文件夹级：%q", body)
	}

	// 「编辑共享设置」能跳到文件夹那一层。
	h.clickText(t, ".inherit-note .link-btn", "编辑共享设置")
	h.wait(t, "打开文件夹的共享设置", fmt.Sprintf(`(() => {
  const head = document.querySelector('.dialog .dialog-head h2');
  return !!head && head.textContent.includes(%s) && head.textContent.includes('文件夹');
})()`, jsString(foldName)))
	closeDialog(t)

	deleteCollectionViaMenu(t, colName)
}

// 文件夹级变量优先于集合级：同名变量取更近的那一层。
func TestFolderVarOverridesCollection(t *testing.T) {
	const (
		colName  = "共享变量集合"
		foldName = "变量文件夹"
		reqName  = "变量请求"
	)
	base := baseURL(t)
	newCollection(t, colName)
	rightClick(t, ".tree-row", colName)
	h.clickText(t, ".env-menu-item", "新建文件夹")
	h.wait(t, "文件夹出现", fmt.Sprintf(`[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === %s)`, jsString("新建文件夹")))
	renameViaMenu(t, ".tree-row", "新建文件夹", foldName)

	newRequestVia(t, foldName)
	typeURL(t, "{{sharedBase}}/echo")
	saveTabInto(t, reqName, colName, foldName)

	// 集合里给一个错的地址，文件夹里给对的那个：解析结果必须是文件夹的。
	openSharedSettings(t, colName)
	setSharedVar(t, "sharedBase", "http://127.0.0.1:1")
	closeDialog(t)
	openSharedSettings(t, foldName)
	setSharedVar(t, "sharedBase", base)
	closeDialog(t)

	h.openRequest(t, reqName)
	clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数")
	// 等预览地址真的算出文件夹那一层的值：切换子页签与设置写入都走异步重绘，
	// 立刻读文本会读到改设置之前那一帧。
	h.wait(t, "预览地址用上文件夹变量", fmt.Sprintf(
		`(document.querySelector('.pane-preview-url') || {}).textContent === %s`,
		jsString(base+"/echo"),
	))
	if got := h.text(t, ".pane-preview-url"); got != base+"/echo" {
		t.Fatalf("文件夹变量没有覆盖集合变量：%q，期望 %q", got, base+"/echo")
	}

	h.send(t)
	if got := h.status(t); got != "200" {
		t.Fatalf("发送失败：状态 %q\n应用日志：\n%s", got, h.appLog())
	}

	deleteCollectionViaMenu(t, colName)
}

// 共享设置要能跨重启保留：集合 / 文件夹的认证与变量写在库里的 settings 列。
func TestSharedSettingsPersist(t *testing.T) {
	const (
		colName  = "持久设置集合"
		foldName = "持久文件夹"
		reqName  = "持久请求"
	)
	base := baseURL(t)
	newCollection(t, colName)
	rightClick(t, ".tree-row", colName)
	h.clickText(t, ".env-menu-item", "新建文件夹")
	h.wait(t, "文件夹出现", `[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === '新建文件夹')`)
	renameViaMenu(t, ".tree-row", "新建文件夹", foldName)

	newRequestVia(t, foldName)
	typeURL(t, "{{sharedBase}}/echo")
	saveTabInto(t, reqName, colName, foldName)

	openSharedSettings(t, colName)
	setSharedAuth(t, "Bearer Token", "col-token")
	setSharedVar(t, "sharedBase", "http://127.0.0.1:1")
	closeDialog(t)
	openSharedSettings(t, foldName)
	setSharedVar(t, "sharedBase", base)
	closeDialog(t)

	waitForCommit(t, filepath.Join(h.userData, "workspace.db"), time.Now())
	h.restart(t)

	h.openRequest(t, reqName)
	clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数")
	h.wait(t, "查询参数面板", `!!document.querySelector('.pane-preview-url')`)
	if got := h.text(t, ".pane-preview-url"); got != base+"/echo" {
		t.Fatalf("重启后文件夹变量丢了：%q，期望 %q", got, base+"/echo")
	}
	clickIn(t, ".subtabs:not(.response-subtabs)", "认证")
	h.wait(t, "认证面板", `!!document.querySelector('.inherit-note')`)
	if note := h.text(t, ".inherit-note"); !strings.Contains(note, colName) || !strings.Contains(note, "Bearer Token") {
		t.Fatalf("重启后集合认证丢了：%q", note)
	}

	deleteCollectionViaMenu(t, colName)
}
