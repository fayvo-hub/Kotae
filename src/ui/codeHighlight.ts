// 脚本源码的语法切分：这里只算「哪一段字符画什么颜色」，怎么画由 codeEditor.ts 决定。
//
// 早先是镜像层方案（文本域文字透明、底层照抄字符位置画着色块），为了逐字符对齐要跟着
// 字体、内边距、折行与滚动偏移逐像素同步，输入法进入组合态时候选字还会画在透明文字上。
// 改成 CSS Custom Highlight API 之后着色直接落在真文本上，这里就只剩切分这件事。
//
// 唯一的约束留在样式里：着色只能改颜色，不能改字重与斜体（Highlight 也只认颜色类属性）。

/** 超过这个长度就不着色：几万字符每次敲键都重算一遍区间会拖慢输入。 */
const MAX_CHARS = 20000;

export type JsKind = "hl-comment" | "hl-str" | "hl-num" | "hl-kw" | "hl-builtin" | "hl-fn";

/** 一段着色的字符区间，`end` 不含。 */
export interface JsRange {
  start: number;
  end: number;
  kind: JsKind;
}

const KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

/** 脚本里高频出现的内置对象与函数：pm 是 Postman 风格的入口，单个着色让人一眼能扫到。 */
const BUILTINS = new Set([
  "pm",
  "console",
  "JSON",
  "Math",
  "Date",
  "Promise",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Error",
  "RegExp",
  "Map",
  "Set",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "parseInt",
  "parseFloat",
  "isNaN",
  "encodeURIComponent",
  "decodeURIComponent",
  "structuredClone",
  "fetch",
]);

// 注释在最前、字符串其次，这样字符串里的 // 与注释里的引号都不会被误切。
const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|(\b0[xXbBoO][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;

/** 标识符后面紧跟 `(` 就当作函数调用着色，`pm.test(`、`JSON.stringify(` 一眼能分开。 */
function followedByParen(text: string, from: number): boolean {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  return text[i] === "(";
}

/** 切出所有要着色的区间；运算符、空白与括号不在其中，保持正文颜色。 */
export function jsRanges(text: string): JsRange[] {
  if (text.length === 0 || text.length > MAX_CHARS) return [];
  const out: JsRange[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const raw = match[0];
    if (!raw) {
      // 零宽匹配只会来自正则自身写错，直接退出避免死循环。
      TOKEN_RE.lastIndex += 1;
      continue;
    }
    let kind: JsKind | undefined;
    if (match[1]) kind = "hl-comment";
    else if (match[2]) kind = "hl-str";
    else if (match[3]) kind = "hl-num";
    else if (KEYWORDS.has(raw)) kind = "hl-kw";
    else if (BUILTINS.has(raw)) kind = "hl-builtin";
    else if (followedByParen(text, match.index + raw.length)) kind = "hl-fn";
    if (kind) out.push({ start: match.index, end: match.index + raw.length, kind });
  }
  return out;
}
