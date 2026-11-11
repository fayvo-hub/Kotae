//go:build e2e

package e2e

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/plugins/sqlite"
)

// TestStorageMigratesLegacyWorkspace 验证存储层改造后的首次启动行为：
// 旧的 workspace.json 被一次性迁进 workspace.db，并改名成 .bak 保留原样。
func TestStorageMigratesLegacyWorkspace(t *testing.T) {
	dir := h.userData
	db := filepath.Join(dir, "workspace.db")
	info, err := os.Stat(db)
	if err != nil {
		t.Fatalf("没有生成 SQLite 数据库 %s：%v\n目录内容：%s", db, err, listDir(dir))
	}
	if info.Size() == 0 {
		t.Fatalf("数据库文件是空的：%s", db)
	}

	if _, err := os.Stat(filepath.Join(dir, "workspace.json")); err == nil {
		t.Fatalf("旧的 workspace.json 应该已经被改名，目录内容：%s", listDir(dir))
	}

	backup := filepath.Join(dir, "workspace.json.bak")
	b, err := os.ReadFile(backup)
	if err != nil {
		t.Fatalf("没有留下备份 %s：%v\n目录内容：%s", backup, err, listDir(dir))
	}
	if !strings.Contains(string(b), "固定用例") {
		t.Fatalf("备份内容不像原始 fixture，前 200 字节：%.200s", string(b))
	}

	// 设置面板的「关于」里要能看到存储层用的是哪个文件。
	h.openSettingsTab(t, "about")
	h.wait(t, "关于页出现", `!!document.querySelector('.info-box')`)
	if text := h.text(t, ".info-box"); !strings.Contains(text, "workspace.db") {
		t.Fatalf("设置面板没有显示数据库文件：%q", text)
	}
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "设置浮层关闭", `!document.querySelector('.info-box')`)
}

// TestStoragePersistsAcrossRestart 验证数据真的写进了数据库：
// 新建一个集合，重启进程后它仍然在，且二次重启不会重复迁移或清空数据。
func TestStoragePersistsAcrossRestart(t *testing.T) {
	const name = "重启后仍在"

	h.click(t, ".sidebar-foot .btn")
	h.wait(t, "输入框出现", `!!document.querySelector('.prompt-dialog .text-input')`)
	h.typeInto(t, ".prompt-dialog .text-input", name)
	h.clickText(t, ".prompt-dialog .btn", "创建")
	h.wait(t, "新集合出现在侧边栏", `[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === `+jsString(name)+`)`)

	// 页面写库有 220ms 防抖，等数据库文件真的被改写过再杀进程。
	waitForCommit(t, filepath.Join(h.userData, "workspace.db"), time.Now())

	h.restart(t)
	h.wait(t, "重启后集合还在", `[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === `+jsString(name)+`)`)

	h.restart(t)
	h.wait(t, "二次重启后集合仍在", `[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === `+jsString(name)+`)`)

	// 文件夹里的请求也要还在（层级与顺序靠 position 列还原），打开后要能真的发出去。
	h.openRequest(t, "纯文本")
	h.send(t)
	if status := h.status(t); status != "200" {
		t.Fatalf("重启后从固定用例发出的请求状态是 %q，期望 200\n应用日志：\n%s", status, h.appLog())
	}

	// 界面上的固定用例也还在，说明集合树整体往返正确。
	if n := h.count(t, ".tree-row"); n < 5 {
		t.Fatalf("重启后集合树只剩 %d 行，数据可能没读回来\n目录内容：%s", n, listDir(h.userData))
	}

	// 侧边栏折叠状态也要落库：重启后不该把用户的布局改回去。
	h.pressKeys(t, "b", true, false)
	h.wait(t, "侧边栏收起", `document.querySelector('.sidebar-host').classList.contains('collapsed')`)
	waitForCommit(t, filepath.Join(h.userData, "workspace.db"), time.Now())
	h.restart(t)
	h.wait(t, "重启后侧边栏仍收起", `document.querySelector('.sidebar-host').classList.contains('collapsed')`)
	h.pressKeys(t, "b", true, false)
	h.wait(t, "侧边栏重新展开", `!document.querySelector('.sidebar-host').classList.contains('collapsed')`)
	// 展开也要落库再走：这里不写盘，下一次重启会读回 collapsed=1，
	// 后面的用例全都看不到集合树（侧边栏收起时侧边栏不渲染行）。
	waitForCommit(t, filepath.Join(h.userData, "workspace.db"), time.Now())
}

// waitForCommit 等到数据库（或它的 WAL 文件）在 since 之后被写过，
// 说明上一批改动已经提交，此时杀进程不会丢掉它们。
func waitForCommit(t *testing.T, db string, since time.Time) {
	t.Helper()
	files := []string{db, db + "-wal"}
	deadline := time.Now().Add(10 * time.Second)
	for {
		for _, f := range files {
			if info, err := os.Stat(f); err == nil && info.ModTime().After(since) {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("等数据库写入超时（%s 在 %s 之后没有变化）\n目录内容：%s", db, since.Format("15:04:05.000"), listDir(filepath.Dir(db)))
		}
		time.Sleep(80 * time.Millisecond)
	}
}

// TestStorageMigratesDirectConnection v2 库里的「忽略系统代理」存的是旧默认值 0，
// 升到 v3 时应刷成 1（新默认直连）：旧版本没让用户选过这个开关，存量 0 与
// 「用户主动关掉」无法区分，不刷就会让内网请求继续被系统代理接管。
func TestStorageMigratesDirectConnection(t *testing.T) {
	db := filepath.Join(h.userData, "workspace.db")
	h.kill()

	// 把库改回 v2 的旧状态：直连存 0，版本号降回 2。
	conn, err := sqlite.Open(context.Background(), db, sqlite.OpenOptions{})
	if err != nil {
		t.Fatalf("打开数据库失败：%v", err)
	}
	for _, sql := range []string{
		"UPDATE settings SET value = '0' WHERE key = 'directConnection'",
		"UPDATE meta SET value = '2' WHERE key = 'schema_version'",
	} {
		if _, err := conn.Execute(context.Background(), sql); err != nil {
			_ = conn.Close()
			t.Fatalf("改库失败（%s）：%v", sql, err)
		}
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("关闭数据库失败：%v", err)
	}

	if err := h.launch(); err != nil {
		t.Fatalf("重新启动应用失败：%v\n应用日志：\n%s", err, h.appLog())
	}
	h.openSettingsTab(t, "desktop")
	h.wait(t, "桌面开关就位", `document.querySelectorAll('.desktop-toggle').length === 3`)
	var states []bool
	readDesktopToggles(t, &states)
	if len(states) != 3 || !states[2] {
		t.Fatalf("v2 库升级后直连应为开，实际：%v", states)
	}
	h.clearOverlays(t)

	// 版本号必须真的写回 3，否则每次启动都重跑迁移，把用户关掉的直连又打开。
	if version := schemaVersion(t, db); version != "3" {
		t.Fatalf("迁移后 schema_version 应为 3，实际 %q", version)
	}
}

// schemaVersion 读库里 meta.schema_version。
func schemaVersion(t *testing.T, db string) string {
	t.Helper()
	conn, err := sqlite.Open(context.Background(), db, sqlite.OpenOptions{ReadOnly: true})
	if err != nil {
		t.Fatalf("打开数据库失败：%v", err)
	}
	defer func() { _ = conn.Close() }()
	rows, err := conn.Query(context.Background(), "SELECT value FROM meta WHERE key = 'schema_version'")
	if err != nil {
		t.Fatalf("读版本号失败：%v", err)
	}
	if len(rows.Values) == 0 || len(rows.Values[0]) == 0 {
		t.Fatalf("库里没有 schema_version 行")
	}
	return fmt.Sprint(rows.Values[0][0])
}

// listDir 列出目录内容，断言失败时贴进报告里，方便判断是没写文件还是路径不对。
func listDir(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "读取目录失败：" + err.Error()
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		size := int64(-1)
		if info, err := e.Info(); err == nil {
			size = info.Size()
		}
		names = append(names, fmt.Sprintf("%s(%s)", e.Name(), sizeText(size)))
	}
	return strings.Join(names, ", ")
}

func sizeText(n int64) string {
	switch {
	case n < 0:
		return "?"
	case n < 1024:
		return strconv.FormatInt(n, 10) + "B"
	case n < 1024*1024:
		return strconv.FormatInt(n/1024, 10) + "KB"
	default:
		return strconv.FormatInt(n/(1024*1024), 10) + "MB"
	}
}
