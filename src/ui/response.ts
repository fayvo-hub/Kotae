// 响应查看区：状态横幅、响应体（JSON 树 / 原始 / 美化）、响应头、保存、复制、搜索。

import { el, fill, icon, iconButton } from "./dom";
import { highlightMarkup, highlightText, jsonTree, looksJson, setTreeExpanded } from "./jsonview";
import { System } from "../mygo";
import type {
  RequestProtocol,
  ResponseRecord,
  ResponseTrace,
  ScriptRun,
  SentRecord,
  StreamMessage,
  StreamSession,
  StreamState,
  Tab,
} from "../types";
import { clearStreamMessages, copyText, sendStreamMessage, toast } from "../store";
import { scriptPhaseLabel } from "../script";
import { formatBytes, formatDuration } from "../util";
import { prettyJSON } from "../util";

/** 渲染响应区。没有响应时显示占位提示。 */
export function responsePanel(tab: Tab): HTMLElement {
  const wrap = el("section", { class: "response-panel" });
  const protocol = tab.request.protocol ?? "http";

  if (protocol !== "http") {
    if (tab.stream) {
      fill(wrap, streamPanel(tab, tab.stream, protocol));
    } else {
      fill(wrap, streamEmpty(protocol));
    }
    return wrap;
  }

  const res = tab.response;
  const runs = tab.scriptRuns ?? [];

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

  fill(wrap, statusBar(tab, res), resTabs(tab, res, runs));
  return wrap;
}

/** 「控制台」页签：脚本输出、断言与报错都收在这里，不再占响应区顶上的一条带。 */
function consoleView(runs: ScriptRun[]): HTMLElement {
  if (runs.length === 0) {
    return el(
      "div",
      { class: "body-view console-view" },
      el(
        "div",
        { class: "response-empty" },
        icon("code"),
        el("p", { text: "还没有脚本输出" }),
        el("p", {
          class: "muted",
          text: "在「前置操作 / 后置操作」里加一步脚本，发送后这里会显示 console 输出、断言结果与耗时。",
        }),
      ),
    );
  }
  return el("div", { class: "body-view console-view" }, scriptLog(runs));
}

/** 脚本执行记录：每条脚本一行摘要，下面跟 console 输出与报错。 */
function scriptLog(runs: ScriptRun[]): HTMLElement {
  const box = el("section", { class: "script-log" });
  for (const run of runs) {
    const head = el("div", { class: "script-log-head" });
    const phase = `${scriptPhaseLabel(run.phase)}脚本`;
    // 一次发送可能跑好几条脚本，只写「前置/后置」分不清是哪一条在说话。
    const who = [run.name?.trim(), run.scopeName, phase].filter((part): part is string => !!part);
    head.append(
      el("span", { class: "script-log-phase", text: who.join(" · ") }),
      el("span", { class: "script-log-ms", text: `${run.ms} ms` }),
    );
    if (run.bodyEdited) head.append(el("span", { class: "script-log-tag", text: "已改写响应体" }));
    const tests = run.tests ?? [];
    if (tests.length > 0) {
      const passed = tests.filter((t) => t.passed).length;
      head.append(
        el("span", {
          class: `script-log-tag${passed === tests.length ? "" : " bad"}`,
          text: `断言 ${String(passed)}/${String(tests.length)}`,
        }),
      );
    }
    if (run.error) head.append(el("span", { class: "script-log-error", text: run.error }));
    const body = el("div", { class: "script-log-body" });
    for (const log of run.logs) {
      body.append(el("div", { class: `script-log-line ${log.level}`, text: log.text }));
    }
    for (const t of tests) {
      body.append(
        el(
          "div",
          { class: `script-test ${t.passed ? "pass" : "fail"}` },
          el("span", { class: "script-test-icon", text: t.passed ? "✓" : "✗" }),
          el("span", { class: "script-test-name", text: t.name }),
          t.error ? el("span", { class: "script-test-error", text: t.error }) : null,
        ),
      );
    }
    box.append(el("div", { class: `script-log-run${run.error ? " has-error" : ""}` }, head, body));
  }
  return box;
}

// ---- SSE / WebSocket ----

const STREAM_STATE_TEXT: Record<StreamState, string> = {
  idle: "未连接",
  connecting: "连接中",
  open: "已连接",
  closed: "已断开",
  error: "连接失败",
};

const DIR_TEXT: Record<StreamMessage["dir"], string> = { in: "收", out: "发", sys: "系统" };

/** WebSocket 发送框的草稿：新消息触发重渲染后，草稿与焦点都不丢。 */
const composerDrafts = new Map<string, string>();

function streamEmpty(protocol: RequestProtocol): HTMLElement {
  const ws = protocol === "ws";
  return el(
    "div",
    { class: "response-empty" },
    icon(ws ? "dot" : "send"),
    el("p", { text: ws ? "还没有建立 WebSocket 连接" : "还没有建立 SSE 连接" }),
    el("p", {
      class: "muted",
      text: ws
        ? "点「连接」后由 Go 侧完成握手，请求头里可以写 Authorization、Cookie。"
        : "点「连接」后服务端推来的每条事件都会实时追加到下面。",
    }),
  );
}

function streamClock(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

function streamPanel(tab: Tab, session: StreamSession, protocol: RequestProtocol): HTMLElement {
  const box = el("div", { class: "stream-panel" });
  const live = session.state === "connecting" || session.state === "open";

  // 上一次渲染的滚动位置：贴底时继续贴底，往上翻的时候不往回弹。
  const old = document.querySelector<HTMLElement>(".stream-log");
  const stickToBottom = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 48;
  const oldTop = old?.scrollTop ?? 0;
  const composerFocused = document.activeElement?.classList.contains("stream-composer-input") ?? false;

  const head = el("div", { class: "stream-head" });
  head.append(
    el(
      "span",
      { class: `stream-state state-${session.state}` },
      icon("dot"),
      el("span", { text: STREAM_STATE_TEXT[session.state] }),
    ),
    el("span", {
      class: "stream-url",
      attr: { title: session.meta?.url ?? "" },
      text: session.meta?.url ?? "—",
    }),
  );
  if (session.meta && protocol === "sse") {
    head.append(
      el("span", { class: "stream-chip", text: `${session.meta.status} ${session.meta.statusText}`.trim() }),
    );
  }
  if (session.meta?.protocol) {
    head.append(el("span", { class: "stream-chip", text: `子协议 ${session.meta.protocol}` }));
  }
  if (session.durationMs !== undefined) {
    head.append(el("span", { class: "stream-chip", text: formatDuration(session.durationMs) }));
  }
  head.append(el("span", { class: "stream-chip", text: `${session.messages.length} 条` }));
  head.append(el("span", { class: "stream-spacer" }));
  head.append(
    iconButton("copy", "复制全部消息", () => {
      const text = session.messages
        .map((m) => `[${streamClock(m.at)}] ${DIR_TEXT[m.dir]} ${m.kind}\n${m.text}`)
        .join("\n\n");
      if (!text) {
        toast("还没有消息可复制", "error");
        return;
      }
      void copyText(text, `已复制 ${session.messages.length} 条消息`);
    }),
    iconButton("trash", "清空消息", () => clearStreamMessages(tab.id)),
  );
  box.append(head);

  if (session.error) {
    box.append(el("div", { class: "stream-error" }, icon("warn"), el("span", { text: session.error })));
  }

  const log = el("div", { class: "stream-log" });
  if (session.messages.length === 0) {
    log.append(
      el(
        "div",
        { class: "stream-waiting" },
        icon("info"),
        el("span", { text: live ? "已连接，等待服务端消息…" : "还没有收到消息" }),
      ),
    );
  }
  for (const msg of session.messages) {
    const row = el("div", { class: `stream-row dir-${msg.dir}` });
    const rowHead = el("div", { class: "stream-row-head" });
    rowHead.append(
      el("span", { class: `stream-dir dir-${msg.dir}`, text: DIR_TEXT[msg.dir] }),
      el("span", { class: "stream-kind", text: msg.kind }),
      el("span", { class: "stream-time", text: streamClock(msg.at) }),
    );
    row.append(rowHead, el("pre", { class: "stream-text", text: msg.text }));
    log.append(row);
  }
  box.append(log);

  if (protocol === "ws") {
    const input = el("textarea", {
      class: "stream-composer-input",
      attr: {
        placeholder: live ? "输入要发送的消息，Enter 发送，Shift+Enter 换行" : "连接建立后才能发送消息",
        rows: "2",
        spellcheck: "false",
        "aria-label": "要发送的消息",
      },
      on: {
        input: () => composerDrafts.set(tab.id, input.value),
        keydown: (ev) => {
          if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
            ev.preventDefault();
            submit();
          }
        },
      },
    });
    input.value = composerDrafts.get(tab.id) ?? "";
    const submit = (): void => {
      if (!input.value.trim()) return;
      sendStreamMessage(input.value);
      input.value = "";
      composerDrafts.set(tab.id, "");
    };
    const submitBtn = el("button", { class: "btn primary stream-send", attr: { type: "button" }, on: { click: submit } });
    submitBtn.append(icon("send"), el("span", { text: "发送" }));
    if (!live) submitBtn.disabled = true;
    box.append(el("div", { class: "stream-composer" }, input, submitBtn));
  }

  requestAnimationFrame(() => {
    const node = document.querySelector<HTMLElement>(".stream-log");
    if (node) node.scrollTop = stickToBottom ? node.scrollHeight : oldTop;
    if (composerFocused && protocol === "ws") {
      const area = document.querySelector<HTMLTextAreaElement>(".stream-composer-input");
      if (area) {
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      }
    }
  });

  return box;
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
  // 耗时拆成两段：慢在建立连接/等服务端，还是慢在传正文。
  meta.append(
    chip(
      "耗时",
      formatDuration(res.durationMs),
      `等待响应 ${formatDuration(res.waitMs)} · 下载正文 ${formatDuration(res.downloadMs)}`,
    ),
  );
  if (!res.error) {
    const lastHop = res.trace?.hops[res.trace.hops.length - 1];
    if (lastHop?.addr) {
      // 域名只是输入：到底连到哪台机器由对端地址说了算。改过 hosts / DNS 之后
      // 页面上的地址不会变，只能靠这一项判断请求是不是还连着旧地址。
      meta.append(
        lastHop.viaProxy
          ? chip("经代理", lastHop.addr, "这条请求经代理转发，显示的是代理地址；目标服务器由代理解析。")
          : chip("服务器", lastHop.addr, "这条请求实际连上的服务器地址（IP:端口）。"),
      );
    }
    meta.append(chip("大小", formatBytes(res.bytes)));
    meta.append(chip("类型", res.contentType || "未知"));
  }
  if (res.redirected) {
    meta.append(
      chip("重定向", "已跟随", `请求被重定向过，最终地址：${res.url || "未知"}`),
    );
  }

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

function chip(label: string, value: string, title?: string): HTMLElement {
  const c = el("span", { class: "chip", attr: title ? { title } : {} });
  if (label) c.append(el("span", { class: "chip-label", text: label }));
  c.append(el("span", { class: "chip-value", text: value }));
  return c;
}

function errorView(res: ResponseRecord): HTMLElement {
  const wrap = el("div", { class: "body-view error-view" });
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

function resTabs(tab: Tab, res: ResponseRecord, runs: ScriptRun[]): HTMLElement {
  const wrap = el("div", { class: "response-body" });

  const strip = el("div", { class: "subtabs response-subtabs" });
  const tabs: { key: Tab["responseTab"]; label: string; count: number; bad?: boolean }[] = [
    { key: "body", label: "响应体", count: 0 },
    { key: "headers", label: "响应头", count: res.headers.length },
    { key: "request", label: "请求", count: tab.sent ? tab.sent.headers.length : 0 },
  ];
  if (res.trace) tabs.push({ key: "trace", label: "链路", count: res.trace.hops.length });
  // 脚本输出收进「控制台」页签：有报错或断言没过时徽标变红，用户不用挨个点开找。
  const scriptTrouble = runs.some(
    (run) => Boolean(run.error) || (run.tests ?? []).some((test) => !test.passed),
  );
  tabs.push({ key: "console", label: "控制台", count: runs.length, bad: scriptTrouble });
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
    if (t.count) {
      btn.append(el("span", { class: `subtab-badge${t.bad ? " bad" : ""}`, text: String(t.count) }));
    }
    strip.append(btn);
  }

  const tools = el("div", { class: "response-tools" });
  if (tab.responseTab === "body") {
    tools.append(bodyTools(tab, res));
  }
  strip.append(el("span", { class: "spacer" }), tools);

  wrap.append(strip);
  let content: HTMLElement;
  if (tab.responseTab === "body") content = res.error ? errorView(res) : bodyView(tab, res);
  else if (tab.responseTab === "headers") content = headersView(tab, res);
  else if (tab.responseTab === "trace" && res.trace) content = traceView(res.trace);
  else if (tab.responseTab === "console") content = consoleView(runs);
  else content = requestView(tab);
  wrap.append(content);
  if (tab.responseTab === "body") applySearchHits(tab, wrap);
  return wrap;
}

/** 在命中之间移动：总数从当前渲染里数，序号记在标签页上，重绘后落成高亮。 */
function stepSearchHit(tab: Tab, step: number): void {
  const total = document.querySelectorAll(".response-body .code-view mark").length;
  if (total === 0) return;
  tab.searchIndex = ((tab.searchIndex ?? 0) + step + total) % total;
  window.dispatchEvent(new CustomEvent("mygo:rerender-response-body"));
}

/** 标出当前命中、写「第几个/共几个」，并把它滚进可视区。 */
function applySearchHits(tab: Tab, host: HTMLElement): void {
  const count = host.querySelector<HTMLElement>('[data-role="body-search-count"]');
  if (!tab.search) {
    tab.searchIndex = 0;
    return;
  }
  const marks = [...host.querySelectorAll<HTMLElement>("mark")];
  if (marks.length === 0) {
    tab.searchIndex = 0;
    if (count) count.textContent = "无匹配";
    return;
  }
  const idx = Math.min(Math.max(tab.searchIndex ?? 0, 0), marks.length - 1);
  tab.searchIndex = idx;
  const current = marks[idx];
  if (current) {
    current.classList.add("mark-current");
    requestAnimationFrame(() => {
      if (current.isConnected) current.scrollIntoView({ block: "nearest" });
    });
  }
  if (count) count.textContent = `${String(idx + 1)}/${String(marks.length)}`;
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

/** 「链路」页签：走了几跳、每跳打到哪，以及最后一跳的耗时拆解。 */
function traceView(trace: ResponseTrace): HTMLElement {
  const host = el("div", { class: "body-view trace-view" });

  const hops = el("div", { class: "trace-hops" });
  trace.hops.forEach((hop, i) => {
    const row = el("div", { class: "trace-hop" });
    row.append(el("span", { class: "trace-index", text: String(i + 1) }));
    row.append(el("span", { class: `method-tag tone-${hop.method.toLowerCase()}`, text: hop.method }));
    row.append(el("span", { class: "trace-url", attr: { title: hop.url }, text: hop.url }));
    // 对端地址：域名没变但连到的机器可能已经变了（改 hosts、DNS 生效、连接复用）。
    row.append(
      el("span", {
        class: "trace-addr",
        attr: {
          title: hop.addr
            ? hop.viaProxy
              ? `${hop.addr}（代理地址，不是目标服务器）`
              : `实际连上的服务器 ${hop.addr}`
            : "这一跳没有拿到对端地址",
        },
        text: hop.addr ?? "",
      }),
    );
    row.append(el("span", { class: `trace-status tone-${statusTone(hop.status)}`, text: String(hop.status) }));
    hops.append(row);
  });
  host.append(sentSection(trace.hops.length > 1 ? `重定向链路 ${trace.hops.length} 跳` : "直连，没有重定向"));
  host.append(hops);

  const timing = trace.timings[trace.timings.length - 1];
  if (!timing) return host;
  const phases: [string, number][] = [
    ["DNS 解析", timing.dnsMs],
    ["建立连接", timing.connectMs],
    ["TLS 握手", timing.tlsMs],
    ["等待首字节", timing.ttfbMs],
  ];
  const widest = Math.max(timing.totalMs, ...phases.map(([, ms]) => ms), 1);
  const list = el("div", { class: "trace-phases" });
  for (const [label, ms] of phases) {
    if (ms <= 0) continue;
    list.append(phaseRow(label, ms, widest));
  }
  if (!list.firstElementChild) {
    // 本机回环或复用连接时不会产生解析/连接/TLS 耗时，只剩总计。
    list.append(el("p", { class: "muted small", text: "这次没有产生 DNS、连接或 TLS 开销（本机地址或复用连接）。" }));
  }
  list.append(phaseRow("总计", timing.totalMs, widest, true));
  const dnsAddrs = timing.dnsAddrs ?? [];
  host.append(
    sentSection("耗时拆解（最后一跳）", [
      timing.reused
        ? el("span", { class: "muted small", text: "复用了已有连接" })
        : el("span", { class: "muted small", text: "新建连接" }),
      ...(dnsAddrs.length > 0
        ? [
            el("span", {
              class: "trace-dns",
              attr: { title: "这一跳 DNS 解析到的地址，按尝试顺序" },
              text: `解析到 ${dnsAddrs.join("、")}`,
            }),
          ]
        : []),
    ]),
  );
  host.append(list);
  host.append(
    el("p", {
      class: "muted small",
      text: "对端地址是这一跳真正连上的 IP:端口。每次发送都重新建立连接，改完 hosts / DNS 之后下一条请求就按新解析连；同一请求内跟随重定向的那几跳会复用连接。阶段耗时由 Go 侧 httptrace 采集；正文下载时间见状态栏的「读取」值。",
    }),
  );
  return host;
}

function phaseRow(label: string, ms: number, widest: number, strong = false): HTMLElement {
  const row = el("div", { class: `trace-phase${strong ? " strong" : ""}` });
  row.append(el("span", { class: "trace-phase-label", text: label }));
  const bar = el("div", { class: "trace-bar" }, el("div", { class: "trace-bar-fill" }));
  const fillEl = bar.firstElementChild as HTMLElement;
  fillEl.style.width = `${Math.max(2, Math.round((ms / widest) * 100))}%`;
  row.append(bar);
  row.append(el("span", { class: "trace-phase-ms", text: formatDuration(ms) }));
  return row;
}

function statusTone(status: number): string {
  if (status >= 500) return "delete";
  if (status >= 400) return "put";
  if (status >= 300) return "post";
  return "get";
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

  if (body.kind === "binary") {
    box.append(sentSection(`请求体 · ${body.contentType} · 文件直传`));
    box.append(sentRows([
      ["文件", body.name],
      ["大小", formatBytes(body.bytes)],
    ]));
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

/** 二进制响应：图片直接渲染，其他类型给一段十六进制，省得只能盲存文件。 */
function binaryBody(res: ResponseRecord): HTMLElement {
  const host = el("div", { class: "binary-view" });
  const mime = (res.contentType.split(";")[0] ?? "").trim().toLowerCase();
  const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && Boolean(res.base64);

  if (isImage && (res.base64?.length ?? 0) < 12_000_000) {
    host.append(
      el("div", { class: "binary-preview" }, el("img", {
        class: "binary-image",
        attr: { src: `data:${mime};base64,${res.base64}`, alt: "响应图片预览" },
      })),
    );
    host.append(
      el("p", {
        class: "binary-meta",
        text: `${formatBytes(res.bytes)} · ${res.contentType}${res.truncated ? " · 超过 2 MB，预览与保存都只含前半部分" : ""}`,
      }),
    );
    return host;
  }

  host.append(
    el("p", {
      class: "binary-meta",
      text: `${formatBytes(res.bytes)} · ${res.contentType || "未知类型"}`,
    }),
  );
  host.append(
    el("pre", { class: "hex-view", text: res.base64 ? hexDump(res.base64) : "（没有内容）" }),
  );
  host.append(
    el("p", {
      class: "binary-meta",
      text: res.truncated
        ? "响应体超过 2 MB，这里与保存都只含前 2 MB。"
        : "这段是原始字节的十六进制与 ASCII 对照（最多前 512 字节）；要完整内容请点右上角下载。",
    }),
  );
  return host;
}

/** 把 base64 前若干字节排成 hexdump，排查非文本响应时够用。 */
function hexDump(base64: string, limit = 512): string {
  const bin = atob(base64);
  const end = Math.min(bin.length, limit);
  const lines: string[] = [];
  for (let i = 0; i < end; i += 16) {
    const chunk = bin.slice(i, Math.min(i + 16, end));
    const hex = [...chunk].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
    const ascii = [...chunk]
      .map((c) => {
        const code = c.charCodeAt(0);
        return code >= 32 && code < 127 ? c : ".";
      })
      .join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }
  return lines.join(String.fromCharCode(10));
}

function bodyTools(tab: Tab, res: ResponseRecord): HTMLElement {
  const tools = el("div", { class: "tools-row" });
  if (res.binary) {
    tools.append(
      el("span", {
        class: "muted small",
        text: res.truncated
          ? `二进制响应 · 超过 2 MB，只保留前 2 MB（共 ${formatBytes(res.bytes)}）`
          : "二进制响应：图片直接预览，其他类型给十六进制片段",
      }),
    );
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
        tab.searchIndex = 0;
        window.dispatchEvent(new CustomEvent("mygo:rerender-response-body"));
      },
      keydown: (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          // Shift+Enter 往回跳，到开头回到最后一处。
          stepSearchHit(tab, ev.shiftKey ? -1 : 1);
          return;
        }
        if (ev.key === "Escape") {
          search.value = "";
          tab.search = "";
          tab.searchIndex = 0;
          window.dispatchEvent(new CustomEvent("mygo:rerender-response"));
        }
      },
    },
  });
  search.value = tab.search;
  search.dataset.role = "body-search";
  tools.append(search);
  // 命中计数：具体数字要等响应体画完才知道，由 applySearchHits 填。
  tools.append(
    el("span", {
      class: "search-count",
      data: { role: "body-search-count" },
      attr: { "aria-live": "polite" },
    }),
  );

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
    fill(host, binaryBody(res));
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
    if (saved) {
      toast(`已保存到 ${saved}`, "success");
      if (res.truncated) toast("响应体超过 2 MB，文件里只有前 2 MB", "info");
    }
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
