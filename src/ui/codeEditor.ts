// 自建的等宽代码输入框：contenteditable 承载文本，外观与着色都自己画。
//
// 为什么不再用原生 textarea：原生控件没法把 {{变量}} 与语法着色画在文字本身上，
// 之前的补丁方案是「文字透明 + 镜像层照抄字符位置」，输入法进入组合态时候选字落在
// 透明文字上（看不见），镜像还要跟着字体、折行与滚动逐像素对齐。换成 contenteditable
// 之后文本就是真文本，着色走 CSS Custom Highlight API（只画颜色，不动 DOM），
// 输入、撤销、选区、输入法全部还是浏览器原生行为。
//
// 读写文本自己来：浏览器在多行编辑里既会插字面 \n，也会插 <div>/<br> 块，
// 而 innerText 与 textContent 都会算错换行个数（见 slotsOf 的规则）。

import { el } from "./dom";
import { assistOpen } from "./kvtable";
import { hideVarTip, scanVars, showVarTip } from "./varTokens";
import { jsRanges } from "./codeHighlight";

export interface CodeEditorOptions {
  value: string;
  /** 空值时显示的提示文本，换行按字面渲染。 */
  placeholder?: string;
  /** 无障碍名称，e2e 也用它定位。 */
  label: string;
  /** 追加在基础类名后面的修饰类（如 script-input / curl-input）。 */
  className?: string;
  /** 额外的属性，如 data-phase。 */
  attrs?: Record<string, string>;
  /** 按 {{变量}} 上色并挂悬停浮层。 */
  vars?: boolean;
  /** 按 JavaScript 语法上色（脚本源码框）。 */
  js?: boolean;
  /** 按下 Tab 时插入的缩进；不给就让 Tab 照常跳到下一个控件。 */
  tabIndent?: string;
  onInput: (value: string) => void;
}

export interface CodeEditorElement extends HTMLDivElement {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end?: number): void;
  /** 在光标处插入一段代码（片段栏用），必要时先补一个换行让它独占一行。 */
  insertSnippet(code: string): void;
  /** 光标矩形；补全层靠它贴边。 */
  caretRect(): DOMRect | null;
}

/** 与 style.css 里 `::highlight(kotae-…)` 一一对应，名字只在这里生成。 */
const highlightName = (kind: string): string => `kotae-${kind}`;

/**
 * 光标位置的看守：contenteditable 被聚焦时，浏览器常把光标丢到文字开头（点空白处、
 * Tab 过来、代码里 node.focus() 都会），而原生 textarea 的语义是光标还在原处。
 * 聚焦不一定发 focus 事件（窗口未激活时 Chromium 只改 activeElement），
 * 所以靠 selectionchange 叙事：谁刚接管 activeElement 就通知一下它。
 */
const caretReminders = new WeakMap<HTMLElement, () => void>();
let lastActiveHost: HTMLElement | null = null;
/** 刚接管 activeElement、还没看到「光标落进自己」的那个宿主。 */
let armedHost: HTMLElement | null = null;
document.addEventListener("selectionchange", () => {
  const active = document.activeElement;
  const next = active instanceof HTMLElement ? active : null;
  if (next !== lastActiveHost) armedHost = next;
  lastActiveHost = next;
  if (next) caretReminders.get(next)?.();
});

interface Slot {
  /** 这一段在文本值里的起始偏移。 */
  start: number;
  node: Node;
  kind: "text" | "line-break";
  /** 占几个字符：文本节点是字符数，换行固定 1。 */
  length: number;
}

interface PaintedRange {
  kind: string;
  range: Range;
}

/** 每个编辑器画了哪些区间。整页重绘会换掉编辑器，提交时顺手把断开的清掉。 */
const painted = new Map<HTMLElement, PaintedRange[]>();
/** 上一轮登记过的着色组：这一轮没有的要删掉，否则旧区间会一直画在老位置。 */
let registered = new Set<string>();
let commitPending = false;

/**
 * 汇总注册表要等这一栈跑完再算：工厂里刚建好的编辑器还没插进文档，
 * 此刻就提交会被当成「已断开」清掉，之后再也不会有输入事件来救它。
 */
function scheduleCommit(): void {
  if (commitPending) return;
  commitPending = true;
  queueMicrotask(() => {
    commitPending = false;
    commitHighlights();
  });
}

/**
 * 把各编辑器的区间汇总到 CSS 注册表。每个区间必须绑定在还连着的节点上，
 * 所以整页重绘后旧区间会在这里被清掉，不会报错也不会残留。
 */
function commitHighlights(): void {
  const byKind = new Map<string, Range[]>();
  for (const [host, items] of painted) {
    if (!host.isConnected) {
      painted.delete(host);
      continue;
    }
    for (const item of items) {
      const list = byKind.get(item.kind);
      if (list) list.push(item.range);
      else byKind.set(item.kind, [item.range]);
    }
  }
  const next = new Set<string>();
  for (const [kind, ranges] of byKind) {
    const name = highlightName(kind);
    next.add(name);
    const group = new Highlight();
    for (const range of ranges) group.add(range);
    CSS.highlights.set(name, group);
  }
  for (const name of registered) if (!next.has(name)) CSS.highlights.delete(name);
  registered = next;
}

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE"]);

/**
 * 把 DOM 翻译成「文本 + 每个字符落在哪个节点上」。
 * 规则：文本节点原样计数，`<br>` 与块边界（DIV/P 等）各算一个换行；
 * 浏览器为了显示末尾空行插的填充 `<br>` 不算字符。
 */
function slotsOf(root: HTMLElement): Slot[] {
  const slots: Slot[] = [];
  let at = 0;
  const push = (node: Node, kind: Slot["kind"], length: number): void => {
    slots.push({ start: at, node, kind, length });
    at += length;
  };
  const walk = (parent: Node): void => {
    let index = 0;
    for (const child of Array.from(parent.childNodes)) {
      index += 1;
      if (child.nodeType === Node.TEXT_NODE) {
        const data = (child as Text).data;
        if (data) push(child, "text", data.length);
        continue;
      }
      if (!(child instanceof HTMLElement) || child.classList.contains("code-deco")) continue;
      if (child.tagName === "BR") {
        push(child, "line-break", 1);
        continue;
      }
      // 多行粘贴与浏览器的换行命令会插块元素：块前补一个换行，再走块里的内容。
      if (BLOCK_TAGS.has(child.tagName) && (index > 1 || at > 0)) push(child, "line-break", 1);
      walk(child);
    }
  };
  walk(root);
  const last = slots[slots.length - 1];
  if (last && last.kind === "line-break" && last.node instanceof HTMLBRElement) {
    const text = textOf(slots.slice(0, -1));
    if (text === "" || text.endsWith("\n")) slots.pop();
  }
  return slots;
}

function textOf(slots: Slot[]): string {
  let out = "";
  for (const slot of slots) out += slot.kind === "text" ? (slot.node as Text).data : "\n";
  return out;
}

const readValue = (host: HTMLElement): string => textOf(slotsOf(host));

function childIndex(parent: Node, node: Node): number {
  const list: Node[] = Array.from(parent.childNodes);
  return list.indexOf(node);
}

type Point = { node: Node; offset: number };

function pointBefore(node: Node): Point | null {
  const parent = node.parentNode;
  return parent ? { node: parent, offset: childIndex(parent, node) } : null;
}

function pointAfter(node: Node): Point | null {
  const parent = node.parentNode;
  return parent ? { node: parent, offset: childIndex(parent, node) + 1 } : null;
}

/** 字符偏移 → DOM 位置。换行位置的光标落在换行符之前。 */
function pointOf(slots: Slot[], offset: number): Point | null {
  for (const slot of slots) {
    if (offset >= slot.start + slot.length) continue;
    if (slot.kind === "text") return { node: slot.node, offset: offset - slot.start };
    return pointBefore(slot.node);
  }
  const last = slots[slots.length - 1];
  if (!last) return null;
  if (last.kind === "text") return { node: last.node, offset: (last.node as Text).data.length };
  return pointAfter(last.node);
}

/** 字符区间 → Range；起点终点量不到节点时返回 null（不画这一段）。 */
function rangeOf(slots: Slot[], start: number, end: number): Range | null {
  const from = pointOf(slots, start);
  const to = pointOf(slots, end);
  if (!from || !to) return null;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    // 节点在两次取值之间被浏览器改掉了（极少），这一段就跳过。
    return null;
  }
  return range;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 光标处的字符偏移：借同一个读取器量前缀长度，算法不会和 value 分叉。 */
function offsetIn(host: HTMLElement, node: Node, offset: number): number {
  if (!host.contains(node)) return 0;
  const range = document.createRange();
  try {
    range.setStart(host, 0);
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  const box = document.createElement("div");
  box.append(range.cloneContents());
  return readValue(box).length;
}

function caretOffset(host: HTMLElement, which: "start" | "end"): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  return which === "start"
    ? offsetIn(host, range.startContainer, range.startOffset)
    : offsetIn(host, range.endContainer, range.endOffset);
}

function applySelection(host: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const slots = slotsOf(host);
  if (slots.length === 0) {
    // 空内容（只有一个填充 <br>）只能在宿主节点上摆光标。
    range.setStart(host, 0);
    range.setEnd(host, 0);
  } else {
    const total = textOf(slots).length;
    const from = pointOf(slots, clamp(start, 0, total));
    const to = pointOf(slots, clamp(end, 0, total));
    if (!from || !to) return;
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
    } catch {
      return;
    }
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function writeValue(host: HTMLElement, value: string): void {
  // 字面 \n 文本节点在 pre-wrap 下就是换行，浏览器认可并原样保留；
  // 末尾还要补一个填充 <br>，否则最后一个空行会被吃掉看不见。
  host.replaceChildren(document.createTextNode(value));
  if (value === "" || value.endsWith("\n")) host.append(document.createElement("br"));
}

/** 在当前选区插入文本，走浏览器自己的编辑命令，撤销栈不用我们操心。 */
function typeText(host: HTMLElement, text: string): void {
  host.focus();
  if (document.execCommand("insertText", false, text)) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  host.dispatchEvent(new Event("input", { bubbles: true }));
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="plaintext-only"], [tabindex]:not([tabindex="-1"])';

/** Tab 没被用作缩进时照旧跳到下一个可聚焦控件（原生输入框就是这么做的）。 */
function moveFocus(host: HTMLElement, back: boolean): void {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node === host,
  );
  const at = nodes.indexOf(host);
  if (at < 0) return;
  const target = nodes[at + (back ? -1 : 1)];
  target?.focus();
}

function caretFromPoint(x: number, y: number): Point | null {
  const pos = document.caretPositionFromPoint?.(x, y);
  if (pos) return { node: pos.offsetNode, offset: pos.offset };
  const range = document.caretRangeFromPoint(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

export function codeEditor(opts: CodeEditorOptions): CodeEditorElement {
  const host = el("div", {
    class: ["code-input", "code-editor", opts.className ?? ""].filter(Boolean).join(" "),
    attr: {
      contenteditable: "plaintext-only",
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": opts.label,
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      "data-placeholder": opts.placeholder ?? "",
    },
  }) as CodeEditorElement;
  for (const [key, value] of Object.entries(opts.attrs ?? {})) host.setAttribute(key, value);

  let vars: { start: number; end: number; name: string }[] = [];

  const paint = (): void => {
    const text = readValue(host);
    host.dataset.empty = text.length === 0 ? "true" : "false";
    const slots = slotsOf(host);
    const items: PaintedRange[] = [];
    vars = [];
    if (opts.vars) {
      for (const span of scanVars(text)) {
        vars.push({ start: span.start, end: span.end, name: span.name });
        const range = rangeOf(slots, span.start, span.end);
        if (range) items.push({ kind: span.missing ? "var-missing" : "var", range });
      }
    }
    if (opts.js) {
      for (const piece of jsRanges(text)) {
        const range = rangeOf(slots, piece.start, piece.end);
        if (range) items.push({ kind: piece.kind, range });
      }
    }
    painted.set(host, items);
    scheduleCommit();
  };

  // 光标位置的看守（见文件头的 caretReminders）：记下用户真实停住的位置，
  // 被浏览器抹到开头时放回去，补全与插片段的偏移才不会错位。
  let rememberedCaret = -1;
  let pointerFocus = false;
  host.addEventListener("pointerdown", () => {
    // 真鼠标点进来时浏览器自己把光标放在点到的位置，不要去干扰；
    // 标记在下个宏任务里清掉（聚焦在 pointerdown 的默认动作里完成，来得及看见）。
    pointerFocus = true;
    setTimeout(() => {
      pointerFocus = false;
    }, 0);
  });
  caretReminders.set(host, () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !host.contains(sel.getRangeAt(0).startContainer)) return;
    const total = readValue(host).length;
    const at = caretOffset(host, "start");
    // 刚接管焦点后「光标第一次落进自己」这一刻：若被抹到开头而字又不为空，
    // 当成浏览器丢了位置，放回上次记下的位置（真鼠标点进来的不算，见 pointerFocus）。
    if (armedHost === host) {
      armedHost = null;
      if (at === 0 && total > 0 && !pointerFocus) {
        const to = rememberedCaret > 0 && rememberedCaret <= total ? rememberedCaret : total;
        rememberedCaret = to;
        applySelection(host, to, to);
        return;
      }
    }
    rememberedCaret = at;
  });

  host.addEventListener("input", () => {
    paint();
    opts.onInput(readValue(host));
  });

  host.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Tab" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    // 补全层开着时 Tab 归它选候选词。
    if (assistOpen()) return;
    if (opts.tabIndent) {
      ev.preventDefault();
      typeText(host, opts.tabIndent);
      return;
    }
    // contenteditable 默认把 Tab 当文本插进来，原生输入框是跳焦点，这里保持后者。
    ev.preventDefault();
    moveFocus(host, ev.shiftKey);
  });

  // 粘贴一律按纯文本收下：Windows 剪贴板常带 \r\n，统一成 \n 才不会多出空行。
  host.addEventListener("paste", (ev: ClipboardEvent) => {
    const text = ev.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    ev.preventDefault();
    typeText(host, text.replace(/\r\n?/g, "\n"));
  });

  if (opts.vars) {
    // 真文本没有镜像层，鼠标点反查字符偏移就能判断落在哪个 {{变量}} 里。
    host.addEventListener("mousemove", (ev: MouseEvent) => {
      if (vars.length === 0) return;
      const pos = caretFromPoint(ev.clientX, ev.clientY);
      if (!pos) {
        hideVarTip();
        return;
      }
      const at = offsetIn(host, pos.node, pos.offset);
      const hit = vars.find((item) => at >= item.start && at < item.end);
      if (!hit) {
        hideVarTip();
        return;
      }
      const range = rangeOf(slotsOf(host), hit.start, hit.end);
      const rect = range ? rectAt(range.getClientRects(), ev.clientY) : null;
      if (rect) showVarTip(hit.name, rect);
      else hideVarTip();
    });
    host.addEventListener("mouseleave", hideVarTip);
    host.addEventListener("blur", hideVarTip);
    host.addEventListener("mousedown", hideVarTip);
    host.addEventListener("scroll", hideVarTip);
  }

  Object.defineProperty(host, "value", {
    get: () => readValue(host),
    set: (next: string) => {
      writeValue(host, String(next ?? ""));
      paint();
      // 和原生 textarea 一样：赋值后光标落到末尾（补全层靠它判断插入位置）。
      // 只在选区本来就在自己身上时才动，别处的选区不能被抢走。
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && host.contains(sel.getRangeAt(0).startContainer)) {
        const total = readValue(host).length;
        applySelection(host, total, total);
      }
    },
  });
  // 光标不在自己身上时（例如刚被赋值、还没聚焦），按「末尾」算——
  // 原生 textarea 的 selectionStart 也是这个语义。
  Object.defineProperty(host, "selectionStart", {
    get: () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !host.contains(sel.getRangeAt(0).startContainer)) return readValue(host).length;
      return caretOffset(host, "start");
    },
  });
  Object.defineProperty(host, "selectionEnd", {
    get: () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !host.contains(sel.getRangeAt(0).endContainer)) return readValue(host).length;
      return caretOffset(host, "end");
    },
  });
  Object.defineProperty(host, "setSelectionRange", {
    value: (start: number, end: number = start) => applySelection(host, start, end),
  });
  Object.defineProperty(host, "caretRect", {
    value: (): DOMRect | null => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (!host.contains(range.startContainer)) return null;
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) return rect;
      return host.getBoundingClientRect();
    },
  });
  Object.defineProperty(host, "insertSnippet", {
    value: (code: string) => {
      const value = readValue(host);
      const start = caretOffset(host, "start");
      const end = caretOffset(host, "end");
      const before = value.slice(0, start);
      // 片段要独占行：光标前不是行首就先补一个换行，粘上去的代码不会接在上一行末尾。
      const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      const caret = before.length + prefix.length + code.length;
      writeValue(host, `${before}${prefix}${code}${value.slice(end)}`);
      host.focus();
      applySelection(host, caret, caret);
      paint();
      host.dispatchEvent(new Event("input", { bubbles: true }));
    },
  });

  writeValue(host, opts.value);
  paint();
  return host;
}

/** 在一组矩形里挑鼠标所在的那一行，找不到就用第一个。 */
function rectAt(rects: DOMRectList, y: number): DOMRect | null {
  for (const rect of rects) if (y >= rect.top && y <= rect.bottom) return rect;
  return rects[0] ?? null;
}
