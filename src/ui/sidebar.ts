// 左侧边栏：集合树、历史列表、搜索、增删改、导入导出入口。

import { el, fill, icon, iconButton, icons } from "./dom";
import {
  activeTab,
  clearHistory,
  createCollection,
  createFolder,
  deleteCollection,
  deleteHistory,
  deleteNode,
  duplicateNode,
  exportBundle,
  importBundle,
  openHistory,
  openNode,
  openTab,
  pasteText,
  renameCollection,
  renameNode,
  setPendingCurl,
  state,
  toast,
  toggleFolder,
  toggleSidebar,
  toggleUI,
} from "../store";
import { CurlError, emptyRequest, parseCurl } from "../curl";
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
  row.append(twisty, icon("collection", "tree-icon"), el("span", { class: "tree-label", text: col.name }));
  const count = countRequests(col.items);
  row.append(el("span", { class: "tree-count", text: String(count) }));
  row.append(
    ...hoverActions([
      { icon: "plus", title: "在集合里新建请求", run: () => {
        openTab(emptyRequest(), "新请求", { collectionId: col.id, nodeId: "" });
        toast("已新建请求，编辑后按 Ctrl+S 保存到集合", "info");
      } },
      { icon: "folder", title: "新建文件夹", run: () => createFolder(col.id) },
      { icon: "settings", title: "重命名集合", run: () => {
        void renameCollectionPrompt(col.id, col.name);
      } },
      { icon: "trash", title: "删除集合", run: () => {
        void removeCollection(col.id, col.name, count);
      } },
    ]),
  );

  const children = el("div", { class: "tree-children" });
  const items = filter ? filterTree(col.items, filter) : col.items;
  for (const item of items) children.append(treeItem(col.id, item, 1, filter));

  row.addEventListener("click", () => {
    children.classList.toggle("collapsed");
    twisty.classList.toggle("collapsed");
  });

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

function treeItem(collectionId: string, node: TreeNode, depth: number, filter: string): HTMLElement {
  const wrap = el("div", { class: "tree-item" });
  const row = el("div", {
    class: `tree-row${node.type === "folder" ? " folder-row" : ""}`,
    style: { paddingLeft: `${6 + depth * 14}px` },
  });

  if (node.type === "folder") {
    const folder = node as FolderNode;
    const twisty = el("span", { class: `twisty${folder.open ? "" : " collapsed"}`, html: icon("chevron").innerHTML });
    row.append(twisty, icon("folder", "tree-icon"), el("span", { class: "tree-label", text: folder.name }));
    row.append(
      ...hoverActions([
        { icon: "plus", title: "新建请求", run: () => { openTab(emptyRequest(), "新请求", { collectionId, nodeId: "" }); } },
        { icon: "folder", title: "新建子文件夹", run: () => createFolder(collectionId, folder.id) },
        { icon: "copy", title: "复制文件夹", run: () => duplicateNode(collectionId, folder.id) },
        { icon: "trash", title: "删除文件夹", run: () => {
          void removeFolder(collectionId, folder.id, folder.name);
        } },
      ]),
    );
    const children = el("div", { class: `tree-children${folder.open ? "" : " collapsed"}` });
    for (const child of folder.items) children.append(treeItem(collectionId, child, depth + 1, filter));
    row.addEventListener("click", () => toggleFolder(collectionId, folder.id));
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
  row.append(
    el("span", { class: "twisty-space" }),
    el("span", { class: `method-tag tone-${tone}`, text: node.request.method }),
    el("span", { class: "tree-label", text: node.name }),
    ...hoverActions([
      { icon: "copy", title: "复制请求", run: () => duplicateNode(collectionId, node.id) },
      { icon: "settings", title: "重命名", run: () => {
        void renameRequestPrompt(collectionId, node.id, node.name);
      } },
      { icon: "trash", title: "删除请求", run: () => {
        void removeRequest(collectionId, node.id, node.name);
      } },
    ]),
  );
  row.addEventListener("click", () => openNode(collectionId, node.id));
  row.addEventListener("dblclick", () => {
    void renameRequestPrompt(collectionId, node.id, node.name);
  });
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

async function renameCollectionPrompt(id: string, current: string): Promise<void> {
  const name = await askText({ title: "重命名集合", label: "名称", value: current });
  if (name) renameCollection(id, name);
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

async function renameRequestPrompt(
  collectionId: string,
  nodeId: string,
  current: string,
): Promise<void> {
  const name = await askText({ title: "重命名请求", label: "名称", value: current });
  if (name) renameNode(collectionId, nodeId, name);
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

/** cURL 快捷导入：从剪贴板读取并解析。 */
export async function importCurlFromClipboard(): Promise<void> {
  const text = await pasteText();
  if (!text.trim()) {
    toggleUI("curlOpen", true);
    return;
  }
  try {
    const result = parseCurl(text);
    setPendingCurl({ request: result.request, warnings: result.warnings, source: text });
  } catch (err) {
    if (err instanceof CurlError) {
      toggleUI("curlOpen", true);
      toast(`剪贴板内容解析失败（第 ${err.line} 行）：${err.message}`, "error");
    } else {
      toast(`解析失败：${(err as Error).message}`, "error");
    }
  }
}
