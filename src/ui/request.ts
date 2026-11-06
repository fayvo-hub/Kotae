// 请求编辑区：方法 + URL + 发送 + cURL 导入导出 + 参数/头/体/认证/选项 五个子页签。

import { el, fill, icon, iconButton, icons } from "./dom";
import { kvTable } from "./kvtable";
import {
  abortSend,
  activeTab,
  applyURL,
  copyText,
  currentCurl,
  mutate,
  send,
  setPendingCurl,
  toast,
  toggleUI,
} from "../store";
import { System } from "../mygo";
import { CurlError, parseCurl } from "../curl";
import { METHODS, type AuthType, type BodyMode, type HttpMethod, type Tab } from "../types";
import { interpolate, normalizeURL, prettyJSON } from "../util";
import { scope as storeScope } from "../store";

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

/** 渲染整块请求编辑区。 */
export function requestPanel(tab: Tab): HTMLElement {
  const wrap = el("section", { class: "request-panel" });
  const row = el("div", { class: "request-tabs-row" });
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

  const methodSelect = el("select", {
    class: `method-select tone-${tab.request.method.toLowerCase()}`,
    attr: { "aria-label": "请求方法" },
    on: {
      change: () => {
        const value = methodSelect.value as HttpMethod;
        mutate((r) => {
          r.method = value;
        });
      },
    },
  });
  for (const m of METHODS) methodSelect.append(el("option", { attr: { value: m }, text: m }));
  methodSelect.value = tab.request.method;

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
      },
      paste: (ev) => {
        const text = ev.clipboardData?.getData("text") ?? "";
        if (/^\s*curl(\.exe)?\s/i.test(text)) {
          ev.preventDefault();
          mutate((r) => r.url);
          importCurlText(text);
        }
      },
      keydown: (ev) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey || !ev.shiftKey)) {
          ev.preventDefault();
          void send();
        }
        if (ev.key === "Enter") urlInput.blur();
      },
      blur: () => {
        const raw = urlInput.value;
        if (!raw.trim()) return;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(raw.trim())) {
          urlInput.value = normalizeURL(raw);
          applyURL(urlInput.value);
          return;
        }
        applyURL(raw);
        setUrlInvalid(urlInput, false);
      },
    },
  });
  urlInput.value = tab.request.url;

  const sendBtn = el("button", {
    class: "btn primary send-btn",
    attr: { type: "button", title: "发送（Ctrl+Enter）" },
    on: { click: () => void send() },
  });
  if (tab.sending) {
    sendBtn.append(el("span", { class: "spinner" }), el("span", { text: "取消" }));
    sendBtn.classList.add("cancelling");
    sendBtn.addEventListener("click", (ev) => {
      ev.stopImmediatePropagation();
      abortSend(tab.id);
    });
  } else {
    sendBtn.append(icon("send"), el("span", { text: "发送" }));
  }

  const curlBtn = el("button", {
    class: "btn",
    attr: { type: "button", title: "导入 cURL 命令（Ctrl+I）" },
    on: { click: () => toggleUI("curlOpen", true) },
  });
  curlBtn.append(icon("terminal"), el("span", { text: "导入 cURL" }));

  const copyCurlBtn = iconButton("copy", "复制为 cURL（Ctrl+Shift+C）", () => {
    void copyText(currentCurl(true), "已复制 cURL 命令");
  });

  const saveBtn = iconButton("save", "保存到集合（Ctrl+S）", () => {
    window.dispatchEvent(new CustomEvent("mygo:save"));
  });

  fill(
    bar,
    el("div", { class: "url-method" }, methodSelect),
    el("div", { class: "url-field" }, urlInput, unresolvedBadge(tab)),
    el("div", { class: "url-actions" }, saveBtn, copyCurlBtn, curlBtn, sendBtn),
  );
  return bar;
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

function tabStrip(tab: Tab): HTMLElement {
  const strip = el("div", { class: "subtabs", attr: { role: "tablist" } });
  const counts = {
    params: tab.request.params.filter((p) => p.enabled && p.key).length,
    headers: tab.request.headers.filter((h) => h.enabled && h.key).length,
    body: 0,
    auth: tab.request.auth.type === "none" ? 0 : 1,
    options: 0,
  };
  const defs: { key: Tab["requestTab"]; label: string; icon: keyof typeof icons }[] = [
    { key: "params", label: "查询参数", icon: "filter" },
    { key: "headers", label: "请求头", icon: "table" },
    { key: "body", label: "请求体", icon: "terminal" },
    { key: "auth", label: "认证", icon: "lock" },
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
          tab.requestTab = def.key;
          window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
        },
      },
    });
    btn.append(icon(def.icon), el("span", { text: def.label }));
    if (badge) btn.append(el("span", { class: "subtab-badge", text: String(badge) }));
    strip.append(btn);
  }
  return strip;
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
    case "options":
      fill(host, optionsPane(tab));
      break;
  }
  return host;
}

function paramsPane(tab: Tab): HTMLElement {
  const host = el("div", { class: "pane" });
  const hint = el("p", {
    class: "pane-hint",
    text: "同名参数会全部发送；勾选框控制是否启用。粘贴带查询串的完整 URL 会自动拆到这里。",
  });
  const table = kvTable({
    rows: tab.request.params,
    keyPlaceholder: "参数名",
    valuePlaceholder: "参数值（支持 {{变量}}）",
    keyList: [],
    onChange: () => {
      mutate((r) => r.params);
      window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
    },
    emptyHint: "暂无查询参数",
  });
  const preview = el("div", { class: "pane-preview" });
  const url = tab.request.url ? buildPreview(tab) : "";
  preview.append(el("span", { class: "pane-preview-label", text: "实际地址" }));
  preview.append(el("code", { text: url || "（尚未填写地址）" }));
  fill(host, hint, table, preview);
  return host;
}

function buildPreview(tab: Tab): string {
  const base = interpolate(tab.request.url, storeScope()).text;
  const pairs = tab.request.params
    .filter((p) => p.enabled && p.key.trim())
    .map(
      (p) =>
        `${encodeURIComponent(interpolate(p.key, storeScope()).text)}=${encodeURIComponent(
          interpolate(p.value, storeScope()).text,
        )}`,
    );
  if (pairs.length === 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${pairs.join("&")}`;
}

function headersPane(tab: Tab): HTMLElement {
  const host = el("div", { class: "pane" });
  const hint = el("p", {
    class: "pane-hint",
    text: "请求由 Go 发出，可写任意请求头（包括 Origin、Referer、User-Agent）。批量粘贴支持 name: value 每行一条。",
  });
  const table = kvTable({
    rows: tab.request.headers,
    keyPlaceholder: "头部名称",
    valuePlaceholder: "头部值",
    keyList: COMMON_HEADERS,
    onChange: () => {
      mutate((r) => r.headers);
      window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
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
            r.bodyMode = mode.value;
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

  if (tab.request.bodyMode === "form" || tab.request.bodyMode === "urlencoded") {
    const table = kvTable({
      rows: tab.request.form,
      keyPlaceholder: "字段名",
      valuePlaceholder: "字段值",
      multiline: true,
      onChange: () => {
        mutate((r) => r.form);
        window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
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

  const area = el("textarea", {
    class: "code-input",
    attr: {
      placeholder:
        tab.request.bodyMode === "json" ? '{\n  "name": "张三"\n}' : "请求体正文，支持 {{变量}}",
      spellcheck: "false",
      "aria-label": "请求体",
    },
    on: {
      input: () => {
        const value = area.value;
        mutate((r) => {
          r.body = value;
        });
        updateJsonStatus(value);
      },
      keydown: (ev) => {
        if (ev.key === "Tab") {
          ev.preventDefault();
          const start = area.selectionStart;
          area.value = `${area.value.slice(0, start)}  ${area.value.slice(area.selectionEnd)}`;
          area.setSelectionRange(start + 2, start + 2);
          const value = area.value;
          mutate((r) => {
            r.body = value;
          });
        }
      },
    },
  });
  area.value = tab.request.body;

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

  const height = Math.min(420, Math.max(140, (tab.request.body.split("\n").length + 2) * 20));
  area.style.minHeight = `${height}px`;
  host.append(area, status);
  return host;
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

const AUTH_TYPES: { value: AuthType; label: string }[] = [
  { value: "none", label: "无认证" },
  { value: "bearer", label: "Bearer Token" },
  { value: "basic", label: "Basic 用户名密码" },
  { value: "apikey", label: "API Key" },
];

function authPane(tab: Tab): HTMLElement {
  const host = el("div", { class: "pane" });
  const auth = tab.request.auth;
  const row = el("div", { class: "pane-toolbar" });
  const seg = el("div", { class: "segmented", attr: { role: "radiogroup", "aria-label": "认证方式" } });
  for (const t of AUTH_TYPES) {
    const active = auth.type === t.value;
    seg.append(
      el("button", {
        class: `segmented-item${active ? " active" : ""}`,
        attr: { type: "button", role: "radio", "aria-checked": active ? "true" : "false" },
        text: t.label,
        on: {
          click: () => {
            mutate((r) => {
              r.auth.type = t.value;
            });
            window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
          },
        },
      }),
    );
  }
  row.append(seg);
  host.append(row);

  const form = el("div", { class: "form-grid" });
  const field = (
    label: string,
    value: string,
    placeholder: string,
    onInput: (v: string) => void,
    type = "text",
  ): HTMLElement => {
    const input = el("input", {
      class: "text-input",
      attr: { placeholder, type, spellcheck: "false", autocomplete: "off" },
      on: {
        input: () => onInput(input.value),
      },
    });
    input.value = value;
    return el("label", { class: "field" }, el("span", { class: "field-label", text: label }), input);
  };

  if (auth.type === "none") {
    host.append(
      el("div", { class: "pane-empty" }, icon("info"), el("span", { text: "不额外添加认证信息" })),
    );
    return host;
  }
  if (auth.type === "bearer") {
    // 只有 Token 一个字段时让它独占整行，避免左半边输入框看着像没填完。
    form.classList.add("form-single");
    form.append(
      field(
        "Token",
        auth.token,
        "粘贴 token，支持 {{token}}",
        (v) => mutate((r) => (r.auth.token = v)),
      ),
      el("p", {
        class: "field-hint",
        text: "发送时会加上 Authorization: Bearer <token> 请求头。",
      }),
    );
  }
  if (auth.type === "basic") {
    form.append(
      field(
        "用户名",
        auth.username,
        "username",
        (v) => mutate((r) => (r.auth.username = v)),
      ),
      field(
        "密码",
        auth.password,
        "password",
        (v) => mutate((r) => (r.auth.password = v)),
        "password",
      ),
      el("p", { class: "field-hint", text: "发送时会加上 Authorization: Basic base64(用户名:密码)。" }),
    );
  }
  if (auth.type === "apikey") {
    form.append(
      field("名称", auth.key, "例如 X-Api-Key", (v) => mutate((r) => (r.auth.key = v))),
      field("值", auth.value, "支持 {{变量}}", (v) => mutate((r) => (r.auth.value = v))),
    );
    const seg2 = el("div", { class: "segmented small" });
    for (const where of [
      { value: "header" as const, label: "放在请求头" },
      { value: "query" as const, label: "放在查询参数" },
    ]) {
      seg2.append(
        el("button", {
          class: `segmented-item${auth.in === where.value ? " active" : ""}`,
          attr: { type: "button" },
          text: where.label,
          on: {
            click: () => {
              mutate((r) => {
                r.auth.in = where.value;
              });
              window.dispatchEvent(new CustomEvent("mygo:rerender-request"));
            },
          },
        }),
      );
    }
    form.append(seg2);
  }
  host.append(form);
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

  const redirect = el("select", {
    class: "text-input",
    on: {
      change: () => {
        const value = redirect.value as "follow" | "manual" | "error";
        mutate((r) => {
          r.options.redirect = value;
        });
      },
    },
  });
  for (const item of [
    { value: "follow", label: "自动跟随（最多 20 次）" },
    { value: "manual", label: "不跟随，直接返回 3xx 响应" },
    { value: "error", label: "遇到重定向就报错" },
  ]) {
    redirect.append(el("option", { attr: { value: item.value }, text: item.label }));
  }
  redirect.value = opt.redirect;

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
        { class: "field checkbox-field" },
        cookie,
        el("span", { text: "保持 Cookie 会话（多次请求共享登录态）" }),
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
      setPendingCurl({ request: result.request, warnings: result.warnings });
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
