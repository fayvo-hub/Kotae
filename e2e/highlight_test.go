//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// 脚本源码高亮的一帧快照：着色片段数、镜像与文本域的盒偏差、以及排版高度偏差。
type codeHighlightReport struct {
	Mirror    bool           `json:"mirror"`
	Opaque    bool           `json:"opaque"`
	Same      bool           `json:"same"`
	Text      string         `json:"text"`
	Tokens    map[string]int `json:"tokens"`
	DX        float64        `json:"dx"`
	DY        float64        `json:"dy"`
	DW        float64        `json:"dw"`
	DH        float64        `json:"dh"`
	LineGap   int            `json:"lineGap"`
	Overflow  bool           `json:"overflow"`
	Transform string         `json:"transform"`
	Debug     string         `json:"debug"`
}

// readCodeHighlight 读某个脚本代码框的高亮状态。
// 高亮错位的机械判据和变量高亮一样：镜像照抄盒子，两者必须完全重合；
// 再补一条排版高度比对——字体或折行规则不一致时，换行点就会不同，内容高度立刻拉开。
func readCodeHighlight(t *testing.T, areaSelector string) (report codeHighlightReport, scrollTop float64) {
	t.Helper()
	var scroll struct {
		Top  float64             `json:"top"`
		Area codeHighlightReport `json:"area"`
	}
	h.eval(t, fmt.Sprintf(`(() => {
		const area = document.querySelector(%s);
		const mirror = area.previousElementSibling;
		const inner = mirror.firstElementChild;
		const tokens = {};
		for (const node of inner.querySelectorAll('span[class^="hl-"]')) {
			tokens[node.className] = (tokens[node.className] || 0) + 1;
		}
		const a = area.getBoundingClientRect();
		const b = mirror.getBoundingClientRect();
		const cs = getComputedStyle(area);
		const ms = getComputedStyle(mirror);
		const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
		return {
			top: area.scrollTop,
			area: {
				mirror: mirror.classList.contains('on'),
				opaque: area.classList.contains('hl-input'),
				same: inner.textContent === area.value,
				text: inner.textContent,
				tokens,
				dx: Math.abs(a.left - b.left),
				dy: Math.abs(a.top - b.top),
				dw: Math.abs(a.width - b.width),
				dh: Math.abs(a.height - b.height),
				// 文本域的 scrollHeight 会把最后一行算成半行，直接比像素不可靠：
				// 换成「视觉行数」比对——折行点不一致时行数一定对不上。
				// 内容没溢出时 scrollHeight 被盒子高度钳住，不带信息，这时跳过比对。
				overflow: area.scrollHeight > area.clientHeight + 1,
				lineGap: Math.abs(
					Math.round((area.scrollHeight - pad) / parseFloat(cs.lineHeight)) -
					Math.round(inner.offsetHeight / parseFloat(cs.lineHeight)),
				),
				transform: inner.style.transform,
				debug: JSON.stringify({
					scrollH: area.scrollHeight, innerH: inner.offsetHeight, pad,
					areaLine: cs.lineHeight, mirrorLine: ms.lineHeight,
					areaWhite: cs.whiteSpace, mirrorWhite: ms.whiteSpace,
					areaWrap: cs.overflowWrap, mirrorWrap: ms.overflowWrap,
					areaFont: cs.fontFamily, mirrorFont: ms.fontFamily,
					areaSize: cs.fontSize, mirrorSize: ms.fontSize,
				}),
			},
		};
	})()`, jsString(areaSelector)), &scroll)
	return scroll.Area, scroll.Top
}

// 脚本代码框要有语法着色：注释、字符串、数字、关键字、内置对象、函数调用各成一色，
// 着色层与文本域逐像素对齐，并且不改变文本内容。
func TestScriptCodeHighlightTokenizes(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	addRequestStep(t, "pre", "脚本")
	// 源码里刻意放：注释、模板串、单双引号串、数字、关键字、pm/Date 内置对象、
	// 以及一长行——长行会折行，能顺带验证折行规则与文本域一致。
	source := strings.Join([]string{
		`// 算签名：时间戳 + 密钥`,
		`const secret = pm.environment.get("secret");`,
		`const ts = Date.now();`,
		`if (ts > 1700000000) {`,
		`  pm.environment.set("sign", String(ts) + secret);`,
		`}`,
		`pm.environment.set("note", "0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789");`,
		"const tpl = `值 ${ts}`;",
	}, "\n")
	fillStepSource(t, 1, source)

	sel := ".step-row:nth-child(1) .script-input"
	h.wait(t, "高亮镜像层出现", fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  const mirror = area && area.previousElementSibling;
  return !!mirror && mirror.classList.contains('on') && mirror.textContent === area.value;
})()`, jsString(sel)))

	report, _ := readCodeHighlight(t, sel)
	if !report.Mirror || !report.Opaque {
		t.Fatalf("没有切到高亮镜像模式（mirror=%v opaque=%v）", report.Mirror, report.Opaque)
	}
	if !report.Same {
		t.Fatalf("镜像文本与代码框的值不一致：镜像=%q", report.Text)
	}
	want := map[string]int{
		"hl-comment": 1,
		"hl-kw":      4, // const ×2、if、const
		"hl-str":     3, // "secret"、"sign"、"note"
		"hl-num":     1, // 1700000000
		"hl-builtin": 2, // pm、pm（Date 出现 2 次但只断言存在）
		"hl-fn":      3, // get、now、set（set 出现 2 次）
	}
	for cls, min := range want {
		if report.Tokens[cls] < min {
			t.Fatalf("%s 着色片段 %d 个，至少应有 %d 个：%v", cls, report.Tokens[cls], min, report.Tokens)
		}
	}
	if report.Tokens["hl-num"] < 1 {
		t.Fatalf("数字没有被着色：%v", report.Tokens)
	}
	if report.DX > 1 || report.DY > 1 || report.DW > 1 || report.DH > 1 {
		t.Fatalf("镜像与代码框错位：dx=%.1f dy=%.1f dw=%.1f dh=%.1f", report.DX, report.DY, report.DW, report.DH)
	}
	if report.Overflow && report.LineGap != 0 {
		t.Fatalf("镜像渲染的行数与代码框差 %d 行，说明字体或折行规则不一致：%s", report.LineGap, report.Debug)
	}

	// 两种主题都看一眼：着色用的都是主题令牌，浅色下不能糊成一片。
	h.shot(t, "62-script-highlight-dark")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="light"]`) {
		t.Fatalf("没能切到浅色主题")
	}
	// 换主题会重建面板：等新的代码框挂上高亮，再确认盒子仍然对齐。
	h.wait(t, "浅色主题下高亮仍在", fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  const mirror = area && area.previousElementSibling;
  return !!mirror && mirror.classList.contains('on') && mirror.textContent === area.value;
})()`, jsString(sel)))
	light, _ := readCodeHighlight(t, sel)
	if light.DX > 1 || light.DY > 1 || light.DW > 1 || light.DH > 1 {
		t.Fatalf("浅色主题下镜像与代码框错位：dx=%.1f dy=%.1f dw=%.1f dh=%.1f", light.DX, light.DY, light.DW, light.DH)
	}
	if light.Tokens["hl-comment"] < 1 || light.Tokens["hl-kw"] < 1 {
		t.Fatalf("浅色主题下丢了着色：%v", light.Tokens)
	}
	h.shot(t, "63-script-highlight-light")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="dark"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="dark"]`) {
		t.Fatalf("没能切回深色主题（后续用例默认深色）")
	}
}

// 源码滚动时镜像必须跟着走，否则往下翻几屏后的着色会整体错行。
func TestScriptCodeHighlightFollowsScroll(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	addRequestStep(t, "post", "脚本")
	lines := make([]string, 0, 40)
	for i := 1; i <= 40; i++ {
		lines = append(lines, fmt.Sprintf(`pm.environment.set("k%d", "%d");`, i, i))
	}
	fillStepSource(t, 1, strings.Join(lines, "\n"))

	sel := ".step-row:nth-child(1) .script-input"
	h.wait(t, "高亮镜像层出现", fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  return !!area && area.previousElementSibling.classList.contains('on');
})()`, jsString(sel)))

	// 往下滚 3 行左右，再读镜像的位移。
	h.eval(t, fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  area.scrollTop = 60;
  area.dispatchEvent(new Event('scroll'));
  return true;
})()`, jsString(sel)), nil)

	report, top := readCodeHighlight(t, sel)
	if top < 30 {
		t.Fatalf("代码框没有真的滚起来：scrollTop=%.0f（内容不足，用例失效）", top)
	}
	wantTransform := fmt.Sprintf("translate(0px, -%.0fpx)", top)
	if report.Transform != wantTransform {
		t.Fatalf("镜像没跟上滚动：位移 %q，期望 %q", report.Transform, wantTransform)
	}
	if report.DY > 1 || report.DH > 1 {
		t.Fatalf("滚动后镜像与代码框错位：dy=%.1f dh=%.1f", report.DY, report.DH)
	}
	// 40 行必然溢出盒子，这时 scrollHeight 才带信息：行数对得上说明折行点一致。
	if !report.Overflow {
		t.Fatalf("代码框内容没有溢出，行数比对失效（用例需要再加长源码）")
	}
	if report.LineGap != 0 {
		t.Fatalf("镜像渲染的行数与代码框差 %d 行，说明字体或折行规则不一致：%s", report.LineGap, report.Debug)
	}
}

// 脚本库浮层里的编辑器走同一套高亮：空间更窄，盒子对齐与空源码回退都要成立。
func TestScriptLibraryEditorHighlighted(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	openScriptLibrary(t)
	// 新建的脚本源码是空的：这一刻不该有镜像层，占位提示要能看见。
	h.click(t, `[data-role="script-new"]`)
	h.wait(t, "新建的脚本被选中", `!!document.querySelector('.script-lib-editor .script-input')`)
	var off struct {
		Mirror bool `json:"mirror"`
		Opaque bool `json:"opaque"`
	}
	h.eval(t, `(() => {
		const area = document.querySelector('.script-lib-editor .script-input');
		const mirror = area.previousElementSibling;
		return { mirror: mirror.classList.contains('on'), opaque: area.classList.contains('hl-input') };
	})()`, &off)
	if off.Mirror || off.Opaque {
		t.Fatalf("空源码不该切到镜像模式（mirror=%v opaque=%v）", off.Mirror, off.Opaque)
	}

	addLibraryScript(t, "高亮用例", "// 读环境变量\nconst base = pm.environment.get(\"baseUrl\");\nif (!base) throw new Error(\"缺 baseUrl\");")

	sel := ".script-lib-editor .script-input"
	h.wait(t, "脚本库编辑器的高亮层出现", fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  const mirror = area && area.previousElementSibling;
  return !!mirror && mirror.classList.contains('on') && mirror.textContent === area.value;
})()`, jsString(sel)))

	report, _ := readCodeHighlight(t, sel)
	if !report.Same {
		t.Fatalf("镜像文本与代码框的值不一致：镜像=%q", report.Text)
	}
	for _, cls := range []string{"hl-comment", "hl-kw", "hl-str", "hl-builtin", "hl-fn"} {
		if report.Tokens[cls] < 1 {
			t.Fatalf("脚本库编辑器里 %s 没有着色片段：%v", cls, report.Tokens)
		}
	}
	if report.DX > 1 || report.DY > 1 || report.DW > 1 || report.DH > 1 {
		t.Fatalf("脚本库编辑器里镜像与代码框错位：dx=%.1f dy=%.1f dw=%.1f dh=%.1f", report.DX, report.DY, report.DW, report.DH)
	}
	if report.Overflow && report.LineGap != 0 {
		t.Fatalf("脚本库编辑器里镜像与代码框的行数差 %d：%s", report.LineGap, report.Debug)
	}
}
