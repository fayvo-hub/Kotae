//go:build e2e

package e2e

// 生成 README 里的功能截图。
//
// 默认跳过（npm run e2e 不跑它，避免每次都多写一堆文件）；需要更新截图时：
//
//	MYGO_E2E_SCREENSHOTS=1 go test -tags e2e ./e2e/ -run TestScreenshots -count=1
//
// 截图落在 docs/screenshots/，用的是 e2e 的固定测试数据与本机桩服务，
// 因此画面里不会出现真实内网地址或账号。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// reseed 把用户数据恢复到固定测试数据的状态，保证截图不受前面用例影响。
func reseed(t *testing.T) {
	t.Helper()
	if h.client != nil {
		_ = h.client.Close()
		h.client = nil
	}
	if h.cmd != nil && h.cmd.Process != nil {
		_ = h.cmd.Process.Kill()
		_, _ = h.cmd.Process.Wait()
		h.cmd = nil
	}
	// 库文件删掉后会重新从 workspace.json 导入，等于回到初始状态。
	for _, name := range []string{"workspace.db", "workspace.db-wal", "workspace.db-shm"} {
		_ = os.Remove(filepath.Join(h.userData, name))
	}
	// 等上一个进程真正退出：全局快捷键要在系统层面释放后才能重新注册。
	time.Sleep(300 * time.Millisecond)
	seed, err := os.ReadFile(filepath.Join(h.root, "e2e", "fixtures", "workspace.json"))
	if err != nil {
		t.Fatalf("读固定测试数据失败：%v", err)
	}
	seed = []byte(strings.NewReplacer(
		placeholderBaseURL, h.echo.URL(),
		placeholderToken, "fixture-token-123",
	).Replace(string(seed)))
	if err := os.WriteFile(filepath.Join(h.userData, "workspace.json"), seed, 0o644); err != nil {
		t.Fatalf("写固定测试数据失败：%v", err)
	}
	if err := h.launch(); err != nil {
		t.Fatalf("重启应用失败：%v\n应用日志：\n%s", err, h.appLog())
	}
}

// closeStrayTabs 关掉后台空标签（「未命名请求」），让截图只留下当前正在演示的那个。
func closeStrayTabs(t *testing.T) {
	t.Helper()
	h.eval(t, `(() => {
  for (let i = 0; i < 8; i++) {
    const tab = [...document.querySelectorAll('.tab')].find(el =>
      !el.classList.contains('active') && (el.querySelector('.tab-name')?.textContent || '').trim() === '未命名请求');
    if (!tab) return true;
    tab.querySelector('.tab-close')?.click();
  }
  return true;
})()`, nil)
	time.Sleep(80 * time.Millisecond)
}

// shotTo 截图到指定目录，等一小会儿让过渡动画结束再拍。
func shotTo(t *testing.T, dir, name string) {
	t.Helper()
	closeStrayTabs(t)
	time.Sleep(220 * time.Millisecond)
	png, err := h.client.Capture(h.win)
	if err != nil {
		t.Fatalf("截图 %s 失败：%v", name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".png"), png, 0o644); err != nil {
		t.Fatalf("写截图 %s 失败：%v", name, err)
	}
}

// expandTree 展开侧边栏里所有折叠的集合/文件夹，截图要能看到完整树。
func expandTree(t *testing.T) {
	t.Helper()
	h.eval(t, `(() => {
  const rows = [...document.querySelectorAll('.folder-row')];
  for (const row of rows) {
    const kids = row.parentElement?.querySelector(':scope > .tree-children');
    const twisty = row.querySelector('.twisty');
    if (kids && kids.classList.contains('collapsed') && twisty) twisty.click();
  }
  return true;
})()`, nil)
	// 切到集合页签，确保看到的是集合树而不是历史。
	h.wait(t, "侧边栏页签出现", `document.querySelectorAll('.sidebar-tab').length > 0`)
	h.clickContaining(t, ".sidebar-tab", "集合")
	time.Sleep(120 * time.Millisecond)
}

// waitResponse 等响应状态码出现且与期望一致。
func waitResponse(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		if h.text(t, ".status-num") == want {
			h.clearToasts(t)
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("响应状态不是 %q；状态栏=%s；提示=%s；响应区=%s", want, h.text(t, ".status-bar"), h.text(t, ".toasts"), h.responseText(t))
		}
		time.Sleep(80 * time.Millisecond)
	}
}

// streamShot 打开一个 WebSocket 标签页，连上、发一条消息，然后截图。
func streamShot(t *testing.T, dir, name string) {
	t.Helper()
	newStreamTab(t, "ws", "{{baseUrl}}/ws")
	h.click(t, ".send-btn")
	h.wait(t, "WebSocket 连上", `[...document.querySelectorAll('.stream-row')].some(r => (r.textContent || '').includes('hello from fixture'))`)
	h.typeInto(t, ".stream-composer-input", "你好，WebSocket")
	h.click(t, ".stream-send")
	h.wait(t, "消息被回显", `[...document.querySelectorAll('.stream-row.dir-in')].some(r => (r.textContent || '').includes('你好，WebSocket'))`)
	shotTo(t, dir, name)
	h.clearOverlays(t)
}

func TestScreenshots(t *testing.T) {
	if os.Getenv("MYGO_E2E_SCREENSHOTS") != "1" {
		t.Skip("设置 MYGO_E2E_SCREENSHOTS=1 才生成 README 截图")
	}
	dir := filepath.Join(h.root, "docs", "screenshots")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建截图目录失败：%v", err)
	}
	reseed(t)
	expandTree(t)

	// 01 主界面：左集合树 + 请求构建 + JSON 结构化响应。
	h.openRequest(t, "POST JSON 回显")
	h.send(t)
	waitResponse(t, "200")
	shotTo(t, dir, "01-main")

	// 02 结构化响应：GET 带查询参数，右侧全展开的 JSON 树。
	h.openRequest(t, "GET 查询参数")
	h.send(t)
	waitResponse(t, "200")
	shotTo(t, dir, "02-json-tree")

	// 03 请求脚本：前置脚本算 HMAC 签名，脚本输出收在响应区的「控制台」页签里。
	newTab(t)
	openScriptLibrary(t)
	addLibraryScript(t, "签名", strings.Join([]string{
		`const ts = String(pm.utils.now());`,
		`pm.request.headers.upsert("X-Ts", ts);`,
		`pm.request.headers.upsert("X-Sign", await pm.utils.hmacSha256("e2e-secret", "/signed|" + ts));`,
		`console.log("已签名 ts=" + ts);`,
	}, "\n"))
	h.clearOverlays(t)
	h.typeInto(t, ".url-input", "{{baseUrl}}/signed")
	blurURL(t)
	addRequestStep(t, "pre", "脚本库")
	pickStepLibrary(t, 1, "签名")
	h.send(t)
	waitResponse(t, "200")
	openConsoleTab(t)
	shotTo(t, dir, "03-script")

	// 13 脚本库：库里只放可复用的代码，不再带阶段与作用范围。
	openScriptLibrary(t)
	selectLibraryScript(t, "签名")
	shotTo(t, dir, "13-script-library")
	h.clearOverlays(t)

	// 04 环境变量：顶栏胶囊 → 编辑按钮进入环境对话框。
	h.pressKeys(t, "e", true, false)
	h.wait(t, "环境对话框", `document.querySelector('.dialog .env-item') !== null`)
	shotTo(t, dir, "04-environment")
	h.clearOverlays(t)

	// 05 cURL 导入：粘贴一条带认证与请求体的命令，右侧出解析预览。
	h.pressKeys(t, "i", true, false)
	h.wait(t, "cURL 对话框", `document.querySelector('.curl-input') !== null`)
	h.typeInto(t, ".curl-input", `curl -X POST 'https://api.example.com/v1/orders?page=2' -H 'Content-Type: application/json' -H 'X-Token: {{token}}' --data-raw '{"sku":"A-1","qty":3}' -u user:pass`)
	h.clickText(t, ".dialog .btn", "解析")
	h.wait(t, "解析预览", `document.querySelector('.preview-card') !== null`)
	shotTo(t, dir, "05-curl-import")
	h.clearOverlays(t)

	// 06 导入集合：Postman Collection v2.1 粘进导入浮层，出集合树预览。
	h.pressKeys(t, "i", true, true)
	h.wait(t, "导入浮层", `document.querySelector('.dialog .curl-input') !== null`)
	h.typeInto(t, ".dialog .curl-input", `{
  "info": { "name": "示例 API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "item": [
    { "name": "用户", "item": [
      { "name": "列表", "request": { "method": "GET", "url": "{{baseUrl}}/users" } },
      { "name": "创建", "request": { "method": "POST", "url": "{{baseUrl}}/users", "body": { "mode": "raw", "raw": "{\"name\":\"mygo\"}" } } }
    ] },
    { "name": "健康检查", "request": { "method": "GET", "url": "{{baseUrl}}/health" } }
  ]
}`)
	h.clickText(t, ".dialog .btn", "解析")
	h.wait(t, "导入预览", `document.querySelector('.import-preview') !== null`)
	shotTo(t, dir, "06-import")
	h.clearOverlays(t)

	// 07 命令面板：输入「环境」筛选出环境相关命令。
	h.pressKeys(t, "k", true, false)
	h.wait(t, "命令面板", `document.querySelector('.palette-search') !== null`)
	h.typeInto(t, ".palette-search", "环境")
	shotTo(t, dir, "07-palette")
	h.clearOverlays(t)

	// 08 设置：左栏分类页签 + 右栏内容（默认外观：主题、缩放、代码字号）。
	h.pressKeys(t, ",", true, false)
	h.wait(t, "设置面板", `document.querySelector('.settings-tabs') !== null`)
	shotTo(t, dir, "08-settings")
	h.clearOverlays(t)

	// 09 历史：每次发送都会留一条，带状态码与耗时。
	h.clickContaining(t, ".sidebar-tab", "历史")
	h.wait(t, "历史列表", `document.querySelector('.history-row') !== null`)
	shotTo(t, dir, "09-history")

	// 11 流式面板：WebSocket 连本机桩服务，收问候 + 发一条回显。
	streamShot(t, dir, "11-stream")

	// 10 浅色主题：切回集合页签，主题轮转到浅色再拍一张。
	h.clickContaining(t, ".sidebar-tab", "集合")
	h.click(t, `[data-role="theme"]`)
	h.click(t, `[data-role="theme"]`)
	h.wait(t, "浅色主题", `document.documentElement.dataset.theme === "light"`)
	h.openRequest(t, "POST JSON 回显")
	h.send(t)
	waitResponse(t, "200")
	shotTo(t, dir, "10-light")

	// 12 浅色主题下的流式面板：两种主题都要看过才算验证过界面。
	streamShot(t, dir, "12-stream-light")

	// 收尾：把主题切回深色，避免影响后续用例的截图基线。
	h.click(t, `[data-role="theme"]`)
	t.Logf("截图已写入 %s", dir)
}
