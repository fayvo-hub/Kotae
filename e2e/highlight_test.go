//go:build e2e

package e2e

import (
	"fmt"
	"strings"
	"testing"
)

// 代码框着色的一帧快照：自建编辑器的值、每个着色组的片段数与片段文本。
// 着色走 CSS Custom Highlight API，区间挂在真文本上，所以判据是
// 「听着色的那几段字符正好是这几个词」，不再是镜像层时代的逐像素对齐。
type codeHighlightReport struct {
	Value     string              `json:"value"`
	Empty     string              `json:"empty"`
	Editable  string              `json:"editable"`
	Counts    map[string]int      `json:"counts"`
	Texts     map[string][]string `json:"texts"`
	ScrollTop float64             `json:"scrollTop"`
	// RangeTop 是第一个函数着色区间的屏幕位置（相对代码框上沿）：区间挂在真文本上，
	// 滚动后它要跟着字跑到盒子外面（负值），不会留在固定偏移上。
	RangeTop *float64 `json:"rangeTop"`
}

// readCodeHighlight 只统计挂在这个代码框里的区间，别的框的着色不混进来。
func readCodeHighlight(t *testing.T, areaSelector string) codeHighlightReport {
	t.Helper()
	var report codeHighlightReport
	h.eval(t, fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  if (!area) return null;
  const counts = {}, texts = {};
  let rangeTop = null;
  for (const [name, group] of CSS.highlights) {
    for (const range of group) {
      if (!area.contains(range.startContainer)) continue;
      const key = name.replace(/^kotae-/, '');
      counts[key] = (counts[key] || 0) + 1;
      if (!texts[key]) texts[key] = [];
      texts[key].push(range.toString());
      if (key === 'hl-fn' && rangeTop === null) {
        rangeTop = range.getBoundingClientRect().top - area.getBoundingClientRect().top;
      }
    }
  }
  return {
    value: area.value,
    empty: area.dataset.empty || '',
    editable: area.getAttribute('contenteditable') || '',
    counts, texts,
    scrollTop: area.scrollTop,
    rangeTop,
  };
})()`, jsString(areaSelector)), &report)
	return report
}

// hasPiece 判断某一着色组里是否出现过这段文字。
func (r codeHighlightReport) hasPiece(group, piece string) bool {
	for _, text := range r.Texts[group] {
		if strings.Contains(text, piece) {
			return true
		}
	}
	return false
}

// 脚本代码框要有语法着色：注释、字符串、数字、关键字、内置对象、函数调用各成一色，
// 着色落在真文本上，代码框自己是 contenteditable，且不再有镜像层与透明文字。
func TestScriptCodeHighlightTokenizes(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	addRequestStep(t, "pre", "脚本")
	// 源码里刻意放：注释、模板串、单双引号串、数字、关键字、pm/Date 内置对象、
	// 以及一长行——长行会折行，顺带验证折行后着色仍然贴字。
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
	h.wait(t, "关键字着色出现", fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  if (!area) return false;
  const group = CSS.highlights.get('kotae-hl-kw');
  if (!group) return false;
  for (const range of group) if (area.contains(range.startContainer)) return true;
  return false;
})()`, jsString(sel)))

	report := readCodeHighlight(t, sel)
	if report.Editable != "plaintext-only" {
		t.Fatalf("代码框不是自建的 contenteditable（contenteditable=%q）", report.Editable)
	}
	// 读值必须逐字节还原写入的内容：换行、缩进、模板串都不能被吃或翻倍。
	if report.Value != source {
		t.Fatalf("代码框读回的值与写入的不一致：\n得到 %q\n期望 %q", report.Value, source)
	}
	want := map[string]int{
		"hl-comment": 1,
		"hl-kw":      4, // const ×3、if
		"hl-str":     3, // "secret"、"sign"、"note"
		"hl-num":     1, // 1700000000
		"hl-builtin": 2, // pm ×2
		"hl-fn":      3, // get、now、set
	}
	for group, min := range want {
		if report.Counts[group] < min {
			t.Fatalf("%s 着色片段 %d 个，至少应有 %d 个：%v", group, report.Counts[group], min, report.Counts)
		}
	}
	// 片段文本要真的是那几段字符，说明区间没整体偏移。
	for group, piece := range map[string]string{
		"hl-comment": "算签名",
		"hl-kw":      "if",
		"hl-str":     `"secret"`,
		"hl-builtin": "pm",
		"hl-fn":      "now",
	} {
		if !report.hasPiece(group, piece) {
			t.Fatalf("%s 的着色片段里找不到 %q：%v", group, piece, report.Texts[group])
		}
	}
	// 镜像层与透明文字必须彻底消失：整页里不应再有 .code-mirror / .hl-input。
	var legacy int
	h.eval(t, `document.querySelectorAll('.code-mirror, .code-host, .hl-input, .code-inner').length`, &legacy)
	if legacy != 0 {
		t.Fatalf("还留着镜像层的元素 %d 个", legacy)
	}

	// 两种主题都看一眼：着色用的都是主题令牌，浅色下不能糊成一片。
	h.shot(t, "62-script-highlight-dark")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="light"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="light"]`) {
		t.Fatalf("没能切到浅色主题")
	}
	// 换主题会重建面板：等新代码框重新挂上着色再断言。
	h.wait(t, "浅色主题下着色仍在", fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  if (!area) return false;
  const group = CSS.highlights.get('kotae-hl-comment');
  if (!group) return false;
  for (const range of group) if (area.contains(range.startContainer)) return true;
  return false;
})()`, jsString(sel)))
	light := readCodeHighlight(t, sel)
	if light.Counts["hl-comment"] < 1 || light.Counts["hl-kw"] < 1 {
		t.Fatalf("浅色主题下丢了着色：%v", light.Counts)
	}
	if light.Value != source {
		t.Fatalf("浅色主题下代码框的值变了：%q", light.Value)
	}
	h.shot(t, "63-script-highlight-light")
	for i := 0; i < 3 && !h.exists(t, `html[data-theme="dark"]`); i++ {
		h.click(t, `[data-role="theme"]`)
	}
	if !h.exists(t, `html[data-theme="dark"]`) {
		t.Fatalf("没能切回深色主题（后续用例默认深色）")
	}
}

// 着色区间挂在真文本上：滚动时自然跟着内容走，改字后必须重新算，不能留在旧字符上。
func TestScriptCodeHighlightTracksScrollAndEdits(t *testing.T) {
	h.clearOverlays(t)
	newTab(t)
	addRequestStep(t, "post", "脚本")
	lines := make([]string, 0, 40)
	for i := 1; i <= 40; i++ {
		lines = append(lines, fmt.Sprintf(`pm.environment.set("k%d", "%d");`, i, i))
	}
	fillStepSource(t, 1, strings.Join(lines, "\n"))
	// 输入会触发一轮面板重绘（重绘把代码框换成新节点），等它落定再滚。
	h.settleFrames(t)

	sel := ".step-row:nth-child(1) .script-input"
	h.wait(t, "函数着色出现", fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  if (!area) return false;
  const group = CSS.highlights.get('kotae-hl-fn');
  if (!group) return false;
  for (const range of group) if (area.contains(range.startContainer)) return true;
  return false;
})()`, jsString(sel)))

	// 往下滚，第一个着色区间应该跟着文本跑到盒子上沿之外（区间是 DOM 区间，不是偏移）。
	h.eval(t, fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  area.scrollTop = 60;
  return true;
})()`, jsString(sel)), nil)
	scrolled := readCodeHighlight(t, sel)
	if scrolled.ScrollTop < 30 {
		t.Fatalf("代码框没有真的滚起来：scrollTop=%.0f（内容不足，用例失效）", scrolled.ScrollTop)
	}
	if scrolled.RangeTop == nil {
		t.Fatalf("滚动后找不到函数着色区间")
	}
	if *scrolled.RangeTop >= 0 {
		t.Fatalf("着色区间没跟着内容滚：第一段函数着色落在相对 %.0fpx，应该已经滑出盒子上沿", *scrolled.RangeTop)
	}

	// 在末尾敲一行带关键字的代码：着色要重算，值也要跟着变。
	h.eval(t, fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  document.execCommand('insertText', false, '\nconst added = 1;');
  return area.value;
})()`, jsString(sel)), nil)
	// 断言方式：新出现的 const 必须被着色（旧代码这一行压根不存在）。
	h.wait(t, "新输入的关键字被着色", fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  if (!area || !area.value.includes('const added = 1;')) return false;
  const group = CSS.highlights.get('kotae-hl-kw');
  if (!group) return false;
  for (const range of group) {
    if (area.contains(range.startContainer) && range.toString() === 'const') {
      // 关键字后面紧跟的就是新插入的那行，说明区间没停在旧字符上。
      return area.value.slice(-40).includes('const added = 1;');
    }
  }
  return false;
})()`, jsString(sel)))

	edited := readCodeHighlight(t, sel)
	if !strings.HasSuffix(edited.Value, "\nconst added = 1;") {
		t.Fatalf("插入的代码没进值里：%q", tailOf(edited.Value, 60))
	}
	if edited.Counts["hl-kw"] < 1 {
		t.Fatalf("插入关键字后没有关键字着色：%v", edited.Counts)
	}
	if !edited.hasPiece("hl-kw", "const") {
		t.Fatalf("关键字着色的片段里没有 const：%v", edited.Texts["hl-kw"])
	}
}

func tailOf(text string, n int) string {
	if len(text) <= n {
		return text
	}
	return text[len(text)-n:]
}

// 脚本库浮层里的编辑器走同一套：空源码不挂着色、占位提示可见，填了源码就着色。
func TestScriptLibraryEditorHighlighted(t *testing.T) {
	cleanupScripts(t)
	h.clearOverlays(t)
	openScriptLibrary(t)
	// 新建的脚本源码是空的：这一刻不该有任何着色区间，占位提示要能看见。
	h.click(t, `[data-role="script-new"]`)
	h.wait(t, "新建的脚本被选中", `!!document.querySelector('.script-lib-editor .script-input')`)
	var blank struct {
		Empty    string         `json:"empty"`
		Counts   map[string]int `json:"counts"`
		Editable string         `json:"editable"`
	}
	h.eval(t, `(() => {
		const area = document.querySelector('.script-lib-editor .script-input');
		const counts = {};
		for (const [name, group] of CSS.highlights) {
			for (const range of group) {
				if (!area.contains(range.startContainer)) continue;
				const key = name.replace(/^kotae-/, '');
				counts[key] = (counts[key] || 0) + 1;
			}
		}
		return { empty: area.dataset.empty || '', counts, editable: area.getAttribute('contenteditable') || '' };
	})()`, &blank)
	if blank.Editable != "plaintext-only" {
		t.Fatalf("脚本库代码框不是自建的 contenteditable（contenteditable=%q）", blank.Editable)
	}
	if blank.Empty != "true" {
		t.Fatalf("空源码时没有置空值标记（data-empty=%q），占位提示画不出来", blank.Empty)
	}
	if len(blank.Counts) != 0 {
		t.Fatalf("空源码不该有着色区间：%v", blank.Counts)
	}

	source := "// 读环境变量\nconst base = pm.environment.get(\"baseUrl\");\nif (!base) throw new Error(\"缺 baseUrl\");"
	addLibraryScript(t, "高亮用例", source)

	sel := ".script-lib-editor .script-input"
	h.wait(t, "脚本库编辑器的着色出现", fmt.Sprintf(`(() => {
  const area = document.querySelector(%s);
  if (!area) return false;
  const group = CSS.highlights.get('kotae-hl-builtin');
  if (!group) return false;
  for (const range of group) if (area.contains(range.startContainer)) return true;
  return false;
})()`, jsString(sel)))

	report := readCodeHighlight(t, sel)
	if report.Value != source {
		t.Fatalf("脚本库代码框读回的值与写入的不一致：\n得到 %q\n期望 %q", report.Value, source)
	}
	for _, group := range []string{"hl-comment", "hl-kw", "hl-str", "hl-builtin", "hl-fn"} {
		if report.Counts[group] < 1 {
			t.Fatalf("脚本库编辑器里 %s 没有着色片段：%v", group, report.Counts)
		}
	}
	if !report.hasPiece("hl-kw", "throw") {
		t.Fatalf("脚本库编辑器里 throw 没被当成关键字：%v", report.Texts["hl-kw"])
	}
}
