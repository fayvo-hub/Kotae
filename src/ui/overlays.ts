// 浮层：cURL 导入确认、保存请求、环境变量、设置、命令面板。

import { databaseFile } from "../db";
import { el, fill, icon, iconButton, icons } from "./dom";
import { kvTable } from "./kvtable";
import {
  activeTab,
  applyPendingCurl,
  copyText,
  createCollection,
  createEnv,
  deleteEnv,
  exportBundle,
  importBundle,
  openTab,
  pasteText,
  renameEnv,
  saveRequestTo,
  saveTab,
  saveTabAs,
  scope,
  setEnv,
  setPendingCurl,
  setTheme,
  state,
  toast,
  toggleUI,
} from "../store";
import { CurlError, emptyRequest, parseCurl } from "../curl";
import { DYNAMIC_VARS, methodTone, visibleVarNames } from "../util";
import type { ApiRequest } from "../types";
import { System } from "../mygo";
import { formatBytes } from "../util";
import { askConfirm, askText } from "./prompt";

// ---- 通用浮层外壳 ----

function modal(title: string, body: HTMLElement, footer?: HTMLElement, width = 560): HTMLElement {
  const backdrop = el("div", {
    class: "backdrop",
    on: {
      mousedown: (ev) => {
        if (ev.target === backdrop) closeAll();
      },
    },
  });
  const dialog = el("div", { class: "dialog", style: { maxWidth: `${width}px` }, attr: { role: "dialog" } });
  const head = el("div", { class: "dialog-head" });
  head.append(el("h2", { text: title }), iconButton("close", "关闭（Esc）", () => closeAll()));
  const content = el("div", { class: "dialog-body" });
  fill(content, body);
  dialog.append(head, content);
  if (footer) dialog.append(footer);
  backdrop.append(dialog);
  return backdrop;
}

export function closeAll(): void {
  state.commandOpen = false;
  state.settingsOpen = false;
  state.envOpen = false;
  state.curlOpen = false;
  state.pendingCurl = null;
  window.dispatchEvent(new CustomEvent("mygo:rerender-overlay"));
}

// ---- cURL 导入 ----

export function curlDialog(): HTMLElement {
  const body = el("div", { class: "stack" });

  const textarea = el("textarea", {
    class: "code-input curl-input",
    attr: {
      placeholder: "粘贴 curl 命令，例如：\ncurl 'https://httpbin.org/post' -X POST -H 'Content-Type: application/json' --data-raw '{\"name\":\"张三\"}'",
      spellcheck: "false",
      rows: "7",
    },
    on: {
      input: () => {
        // 手动修改文本时清掉旧预览，避免拿旧结果去覆盖当前请求。
        state.pendingCurl = null;
        fill(result);
        renderFoot();
        window.clearTimeout(autoTimer);
        // 输入停顿后静默解析一次：成功就直接出预览，失败留给「解析」按钮报错。
        autoTimer = window.setTimeout(() => preview(textarea.value, true), 320);
      },
    },
  });
  let autoTimer: number | undefined;

  const pasteBtn = el("button", {
    class: "btn small",
    attr: { type: "button" },
    on: {
      click: async () => {
        const text = await pasteText();
        if (!text.trim()) {
          toast("剪贴板里没有文本", "error");
          return;
        }
        textarea.value = text;
        preview(text);
      },
    },
  });
  pasteBtn.append(icon("copy"), el("span", { text: "从剪贴板粘贴" }));

  const parseBtn = el("button", {
    class: "btn primary small",
    attr: { type: "button" },
    on: { click: () => preview(textarea.value) },
  });
  parseBtn.append(icon("check"), el("span", { text: "解析" }));

  const tools = el("div", { class: "tools-row" });
  tools.append(pasteBtn, parseBtn, el("span", { class: "spacer" }));

  const result = el("div", { class: "curl-result" });
  const footer = el("div", { class: "dialog-foot" });

  const renderFoot = (): void => {
    fill(footer);
    const hasPending = Boolean(state.pendingCurl);
    if (hasPending) {
      footer.append(
        el("span", { class: "spacer" }),
        el("button", {
          class: "btn primary",
          attr: { type: "button" },
          text: "替换当前请求",
          on: { click: () => applyPendingCurl("replace") },
        }),
        el("button", {
          class: "btn",
          attr: { type: "button" },
          text: "在新标签页打开",
          on: { click: () => applyPendingCurl("newTab") },
        }),
      );
      return;
    }
    footer.append(
      el("span", { class: "spacer" }),
      el("button", { class: "btn", attr: { type: "button" }, text: "关闭", on: { click: closeAll } }),
    );
  };

  const preview = (text: string, quiet = false): void => {
    void (async () => {
      try {
        const parsed = parseCurl(text);
        state.pendingCurl = { request: parsed.request, warnings: parsed.warnings, source: text };
        fill(result, previewCard(parsed.request, parsed.warnings));
        renderFoot();
      } catch (err) {
        state.pendingCurl = null;
        renderFoot();
        if (quiet) {
          fill(result);
          return;
        }
        if (err instanceof CurlError) {
          fill(
            result,
            el(
              "div",
              { class: "error-card tone-invalid" },
              icon("warn"),
              el(
                "div",
                { class: "error-text" },
                el("strong", { text: `解析失败${err.line > 0 ? `（第 ${err.line} 行）` : ""}` }),
                el("p", { text: err.message }),
                err.snippet ? el("pre", { class: "snippet", text: err.snippet }) : null,
              ),
            ),
          );
        } else {
          toast(`解析失败：${(err as Error).message}`, "error");
        }
      }
    })();
  };

  body.append(
    el("p", {
      class: "dialog-hint",
      text: "支持浏览器「Copy as cURL」与后端文档里的命令：方法、地址、查询参数、请求头、请求体、认证、Cookie 都会自动填好。",
    }),
    textarea,
    tools,
    result,
  );

  const dialog = modal("导入 cURL 命令", body, footer, 720);
  const pending = state.pendingCurl;
  if (pending) {
    textarea.value = pending.source;
    fill(result, previewCard(pending.request, pending.warnings));
  }
  renderFoot();
  queueMicrotask(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  return dialog;
}

function previewCard(request: ApiRequest, warnings: string[]): HTMLElement {
  const card = el("div", { class: "preview-card" });
  const head = el("div", { class: "preview-head" });
  head.append(
    el("span", { class: `method-tag tone-${methodTone(request.method)}`, text: request.method }),
    el("code", { class: "preview-url", text: request.url || "（没有地址）" }),
  );
  card.append(head);

  const rows = el("div", { class: "preview-rows" });
  rows.append(previewRow("查询参数", paramSummary(request)));
  rows.append(
    previewRow(
      "请求头",
      request.headers.filter((h) => h.enabled && h.key).length
        ? request.headers
            .filter((h) => h.enabled && h.key)
            .map((h) => h.key)
            .join("、")
        : "无",
    ),
  );
  rows.append(previewRow("请求体", bodySummary(request)));
  rows.append(previewRow("认证", authSummary(request)));
  card.append(rows);

  if (warnings.length > 0) {
    const warnBox = el("div", { class: "warn-box" });
    warnBox.append(icon("warn"), el("strong", { text: "需要注意" }));
    const ul = el("ul");
    for (const w of warnings) ul.append(el("li", { text: w }));
    warnBox.append(ul);
    card.append(warnBox);
  }
  return card;
}

function previewRow(label: string, value: string): HTMLElement {
  return el(
    "div",
    { class: "preview-row" },
    el("span", { class: "preview-label", text: label }),
    el("span", { class: "preview-value", text: value }),
  );
}

function paramSummary(request: ApiRequest): string {
  const params = request.params.filter((p) => p.enabled && p.key);
  if (params.length === 0) return "无";
  // 与其只说「1 个」，不如把真的值列出来，一眼能核对。
  const shown = params.slice(0, 2).map((p) => `${p.key}=${p.value}`);
  return params.length > 2 ? `${shown.join("、")} 等 ${params.length} 个` : shown.join("、");
}

function bodySummary(r: ApiRequest): string {
  if (r.bodyMode === "none") return "无";
  if (r.bodyMode === "form") {
    const files = r.form.filter((f) => f.kind === "file").length;
    return `表单 ${r.form.length} 个字段${files ? `（含 ${files} 个文件）` : ""}`;
  }
  if (r.bodyMode === "urlencoded") return `表单编码 ${r.form.length} 个字段`;
  return `${r.bodyMode.toUpperCase()}，${formatBytes(new Blob([r.body]).size)}`;
}

function authSummary(r: ApiRequest): string {
  switch (r.auth.type) {
    case "bearer":
      return `Bearer ${r.auth.token ? `${r.auth.token.slice(0, 8)}…` : "（空）"}`;
    case "basic":
      return `Basic ${r.auth.username || "（空）"}`;
    case "apikey":
      return `API Key（${r.auth.in === "header" ? "请求头" : "查询参数"} ${r.auth.key}）`;
    default:
      return "无";
  }
}

// ---- 保存请求 ----

let saveMode: "save" | "saveAs" = "save";

export function openSaveDialog(mode: "save" | "saveAs" = "save"): void {
  saveMode = mode;
  window.dispatchEvent(new CustomEvent("mygo:open-save"));
}

export function saveDialog(): HTMLElement {
  const tab = activeTab();
  const body = el("div", { class: "stack" });
  const nameInput = el("input", {
    class: "text-input",
    attr: { placeholder: "请求名称", autocomplete: "off" },
  });
  nameInput.value = tab ? tab.name : "未命名请求";

  // 集合选择
  const colSelect = el("select", { class: "text-input" });
  for (const col of state.collections) {
    colSelect.append(el("option", { attr: { value: col.id }, text: col.name }));
  }
  if (state.collections.length === 0) {
    colSelect.append(el("option", { attr: { value: "" }, text: "（还没有集合）" }));
  }

  // 文件夹选择
  const folderSelect = el("select", { class: "text-input" });
  const rebuildFolders = (): void => {
    fill(folderSelect, el("option", { attr: { value: "" }, text: "（集合根目录）" }));
    const col = state.collections.find((c) => c.id === colSelect.value);
    if (!col) return;
    const walk = (items: typeof col.items, prefix: string): void => {
      for (const item of items) {
        if (item.type === "folder") {
          folderSelect.append(
            el("option", { attr: { value: item.id }, text: `${prefix}${item.name}` }),
          );
          walk(item.items, `${prefix}${item.name} / `);
        }
      }
    };
    walk(col.items, "");
  };
  colSelect.addEventListener("change", rebuildFolders);
  rebuildFolders();

  if (tab?.origin) {
    const col = state.collections.find((c) => c.id === tab.origin?.collectionId);
    if (col) colSelect.value = col.id;
    rebuildFolders();
  }

  const newColName = el("input", {
    class: "text-input",
    attr: { placeholder: "新集合名称", autocomplete: "off" },
  });
  const newColRow = el("div", { class: "row-2" });
  const createBtn = el("button", {
    class: "btn small",
    attr: { type: "button" },
    text: "新建集合",
    on: {
      click: () => {
        const name = newColName.value.trim();
        if (!name) {
          toast("请先填写新集合名称", "error");
          return;
        }
        const col = createCollection(name);
        colSelect.value = col.id;
        rebuildFolders();
        newColName.value = "";
      },
    },
  });
  newColRow.append(newColName, createBtn);

  body.append(
    el(
      "label",
      { class: "field" },
      el("span", { class: "field-label", text: "名称" }),
      nameInput,
    ),
    el(
      "label",
      { class: "field" },
      el("span", { class: "field-label", text: "集合" }),
      colSelect,
    ),
    el(
      "label",
      { class: "field" },
      el("span", { class: "field-label", text: "文件夹（可选）" }),
      folderSelect,
    ),
    el(
      "details",
      { class: "details" },
      el("summary", { text: "新建一个集合" }),
      newColRow,
    ),
  );

  const footer = el("div", { class: "dialog-foot" });
  const saveBtn = el("button", {
    class: "btn primary",
    attr: { type: "button" },
    text: saveMode === "saveAs" ? "另存为" : "保存",
    on: {
      click: () => {
        const collectionId = colSelect.value;
        if (!collectionId) {
          toast("请先创建一个集合", "error");
          return;
        }
        const folderId = folderSelect.value || undefined;
        if (saveMode === "save" && tab?.origin) {
          saveTab(collectionId, folderId, nameInput.value);
          toast("已保存到集合", "success");
        } else if (saveMode === "saveAs") {
          saveTabAs(collectionId, folderId, nameInput.value);
          toast("已另存为新请求", "success");
        } else {
          // 新请求：无归属，直接存进集合
          if (tab) {
            saveTab(collectionId, folderId, nameInput.value);
          } else {
            saveRequestTo(collectionId, nameInput.value || "未命名请求", emptyRequest());
          }
          toast("已保存到集合", "success");
        }
        window.dispatchEvent(new CustomEvent("mygo:close-save"));
      },
    },
  });
  footer.append(
    el("span", { class: "spacer" }),
    el("button", {
      class: "btn",
      attr: { type: "button" },
      text: "取消",
      on: { click: () => window.dispatchEvent(new CustomEvent("mygo:close-save")) },
    }),
    saveBtn,
  );

  const backdrop = modal(saveMode === "saveAs" ? "另存为" : "保存请求", body, footer, 520);
  queueMicrotask(() => {
    nameInput.focus();
    nameInput.select();
  });
  return backdrop;
}

// ---- 环境变量 ----

export function envDialog(): HTMLElement {
  const body = el("div", { class: "env-layout" });
  const list = el("div", { class: "env-list" });
  const detail = el("div", { class: "env-detail" });

  const renderList = (): void => {
    fill(list);
    for (const env of state.envs) {
      const active = env.id === state.activeEnvId;
      const row = el("div", { class: `env-item${active ? " active" : ""}` });
      row.append(
        el("span", { class: "env-dot" }),
        el("span", { class: "env-name", text: env.name }),
        el("span", { class: "env-count", text: String(env.vars.filter((v) => v.enabled && v.key).length) }),
      );
      row.addEventListener("click", () => {
        setEnv(env.id);
        renderList();
        renderDetail(env.id);
      });
      list.append(row);
    }
    const add = el("button", {
      class: "link-btn",
      attr: { type: "button" },
      on: {
        click: () => {
          void (async () => {
            const name = await askText({
              title: "新建环境",
              label: "环境名称",
              value: "测试环境",
              confirmText: "创建",
            });
            if (!name) return;
            const env = createEnv(name);
            renderList();
            renderDetail(env.id);
          })();
        },
      },
    });
    add.append(icon("plus"), el("span", { text: "新建环境" }));
    list.append(add);
  };

  const renderDetail = (envId: string): void => {
    const env = state.envs.find((e) => e.id === envId);
    if (!env) {
      fill(detail, el("div", { class: "pane-empty" }, el("span", { text: "选择左侧的环境进行编辑" })));
      return;
    }
    const head = el("div", { class: "env-detail-head" });
    const nameInput = el("input", {
      class: "text-input",
      attr: { placeholder: "环境名称" },
      on: { change: () => renameEnv(env.id, nameInput.value) },
    });
    nameInput.value = env.name;
    head.append(
      nameInput,
      el("button", {
        class: "btn small ghost danger",
        attr: { type: "button" },
        text: "删除环境",
        on: {
          click: () => {
            void (async () => {
              const ok = await askConfirm({
                title: "删除环境",
                message: `删除环境「${env.name}」？`,
                detail: "环境里的变量会一并删除，集合与历史不受影响。",
                confirmText: "删除",
                danger: true,
              });
              if (!ok) return;
              deleteEnv(env.id);
              renderList();
              renderDetail(state.activeEnvId);
            })();
          },
        },
      }),
    );

    const table = kvTable({
      rows: env.vars,
      keyPlaceholder: "变量名（如 baseUrl）",
      valuePlaceholder: "变量值",
      onChange: () => {
        window.dispatchEvent(new CustomEvent("mygo:rerender-env"));
      },
      emptyHint: "还没有变量，点击下面的按钮添加",
    });

    fill(detail, head, table);
  };

  renderList();
  renderDetail(state.activeEnvId);
  body.append(list, detail);

  const footer = el("div", { class: "dialog-foot" });
  footer.append(
    el("span", {
      class: "muted small",
      text: "发送请求时 {{变量}} 会先替换成当前环境的值；未定义的变量会在发送前拦下。",
    }),
    el("span", { class: "spacer" }),
    el("button", {
      class: "btn primary",
      attr: { type: "button" },
      text: "完成",
      on: { click: closeAll },
    }),
  );

  return modal(`环境变量 · 当前：${state.envs.find((e) => e.id === state.activeEnvId)?.name ?? "无"}`, body, footer, 760);
}

// ---- 全局变量 ----

export function globalsSection(): HTMLElement {
  return kvTable({
    rows: state.globals,
    keyPlaceholder: "变量名",
    valuePlaceholder: "变量值",
    onChange: () => {
      window.dispatchEvent(new CustomEvent("mygo:rerender-settings"));
    },
    emptyHint: "还没有全局变量（全局变量不随环境切换）",
  });
}

// ---- 设置 ----

export function settingsDialog(): HTMLElement {
  const body = el("div", { class: "stack settings-body" });

  const themeRow = el("div", { class: "segmented" });
  for (const mode of [
    { value: "auto" as const, label: "跟随系统" },
    { value: "light" as const, label: "浅色" },
    { value: "dark" as const, label: "深色" },
  ]) {
    themeRow.append(
      el("button", {
        class: `segmented-item${state.theme === mode.value ? " active" : ""}`,
        attr: { type: "button" },
        text: mode.label,
        on: {
          click: () => {
            setTheme(mode.value);
            window.dispatchEvent(new CustomEvent("mygo:rerender-settings"));
          },
        },
      }),
    );
  }

  const varList = el("div", { class: "var-list" });
  for (const d of DYNAMIC_VARS) {
    const row = el("div", { class: "var-row" });
    row.append(el("code", { text: `{{${d.name}}}` }), el("span", { class: "muted", text: d.desc }));
    varList.append(row);
  }

  const infoBox = el("div", { class: "info-box" });
  const versionLine = el("div", { class: "info-row" });

  body.append(
    section("外观", themeRow),
    section("全局变量", globalsSection()),
    section("内置动态变量", varList),
    section("数据与备份", backupSection()),
    section("关于", infoBox),
  );

  void System.info().then((info) => {
    fill(
      versionLine,
      el("span", { class: "info-key", text: "版本" }),
      el("span", { text: `${info.name} ${info.version}` }),
      el("span", { class: "spacer" }),
      el("button", {
        class: "link-btn",
        attr: { type: "button" },
        text: "打开数据目录",
        on: {
          click: () => {
            void System.openDataDir().catch((err: unknown) => {
              toast(`打不开数据目录：${(err as Error).message}`, "error");
            });
          },
        },
      }),
    );
    const dirRow = el("div", { class: "info-row" });
    dirRow.append(el("span", { class: "info-key", text: "数据目录" }));
    dirRow.append(el("code", { class: "path", text: info.dataDir }));
    dirRow.append(
      iconButton("copy", "复制路径", () => {
        void copyText(info.dataDir, "已复制数据目录");
      }),
    );
    const platformRow = el("div", { class: "info-row" });
    platformRow.append(
      el("span", { class: "info-key", text: "运行平台" }),
      el("span", { text: `${info.platform}/${info.arch}` }),
    );
    // 存储层：整个工作区在一个 SQLite 文件里，路径就是数据目录下的这个文件名。
    const dbRow = el("div", { class: "info-row" });
    dbRow.append(
      el("span", { class: "info-key", text: "数据库" }),
      el("code", { class: "path", text: `${databaseFile()}（SQLite，WAL 模式）` }),
    );
    fill(infoBox, versionLine, dirRow, dbRow, platformRow);
  });

  const footer = el("div", { class: "dialog-foot" });
  footer.append(
    el("span", { class: "spacer" }),
    el("button", {
      class: "btn primary",
      attr: { type: "button" },
      text: "完成",
      on: { click: closeAll },
    }),
  );

  return modal("设置", body, footer, 640);
}

function section(title: string, content: HTMLElement): HTMLElement {
  const box = el("section", { class: "settings-section" });
  box.append(el("h3", { text: title }), content);
  return box;
}

function backupSection(): HTMLElement {
  const box = el("div", { class: "stack-tight" });
  const row = el("div", { class: "tools-row" });
  const exportBtn = el("button", {
    class: "btn small",
    attr: { type: "button" },
    on: {
      click: async () => {
        try {
          const saved = await System.saveText("mygo-api-备份.json", exportBundle());
          if (saved) toast(`已导出到 ${saved}`, "success");
        } catch (err) {
          toast(`导出失败：${(err as Error).message}`, "error");
        }
      },
    },
  });
  exportBtn.append(icon("download"), el("span", { text: "导出全部数据" }));

  const importBtn = el("button", {
    class: "btn small",
    attr: { type: "button" },
    on: {
      click: async () => {
        try {
          const file = await System.openText("选择备份文件（JSON）");
          if (!file.path) return;
          const text = file.content.startsWith("{")
            ? file.content
            : new TextDecoder().decode(Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)));
          const result = importBundle(text);
          toast(`已导入 ${result.collections} 个集合、${result.envs} 个环境`, "success");
        } catch (err) {
          toast(`导入失败：${(err as Error).message}`, "error");
        }
      },
    },
  });
  importBtn.append(icon("upload"), el("span", { text: "导入备份" }));

  row.append(exportBtn, importBtn);
  box.append(
    row,
    el("p", {
      class: "field-hint",
      text: "导出内容包含全部集合、环境与全局变量；导入时合并到现有数据，不会覆盖同名集合。",
    }),
  );
  return box;
}

// ---- 命令面板 ----

interface CommandItem {
  id: string;
  title: string;
  hint: string;
  icon: keyof typeof icons;
  run: () => void;
}

export function commandPalette(): HTMLElement {
  const items: CommandItem[] = [];

  for (const c of state.collections) {
    const walk = (nodes: typeof c.items, prefix: string): void => {
      for (const n of nodes) {
        if (n.type === "request") {
          items.push({
            id: `node_${n.id}`,
            title: n.name,
            hint: `${c.name}${prefix ? ` / ${prefix}` : ""} · ${n.request.method}`,
            icon: "collection",
            run: () => window.dispatchEvent(new CustomEvent("mygo:open-node", { detail: { collectionId: c.id, nodeId: n.id } })),
          });
        } else {
          walk(n.items, `${prefix ? `${prefix} / ` : ""}${n.name}`);
        }
      }
    };
    walk(c.items, "");
  }

  for (const h of state.history.slice(0, 60)) {
    items.push({
      id: `h_${h.id}`,
      title: `${h.method} ${shortURL(h.url)}`,
      hint: `历史 · ${h.status || "失败"} · ${Math.round(h.durationMs)} ms`,
      icon: "history",
      run: () => window.dispatchEvent(new CustomEvent("mygo:open-history", { detail: h.id })),
    });
  }

  for (const e of state.envs) {
    items.push({
      id: `env_${e.id}`,
      title: `切换到环境：${e.name}`,
      hint: "环境变量",
      icon: "globe",
      run: () => setEnv(e.id),
    });
  }

  const vars = visibleVarNames(scope());
  for (const v of vars.slice(0, 40)) {
    items.push({
      id: `var_${v}`,
      title: `{{${v}}}`,
      hint: "复制变量占位符",
      icon: "key",
      run: () => void copyText(`{{${v}}}`, `已复制 {{${v}}}`),
    });
  }

  const commands: CommandItem[] = [
    {
      id: "new",
      title: "新建请求",
      hint: "Ctrl+N",
      icon: "plus",
      run: () => openTab(emptyRequest(), "未命名请求"),
    },
    {
      id: "curl",
      title: "导入 cURL 命令",
      hint: "Ctrl+I",
      icon: "terminal",
      run: () => toggleUI("curlOpen", true),
    },
    {
      id: "copy-curl",
      title: "复制当前请求为 cURL",
      hint: "Ctrl+Shift+C",
      icon: "copy",
      run: () => window.dispatchEvent(new CustomEvent("mygo:copy-curl")),
    },
    {
      id: "save",
      title: "保存当前请求到集合",
      hint: "Ctrl+S",
      icon: "save",
      run: () => window.dispatchEvent(new CustomEvent("mygo:save")),
    },
    {
      id: "env",
      title: "管理环境变量",
      hint: "Ctrl+E",
      icon: "globe",
      run: () => toggleUI("envOpen", true),
    },
    {
      id: "settings",
      title: "打开设置",
      hint: "",
      icon: "settings",
      run: () => toggleUI("settingsOpen", true),
    },
    {
      id: "theme",
      title: "切换深色 / 浅色主题",
      hint: "",
      icon: "moon",
      run: () => setTheme(state.theme === "dark" ? "light" : "dark"),
    },
    {
      id: "sidebar",
      title: "收起 / 展开侧边栏",
      hint: "Ctrl+B",
      icon: "sidebar",
      run: () => window.dispatchEvent(new CustomEvent("mygo:toggle-sidebar")),
    },
  ];
  items.unshift(...commands);

  const body = el("div", { class: "palette" });
  const inputWrap = el("div", { class: "palette-input" });
  const input = el("input", {
    class: "palette-search",
    attr: { placeholder: "输入命令或搜索请求、历史、变量…", spellcheck: "false" },
    on: {
      input: () => render(input.value),
      keydown: (ev) => {
        if (ev.key === "ArrowDown") {
          ev.preventDefault();
          moveSelection(1);
        } else if (ev.key === "ArrowUp") {
          ev.preventDefault();
          moveSelection(-1);
        } else if (ev.key === "Enter") {
          ev.preventDefault();
          runSelected();
        } else if (ev.key === "Escape") {
          closeAll();
        }
      },
    },
  });
  inputWrap.append(icon("search"), input);
  const list = el("div", { class: "palette-list", attr: { role: "listbox" } });
  body.append(inputWrap, list);

  let filtered: CommandItem[] = items;
  let selected = 0;

  const render = (query: string): void => {
    const q = query.trim().toLowerCase();
    filtered = q
      ? items.filter(
          (i) => i.title.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q),
        )
      : items;
    filtered = filtered.slice(0, 40);
    selected = 0;
    paint();
  };

  const paint = (): void => {
    fill(list);
    if (filtered.length === 0) {
      list.append(el("div", { class: "palette-empty", text: "没有匹配项，试试「设置」「环境」「新建请求」" }));
      return;
    }
    filtered.forEach((item, i) => {
      const row = el("div", {
        class: `palette-item${i === selected ? " active" : ""}`,
        attr: { role: "option" },
      });
      row.append(icon(item.icon), el("span", { class: "palette-title", text: item.title }));
      if (item.hint) row.append(el("span", { class: "palette-hint", text: item.hint }));
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        closeAll();
        item.run();
      });
      list.append(row);
    });
    const active = list.querySelector<HTMLElement>(".palette-item.active");
    active?.scrollIntoView({ block: "nearest" });
  };

  const moveSelection = (delta: number): void => {
    if (filtered.length === 0) return;
    selected = (selected + delta + filtered.length) % filtered.length;
    paint();
  };

  const runSelected = (): void => {
    const item = filtered[selected];
    if (!item) return;
    closeAll();
    item.run();
  };

  render("");
  const backdrop = el("div", {
    class: "backdrop palette-backdrop",
    on: {
      mousedown: (ev) => {
        if (ev.target === backdrop) closeAll();
      },
    },
  });
  backdrop.append(body);
  queueMicrotask(() => input.focus());
  return backdrop;
}

function shortURL(url: string): string {
  const text = url.replace(/^https?:\/\//, "");
  return text.length > 52 ? `${text.slice(0, 50)}…` : text;
}

export { guessName } from "../util";
