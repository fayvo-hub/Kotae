// 浮层：cURL 导入确认、保存请求、环境变量、设置、命令面板。

import { databaseFile } from "../db";
import { el, fill, icon, iconButton, icons } from "./dom";
import { codeEditor } from "./codeEditor";
import { enableVarAssist, kvTable } from "./kvtable";
import {
  activeTab,
  applyPendingCurl,
  copyText,
  createCollection,
  currentSnippet,
  createEnv,
  deleteEnv,
  exportBundle,
  importBundle,
  importCollections,
  openTab,
  pasteText,
  renameEnv,
  globalSteps,
  saveRequestTo,
  saveTab,
  persist,
  saveTabAs,
  scope,
  setGlobalSteps,
  setSnippetLang,
  setEnv,
  setEnvCommonParams,
  setPendingCurl,
  setDesktopPrefs,
  setDirectConnection,
  setCodeFontSize,
  setShortcut,
  shortcutFor,
  resetShortcuts,
  setTheme,
  setZoom,
  stepZoom,
  CODE_FS_MAX,
  CODE_FS_MIN,
  DEFAULT_CODE_FS,
  ZOOM_MAX,
  ZOOM_MIN,
  state,
  toast,
  toggleUI,
} from "../store";
import { CurlError, emptyRequest, parseCurl } from "../curl";
import { SNIPPET_LANGS } from "../snippets";
import { parseImport, toPostmanCollection } from "../postman";
import { DYNAMIC_VARS, methodTone, visibleVarNames } from "../util";
import type { ApiRequest, Env, KV } from "../types";
import { System } from "../mygo";
import { formatBytes } from "../util";
import { askConfirm, askText } from "./prompt";
import { scriptStepsPanel } from "./scriptSteps";
import {
  SHORTCUT_ACTIONS,
  beginShortcutCapture,
  comboLabel,
  endShortcutCapture,
} from "../shortcuts";

// ---- 通用浮层外壳 ----

export function modal(
  title: string,
  body: HTMLElement,
  footer?: HTMLElement,
  width = 560,
): HTMLElement {
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
  state.nodeSettings = null;
  state.commandOpen = false;
  state.settingsOpen = false;
  state.envOpen = false;
  state.curlOpen = false;
  state.snippetsOpen = false;
  state.cookiesOpen = false;
  state.scriptsOpen = false;
  state.importOpen = false;
  state.pendingCurl = null;
  state.pendingImport = null;
  window.dispatchEvent(new CustomEvent("mygo:rerender-overlay"));
}

// ---- cURL 导入 ----

export function curlDialog(): HTMLElement {
  const body = el("div", { class: "stack" });

  const editor = codeEditor({
    value: "",
    className: "curl-input",
    label: "cURL 命令",
    vars: true,
    placeholder:
      "粘贴 curl 命令，例如：\ncurl 'https://httpbin.org/post' -X POST -H 'Content-Type: application/json' --data-raw '{\"name\":\"张三\"}'",
    onInput: (value) => {
      // 手动修改文本时清掉旧预览，避免拿旧结果去覆盖当前请求。
      state.pendingCurl = null;
      fill(result);
      renderFoot();
      window.clearTimeout(autoTimer);
      // 输入停顿后静默解析一次：成功就直接出预览，失败留给「解析」按钮报错。
      autoTimer = window.setTimeout(() => preview(value, true), 320);
    },
  });
  let autoTimer: number | undefined;
  enableVarAssist(editor, "curl-input");

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
        editor.value = text;
        preview(text);
      },
    },
  });
  pasteBtn.append(icon("copy"), el("span", { text: "从剪贴板粘贴" }));

  const parseBtn = el("button", {
    class: "btn primary small",
    attr: { type: "button" },
    on: { click: () => preview(editor.value) },
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
    editor,
    tools,
    result,
  );

  const dialog = modal("导入 cURL 命令", body, footer, 720);
  const pending = state.pendingCurl;
  if (pending) {
    editor.value = pending.source;
    fill(result, previewCard(pending.request, pending.warnings));
  }
  renderFoot();
  queueMicrotask(() => {
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
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

  // 只改左侧计数：环境变量每输入一个字就走一遍列表重绘，对话框本身不动。
  const syncCounts = (): void => {
    const rows = list.querySelectorAll<HTMLElement>(".env-item");
    state.envs.forEach((env, i) => {
      const count = rows[i]?.querySelector<HTMLElement>(".env-count");
      if (count) {
        count.textContent = String(env.vars.filter((v) => v.enabled && v.key).length);
      }
    });
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
      // 逐字输入就重建整个对话框会重新播一次弹入动画，看着一直在闪；
      // 这里只写库并就地刷新左侧计数与顶栏胶囊。
      onChange: () => {
        persist();
        syncCounts();
        window.dispatchEvent(new CustomEvent("mygo:env-pill"));
      },
      emptyHint: "还没有变量，点击下面的按钮添加",
      secretToggle: true,
    });

    // 公共参数：生效的环境会把这两组行附加到每个请求上（请求里同名时不覆盖）。
    const commonSection = (
      which: "query" | "header",
      rows: KV[],
      title: string,
      keyHint: string,
      valueHint: string,
      emptyHint: string,
    ): HTMLElement => {
      const section = el("div", { class: `env-section env-section-${which}` });
      section.append(
        el("div", { class: "env-section-head", text: title }),
        el("p", {
          class: "pane-hint",
          text:
            which === "query"
              ? "发送时附加到查询串；请求里已有同名参数时以请求为准。"
              : "发送时附加到请求头；请求里已有同名请求头（不分大小写）时以请求为准。",
        }),
        kvTable({
          rows,
          keyPlaceholder: keyHint,
          valuePlaceholder: valueHint,
          onChange: () => {
            setEnvCommonParams(env.id, which, rows);
            syncCounts();
            window.dispatchEvent(new CustomEvent("mygo:env-pill"));
          },
          emptyHint,
        }),
      );
      return section;
    };

    fill(
      detail,
      head,
      table,
      commonSection(
        "query",
        env.commonParams ?? [],
        "公共查询参数",
        "参数名（如 appId）",
        "参数值（支持 {{变量}}）",
        "暂无公共查询参数",
      ),
      commonSection(
        "header",
        env.commonHeaders ?? [],
        "公共请求头",
        "头部名称（如 X-Channel）",
        "头部值（支持 {{变量}}）",
        "暂无公共请求头",
      ),
    );
  };

  renderList();
  renderDetail(state.activeEnvId);
  body.append(list, detail);

  const footer = el("div", { class: "dialog-foot" });
  footer.append(
    el("span", {
      class: "muted small",
      text: "发送请求时 {{变量}} 会先替换成当前环境的值；未定义的变量会在发送前拦下。公共参数在当前环境生效时附加到每个请求，请求里已有同名键时以请求为准。",
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
    // 同样不重建设置对话框：全局变量只影响发送时的插值。
    onChange: () => {
      persist();
      window.dispatchEvent(new CustomEvent("mygo:env-pill"));
    },
    emptyHint: "还没有全局变量（全局变量不随环境切换）",
    secretToggle: true,
  });
}

/** 设置里的「全局操作」：所有请求发送前 / 拿到响应后都会跑的那两串。
 * 只给「脚本」与「等待时间」：全局脚本必须能在原地看到、就地改，不接脚本库引用。
 */
function globalScriptsSection(): HTMLElement {
  const box = el("div", { class: "stack" });
  for (const phase of ["pre", "post"] as const) {
    box.append(
      el(
        "div",
        { class: "settings-sub" },
        el("h4", { text: phase === "pre" ? "前置操作" : "后置操作" }),
        el("p", {
          class: "muted small",
          text:
            phase === "pre"
              ? "所有请求发送前按顺序执行，比如统一加签名头、取时间戳。"
              : "所有请求拿到响应后按顺序执行，比如统一记录日志、刷新 token。",
        }),
        scriptStepsPanel({
          phase,
          steps: () => globalSteps(),
          onChange: (next, quiet) => setGlobalSteps(next, quiet),
          allowLibrary: false,
        }),
      ),
    );
  }
  return box;
}

// ---- 设置 ----

/**
 * 打开 mygo 的更新窗口检查新版本。
 * 开发版与包管理器安装的版本没有配置更新源，Go 侧会返回原因，这里如实提示而不是静默。
 */
export function checkUpdates(): void {
  void System.checkForUpdates().catch((err: unknown) => {
    toast(`检查更新失败：${(err as Error).message}`, "error");
  });
}

/** 上次检查时间的中文说法。 */
function checkedAtText(ms: number): string {
  if (!ms) return "还没检查过";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚检查过";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前检查过`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前检查过`;
  return `${new Date(ms).toLocaleDateString()} 检查过`;
}

/**
 * 设置页的「更新」一节：状态 + 检查按钮 + 两个偏好开关。
 * 状态每渲染一次读一次 Go 侧（插件把偏好存在自己的 updater.json 里，页面不落库）。
 */
function updateSection(): HTMLElement {
  const box = el("div", { class: "stack-tight" });
  const status = el("div", { class: "update-box" });
  box.append(status);

  const paint = (): void => {
    void System.updateState()
      .then((st) => {
        const stateText = st.supported
          ? st.available
            ? `发现新版本 ${st.available}`
            : "已是最新版本"
          : "这个构建不能自我更新（开发版或包管理器安装的版本）";
        const row = el("div", { class: "info-row" });
        row.append(
          el("span", {
            class: `update-dot${st.available ? " has-update" : ""}`,
            attr: { "aria-hidden": "true" },
          }),
          el("span", { text: stateText }),
          el("span", { class: "spacer" }),
          el("span", { class: "muted", text: checkedAtText(st.lastCheck) }),
        );
        fill(
          status,
          row,
          el("div", { class: "info-row" }, el("span", { class: "spacer" }), checkBtn),
        );
        checks.checked = st.automaticChecks;
        checks.disabled = !st.supported;
        downloads.checked = st.automaticDownloads;
        downloads.disabled = !st.supported;
      })
      .catch((err: unknown) => {
        fill(status, el("div", { class: "info-row", text: `读不到更新状态：${(err as Error).message}` }));
      });
  };

  const checkBtn = el("button", {
    class: "btn small",
    attr: { type: "button" },
    text: "检查更新",
    on: {
      click: () => {
        checkUpdates();
        // 插件自己的窗口负责展示进度，这里稍等一会儿重读状态（可用版本、上次检查时间）。
        window.setTimeout(paint, 1200);
      },
    },
  });

  const checks = el("input", {
    attr: { type: "checkbox" },
    on: { change: () => void saveUpdatePrefs() },
  });
  const downloads = el("input", {
    attr: { type: "checkbox" },
    on: { change: () => void saveUpdatePrefs() },
  });
  const saveUpdatePrefs = async (): Promise<void> => {
    try {
      await System.setUpdatePrefs(checks.checked, downloads.checked);
    } catch (err) {
      toast(`保存更新偏好失败：${(err as Error).message}`, "error");
    }
  };

  box.append(
    el(
      "label",
      { class: "field checkbox-field update-toggle" },
      checks,
      el(
        "span",
        { class: "desktop-toggle-text" },
        el("span", { text: "后台自动检查更新" }),
        el("span", { class: "field-hint", text: "每天检查一次，发现新版本时弹出更新窗口。" }),
      ),
    ),
    el(
      "label",
      { class: "field checkbox-field update-toggle" },
      downloads,
      el(
        "span",
        { class: "desktop-toggle-text" },
        el("span", { text: "自动下载并安装" }),
        el("span", { class: "field-hint", text: "发现新版本直接下载，下次启动时生效；也可以在更新窗口里临时打开。" }),
      ),
    ),
  );

  paint();
  return box;
}

// ---- 桌面偏好 ----

/** 一行开关：勾选框 + 标题 + 说明，说明换行跟在标题下面。 */
function toggleRow(o: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }): HTMLElement {
  const input = el("input", {
    attr: { type: "checkbox" },
    on: { change: () => o.onChange(input.checked) },
  });
  input.checked = o.checked;
  return el(
    "label",
    { class: "field checkbox-field desktop-toggle" },
    input,
    el("span", { class: "desktop-toggle-text" }, el("span", { text: o.label }), el("span", { class: "field-hint", text: o.hint })),
  );
}

function desktopSection(): HTMLElement {
  return el(
    "div",
    { class: "stack" },
    toggleRow({
      label: "关闭窗口时最小化到托盘",
      hint: "关掉后点关闭按钮会直接退出应用。",
      checked: state.closeToTray,
      onChange: (on) => setDesktopPrefs({ closeToTray: on }),
    }),
    toggleRow({
      label: "全局快捷键 CmdOrCtrl+Shift+M",
      hint: "在任何程序前按下都能呼出或收起窗口；被别的程序占用时会自动跳过注册。",
      checked: state.globalShortcut,
      onChange: (on) => setDesktopPrefs({ globalShortcut: on }),
    }),
    toggleRow({
      label: "忽略系统代理（直连）",
      hint: "开启后请求不经过系统代理，直接按本机 DNS / hosts 连接。排查 hosts、访问内网时用它；需要代理才能访问的接口会连不上。单条请求在「选项」里填了代理时仍以那条为准。",
      checked: state.directConnection,
      onChange: (on) => setDirectConnection(on),
    }),
  );
}

/**
 * 「外观」一节：主题 + 界面缩放 + 代码字号。
 * 缩放与字号立刻生效并落库，改完不需要「保存」；涉及重绘的地方统一用
 * mygo:rerender-settings 让弹窗自己重建。
 */
function appearanceSection(): HTMLElement {
  const themeRow = el("div", { class: "segmented", attr: { "aria-label": "主题" } });
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

  const stepBtn = (name: "minus" | "plus", title: string, disabled: boolean, run: () => void): HTMLElement => {
    const btn = el("button", {
      class: "icon-btn",
      attr: { type: "button", title, "aria-label": title, disabled },
      on: { click: run },
    });
    btn.append(icon(name));
    return btn;
  };

  const stepper = (
    label: string,
    hint: string,
    valueText: string,
    canDown: boolean,
    canUp: boolean,
    step: (dir: 1 | -1) => void,
    reset: () => void,
  ): HTMLElement =>
    el(
      "div",
      { class: "stepper-field" },
      el(
        "div",
        { class: "stepper-text" },
        el("span", { text: label }),
        el("span", { class: "field-hint", text: hint }),
      ),
      el(
        "div",
        { class: "stepper" },
        stepBtn("minus", `减小${label}`, !canDown, () => step(-1)),
        el("span", { class: "stepper-value", text: valueText }),
        stepBtn("plus", `增大${label}`, !canUp, () => step(1)),
        el("button", { class: "link-btn", attr: { type: "button" }, text: "复位", on: { click: reset } }),
      ),
    );

  return el(
    "div",
    { class: "stack" },
    themeRow,
    stepper(
      "界面缩放",
      "整页缩放，窗口大小不变；Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 复位。",
      `${Math.round(state.zoom * 100)}%`,
      state.zoom > ZOOM_MIN + 0.001,
      state.zoom < ZOOM_MAX - 0.001,
      (dir) => {
        stepZoom(dir);
        window.dispatchEvent(new CustomEvent("mygo:rerender-settings"));
      },
      () => {
        setZoom(1);
        window.dispatchEvent(new CustomEvent("mygo:rerender-settings"));
      },
    ),
    stepper(
      "代码字号",
      "只影响请求体、响应体与脚本区，界面上其余文字不变。",
      `${state.codeFontSize}px`,
      state.codeFontSize > CODE_FS_MIN,
      state.codeFontSize < CODE_FS_MAX,
      (dir) => {
        setCodeFontSize(state.codeFontSize + dir);
        window.dispatchEvent(new CustomEvent("mygo:rerender-settings"));
      },
      () => {
        setCodeFontSize(DEFAULT_CODE_FS);
        window.dispatchEvent(new CustomEvent("mygo:rerender-settings"));
      },
    ),
  );
}

/** 「快捷键」一节：每行一个动作，点「修改」进入录制，Esc 取消，冲突时提示。 */
function shortcutsSection(): HTMLElement {
  const list = el("div", { class: "shortcut-list" });
  const rerender = (): void => {
    window.dispatchEvent(new CustomEvent("mygo:rerender-settings"));
  };

  for (const action of SHORTCUT_ACTIONS) {
    const combo = shortcutFor(action.id);
    const key = el("kbd", { class: "shortcut-key", text: comboLabel(combo) });
    // 录制中再点一次同一个按钮＝取消；靠这个标志而不是改写 onclick，
    // 否则原有的 click 监听还会再启动一轮录制。
    let recording = false;
    const edit = el("button", {
      class: "link-btn",
      attr: { type: "button" },
      text: "修改",
      on: {
        click: () => {
          if (recording) {
            endShortcutCapture();
            rerender();
            return;
          }
          recording = true;
          key.textContent = "按下新组合键…";
          key.classList.add("recording");
          edit.textContent = "取消";
          beginShortcutCapture((next) => {
            if (!next) {
              rerender();
              return;
            }
            if (setShortcut(action.id, next)) {
              toast(`「${action.label}」现在是 ${comboLabel(next)}`);
            }
            rerender();
          });
        },
      },
    });
    list.append(
      el(
        "div",
        { class: "shortcut-row" },
        el("span", { class: "shortcut-label", text: action.label }),
        key,
        edit,
      ),
    );
  }

  return el(
    "div",
    { class: "stack" },
    el(
      "div",
      { class: "info-row" },
      el("span", {
        class: "field-hint",
        text: "点「修改」后按下新的组合键，Esc 取消；与别的动作冲突时会提示。",
      }),
      el("span", { class: "spacer" }),
      el("button", {
        class: "link-btn",
        attr: { type: "button" },
        text: "全部恢复默认",
        on: {
          click: () => {
            resetShortcuts();
            rerender();
          },
        },
      }),
    ),
    list,
  );
}

/** 设置页的分类。id 同时写进 `data-tab`，样式与 e2e 都靠它定位。 */
type SettingsTabId = "appearance" | "shortcuts" | "desktop" | "vars" | "steps" | "data" | "about";

/**
 * 当前选中的页签。改主题、改缩放会整块重建设置弹窗，所以记在模块里而不是 DOM 上；
 * 同一会话内关掉再打开回到上次那一页。
 */
let settingsTab: SettingsTabId = "appearance";

/** 「变量」页：全局变量 + 内置动态变量。 */
function varsTab(): HTMLElement[] {
  const varList = el("div", { class: "var-list" });
  for (const d of DYNAMIC_VARS) {
    const row = el("div", { class: "var-row" });
    row.append(el("code", { text: `{{${d.name}}}` }), el("span", { class: "muted", text: d.desc }));
    varList.append(row);
  }
  return [section("全局变量", globalsSection()), section("内置动态变量", varList)];
}

/** 「关于」页：版本与路径信息 + 更新检查。 */
function aboutTab(): HTMLElement[] {
  const infoBox = el("div", { class: "info-box" });
  const versionLine = el("div", { class: "info-row" });

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

  return [infoBox, section("更新", updateSection())];
}

interface SettingsTabSpec {
  id: SettingsTabId;
  label: string;
  icon: keyof typeof icons;
  /** 这一页的内容块；单块且标题重复的就不包 h3。 */
  build: () => HTMLElement[];
}

const SETTINGS_TABS: SettingsTabSpec[] = [
  { id: "appearance", label: "外观", icon: "sun", build: () => [appearanceSection()] },
  { id: "shortcuts", label: "快捷键", icon: "command", build: () => [shortcutsSection()] },
  { id: "desktop", label: "桌面", icon: "sidebar", build: () => [desktopSection()] },
  { id: "vars", label: "变量", icon: "globe", build: varsTab },
  { id: "steps", label: "全局操作", icon: "code", build: () => [globalScriptsSection()] },
  { id: "data", label: "数据与备份", icon: "file", build: () => [backupSection()] },
  { id: "about", label: "关于", icon: "info", build: aboutTab },
];

/**
 * 设置：左栏分类页签 + 右栏内容，两栏各自滚动。
 *
 * 以前是一条长列表从头滚到底，节数一多就得翻半天；现在按类分页，默认落在外观。
 * 只挂载当前页签的内容（切走的页不留在 DOM 里），所以页面上的元素计数是干净的。
 */
export function settingsDialog(): HTMLElement {
  const tabBar = el("nav", { class: "settings-nav", attr: { role: "tablist", "aria-label": "设置分类" } });
  const pane = el("div", { class: "settings-content", attr: { role: "tabpanel" } });

  const paint = (): void => {
    for (const btn of tabBar.querySelectorAll<HTMLElement>(".settings-tab")) {
      const on = btn.dataset.tab === settingsTab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    const spec = SETTINGS_TABS.find((tab) => tab.id === settingsTab) ?? SETTINGS_TABS[0];
    if (!spec) return;
    pane.dataset.tab = spec.id;
    fill(pane, ...spec.build());
  };

  for (const spec of SETTINGS_TABS) {
    tabBar.append(
      el(
        "button",
        {
          class: "settings-tab",
          data: { tab: spec.id },
          attr: { type: "button", role: "tab", "aria-selected": "false" },
          on: {
            click: () => {
              if (settingsTab === spec.id) return;
              settingsTab = spec.id;
              paint();
            },
          },
        },
        icon(spec.icon),
        el("span", { text: spec.label }),
      ),
    );
  }

  paint();

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

  return modal("设置", el("div", { class: "settings-tabs" }, tabBar, pane), footer, 760);
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
          const saved = await System.saveText("kotae-备份.json", exportBundle());
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

  const postmanBtn = el("button", {
    class: "btn small",
    attr: { type: "button", title: "导出为 Postman Collection v2.1，可直接在 Postman 里导入" },
    on: {
      click: async () => {
        try {
          const saved = await System.saveText(
            "kotae-postman.json",
            toPostmanCollection(state.collections, state.envs, state.scriptLibrary),
          );
          if (saved) toast(`已导出到 ${saved}`, "success");
        } catch (err) {
          toast(`导出失败：${(err as Error).message}`, "error");
        }
      },
    },
  });
  postmanBtn.append(icon("download"), el("span", { text: "导出为 Postman" }));

  row.append(exportBtn, importBtn, postmanBtn);
  box.append(
    row,
    el("p", {
      class: "field-hint",
      text: "导出内容包含全部集合、环境与全局变量；导入时合并到现有数据，不会覆盖同名集合。Postman 格式会把多个集合装成顶层文件夹。",
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
      id: "import",
      title: "导入 Postman Collection / HAR",
      hint: "Ctrl+Shift+I",
      icon: "upload",
      run: () => toggleUI("importOpen", true),
    },
    {
      id: "snippets",
      title: "生成代码片段（fetch / axios / Python）",
      hint: "Ctrl+Shift+G",
      icon: "code",
      run: () => toggleUI("snippetsOpen", true),
    },
    {
      id: "scripts",
      title: "脚本库（全局 / 集合 / 请求脚本）",
      hint: "",
      icon: "code",
      run: () => toggleUI("scriptsOpen", true),
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
      id: "zoom-in",
      title: "放大界面",
      hint: "Ctrl+=",
      icon: "plus",
      run: () => stepZoom(1),
    },
    {
      id: "zoom-out",
      title: "缩小界面",
      hint: "Ctrl+-",
      icon: "minus",
      run: () => stepZoom(-1),
    },
    {
      id: "zoom-reset",
      title: "复位界面缩放（100%）",
      hint: "Ctrl+0",
      icon: "refresh",
      run: () => setZoom(1),
    },
    {
      id: "check-updates",
      title: "检查更新",
      hint: "",
      icon: "download",
      run: () => checkUpdates(),
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

// ---- 代码片段 ----

/** 生成代码片段：把当前请求转成 fetch / axios / requests / cURL 四种写法。 */
export function snippetsDialog(): HTMLElement {
  const tab = activeTab();
  if (!tab) {
    return modal("生成代码片段", el("p", { class: "muted", text: "先新建一个请求标签页。" }), undefined, 640);
  }

  const body = el("div", { class: "stack" });
  const seg = el("div", { class: "segmented" });
  const code = el("pre", { class: "snippet-code", attr: { tabindex: "0" } });
  const hint = el("p", { class: "field-hint" });

  const paint = (): void => {
    fill(seg);
    for (const lang of SNIPPET_LANGS) {
      seg.append(
        el("button", {
          class: `segmented-item${state.snippetLang === lang.key ? " active" : ""}`,
          attr: { type: "button", title: lang.hint },
          text: lang.label,
          // 语言切换只重画本面板（不改浮层开关），避免整个对话框闪一下。
          on: {
            click: () => {
              setSnippetLang(lang.key);
              paint();
            },
          },
        }),
      );
    }
    code.textContent = currentSnippet(state.snippetLang);
    const meta = SNIPPET_LANGS.find((l) => l.key === state.snippetLang);
    hint.textContent = `变量已替换成「${state.activeEnvId ? "当前环境" : "未选环境"}」的实际值，复制即可运行。${meta ? `（${meta.hint}）` : ""}`;
  };

  paint();
  body.append(seg, code, hint);

  const copyBtn = el("button", {
    class: "btn primary small",
    attr: { type: "button" },
    on: {
      click: () => {
        void copyText(currentSnippet(state.snippetLang), "已复制代码片段");
      },
    },
  });
  copyBtn.append(icon("copy"), el("span", { text: "复制代码" }));

  const footer = el("div", { class: "dialog-foot" });
  footer.append(
    el("span", { class: "spacer" }),
    el("button", {
      class: "btn small",
      attr: { type: "button" },
      text: "关闭",
      on: { click: closeAll },
    }),
    copyBtn,
  );

  return modal("生成代码片段", body, footer, 680);
}

// ---- 导入 Postman / HAR ----

/** 导入外部集合：粘贴或选文件，解析后展示将要并进来多少集合与请求。 */
export function importDialog(): HTMLElement {
  const body = el("div", { class: "stack" });

  const hint = el("p", {
    class: "field-hint",
    text: "支持 Postman Collection v2.0 / v2.1（.json）与浏览器导出的 HAR。脚本、测试、集合级变量不会导入。",
  });

  const editor = codeEditor({
    value: "",
    className: "curl-input",
    label: "导入 JSON",
    placeholder: "把 Collection 或 HAR 的 JSON 粘贴到这里，也可以直接选文件。",
    onInput: () => {
      state.pendingImport = null;
      fill(result);
      renderFoot();
    },
  });

  const result = el("div");

  // 双击 .har 打开时，文本已经由桌面外壳读进来：直接填好并解析一次。
  if (state.importDraft) {
    const draft = state.importDraft;
    state.importDraft = "";
    editor.value = draft;
    queueMicrotask(() => preview(draft));
  }

  const fileBtn = el("button", {
    class: "btn small",
    attr: { type: "button" },
    on: {
      click: async () => {
        try {
          const file = await System.openText("选择 Postman Collection 或 HAR（JSON）");
          if (!file.path) return;
          editor.value = file.content;
          preview(file.content);
        } catch (err) {
          toast(`读取文件失败：${(err as Error).message}`, "error");
        }
      },
    },
  });
  fileBtn.append(icon("upload"), el("span", { text: "从文件读取" }));

  const parseBtn = el("button", {
    class: "btn primary small",
    attr: { type: "button" },
    on: { click: () => preview(editor.value) },
  });
  parseBtn.append(icon("check"), el("span", { text: "解析" }));

  const tools = el("div", { class: "tools-row" });
  tools.append(fileBtn, parseBtn);

  function preview(text: string): void {
    if (!text.trim()) {
      toast("先粘贴内容或选择一个文件", "error");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      toast(`不是合法 JSON：${(err as Error).message}`, "error");
      return;
    }
    try {
      const one = parseImport(parsed);
      state.pendingImport = { collections: [{ collection: one.collection, warnings: one.warnings }], source: text };
      renderPreview([one]);
    } catch (err) {
      toast(`无法解析：${(err as Error).message}`, "error");
    }
  }

  function renderPreview(items: { kind: string; collection: { name: string; items: unknown[] }; warnings: string[] }[]): void {
    fill(result);
    const box = el("div", { class: "import-preview" });
    for (const item of items) {
      const total = countTree(item.collection.items as never);
      const line = el("div", { class: "import-line" });
      line.append(
        el("span", { class: `badge ${item.kind === "har" ? "tone-warn" : "tone-accent"}`, text: item.kind === "har" ? "HAR" : "Postman" }),
        el("strong", { text: item.collection.name }),
        el("span", { class: "muted", text: `${total} 条请求` }),
      );
      box.append(line);
      for (const w of item.warnings.slice(0, 4)) {
        box.append(el("p", { class: "field-hint", text: `· ${w}` }));
      }
    }
    result.append(box);
    renderFoot();
  }

  const footer = el("div", { class: "dialog-foot" });
  function renderFoot(): void {
    fill(footer);
    const pending = state.pendingImport;
    const importBtn = el("button", {
      class: "btn primary small",
      attr: { type: "button" },
      text: "导入到工作区",
      on: {
        click: () => {
          if (!state.pendingImport) return;
          const res = importCollections(state.pendingImport.collections);
          toast(`已导入 ${res.collections} 个集合，共 ${res.requests} 条请求`, "success");
          closeAll();
        },
      },
    });
    importBtn.disabled = !pending;
    footer.append(
      el("span", { class: "spacer" }),
      el("button", {
        class: "btn small",
        attr: { type: "button" },
        text: "关闭",
        on: { click: closeAll },
      }),
      importBtn,
    );
  }

  renderFoot();
  body.append(hint, editor, tools, result);
  return modal("导入 Postman / HAR", body, footer, 680);
}

function countTree(nodes: { type: string; items?: unknown[] }[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "request") n += 1;
    else if (Array.isArray(node.items)) n += countTree(node.items as { type: string; items?: unknown[] }[]);
  }
  return n;
}
