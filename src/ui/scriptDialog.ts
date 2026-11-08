// 脚本库浮层：命名脚本的列表 + 单条编辑。
//
// 这里只管「有哪些可复用的脚本」；哪一层、前置还是后置，由引用它的那一行决定。
// 所以一条脚本既能在前置里跑，也能在后置里跑，不用为两个阶段各复制一份。

import { el, fill, iconButton } from "./dom";
import { closeAll, modal } from "./overlays";
import { scriptSourceField } from "./scriptEditor";
import { askConfirm } from "./prompt";
import {
  createLibraryScript,
  deleteLibraryScript,
  libraryScripts,
  updateLibraryScript,
} from "../store";
import type { LibraryScript } from "../types";

let selected: string | null = null;

function current(): LibraryScript | undefined {
  const list = libraryScripts();
  const hit = list.find((entry) => entry.id === selected);
  if (hit) return hit;
  const first = list[0];
  selected = first?.id ?? null;
  return first;
}

/** 脚本库浮层：左列表 + 右编辑器。 */
export function scriptsDialog(): HTMLElement {
  const listHost = el("div", { class: "script-lib-list" });
  const editorHost = el("div", { class: "script-lib-editor" });

  const paintList = (): void => {
    const list = libraryScripts();
    if (list.length === 0) {
      fill(listHost, el("div", { class: "pane-empty", text: "脚本库还是空的，点上面的「新建」写一个。" }));
      return;
    }
    fill(
      listHost,
      ...list.map((entry) => {
        const meta = [entry.description.trim() || "无说明", entry.trusted === false ? "未信任" : ""]
          .filter(Boolean)
          .join(" · ");
        const item = el(
          "button",
          {
            class: `script-lib-item${entry.id === selected ? " active" : ""}${entry.trusted === false ? " off" : ""}`,
            attr: { type: "button", title: entry.name, "data-script-id": entry.id },
            on: {
              click: () => {
                selected = entry.id;
                paint();
              },
            },
          },
          el("span", { class: "script-lib-name", text: entry.name }),
          el("span", { class: "script-lib-meta", text: meta }),
        );
        return item;
      }),
    );
  };

  const paintEditor = (): void => {
    const entry = current();
    if (!entry) {
      fill(editorHost, el("div", { class: "pane-empty", text: "左边还没有脚本。" }));
      return;
    }
    const name = el("input", {
      class: "text-input",
      attr: { type: "text", placeholder: "脚本名称", "aria-label": "脚本名称" },
      data: { field: "name" },
      on: { input: () => updateLibraryScript(entry.id, { name: name.value }, true) },
    });
    name.value = entry.name;
    name.addEventListener("change", () => {
      // 名字留空没法在引用处认出来，落库时补一个占位名。
      if (!name.value.trim()) {
        name.value = "未命名脚本";
        updateLibraryScript(entry.id, { name: name.value });
      }
      updateLibraryScript(entry.id, { name: name.value.trim() });
      paintList();
    });

    const description = el("textarea", {
      class: "text-input",
      attr: { rows: "2", placeholder: "说明（可选）：这条脚本干什么、依赖哪些变量", "aria-label": "脚本说明" },
      data: { field: "description" },
      on: { input: () => updateLibraryScript(entry.id, { description: description.value }, true) },
    });
    description.value = entry.description;

    const trusted = entry.trusted === false
      ? el(
          "div",
          { class: "script-untrusted" },
          el("span", { text: "这条脚本来自导入文件，还没被信任，引用它的地方都不会执行。" }),
          el("button", {
            class: "btn primary",
            attr: { type: "button" },
            text: "信任并启用",
            on: {
              click: () => {
                updateLibraryScript(entry.id, { trusted: true });
                paint();
              },
            },
          }),
        )
      : el("span");

    fill(
      editorHost,
      el(
        "div",
        { class: "script-lib-fields" },
        el("label", { class: "field" }, el("span", { class: "field-label", text: "名称" }), name),
        el("label", { class: "field" }, el("span", { class: "field-label", text: "说明" }), description),
      ),
      trusted,
      scriptSourceField({
        source: entry.source,
        phase: "pre",
        label: "脚本内容",
        onInput: (value) => updateLibraryScript(entry.id, { source: value }, true),
      }),
      el("div", {
        class: "pane-hint",
        text: "同一段脚本既能当前置也能当后置，具体在引用它的那一行决定；可用对象见下方说明。",
      }),
    );
  };

  const paint = (): void => {
    paintList();
    paintEditor();
  };

  const addButton = iconButton("plus", "新建脚本", () => {
    selected = createLibraryScript();
    paint();
  });
  const removeButton = iconButton("trash", "删除脚本", () => {
    const entry = current();
    if (!entry) return;
    void askConfirm({
      title: "删除脚本",
      message: `确定删除「${entry.name}」吗？`,
      detail: "引用它的前置 / 后置操作会一起删掉。",
      confirmText: "删除",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      deleteLibraryScript(entry.id);
      selected = null;
      paint();
    });
  });
  addButton.dataset.role = "script-new";
  removeButton.dataset.role = "script-delete";

  const body = el(
    "div",
    { class: "stack" },
    el("p", {
      class: "pane-hint",
      text: "脚本库里的脚本能被任意请求、集合或全局引用：改一处，所有引用处都跟着变。",
    }),
    el(
      "div",
      { class: "script-lib" },
      el(
        "div",
        { class: "script-lib-side" },
        el("div", { class: "tools-row" }, addButton, removeButton, el("span", { class: "spacer" })),
        listHost,
      ),
      editorHost,
    ),
  );

  const footer = el(
    "div",
    { class: "dialog-foot" },
    el("span", { class: "muted small", text: `共 ${libraryScripts().length} 条脚本` }),
    el("span", { class: "spacer" }),
    el("button", {
      class: "btn primary",
      attr: { type: "button" },
      text: "完成",
      on: { click: () => closeAll() },
    }),
  );

  paint();
  const dialog = modal("脚本库", body, footer, 820);
  return dialog;
}
