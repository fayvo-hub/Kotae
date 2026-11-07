// 极简 DOM 构造与图标。不引入框架，保持零依赖。

type Child = Node | string | number | null | undefined | false;

type Props = {
  class?: string;
  /** 直接写入 dataset。 */
  data?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration> | string;
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void;
  }>;
  attr?: Record<string, string | number | boolean | null | undefined>;
  text?: string | number;
  html?: string;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    if (props.class) node.className = props.class;
    if (props.text !== undefined) node.textContent = String(props.text);
    if (props.html !== undefined) node.innerHTML = props.html;
    if (props.data) {
      for (const [k, v] of Object.entries(props.data)) node.dataset[k] = v;
    }
    if (props.style) {
      if (typeof props.style === "string") node.setAttribute("style", props.style);
      else Object.assign(node.style, props.style);
    }
    if (props.attr) {
      for (const [k, v] of Object.entries(props.attr)) {
        if (v === null || v === undefined || v === false) continue;
        node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    if (props.on) {
      for (const [k, fn] of Object.entries(props.on)) {
        node.addEventListener(k, fn as EventListener);
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
  }
  return node;
}

/** 清空并放入新内容。 */
export function fill(host: HTMLElement, ...children: Child[]): void {
  host.replaceChildren();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    host.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
  }
}

export function qs<T extends HTMLElement = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

// ---- 图标（16px 线性图标，currentColor 描边） ----

function svg(paths: string, viewBox = "0 0 24 24"): string {
  return `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const icons = {
  send: svg('<path d="M4.5 12h15"/><path d="m13 5.5 6.5 6.5-6.5 6.5"/>'),
  save: svg(
    '<path d="M5 4.5h11L19.5 8v11.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z"/><path d="M8 4.5v5h7v-5"/><path d="M8 19.5v-6h8v6"/>',
  ),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.5 4.5"/>'),
  chevron: svg('<path d="m8.5 5 7 7-7 7"/>'),
  chevronDown: svg('<path d="m5 8.5 7 7 7-7"/>'),
  folder: svg('<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18Z"/>'),
  collection: svg(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9h17"/><path d="M8 4.5v15"/>',
  ),
  history: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.8"/>'),
  settings: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 7.9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 14.1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 7.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 3.6V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a2 2 0 1 1 0 4Z"/>',
  ),
  copy: svg(
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15"/>',
  ),
  trash: svg('<path d="M4.5 7h15"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"/>'),
  download: svg('<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>'),
  file: svg('<path d="M6 3.5h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z"/><path d="M13 3.5V9h5"/>'),
  upload: svg('<path d="M12 20V9"/><path d="m7.5 13.5 4.5-4.5 4.5 4.5"/><path d="M4.5 4.5h15"/>'),
  curl: svg('<path d="M4 8.5 7.5 12 4 15.5"/><path d="M11 16h6"/>'),
  code: svg('<path d="m9 8-4 4 4 4"/><path d="m15 8 4 4-4 4"/>'),
  terminal: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7.5 10 2 2-2 2"/><path d="M12.5 14h4"/>'),
  table: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17"/><path d="M3.5 14.5h17"/><path d="M9.5 9.5v10"/>'),
  sliders: svg('<path d="M4 7h9"/><path d="M17 7h3"/><circle cx="15" cy="7" r="2"/><path d="M4 17h3"/><path d="M11 17h9"/><circle cx="9" cy="17" r="2"/>'),
  lock: svg('<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>'),
  cookie: svg('<circle cx="12" cy="12" r="8"/><circle cx="9" cy="9.5" r=".8" fill="currentColor"/><circle cx="14" cy="10" r=".8" fill="currentColor"/><circle cx="10.5" cy="15" r=".8" fill="currentColor"/><circle cx="15" cy="14.5" r=".8" fill="currentColor"/>'),
  command: svg('<path d="M9 6.5a2.5 2.5 0 1 0-2.5 2.5H17a2.5 2.5 0 1 0-2.5-2.5v11A2.5 2.5 0 1 0 17 15H7a2.5 2.5 0 1 0 2.5 2.5Z"/>'),
  sidebar: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>'),
  refresh: svg('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4.5V10h-5.5"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 6.5"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="M3 12h2"/><path d="M19 12h2"/><path d="m5.6 5.6 1.4 1.4"/><path d="m17 17 1.4 1.4"/><path d="m18.4 5.6-1.4 1.4"/><path d="m7 17-1.4 1.4"/>'),
  moon: svg('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>'),
  auto: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M12 4a8 8 0 0 1 0 16" fill="currentColor" stroke="none" opacity=".25"/>'),
  dot: svg('<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>'),
  info: svg('<circle cx="12" cy="12" r="8"/><path d="M12 11v5"/><path d="M12 8.2v.2"/>'),
  warn: svg('<path d="M12 4.5 21 19.5H3Z"/><path d="M12 10v4"/><path d="M12 17v.2"/>'),
  filter: svg('<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>'),
  key: svg('<circle cx="8" cy="15" r="3.5"/><path d="m11 12.5 8-8"/><path d="m16 4.5 3.5 3.5"/><path d="m14 6.5 2 2"/>'),
  globe: svg('<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c2.5 2.4 2.5 13.2 0 16"/><path d="M12 4c-2.5 2.4-2.5 13.2 0 16"/>'),
} as const;

/** 生成图标节点。 */
export function icon(name: keyof typeof icons, cls = ""): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `ic ${cls}`.trim();
  span.innerHTML = icons[name];
  return span;
}

/** 把图标塞进已有元素（按钮修复用）。 */
export function setIcon(node: HTMLElement, name: keyof typeof icons): void {
  node.innerHTML = icons[name];
}

/** 复制文本的小按钮，样式统一。 */
export function iconButton(
  name: keyof typeof icons,
  title: string,
  onclick: (ev: MouseEvent) => void,
  cls = "",
): HTMLButtonElement {
  const btn = el("button", {
    class: `icon-btn ${cls}`.trim(),
    attr: { type: "button", title, "aria-label": title },
    on: { click: onclick },
  });
  btn.append(icon(name));
  return btn;
}
