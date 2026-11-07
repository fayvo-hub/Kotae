// 应用外壳：顶部栏、标签页、侧边栏 / 主区分栏、响应区分栏、浮层与提示条接线。
// 界面是命令式重建的：任何状态变化都经 emit() 触发一次整屏重绘，
// 重绘时保留输入焦点与各滚动容器的位置，避免边打字边丢光标。

import { System, events } from "./mygo";
import type { ApiRequest, Tab } from "./types";
import { el, fill, icon, iconButton, icons } from "./ui/dom";
import { mountAssist } from "./ui/kvtable";
import { responsePanel } from "./ui/response";
import { requestPanel } from "./ui/request";
import { promptNewCollection, sidebar } from "./ui/sidebar";
import {
  closeAll,
  commandPalette,
  curlDialog,
  envDialog,
  importDialog,
  openSaveDialog,
  saveDialog,
  settingsDialog,
  snippetsDialog,
} from "./ui/overlays";
import { emptyRequest, parseCurl } from "./curl";
import { methodTone } from "./util";
import { closeContextMenu, openContextMenu } from "./ui/menu";
import {
  DEFAULT_RESPONSE_HEIGHT,
  DEFAULT_SIDEBAR_WIDTH,
  abortSend,
  activeTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  copyText,
  createCollection,
  createEnv,
  currentCurl,
  emit,
  errText,
  finishOnboarding,
  load,
  openHistory,
  openNode,
  openTab,
  pasteText,
  persist,
  saveRequestTo,
  send,
  setActiveTab,
  setEnv,
  setImportDraft,
  setPendingCurl,
  setCloseToTray,
  setGlobalShortcutFromShell,
  setTheme,
  state,
  subscribe,
  toast,
  toggleSidebar,
  toggleUI,
} from "./store";

// ---- 外壳骨架（只建一次） ----

const app = document.getElementById("app")!;
const overlayRoot = document.getElementById("overlay-root")!;
const toastRoot = document.getElementById("toast-root")!;

const envHost = el("div", { class: "env-host" });
const sidebarHost = el("div", { class: "sidebar-host" });
const tabstrip = el("div", { class: "tabstrip", attr: { role: "tablist" } });
const requestHost = el("div", { class: "request-host" });
const responseHost = el("div", { class: "response-host" });
const statusbar = el("footer", { class: "statusbar" });

function buildShell(): void {
  const brand = el("div", { class: "brand" });
  brand.append(icon("terminal"), el("span", { class: "brand-name", text: "MyGo API" }));
  brand.append(el("span", { class: "brand-badge", text: "本地" }));

  const actions = el("div", { class: "topbar-actions" });

  const curlBtn = el("button", {
    class: "btn small ghost",
    attr: { type: "button", title: "导入 cURL 命令（Ctrl+I）" },
    on: { click: () => toggleUI("curlOpen", true) },
  });
  curlBtn.dataset.role = "import-curl";
  curlBtn.append(icon("terminal"), el("span", { text: "导入 cURL" }));

  const paletteBtn = iconButton("command", "命令面板（Ctrl+K）", () =>
    toggleUI("commandOpen", true),
  );
  const themeBtn = iconButton(
    state.theme === "dark" ? "moon" : state.theme === "light" ? "sun" : "auto",
    "切换主题（跟随系统 / 浅色 / 深色）",
    () => {
      const order = ["auto", "light", "dark"] as const;
      const next = order[(order.indexOf(state.theme) + 1) % order.length]!;
      setTheme(next);
      setThemeIcon(themeBtn);
    },
  );
  themeBtn.dataset.role = "theme";
  paletteBtn.dataset.role = "palette";
  const settingsBtn = iconButton("settings", "设置", () => toggleUI("settingsOpen", true));
  settingsBtn.dataset.role = "settings";
  const sidebarBtn = iconButton("sidebar", "收起 / 展开侧边栏（Ctrl+B）", () => toggleSidebar());
  sidebarBtn.dataset.role = "sidebar";

  // 环境切换由左上角的环境胶囊负责，这里不再放重复入口。
  actions.append(curlBtn, paletteBtn, themeBtn, settingsBtn, sidebarBtn);

  const topbar = el("header", { class: "topbar" });
  topbar.append(brand, envHost, el("span", { class: "spacer" }), actions);

  const mainCol = el("div", { class: "main-col" });
  const splitV = el("div", { class: "splitter-v", attr: { role: "separator", "aria-label": "调整侧边栏宽度" } });
  const splitH = el("div", { class: "splitter-h", attr: { role: "separator", "aria-label": "调整响应区高度" } });
  mainCol.append(tabstrip, requestHost, splitH, responseHost);

  const workspace = el("div", { class: "workspace" });
  workspace.append(sidebarHost, splitV, mainCol);

  app.append(topbar, workspace, statusbar);

  bindSidebarSplit(splitV);
  bindResponseSplit(splitH);

  // 标签页横向滚轮（元素常驻，只绑一次）
  tabstrip.addEventListener(
    "wheel",
    (ev) => {
      if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
        tabstrip.scrollLeft += ev.deltaY;
        ev.preventDefault();
      }
    },
    { passive: false },
  );

  mountAssist();
}

function setThemeIcon(btn: HTMLButtonElement): void {
  const name = state.theme === "dark" ? "moon" : state.theme === "light" ? "sun" : "auto";
  btn.replaceChildren(icon(name));
}

// ---- 分栏拖拽 ----

function bindSidebarSplit(handle: HTMLElement): void {
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = state.sidebarWidth;
    handle.setPointerCapture(ev.pointerId);
    document.body.classList.add("resizing-col");
    const move = (e: PointerEvent): void => {
      state.sidebarWidth = Math.max(208, Math.min(520, startWidth + (e.clientX - startX)));
      const node = sidebarHost.querySelector<HTMLElement>(".sidebar");
      if (node) node.style.width = `${state.sidebarWidth}px`;
    };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col");
      persist();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  // 双击分隔条复位到默认宽度：拖窄了找不回来时的退路。
  handle.addEventListener("dblclick", () => {
    state.sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
    const node = sidebarHost.querySelector<HTMLElement>(".sidebar");
    if (node) node.style.width = `${state.sidebarWidth}px`;
    persist();
  });
}

function bindResponseSplit(handle: HTMLElement): void {
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const startY = ev.clientY;
    const startHeight = state.responseHeight;
    handle.setPointerCapture(ev.pointerId);
    document.body.classList.add("resizing-row");
    const move = (e: PointerEvent): void => {
      state.responseHeight = Math.max(140, Math.min(window.innerHeight - 260, startHeight - (e.clientY - startY)));
      responseHost.style.height = `${state.responseHeight}px`;
    };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-row");
      persist();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  // 双击复位响应区高度：默认值在 store 里定义，两边不要各写一份。
  handle.addEventListener("dblclick", () => {
    state.responseHeight = DEFAULT_RESPONSE_HEIGHT;
    responseHost.style.height = `${state.responseHeight}px`;
    persist();
  });
}

// ---- 重绘：状态快照与焦点/滚动保持 ----

let frame = 0;

function scheduleRender(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

interface FocusState {
  path: number[];
  start: number;
  end: number;
}

const SCROLL_HOSTS = [
  ".sidebar-body",
  ".code-view",
  ".body-view",
  ".headers-list",
  ".palette-list",
  ".dialog-body",
  ".subtabs-body",
];

function captureFocus(): FocusState | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || active === document.documentElement) return null;
  if (active.closest(".prompt-backdrop")) return null;
  const path: number[] = [];
  let node: HTMLElement | null = active;
  while (node && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) return null;
    path.unshift([...parent.children].indexOf(node));
    node = parent;
  }
  const start =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? (active.selectionStart ?? 0)
      : 0;
  const end =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? (active.selectionEnd ?? start)
      : start;
  return { path, start, end };
}

function restoreFocus(saved: FocusState | null): void {
  if (!saved) return;
  let node: Element | null = document.body;
  for (const index of saved.path) {
    node = node.children[index] ?? null;
    if (!node) return;
  }
  const target = node as HTMLElement;
  if (typeof target.focus !== "function") return;
  target.focus({ preventScroll: true });
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    try {
      const max = target.value.length;
      target.setSelectionRange(Math.min(saved.start, max), Math.min(saved.end, max));
    } catch {
      // 某些 input 类型（number 等）不支持选区，忽略。
    }
  }
}

function captureScroll(): [string, number][] {
  const out: [string, number][] = [];
  for (const sel of SCROLL_HOSTS) {
    const node = document.querySelector<HTMLElement>(sel);
    if (node) out.push([sel, node.scrollTop]);
  }
  return out;
}

function restoreScroll(saved: [string, number][]): void {
  for (const [sel, top] of saved) {
    const node = document.querySelector<HTMLElement>(sel);
    if (node) node.scrollTop = top;
  }
}

// ---- 各区域渲染 ----

function render(): void {
  const focus = captureFocus();
  const scrolls = captureScroll();
  renderEnv();
  renderSidebar();
  renderTabs();
  renderRequest();
  renderResponse();
  renderStatus();
  renderOverlays();
  renderToasts();
  restoreScroll(scrolls);
  restoreFocus(focus);
}

/** 顶栏环境下拉是否展开（只影响外观，不进存储）。 */
let envMenuOpen = false;

function closeEnvMenu(): void {
  if (!envMenuOpen) return;
  envMenuOpen = false;
  renderEnv();
}

function renderEnv(): void {
  const active = state.envs.find((e) => e.id === state.activeEnvId);
  const name = active?.name ?? "无环境";
  document.documentElement.dataset.envName = name;
  const countOf = (env: (typeof state.envs)[number]): number =>
    env.vars.filter((v) => v.enabled && v.key).length;
  const count = active ? countOf(active) : 0;

  const trigger = el("button", {
    class: "env-pill-btn",
    attr: {
      type: "button",
      "aria-haspopup": "listbox",
      "aria-expanded": envMenuOpen ? "true" : "false",
      title: "切换环境（Ctrl+E 编辑变量）",
    },
    on: {
      click: () => {
        envMenuOpen = !envMenuOpen;
        renderEnv();
      },
    },
  });
  trigger.append(
    icon("globe"),
    el("span", { class: "env-pill-name", text: name }),
    el("span", { class: "env-count-badge", text: String(count) }),
    icon("chevronDown", "env-caret"),
  );

  const edit = el("button", {
    class: "env-pill-edit",
    attr: { type: "button", title: "编辑环境变量（Ctrl+E）", "aria-label": "编辑环境变量" },
    on: {
      click: () => {
        envMenuOpen = false;
        toggleUI("envOpen", true);
      },
    },
  });
  edit.append(icon("sliders"));

  const wrap = el("div", { class: `env-pill${envMenuOpen ? " open" : ""}` });
  wrap.append(trigger, el("span", { class: "env-pill-sep" }), edit);
  if (envMenuOpen) wrap.append(envMenu(active?.id, countOf));
  fill(envHost, wrap);
}

/** 环境下拉面板：切换 + 新建 + 进入管理。 */
function envMenu(
  activeId: string | undefined,
  countOf: (env: (typeof state.envs)[number]) => number,
): HTMLElement {
  const menu = el("div", { class: "env-menu", attr: { role: "listbox", "aria-label": "切换环境" } });
  menu.append(el("div", { class: "env-menu-label", text: "切换环境" }));

  for (const env of state.envs) {
    const isActive = env.id === activeId;
    const item = el("button", {
      class: `env-menu-item${isActive ? " active" : ""}`,
      attr: { type: "button", role: "option", "aria-selected": isActive ? "true" : "false" },
      on: {
        click: () => {
          envMenuOpen = false;
          if (!isActive) {
            setEnv(env.id);
            toast(`已切换到环境「${env.name}」`);
          } else {
            renderEnv();
          }
        },
      },
    });
    item.append(
      el("span", { class: "env-menu-dot" }),
      el("span", { class: "env-menu-name", text: env.name }),
      el("span", { class: "env-menu-count", text: String(countOf(env)) }),
    );
    if (isActive) item.append(icon("check", "env-menu-check"));
    menu.append(item);
  }

  menu.append(el("div", { class: "env-menu-sep" }));

  const create = el("button", {
    class: "env-menu-item action",
    attr: { type: "button" },
    on: {
      click: () => {
        envMenuOpen = false;
        createEnv(`环境 ${state.envs.length + 1}`);
        toggleUI("envOpen", true);
      },
    },
  });
  create.append(icon("plus"), el("span", { class: "env-menu-name", text: "新建环境" }));

  const manage = el("button", {
    class: "env-menu-item action",
    attr: { type: "button" },
    on: {
      click: () => {
        envMenuOpen = false;
        toggleUI("envOpen", true);
      },
    },
  });
  manage.append(
    icon("sliders"),
    el("span", { class: "env-menu-name", text: "管理环境变量…" }),
    el("kbd", { class: "env-menu-key", text: "Ctrl+E" }),
  );

  menu.append(create, manage);
  return menu;
}

function renderSidebar(): void {
  sidebarHost.classList.toggle("collapsed", state.sidebarCollapsed);
  if (state.sidebarCollapsed) {
    fill(sidebarHost);
    return;
  }
  fill(sidebarHost, sidebar());
}

function renderTabs(): void {
  fill(tabstrip);
  for (const tab of state.tabs) {
    tabstrip.append(tabItem(tab));
  }
  const add = el("button", {
    class: "tab-add",
    attr: { type: "button", title: "新建请求（Ctrl+N）" },
    on: { click: () => openTab(emptyRequest(), "未命名请求") },
  });
  add.append(icon("plus"));
  tabstrip.append(add);
  revealActiveTab();
}

// 标签多到需要横向滚动时，把当前标签滚进视野（右侧给新建按钮留出位置）。
function revealActiveTab(): void {
  const active = tabstrip.querySelector<HTMLElement>(".tab.active");
  if (!active) return;
  const strip = tabstrip.getBoundingClientRect();
  const box = active.getBoundingClientRect();
  const rightInset = 32;
  if (box.left < strip.left) tabstrip.scrollLeft -= strip.left - box.left + 6;
  else if (box.right > strip.right - rightInset) {
    tabstrip.scrollLeft += box.right - (strip.right - rightInset) + 6;
  }
}

function tabItem(tab: Tab): HTMLElement {
  const active = tab.id === state.activeTabId;
  const item = el("div", {
    class: `tab${active ? " active" : ""}`,
    attr: { role: "tab", "aria-selected": active ? "true" : "false", title: tab.name },
    on: {
      mousedown: (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          closeTab(tab.id);
          return;
        }
        if (ev.button === 0) setActiveTab(tab.id);
      },
      auxclick: (ev) => {
        if (ev.button === 1) closeTab(tab.id);
      },
      contextmenu: (ev) => {
        ev.preventDefault();
        openTabContextMenu(ev, tab);
      },
    },
  });
  item.append(
    el("span", {
      class: `method-tag mini tone-${methodTone(tab.request.method)}`,
      text: tab.request.method,
    }),
    el("span", { class: "tab-name", text: tab.name }),
  );
  if (tab.dirty) item.append(el("span", { class: "tab-dirty", attr: { title: "有未保存的修改" } }));
  const close = el("button", {
    class: "tab-close",
    attr: { type: "button", "aria-label": "关闭标签页" },
    on: {
      mousedown: (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      },
      click: (ev) => {
        ev.stopPropagation();
        closeTab(tab.id);
      },
    },
  });
  close.append(icon("close"));
  item.append(close);
  return item;
}

/** 标签页右键菜单：刷新（重发当前请求）、关闭、关闭其他、关闭全部。 */
function openTabContextMenu(ev: MouseEvent, tab: Tab): void {
  setActiveTab(tab.id);
  openContextMenu(ev, [
    { label: "刷新", hint: "Ctrl+Enter", run: () => void send() },
    { label: "关闭", hint: "Ctrl+W", run: () => closeTab(tab.id) },
    { label: "关闭其他", run: () => closeOtherTabs(tab.id) },
    { label: "关闭全部", run: () => closeAllTabs(), danger: true },
  ]);
}

function renderRequest(): void {
  const tab = activeTab();
  if (!tab) {
    fill(requestHost, el("div", { class: "pane-empty big-empty" }, el("span", { text: "没有打开的请求" })));
    return;
  }
  fill(requestHost, requestPanel(tab));
}

let lastResponseSig = "";

function renderResponse(): void {
  const tab = activeTab();
  responseHost.style.height = `${state.responseHeight}px`;
  const sig = tab
    ? [
        tab.id,
        tab.sending ? "1" : "0",
        tab.response?.at ?? 0,
        tab.response?.error ?? "",
        tab.responseTab,
        tab.bodyView,
        tab.search,
      ].join("|")
    : "none";
  if (sig === lastResponseSig) return;
  lastResponseSig = sig;
  fill(responseHost, tab ? responsePanel(tab) : el("div", { class: "response-empty" }));
}

function renderStatus(): void {
  const tab = activeTab();
  const env = state.envs.find((e) => e.id === state.activeEnvId);
  const left = el("div", { class: "status-left" });
  left.append(icon("globe"), el("span", { text: env?.name ?? "无环境" }));
  if (tab?.origin) {
    const col = state.collections.find((c) => c.id === tab.origin?.collectionId);
    if (col) {
      left.append(el("span", { class: "status-sep" }));
      left.append(icon("collection"), el("span", { text: col.name }));
    }
  }
  left.append(el("span", { class: "status-sep" }));
  left.append(
    el("span", {
      text: `集合 ${state.collections.length} · 历史 ${state.history.length} · 请求 ${state.tabs.length}`,
    }),
  );

  const right = el("div", { class: "status-right" });
  for (const hint of [
    { key: "Ctrl+Enter", label: "发送" },
    { key: "Ctrl+K", label: "命令" },
    { key: "Ctrl+S", label: "保存" },
    { key: "Ctrl+I", label: "cURL" },
  ]) {
    const item = el("span", { class: "hint" });
    item.append(el("kbd", { text: hint.key }), el("span", { text: hint.label }));
    right.append(item);
  }

  fill(statusbar, left, el("span", { class: "spacer" }), right);
}

// ---- 浮层 ----

let saveOpen = false;
let overlaySig = "";

function overlaySignature(): string {
  return [
    state.onboardingDone ? "on" : "off",
    state.commandOpen,
    state.curlOpen,
    state.importOpen,
    state.envOpen,
    state.settingsOpen,
    state.snippetsOpen,
    saveOpen,
  ].join("|");
}

function renderOverlays(): void {
  const sig = overlaySignature();
  if (sig === overlaySig) return;
  overlaySig = sig;
  fill(overlayRoot);
  // 浮层优先于首次引导页：按快捷键时直接打开对应对话框。
  if (state.commandOpen) {
    overlayRoot.append(commandPalette());
  } else if (state.curlOpen) {
    overlayRoot.append(curlDialog());
  } else if (state.importOpen) {
    overlayRoot.append(importDialog());
  } else if (state.envOpen) {
    overlayRoot.append(envDialog());
  } else if (state.snippetsOpen) {
    overlayRoot.append(snippetsDialog());
  } else if (state.settingsOpen) {
    overlayRoot.append(settingsDialog());
  } else if (saveOpen) {
    overlayRoot.append(saveDialog());
  } else if (!state.onboardingDone) {
    overlayRoot.append(welcomeCard());
  }
}

function rebuildOverlays(): void {
  const focus = captureFocus();
  const scrolls = captureScroll();
  overlaySig = "";
  renderOverlays();
  restoreScroll(scrolls);
  restoreFocus(focus);
}

function renderToasts(): void {
  const seen = new Set(state.toasts.map((t) => t.id));
  for (const node of [...toastRoot.children] as HTMLElement[]) {
    if (!seen.has(node.dataset.id ?? "")) node.remove();
  }
  for (const item of state.toasts) {
    if (toastRoot.querySelector(`[data-id="${item.id}"]`)) continue;
    const node = el("div", { class: `toast tone-${item.kind}`, data: { id: item.id } });
    node.append(icon(item.kind === "error" ? "warn" : item.kind === "success" ? "check" : "info"));
    node.append(el("span", { text: item.text }));
    toastRoot.append(node);
    requestAnimationFrame(() => node.classList.add("in"));
  }
}

// ---- 首次启动引导 ----

function welcomeCard(): HTMLElement {
  const backdrop = el("div", { class: "backdrop welcome-backdrop" });
  const card = el("div", { class: "welcome" });
  card.append(el("div", { class: "welcome-glow" }));

  const head = el("div", { class: "welcome-head" });
  head.append(
    el("span", { class: "welcome-logo", html: icons.terminal }),
    el("h1", { text: "MyGo API" }),
  );
  head.append(
    el("p", {
      class: "welcome-sub",
      text: "纯本地的轻量级 HTTP 调试工具：请求、响应、集合、环境变量全部留在这台机器上。",
    }),
  );

  const actions = el("div", { class: "welcome-actions" });

  const curlCard = el("button", { class: "welcome-action", attr: { type: "button" } });
  curlCard.append(icon("terminal"), el("strong", { text: "粘贴 cURL 开始" }));
  curlCard.append(el("span", { text: "浏览器里复制一条命令，粘上来就能还原成请求。" }));
  curlCard.addEventListener("click", () => {
    finishOnboarding();
    state.curlOpen = true;
    state.settingsOpen = false;
    state.envOpen = false;
    state.commandOpen = false;
    emit();
    void (async () => {
      const text = await pasteText();
      if (text.trim() && /^\s*curl/i.test(text)) {
        try {
          const parsed = parseCurl(text);
          setPendingCurl({ request: parsed.request, warnings: parsed.warnings, source: text });
        } catch {
          // 解析失败就停在导入面板里让用户手动改。
        }
      }
    })();
  });

  const blankCard = el("button", { class: "welcome-action", attr: { type: "button" } });
  blankCard.append(icon("plus"), el("strong", { text: "新建空白请求" }));
  blankCard.append(el("span", { text: "从零填地址、参数与请求体，按 Ctrl+Enter 发送。" }));
  blankCard.addEventListener("click", () => {
    finishOnboarding();
    openTab(emptyRequest(), "未命名请求");
    void (async () => {
      // 首次进入给一个能直接跑通的地址，避免开局一片空白。
      toast("提示：地址里可以直接粘贴整条 curl 命令");
    })();
  });

  const exampleCard = el("button", { class: "welcome-action", attr: { type: "button" } });
  exampleCard.append(icon("collection"), el("strong", { text: "载入示例集合" }));
  exampleCard.append(el("span", { text: "内置 4 条示例，点开即可改用。" }));
  exampleCard.addEventListener("click", () => {
    finishOnboarding();
    loadExamples();
  });

  actions.append(curlCard, blankCard, exampleCard);

  const foot = el("div", { class: "welcome-foot" });
  foot.append(
    el("span", {
      class: "muted small",
      text: "数据保存在本机 userData 目录的 workspace.db（SQLite），不会上传到任何服务器。",
    }),
    el("button", {
      class: "btn primary",
      attr: { type: "button" },
      text: "开始使用",
      on: {
        click: () => {
          finishOnboarding();
          emit();
        },
      },
    }),
  );

  card.append(head, actions, foot);
  backdrop.append(card);
  return backdrop;
}

function loadExamples(): void {
  const col = createCollection("示例集合");
  const add = (name: string, request: ApiRequest): void => {
    saveRequestTo(col.id, name, request);
  };

  const get = emptyRequest("https://httpbin.org/get");
  get.params.push({ id: "kv_demo1", key: "q", value: "mygo", enabled: true });
  add("GET 回显查询参数", get);

  const post = emptyRequest("https://httpbin.org/post");
  post.method = "POST";
  post.bodyMode = "json";
  post.body = '{\n  "name": "张三",\n  "ok": true\n}';
  post.headers.push({ id: "kv_demo2", key: "Content-Type", value: "application/json", enabled: true });
  add("POST 发送 JSON", post);

  const uuid = emptyRequest("https://httpbin.org/uuid");
  add("GET 随机 UUID", uuid);

  const gh = emptyRequest("https://api.github.com/repos/egoist/mygo");
  gh.headers.push({
    id: "kv_demo3",
    key: "Accept",
    value: "application/vnd.github+json",
    enabled: true,
  });
  add("GET GitHub 仓库信息", gh);

  toast("已创建「示例集合」，共 4 条请求", "success");
}

// ---- 事件接线 ----

function bindEvents(): void {
  subscribe(scheduleRender);

  window.addEventListener("mygo:rerender-request", scheduleRender);
  window.addEventListener("mygo:rerender-response", scheduleRender);
  window.addEventListener("mygo:rerender-response-body", scheduleRender);
  window.addEventListener("mygo:rerender-sidebar", scheduleRender);
  window.addEventListener("mygo:rerender-sidebar-body", scheduleRender);

  window.addEventListener("mygo:rerender-overlay", () => {
    saveOpen = false;
    rebuildOverlays();
  });
  window.addEventListener("mygo:rerender-settings", rebuildOverlays);
  window.addEventListener("mygo:rerender-env", rebuildOverlays);
  // 环境/全局变量逐字编辑时只刷新顶栏胶囊，不动整块浮层（重建会重播弹入动画）。
  window.addEventListener("mygo:env-pill", renderEnv);

  window.addEventListener("mygo:open-save", () => {
    saveOpen = true;
    state.commandOpen = false;
    state.curlOpen = false;
    state.envOpen = false;
    state.settingsOpen = false;
    rebuildOverlays();
  });
  window.addEventListener("mygo:close-save", () => {
    saveOpen = false;
    rebuildOverlays();
  });

  window.addEventListener("mygo:open-node", (ev) => {
    const detail = (ev as CustomEvent<{ collectionId: string; nodeId: string }>).detail;
    openNode(detail.collectionId, detail.nodeId);
  });
  window.addEventListener("mygo:open-history", (ev) => {
    const id = (ev as CustomEvent<string>).detail;
    openHistory(id);
  });
  window.addEventListener("mygo:copy-curl", () => {
    void copyText(currentCurl(true), "已复制 cURL 命令");
  });
  window.addEventListener("mygo:save", () => {
    openSaveDialog("save");
  });
  window.addEventListener("mygo:send", () => {
    void send();
  });
  window.addEventListener("mygo:toggle-sidebar", () => toggleSidebar());

  window.addEventListener("keydown", onKeydown);

  // 右键菜单/环境下拉/浮层之间互斥：菜单打开时先收起其他浮层。
  window.addEventListener("mygo:close-popovers", () => {
    closeContextMenu();
    closeEnvMenu();
  });

  // 环境下拉与标签页右键菜单点外面就收起来（和系统菜单一致的手感）。
  document.addEventListener("click", (ev) => {
    const target = ev.target as Element | null;
    if (!envMenuOpen) return;
    if (target?.closest(".env-pill")) return;
    closeEnvMenu();
  });
  // 右键菜单收起由 ui/menu.ts 统一处理，这里只管环境下拉。
}

function onKeydown(ev: KeyboardEvent): void {
  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  const target = ev.target as HTMLElement | null;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable === true;

  if (mod && ev.key === "Enter") {
    ev.preventDefault();
    void send();
    return;
  }
  if (!mod) {
    if (ev.key === "Escape") {
      if (envMenuOpen) {
        closeEnvMenu();
        return;
      }
      // 有任何浮层（含首次引导页）时，Esc 先关浮层。
      if (
        state.commandOpen ||
        state.curlOpen ||
        state.importOpen ||
        state.envOpen ||
        state.snippetsOpen ||
        state.settingsOpen ||
        saveOpen ||
        !state.onboardingDone
      ) {
        closeAll();
        // 首次引导页在 Esc 下也作为「关闭」处理。
        if (!state.onboardingDone) finishOnboarding();
        return;
      }
      const tab = activeTab();
      if (tab?.sending) {
        abortSend(tab.id);
        toast("已取消请求");
      }
      return;
    }
    return;
  }

  if (ev.shiftKey) {
    if (key === "c") {
      ev.preventDefault();
      void copyText(currentCurl(true), "已复制 cURL 命令");
      return;
    }
    if (key === "n") {
      ev.preventDefault();
      promptNewCollection();
      return;
    }
    if (key === "g") {
      ev.preventDefault();
      toggleUI("snippetsOpen", true);
      return;
    }
    if (key === "i") {
      ev.preventDefault();
      toggleUI("importOpen", true);
      return;
    }
  }

  switch (key) {
    case "s":
      ev.preventDefault();
      openSaveDialog("save");
      break;
    case "n":
      ev.preventDefault();
      openTab(emptyRequest(), "未命名请求");
      break;
    case "k":
      ev.preventDefault();
      toggleUI("commandOpen", true);
      break;
    case "i":
      ev.preventDefault();
      toggleUI("curlOpen", true);
      break;
    case "e":
      ev.preventDefault();
      toggleUI("envOpen", true);
      break;
    case "b":
      ev.preventDefault();
      toggleSidebar();
      break;
    case "f":
      ev.preventDefault();
      focusBodySearch();
      break;
    case ",":
      ev.preventDefault();
      toggleUI("settingsOpen", true);
      break;
    case "w":
      if (!typing) {
        const tab = activeTab();
        if (tab) {
          ev.preventDefault();
          closeTab(tab.id);
        }
      }
      break;
    default:
      break;
  }
}

function focusBodySearch(): void {
  const tab = activeTab();
  if (!tab) return;
  tab.responseTab = "body";
  scheduleRender();
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('[data-role="body-search"]');
    input?.focus();
    input?.select();
  });
}

// ---- 启动 ----

async function boot(): Promise<void> {
  buildShell();
  bindEvents();
  await load();
  render();
  bindDesktop();
  void System.info()
    .then((info) => {
      document.title = `${info.name} ${info.version}`;
    })
    .catch(() => {});
}

// bindDesktop 接上桌面外壳（菜单、托盘、深链）发来的指令：页面不做菜单，
// 所有入口都复用界面已有的动作，行为只在一处实现。
function bindDesktop(): void {
  events.desktopCommand.on((cmd) => {
    switch (cmd.action) {
      case "new-request":
        openTab(emptyRequest(), "未命名请求");
        break;
      case "import-curl": {
        toggleUI("curlOpen", true);
        if (cmd.text) {
          try {
            const parsed = parseCurl(cmd.text);
            setPendingCurl({ request: parsed.request, warnings: parsed.warnings, source: cmd.text });
          } catch (err) {
            toast(`深链里的 cURL 命令无法解析：${errText(err)}`, "error");
          }
        }
        break;
      }
      case "save":
        openSaveDialog("save");
        break;
      case "close-tab": {
        const tab = activeTab();
        if (tab) closeTab(tab.id);
        break;
      }
      case "toggle-sidebar":
        toggleSidebar();
        break;
      case "command-palette":
        toggleUI("commandOpen", true);
        break;
      case "open-env":
        toggleUI("envOpen", true);
        break;
      case "snippets":
        toggleUI("snippetsOpen", true);
        break;
      case "import-postman":
        // 双击 .har 打开时 Text 里是文件内容，直接解析；从菜单进来则只是打开浮层。
        if (cmd.text) setImportDraft(cmd.text);
        else toggleUI("importOpen", true);
        break;
      case "import-file-too-big":
        toast(`「${cmd.text}」超过 16 MB，请改用「导入 Postman / HAR」手动选文件`, "error");
        break;
      case "import-file-error":
        toast(`打开「${cmd.text}」失败，文件可能已被移动或没有读取权限`, "error");
        break;
      case "open-settings":
        toggleUI("settingsOpen", true);
        break;
      case "toggle-theme": {
        const order = ["auto", "light", "dark"] as const;
        setTheme(order[(order.indexOf(state.theme) + 1) % order.length]!);
        break;
      }
      default:
        break;
    }
  });
  // 用户在托盘菜单里改过桌面偏好后，Go 侧把新值发过来，由页面写库。
  events.desktopPrefs.on((prefs) => {
    setCloseToTray(prefs.closeToTray);
    setGlobalShortcutFromShell(prefs.globalShortcut);
  });
  // 告诉 Go 侧页面已就绪：启动阶段积压的菜单 / 深链指令现在可以发了。
  void System.desktopReady().catch(() => {});
}

void boot();
