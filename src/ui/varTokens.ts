// 变量高亮与悬停浮层：所有支持 {{变量}} 的输入框共用这一套。
// 做法是「输入框文字透明 + 底层镜像画出彩色变量」：镜像照抄输入框的字体、内边距、
// 边框宽度与滚动偏移，所以逐字符对齐。只有值里真的出现 {{}} 时才切到镜像模式，
// 没有变量的输入框保持原样渲染，不受字体度量差异影响。

import { el } from "./dom";
import { scope } from "../store";
import { DYNAMIC_VARS, dynamicVar, lookupVar } from "../util";

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

type VarField = HTMLInputElement | HTMLTextAreaElement;

const bound = new WeakSet<VarField>();

/**
 * 已挂上的输入框的「重新对齐」回调。整块面板每次重绘都会换掉输入框，
 * 所以这里只存还连在文档上的那些，靠 isConnected 就地修剪。
 */
const syncers = new Set<{ node: VarField; sync: () => void }>();
let listening = false;

function syncAll(): void {
  for (const item of syncers) {
    if (!item.node.isConnected) {
      syncers.delete(item);
      continue;
    }
    item.sync();
  }
}

/** 给输入框 / 文本域接上变量高亮与悬停提示。重复调用无副作用。 */
export function enableVarHighlight(target: VarField): void {
  if (bound.has(target) || (target instanceof HTMLInputElement && target.type === "password")) return;
  bound.add(target);
  // 调用方常常先建元素、后插进文档：这一刻量不到父节点，等这一轮任务结束再挂。
  // 不用 requestAnimationFrame：窗口被挪到屏幕外时它会被节流到一秒一帧。
  if (hook(target)) return;
  pending.set(target, RETRY_TICKS);
  queueMicrotask(pump);
}

/** 等父节点的输入框，值 = 还能重试多少次。 */
const pending = new Map<VarField, number>();
const RETRY_TICKS = 60;

function pump(): void {
  for (const [node, left] of pending) {
    if (hook(node) || left <= 1) pending.delete(node);
    else pending.set(node, left - 1);
  }
  if (pending.size) setTimeout(pump, 0);
}

/** 真的挂上：父节点必须是定位上下文，镜像才能和输入框同框。 */
function hook(target: VarField): boolean {
  const parent = target.parentElement;
  if (!parent) return false;
  parent.classList.add("var-host");

  const inner = el("div", { class: "var-inner" });
  // 单行输入框靠 flex 做垂直居中，与原生 input 一致；文本域按行从顶部排。
  const single = target instanceof HTMLInputElement;
  const mirror = el("div", { class: `var-mirror${single ? " single" : ""}`, attr: { "aria-hidden": "true" } }, inner);
  parent.insertBefore(mirror, target);

  // 镜像与输入框同框：位置、字体、内边距、边框都照抄计算值，
  // 边框画成透明，这样 padding 起点与输入框的文字起点完全重合。
  const syncBox = (): void => {
    if (!target.isConnected) return;
    const cs = getComputedStyle(target);
    const s = mirror.style;
    s.left = `${target.offsetLeft}px`;
    s.top = `${target.offsetTop}px`;
    s.width = `${target.offsetWidth}px`;
    s.height = `${target.offsetHeight}px`;
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
  };

  const syncScroll = (): void => {
    inner.style.transform = `translate(${-target.scrollLeft}px, ${-target.scrollTop}px)`;
  };

  const sync = (): void => {
    if (!mirror.classList.contains("on")) return;
    syncBox();
    syncScroll();
  };

  const paint = (): void => {
    const tokens = splitTokens(target.value);
    // 没有变量就退出镜像模式：输入框自己画字，最稳。
    target.classList.toggle("var-input", tokens !== null);
    mirror.classList.toggle("on", tokens !== null);
    if (tokens) inner.replaceChildren(...tokens);
    else inner.replaceChildren();
    sync();
    if (!tokens) hideVarTip();
  };

  target.addEventListener("input", paint);
  target.addEventListener("focus", paint);
  target.addEventListener("scroll", () => {
    syncScroll();
    hideVarTip();
  });
  // 联合类型上的 addEventListener 取不到 MouseEvent 重载，显式换成事件监听签名。
  target.addEventListener("mousemove", ((ev: MouseEvent) => {
    // 拖动分栏或窗口改变宽度时镜像宽度会旧，借鼠标移动顺手对齐。
    sync();
    const hit = tokenAt(mirror, ev.clientX, ev.clientY);
    if (!hit) return hideVarTip();
    showVarTip(hit.dataset.varName ?? "", hit.getBoundingClientRect());
  }) as EventListener);
  target.addEventListener("mouseleave", hideVarTip);
  target.addEventListener("blur", hideVarTip);
  target.addEventListener("mousedown", hideVarTip);

  if (!listening) {
    listening = true;
    window.addEventListener("resize", syncAll);
  }

  paint();
  if (mirror.classList.contains("on")) {
    syncers.add({ node: target, sync });
    // 插入文档之前量不到盒子（插入由调用方完成），这一轮任务收尾时再对齐。
    if (!target.isConnected) queueMicrotask(sync);
  }
  return true;
}

export interface VarSpan {
  start: number;
  end: number;
  name: string;
  missing: boolean;
}

/**
 * 扫描文本里的 {{变量}}，给出字符区间与能否解析到值。
 * 镜像层（原生输入框）与自建编辑器都从这里取区间，只有一份解析规则。
 */
export function scanVars(text: string): VarSpan[] {
  if (!text.includes("{{")) return [];
  const vars = variableScope();
  const out: VarSpan[] = [];
  for (const m of text.matchAll(VAR_RE)) {
    const start = m.index ?? 0;
    const name = (m[1] ?? "").trim();
    out.push({ start, end: start + m[0].length, name, missing: vars.value(name) === undefined });
  }
  return out;
}

/** 把值拆成文本节点与变量片段；没有完整的 {{}} 时返回 null 表示不需要高亮。 */
function splitTokens(text: string): Node[] | null {
  if (!text.includes("{{")) return null;
  const out: Node[] = [];
  let last = 0;
  for (const span of scanVars(text)) {
    if (span.start > last) out.push(document.createTextNode(text.slice(last, span.start)));
    out.push(
      el("span", {
        class: `var-token${span.missing ? " missing" : ""}`,
        data: { varName: span.name },
        text: text.slice(span.start, span.end),
      }),
    );
    last = span.end;
  }
  if (out.length === 0) return null;
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** 鼠标点落在哪个变量片段上（按片段的渲染矩形逐个判定）。 */
function tokenAt(mirror: HTMLElement, x: number, y: number): HTMLElement | null {
  for (const node of mirror.querySelectorAll<HTMLElement>(".var-token")) {
    for (const rect of node.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return node;
    }
  }
  return null;
}

// ---- 悬停浮层 ----

let tip: HTMLElement | null = null;
let tipName = "";

function tipBox(): HTMLElement {
  if (tip?.isConnected) return tip;
  tip = el("div", { class: "var-tip", attr: { role: "tooltip" } });
  document.body.append(tip);
  return tip;
}

export function showVarTip(name: string, anchor: DOMRect): void {
  if (!name) return;
  const vars = variableScope();
  const value = vars.value(name);
  const box = tipBox();
  box.replaceChildren(
    el(
      "div",
      { class: "var-tip-head" },
      el("code", { class: "var-tip-name", text: `{{${name}}}` }),
      el("span", { class: `var-tip-tag${value === undefined ? " missing" : ""}`, text: value === undefined ? "未定义" : vars.source(name) }),
    ),
    el("div", {
      class: `var-tip-value${value === undefined ? " missing" : ""}`,
      text: value ?? "发送时会原样保留，可在环境变量或集合设置里添加同名变量。",
    }),
  );
  if (tipName !== name) {
    tipName = name;
    box.classList.remove("on");
  }
  box.classList.add("on");
  placeTip(box, anchor);
}

/** 浮层贴在变量上方；上方放不下就翻到下方，左右钳在视口内。 */
function placeTip(box: HTMLElement, rect: DOMRect): void {
  const pad = 8;
  const gap = 6;
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  const left = Math.min(Math.max(pad, rect.left), Math.max(pad, window.innerWidth - width - pad));
  const above = rect.top - height - gap;
  const below = rect.bottom + gap;
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(above >= pad ? above : below)}px`;
}

export function hideVarTip(): void {
  tip?.classList.remove("on");
  tipName = "";
}

window.addEventListener("mygo:close-popovers", hideVarTip);
window.addEventListener("scroll", hideVarTip, true);

/** 变量解析：给出值与它来自哪里，供浮层标注。 */
function variableScope(): { value: (name: string) => string | undefined; source: (name: string) => string } {
  const vars = scope();
  const value = (name: string): string | undefined => lookupVar(name, vars) ?? dynamicVar(name);
  const source = (name: string): string => {
    if (vars.env.some((v) => v.enabled && v.key === name)) return "环境变量";
    if (vars.local?.some((v) => v.enabled && v.key === name)) return "集合变量";
    if (vars.globals.some((v) => v.enabled && v.key === name)) return "全局变量";
    return DYNAMIC_VARS.some((d) => d.name === name) ? "动态变量" : "未定义";
  };
  return { value, source };
}
