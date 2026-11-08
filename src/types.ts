// 应用的数据模型。所有对象都是纯 JSON（可被 JSON.stringify 直接序列化），
// 只有 Tab 里的运行时字段（sending / 响应）在持久化前会被剔除。

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export const METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/** 键值行：查询参数、请求头、环境变量共用同一个结构。 */
export interface KV {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  /** 敏感值：界面上默认遮住，只影响显示，发送与导出仍用真实值。 */
  secret?: boolean;
}

/** 请求体形态。binary 是把整个文件当正文直传（不是 multipart）。 */
export type BodyMode = "none" | "json" | "text" | "urlencoded" | "form" | "binary" | "graphql";

/** multipart 表单里的一行，可以是文本或文件。 */
export interface FormField {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  kind: "text" | "file";
  fileName?: string;
  fileSize?: number;
  /** base64 编码的文件内容，来自 System.pickFile。 */
  fileData?: string;
}

/** 直传的文件：只需要名字、大小与 base64 内容。 */
export interface BinaryFile {
  name: string;
  size: number;
  /** base64 编码的原始字节。 */
  data: string;
  /** 来源路径，仅用于界面提示。 */
  path?: string;
}

export type AuthType = "none" | "bearer" | "basic" | "apikey";

export interface AuthConfig {
  type: AuthType;
  token: string;
  username: string;
  password: string;
  key: string;
  value: string;
  in: "header" | "query";
}

export type RedirectMode = "follow" | "manual" | "error";

export interface RequestOptions {
  /** 毫秒。0 表示不超时。 */
  timeoutMs: number;
  redirect: RedirectMode;
  /** 关闭时请求不带 Cookie，也不写入 Cookie（由 Go 侧 Cookie 罐实现）。 */
  keepCookies: boolean;
  /** 这条请求自己的代理，空表示跟随系统代理。 */
  proxy: string;
  /** 跳过 TLS 证书校验（自签证书的测试环境用）。 */
  insecureTLS: boolean;
}

/** 脚本在库里是前置还是后置。 */
export type ScriptPhase = "pre" | "post";

/** 脚本的作用范围：所有请求、某个集合（含其中的文件夹与请求）、某个请求。 */
export type ScriptScopeKind = "global" | "collection" | "request";

/**
 * 脚本库里的一个脚本。库里是一个有序列表，发送时按这份顺序执行：
 * 前置只跑 phase 为 pre 的，后置只跑 phase 为 post 的，顺序即用户排的顺序。
 * trusted 只对导入来的脚本有意义：false 时不会执行，直到用户在库里点「信任并启用」。
 */
export interface ScriptEntry {
  id: string;
  name: string;
  phase: ScriptPhase;
  /** 作用范围；不匹配当前请求的脚本不会执行。 */
  scope: ScriptScopeKind;
  /** scope 为 collection 时是集合 id，为 request 时是请求节点 id；global 不用。 */
  scopeId?: string;
  source: string;
  /** 关掉就跳过，但脚本仍留在库里。 */
  enabled: boolean;
  trusted: boolean;
}

/**
 * 导入时临时携带的一对脚本（Postman 的一个请求最多一个 prerequest + 一个 test）。
 * 只在 `parseImport` 到 `importCollections` 之间有效，落库前会拆成库里的脚本并清掉。
 */
export interface RequestScript {
  pre: string;
  post: string;
  trusted: boolean;
}

/** 脚本里 console.log / warn / error 产出的一行。 */
export interface ScriptLog {
  level: "log" | "warn" | "error";
  text: string;
}

/** 脚本里 pm.test 产出的一条断言结果。 */
export interface ScriptTest {
  name: string;
  passed: boolean;
  error?: string;
}

/** 一次脚本执行的记录，每条跑过的脚本一条。 */
export interface ScriptRun {
  phase: ScriptPhase;
  /** 库里的脚本名，响应区按它标注这次跑的是哪个脚本。 */
  name?: string;
  /** 这条脚本的作用范围；响应区用它标注来源。 */
  scope?: ScriptScopeKind;
  /** 集合 / 请求的名字，配合 scope 显示成「集合「用户」」。 */
  scopeName?: string;
  logs: ScriptLog[];
  error?: string;
  ms: number;
  /** 后置脚本改写了响应体。 */
  bodyEdited?: boolean;
  /** 脚本里的 pm.test 断言，按执行顺序。 */
  tests?: ScriptTest[];
}

/** 一条请求定义，集合里的请求与标签页里的请求是同一结构。 */
/** 请求的传输方式：普通 HTTP、服务端推送（SSE）、双向 WebSocket。 */
export type RequestProtocol = "http" | "sse" | "ws";

export interface ApiRequest {
  /** 缺省按普通 HTTP 处理，老数据不用迁移。 */
  protocol?: RequestProtocol;
  method: HttpMethod;
  /** 不含查询串的地址；查询串由 params 维护。 */
  url: string;
  params: KV[];
  headers: KV[];
  bodyMode: BodyMode;
  body: string;
  /** binary 模式下要直传的那个文件：内容存 base64，跟着工作区落库。 */
  binary?: BinaryFile;
  /** GraphQL 变量（JSON 文本），body 里存的是 query。 */
  graphqlVars?: string;
  /** 路径变量：地址里 `:id` 这样的占位符对应的值。 */
  pathVars?: KV[];
  form: FormField[];
  auth: AuthConfig;
  options: RequestOptions;
  /** 只由 Postman 导入临时携带，导入时拆成库里的脚本并清掉；不要持久化。 */
  importScript?: RequestScript;
}

export interface RequestNode {
  id: string;
  type: "request";
  name: string;
  request: ApiRequest;
}

export interface FolderNode {
  id: string;
  type: "folder";
  name: string;
  open: boolean;
  items: TreeNode[];
  /** 文件夹级共享认证：子请求自己没设认证时继承它。 */
  auth?: AuthConfig;
  /** 文件夹级变量：子请求插值时优先于环境变量之外的集合与全局。 */
  vars?: KV[];
}

export type TreeNode = RequestNode | FolderNode;

export interface Collection {
  id: string;
  name: string;
  items: TreeNode[];
  /** 集合级共享认证：整棵树里没单独设认证的请求都用它。 */
  auth?: AuthConfig;
  /** 集合级变量：文件夹与请求之外的一层，优先级低于文件夹。 */
  vars?: KV[];
}

/** 一跳：这次用了什么方法、打到哪个地址、返回什么状态码。 */
export interface TraceHop {
  method: string;
  url: string;
  status: number;
}

/** 一跳的分阶段耗时（毫秒），没有发生的阶段为 0。 */
export interface TraceTiming {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  totalMs: number;
  reused: boolean;
}

export interface ResponseTrace {
  hops: TraceHop[];
  timings: TraceTiming[];
}

export interface ResponseRecord {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: [string, string][];
  /** 文本响应的正文；二进制响应为空串。 */
  body: string;
  /** 原始字节数（不是字符数）。 */
  bytes: number;
  /** 非文本响应只保留 base64，不渲染预览。 */
  binary: boolean;
  base64?: string;
  durationMs: number;
  /** 等到响应头的时间（首字节），和下载正文的时间分开记，慢在哪一段一眼能看出。 */
  waitMs: number;
  /** 读完响应体的时间。 */
  downloadMs: number;
  /** 首次响应字节到达的时刻（毫秒时间戳）。 */
  at: number;
  contentType: string;
  /** 正文超过预览上限，只保留了前一段。 */
  truncated: boolean;
  /** 网络/超时/取消失败时的中文提示。 */
  error?: string;
  /** 错误分类，用于提示文案。 */
  errorKind?: "network" | "timeout" | "aborted" | "invalid";
  /** 本次请求的脚本执行记录（前置 / 后置），只在内存里。 */
  scripts?: ScriptRun[];
  /** 重定向逐跳链路与分阶段耗时（由 Go 侧 trace.go 采集）。 */
  trace?: ResponseTrace;
}

/** multipart 里的一个文件：只记名字与大小，不重复存内容。 */
export interface SentFile {
  key: string;
  name: string;
  size: number;
}

/** 实际发出的请求体形态。 */
export type SentBody =
  | { kind: "none" }
  | { kind: "text"; contentType: string; text: string; chars: number; truncated: boolean }
  | { kind: "form"; contentType: string; fields: [string, string][]; files: SentFile[] }
  | { kind: "binary"; contentType: string; name: string; bytes: number };

/**
 * 最近一次实际发出的请求快照。变量已插值、认证头已合并、自动 Content-Type 已补上，
 * 就是真正交给 fetch 的内容，出问题时直接看它。只存在内存，不写进数据库。
 */
export interface SentRecord {
  method: string;
  url: string;
  headers: [string, string][];
  body: SentBody;
  timeoutMs: number;
  redirect: RedirectMode;
  keepCookies: boolean;
  authType: AuthType;
  /** 发送时刻（毫秒时间戳）。 */
  at: number;
}

/** 流式连接里的一条消息（SSE 事件或 WebSocket 消息）。 */
export interface StreamMessage {
  id: string;
  at: number;
  /** in = 服务端发来，out = 我们发出去，sys = 连接状态变化。 */
  dir: "in" | "out" | "sys";
  /** SSE 的事件名（message / update…），WS 的 text | binary，sys 的说明。 */
  kind: string;
  text: string;
}

export type StreamState = "idle" | "connecting" | "open" | "closed" | "error";

/** SSE / WebSocket 会话的运行时状态（不落盘）。 */
export interface StreamSession {
  state: StreamState;
  messages: StreamMessage[];
  /** SSE 才有：握手得到的 HTTP 状态与响应头。 */
  meta?: {
    url: string;
    status: number;
    statusText: string;
    headers: { key: string; value: string }[];
    protocol?: string;
  };
  /** 出错时的中文说明。 */
  error?: string;
  /** 连接持续时长（毫秒），断开后显示。 */
  durationMs?: number;
}

export interface Tab {
  id: string;
  name: string;
  request: ApiRequest;
  /** 内容与集合里保存的版本不一致。 */
  dirty: boolean;
  /** 来源于集合中的某个请求（用于 Ctrl+S 直接保存回原位置）。 */
  origin?: { collectionId: string; nodeId: string };
  response?: ResponseRecord;
  /** 最近一次实际发出的请求快照（排查用，不落盘）。 */
  sent?: SentRecord;
  /** 最近一次发送的脚本记录（前置失败时也要能看到，所以挂在标签页上）。 */
  scriptRuns?: ScriptRun[];
  /** SSE / WebSocket 的连接状态与消息流（只在当前会话里有效）。 */
  stream?: StreamSession;
  sending: boolean;
  /** 响应区分栏当前展示的页签。 */
  responseTab: "body" | "headers" | "request" | "trace";
  /** 响应体展示方式。 */
  bodyView: "pretty" | "raw";
  /** 响应体搜索词。 */
  search: string;
  /** 请求编辑区的当前子页签。 */
  requestTab: "params" | "headers" | "body" | "auth" | "options" | "script";
}

export interface HistoryEntry {
  id: string;
  at: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  request: ApiRequest;
}

export interface Env {
  id: string;
  name: string;
  vars: KV[];
}

export type ThemeMode = "auto" | "dark" | "light";

export interface PersistedWorkspace {
  version: number;
  collections: Collection[];
  history: HistoryEntry[];
  envs: Env[];
  activeEnvId: string;
  globals: KV[];
  /** 脚本库，数组顺序就是执行顺序。 */
  scripts?: ScriptEntry[];
  tabs: PersistedTab[];
  activeTabId: string | null;
  theme: ThemeMode;
  sidebarWidth: number;
  responseHeight: number;
  sidebarTab: "collections" | "history";
  /** 侧边栏是否收起，落库后重启能保持用户的布局。 */
  sidebarCollapsed: boolean;
  onboardingDone: boolean;
  /** 关闭窗口时最小化到托盘。桌面外壳启动时读它，用户在托盘菜单里改它。 */
  closeToTray: boolean;
  /** 是否注册系统级快捷键（CmdOrCtrl+Shift+M 唤起窗口）。 */
  globalShortcut: boolean;
  /** 界面缩放，1 = 100%。走 WebView 的真实缩放，重启后恢复。 */
  zoom: number;
  /** 代码区（请求体 / 响应体 / 脚本）的字号，单位 px。 */
  codeFontSize: number;
  /** 快捷键覆盖：只存用户改过的动作（id → 组合键），没改的用 src/shortcuts.ts 的默认值。 */
  shortcuts: Record<string, string>;
}

export type PersistedTab = Omit<
  Tab,
  "response" | "sent" | "sending" | "search" | "requestTab" | "bodyView" | "responseTab"
>;
