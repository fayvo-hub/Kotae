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

/** 请求体形态。binary（二进制直传）属首版不做的范围。 */
export type BodyMode = "none" | "json" | "text" | "urlencoded" | "form";

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
}

/**
 * 前置 / 后置脚本。老数据里没有这个字段，读的时候统一用 `scriptOf()` 兜底。
 * trusted 只对导入来的脚本有意义：false 时不会执行，直到用户点「信任」。
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

/** 一次脚本执行的记录，前置与后置各一条。 */
export interface ScriptRun {
  phase: "pre" | "post";
  logs: ScriptLog[];
  error?: string;
  ms: number;
  /** 后置脚本改写了响应体。 */
  bodyEdited?: boolean;
}

/** 一条请求定义，集合里的请求与标签页里的请求是同一结构。 */
export interface ApiRequest {
  method: HttpMethod;
  /** 不含查询串的地址；查询串由 params 维护。 */
  url: string;
  params: KV[];
  headers: KV[];
  bodyMode: BodyMode;
  body: string;
  form: FormField[];
  auth: AuthConfig;
  options: RequestOptions;
  /** 前置 / 后置脚本；缺省视为没有脚本。 */
  script?: RequestScript;
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
}

export type TreeNode = RequestNode | FolderNode;

export interface Collection {
  id: string;
  name: string;
  items: TreeNode[];
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
  | { kind: "form"; contentType: string; fields: [string, string][]; files: SentFile[] };

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
  sending: boolean;
  /** 响应区分栏当前展示的页签。 */
  responseTab: "body" | "headers" | "request";
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
}

export type PersistedTab = Omit<
  Tab,
  "response" | "sent" | "sending" | "search" | "requestTab" | "bodyView" | "responseTab"
>;
