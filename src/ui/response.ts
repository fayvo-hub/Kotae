// 响应查看区：状态横幅、响应体（JSON 树 / 原始 / 美化）、响应头、保存、复制、搜索。

import { el, fill, icon, iconButton } from "./dom";
import { highlightMarkup, highlightText, jsonTree, looksJson, setTreeExpanded } from "./jsonview";
import { System } from "../mygo";
import type { ResponseRecord, SentRecord, Tab } from "../types";
import { copyText, toast } from "../store";
import { formatBytes, formatDuration } from "../util";
import { prettyJSON } from "../util";

/** 渲染响应区。没有响应时显示占位提示。 */
export function responsePanel(tab: Tab): HTMLElement {
  const wrap = el("section", { class: "response-panel" });
  const res = tab.response;

  if (tab.sending) {
    fill(
      wrap,
      el(
        "div",
        { class: "response-empty" },
        el("span", { class: "spinner big" }),
        el("p", { text: "正在发送请求…" }),
        el("p", { class: "muted", text: "接口较慢时可以点「取消」中止，或等待超时。" }),
      ),
    );
    return wrap;
  }

  if (!res) {
    fill(
      wrap,
      el(
        "div",
        { class: "response-empty" },
        icon("send"),
        el("p", { text: "还没有响应" }),
        el("p", { class: "muted", text: "按 Ctrl+Enter 或点「发送」开始第一次请求。" }),
      ),
    );
    return wrap;
  }

  fill(wrap, statusBar(tab, res), res.error ? errorPane(res) : resTabs(tab, res));
  return wrap;
}

function statusBar(tab: Tab, res: ResponseRecord): HTMLElement {
  const bar = el("div", { class: "status-bar" });

  const tone = res.error
    ? "error"
    : res.status >= 200 && res.status < 300
      ? "ok"
      : res.status >= 300 && res.status < 400
        ? "redirect"
        : "bad";

  const code = el("div", { class: `status-code tone-${tone}` });
  code.append(el("span", { class: "status-num", text: res.error ? "失败" : String(res.status) }));
  if (res.statusText) code.append(el("span", { class: "status-text", text: res.statusText }));

  const meta = el("div", { class: "status-meta" });
  meta.append(chip("耗时", formatDuration(res.durationMs)));
  if (!res.error) {
    meta.append(chip("大小", formatBytes(res.bytes)));
    meta.append(chip("类型", res.contentType || "未知"));
  }
  if (res.redirected) meta.append(chip("提示", "跟随了重定向"));

  const actions = el("div", { class: "status-actions" });
  if (!res.error) {
    if (res.binary && res.base64) {
      actions.append(
        iconButton("download", "保存为文件", () => void saveBody(tab, res)),
      );
    } else {
      actions.append(
        iconButton("copy", "复制响应体", () => {
          void copyText(res.body, "已复制响应体");
        }),
      );
      actions.append(iconButton("download", "保存为文件", () => void saveBody(tab, res)));
    }
  }
  actions.append(
    iconButton("refresh", "重新发送（Ctrl+Enter）", () => {
      window.dispatchEvent(new CustomEvent("mygo:send"));
    }),
  );

  fill(bar, code, meta, actions);
  return bar;
}

function chip(label: string, value: string): HTMLElement {
  const c = el("span", { class: "chip" });
  if (label) c.append(el("span", { class: "chip-label", text: label }));
  c.append(el("span", { class: "chip-value", text: value }));
  return c;
}

function errorPane(res: ResponseRecord): HTMLElement {
  const wrap = el("div", { class: "response-body" });
  const card = el("div", { class: `error-card tone-${res.errorKind ?? "network"}` });
  card.append(icon("warn"));
  const text = el("div", { class: "error-text" });
  text.append(el("strong", { text: res.error ?? "请求失败" }));
  if (res.errorKind === "timeout") {
    text.append(
      el("p", {
        class: "muted",
        text: "可以在「选项」页把超时时间调大，或填 0 关闭超时。",
      }),
    );
  }
  if (res.errorKind === "network") {
    text.append(
      el("p", { class: "muted", text: "检查地址、端口、服务是否启动，以及系统代理是否拦截了该地址。" }),
    );
  }
  card.append(text);
  wrap.append(card);
  return wrap;
}

function resTabs(tab: Tab, res: ResponseRecord): HTMLElement {
  const wrap = el("div", { class: "response-body" });

  const strip = el("div", { class: "subtabs response-subtabs" });
  const tabs: { key: Tab["responseTab"]; label: string; count: number }[] = [
    { key: "body", label: "响应体", count: 0 },
    { key: "headers", label: "响应头", count: res.headers.length },
    { key: "request", label: "请求", count: tab.sent ? tab.sent.headers.length : 0 },
  ];
  for (const t of tabs) {
    const active = tab.responseTab === t.key;
    const btn = el("button", {
      class: `subtab${active ? " active" : ""}`,
      attr: { type: "button" },
      on: {
        click: () => {
          tab.responseTab = t.key;
          window.dispatchEvent(new CustomEvent("mygo:rerender-response"));
        },
      },
    });
    btn.append(el("span", { text: t.label }));
    if (t.count) btn.append(el("span", { class: "subtab-badge", text: String(t.count) }));
    strip.append(btn);
  }

  const tools = el("div", { class: "response-tools" });
  if (tab.responseTab === "body") {
    tools.append(bodyTools(tab, res));
  }
  strip.append(el("span", { class: "spacer" }), tools);

  wrap.append(strip);
  if (tab.responseTab === "body") wrap.append(bodyView(tab, res));
  else if (tab.responseTab === "headers") wrap.append(headersView(tab, res));
  else wrap.append(requestView(tab));
  return wrap;
}

/** 「请求」页签：实际发出去的方法、地址、头与体，出问题时先看这里。 */
function requestView(tab: Tab): HTMLElement {
  const host = el("div", { class: "body-view headers-view" });
  const sent = tab.sent;
  if (!sent) {
    fill(
      host,
      el(
        "div",
        { class: "response-empty" },
        icon("send"),
        el("p", { text: "还没有发送过请求" }),
        el("p", { class: "muted", text: "发送一次后，这里会显示实际发出的方法、地址、请求头与请求体。" }),
      ),
    );
    return host;
  }

  const head = el("div", { class: "sent-head" });
  head.append(el("span", { class: `method-tag tone-${sent.method.toLowerCase()}`, text: sent.method }));
  head.append(el("span", { class: "sent-url", attr: { title: sent.url }, text: sent.url }));
  head.append(
    el("span", { class: "muted small", text: sentAt(sent.at) }),
    el("button", {
      class: "link-btn",
      attr: { type: "button" },
      text: "复制地址",
      on: { click: () => void copyText(sent.url, "已复制实际地址") },
    }),
  );
  host.append(head);
  host.append(sentHeaders(sent));
  host.append(sentBody(sent));
  host.append(sentOptions(sent));
  return host;
}

function sentAt(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} 发出`;
}

function sentSection(text: string, extra: HTMLElement[] = []): HTMLElement {
  const row = el("div", { class: "sent-section" });
  row.append(el("span", { text }));
  row.append(el("span", { class: "spacer" }));
  for (const node of extra) row.append(node);
  return row;
}

function sentRows(rows: [string, string][], copyHint?: (key: string, value: string) => string): HTMLElement {
  const list = el("div", { class: "headers-list" });
  for (const [key, value] of rows) {
    const row = el("div", { class: "header-row" });
    row.append(el("span", { class: "header-key", text: key }));
    row.append(el("span", { class: "header-value", text: value }));
    if (copyHint) {
      const line = copyHint(key, value);
      row.append(
        iconButton("copy", "复制这一条", () => {
          void copyText(line);
        }),
      );
    }
    list.append(row);
  }
  return list;
}

function sentHeaders(sent: SentRecord): HTMLElement {
  const box = el("div");
  const copyAll = el("button", {
    class: "link-btn",
    attr: { type: "button" },
    text: "复制全部",
    on: {
      click: () => {
        void copyText(sent.headers.map(([k, v]) => `${k}: ${v}`).join("\n"), "已复制请求头");
      },
    },
  });
  box.append(sentSection(`请求头 ${sent.headers.length}`, [copyAll]));
  if (sent.headers.length === 0) {
    box.append(el("p", { class: "muted small", text: "本次请求没有设置任何请求头。" }));
    return box;
  }
  box.append(sentRows(sent.headers, (k, v) => `${k}: ${v}`));
  return box;
}

function sentBody(sent: SentRecord): HTMLElement {
  const box = el("div");
  const body = sent.body;
  if (body.kind === "none") {
    box.append(sentSection("请求体"));
    box.append(el("p", { class: "muted small", text: "本次请求没有请求体（GET/HEAD，或请求体形态选了「无」）。" }));
    return box;
  }

  if (body.kind === "text") {
    const label = `请求体 · ${body.contentType || "未设置 Content-Type"} · ${body.chars} 字符${
      body.truncated ? "（已截断）" : ""
    }`;
    const copy = el("button", {
      class: "link-btn",
      attr: { type: "button" },
      text: "复制",
      on: { click: () => void copyText(body.text, "已复制请求体") },
    });
    box.append(sentSection(label, [copy]));
    box.append(el("pre", { class: "sent-body", text: body.text }));
    if (body.truncated) {
      box.append(el("p", { class: "muted small", text: "请求体超过 64 KB，这里只保留前 64 KB。" }));
    }
    return box;
  }

  const rows: [string, string][] = [...body.fields];
  for (const f of body.files) rows.push([f.key, `${f.name} · ${formatBytes(f.size)}`]);
  const label = `请求体 · ${body.contentType === "multipart/form-data" ? "multipart/form-data（boundary 由发送时生成）" : body.contentType} · ${rows.length} 项`;
  box.append(sentSection(label));
  if (rows.length === 0) {
    box.append(el("p", { class: "muted small", text: "请求体里没有任何启用的字段。" }));
    return box;
  }
  box.append(sentRows(rows));
  return box;
}

function sentOptions(sent: SentRecord): HTMLElement {
  const redirects: Record<SentRecord["redirect"], string> = {
    follow: "自动跟随（最多 20 次）",
    manual: "不跟随（拿到 3xx 与 Location）",
    error: "遇到重定向即报错",
  };
  const auths: Record<SentRecord["authType"], string> = {
    none: "无认证",
    bearer: "Bearer Token（写入 Authorization）",
    basic: "Basic 用户名密码（写入 Authorization）",
    apikey: "API Key（头部或查询串）",
  };
  const rows: [string, string][] = [
    ["超时", sent.timeoutMs > 0 ? `${sent.timeoutMs} ms` : "不超时"],
    ["重定向", redirects[sent.redirect]],
    ["Cookie", sent.keepCookies ? "保留（多次请求共享登录态）" : "不保留"],
    ["认证", auths[sent.authType]],
  ];
  const box = el("div");
  box.append(sentSection("本次选项"));
  box.append(sentRows(rows));
  return box;
}

function bodyTools(tab: Tab, res: ResponseRecord): HTMLElement {
  const tools = el("div", { class: "tools-row" });
  if (res.binary) {
    tools.append(el("span", { class: "muted small", text: "二进制响应，无法以文本预览，可保存后查看" }));
    return tools;
  }

  const json = looksJson(res.body, res.contentType);
  const seg = el("div", { class: "segmented small" });
  if (json) {
    for (const v of [
      { key: "pretty" as const, label: "结构化" },
      { key: "raw" as const, label: "原始" },
    ]) {
      seg.append(
        el("button", {
          class: `segmented-item${tab.bodyView === v.key ? " active" : ""}`,
          attr: { type: "button" },
          text: v.label,
          on: {
            click: () => {
              tab.bodyView = v.key;
              window.dispatchEvent(new CustomEvent("mygo:rerender-response"));
            },
          },
        }),
      );
    }
    tools.append(seg);
    // 默认只展开前几层，剩下的一键搞定（原始视图下没有树，不显示）。
    if (tab.bodyView === "pretty") {
      const treeHost = (): HTMLElement | null => document.querySelector<HTMLElement>(".json-host");
      for (const [label, open] of [
        ["展开全部", true],
        ["收起全部", false],
      ] as [string, boolean][]) {
        tools.append(
          el("button", {
            class: "link-btn",
            attr: { type: "button" },
            text: label,
            on: {
              click: () => {
                const host = treeHost();
                if (host) setTreeExpanded(host, open);
              },
            },
          }),
        );
      }
    }
  } else if (/html|xml|svg/i.test(res.contentType)) {
    for (const v of [
      { key: "pretty" as const, label: "高亮" },
      { key: "raw" as const, label: "纯文本" },
    ]) {
      seg.append(
        el("button", {
          class: `segmented-item${tab.bodyView === v.key ? " active" : ""}`,
          attr: { type: "button" },
          text: v.label,
          on: {
            click: () => {
              tab.bodyView = v.key;
              window.dispatchEvent(new CustomEvent("mygo:rerender-response"));
            },
          },
        }),
      );
    }
    tools.append(seg);
  }

  const search = el("input", {
    class: "search-input small",
    attr: { placeholder: "在响应体中查找（Ctrl+F）", spellcheck: "false", "aria-label": "查找响应体" },
    on: {
      input: () => {
        tab.search = search.value;
        window.dispatchEvent(new CustomEvent("mygo:rerender-response-body"));
      },
      keydown: (ev) => {
        if (ev.key === "Escape") {
          search.value = "";
          tab.search = "";
          window.dispatchEvent(new CustomEvent("mygo:rerender-response"));
        }
      },
    },
  });
  search.value = tab.search;
  search.dataset.role = "body-search";
  tools.append(search);

  if (res.truncated) {
    tools.append(
      el("span", {
        class: "muted small",
        text: `响应体超过 2 MB，仅预览前 2 MB（共 ${formatBytes(res.bytes)}）`,
      }),
    );
  }
  return tools;
}

function bodyView(tab: Tab, res: ResponseRecord): HTMLElement {
  const host = el("div", { class: "body-view" });
  if (res.binary) {
    fill(
      host,
      el(
        "div",
        { class: "response-empty" },
        icon("download"),
        el("p", { text: "二进制响应" }),
        el("p", { class: "muted", text: `${formatBytes(res.bytes)} · ${res.contentType || "未知类型"}` }),
      ),
    );
    return host;
  }
  if (!res.body) {
    fill(host, el("div", { class: "response-empty" }, el("p", { class: "muted", text: "响应体为空" })));
    return host;
  }

  const json = looksJson(res.body, res.contentType);
  const pre = el("div", { class: "code-view", attr: { tabindex: "0" } });

  if (json) {
    if (tab.bodyView === "pretty") {
      const parsed = JSON.parse(res.body) as unknown;
      pre.classList.add("json-host");
      pre.append(jsonTree(parsed, { search: tab.search }));
    } else {
      const pretty = prettyJSON(res.body) ?? res.body;
      pre.append(el("pre", { html: highlightText(pretty, tab.search) }));
    }
  } else if (/html|xml|svg/i.test(res.contentType) && tab.bodyView === "pretty") {
    pre.append(el("pre", { html: highlightMarkup(res.body, tab.search) }));
  } else {
    pre.append(el("pre", { html: highlightText(res.body, tab.search) }));
  }

  host.append(pre);
  return host;
}

function headersView(tab: Tab, res: ResponseRecord): HTMLElement {
  const host = el("div", { class: "body-view headers-view" });
  const tools = el("div", { class: "tools-row" });
  const search = el("input", {
    class: "search-input small",
    attr: { placeholder: "筛选响应头", spellcheck: "false", "aria-label": "筛选响应头" },
    on: {
      input: () => {
        filterRows(search.value);
      },
    },
  });
  tools.append(search);
  tools.append(
    el("button", {
      class: "link-btn",
      attr: { type: "button" },
      text: "复制全部",
      on: {
        click: () => {
          const text = res.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
          void copyText(text, "已复制全部响应头");
        },
      },
    }),
  );
  host.append(tools);

  const list = el("div", { class: "headers-list" });
  for (const [key, value] of res.headers) {
    const row = el("div", { class: "header-row", data: { search: `${key} ${value}`.toLowerCase() } });
    row.append(el("span", { class: "header-key", text: key }));
    row.append(el("span", { class: "header-value", text: value }));
    row.append(
      iconButton("copy", "复制这一条", () => {
        void copyText(`${key}: ${value}`);
      }),
    );
    list.append(row);
  }
  if (res.headers.length === 0) {
    list.append(el("div", { class: "response-empty" }, el("p", { class: "muted", text: "没有响应头" })));
  }

  const filterRows = (query: string): void => {
    const q = query.trim().toLowerCase();
    for (const row of list.querySelectorAll<HTMLElement>(".header-row")) {
      const hay = row.dataset.search ?? "";
      row.style.display = !q || hay.includes(q) ? "" : "none";
    }
  };
  host.append(list);
  return host;
}

async function saveBody(tab: Tab, res: ResponseRecord): Promise<void> {
  const name = suggestedFileName(tab, res);
  try {
    // 二进制响应直接把原始字节写盘，不能把 base64 文本当文件存。
    const saved =
      res.binary && res.base64
        ? await System.saveBase64(name, res.base64)
        : await System.saveText(name, res.body);
    if (saved) toast(`已保存到 ${saved}`, "success");
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, "error");
  }
}

function suggestedFileName(tab: Tab, res: ResponseRecord): string {
  const ct = res.contentType.toLowerCase();
  const ext = ct.includes("json")
    ? "json"
    : ct.includes("html")
      ? "html"
      : ct.includes("xml")
        ? "xml"
        : ct.includes("csv")
          ? "csv"
          : ct.startsWith("image/png")
            ? "png"
            : ct.startsWith("image/jpeg")
              ? "jpg"
              : "txt";
  const base = tab.name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 40) || "response";
  return `${base}.${ext}`;
}
