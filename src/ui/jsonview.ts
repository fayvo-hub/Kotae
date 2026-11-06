// JSON 树与语法高亮。用于响应体美化视图与请求体预览。

import { el } from "./dom";
import { esc } from "../util";

/** 单行最多渲染的子节点数；超出时折叠为「还有 N 项」按钮。 */
const PAGE = 200;

interface NodeContext {
  /** 搜索词，命中节点会高亮并自动展开。 */
  search: string;
}

/** 把任意 JSON 值渲染成可折叠的树。 */
export function jsonTree(value: unknown, ctx: NodeContext = { search: "" }, depth = 0): HTMLElement {
  const root = el("div", { class: "json-tree" });
  root.append(renderValue(value, ctx, depth, undefined));
  return root;
}

function matches(text: string, search: string): boolean {
  if (!search) return false;
  return text.toLowerCase().includes(search.toLowerCase());
}

function renderValue(
  value: unknown,
  ctx: NodeContext,
  depth: number,
  key: string | undefined,
): HTMLElement {
  const primitive = value === null || typeof value !== "object";
  if (primitive) return renderPrimitive(value, ctx, key);

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);

  const childHit = ctx.search ? subtreeMatches(value, ctx.search) : false;
  const open = depth < 2 || ctx.search !== "" ? (ctx.search ? childHit : depth < 2) : false;

  const box = el("div", { class: "json-node" });
  const line = el("div", { class: "json-line" });
  const toggle = el("button", {
    class: "json-toggle",
    attr: { type: "button", "aria-expanded": open ? "true" : "false" },
    on: {
      click: () => {
        const expanded = box.classList.toggle("open");
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
        toggle.textContent = expanded ? "▾" : "▸";
      },
    },
  });
  toggle.textContent = open ? "▾" : "▸";
  box.classList.toggle("open", open);

  line.append(toggle);
  if (key !== undefined) {
    line.append(el("span", { class: "json-key", html: highlight(esc(key), ctx.search) }));
    line.append(el("span", { class: "json-colon", text: ": " }));
  }
  const openBrace = isArray ? "[" : "{";
  const closeBrace = isArray ? "]" : "}";
  line.append(
    el("span", {
      class: "json-punct",
      text: `${openBrace} ${entries.length} ${isArray ? "项" : "个字段"} ${closeBrace}`,
    }),
  );

  const children = el("div", { class: "json-children" });
  const renderRange = (from: number): number => {
    const to = Math.min(entries.length, from + PAGE);
    for (let i = from; i < to; i += 1) {
      const [k, v] = entries[i]!;
      children.append(renderValue(v, ctx, depth + 1, isArray ? k : k));
    }
    return to;
  };
  let next = renderRange(0);
  if (next < entries.length) {
    const more = el("button", {
      class: "json-more",
      attr: { type: "button" },
      text: `还有 ${entries.length - next} 项，点击继续加载`,
      on: {
        click: () => {
          more.remove();
          next = renderRange(next);
          if (next < entries.length) children.append(more);
        },
      },
    });
    children.append(more);
  }

  box.append(line, children);
  return box;
}

function renderPrimitive(value: unknown, ctx: NodeContext, key: string | undefined): HTMLElement {
  const box = el("div", { class: "json-line json-primitive" });
  box.append(el("span", { class: "json-toggle-space" }));
  if (key !== undefined) {
    box.append(el("span", { class: "json-key", html: highlight(esc(key), ctx.search) }));
    box.append(el("span", { class: "json-colon", text: ": " }));
  }
  const tone =
    value === null
      ? "null"
      : typeof value === "string"
        ? "string"
        : typeof value === "number"
          ? "number"
          : typeof value === "boolean"
            ? "boolean"
            : "other";
  let text: string;
  if (value === null) text = "null";
  else if (typeof value === "string") text = JSON.stringify(value);
  else text = String(value);
  box.append(
    el("span", { class: `json-value json-${tone}`, html: highlight(esc(text), ctx.search) }),
  );
  return box;
}

/** 子树里是否有文本命中，用于搜索时自动展开。 */
function subtreeMatches(value: unknown, search: string): boolean {
  if (value === null || typeof value !== "object") {
    return matches(String(value), search);
  }
  if (Array.isArray(value)) return value.some((v) => subtreeMatches(v, search));
  return Object.entries(value as Record<string, unknown>).some(
    ([k, v]) => matches(k, search) || subtreeMatches(v, search),
  );
}

/** 高亮搜索词（输入已转义）。 */
export function highlight(escaped: string, search: string): string {
  if (!search) return escaped;
  const needle = esc(search);
  if (!needle) return escaped;
  const lower = escaped.toLowerCase();
  const target = needle.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(target, i);
    if (idx < 0) {
      out += escaped.slice(i);
      break;
    }
    out += escaped.slice(i, idx);
    out += `<mark>${escaped.slice(idx, idx + needle.length)}</mark>`;
    i = idx + needle.length;
  }
  return out;
}

// ---- 非 JSON 文本的语法高亮 ----

/** 判断文本像不像 JSON。 */
export function looksJson(text: string, contentType: string): boolean {
  if (/json/i.test(contentType)) return true;
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

const HTML_TOKEN = /(<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>)/g;
const XML_TOKEN = /(<\/?[A-Za-z][^>]*>|&[a-z#0-9]+;)/g;

/** 给 HTML/XML 文本上色。 */
export function highlightMarkup(text: string, search: string): string {
  const isHtml = /<([A-Za-z][A-Za-z0-9]*)\b[^>]*>/i.test(text) && /<(html|head|body|div|span|p)\b/i.test(text);
  const re = isHtml ? HTML_TOKEN : XML_TOKEN;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const raw = m[0];
    out += highlight(esc(text.slice(last, idx)), search);
    if (raw.startsWith("<!--")) {
      out += `<span class="tok-comment">${highlight(esc(raw), search)}</span>`;
    } else if (raw.startsWith("&")) {
      out += `<span class="tok-entity">${esc(raw)}</span>`;
    } else {
      out += markupTag(raw, search);
    }
    last = idx + raw.length;
  }
  out += highlight(esc(text.slice(last)), search);
  return out;
}

function markupTag(raw: string, search: string): string {
  const m = /^(<\/?)([A-Za-z][\w:-]*)([\s\S]*?)(\/?>)$/.exec(raw);
  if (!m) return highlight(esc(raw), search);
  const [, open, name, attrs, close] = m;
  const attrHtml = (attrs ?? "").replace(
    /([A-Za-z_:][\w.:-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g,
    (_all, key: string, eq: string, val?: string) => {
      if (!val) return `<span class="tok-attr">${esc(key)}</span>`;
      const quote = val[0] === '"' || val[0] === "'" ? val[0] : "";
      const body = quote ? val.slice(1, -1) : val;
      return `<span class="tok-attr">${esc(key)}</span>${esc(eq)}<span class="tok-str">${quote}${highlight(
        esc(body),
        search,
      )}${quote}</span>`;
    },
  );
  return `<span class="tok-punct">${esc(open ?? "")}</span><span class="tok-tag">${esc(
    name ?? "",
  )}</span>${attrHtml}<span class="tok-punct">${esc(close ?? "")}</span>`;
}

/** 给纯文本上色：只做搜索高亮。 */
export function highlightText(text: string, search: string): string {
  return highlight(esc(text), search);
}
