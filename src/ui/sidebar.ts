// 左侧边栏：集合树、历史列表、搜索、增删改、导入导出入口。

import { el, fill, icon, iconButton, icons } from "./dom";
import {
  activeTab,
  clearHistory,
  copyText,
  createCollection,
  createFolder,
  deleteCollection,
  deleteHistory,
  deleteNode,
  duplicateNode,
  exportBundle,
  importBundle,
  moveTreeNode,
  openHistory,
  openNode,
  openTab,
  persist,
  renameCollection,
  renameNode,
  resolveText,
  state,
  toast,
  toggleFolder,
  toggleSidebar,
  toggleUI,
  type DropMode,
} from "../store";
import { emptyRequest, toCurl } from "../curl";
import { openContextMenu } from "./menu";
import { System } from "../mygo";
import { askConfirm, askText } from "./prompt";
import { formatDuration, formatRelative, methodTone } from "../util";
import type { Collection, FolderNode, HistoryEntry, TreeNode } from "../types";

/** 渲染侧边栏。 */
export function sidebar(): HTMLElement {
  const wrap = el("aside", { class: "sidebar", style: { width: `${state.sidebarWidth}px` } });
  const head = el("div", { class: "sidebar-head" });
  const tabs = el("div", { class: "sidebar-tabs", attr: { role: "tablist" } });
  for (const t of [
    { key: "collections" as const, label: "集合", icon: "collection" as const },
    { key: "history" as const, label: "历史", icon: "history" as const },
  ]) {
    const active = state.sidebarTab === t.key;
    const btn = el("button", {
      class: `sidebar-tab${active ? " active" : ""}`,
      attr: { type: "button", role: "tab", "aria-selected": active ? "true" : "false" },
      on: {
        click: () => {
          state.sidebarTab = t.key;
          // 页签选择会落库（settings.sidebarTab），否则重启后回到「集合」。
          persist();
          window.dispatchEvent(new CustomEvent("mygo:rerender-sidebar"));
        },
      },
    });
    btn.append(icon(t.icon), el("span", { text: t.label }));
    if (t.key === "history" && state.history.length > 0) {
      btn.append(el("span", { class: "sidebar-count", text: String(state.history.length) }));
    }
    tabs.append(btn);
  }

  const collapse = iconButton("sidebar", "收起侧边栏（Ctrl+B）", () => toggleSidebar());
  fill(head, tabs, collapse);

  const search = el("div", { class: "sidebar-search" });
  const input = el("input", {
    class: "search-input",
    attr: { placeholder: state.sidebarTab === "collections" ? "搜索集合与请求" : "搜索历史", spellcheck: "false" },
    on: {
      input: () => {
        if (state.sidebarTab === "collections") state.treeFilter = input.value;
        else state.historyFilter = input.value;
        window.dispatchEvent(new CustomEvent("mygo:rerender-sidebar-body"));
      },
    },
  });
  input.value = state.sidebarTab === "collections" ? state.treeFilter : state.historyFilter;
  search.append(icon("search"), input);

  wrap.append(head, search);
  wrap.append(state.sidebarTab === "collections" ? collectionsBody() : historyBody());
  wrap.append(sidebarFooter());
  return wrap;
}

function sidebarFooter(): HTMLElement {
  const foot = el("div", { class: "sidebar-foot" });
  const add = el("button", {
    class: "btn small",
    attr: { type: "button", title: "新建集合（Ctrl+Shift+N）" },
    on: { click: () => promptNewCollection() },
  });
  add.append(icon("plus"), el("span", { text: "新建集合" }));

  const importBtn = iconButton("upload", "导入工作区备份（JSON）", () => void doImport());
  const exportBtn = iconButton("download", "导出工作区备份（JSON）", () => void doExport());

  fill(foot, add, el("span", { class: "spacer" }), importBtn, exportBtn);
  return foot;
}

async function doExport(): Promise<void> {
  try {
    const saved = await System.saveText("mygo-api-备份.json", exportBundle());
    if (saved) toast(`已导出到 ${saved}`, "success");
  } catch (err) {
    toast(`导出失败：${(err as Error).message}`, "error");
  }
}

async function doImport(): Promise<void> {
  try {
    const file = await System.openText("选择备份文件（JSON）");
    if (!file.path) return;
    const text =
      file.content.startsWith("{") || file.content.startsWith("[")
        ? file.content
        : new TextDecoder().decode(base64ToBytes(file.content));
    const result = importBundle(text);
    toast(`已导入 ${result.collections} 个集合、${result.envs} 个环境`, "success");
  } catch (err) {
    toast(`导入失败：${(err as Error).message}`, "error");
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function collectionsBody(): HTMLElement {
  const body = el("div", { class: "sidebar-body" });
  const filter = state.treeFilter.trim().toLowerCase();

  if (state.collections.length === 0) {
    fill(
      body,
      el(
        "div",
        { class: "sidebar-empty" },
        icon("collection"),
        el("p", { text: "还没有集合" }),
        el("p", {
          class: "muted",
          text: "把常用请求存进集合，下次一键打开。也可以粘贴 cURL 命令快速开始。",
        }),
      ),
    );
    return body;
  }

  for (const col of state.collections) {
    const node = collectionNode(col, filter);
    if (node) body.append(node);
  }
  return body;
}

function collectionNode(col: Collection, filter: string): HTMLElement | null {
  const matched = filter ? collectMatches(col.items, filter) : [];
  if (filter && matched.length === 0 && !col.name.toLowerCase().includes(filter)) return null;

  const box = el("div", { class: "tree-group" });
  const row = el("div", { class: "tree-row folder-row root", data: { kind: "collection" } });
  const twisty = el("span", { class: "twisty", html: icon("chevronDown").innerHTML });
  const label = el("span", { class: "tree-label", text: col.name });
  row.append(twisty, icon("collection", "tree-icon"), label);
  const count = countRequests(col.items);
  row.append(el("span", { class: "tree-count", text: String(count) }));
  row.append(
    ...hoverActions([
      { icon: "plus", title: "在集合里新建请求", run: () => {
        openTab(emptyRequest(), "新请求", { collectionId: col.id, nodeId: "" });
        toast("已新建请求，编辑后按 Ctrl+S 保存到集合", "info");
      } },
      { icon: "folder", title: "新建文件夹", run: () => createFolder(col.id) },
      { icon: "settings", title: "重命名集合", run: () => inlineRename(label, col.name, (name) => renameCollection(col.id, name)) },
      { icon: "trash", title: "删除集合", run: () => {
        void removeCollection(col.id, col.name, count);
      } },
    ]),
  );

  const children = el("div", { class: "tree-children" });
  const items = filter ? filterTree(col.items, filter) : col.items;
  for (const item of items) children.append(treeItem(col.id, item, 1, filter));

  row.setAttribute("draggable", "true");
  row.addEventListener("dragstart", (ev) => {
    dragging = { collectionId: col.id, nodeId: "__collection__" };
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragover", (ev) => {
    if (dragging && dragging.collectionId === col.id) return;
    if (!dragging) return;
    ev.preventDefault();
    clearDropMarks();
    row.classList.add("drop-inside");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-inside"));
  row.addEventListener("drop", (ev) => {
    if (!dragging || dragging.nodeId === "__collection__") return;
    ev.preventDefault();
    const src = dragging;
    dragging = null;
    clearDropMarks();
    const last = col.items[col.items.length - 1];
    if (last) moveTreeNode(src, { collectionId: col.id, nodeId: last.id, mode: "after" });
  });
  row.addEventListener("click", () => {
    if (renaming) return;
    children.classList.toggle("collapsed");
    twisty.classList.toggle("collapsed");
  });
  row.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    inlineRename(label, col.name, (name) => renameCollection(col.id, name));
  });
  row.addEventListener("contextmenu", (ev) =>
    openCollectionMenu(ev, col, label, count),
  );

  box.append(row, children);
  return box;
}

function filterTree(items: TreeNode[], filter: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const item of items) {
    if (item.name.toLowerCase().includes(filter)) {
      out.push(item);
      continue;
    }
    if (item.type === "folder") {
      const kids = filterTree(item.items, filter);
      if (kids.length > 0) out.push({ ...item, open: true, items: kids });
    } else {
      const hay = `${item.request.url} ${item.request.method}`.toLowerCase();
      if (hay.includes(filter)) out.push(item);
    }
  }
  return out;
}

function collectMatches(items: TreeNode[], filter: string): TreeNode[] {
  return filterTree(items, filter);
}

function countRequests(items: TreeNode[]): number {
  let n = 0;
  for (const item of items) {
    if (item.type === "request") n += 1;
    else n += countRequests(item.items);
  }
  return n;
}

// ---- 拖拽排序 ----
// HTML5 拖放：行上半区插到前面、下半区插到后面、文件夹行中段拖进去。
// 用模块级变量记住正在拖的节点，比从 dataTransfer 里反序列化更可靠。

let dragging: { collectionId: string; nodeId: string } | null = null;

function clearDropMarks(): void {
  for (const el of document.querySelectorAll(".drop-before, .drop-after, .drop-inside")) {
    el.classList.remove("drop-before", "drop-after", "drop-inside");
  }
}

/** 落点判定：文件夹行中间 40% 算「放进去」，其余按上下半区算前后。 */
function dropModeOf(row: HTMLElement, isFolder: boolean, ev: DragEvent): DropMode {
  const rect = row.getBoundingClientRect();
  const ratio = (ev.clientY - rect.top) / Math.max(rect.height, 1);
  if (isFolder && ratio > 0.3 && ratio < 0.7) return "inside";
  return ratio < 0.5 ? "before" : "after";
}

function attachDrag(row: HTMLElement, collectionId: string, node: TreeNode): void {
  row.setAttribute("draggable", "true");
  row.addEventListener("dragstart", (ev) => {
    dragging = { collectionId, nodeId: node.id };
    ev.dataTransfer?.setData("text/plain", node.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    dragging = null;
    row.classList.remove("dragging");
    clearDropMarks();
  });
  row.addEventListener("dragover", (ev) => {
    if (!dragging) return;
    // 不能拖到自己身上，也不能把文件夹拖进自己的子树（store 里还会再挡一次）。
    if (dragging.collectionId === collectionId && dragging.nodeId === node.id) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    const mode = dropModeOf(row, node.type === "folder", ev);
    clearDropMarks();
    row.classList.add(`drop-${mode}`);
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-before", "drop-after", "drop-inside");
  });
  row.addEventListener("drop", (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    const mode = dropModeOf(row, node.type === "folder", ev);
    const src = dragging;
    dragging = null;
    clearDropMarks();
    moveTreeNode(src, { collectionId, nodeId: node.id, mode });
  });
}

function hoverActions(actions: { icon: keyof typeof icons; title: string; run: () => void }[]): HTMLElement[] {
  const wrap = el("span", { class: "tree-actions" });
  for (const a of actions) {
    const btn = iconButton(a.icon, a.title, (ev) => {
      ev.stopPropagation();
      a.run();
    }, "mini");
    wrap.append(btn);
  }
  return [wrap];
}

// ---- 就地重命名 ----
// 双击或右键「重命名」后，名字直接在树上变成输入框（Enter 确认、Esc 或空名字取消），
// 比弹对话框顺手，也避免名称改完才发现改错行。

let renaming = false;

function inlineRename(label: HTMLElement, current: string, commit: (name: string) => void): void {
  if (renaming || !label.parentElement) return;
  renaming = true;
  let done = false;
  const input = el("input", {
    class: "tree-rename",
    attr: { type: "text", spellcheck: "false", "aria-label": "名称" },
  });
  input.value = current;

  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(label);
    renaming = false;
    if (save && value && value !== current) commit(value);
  };

  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
  });
  // 点到别处就按确认处理（和资源管理器一致）；文本框抢走的点击不要再冒泡到行上。
  input.addEventListener("blur", () => finish(true));
  for (const type of ["click", "dblclick", "mousedown"] as const) {
    input.addEventListener(type, (ev) => ev.stopPropagation());
  }

  label.replaceWith(input);
  input.focus();
  input.select();
}

function newRequestIn(collectionId: string): void {
  openTab(emptyRequest(), "新请求", { collectionId, nodeId: "" });
  toast("已新建请求，编辑后按 Ctrl+S 保存到集合", "info");
}

function renameFolder(collectionId: string, nodeId: string, name: string): void {
  renameNode(collectionId, nodeId, name);
}

function openCollectionMenu(ev: MouseEvent, col: Collection, label: HTMLElement, count: number): void {
  openContextMenu(ev, [
    { label: "新建请求", run: () => newRequestIn(col.id) },
    { label: "新建文件夹", run: () => createFolder(col.id) },
    {
      label: "重命名",
      hint: "双击",
      run: () => inlineRename(label, col.name, (name) => renameCollection(col.id, name)),
    },
    { label: "删除集合", danger: true, run: () => void removeCollection(col.id, col.name, count) },
  ]);
}

function openFolderMenu(
  ev: MouseEvent,
  collectionId: string,
  folder: FolderNode,
  label: HTMLElement,
): void {
  openContextMenu(ev, [
    { label: "新建请求", run: () => newRequestIn(collectionId) },
    { label: "新建子文件夹", run: () => createFolder(collectionId, folder.id) },
    {
      label: "重命名",
      hint: "双击",
      run: () => inlineRename(label, folder.name, (name) => renameFolder(collectionId, folder.id, name)),
    },
    { label: "复制文件夹", run: () => duplicateNode(collectionId, folder.id) },
    {
      label: "删除文件夹",
      danger: true,
      run: () => void removeFolder(collectionId, folder.id, folder.name),
    },
  ]);
}

function openRequestMenu(
  ev: MouseEvent,
  collectionId: string,
  node: TreeNode,
  label: HTMLElement,
  rename: () => void,
): void {
  openContextMenu(ev, [
    { label: "打开", run: () => openNode(collectionId, node.id) },
    { label: "重命名", hint: "双击", run: rename },
    { label: "复制请求", run: () => duplicateNode(collectionId, node.id) },
    {
      label: "复制为 cURL",
      run: () => {
        if (node.type !== "request") return;
        void copyText(toCurl(node.request, { resolve: resolveText }), "已复制 cURL 命令");
      },
    },
    {
      label: "删除请求",
      danger: true,
      run: () => void removeRequest(collectionId, node.id, node.name),
    },
  ]);
}

function treeItem(collectionId: string, node: TreeNode, depth: number, filter: string): HTMLElement {
  const wrap = el("div", { class: "tree-item" });
  const row = el("div", {
    class: `tree-row${node.type === "folder" ? " folder-row" : ""}`,
    style: { paddingLeft: `${6 + depth * 14}px` },
  });

  if (node.type === "folder") {
    const folder = node as FolderNode;
    const twisty = el("span", { class: `twisty${folder.open ? "" : " collapsed"}`, html: icon("chevron").innerHTML });
    const label = el("span", { class: "tree-label", text: folder.name });
    row.append(twisty, icon("folder", "tree-icon"), label);
    const rename = (): void => inlineRename(label, folder.name, (name) => renameFolder(collectionId, folder.id, name));
    row.append(
      ...hoverActions([
        { icon: "plus", title: "新建请求", run: () => newRequestIn(collectionId) },
        { icon: "folder", title: "新建子文件夹", run: () => createFolder(collectionId, folder.id) },
        { icon: "settings", title: "重命名文件夹", run: rename },
        { icon: "copy", title: "复制文件夹", run: () => duplicateNode(collectionId, folder.id) },
        { icon: "trash", title: "删除文件夹", run: () => {
          void removeFolder(collectionId, folder.id, folder.name);
        } },
      ]),
    );
    const children = el("div", { class: `tree-children${folder.open ? "" : " collapsed"}` });
    for (const child of folder.items) children.append(treeItem(collectionId, child, depth + 1, filter));
    attachDrag(row, collectionId, folder);
    row.addEventListener("click", () => {
      if (renaming) return;
      toggleFolder(collectionId, folder.id);
    });
    row.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      rename();
    });
    row.addEventListener("contextmenu", (ev) => openFolderMenu(ev, collectionId, folder, label));
    wrap.append(row, children);
    return wrap;
  }

  // 请求节点
  const current = activeTab();
  const isOpen = current?.origin?.nodeId === node.id && current.origin.collectionId === collectionId;
  if (isOpen) row.classList.add("active");
  row.dataset.nodeId = node.id;
  row.dataset.collectionId = collectionId;
  const tone = methodTone(node.request.method);
  const label = el("span", { class: "tree-label", text: node.name });
  const rename = (): void => inlineRename(label, node.name, (name) => renameNode(collectionId, node.id, name));
  row.append(
    el("span", { class: "twisty-space" }),
    el("span", { class: `method-tag tone-${tone}`, text: node.request.method }),
    label,
    ...hoverActions([
      { icon: "copy", title: "复制请求", run: () => duplicateNode(collectionId, node.id) },
      { icon: "settings", title: "重命名", run: rename }, 
      { icon: "trash", title: "删除请求", run: () => {
        void removeRequest(collectionId, node.id, node.name);
      } },
    ]),
  );
  attachDrag(row, collectionId, node);
  row.addEventListener("click", () => {
    if (renaming) return;
    openNode(collectionId, node.id);
  });
  row.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    rename();
  });
  row.addEventListener("contextmenu", (ev) => openRequestMenu(ev, collectionId, node, label, rename));
  wrap.append(row);
  return wrap;
}

function historyBody(): HTMLElement {
  const body = el("div", { class: "sidebar-body" });
  const filter = state.historyFilter.trim().toLowerCase();
  const items = filter
    ? state.history.filter(
        (h) => h.url.toLowerCase().includes(filter) || h.method.toLowerCase().includes(filter),
      )
    : state.history;

  if (state.history.length === 0) {
    fill(
      body,
      el(
        "div",
        { class: "sidebar-empty" },
        icon("history"),
        el("p", { text: "还没有请求记录" }),
        el("p", { class: "muted", text: "发送过的请求都会出现在这里，最多保留 200 条。" }),
      ),
    );
    return body;
  }

  const head = el("div", { class: "history-head" });
  head.append(
    el("span", { class: "muted small", text: `共 ${items.length} 条` }),
    el("span", { class: "spacer" }),
    el("button", {
      class: "link-btn",
      attr: { type: "button" },
      text: "清空历史",
      on: {
        click: () => {
          void (async () => {
            const ok = await askConfirm({
              title: "清空历史",
              message: "清空全部请求历史？",
              detail: "只影响历史列表，集合里的请求不受影响。",
              confirmText: "清空",
              danger: true,
            });
            if (ok) clearHistory();
          })();
        },
      },
    }),
  );
  body.append(head);

  if (items.length === 0) {
    body.append(el("div", { class: "sidebar-empty" }, el("p", { class: "muted", text: "没有匹配的记录" })));
    return body;
  }

  for (const h of items) body.append(historyRow(h));
  return body;
}

function historyRow(h: HistoryEntry): HTMLElement {
  const row = el("div", { class: "history-row" });
  const top = el("div", { class: "history-top" });
  top.append(el("span", { class: `method-tag tone-${methodTone(h.method)}`, text: h.method }));
  top.append(el("span", { class: "history-url", text: shortURL(h.url) }));
  const statusTone = h.status === 0 ? "bad" : h.status < 300 ? "ok" : h.status < 400 ? "redirect" : "bad";
  top.append(
    el("span", {
      class: `history-status tone-${statusTone}`,
      text: h.status === 0 ? "失败" : String(h.status),
    }),
  );
  const bottom = el("div", { class: "history-bottom" });
  bottom.append(
    el("span", { text: formatRelative(h.at) }),
    el("span", { class: "dot", text: "·" }),
    el("span", { text: formatDuration(h.durationMs) }),
  );
  bottom.append(el("span", { class: "spacer" }));
  bottom.append(
    iconButton("close", "删除这条记录", (ev) => {
      ev.stopPropagation();
      deleteHistory(h.id);
    }, "mini"),
  );
  top.title = h.url;
  fill(row, top, bottom);
  row.addEventListener("click", () => openHistory(h.id));
  return row;
}

function shortURL(url: string): string {
  const text = url.replace(/^https?:\/\//, "");
  return text.length > 46 ? `${text.slice(0, 44)}…` : text;
}

export function promptNewCollection(): void {
  void (async () => {
    const name = await askText({
      title: "新建集合",
      label: "集合名称",
      value: "我的集合",
      confirmText: "创建",
    });
    if (name) createCollection(name);
  })();
}

async function removeCollection(id: string, name: string, count: number): Promise<void> {
  const ok = await askConfirm({
    title: "删除集合",
    message: `确定删除集合「${name}」？`,
    detail: `其中 ${count} 个请求会一并删除，此操作不可撤销。`,
    confirmText: "删除",
    danger: true,
  });
  if (ok) deleteCollection(id);
}

async function removeRequest(collectionId: string, nodeId: string, name: string): Promise<void> {
  const ok = await askConfirm({
    title: "删除请求",
    message: `确定删除请求「${name}」？`,
    confirmText: "删除",
    danger: true,
  });
  if (ok) deleteNode(collectionId, nodeId);
}

async function removeFolder(collectionId: string, nodeId: string, name: string): Promise<void> {
  const ok = await askConfirm({
    title: "删除文件夹",
    message: `确定删除文件夹「${name}」？`,
    detail: "文件夹里的请求会一并删除。",
    confirmText: "删除",
    danger: true,
  });
  if (ok) deleteNode(collectionId, nodeId);
}

