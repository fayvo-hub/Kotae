// 通用右键菜单：标签页和集合树共用一套，点外面、滚动、改窗口大小、Esc 都会收起。

import { el } from "./dom";

export interface MenuEntry {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

let current: HTMLElement | null = null;
/** 菜单打开的时刻，用于放过紧随其后的程序性滚动（见下面的 scroll 监听）。 */
let openedAt = 0;
/** 打开后这段时间内的滚动不收起菜单，约等于两个渲染帧。 */
const SCROLL_GRACE_MS = 48;

export function closeContextMenu(): void {
  current?.remove();
  current = null;
}

/** 打开右键菜单（坐标超出视口时会往里收）。 */
export function openContextMenu(ev: MouseEvent, items: MenuEntry[]): void {
  ev.preventDefault();
  ev.stopPropagation();
  closeContextMenu();
  // 右上角的环境下拉、命令面板等同一时间只留一个浮层。
  window.dispatchEvent(new CustomEvent("mygo:close-popovers"));
  if (items.length === 0) return;

  const menu = el("div", { class: "env-menu ctx-menu", attr: { role: "menu" } });
  for (const spec of items) {
    const btn = el("button", {
      class: `env-menu-item${spec.danger ? " danger" : ""}`,
      attr: { type: "button", role: "menuitem" },
      on: {
        click: () => {
          if (spec.disabled) return;
          closeContextMenu();
          spec.run();
        },
      },
    });
    if (spec.disabled) btn.setAttribute("disabled", "true");
    btn.append(el("span", { class: "env-menu-name", text: spec.label }));
    if (spec.hint) btn.append(el("span", { class: "env-menu-key", text: spec.hint }));
    menu.append(btn);
  }

  // 先用不可见状态量尺寸，再夹到视口内，避免菜单从右边或下边溢出。
  menu.style.visibility = "hidden";
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(ev.clientX, window.innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(ev.clientY, window.innerHeight - box.height - 8))}px`;
  menu.style.visibility = "";
  current = menu;
  openedAt = performance.now();
}

document.addEventListener("click", (ev) => {
  if (!current) return;
  const target = ev.target as Element | null;
  if (target?.closest(".ctx-menu")) return;
  closeContextMenu();
});
document.addEventListener(
  "scroll",
  () => {
    // 菜单刚弹出时，界面自身的程序滚动（标签条把当前页签滚进视野、加行后滚到新行）会在
    // 下一帧冒出来；那不是用户在滚动内容，不该把菜单收掉。人手滚动必然晚于这个窗口。
    if (performance.now() - openedAt < SCROLL_GRACE_MS) return;
    closeContextMenu();
  },
  true,
);
window.addEventListener("resize", () => closeContextMenu());
document.addEventListener(
  "keydown",
  (ev) => {
    if (!current) return;
    if (ev.key !== "Escape") return;
    // Esc 只收起菜单，不要顺带把下面的对话框也关掉。
    ev.stopPropagation();
    ev.preventDefault();
    closeContextMenu();
  },
  true,
);
