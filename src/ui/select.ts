// 统一下拉框：替换原生 select，样式跟设计系统一致，支持键盘、Esc、点外面收起。
// 协议、方法、重定向这些「几个固定选项」的地方都用它，避免每个地方各写一套。

import { el, icon } from "./dom";

export interface SelectOption {
  value: string;
  label: string;
  /** 选项右侧的浅色说明，可选。 */
  hint?: string;
}

export interface SelectConfig {
  value: string;
  options: SelectOption[];
  onPick: (value: string) => void;
  /** 无障碍与 tooltip 用的名字，如「请求协议」。 */
  label: string;
  /** 根节点额外类名（`proto-sse`、`tone-post` 这类状态类也放这里）。 */
  className?: string;
  disabled?: boolean;
  title?: string;
  /** 菜单最小宽度；默认跟随触发器宽度。 */
  menuWidth?: number;
}

interface OpenMenu {
  root: HTMLElement;
  menu: HTMLElement;
  options: SelectOption[];
  active: number;
  onPick: (value: string) => void;
  trigger: HTMLButtonElement;
}

let open: OpenMenu | null = null;

/** 收起当前展开的下拉框（外面点了、滚动、改窗口大小、按 Esc 都会收起）。 */
export function closeSelect(): void {
  if (!open) return;
  open.menu.remove();
  open.trigger.setAttribute("aria-expanded", "false");
  open.root.classList.remove("open");
  open = null;
}

function position(menu: HTMLElement, trigger: HTMLElement, minWidth: number): void {
  const rect = trigger.getBoundingClientRect();
  menu.style.visibility = "hidden";
  menu.style.minWidth = `${Math.max(minWidth, Math.round(rect.width))}px`;
  const box = menu.getBoundingClientRect();
  // 下面放不下就翻到上面，左右夹在视口里。
  const below = rect.bottom + 4;
  const flip = below + box.height > window.innerHeight - 8 && rect.top - box.height - 4 > 8;
  const top = flip ? rect.top - box.height - 4 : below;
  const left = Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - box.width - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = "";
}

function paintActive(state: OpenMenu): void {
  const nodes = state.menu.querySelectorAll<HTMLElement>(".select-option");
  nodes.forEach((node, i) => {
    node.classList.toggle("active", i === state.active);
    if (i === state.active) node.setAttribute("aria-selected", "true");
    else node.setAttribute("aria-selected", "false");
  });
  nodes[state.active]?.scrollIntoView({ block: "nearest" });
}

/** 建一个下拉框。返回根节点，值变化由调用方重绘（不在组件里改 DOM 结构）。 */
export function selectBox(cfg: SelectConfig): HTMLElement {
  const option = cfg.options.find((item) => item.value === cfg.value) ?? cfg.options[0];
  const root = el("div", {
    class: `select${cfg.className ? ` ${cfg.className}` : ""}${cfg.disabled ? " disabled" : ""}`,
    attr: { "data-value": option?.value ?? "" },
  });

  const valueText = el("span", { class: "select-value", text: option?.label ?? "" });
  const trigger = el("button", {
    class: "select-trigger",
    attr: {
      type: "button",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-label": cfg.label,
      ...(cfg.title ? { title: cfg.title } : {}),
      ...(cfg.disabled ? { disabled: "true" } : {}),
    },
    on: {
      click: () => {
        if (cfg.disabled) return;
        if (open?.root === root) {
          closeSelect();
          return;
        }
        showMenu();
      },
      keydown: (ev) => onKeydown(ev as KeyboardEvent),
    },
  });
  trigger.append(valueText, icon("chevronDown", "select-caret"));
  root.append(trigger);

  function showMenu(): void {
    closeSelect();
    // 顶栏环境下拉、命令面板、右键菜单同一时间只留一个浮层。
    window.dispatchEvent(new CustomEvent("mygo:close-popovers"));
    const menu = el("div", { class: "select-menu", attr: { role: "listbox", "aria-label": cfg.label } });
    const activeIndex = Math.max(0, cfg.options.findIndex((item) => item.value === cfg.value));
    cfg.options.forEach((item, i) => {
      const node = el("button", {
        class: `select-option${i === activeIndex ? " active" : ""}`,
        attr: { type: "button", role: "option", "aria-selected": i === activeIndex ? "true" : "false" },
        on: {
          // 用 mousedown 拦掉焦点转移：否则触发器先 blur，菜单再被收起就点不中。
          mousedown: (ev) => ev.preventDefault(),
          click: () => {
            closeSelect();
            if (item.value !== cfg.value) cfg.onPick(item.value);
          },
        },
      });
      node.append(el("span", { class: "select-label", text: item.label }));
      if (item.hint) node.append(el("span", { class: "select-hint", text: item.hint }));
      if (i === activeIndex) node.append(icon("check", "select-check"));
      menu.append(node);
    });
    document.body.append(menu);
    position(menu, trigger, cfg.menuWidth ?? 0);
    root.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    open = { root, menu, options: cfg.options, active: activeIndex, onPick: cfg.onPick, trigger };
    paintActive(open);
  }

  function pick(state: OpenMenu): void {
    const item = state.options[state.active];
    closeSelect();
    if (item && item.value !== cfg.value) state.onPick(item.value);
    trigger.focus();
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (cfg.disabled) return;
    const state = open?.root === root ? open : null;
    if (ev.key === "Escape") {
      if (!state) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeSelect();
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const step = ev.key === "ArrowUp" ? -1 : 1;
      if (!state) {
        // 关着的时候按方向键：就地展开并挪一格，跟原生下拉的手感一致。
        showMenu();
        if (open && open.root === root) {
          open.active = (open.active + step + open.options.length) % open.options.length;
          paintActive(open);
        }
        return;
      }
      state.active = (state.active + step + state.options.length) % state.options.length;
      paintActive(state);
      return;
    }
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (!state) showMenu();
      else pick(state);
    }
  }

  return root;
}

document.addEventListener("mousedown", (ev) => {
  if (!open) return;
  const target = ev.target as Element | null;
  if (target?.closest(".select-menu") || open.root.contains(target)) return;
  closeSelect();
});
document.addEventListener(
  "scroll",
  (ev) => {
    if (!open) return;
    // 菜单自己往上挪（把选中项滚进可视区）不算「页面滚了」，否则长列表一展开就自己收起。
    const target = ev.target as Node | null;
    if (target && open.menu.contains(target)) return;
    closeSelect();
  },
  true,
);
window.addEventListener("resize", () => closeSelect());
document.addEventListener(
  "keydown",
  (ev) => {
    if (!open || ev.key !== "Escape") return;
    // Esc 只收下拉框，不要顺带把下面的对话框也关掉。
    ev.stopPropagation();
    ev.preventDefault();
    closeSelect();
  },
  true,
);
window.addEventListener("mygo:close-popovers", () => closeSelect());
