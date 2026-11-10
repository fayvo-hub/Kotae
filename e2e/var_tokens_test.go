//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// 变量高亮层的一帧快照：token 数量、未定义项、镜像与输入框的盒偏差。
type varHighlightReport struct {
	Count   int      `json:"count"`
	Text    []string `json:"text"`
	Missing []string `json:"missing"`
	Mirror  bool     `json:"mirror"`
	Opaque  bool     `json:"opaque"`
	DX      float64  `json:"dx"`
	DY      float64  `json:"dy"`
	DW      float64  `json:"dw"`
	DH      float64  `json:"dh"`
}

// assertVarsHighlighted 断言某个输入框里的 {{变量}} 被拆成了 token，且镜像层与输入框
// 逐像素对齐（高亮错位的唯一机械判据：镜像照抄盒子，两者必须完全重合）。
func assertVarsHighlighted(t *testing.T, inputSelector string, want int, wantMissing string) {
	t.Helper()
	var report varHighlightReport
	h.eval(t, fmt.Sprintf(`(() => {
		const input = document.querySelector(%s);
		// 一行里可能有两个输入框（键与值），镜像紧贴在自己输入框前面。
		const mirror = input.previousElementSibling;
		const tokens = [...mirror.querySelectorAll('.var-token')];
		const a = input.getBoundingClientRect();
		const b = mirror.getBoundingClientRect();
		return {
			count: tokens.length,
			text: tokens.map(v => v.textContent),
			missing: tokens.filter(v => v.classList.contains('missing')).map(v => v.textContent),
			mirror: mirror.classList.contains('on'),
			opaque: input.classList.contains('var-input'),
			dx: Math.abs(a.left - b.left),
			dy: Math.abs(a.top - b.top),
			dw: Math.abs(a.width - b.width),
			dh: Math.abs(a.height - b.height),
		};
	})()`, jsString(inputSelector)), &report)

	if report.Count != want {
		t.Fatalf("%s：变量片段数 %d，期望 %d（实际 %v）", inputSelector, report.Count, want, report.Text)
	}
	if !report.Mirror || !report.Opaque {
		t.Fatalf("%s：没有切到镜像模式（mirror=%v opaque=%v）", inputSelector, report.Mirror, report.Opaque)
	}
	if wantMissing != "" {
		found := false
		for _, name := range report.Missing {
			if name == wantMissing {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s：%s 没有被标成未定义（实际 %v）", inputSelector, wantMissing, report.Missing)
		}
	}
	if report.DX > 1.5 || report.DY > 1.5 || report.DW > 1.5 || report.DH > 1.5 {
		t.Fatalf("%s：镜像与输入框没对齐 dx=%.2f dy=%.2f dw=%.2f dh=%.2f", inputSelector, report.DX, report.DY, report.DW, report.DH)
	}
}

// 变量浮层的一帧快照。
type varTipReport struct {
	On    bool   `json:"on"`
	Name  string `json:"name"`
	Tag   string `json:"tag"`
	Value string `json:"value"`
	Title string `json:"title"`
}

// assertVarTip 把鼠标移到第 index 个变量片段上，断言浮层弹出、变量名与解析值正确。
func assertVarTip(t *testing.T, inputSelector string, index int, wantName, wantTag, wantValue string) {
	t.Helper()
	var report varTipReport
	h.eval(t, fmt.Sprintf(`(() => {
		const input = document.querySelector(%s);
		const token = input.closest('.var-host').querySelectorAll('.var-token')[%d];
		const r = token.getClientRects()[0];
		input.dispatchEvent(new MouseEvent('mousemove', {
			clientX: r.left + 3, clientY: r.top + r.height / 2, bubbles: true,
		}));
		const tip = document.querySelector('.var-tip');
		return {
			on: !!tip && tip.classList.contains('on'),
			name: tip ? tip.querySelector('.var-tip-name').textContent : '',
			tag: tip ? tip.querySelector('.var-tip-tag').textContent : '',
			value: tip ? tip.querySelector('.var-tip-value').textContent : '',
			title: input.getAttribute('title') || '',
		};
	})()`, jsString(inputSelector), index), &report)

	checkVarTip(t, inputSelector, index, report, wantName, wantTag, wantValue)
}

// checkVarTip 是两种控件共用的浮层断言（原生输入框与自建代码框都一样）。
func checkVarTip(t *testing.T, selector string, index int, report varTipReport, wantName, wantTag, wantValue string) {
	t.Helper()
	if !report.On {
		t.Fatalf("%s：悬停第 %d 个变量没有弹出浮层", selector, index)
	}
	if report.Name != wantName {
		t.Fatalf("%s：浮层里的变量名是 %q，期望 %q", selector, report.Name, wantName)
	}
	if report.Tag != wantTag {
		t.Fatalf("%s：浮层的来源标签是 %q，期望 %q", selector, report.Tag, wantTag)
	}
	if !strings.Contains(report.Value, wantValue) {
		t.Fatalf("%s：浮层里的值是 %q，期望包含 %q", selector, report.Value, wantValue)
	}
	if report.Title != "" {
		t.Fatalf("%s：还在用原生 title 提示（%q），应该只走浮层", selector, report.Title)
	}

	// 移开鼠标就收起，浮层不能粘在屏幕上。
	var still bool
	h.eval(t, fmt.Sprintf(`(() => {
		document.querySelector(%s).dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
		const tip = document.querySelector('.var-tip');
		return !!tip && tip.classList.contains('on');
	})()`, jsString(selector)), &still)
	if still {
		t.Fatalf("%s：鼠标移开后浮层没有收起", selector)
	}
}

// assertEditorVarsHighlighted 断言代码框（自建 contenteditable）里的变量着色区间。
// 这里没有镜像层：区间直接挂在真文本上，所以数区间、比对片段文字就够了。
func assertEditorVarsHighlighted(t *testing.T, selector string, want int, wantMissing string) {
	t.Helper()
	var report struct {
		Count   int      `json:"count"`
		Text    []string `json:"text"`
		Missing []string `json:"missing"`
	}
	h.eval(t, fmt.Sprintf(`(() => {
		const area = document.querySelector(%s);
		const collect = (name) => {
			const out = [];
			const group = CSS.highlights.get(name);
			if (!group) return out;
			for (const range of group) if (area.contains(range.startContainer)) out.push(range.toString());
			return out;
		};
		const text = collect('kotae-var').concat(collect('kotae-var-missing'));
		return { count: text.length, text, missing: collect('kotae-var-missing') };
	})()`, jsString(selector)), &report)

	if report.Count != want {
		t.Fatalf("%s：变量着色区间 %d 个，期望 %d（实际 %v）", selector, report.Count, want, report.Text)
	}
	if wantMissing != "" {
		found := false
		for _, name := range report.Missing {
			if name == wantMissing {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s：%s 没有被标成未定义（实际 %v）", selector, wantMissing, report.Missing)
		}
	}
}

// assertEditorVarTip 把鼠标移到代码框里第 index 个变量区间上，断言浮层内容。
func assertEditorVarTip(t *testing.T, selector string, index int, wantName, wantTag, wantValue string) {
	t.Helper()
	var report varTipReport
	h.eval(t, fmt.Sprintf(`(() => {
		const area = document.querySelector(%s);
		const group = CSS.highlights.get('kotae-var');
		const ranges = group ? [...group].filter(r => area.contains(r.startContainer)) : [];
		const range = ranges[%d];
		if (!range) return { on: false, name: '', tag: '', value: '', title: '' };
		const r = range.getBoundingClientRect();
		area.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 3, clientY: r.top + r.height / 2, bubbles: true }));
		const tip = document.querySelector('.var-tip');
		return {
			on: !!tip && tip.classList.contains('on'),
			name: tip ? tip.querySelector('.var-tip-name').textContent : '',
			tag: tip ? tip.querySelector('.var-tip-tag').textContent : '',
			value: tip ? tip.querySelector('.var-tip-value').textContent : '',
			title: area.getAttribute('title') || '',
		};
	})()`, jsString(selector), index), &report)

	checkVarTip(t, selector, index, report, wantName, wantTag, wantValue)
}

// 变量高亮不只出现在地址栏：参数值单元格与请求体正文里同样上色并可悬停看值。
func TestVarHighlightInParamsAndBody(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)

	// 1) 查询参数的值单元格。
	h.click(t, ".kv-foot .link-btn")
	h.wait(t, "出现参数行", `!!document.querySelector('.kv-value')`)
	h.typeInto(t, ".kv-value", "{{baseUrl}}/echo/{{nope}}")
	assertVarsHighlighted(t, ".kv-value", 2, "{{nope}}")
	assertVarTip(t, ".kv-value", 0, "{{baseUrl}}", "环境变量", "http://127.0.0.1:")
	// 键列同样支持变量：一行里两个输入框各画自己的镜像，不能互相串。
	h.typeInto(t, ".kv-key", "{{baseUrl}}")
	assertVarsHighlighted(t, ".kv-key", 1, "")
	h.shot(t, "34-var-highlight-params")

	// 2) 请求体正文（自建代码框：着色区间直接挂在真文本上，没有镜像层）。
	h.clickText(t, ".subtab", "请求体")
	h.wait(t, "请求体面板出现", `!!document.querySelector('.segmented')`)
	h.clickText(t, ".segmented-item", "JSON")
	h.wait(t, "正文编辑框出现", `!!document.querySelector('.code-editor')`)
	h.typeInto(t, ".code-editor", "{\n  \"base\": \"{{baseUrl}}\",\n  \"gone\": \"{{nope}}\"\n}")
	assertEditorVarsHighlighted(t, ".code-editor", 2, "{{nope}}")
	assertEditorVarTip(t, ".code-editor", 0, "{{baseUrl}}", "环境变量", "http://127.0.0.1:")

	h.shot(t, "35-var-highlight-body")

	// 3) 清掉变量后着色区间要跟着消失，不能留在旧字符上。
	h.typeInto(t, ".code-editor", `{"ok": true}`)
	h.wait(t, "变量着色消失", `(() => {
		const group = CSS.highlights.get('kotae-var');
		if (!group) return true;
		const area = document.querySelector('.code-editor');
		for (const range of group) if (area.contains(range.startContainer)) return false;
		return true;
	})()`)
}
