// 应用状态与所有写操作。界面只读 state、调用 action，然后由 subscribe 触发重绘。

import { System, events } from "./mygo";
import type {
  ApiRequest,
  Collection,
  Env,
  FolderNode,
  HistoryEntry,
  KV,
  PersistedWorkspace,
  RequestNode,
  ResponseRecord,
  Tab,
  ThemeMode,
  TreeNode,
  SentBody,
  SentFile,
  SentRecord,
  RedirectMode,
  AuthType,
  ScriptRun,
} from "./types";
import { init as openStorage, load as readStorage, save as writeStorage } from "./db";
import { buildURL, cloneRequest, emptyRequest, scriptOf, toCurl } from "./curl";
import { snippetText, type SnippetLang } from "./snippets";
import { ensureScheme, guessName, interpolate, lookupVar, splitURL, uid, type VarScope } from "./util";
import { runScript } from "./script";

export interface Toast {
  id: string;
  text: string;
  kind: "info" | "success" | "error";
}

export interface State {
  ready: boolean;
  collections: Collection[];
  history: HistoryEntry[];
  envs: Env[];
  activeEnvId: string;
  globals: KV[];
  tabs: Tab[];
  activeTabId: string | null;
  theme: ThemeMode;
  sidebarWidth: number;
  responseHeight: number;
  sidebarTab: "collections" | "history";
  onboardingDone: boolean;
  /** 关闭窗口时最小化到托盘。由桌面外壳启动时读取，用户在托盘菜单里修改。 */
  closeToTray: boolean;
  /** 是否注册系统级快捷键。同上，托盘菜单与设置面板都能改。 */
  globalShortcut: boolean;
  /** 侧边栏是否收起。 */
  sidebarCollapsed: boolean;
  /** 界面浮层状态，不持久化。 */
  commandOpen: boolean;
  settingsOpen: boolean;
  envOpen: boolean;
  curlOpen: boolean;
  importOpen: boolean;
  /** 双击 .har 打开时带进来的文本，浮层第一次打开会直接用它解析。 */
  importDraft: string;
  snippetsOpen: boolean;
  /** 代码片段面板选中的语言，不持久化。 */
  snippetLang: SnippetLang;
  /** cURL 解析结果，等待用户确认后填充。 */
  pendingCurl: { request: ApiRequest; warnings: string[]; source: string } | null;
  /** Postman / HAR 解析结果，等待用户确认后并入工作区。 */
  pendingImport: { collections: { collection: Collection; warnings: string[] }[]; source: string } | null;
  toasts: Toast[];
  /** 集合树里被展开的节点 id 集合（文件夹的 open 字段已持久化，这里只为搜索时临时展开）。 */
  treeFilter: string;
  historyFilter: string;
}

const STORAGE_VERSION = 1;

// 分栏默认尺寸：双击分隔条复位到这里，默认状态与读回兜底共用同一份数字。
export const DEFAULT_SIDEBAR_WIDTH = 288;
export const DEFAULT_RESPONSE_HEIGHT = 340;

function blankState(): State {
  return {
    ready: false,
    collections: [],
    history: [],
    envs: [],
    activeEnvId: "",
    globals: [],
    tabs: [],
    activeTabId: null,
    theme: "auto",
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    responseHeight: DEFAULT_RESPONSE_HEIGHT,
    sidebarTab: "collections",
    onboardingDone: false,
    closeToTray: true,
    globalShortcut: true,
    sidebarCollapsed: false,
    commandOpen: false,
    settingsOpen: false,
    envOpen: false,
    curlOpen: false,
    importOpen: false,
    importDraft: "",
    snippetsOpen: false,
    snippetLang: "fetch",
    pendingCurl: null,
    pendingImport: null,
    toasts: [],
    treeFilter: "",
    historyFilter: "",
  };
}

export const state: State = blankState();

const listeners = new Set<() => void>();

/** 订阅状态变化；返回取消订阅函数。 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 通知界面重绘。
 */
export function emit(): void {
  for (const fn of listeners) fn();
}

// ---- 持久化（SQLite） ----

let saveTimer: number | undefined;
let saveWarned = false;
/** 写入串行队列：上一次事务没结束时不并发开第二个。 */
let queue: Promise<void> = Promise.resolve();

/** 让开运行时字段，得到要落库的工作区快照。 */
function snapshot(): PersistedWorkspace {
  return {
    version: STORAGE_VERSION,
    collections: state.collections,
    history: state.history.slice(0, 200),
    envs: state.envs,
    activeEnvId: state.activeEnvId,
    globals: state.globals,
    tabs: state.tabs.map((t) => ({
      id: t.id,
      name: t.name,
      request: t.request,
      dirty: t.dirty,
      origin: t.origin,
    })),
    activeTabId: state.activeTabId,
    theme: state.theme,
    sidebarWidth: state.sidebarWidth,
    responseHeight: state.responseHeight,
    sidebarTab: state.sidebarTab,
    sidebarCollapsed: state.sidebarCollapsed,
    onboardingDone: state.onboardingDone,
    closeToTray: state.closeToTray,
    globalShortcut: state.globalShortcut,
  };
}

/** 把当前工作区写进 SQLite（合并 220ms 内的连续改动）。 */
export function persist(): void {
  if (!state.ready) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    queue = queue.then(async () => {
      try {
        await writeStorage(snapshot());
        saveWarned = false;
      } catch (err) {
        // 写库失败只提示一次，避免连续编辑时反复弹出同一条错误。
        if (saveWarned) return;
        saveWarned = true;
        toast(`本地保存失败：${errText(err)}`, "error");
      }
    });
  }, 220);
}

/** 启动时读回工作区；首次运行时把旧版 JSON 工作区迁入数据库。 */
export async function load(): Promise<void> {
  try {
    const migrated = await openStorage();
    if (migrated.legacyBroken) {
      toast("旧的工作区文件无法解析，已跳过并改名备份（workspace.json.bak）", "error");
    }
    applyPersisted(migrated.imported ?? (await readStorage()));
  } catch (err) {
    toast(`打开本地数据库失败，本次不保存改动：${errText(err)}`, "error");
  }
  if (state.envs.length === 0) {
    state.envs = [defaultEnv()];
    state.activeEnvId = state.envs[0]!.id;
  } else if (!state.envs.some((e) => e.id === state.activeEnvId)) {
    state.activeEnvId = state.envs[0]!.id;
  }
  if (state.tabs.length === 0) {
    openTab(emptyRequest(), "未命名请求");
  } else if (!state.tabs.some((t) => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0]!.id;
  }
  state.ready = true;
  applyTheme();
  // 把存在库里的桌面偏好交给 Go 侧的桌面外壳（托盘 menu 的勾选状态）。
  void System.applyDesktopPrefs(state.closeToTray, state.globalShortcut).catch(() => {});
  emit();
}

function applyPersisted(p: Partial<PersistedWorkspace>): void {
  state.collections = Array.isArray(p.collections) ? p.collections : [];
  state.history = Array.isArray(p.history) ? p.history : [];
  state.envs = Array.isArray(p.envs) ? p.envs : [];
  state.globals = Array.isArray(p.globals) ? p.globals : [];
  state.activeEnvId = typeof p.activeEnvId === "string" ? p.activeEnvId : "";
  state.theme = p.theme === "dark" || p.theme === "light" ? p.theme : "auto";
  // 上下限与拖拽时一致：拖到边缘再重启，尺寸不该被悄悄改掉。
  state.sidebarWidth = clamp(p.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, 208, 520);
  state.responseHeight = clamp(p.responseHeight ?? DEFAULT_RESPONSE_HEIGHT, 140, 900);
  state.sidebarTab = p.sidebarTab === "history" ? "history" : "collections";
  state.sidebarCollapsed = p.sidebarCollapsed === true;
  state.onboardingDone = p.onboardingDone === true;
  // 桌面偏好默认开：只有明确存了 false 才关，缺字段（旧库）按默认处理。
  state.closeToTray = p.closeToTray !== false;
  state.globalShortcut = p.globalShortcut !== false;
  state.tabs = Array.isArray(p.tabs)
    ? p.tabs.map((t) => ({
        ...t,
        request: normalizeRequest(t.request),
        sending: false,
        responseTab: "body",
        bodyView: "pretty",
        search: "",
        requestTab: "params",
      }))
    : [];
  state.activeTabId = typeof p.activeTabId === "string" ? p.activeTabId : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

/** 兼容旧数据/缺字段的手工导入文件。 */
function normalizeRequest(r: Partial<ApiRequest> | undefined): ApiRequest {
  const base = emptyRequest();
  if (!r) return base;
  return {
    method: r.method ?? base.method,
    url: r.url ?? base.url,
    params: r.params ?? [],
    headers: r.headers ?? [],
    bodyMode: r.bodyMode ?? "none",
    body: r.body ?? "",
    form: r.form ?? [],
    auth: { ...base.auth, ...(r.auth ?? {}) },
    options: { ...base.options, ...(r.options ?? {}) },
  };
}

function defaultEnv(): Env {
  return {
    id: uid("env"),
    name: "默认环境",
    vars: [
      { id: uid("kv"), key: "baseUrl", value: "https://httpbin.org", enabled: true },
      { id: uid("kv"), key: "token", value: "", enabled: true },
    ],
  };
}

/** 当前环境下发给请求的变量作用域。 */
export function scope(): VarScope {
  const env = state.envs.find((e) => e.id === state.activeEnvId);
  return { env: env?.vars ?? [], globals: state.globals };
}

/**
 * 脚本里 pm.environment.set / pm.globals.set 的落点：写到当前环境或全局变量，
 * 和界面里手改的效果一样（含持久化）。不发事件，发送流程末尾会统一 emit。
 */
function writeScriptVar(kind: "env" | "global", name: string, value: string): void {
  const list = kind === "env" ? state.envs.find((e) => e.id === state.activeEnvId)?.vars : state.globals;
  if (!list) return;
  const hit = list.find((v) => v.key === name);
  if (hit) {
    hit.value = value;
    hit.enabled = true;
  } else {
    list.push({ id: uid("kv"), key: name, value, enabled: true });
  }
  persist();
}

/** 把 {{变量}} 替换成实际值（生成 URL、头、体时用）。 */
export function resolveText(text: string): string {
  return interpolate(text, scope()).text;
}

// ---- 主题 ----

export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = state.theme;
}

export function setTheme(mode: ThemeMode): void {
  state.theme = mode;
  applyTheme();
  persist();
  emit();
}

// ---- 提示条 ----

export function toast(text: string, kind: Toast["kind"] = "info"): void {
  const item: Toast = { id: uid("toast"), text, kind };
  state.toasts.push(item);
  emit();
  window.setTimeout(() => {
    const i = state.toasts.findIndex((t) => t.id === item.id);
    if (i >= 0) {
      state.toasts.splice(i, 1);
      emit();
    }
  }, kind === "error" ? 6000 : 3200);
}

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

// ---- 标签页 ----

export function activeTab(): Tab | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

export function openTab(request: ApiRequest, name: string, origin?: Tab["origin"]): Tab {
  const tab: Tab = {
    id: uid("tab"),
    name,
    request,
    dirty: false,
    origin,
    sending: false,
    responseTab: "body",
    bodyView: "pretty",
    search: "",
    requestTab: "params",
  };
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  persist();
  emit();
  return tab;
}

export function closeTab(id: string): void {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  if (state.activeTabId === id) {
    const next = state.tabs[Math.min(i, state.tabs.length - 1)];
    state.activeTabId = next ? next.id : null;
  }
  if (state.tabs.length === 0) {
    openTab(emptyRequest(), "未命名请求");
    return;
  }
  persist();
  emit();
}

/** 关闭除这一条以外的所有标签页。 */
export function closeOtherTabs(id: string): void {
  const keep = state.tabs.find((t) => t.id === id);
  if (!keep) return;
  state.tabs.splice(0, state.tabs.length, keep);
  state.activeTabId = keep.id;
  persist();
  emit();
}

/** 关闭全部标签页，只留下一个新的空白请求。 */
export function closeAllTabs(): void {
  state.tabs.splice(0, state.tabs.length);
  state.activeTabId = null;
  openTab(emptyRequest(), "未命名请求");
}

export function setActiveTab(id: string): void {
  if (state.activeTabId === id) return;
  state.activeTabId = id;
  persist();
  emit();
}

/** 修改当前标签的请求；mutator 直接改对象，随后标记为未保存。 */
export function mutate(mutator: (r: ApiRequest, t: Tab) => void): void {
  const tab = activeTab();
  if (!tab) return;
  mutator(tab.request, tab);
  tab.dirty = true;
  tab.name = tab.name === "新请求" ? guessName(tab.request.url, tab.request.method) : tab.name;
  persist();
  emit();
}

/** 把粘贴进来的 URL 拆成基础地址与查询参数。 */
export function applyURL(raw: string): void {
  const tab = activeTab();
  if (!tab) return;
  const { base, params } = splitURL(raw.trim());
  tab.request.url = base;
  if (params.length > 0) {
    tab.request.params = [
      ...tab.request.params.filter((p) => p.key.trim() !== "" || p.value.trim() !== ""),
      ...params.map((p) => ({ id: uid("kv"), key: p.key, value: p.value, enabled: true })),
    ];
  }
  tab.dirty = true;
  persist();
  emit();
}

// ---- 发送 ----

/** 每个标签页当前请求的 AbortController，用于取消。 */
const controllers = new Map<string, AbortController>();

/** 取消某个标签页正在进行的请求（abort 会在 Go 侧中止连接）。 */
export function abortSend(tabId: string): void {
  const c = controllers.get(tabId);
  if (!c) return;
  c.abort(new DOMException("用户取消了请求", "AbortError"));
}

export async function send(): Promise<void> {
  const tab = activeTab();
  if (!tab || tab.sending) return;

  let url = ensureScheme(buildURL(tab.request, resolveText));
  if (!url.trim()) {
    toast("请先填写请求地址", "error");
    return;
  }
  const missing = interpolate(
    [
      tab.request.url,
      ...tab.request.params.map((p) => `${p.key}${p.value}`),
      ...tab.request.headers.map((h) => `${h.key}${h.value}`),
      tab.request.body,
    ].join("\n"),
    scope(),
  ).missing;
  if (missing.length > 0) {
    toast(`未定义的变量：${missing.map((m) => `{{${m}}}`).join("、")}`, "error");
    return;
  }

  let headers = new Headers();
  for (const h of tab.request.headers) {
    if (!h.enabled || !h.key.trim()) continue;
    try {
      headers.set(resolveText(h.key), resolveText(h.value));
    } catch {
      toast(`请求头「${h.key}」不是合法的头名`, "error");
      return;
    }
  }

  const auth = tab.request.auth;
  if (auth.type === "bearer" && auth.token) {
    headers.set("Authorization", `Bearer ${resolveText(auth.token)}`);
  } else if (auth.type === "basic") {
    headers.set(
      "Authorization",
      `Basic ${btoa(`${resolveText(auth.username)}:${resolveText(auth.password)}`)}`,
    );
  } else if (auth.type === "apikey" && auth.key) {
    if (auth.in === "header") headers.set(resolveText(auth.key), resolveText(auth.value));
  }

  let body: BodyInit | undefined;
  let methodUpper = tab.request.method.toUpperCase();
  if (methodUpper !== "GET" && methodUpper !== "HEAD" && tab.request.bodyMode !== "none") {
    if (tab.request.bodyMode === "form") {
      const fd = new FormData();
      for (const f of tab.request.form) {
        if (!f.enabled || !f.key.trim()) continue;
        if (f.kind === "file") {
          if (!f.fileData) continue;
          const bytes = base64ToBytes(f.fileData);
          fd.append(
            resolveText(f.key),
            new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
              type: "application/octet-stream",
            }),
            f.fileName ?? "file",
          );
        } else {
          fd.append(resolveText(f.key), resolveText(f.value));
        }
      }
      body = fd;
    } else if (tab.request.bodyMode === "urlencoded") {
      const usp = new URLSearchParams();
      for (const f of tab.request.form) {
        if (!f.enabled || !f.key.trim()) continue;
        usp.append(resolveText(f.key), resolveText(f.value));
      }
      body = usp;
    } else {
      body = resolveText(tab.request.body);
      if (tab.request.bodyMode === "json" && !headers.has("content-type")) {
        headers.set("Content-Type", "application/json");
      }
      if (tab.request.bodyMode === "text" && !headers.has("content-type")) {
        headers.set("Content-Type", "text/plain; charset=utf-8");
      }
    }
  }

  if (auth.type === "apikey" && auth.in === "query" && auth.key.trim()) {
    const u = new URL(url);
    u.searchParams.set(resolveText(auth.key), resolveText(auth.value));
    url = u.toString();
  }

  // 前置脚本可能跑满 5 秒：先占住 sending 并立刻渲染「取消」，这期间再点发送会被
  // 开头的 tab.sending 挡住，不会并行跑两份脚本。
  tab.sending = true;
  emit();

  // 前置脚本：拿到的就是「马上要发出去」的请求，改头、改地址、改体都直接生效。
  const script = scriptOf(tab.request);
  const scriptRuns: ScriptRun[] = [];
  tab.scriptRuns = scriptRuns;
  let scriptVars: Record<string, string> = {};
  const scriptRequestState = () => ({
    method: methodUpper,
    url,
    headers: [...headers.entries()] as [string, string][],
    body: typeof body === "string" ? body : null,
  });
  if (script.pre.trim()) {
    if (!script.trusted) {
      scriptRuns.push({
        phase: "pre",
        logs: [{ level: "warn", text: "这段脚本来自导入文件，还没被信任，本次不执行" }],
        ms: 0,
      });
    } else {
      const pre = await runScript(
        "pre",
        script.pre,
        {
          request: scriptRequestState(),
          getVar: (name) => lookupVar(name, scope()),
          setEnvVar: (name, value) => writeScriptVar("env", name, value),
          setGlobalVar: (name, value) => writeScriptVar("global", name, value),
        },
        scriptVars,
      );
      scriptVars = pre.vars;
      scriptRuns.push({ phase: "pre", logs: pre.logs, error: pre.error, ms: pre.ms });
      if (pre.error) {
        tab.sending = false;
        emit();
        toast(`前置脚本出错，请求已取消：${pre.error}`, "error");
        return;
      }
      url = pre.request.url;
      methodUpper = pre.request.method;
      headers = new Headers();
      for (const [key, value] of pre.request.headers) headers.append(key, value);
      if (typeof body === "string" && pre.request.body !== null) body = pre.request.body;
    }
  }

  // Cookie 开关：关掉时通知 Go 侧停止携带与记录。
  void System.setCookies(tab.request.options.keepCookies).catch(() => {});

  const controller = new AbortController();
  controllers.set(tab.id, controller);
  const timeoutMs = tab.request.options.timeoutMs;
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? window.setTimeout(() => {
          timedOut = true;
          controller.abort(new DOMException("请求超时", "TimeoutError"));
        }, timeoutMs)
      : undefined;

  tab.response = undefined;
  // 真正发出去的东西先记一份：排查时看的就是这份快照，不是编辑区里可能又改过的状态。
  tab.sent = buildSentRecord({
    method: methodUpper,
    url,
    headers,
    body,
    timeoutMs,
    redirect: tab.request.options.redirect,
    keepCookies: tab.request.options.keepCookies,
    authType: auth.type,
  });
  emit();

  const started = performance.now();
  try {
    const res = await fetchFrom(url, {
      // 用脚本改过的方法（前置脚本可以改 pm.request.method）。
      method: methodUpper,
      headers,
      body,
      signal: controller.signal,
      redirect: tab.request.options.redirect,
    });
    const record = await readResponse(res, started, performance.now() - started);

    // 后置脚本：可以读响应、改响应体（解密、脱敏、重排都在这做）。
    if (script.post.trim()) {
      if (!script.trusted) {
        scriptRuns.push({
          phase: "post",
          logs: [{ level: "warn", text: "这段脚本来自导入文件，还没被信任，本次不执行" }],
          ms: 0,
        });
      } else {
        const post = await runScript(
          "post",
          script.post,
          {
            request: scriptRequestState(),
            response: {
              code: record.status,
              status: record.statusText,
              headers: record.headers,
              body: record.body,
            },
            getVar: (name) => lookupVar(name, scope()),
            setEnvVar: (name, value) => writeScriptVar("env", name, value),
            setGlobalVar: (name, value) => writeScriptVar("global", name, value),
          },
          scriptVars,
        );
        scriptVars = post.vars;
        if (post.responseBody !== undefined) {
          record.body = post.responseBody;
          record.binary = false;
          record.base64 = undefined;
          record.truncated = false;
        }
        scriptRuns.push({
          phase: "post",
          logs: post.logs,
          error: post.error,
          ms: post.ms,
          bodyEdited: post.responseBody !== undefined,
        });
      }
    }
    if (scriptRuns.length > 0) record.scripts = scriptRuns;

    const current = state.tabs.find((t) => t.id === tab.id);
    if (current) {
      current.response = record;
      current.sending = false;
      current.responseTab = "body";
      current.search = "";
    }
    addHistory(tab.request, record.status, record.durationMs);
    notifyIfBackground(record);
  } catch (err) {
    const current = state.tabs.find((t) => t.id === tab.id);
    const record = errorRecord(err, performance.now() - started, timedOut);
    if (current) {
      current.response = record;
      current.sending = false;
      current.responseTab = "body";
    }
    addHistory(tab.request, 0, record.durationMs);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    controllers.delete(tab.id);
    emit();
  }
}

/** 文本请求体快照上限：够看清问题，又不会把大文本整份留在内存里。 */
const SENT_TEXT_LIMIT = 64 * 1024;

interface SentInput {
  method: string;
  url: string;
  headers: Headers;
  body: BodyInit | undefined;
  timeoutMs: number;
  redirect: RedirectMode;
  keepCookies: boolean;
  authType: AuthType;
}

function buildSentRecord(input: SentInput): SentRecord {
  const headers: [string, string][] = [];
  input.headers.forEach((value, key) => headers.push([key, value]));
  headers.sort((a, b) => a[0].localeCompare(b[0]));
  return {
    method: input.method,
    url: input.url,
    headers,
    body: sentBodyOf(input.body, input.headers),
    timeoutMs: input.timeoutMs,
    redirect: input.redirect,
    keepCookies: input.keepCookies,
    authType: input.authType,
    at: Date.now(),
  };
}

function sentBodyOf(body: BodyInit | undefined, headers: Headers): SentBody {
  if (body === undefined) return { kind: "none" };
  if (body instanceof FormData) {
    const fields: [string, string][] = [];
    const files: SentFile[] = [];
    body.forEach((value, key) => {
      if (typeof value === "string") fields.push([key, value]);
      else files.push({ key, name: value.name || "file", size: value.size });
    });
    return { kind: "form", contentType: "multipart/form-data", fields, files };
  }
  if (body instanceof URLSearchParams) {
    return {
      kind: "form",
      contentType: "application/x-www-form-urlencoded",
      fields: Array.from(body.entries()),
      files: [],
    };
  }
  if (typeof body === "string") {
    const truncated = body.length > SENT_TEXT_LIMIT;
    return {
      kind: "text",
      contentType: headers.get("content-type") ?? "",
      text: truncated ? body.slice(0, SENT_TEXT_LIMIT) : body,
      chars: body.length,
      truncated,
    };
  }
  return { kind: "none" };
}

async function fetchFrom(input: string, init: RequestInit): Promise<Response> {
  // 延迟 import，避免在没有 Go 侧插件时（纯浏览器预览）启动即失败。
  const mod = await import("@mygo-plugins/fetch");
  return mod.fetch(input, init);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const PREVIEW_LIMIT = 2 * 1024 * 1024;

async function readResponse(res: Response, started: number, waitMs: number): Promise<ResponseRecord> {
  const headers: [string, string][] = [];
  res.headers.forEach((value, key) => headers.push([key, value]));
  headers.sort((a, b) => a[0].localeCompare(b[0]));

  const contentType = res.headers.get("content-type") ?? "";
  const buffer = res.body ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(0);
  const textual = isTextual(contentType, buffer);
  const durationMs = performance.now() - started;

  const truncated = buffer.byteLength > PREVIEW_LIMIT;
  const slice = truncated ? buffer.subarray(0, PREVIEW_LIMIT) : buffer;

  let body = "";
  let base64: string | undefined;
  if (textual) {
    body = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  } else {
    base64 = bytesToBase64(slice);
  }

  return {
    ok: res.status >= 200 && res.status < 400,
    status: res.status,
    statusText: res.statusText,
    url: res.url,
    redirected: res.redirected,
    headers,
    body,
    bytes: buffer.byteLength,
    binary: !textual,
    base64,
    durationMs,
    waitMs,
    downloadMs: Math.max(0, durationMs - waitMs),
    at: Date.now(),
    contentType,
    truncated,
  };
}

function isTextual(contentType: string, buffer: Uint8Array): boolean {
  const ct = contentType.toLowerCase();
  if (ct) {
    if (ct.startsWith("text/")) return true;
    if (/[/+](json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv)/.test(ct)) {
      return true;
    }
    if (ct.includes("html") || ct.includes("svg")) return true;
    return false;
  }
  // 没有 Content-Type 时按字节猜：前 512 字节里出现 NUL 就当二进制。
  const probe = buffer.subarray(0, Math.min(512, buffer.length));
  for (const b of probe) if (b === 0) return false;
  return true;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function errorRecord(err: unknown, durationMs: number, timedOut: boolean): ResponseRecord {
  const raw = errText(err);
  const kind = timedOut
    ? "timeout"
    : raw.toLowerCase().includes("abort")
      ? "aborted"
      : raw.toLowerCase().includes("fetch failed")
        ? "network"
        : "invalid";
  const message = friendlyError(raw, kind);
  return {
    ok: false,
    status: 0,
    statusText: "",
    url: "",
    redirected: false,
    headers: [],
    body: "",
    bytes: 0,
    binary: false,
    durationMs,
    waitMs: durationMs,
    downloadMs: 0,
    at: Date.now(),
    contentType: "",
    truncated: false,
    error: message,
    errorKind: kind,
  };
}

/** 把 Go 侧的错误原文翻译成中文提示，原文仍保留在提示下方可展开。 */
export function friendlyError(raw: string, kind: string): string {
  const text = raw.replace(/^fetch failed:\s*/i, "");
  if (kind === "timeout") return "请求超时：超过设定的时间仍未完成";
  if (kind === "aborted") return "请求已取消";
  const lower = text.toLowerCase();
  if (lower.includes("no such host") || lower.includes("dns"))
    return "域名解析失败：请检查地址拼写或网络连接";
  if (lower.includes("connection refused"))
    return "连接被拒绝：目标服务未启动，或端口不对";
  if (lower.includes("connection reset")) return "连接被重置：可能是服务端主动断开或网络中断";
  if (lower.includes("timeout") || lower.includes("i/o timeout")) return "连接超时：目标服务没有响应";
  if (lower.includes("certificate") || lower.includes("tls"))
    return "TLS 握手失败：服务端证书不被信任";
  if (lower.includes("too many redirects")) return "重定向次数过多：请检查接口是否循环跳转";
  if (lower.includes("unsupported protocol")) return "不支持的协议：地址需要以 http:// 或 https:// 开头";
  if (lower.includes("missing protocol scheme") || lower.includes("invalid url"))
    return "地址格式不正确：请补全 http:// 或 https://";
  if (lower.includes("connection") || lower.includes("dial")) return "网络连接失败：请检查网络与目标地址";
  return "请求失败，请查看下方原始错误信息";
}

function notifyIfBackground(record: ResponseRecord): void {
  if (!document.hidden) return;
  const tab = activeTab();
  const title = record.ok ? "请求已完成" : "请求失败";
  const body = `${tab?.request.method ?? ""} ${record.status || "—"} · ${Math.round(record.durationMs)} ms`;
  void System.notify(title, body).catch(() => {});
}

// ---- 历史 ----

export function addHistory(request: ApiRequest, status: number, durationMs: number): void {
  const entry: HistoryEntry = {
    id: uid("h"),
    at: Date.now(),
    method: request.method,
    url: buildURL(request, resolveText),
    status,
    durationMs,
    request: cloneRequest(request),
  };
  state.history.unshift(entry);
  if (state.history.length > 200) state.history.length = 200;
  persist();
}

export function deleteHistory(id: string): void {
  const i = state.history.findIndex((h) => h.id === id);
  if (i >= 0) {
    state.history.splice(i, 1);
    persist();
    emit();
  }
}

export function clearHistory(): void {
  state.history = [];
  persist();
  emit();
}

export function openHistory(id: string): void {
  const entry = state.history.find((h) => h.id === id);
  if (!entry) return;
  openTab(cloneRequest(entry.request), guessName(entry.url, entry.method));
}

// ---- 集合 ----

export function createCollection(name: string): Collection {
  const c: Collection = { id: uid("col"), name, items: [] };
  state.collections.push(c);
  persist();
  emit();
  return c;
}

export function renameCollection(id: string, name: string): void {
  const c = state.collections.find((x) => x.id === id);
  if (!c) return;
  c.name = name.trim() || c.name;
  persist();
  emit();
}

export function deleteCollection(id: string): void {
  const i = state.collections.findIndex((c) => c.id === id);
  if (i < 0) return;
  state.collections.splice(i, 1);
  for (const t of state.tabs) {
    if (t.origin?.collectionId === id) t.origin = undefined;
  }
  persist();
  emit();
}

export function createFolder(collectionId: string, parentId?: string, name = "新建文件夹"): void {
  const folder: FolderNode = { id: uid("folder"), type: "folder", name, open: true, items: [] };
  const list = parentId ? findList(collectionId, parentId) : findList(collectionId);
  if (!list) return;
  list.push(folder);
  persist();
  emit();
}

// ---- 拖拽排序 ----

export type DropMode = "before" | "after" | "inside";

/** 从树里摘出一个节点（连同它的子树），找不到返回 null。 */
function detachNode(items: TreeNode[], nodeId: string): TreeNode | null {
  const idx = items.findIndex((n) => n.id === nodeId);
  if (idx >= 0) return items.splice(idx, 1)[0] ?? null;
  for (const node of items) {
    if (node.type !== "folder") continue;
    const found = detachNode(node.items, nodeId);
    if (found) return found;
  }
  return null;
}

function findTreeNode(items: TreeNode[], nodeId: string): TreeNode | null {
  for (const node of items) {
    if (node.id === nodeId) return node;
    if (node.type === "folder") {
      const found = findTreeNode(node.items, nodeId);
      if (found) return found;
    }
  }
  return null;
}

/** 把节点插到某个兄弟节点之前或之后；targetId 不存在时返回 false。 */
function insertRelative(items: TreeNode[], targetId: string, node: TreeNode, mode: DropMode): boolean {
  const idx = items.findIndex((n) => n.id === targetId);
  if (idx >= 0) {
    items.splice(mode === "before" ? idx : idx + 1, 0, node);
    return true;
  }
  for (const item of items) {
    if (item.type === "folder" && insertRelative(item.items, targetId, node, mode)) return true;
  }
  return false;
}

/** 判断 node 自己或它的子孙里有没有 targetId：禁止把文件夹拖进自己里面。 */
function containsNode(node: TreeNode, targetId: string): boolean {
  if (node.id === targetId) return true;
  if (node.type !== "folder") return false;
  return node.items.some((child) => containsNode(child, targetId));
}

/** 拖拽排序：支持同集合内移动、跨集合移动、拖进文件夹。 */
export function moveTreeNode(
  src: { collectionId: string; nodeId: string },
  dst: { collectionId: string; nodeId: string; mode: DropMode },
): void {
  if (src.collectionId === dst.collectionId && src.nodeId === dst.nodeId) return;
  const from = state.collections.find((c) => c.id === src.collectionId);
  const to = state.collections.find((c) => c.id === dst.collectionId);
  if (!from || !to) return;

  // 先看落点合不合法再摘出来，免得白改一次还得回滚。
  const target = findTreeNode(to.items, dst.nodeId);
  if (!target && dst.mode === "inside") return;
  const moving = findTreeNode(from.items, src.nodeId);
  if (!moving) return;
  if (target && containsNode(moving, target.id)) return;

  const detached = detachNode(from.items, src.nodeId);
  if (!detached) return;

  if (dst.mode === "inside" && target && target.type === "folder") {
    target.items.push(detached);
    target.open = true;
  } else if (!insertRelative(to.items, dst.nodeId, detached, dst.mode)) {
    // 落点反悔了就把节点放回原处，避免数据丢失。
    from.items.push(detached);
  }
  persist();
  emit();
}

/** 找到某节点（或集合根）下的 items 数组，用于插入。 */
function findList(collectionId: string, parentId?: string): TreeNode[] | undefined {
  const col = state.collections.find((c) => c.id === collectionId);
  if (!col) return undefined;
  if (!parentId) return col.items;
  const stack: TreeNode[] = [...col.items];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "folder") {
      if (node.id === parentId) return node.items;
      stack.push(...node.items);
    }
  }
  return undefined;
}

/** 找到节点本身，返回节点与其父列表。 */
export function findNode(
  collectionId: string,
  nodeId: string,
): { node: TreeNode; list: TreeNode[] } | undefined {
  const col = state.collections.find((c) => c.id === collectionId);
  if (!col) return undefined;
  const walk = (nodes: TreeNode[]): { node: TreeNode; list: TreeNode[] } | undefined => {
    for (const n of nodes) {
      if (n.id === nodeId) return { node: n, list: nodes };
      if (n.type === "folder") {
        const hit = walk(n.items);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(col.items);
}

export function toggleFolder(collectionId: string, nodeId: string): void {
  const hit = findNode(collectionId, nodeId);
  if (hit && hit.node.type === "folder") {
    hit.node.open = !hit.node.open;
    persist();
    emit();
  }
}

export function renameNode(collectionId: string, nodeId: string, name: string): void {
  const hit = findNode(collectionId, nodeId);
  if (!hit || !name.trim()) return;
  hit.node.name = name.trim();
  for (const t of state.tabs) {
    if (t.origin?.nodeId === nodeId) t.name = name.trim();
  }
  persist();
  emit();
}

export function deleteNode(collectionId: string, nodeId: string): void {
  const hit = findNode(collectionId, nodeId);
  if (!hit) return;
  const i = hit.list.findIndex((n) => n.id === nodeId);
  if (i >= 0) hit.list.splice(i, 1);
  for (const t of state.tabs) {
    if (t.origin?.nodeId === nodeId) t.origin = undefined;
  }
  persist();
  emit();
}

export function duplicateNode(collectionId: string, nodeId: string): void {
  const hit = findNode(collectionId, nodeId);
  if (!hit) return;
  const copy = JSON.parse(JSON.stringify(hit.node)) as TreeNode;
  reassignIds(copy);
  copy.name = `${hit.node.name} 副本`;
  const i = hit.list.findIndex((n) => n.id === nodeId);
  hit.list.splice(i + 1, 0, copy);
  persist();
  emit();
}

function reassignIds(node: TreeNode): void {
  node.id = uid(node.type === "folder" ? "folder" : "req");
  if (node.type === "folder") {
    for (const child of node.items) reassignIds(child);
  } else {
    reassignRequestIds(node.request);
  }
}

function reassignRequestIds(r: ApiRequest): void {
  for (const p of r.params) p.id = uid("kv");
  for (const h of r.headers) h.id = uid("kv");
  for (const f of r.form) f.id = uid("ff");
}

export function openNode(collectionId: string, nodeId: string): void {
  const hit = findNode(collectionId, nodeId);
  if (!hit || hit.node.type !== "request") return;
  const existing = state.tabs.find(
    (t) => t.origin?.nodeId === nodeId && t.origin.collectionId === collectionId,
  );
  if (existing) {
    setActiveTab(existing.id);
    return;
  }
  openTab(cloneRequest(hit.node.request), hit.node.name, { collectionId, nodeId });
}

/** 保存当前标签：已归属集合则原地更新，否则新建到目标集合。 */
export function saveTab(collectionId: string, folderId: string | undefined, name: string): void {
  const tab = activeTab();
  if (!tab) return;
  const finalName = name.trim() || guessName(tab.request.url, tab.request.method);
  if (tab.origin) {
    const hit = findNode(tab.origin.collectionId, tab.origin.nodeId);
    if (hit && hit.node.type === "request") {
      hit.node.request = cloneRequest(tab.request);
      hit.node.name = finalName;
      tab.name = finalName;
      tab.dirty = false;
      persist();
      emit();
      return;
    }
    tab.origin = undefined;
  }
  const node: RequestNode = {
    id: uid("req"),
    type: "request",
    name: finalName,
    request: cloneRequest(tab.request),
  };
  const list = findList(collectionId, folderId);
  if (!list) return;
  list.push(node);
  tab.origin = { collectionId, nodeId: node.id };
  tab.name = finalName;
  tab.dirty = false;
  persist();
  emit();
}

/** 把当前标签另存为新节点（不影响原节点）。 */
export function saveTabAs(
  collectionId: string,
  folderId: string | undefined,
  name: string,
): void {
  const tab = activeTab();
  if (!tab) return;
  const node: RequestNode = {
    id: uid("req"),
    type: "request",
    name: name.trim() || guessName(tab.request.url, tab.request.method),
    request: cloneRequest(tab.request),
  };
  const list = findList(collectionId, folderId);
  if (!list) return;
  list.push(node);
  tab.origin = { collectionId, nodeId: node.id };
  tab.name = node.name;
  tab.dirty = false;
  persist();
  emit();
}

/** 把任意请求直接存进指定集合（用于「保存到集合」快捷键与命令面板）。 */
export function saveRequestTo(collectionId: string, name: string, request: ApiRequest): void {
  const node: RequestNode = {
    id: uid("req"),
    type: "request",
    name,
    request: cloneRequest(request),
  };
  const list = findList(collectionId);
  if (!list) return;
  list.push(node);
  persist();
  emit();
}

// ---- 环境变量 ----

export function setEnv(id: string): void {
  state.activeEnvId = id;
  persist();
  emit();
}

export function createEnv(name: string): Env {
  const env: Env = { id: uid("env"), name, vars: [] };
  state.envs.push(env);
  state.activeEnvId = env.id;
  persist();
  emit();
  return env;
}

export function deleteEnv(id: string): void {
  if (state.envs.length <= 1) {
    toast("至少要保留一个环境", "error");
    return;
  }
  const i = state.envs.findIndex((e) => e.id === id);
  if (i < 0) return;
  state.envs.splice(i, 1);
  if (state.activeEnvId === id) state.activeEnvId = state.envs[0]!.id;
  persist();
  emit();
}

export function renameEnv(id: string, name: string): void {
  const env = state.envs.find((e) => e.id === id);
  if (!env) return;
  env.name = name.trim() || env.name;
  persist();
  emit();
}

export function mutateEnvVars(id: string, mutator: (vars: KV[]) => void): void {
  const env = state.envs.find((e) => e.id === id);
  if (!env) return;
  mutator(env.vars);
  persist();
  emit();
}

export function mutateGlobals(mutator: (vars: KV[]) => void): void {
  mutator(state.globals);
  persist();
  emit();
}

// ---- 导入导出 ----

export interface WorkspaceBundle {
  app: string;
  version: number;
  exportedAt: string;
  collections: Collection[];
  envs: Env[];
  globals: KV[];
}

export function exportBundle(): string {
  const bundle: WorkspaceBundle = {
    app: "mygo-api",
    version: STORAGE_VERSION,
    exportedAt: new Date().toISOString(),
    collections: state.collections,
    envs: state.envs,
    globals: state.globals,
  };
  return JSON.stringify(bundle, null, 2);
}

/** 导入备份：合并到现有数据（id 冲突时整体换新 id）。 */
export function importBundle(raw: string): { collections: number; envs: number } {
  const parsed = JSON.parse(raw) as Partial<WorkspaceBundle>;
  const collections = Array.isArray(parsed.collections) ? parsed.collections : [];
  const envs = Array.isArray(parsed.envs) ? parsed.envs : [];
  for (const c of collections) {
    reassignCollectionIds(c);
    state.collections.push(c);
  }
  for (const e of envs) {
    e.id = uid("env");
    for (const v of e.vars) v.id = uid("kv");
    state.envs.push(e);
  }
  if (Array.isArray(parsed.globals)) {
    for (const g of parsed.globals) state.globals.push({ ...g, id: uid("kv") });
  }
  persist();
  emit();
  return { collections: collections.length, envs: envs.length };
}

/** 把解析好的 Postman / HAR 集合并入工作区（重分配 id，不会覆盖已有集合）。 */
export function importCollections(
  parsed: { collection: Collection }[],
): { collections: number; requests: number } {
  let requests = 0;
  for (const item of parsed) {
    reassignCollectionIds(item.collection);
    requests += countRequests(item.collection.items);
    state.collections.push(item.collection);
  }
  state.pendingImport = null;
  state.importOpen = false;
  persist();
  emit();
  return { collections: parsed.length, requests };
}

function countRequests(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "request") n += 1;
    else n += countRequests(node.items);
  }
  return n;
}

function reassignCollectionIds(col: Collection): void {
  col.id = uid("col");
  const walk = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      if (n.type === "folder") {
        n.id = uid("folder");
        walk(n.items);
      } else {
        n.id = uid("req");
        reassignRequestIds(n.request);
      }
    }
  };
  walk(col.items);
}

// ---- 复制为 cURL ----

export function currentCurl(useVariables: boolean): string {
  const tab = activeTab();
  if (!tab) return "";
  return toCurl(tab.request, { resolve: useVariables ? resolveText : (t) => t });
}

/** 生成当前请求的代码片段文本（变量已替换成实际值，复制即可用）。 */
export function currentSnippet(lang: SnippetLang): string {
  const tab = activeTab();
  if (!tab) return "";
  return snippetText(tab.request, lang, { resolve: resolveText });
}

export async function copyText(text: string, label = "已复制"): Promise<void> {
  try {
    await System.copyText(text);
    toast(label, "success");
  } catch (err) {
    // 兜底：用 webview 的剪贴板 API。
    try {
      await navigator.clipboard.writeText(text);
      toast(label, "success");
    } catch {
      toast(`复制失败：${errText(err)}`, "error");
    }
  }
}

export async function pasteText(): Promise<string> {
  // 剪贴板读取在个别环境下会卡住（窗口失焦、剪贴板被别的进程占用），
  // 它是批量粘贴的辅助步骤，不能让调用它的对话框跟着一起卡死。
  const withTimeout = async (task: Promise<string>, ms: number): Promise<string> => {
    let timer = 0;
    try {
      return await Promise.race([
        task.catch(() => ""),
        new Promise<string>((resolve) => {
          timer = window.setTimeout(() => resolve(""), ms);
        }),
      ]);
    } finally {
      window.clearTimeout(timer);
    }
  };
  // 应用侧最多等 1 秒（Go 打开剪贴板的耐心值），等不到再顺序退到 WebView 的接口。
  // 两路必须串行：同时开系统剪贴板会让两边都失败。
  const fromApp = await withTimeout(System.pasteText(), 1200);
  if (fromApp) return fromApp;
  try {
    return await withTimeout(navigator.clipboard.readText(), 400);
  } catch {
    return "";
  }
}

// ---- 界面开关（不持久化） ----

export function toggleUI(
  key: "commandOpen" | "settingsOpen" | "envOpen" | "curlOpen" | "importOpen" | "snippetsOpen",
  open?: boolean,
): void {
  const next = open === undefined ? !state[key] : open;
  state.commandOpen = false;
  state.settingsOpen = false;
  state.envOpen = false;
  state.curlOpen = false;
  state.importOpen = false;
  state.snippetsOpen = false;
  state[key] = next;
  emit();
}

/** 切换代码片段语言，只重画面板，不关掉它。 */
export function setSnippetLang(lang: SnippetLang): void {
  state.snippetLang = lang;
  emit();
}

/** 把双击打开的文件内容交给导入浮层，并把它打开。 */
export function setImportDraft(text: string): void {
  state.importDraft = text;
  toggleUI("importOpen", true);
}

/** 设置 cURL 解析结果并打开导入确认面板。 */
export function setPendingCurl(
  payload: { request: ApiRequest; warnings: string[]; source?: string } | null,
): void {
  state.pendingCurl = payload
    ? { request: payload.request, warnings: payload.warnings, source: payload.source ?? "" }
    : null;
  if (payload) toggleUI("curlOpen", true);
  else emit();
}

/** 确认导入：把解析出的请求填进当前标签（或用新标签）。 */
export function applyPendingCurl(target: "replace" | "newTab"): void {
  const pending = state.pendingCurl;
  if (!pending) return;
  const req = pending.request;
  if (target === "newTab") {
    openTab(cloneRequest(req), guessName(req.url, req.method));
  } else {
    const tab = activeTab();
    if (tab) {
      tab.request = cloneRequest(req);
      tab.dirty = true;
      tab.response = undefined;
      tab.name = guessName(req.url, req.method);
    } else {
      openTab(cloneRequest(req), guessName(req.url, req.method));
    }
  }
  state.pendingCurl = null;
  state.curlOpen = false;
  persist();
  emit();
  toast("已导入 cURL 命令", "success");
}

export function toggleSidebar(): void {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  persist();
  emit();
}

export function finishOnboarding(): void {
  state.onboardingDone = true;
  persist();
}

/** 用户在托盘菜单里改了「关闭到托盘」：只记录，Go 侧已经先改好了自己的状态。 */
export function setCloseToTray(on: boolean): void {
  if (state.closeToTray === on) return;
  state.closeToTray = on;
  persist();
  emit();
}

/** 用户在托盘菜单里改了全局快捷键：同样只记录，注册由 Go 侧完成。 */
export function setGlobalShortcutFromShell(on: boolean): void {
  if (state.globalShortcut === on) return;
  state.globalShortcut = on;
  persist();
  emit();
}

/** 设置面板改桌面偏好：先写库，再让 Go 侧立刻生效。 */
export function setDesktopPrefs(next: { closeToTray?: boolean; globalShortcut?: boolean }): void {
  const closeToTray = next.closeToTray ?? state.closeToTray;
  const globalShortcut = next.globalShortcut ?? state.globalShortcut;
  if (closeToTray === state.closeToTray && globalShortcut === state.globalShortcut) return;
  state.closeToTray = closeToTray;
  state.globalShortcut = globalShortcut;
  persist();
  void System.applyDesktopPrefs(closeToTray, globalShortcut).catch(() => {});
  emit();
}
