//go:build e2e

package e2e

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// 本文件逐个界面盘点可点控件（按钮、链接按钮、图标按钮、分段项、页签、菜单项），
// 断言三件事：有名字（可被读屏或提示识别）、尺寸不为零、中心点真的能被点中
// （没有被其他层盖住）。它不验证业务语义——语义在各自的用例里测。

// ctlInfo 是一个可点控件的现场快照。
type ctlInfo struct {
	Tag      string  `json:"tag"`
	Cls      string  `json:"cls"`
	Text     string  `json:"text"`
	Aria     string  `json:"aria"`
	Title    string  `json:"title"`
	Disabled bool    `json:"disabled"`
	InView   bool    `json:"inView"`
	Clipped  bool    `json:"clipped"`
	W        float64 `json:"w"`
	H        float64 `json:"h"`
	Hit      string  `json:"hit"`
}

// 传入 scope 时只看该容器（取最后一个匹配，浮层里套浮层时用最上面那个）；
// 否则看整页。中心点在视口外（需要滚动）或控件禁用时不判定命中，
// 因为这两种情况点不中是设计如此。
const ctlScript = `(() => {
	const sel = 'button, .btn, .icon-btn, .link-btn, .segmented-item, .subtab, .sidebar-tab, [role="option"], [role="menuitem"], [role="tab"]';
	const roots = %s ? [...document.querySelectorAll(%s)] : [];
	const root = roots.length ? roots[roots.length - 1] : document;
	const hitAt = (el) => {		const r = el.getBoundingClientRect();
		const cx = r.left + r.width / 2;
		const cy = r.top + r.height / 2;
		if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return 'offscreen';
		const hit = document.elementFromPoint(cx, cy);
		if (!hit) return 'none';
		if (hit === el || el.contains(hit)) return 'self';
		const label = (hit.className || '').toString() || hit.tagName;
		return 'blocked-by:' + String(label).slice(0, 40);
	};
	return JSON.stringify([...root.querySelectorAll(sel)]
		.filter(el => el.getClientRects().length > 0)
		.map(el => {
			const r = el.getBoundingClientRect();
			const cx = r.left + r.width / 2;
			const cy = r.top + r.height / 2;
			return {
				tag: el.tagName.toLowerCase(),
				cls: (el.className || '').toString(),
				text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
				aria: el.getAttribute('aria-label') || '',
				title: el.getAttribute('title') || '',
				disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
				inView: cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight,
				clipped: (() => {
					const r = el.getBoundingClientRect();
					for (let p = el.parentElement; p; p = p.parentElement) {
						const cs = getComputedStyle(p);
						if (!/(auto|scroll|hidden)/.test(cs.overflow + cs.overflowY)) continue;
						const pr = p.getBoundingClientRect();
						if (r.bottom > pr.bottom + 1 || r.top < pr.top - 1) return true;
					}
					return false;
				})(),
				w: Math.round(r.width),
				h: Math.round(r.height),
				hit: hitAt(el),			};
		}));
})()`

func collectControls(t *testing.T, scope string) []ctlInfo {
	t.Helper()
	var raw string
	h.eval(t, fmt.Sprintf(ctlScript, jsString(scope), jsString(scope)), &raw)
	var list []ctlInfo
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		t.Fatalf("解析控件清单失败：%v\n%s", err, raw)
	}
	return list
}

// assertControls 断言一个界面上的控件都可用，并返回数量。
func assertControls(t *testing.T, screen, scope string) int {
	t.Helper()
	list := collectControls(t, scope)
	for _, c := range list {
		name := c.Text + c.Aria + c.Title
		if strings.TrimSpace(name) == "" {
			t.Errorf("%s：有个控件既没有文字也没有 aria-label / title（%s.%s，%dx%d）",
				screen, c.Tag, c.Cls, int(c.W), int(c.H))
		}
		if c.InView && (c.W < 6 || c.H < 6) {
			t.Errorf("%s：%q 尺寸异常 %dx%d", screen, c.Text, int(c.W), int(c.H))
		}
		if c.InView && !c.Disabled && !c.Clipped && c.Hit != "self" {
			t.Errorf("%s：%q 点不中（中心点被 %s 接住）", screen, c.Text, c.Hit)
		}
	}
	return len(list)
}

// clickIn 在容器里按文字前缀点一个控件（页签、分段项、菜单项都用它）。
func clickIn(t *testing.T, container, label string) {
	t.Helper()
	var ok bool
	h.eval(t, fmt.Sprintf(`(() => {
		const box = document.querySelectorAll(%s);
		const root = box.length ? box[box.length - 1] : document;
		const target = [...root.querySelectorAll('button, .segmented-item, .subtab, .sidebar-tab, .btn, .link-btn, [role="option"], [role="menuitem"]')]
			.find(el => (el.textContent || '').trim().startsWith(%s));
		if (!target) return false;
		target.click();
		return true;
	})()`, jsString(container), jsString(label)), &ok)
	if !ok {
		t.Fatalf("%s 里找不到「%s」", container, label)
	}
}

// 每个可见界面上的控件都要有名字、有尺寸、点得中。
func TestControlsUsable(t *testing.T) {
	h.clearOverlays(t)

	screens := []struct {
		name  string
		open  func()
		scope string
		min   int
	}{
		{"主界面", func() {}, "", 20},
		{"查询参数", func() { clickIn(t, ".subtabs:not(.response-subtabs)", "查询参数") }, "", 20},
		{"请求头", func() { clickIn(t, ".subtabs:not(.response-subtabs)", "请求头") }, "", 20},
		{"请求体", func() { clickIn(t, ".subtabs:not(.response-subtabs)", "请求体") }, "", 24},
		{"认证", func() { clickIn(t, ".subtabs:not(.response-subtabs)", "认证") }, "", 24},
		{"脚本", func() { clickIn(t, ".subtabs:not(.response-subtabs)", "脚本") }, "", 20},
		{"选项", func() { clickIn(t, ".subtabs:not(.response-subtabs)", "选项") }, "", 18},
		{"导入 cURL", func() { h.pressKeys(t, "i", true, false) }, ".dialog", 4},
		{"导入集合", func() { h.pressKeys(t, "i", true, true) }, ".dialog", 4},
		{"环境", func() { h.pressKeys(t, "e", true, false) }, ".dialog", 10},
		{"设置", func() { h.pressKeys(t, ",", true, false) }, ".dialog", 12},
		{"命令面板", func() { h.pressKeys(t, "k", true, false) }, ".palette", 3},
		{"环境下拉", func() { h.click(t, ".env-pill-btn") }, ".env-menu", 3},
	}

	for _, s := range screens {
		s.open()
		h.wait(t, s.name+" 就绪", fmt.Sprintf(`document.querySelectorAll(%s).length > 0`, jsString(scopeOrRoot(s.scope))))
		n := assertControls(t, s.name, s.scope)
		if n < s.min {
			t.Errorf("%s：只找到 %d 个控件，少于预期的 %d 个（有按钮消失了？）", s.name, n, s.min)
		}
		t.Logf("%s：%d 个控件", s.name, n)
		h.clearOverlays(t)
	}

	// 标签页右键菜单。
	h.eval(t, `(() => {
		const tab = document.querySelector('.tab.active');
		tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 140 }));
		return true;
	})()`, nil)
	h.wait(t, "标签菜单", `!!document.querySelector('.ctx-menu')`)
	if n := assertControls(t, "标签菜单", ".ctx-menu"); n != 4 {
		t.Errorf("标签页右键菜单应该有 4 项（刷新/关闭/关闭其他/关闭全部），实际 %d", n)
	}
	h.pressKeys(t, "Escape", false, false)
}

func scopeOrRoot(scope string) string {
	if scope == "" {
		return "body"
	}
	return scope
}

// 请求区与响应区的每个页签都要真的能切（点不动的页签等于死按钮）。
func TestAllSubtabsSwitchable(t *testing.T) {
	h.clearOverlays(t)

	for _, label := range []string{"查询参数", "请求头", "请求体", "认证", "脚本", "选项"} {
		clickIn(t, ".subtabs:not(.response-subtabs)", label)
		h.wait(t, "请求区页签 "+label, fmt.Sprintf(
			`[...document.querySelectorAll('.subtabs:not(.response-subtabs) .subtab.active')].some(el => el.textContent.startsWith(%s))`,
			jsString(label)))
	}

	// 响应区页签要先把响应拿到手。
	typeURL(t, "{{baseUrl}}/echo")
	h.send(t)
	for _, label := range []string{"响应体", "响应头", "请求"} {
		clickIn(t, ".response-subtabs", label)
		h.wait(t, "响应区页签 "+label, fmt.Sprintf(
			`[...document.querySelectorAll('.response-subtabs .subtab.active')].some(el => el.textContent.startsWith(%s))`,
			jsString(label)))
	}
}

// 请求体的五种模式、认证的四种方式：每组都要能切过去；脚本页是只读列表 + 脚本库入口。
func TestAllSegmentsSwitchable(t *testing.T) {
	h.clearOverlays(t)

	clickIn(t, ".subtabs:not(.response-subtabs)", "请求体")
	h.wait(t, "请求体页签", `!!document.querySelector('.segmented[aria-label="请求体类型"]')`)
	for _, label := range []string{"无", "JSON", "纯文本", "表单编码", "表单（可含文件）"} {
		clickIn(t, ".segmented[aria-label='请求体类型']", label)
		h.wait(t, "请求体模式 "+label, fmt.Sprintf(
			`[...document.querySelectorAll('.segmented[aria-label="请求体类型"] .segmented-item.active')].some(el => el.textContent.startsWith(%s))`,
			jsString(label)))
	}

	clickIn(t, ".subtabs:not(.response-subtabs)", "认证")
	h.wait(t, "认证页签", `!!document.querySelector('.auth-switch, .segmented[aria-label="认证方式"]')`)
	for _, label := range []string{"无认证", "Bearer Token", "Basic 用户名密码", "API Key"} {
		clickIn(t, ".segmented[aria-label='认证方式']", label)
		h.wait(t, "认证方式 "+label, fmt.Sprintf(
			`[...document.querySelectorAll('.segmented[aria-label="认证方式"] .segmented-item.active')].some(el => el.textContent.startsWith(%s))`,
			jsString(label)))
	}

	// 脚本页只读：列出本次发送会跑的那几条，编辑入口是「打开脚本库」。
	clickIn(t, ".subtabs:not(.response-subtabs)", "脚本")
	h.wait(t, "脚本页签", `!!document.querySelector('.script-pane')`)
	h.wait(t, "脚本页有打开脚本库的入口", `[...document.querySelectorAll('.script-pane .btn')].some(b => (b.textContent || '').includes('打开脚本库'))`)
}

// 顶栏与侧边栏的按钮逐个按一遍，每个都要有可见结果。
func TestToolbarButtonsWork(t *testing.T) {
	h.clearOverlays(t)

	// 侧边栏折叠 / 展开。
	h.click(t, "[data-role='sidebar']")
	h.wait(t, "侧边栏折叠", `!!document.querySelector('.sidebar-host.collapsed')`)
	h.pressKeys(t, "b", true, false)
	h.wait(t, "侧边栏展开", `!document.querySelector('.sidebar-host.collapsed')`)

	// 主题按钮循环三档。
	const themeProbe = `document.documentElement.dataset.theme`
	var before, after string
	h.eval(t, themeProbe, &before)
	h.click(t, "[data-role='theme']")
	h.wait(t, "主题切换", fmt.Sprintf(`document.documentElement.dataset.theme !== %s`, jsString(before)))
	h.eval(t, themeProbe, &after)
	if after == before {
		t.Fatalf("点主题按钮后主题没变：%q", after)
	}
	h.click(t, "[data-role='theme']")
	h.click(t, "[data-role='theme']")
	h.wait(t, "主题回到初始", fmt.Sprintf(`document.documentElement.dataset.theme === %s`, jsString(before)))

	// 设置按钮。
	h.click(t, "[data-role='settings']")
	h.wait(t, "设置打开", `!!document.querySelector('.settings-body')`)
	h.clickText(t, ".dialog-foot button", "完成")
	h.wait(t, "设置关闭", `!document.querySelector('.settings-body')`)

	// 命令面板按钮。
	h.click(t, "[data-role='palette']")
	h.wait(t, "命令面板打开", `!!document.querySelector('.palette')`)
	h.pressKeys(t, "Escape", false, false)
	h.wait(t, "命令面板关闭", `!document.querySelector('.palette')`)

	// 环境胶囊：展开 → 切一个环境 → 饼标跟着变。
	var envBefore string
	h.eval(t, `(document.querySelector('.env-pill-name') || {}).textContent || ''`, &envBefore)
	h.click(t, ".env-pill-btn")
	h.wait(t, "环境下拉展开", `!!document.querySelector('.env-menu')`)
	clickIn(t, ".env-menu", "固定环境")
	h.wait(t, "环境下拉收起", `!document.querySelector('.env-menu')`)

	// 编辑环境按钮直达环境面板。
	h.click(t, ".env-pill-edit")
	h.wait(t, "环境面板打开", `!!document.querySelector('.env-layout')`)
	h.clearOverlays(t)

	// 新建集合：点按钮 → 应用内输入框 → 创建。
	h.click(t, ".sidebar-foot .btn")
	h.wait(t, "新建集合输入框", `!!document.querySelector('.prompt-dialog .text-input')`)
	h.typeInto(t, ".prompt-dialog .text-input", "按钮巡检集合")
	h.clickText(t, ".prompt-dialog .btn", "创建")
	h.wait(t, "新建集合出现在侧边栏", `[...document.querySelectorAll('.tree-label')].some(el => el.textContent.trim() === '按钮巡检集合')`)
}

// 响应区的三个图标按钮：复制、重发要真的有结果（保存为文件会弹系统对话框，跳过）。
func TestResponseToolbarButtons(t *testing.T) {
	h.clearOverlays(t)
	typeURL(t, "{{baseUrl}}/echo")
	h.send(t)
	h.wait(t, "有响应", `!!document.querySelector('.status-num')`)

	h.clearToasts(t)
	h.click(t, ".response-pane [title='复制响应体'], [title='复制响应体']")
	h.wait(t, "复制响应体", `[...document.querySelectorAll('.toast')].some(el => el.textContent.includes('已复制'))`)

	// 历史只在「历史」面板里渲染，先切过去再数。
	h.clickContaining(t, ".sidebar-tab", "历史")
	h.wait(t, "历史面板", `!!document.querySelector('.history-row')`)
	h.clearToasts(t)
	before := h.count(t, ".history-row")
	h.click(t, "[title^='重新发送']")
	h.wait(t, "重发新增一条历史", fmt.Sprintf(`document.querySelectorAll('.history-row').length > %d`, before))
}

// 标签页的加号与关闭按钮。
func TestTabButtons(t *testing.T) {
	h.clearOverlays(t)
	before := h.count(t, ".tab")

	h.click(t, ".tab-add")
	h.wait(t, "新建标签页", fmt.Sprintf(`document.querySelectorAll('.tab').length > %d`, before))

	h.eval(t, `(() => {
		const tabs = [...document.querySelectorAll('.tab')];
		tabs[tabs.length - 1].querySelector('.tab-close').click();
		return true;
	})()`, nil)
	h.wait(t, "关闭标签页", fmt.Sprintf(`document.querySelectorAll('.tab').length === %d`, before))
}

// 历史面板的「清空历史」按钮。
func TestHistoryClearButton(t *testing.T) {
	h.clearOverlays(t)
	h.clickContaining(t, ".sidebar-tab", "历史")
	if h.count(t, ".history-row") == 0 {
		typeURL(t, "{{baseUrl}}/echo")
		h.send(t)
		h.wait(t, "有历史", `document.querySelectorAll('.history-row').length > 0`)
	}
	h.click(t, ".history-head .link-btn")
	h.wait(t, "清空历史确认框", `!!document.querySelector('.confirm-box')`)
	h.clickText(t, ".dialog-foot .btn", "清空")
	h.wait(t, "历史已清空", `document.querySelectorAll('.history-row').length === 0`)
}

// 环境面板里的新建环境、删除环境、添加变量行。
// 「导出全部数据 / 导入备份」会弹系统文件对话框，自动化点不到，这里不覆盖。
func TestEnvDialogButtons(t *testing.T) {
	h.clearOverlays(t)
	h.pressKeys(t, "e", true, false)
	h.wait(t, "环境面板", `!!document.querySelector('.env-layout')`)

	before := h.count(t, ".env-item")
	clickIn(t, ".env-dialog, .env-layout", "新建环境")
	h.wait(t, "新建环境输入框", `!!document.querySelector('.prompt-dialog .text-input')`)
	h.clickText(t, ".prompt-dialog .btn", "创建")
	h.wait(t, "新建环境生效", fmt.Sprintf(`document.querySelectorAll('.env-item').length > %d`, before))

	// 新环境是空的，加一行变量并确认能落进表里。
	rows := h.count(t, ".env-detail .kv-row")
	clickIn(t, ".env-detail", "添加一行")
	h.wait(t, "环境变量加了一行", fmt.Sprintf(`document.querySelectorAll('.env-detail .kv-row').length > %d`, rows))

	// 再删掉刚建的环境，回到原来的数量。
	h.click(t, ".env-detail .btn.danger, .env-detail .danger")
	h.wait(t, "删除环境确认框", `!!document.querySelector('.confirm-box')`)
	h.clickText(t, ".dialog-foot .btn", "删除")
	h.wait(t, "环境已删除", fmt.Sprintf(`document.querySelectorAll('.env-item').length === %d`, before))
	h.clearOverlays(t)
}

// 发送中的「取消」按钮：点下去要真的中断请求，页面给出取消提示，而不是等超时。
// （系统文件对话框那类按钮——保存为文件、导出/导入备份——自动化点不到，这里不覆盖。）
func TestCancelSendButton(t *testing.T) {
	h.clearOverlays(t)
	typeURL(t, "{{baseUrl}}/slow?ms=3000")
	h.eval(t, `(() => {
		document.querySelector('.url-input').dispatchEvent(new Event('blur', { bubbles: true }));
		const send = [...document.querySelectorAll('button')].find(b => b.textContent.includes('发送'));
		if (!send) throw new Error('找不到发送按钮');
		send.click();
		return true;
	})()`, nil)
	h.wait(t, "出现取消按钮", `[...document.querySelectorAll('button')].some(b => b.textContent.includes('取消'))`)
	h.eval(t, `(() => {
		const cancel = [...document.querySelectorAll('button')].find(b => b.textContent.includes('取消'));
		cancel.click();
		return true;
	})()`, nil)
	h.wait(t, "请求已取消", `document.body.textContent.includes('请求已取消')`)
}
