// 脚本源码的语法高亮：镜像层方案——文本域的文字变透明，颜色由底层镜像画出来。
//
// 和 varTokens.ts 是同一套路子（照抄字体、内边距、边框宽度与滚动偏移，所以逐字符对齐），
// 好处是输入、撤销、选区、输入法与原生 resize 手柄全部还是文本域自己的行为，
// 不引入编辑器组件、不接管 IME，也不用跟着每次敲键重排 DOM 结构之外的东西。
//
// 两条硬约束：
// 1) 着色只能改颜色，不能改字重/字体样式/字距——一旦字宽变了，镜像就会和光标错位。
// 2) 值太长时直接退出高亮：几万字符的脚本每次都重建 span 会让输入卡顿。

import { el } from "./dom";

/** 超过这个长度就不着色，只留原生文本域。 */
const MAX_CHARS = 20000;

interface Piece {
  text: string;
  cls?: string;
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

/** 切成「有色片段 + 无色片段」，无色片段是运算符、空白与括号。 */
function tokenize(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const raw = match[0];
    if (!raw) {
      // 零宽匹配只会来自正则自身写错，直接退出避免死循环。
      TOKEN_RE.lastIndex += 1;
      continue;
    }
    const start = match.index;
    if (start > last) pieces.push({ text: text.slice(last, start) });
    let cls: string | undefined;
    if (match[1]) cls = "hl-comment";
    else if (match[2]) cls = "hl-str";
    else if (match[3]) cls = "hl-num";
    else if (KEYWORDS.has(raw)) cls = "hl-kw";
    else if (BUILTINS.has(raw)) cls = "hl-builtin";
    else if (followedByParen(text, start + raw.length)) cls = "hl-fn";
    pieces.push(cls ? { text: raw, cls } : { text: raw });
    last = start + raw.length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });
  return pieces;
}

/** 标识符后面紧跟 `(` 就当作函数调用着色，`pm.test(`、`JSON.stringify(` 一眼能分开。 */
function followedByParen(text: string, from: number): boolean {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  return text[i] === "(";
}

function fill(inner: HTMLElement, text: string): void {
  const frag = document.createDocumentFragment();
  for (const piece of tokenize(text)) {
    if (!piece.text) continue;
    frag.append(piece.cls ? el("span", { class: piece.cls, text: piece.text }) : document.createTextNode(piece.text));
  }
  inner.replaceChildren(frag);
}

const bound = new WeakSet<HTMLTextAreaElement>();

/**
 * 还在文档里的高亮实例。面板每次重绘都会换掉文本域，所以这里只留连着的那些：
 * 盒子变大变小（拖动 resize 手柄、展开面板、换主题、改窗口尺寸）都要重抄一次几何。
 */
interface Live {
  node: HTMLTextAreaElement;
  sync: () => void;
}

const live = new Set<Live>();

function syncAll(): void {
  for (const item of live) {
    if (!item.node.isConnected) {
      observer.unobserve(item.node);
      live.delete(item);
      continue;
    }
    item.sync();
  }
}

const observer = new ResizeObserver(() => syncAll());

let watchingWindow = false;

/** 给脚本源码文本域接上高亮。重复调用无副作用。 */
export function enableCodeHighlight(area: HTMLTextAreaElement): void {
  if (bound.has(area)) return;
  bound.add(area);
  hook(area, 0);
}

function hook(area: HTMLTextAreaElement, tries: number): void {
  const parent = area.parentElement;
  if (!parent) {
    // 调用方可能先建元素、后插进文档：等这一轮任务结束再试。
    if (tries < 5) queueMicrotask(() => hook(area, tries + 1));
    return;
  }
  // 镜像靠绝对定位覆盖在文本域上，父节点必须是定位上下文。
  parent.classList.add("code-host");

  const inner = el("div", { class: "code-inner" });
  const mirror = el("div", { class: "code-mirror", attr: { "aria-hidden": "true" } }, inner);
  parent.insertBefore(mirror, area);

  const resync = (): void => {
    if (!area.isConnected || !mirror.classList.contains("on")) return;
    const cs = getComputedStyle(area);
    const s = mirror.style;
    s.left = `${area.offsetLeft}px`;
    s.top = `${area.offsetTop}px`;
    s.width = `${area.offsetWidth}px`;
    s.height = `${area.offsetHeight}px`;
    s.fontFamily = cs.fontFamily;
    s.fontSize = cs.fontSize;
    s.fontWeight = cs.fontWeight;
    s.fontStyle = cs.fontStyle;
    s.lineHeight = cs.lineHeight;
    s.letterSpacing = cs.letterSpacing;
    s.textAlign = cs.textAlign;
    s.whiteSpace = cs.whiteSpace;
    s.overflowWrap = cs.overflowWrap;
    s.wordBreak = cs.wordBreak;
    s.setProperty("tab-size", cs.getPropertyValue("tab-size"));
    s.padding = `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
    s.borderWidth = `${cs.borderTopWidth} ${cs.borderRightWidth} ${cs.borderBottomWidth} ${cs.borderLeftWidth}`;
    inner.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
  };

  /** 上一次画过的原文：内容没变就不重建 span，纯滚动/改窗尺寸时只重排几何。 */
  let painted: string | null = null;

  const refresh = (): void => {
    const text = area.value;
    if (text !== painted) {
      painted = text;
      // 空值与超长值退出镜像模式：文本域自己画字，最稳。
      const on = text.length > 0 && text.length <= MAX_CHARS;
      area.classList.toggle("hl-input", on);
      mirror.classList.toggle("on", on);
      if (on) fill(inner, text);
      else inner.replaceChildren();
    }
    resync();
  };

  area.addEventListener("input", refresh);
  area.addEventListener("scroll", resync);
  area.addEventListener("focus", refresh);

  // 用户拖动 resize 手柄、面板展开收起、换主题都会改盒子，交给共享的 ResizeObserver；
  // 窗口尺寸变化再补一道，免得观察回调被节流时高亮停在上一次的位置。
  live.add({ node: area, sync: refresh });
  observer.observe(area);
  if (!watchingWindow) {
    watchingWindow = true;
    window.addEventListener("resize", syncAll);
  }

  refresh();
}
