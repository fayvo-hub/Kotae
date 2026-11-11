// 请求编辑区：方法 + URL + 发送 + cURL 导入导出 + 参数/头/体/认证/前置/后置/选项 七个子页签。

import { el, fill, icon, iconButton, icons } from "./dom";
import { codeEditor } from "./codeEditor";
import { assistOpen, enableVarAssist, kvTable } from "./kvtable";
import { selectBox } from "./select";
import {
  abortSend,
  activeEnv,
  activeTab,
  applyURL,
  closeStream,
  commonParamCount,
  emit,
  enabledStepCount,
  isStreaming,
  mutate,
  mutateDraft,
  importCurlParsed,
  scriptLayers,
  send,
  setTabSteps,
  stepsOf,
  toast,
  toggleUI,
} from "../store";
import { System } from "../mygo";
import { CurlError, parseCurl } from "../curl";
import { switchBodyMode } from "../bodyConvert";
import { scriptStepsPanel } from "./scriptSteps";
import { enableVarHighlight } from "./varTokens";
import {
  METHODS,
  type BodyMode,
  type HttpMethod,
  type KV,
  type RequestProtocol,
  type ScriptPhase,
  type Tab,
} from "../types";
import {
  formatBytes,
  interpolate,
  pathVarNames,
  prettyJSON,
  uid,
} from "../util";
import {
  inheritedFor,
  openNodeSettings,
  scope as storeScope,
} from "../store";
import { authEditor, authLabel } from "./authEditor";

/** 本地读取文件的上限，与 Go 侧 maxFileSize 保持一致（32 MB）。 */
const FILE_LIMIT = 32 * 1024 * 1024;

/** 请求协议：普通 HTTP、SSE 单向流、WebSocket 双向。 */
const PROTOCOLS: { key: RequestProtocol; label: string; hint: string }[] = [
  { key: "http", label: "HTTP", hint: "普通请求，收发一次" },
  { key: "sse", label: "SSE", hint: "服务端事件流，持续推送" },
  { key: "ws", label: "WebSocket", hint: "双向长连接，可随时发消息" },
];

const COMMON_HEADERS = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Connection",
  "Content-Type",
  "Cookie",
  "Origin",
  "Pragma",
  "Referer",
  "User-Agent",
  "X-Requested-With",
  "X-Api-Key",
];

/** 子页签徽标的局部刷新入口，面板重建时由 tabStrip 重新挂上。 */
let subtabBadges: (() => void) | null = null;

/**
 * 逐字输入后的局部刷新：徽标与标签条重画，输入框和已输入的文本原地不动。
 *
 * `tabsChanged` 由 store.mutateDraft 返回：未保存标记或标签名变了才需要重画标签条。
 */
function refreshChrome(tabsChanged: boolean): void {
  subtabBadges?.();
  if (tabsChanged) window.dispatchEvent(new CustomEvent("mygo:rerender-tabs"));
}

/** 渲染整块请求编辑区。 */
export function requestPanel(tab: Tab): HTMLElement {
  const wrap = el("section", { class: "request-panel" });
  const row = el("div", { class: "request-tabs-row" });
  subtabBadges = null;
  row.append(tabStrip(tab), envChip());
  fill(wrap, urlBar(tab), row, tabBody(tab));
  return wrap;
}

/** 当前环境胶囊：只显示不切换，点开环境管理。 */
function envChip(): HTMLElement {
  const name = document.documentElement.dataset.envName ?? "无环境";
  const chip = el("button", {
    class: "env-chip-btn",
    attr: { type: "button", title: "管理环境变量（Ctrl+E）" },
    on: { click: () => toggleUI("envOpen", true) },
  });
  chip.append(icon("globe"), el("span", { text: name }));
  return chip;
}

function urlBar(tab: Tab): HTMLElement {
  const bar = el("div", { class: "url-bar" });

  const protocol: RequestProtocol = tab.request.protocol ?? "http";

  const protocolSelect = selectBox({
    className: `protocol-select proto-${protocol}`,
    label: "请求协议",
    value: protocol,
    menuWidth: 210,
    options: PROTOCOLS.map((p) => ({ value: p.key, label: p.label, hint: p.hint })),
    onPick: (value) => {
      mutate((r) => {
        r.protocol = value as RequestProtocol;
      });
      // 换协议时丢掉上一轮的连接记录，避免旧的 SSE 消息留在 WebSocket 面板里。
      if (!isStreaming(tab)) {
        tab.stream = undefined;
        emit();
      }
    },
  });

  // WebSocket 握手在 RFC 里是 GET，方法没有意义；SSE 允许 GET/POST，保留可选。
  const methodLocked = protocol === "ws";
  const methodSelect = selectBox({
    className: `method-select tone-${tab.request.method.toLowerCase()}`,
    label: "请求方法",
    value: tab.request.method,
    disabled: methodLocked,
    title: methodLocked ? "WebSocket 握手固定用 GET" : undefined,
    menuWidth: 170,
    options: METHODS.map((m) => ({ value: m, label: m })),
    onPick: (value) => {
      mutate((r) => {
        r.method = value as HttpMethod;
      });
    },
  });

  const urlInput = el("input", {
    class: "url-input",
    attr: {
      placeholder: "输入请求地址，或直接粘贴整条 curl 命令",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "请求地址",
    },
    on: {
      input: () => {
        setUrlInvalid(urlInput, false);
        // 逐字落库：失焦才提交的话，焦点还停在地址栏里按 Ctrl+S（或 Ctrl+Enter 发送）
        // 用的还是上一次提交的旧地址，界面却提示「已保存」，改动就这么丢了。
        // 这里只同步文本，拆分查询参数仍然留给失焦 / 回车时的 applyURL。
        // 空值不提交：清空地址栏后离开，保持「没填地址」而不是把地址抹掉。
        if (!urlInput.value.trim()) return;
        refreshChrome(
          mutateDraft((r) => {
            r.url = urlInput.value;
          }),
        );
      },
      paste: (ev) => {
        const text = ev.clipboardData?.getData("text") ?? "";
        if (/^\s*curl(\.exe)?\s/i.test(text)) {
          ev.preventDefault();
          importCurlText(text);
        }
      },
      keydown: (ev) => {
        // 补全层开着时 Enter 归它选变量，不发送也不收起键盘焦点。
        if (assistOpen()) return;
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey || !ev.shiftKey)) {
          ev.preventDefault();
          void send();
        }
        if (ev.key === "Enter") urlInput.blur();
      },
      // 失焦只存原样输入：不自动补协议，也不改写用户写的变量模板。
      // 协议在发送时按解析后的地址兜底（见 util.ensureScheme）。
      // 必须写回自己的标签：切换标签时旧输入框被移除也会触发一次 blur，
      // 那时 activeTab 已经是新标签了。
      // 文本已经逐字写进状态了，失焦这一下只负责把查询参数从地址里拆进表格。
      // 什么都没变时 applyURL 自己会短路，不会白重绘。
      blur: () => {
        const raw = urlInput.value;
        if (raw.trim()) applyURL(raw, tab.id);
        setUrlInvalid(urlInput, false);
      },
    },
  });
  urlInput.value = tab.request.url;
  enableVarAssist(urlInput, `url:${tab.id}`);
  enableVarHighlight(urlInput);

  const streaming = isStreaming(tab);
  // 普通请求发送中按钮原地变「取消」，流式连接建立后变「断开」。
  const cancelling = !streaming && protocol === "http" && tab.sending;
  const sendBtn = el("button", {
    class: "btn primary send-btn",
    attr: {
      type: "button",
      title: streaming ? "断开连接" : cancelling ? "取消请求" : protocol === "http" ? "发送（Ctrl+Enter）" : "建立连接（Ctrl+Enter）",
    },
    on: {
      click: () => {
        if (streaming) closeStream(tab.id);
        else if (cancelling) abortSend(tab.id);
        else void send();
      },
    },
  });
  if (streaming) {
    sendBtn.append(icon("close"), el("span", { text: "断开" }));
    sendBtn.classList.add("cancelling");
  } else if (cancelling) {
    sendBtn.append(icon("close"), el("span", { text: "取消" }));
    sendBtn.classList.add("cancelling");
  } else if (protocol === "http") {
    sendBtn.append(icon("send"), el("span", { text: "发送" }));
  } else {
    sendBtn.append(icon("dot"), el("span", { text: "连接" }));
  }

  const snippetBtn = iconButton("code", "生成代码片段（Ctrl+Shift+G）", () => {
    toggleUI("snippetsOpen", true);
  });

  const saveBtn = iconButton("save", "保存到集合（Ctrl+S）", () => {
    window.dispatchEvent(new CustomEvent("mygo:save"));
  });

  fill(
    bar,
    el("div", { class: "url-method" }, protocolSelect, methodSelect),
    el("div", { class: "url-field" }, el("div", { class: "url-input-wrap" }, urlInput), unresolvedBadge(tab)),
    // 与顶栏、快捷键重复的动作不在这里重复放：导入 cURL 在顶栏与 Ctrl+I，
    // 复制 cURL 走代码片段（选 cURL）或 Ctrl+Shift+C。
    el("div", { class: "url-actions" }, saveBtn, snippetBtn, sendBtn),
  );
  return bar;
}

/**
 * 按 Ctrl+S 之前把地址栏里正在编辑的地址提交完（快捷键不会先失焦）。
 *
 * 地址栏逐字写的是原文，查询参数要等失焦或这里调 applyURL 才拆进表格：
 * 少了这一步，集合里存下的形态就和用户看到的地址栏不一致。
 */
export function commitAddressBar(): void {
  const input = document.querySelector<HTMLInputElement>(".url-input");
  if (!input || document.activeElement !== input) return;
  const raw = input.value;
  if (!raw.trim()) return;
  const tab = activeTab();
  if (tab) applyURL(raw, tab.id);
}

function setUrlInvalid(input: HTMLInputElement, invalid: boolean): void {
  input.classList.toggle("invalid", invalid);
}

function unresolvedBadge(tab: Tab): HTMLElement {
  const texts = [
    tab.request.url,
    ...tab.request.params.flatMap((p) => [p.key, p.value]),
    ...tab.request.headers.flatMap((h) => [h.key, h.value]),
    tab.request.body,
    tab.request.auth.token,
    tab.request.auth.key,
    tab.request.auth.value,
  ];
  const missing = interpolate(texts.join("\n"), storeScope()).missing;
  const badge = el("div", { class: "url-badge", attr: { role: "status" } });
  if (missing.length > 0) {
    badge.classList.add("warn");
    badge.append(icon("warn"));
    badge.append(
      el("span", { text: `未定义变量：${missing.map((m) => `{{${m}}}`).join(" ")}` }),
    );
  }
  return badge;
}

/** 子页签徽标上的数字；只算这条请求自己的内容。 */
function subtabCounts(tab: Tab): Record<Tab["requestTab"], number> {
  const own = stepsOf(tab.request);
  // 徽标只算这条请求自己的操作：集合与全局的继承条数写在面板顶部，不挤在页签上。
  return {
    params: tab.request.params.filter((p) => p.enabled && p.key).length,
    headers: tab.request.headers.filter((h) => h.enabled && h.key).length,
    body: 0,
    auth: tab.request.auth.type === "none" ? 0 : 1,
    pre: enabledStepCount(own, "pre"),
    post: enabledStepCount(own, "post"),
    options: 0,
  };
}

function tabStrip(tab: Tab): HTMLElement {
  const strip = el("div", { class: "subtabs", attr: { role: "tablist" } });
  const counts = subtabCounts(tab);
  const buttons = new Map<Tab["requestTab"], HTMLElement>();
  const defs: { key: Tab["requestTab"]; label: string; icon: keyof typeof icons }[] = [
    { key: "params", label: "查询参数", icon: "filter" },
    { key: "headers", label: "请求头", icon: "table" },
    { key: "body", label: "请求体", icon: "terminal" },
    { key: "auth", label: "认证", icon: "lock" },
    { key: "pre", label: "前置操作", icon: "code" },
    { key: "post", label: "后置操作", icon: "code" },
    { key: "options", label: "选项", icon: "sliders" },
  ];
  for (const def of defs) {
    const active = tab.requestTab === def.key;
    const badge = counts[def.key];
    const btn = el("button", {
      class: `subtab${active ? " active" : ""}`,
      attr: { type: "button", role: "tab", "aria-selected": active ? "true" : "false" },
      on: {
        click: () => {
          // 取当前活动页签而不是闭包里的 tab：emit 批处理期间这块面板可能还属于上一个页签，
          // 点得快就会把切换写到别的页签上（新页签刚建好时尤其明显）。
          const current = activeTab() ?? tab;
          current.requestTab = def.key;
          window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
        },
      },
    });
    btn.append(icon(def.icon), el("span", { text: def.label }));
    if (badge) btn.append(el("span", { class: "subtab-badge", text: String(badge) }));
    buttons.set(def.key, btn);
    strip.append(btn);
  }
  // 逐字输入不重建面板，但徽标上的条数会跟着变，这里就地改数字。
  subtabBadges = () => {
    const current = activeTab() ?? tab;
    for (const [key, btn] of buttons) {
      const count = subtabCounts(current)[key];
      const badge = btn.querySelector<HTMLElement>(".subtab-badge");
      if (!count) {
        badge?.remove();
        continue;
      }
      if (badge) badge.textContent = String(count);
      else btn.append(el("span", { class: "subtab-badge", text: String(count) }));
    }
  };
  return strip;
}

/**
 * 前置 / 后置操作页：就地增删改、开关、展开、排序。
 * 顶部先交代「这一层之外还有谁会跑」，免得用户以为请求页签里看到的就是全部。
 */
function stepsPane(tab: Tab, phase: ScriptPhase): HTMLElement {
  const host = el("div", { class: "pane step-pane" });
  host.append(
    el("p", {
      class: "pane-hint",
      text:
        phase === "pre"
          ? "发送前按顺序执行，能改请求头、地址与请求体；这里只放这条请求自己的操作。"
          : "拿到响应后按顺序执行，能改写响应体、写变量，也能让同一个请求再发一次。",
    }),
  );
  const inherited = inheritedNote(tab, phase);
  if (inherited) host.append(el("p", { class: "inherit-note", text: inherited }));
  host.append(
    scriptStepsPanel({
      phase,
      steps: () => stepsOf(tab.request),
      onChange: (next, quiet) => setTabSteps(tab, next, quiet),
    }),
  );
  return host;
}

/** 继承来的操作都是谁在跑：按执行顺序列出还有内容的那几层。 */
function inheritedNote(tab: Tab, phase: ScriptPhase): string {
  const layers = scriptLayers(tab).filter((layer) => layer.scope !== "request");
  const ordered = phase === "post" ? [...layers].reverse() : layers;
  const parts: string[] = [];
  for (const layer of ordered) {
    const count = enabledStepCount(layer.steps, phase);
    if (count === 0) continue;
    const where =
      layer.scope === "global"
        ? "全局"
        : `${layer.scope === "folder" ? "文件夹" : "集合"}「${layer.scopeName ?? ""}」`;
    parts.push(`${where} ${count} 条`);
  }
  if (parts.length === 0) return "";
  return `${phase === "pre" ? "这次发送前" : "这次响应后"}还会按顺序执行：${parts.join(" → ")}`;
}

function tabBody(tab: Tab): HTMLElement {
  const host = el("div", { class: "subtabs-body" });
  switch (tab.requestTab) {
    case "params":
      fill(host, paramsPane(tab));
      break;
    case "headers":
      fill(host, headersPane(tab));
      break;
    case "body":
      fill(host, bodyPane(tab));
      break;
    case "auth":
      fill(host, authPane(tab));
      break;
    case "pre":
      fill(host, stepsPane(tab, "pre"));
      break;
    case "post":
      fill(host, stepsPane(tab, "post"));
      break;
    case "options":
      fill(host, optionsPane(tab));
      break;
  }
  return host;
}

/**
 * 参数 / 请求头页签的提示行。当前环境配了公共参数时先说清会自动附加，
 * 免得用户看到发出去的请求多了几项却找不到来源。
 */
function commonHint(which: "query" | "header"): string {
  const count = commonParamCount(activeEnv(), which);
  const base =
    which === "query"
      ? "同名参数会全部发送；勾选框控制是否启用。粘贴带查询串的完整 URL 会自动拆到这里。"
      : "请求由 Go 发出，可写任意请求头（包括 Origin、Referer、User-Agent）。批量粘贴支持 name: value 每行一条。";
  if (count === 0) return base;
  const what = which === "query" ? "公共查询参数" : "公共请求头";
  return `当前环境带 ${String(count)} 个${what}，发送时自动附加（同名时以这里为准）。${base}`;
}

function paramsPane(tab: Tab): HTMLElement {
  const host = el("div", { class: "pane" });
  // 地址里有 `:id` 这种占位符时，参数页签顶部多一张路径变量表。
  const pathNames = pathVarNames(tab.request.url);
  const head: Node[] = [];
  if (pathNames.length > 0) {
    const stored = tab.request.pathVars ?? [];
    const rows: KV[] = pathNames.map(
      (name) => stored.find((s) => s.key === name) ?? { id: uid("kv"), key: name, value: "", enabled: true },
    );
    head.push(
      el("p", {
        class: "pane-hint",
        text: `地址里有 ${String(pathNames.length)} 个路径变量：URL 中的 :name 会替换成下面的值。`,
      }),
      kvTable({
        rows,
        keyPlaceholder: "参数名",
        valuePlaceholder: "路径变量值（支持 {{变量}}）",
        onChange: () => {
          refreshChrome(
            mutateDraft((r) => {
              r.pathVars = rows;
            }),
          );
        },
        emptyHint: "暂无路径变量",
      }),
    );
  }
  const hint = el("p", {
    class: "pane-hint",
    text: commonHint("query"),
  });
  const table = kvTable({
    rows: tab.request.params,
    keyPlaceholder: "参数名",
    valuePlaceholder: "参数值（支持 {{变量}}）",
    keyList: [],
    onChange: () => {
      refreshChrome(mutateDraft((r) => r.params));
    },
    emptyHint: "暂无查询参数",
  });
  fill(host, ...head, hint, table);
  return host;
}

function headersPane(tab: Tab): HTMLElement {
  const host = el("div", { class: "pane" });
  const hint = el("p", {
    class: "pane-hint",
    text: commonHint("header"),
  });
  const table = kvTable({
    rows: tab.request.headers,
    keyPlaceholder: "头部名称",
    valuePlaceholder: "头部值",
    keyList: COMMON_HEADERS,
    onChange: () => {
      refreshChrome(mutateDraft((r) => r.headers));
    },
    emptyHint: "暂无自定义请求头",
  });
  fill(host, hint, table);
  return host;
}

const BODY_MODES: { value: BodyMode; label: string }[] = [
  { value: "none", label: "无" },
  { value: "json", label: "JSON" },
  { value: "text", label: "纯文本" },
  { value: "urlencoded", label: "表单编码" },
  { value: "form", label: "表单（可含文件）" },
  { value: "binary", label: "二进制文件" },
  { value: "graphql", label: "GraphQL" },
];

function bodyPane(tab: Tab): HTMLElement {
  const host = el("div", { class: "pane" });
  const row = el("div", { class: "pane-toolbar" });
  const modes = el("div", { class: "segmented", attr: { role: "radiogroup", "aria-label": "请求体类型" } });
  for (const mode of BODY_MODES) {
    const active = tab.request.bodyMode === mode.value;
    const btn = el("button", {
      class: `segmented-item${active ? " active" : ""}`,
      attr: { type: "button", role: "radio", "aria-checked": active ? "true" : "false" },
      text: mode.label,
      on: {
        click: () => {
          mutate((r) => {
            // 纯文本与表单编码之间自动搬运内容，粘了 `a=1&b=2` 切过去就是两行字段。
            switchBodyMode(r, mode.value);
          });
          window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
        },
      },
    });
    modes.append(btn);
  }
  row.append(modes);

  if (tab.request.bodyMode === "json" || tab.request.bodyMode === "text") {
    const tools = el("div", { class: "pane-toolbar-right" });
    if (tab.request.bodyMode === "json") {
      const prettyBtn = el("button", {
        class: "link-btn",
        attr: { type: "button" },
        text: "格式化",
        on: {
          click: () => {
            const pretty = prettyJSON(tab.request.body);
            if (!pretty) {
              toast("JSON 语法有错误，无法格式化", "error");
              return;
            }
            mutate((r) => {
              r.body = pretty;
            });
            window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
          },
        },
      });
      const minifyBtn = el("button", {
        class: "link-btn",
        attr: { type: "button" },
        text: "压缩",
        on: {
          click: () => {
            const value = JSON.parse(tab.request.body) as unknown;
            mutate((r) => {
              r.body = JSON.stringify(value);
            });
            window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
          },
        },
      });
      tools.append(prettyBtn, minifyBtn);
    }
    row.append(tools);
  }
  host.append(row);

  if (tab.request.bodyMode === "none") {
    host.append(
      el("div", { class: "pane-empty" }, icon("info"), el("span", { text: "这条请求不发送请求体" })),
    );
    return host;
  }

  if (tab.request.bodyMode === "binary") {
    host.append(binaryBodyPane(tab));
    return host;
  }

  if (tab.request.bodyMode === "graphql") {
    host.append(graphqlBodyPane(tab));
    return host;
  }

  if (tab.request.bodyMode === "form" || tab.request.bodyMode === "urlencoded") {
    const table = kvTable({
      rows: tab.request.form,
      keyPlaceholder: "字段名",
      valuePlaceholder: "字段值",
      multiline: true,
      onChange: () => {
        refreshChrome(mutateDraft((r) => r.form));
      },
      extra: (row) => {
        if (tab.request.bodyMode !== "form") return [];
        if (row.kind === "file") {
          const btn = el("button", {
            class: "link-btn file-btn",
            attr: { type: "button", title: row.fileName ?? "" },
            text: row.fileName ? `${row.fileName}（点击更换）` : "选择文件",
            on: {
              click: async () => {
                const done = await pickFile();
                if (!done) return;
                mutate((r) => {
                  const target = r.form.find((f) => f.id === row.id);
                  if (target) {
                    target.kind = "file";
                    target.fileName = done.name;
                    target.fileSize = done.size;
                    target.fileData = done.data;
                  }
                });
                window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
              },
            },
          });
          return [btn];
        }
        const toggle = iconButton("upload", "改为文件字段", async () => {
          const done = await pickFile();
          mutate((r) => {
            const target = r.form.find((f) => f.id === row.id);
            if (target) {
              target.kind = "file";
              if (done) {
                target.fileName = done.name;
                target.fileSize = done.size;
                target.fileData = done.data;
              }
            }
          });
          window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
        });
        return [toggle];
      },
      emptyHint: "还没有表单字段",
    });
    host.append(table);
    if (tab.request.bodyMode === "form") {
      host.append(
        el("p", { class: "pane-hint", text: "multipart/form-data：Content-Type 由发送时自动生成，包含 boundary。" }),
      );
    }
    return host;
  }

  const editor = codeEditor({
    value: tab.request.body,
    placeholder: tab.request.bodyMode === "json" ? '{\n  "name": "张三"\n}' : "请求体正文，支持 {{变量}}",
    label: "请求体",
    vars: true,
    // 代码框里 Tab 缩进两个空格，不再拿去跳焦点。
    tabIndent: "  ",
    onInput: (value) => {
      refreshChrome(
        mutateDraft((r) => {
          r.body = value;
        }),
      );
      updateJsonStatus(value);
    },
  });
  enableVarAssist(editor, `body:${tab.id}`);

  const status = el("div", { class: "pane-status" });
  const updateJsonStatus = (value: string): void => {
    if (tab.request.bodyMode !== "json") {
      fill(status);
      return;
    }
    if (!value.trim()) {
      fill(status);
      return;
    }
    try {
      JSON.parse(value);
      fill(status, el("span", { class: "ok", text: "JSON 语法正确" }));
    } catch (err) {
      fill(status, el("span", { class: "bad", text: `JSON 语法错误：${(err as Error).message}` }));
    }
  };
  updateJsonStatus(tab.request.body);

  host.append(editor, status);
  return host;
}

/** GraphQL：上面写 query，下面写变量，发送时拼成 {query, variables} 的 JSON。 */
function graphqlBodyPane(tab: Tab): HTMLElement {
  const box = el("div", { class: "graphql-pane" });

  const query = codeEditor({
    value: tab.request.body,
    placeholder: "query ($id: ID!) {\n  user(id: $id) { id name }\n}",
    label: "GraphQL 查询",
    className: "graphql-query",
    vars: true,
    tabIndent: "  ",
    onInput: (value) => {
      refreshChrome(
        mutateDraft((r) => {
          r.body = value;
        }),
      );
    },
  });
  enableVarAssist(query, `gql:${tab.id}`);

  const vars = codeEditor({
    value: tab.request.graphqlVars ?? "",
    placeholder: '{\n  "id": 1\n}',
    label: "GraphQL 变量",
    className: "graphql-vars",
    onInput: (value) => {
      refreshChrome(
        mutateDraft((r) => {
          r.graphqlVars = value;
        }),
      );
      paintVarsStatus(value);
    },
  });

  const status = el("div", { class: "pane-status" });
  const paintVarsStatus = (value: string): void => {
    if (!value.trim()) {
      fill(status);
      return;
    }
    try {
      JSON.parse(value);
      fill(status, el("span", { class: "ok", text: "变量 JSON 语法正确" }));
    } catch (err) {
      fill(status, el("span", { class: "bad", text: `变量 JSON 语法错误：${(err as Error).message}` }));
    }
  };
  paintVarsStatus(vars.value);

  const tools = el("div", { class: "pane-toolbar-right" });
  tools.append(
    el("button", {
      class: "link-btn",
      attr: { type: "button" },
      text: "格式化变量",
      on: {
        click: () => {
          const pretty = prettyJSON(vars.value);
          if (!pretty) {
            toast("变量不是合法 JSON，无法格式化", "error");
            return;
          }
          vars.value = pretty;
          mutate((r) => {
            r.graphqlVars = pretty;
          });
          paintVarsStatus(pretty);
        },
      },
    }),
  );

  const varsHead = el("div", { class: "graphql-head" });
  varsHead.append(el("span", { class: "field-label", text: "变量（JSON）" }), el("span", { class: "spacer" }), tools);

  box.append(
    el("span", { class: "field-label", text: "查询" }),
    query,
    varsHead,
    vars,
    status,
    el("p", {
      class: "pane-hint",
      text: "发送时自动拼成 {query, variables} 并设置 Content-Type: application/json；支持 {{变量}}。",
    }),
  );
  return box;
}

async function pickFile(): Promise<{ name: string; size: number; data: string } | null> {
  try {
    const file = await System.pickFile("选择要上传的文件");
    if (!file.path) return null;
    return { name: file.name, size: file.size, data: file.data };
  } catch (err) {
    toast(`选择文件失败：${(err as Error).message}`, "error");
    return null;
  }
}

/** 把拖进来的 File 读成 base64：走页面 API，不需要弹系统对话框。 */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/** 二进制直传：把整个文件当正文发出去，Content-Type 默认 application/octet-stream。 */
function binaryBodyPane(tab: Tab): HTMLElement {
  const box = el("div", { class: "binary-pane" });
  const file = tab.request.binary;

  // 拖一个文件进来就等于选好文件：省一次系统对话框，也是 e2e 唯一能稳定走通的入口。
  const takeFile = async (dropped: File): Promise<void> => {
    if (dropped.size > FILE_LIMIT) {
      toast(`文件超过 ${formatBytes(FILE_LIMIT)}，暂不支持`, "error");
      return;
    }
    try {
      const data = await readBase64(dropped);
      mutate((r) => {
        r.binary = { name: dropped.name, size: dropped.size, data };
        if (r.bodyMode !== "binary") r.bodyMode = "binary";
      });
      window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
    } catch (err) {
      toast(`读取文件失败：${(err as Error).message}`, "error");
    }
  };
  box.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    box.classList.add("dragging");
  });
  box.addEventListener("dragleave", () => box.classList.remove("dragging"));
  box.addEventListener("drop", (ev) => {
    ev.preventDefault();
    box.classList.remove("dragging");
    const dropped = ev.dataTransfer?.files?.[0];
    if (dropped) void takeFile(dropped);
  });

  const choose = async (): Promise<void> => {
    const done = await pickFile();
    if (!done) return;
    mutate((r) => {
      r.binary = { name: done.name, size: done.size, data: done.data };
    });
    window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
  };

  if (!file) {
    box.append(
      el(
        "div",
        { class: "binary-empty" },
        icon("upload"),
        el("span", { text: "把文件拖到这里，或点右侧按钮选择" }),
        el("button", {
          class: "btn small",
          attr: { type: "button" },
          text: "选择文件",
          on: { click: () => void choose() },
        }),
      ),
    );
    box.append(el("p", { class: "pane-hint", text: "Content-Type 默认 application/octet-stream，可在「请求头」里改成文件的实际类型。" }));
    return box;
  }

  const actions = el("div", { class: "binary-actions" });
  actions.append(
    el("button", {
      class: "link-btn",
      attr: { type: "button" },
      text: "更换",
      on: { click: () => void choose() },
    }),
    el("button", {
      class: "link-btn",
      attr: { type: "button" },
      text: "移除",
      on: {
        click: () => {
          mutate((r) => {
            r.binary = undefined;
          });
          window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
        },
      },
    }),
  );

  box.append(
    el(
      "div",
      { class: "binary-file" },
      icon("file"),
      el(
        "div",
        { class: "binary-meta" },
        el("span", { class: "binary-name", text: file.name }),
        el("span", { class: "muted small", text: formatBytes(file.size) }),
      ),
      actions,
    ),
  );
  if (!file.data) {
    box.append(
      el("p", {
        class: "pane-hint warn-text",
        text: "这个文件的内容还没读进来（例如从 cURL 导入），请重新拖入或选择一次。",
      }),
    );
  }
  box.append(
    el("p", {
      class: "pane-hint",
      text: "整个文件按原始字节发送，不做任何编码；Content-Type 默认 application/octet-stream，也可以拖一个新文件进来替换。",
    }),
  );
  return box;
}

function authPane(tab: Tab): HTMLElement {
  const host = el("div", { class: "pane" });
  const inherited = inheritedFor(tab.origin);

  host.append(
    authEditor(tab.request.auth, {
      update: (recipe) => mutate((r) => recipe(r.auth)),
      rebuild: () => window.dispatchEvent(new CustomEvent("mygo:rerender-request")),
      emptyText:
        inherited.auth && tab.request.auth.type === "none"
          ? "不额外添加认证信息，使用继承来的认证"
          : "不额外添加认证信息",
    }),
  );

  // 自己没有认证但上层有：说清用的是谁的，点一下就能改。
  if (tab.request.auth.type === "none" && inherited.auth && tab.origin) {
    const box = el("div", { class: "inherit-note" });
    box.append(
      icon("info"),
      el("span", {
        text: `继承「${inherited.authFrom}」的认证：${authLabel(inherited.auth.type)}`,
      }),
      el("span", { class: "spacer" }),
      el("button", {
        class: "link-btn",
        attr: { type: "button" },
        text: "编辑共享设置",
        on: {
          click: () =>
            openNodeSettings(tab.origin!.collectionId, inherited.authFromId, inherited.authFrom),
        },
      }),
    );
    host.append(box);
  }
  return host;
}

function optionsPane(tab: Tab): HTMLElement {
  const host = el("div", { class: "pane" });
  const opt = tab.request.options;

  const timeout = el("input", {
    class: "text-input",
    attr: { type: "number", min: "0", step: "1", inputmode: "numeric" },
    on: {
      change: () => {
        const n = Number(timeout.value);
        mutate((r) => {
          r.options.timeoutMs = Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
        });
      },
    },
  });
  timeout.value = String(Math.round(opt.timeoutMs / 1000));

  const redirect = selectBox({
    className: "text-input redirect-select",
    label: "重定向",
    value: opt.redirect,
    menuWidth: 260,
    options: [
      { value: "follow", label: "自动跟随", hint: "最多 20 次" },
      { value: "manual", label: "不跟随", hint: "直接返回 3xx 响应" },
      { value: "error", label: "遇到重定向就报错" },
    ],
    onPick: (value) => {
      mutate((r) => {
        r.options.redirect = value as "follow" | "manual" | "error";
      });
    },
  });

  const proxy = el("input", {
    class: "text-input",
    attr: {
      type: "text",
      placeholder: "留空跟随系统代理，例如 http://127.0.0.1:7897",
      spellcheck: "false",
      "aria-label": "代理地址",
    },
    on: {
      change: () => {
        mutate((r) => {
          r.options.proxy = proxy.value.trim();
        });
      },
    },
  });
  proxy.value = opt.proxy;

  const insecure = el("input", {
    attr: { type: "checkbox" },
    on: {
      change: () => {
        mutate((r) => {
          r.options.insecureTLS = insecure.checked;
        });
      },
    },
  });
  insecure.checked = opt.insecureTLS;

  const cookie = el("input", {
    attr: { type: "checkbox" },
    on: {
      change: () => {
        mutate((r) => {
          r.options.keepCookies = cookie.checked;
        });
      },
    },
  });
  cookie.checked = opt.keepCookies;

  host.append(
    el(
      "div",
      { class: "form-grid" },
      el(
        "label",
        { class: "field" },
        el("span", { class: "field-label", text: "超时（秒）" }),
        timeout,
        el("span", { class: "field-hint", text: "填 0 表示不超时；超时后请求会在 Go 侧中止。" }),
      ),
      el(
        "label",
        { class: "field" },
        el("span", { class: "field-label", text: "重定向" }),
        redirect,
        el("span", { class: "field-hint", text: "选择「不跟随」时能直接看到 3xx 与 Location 头。" }),
      ),
      el(
        "label",
        { class: "field" },
        el("span", { class: "field-label", text: "代理" }),
        proxy,
        el("span", { class: "field-hint", text: "只对这一条请求生效，支持 http / https / socks5。" }),
      ),
      el(
        "label",
        { class: "field checkbox-field" },
        el("label", { class: "checkbox-inline" }, insecure, el("span", { text: "跳过 TLS 证书校验（自签证书环境）" })),
        el("span", { class: "field-hint", text: "开启后不再校验证书链，只建议对本地或内网服务使用。" }),
      ),
      el(
        "div",
        { class: "field checkbox-field cookie-field" },
        el("label", { class: "checkbox-inline" }, cookie, el("span", { text: "保持 Cookie 会话（多次请求共享登录态）" })),
        el("button", {
          class: "link-btn",
          attr: { type: "button" },
          text: "管理 Cookie",
          on: { click: () => toggleUI("cookiesOpen") },
        }),
      ),
    ),
    el("p", {
      class: "pane-hint",
      text: "默认使用系统代理与 HTTPS_PROXY / NO_PROXY 环境变量，无需额外配置。",
    }),
  );
  return host;
}

// ---- cURL 导入 ----

/** 从文本导入 cURL（URL 输入框粘贴时调用）。 */
export function importCurlText(text: string): void {
  void (async () => {
    try {
      const result = parseCurl(text);
      // 空白请求直接盖上去；已经有内容才交给浮层，并带上原文免再粘一次。
      importCurlParsed({ request: result.request, warnings: result.warnings, source: text });
    } catch (err) {
      if (err instanceof CurlError) {
        const where = err.line > 0 ? `第 ${err.line} 行` : "命令";
        toast(`解析失败（${where}）：${err.message}`, "error");
      } else {
        toast(`解析失败：${(err as Error).message}`, "error");
      }
    }
  })();
}
