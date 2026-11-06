// 通用小工具：id、转义、格式化、变量插值、动态变量。

import type { KV } from "./types";

let counter = 0;

/** 生成短随机 id，用作列表 key 与节点标识。 */
export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** HTML 注入用：把用户数据转成可安全放进 innerHTML 的文本。 */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 把内容放进 <script type="application/json"> 之外的地方时用不到，但搜索高亮需要。 */
export function escRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 字节数转人类可读，例如 1.2 KB、3.4 MB。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 毫秒转人类可读耗时。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 相对时间：刚刚 / 3 分钟前 / 昨天 14:20 / 2024-05-01。 */
export function formatRelative(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `今天 ${hhmm}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** 方法名的配色分类，样式层用。 */
export function methodTone(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "get";
    case "POST":
      return "post";
    case "PUT":
    case "PATCH":
      return "put";
    case "DELETE":
      return "delete";
    default:
      return "other";
  }
}

/** 尝试把字符串当作 JSON 解析，失败返回 undefined。 */
export function tryParseJSON(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  const first = t[0];
  if (first !== "{" && first !== "[" && first !== '"') return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * 用两层缩进格式化 JSON；保持对象键的原始顺序。解析失败返回 null，
 * 调用方据此回退到原文展示。
 */
export function prettyJSON(text: string, indent = 2): string | null {
  const v = tryParseJSON(text);
  if (v === undefined) return null;
  try {
    return JSON.stringify(v, null, indent);
  } catch {
    return null;
  }
}

/** 猜测响应是否为文本，用于决定是否渲染预览。 */
export function isTextualContentType(ct: string): boolean {
  const t = ct.toLowerCase();
  if (!t) return true;
  if (t.startsWith("text/")) return true;
  if (/[/+](json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql)/.test(t)) return true;
  if (t.includes("yaml") || t.includes("csv") || t.includes("html") || t.includes("svg")) return true;
  if (t.startsWith("application/x-ndjson")) return true;
  return false;
}

/** 根据 URL 猜一个请求名字：路径最后一段或主机名。 */
export function guessName(url: string, method: string): string {
  const raw = url.trim();
  if (!raw) return `${method} 新请求`;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const u = new URL(withScheme);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
    return u.hostname || `${method} 新请求`;
  } catch {
    return `${method} 新请求`;
  }
}

/** 把 URL 拆成基础地址与查询参数（用于把粘贴的完整 URL 还原成表格）。 */
export function splitURL(raw: string): { base: string; params: { key: string; value: string }[] } {
  const text = raw.trim();
  const qIndex = text.indexOf("?");
  if (qIndex < 0) return { base: text, params: [] };
  const base = text.slice(0, qIndex);
  const query = text.slice(qIndex + 1).split("#")[0] ?? "";
  const params: { key: string; value: string }[] = [];
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    params.push({ key: safeDecode(key), value: safeDecode(value) });
  }
  return { base, params };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * 发送前的协议兜底：变量解析完仍然没有协议才补 http://。
 * 只在发请求时用，不回填地址栏——地址栏保持用户原样输入。
 * 顺带清理旧版存下的 `http://{{var}}`（协议写在变量外面那种脏数据）。
 */
export function ensureScheme(url: string): string {
  const t = stripSchemeBeforeVar(url);
  if (!t) return t;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return `http://${t}`;
}

/**
 * 去掉写在变量外面的协议：`http://{{baseUrl}}/x` → `{{baseUrl}}/x`。
 * 协议由变量值带，否则插值后会拼成 `http://https://…` 打不开的地址。
 */
export function stripSchemeBeforeVar(url: string): string {
  return url.trim().replace(/^https?:\/\/(?=\{\{)/i, "");
}

// ---- 变量插值 ----

export interface VarScope {
  /** 当前环境变量。 */
  env: KV[];
  /** 全局变量。 */
  globals: KV[];
}

/** 解析变量名到值；环境优先于全局。 */
export function lookupVar(name: string, scope: VarScope): string | undefined {
  const hit = scope.env.find((v) => v.enabled && v.key === name);
  if (hit) return hit.value;
  const g = scope.globals.find((v) => v.enabled && v.key === name);
  if (g) return g.value;
  return undefined;
}

/** 内置动态变量，例如 {{$timestamp}}、{{$uuid}}。 */
export function dynamicVar(name: string): string | undefined {
  switch (name) {
    case "$timestamp":
      return String(Math.floor(Date.now() / 1000));
    case "$timestampMs":
      return String(Date.now());
    case "$isoTimestamp":
      return new Date().toISOString();
    case "$uuid":
      return crypto.randomUUID();
    case "$randomInt":
      return String(Math.floor(Math.random() * 1000));
    case "$randomBoolean":
      return Math.random() < 0.5 ? "true" : "false";
    default:
      return undefined;
  }
}

export const DYNAMIC_VARS = [
  { name: "$timestamp", desc: "当前时间的秒级 Unix 时间戳" },
  { name: "$timestampMs", desc: "当前时间的毫秒级时间戳" },
  { name: "$isoTimestamp", desc: "当前时间的 ISO 8601 字符串" },
  { name: "$uuid", desc: "随机 UUID v4" },
  { name: "$randomInt", desc: "0 到 999 之间的随机整数" },
  { name: "$randomBoolean", desc: "随机 true 或 false" },
];

export interface InterpolateResult {
  text: string;
  /** 未能解析的变量名（去重后的原始名字，不含花括号）。 */
  missing: string[];
}

/** 把 {{变量}} 替换成实际值，同时收集未定义的变量名。 */
export function interpolate(text: string, scope: VarScope): InterpolateResult {
  const missing = new Set<string>();
  if (!text || !text.includes("{{")) return { text, missing: [] };
  const out = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, rawName: string) => {
    const name = rawName.trim();
    const dyn = dynamicVar(name);
    if (dyn !== undefined) return dyn;
    const v = lookupVar(name, scope);
    if (v === undefined) {
      missing.add(name);
      return whole;
    }
    return v;
  });
  return { text: out, missing: [...missing] };
}

/** 当前作用域里所有可用变量名，供补全列表使用。 */
export function visibleVarNames(scope: VarScope): string[] {
  const names = new Set<string>();
  for (const v of scope.env) if (v.enabled && v.key) names.add(v.key);
  for (const v of scope.globals) if (v.enabled && v.key) names.add(v.key);
  for (const d of DYNAMIC_VARS) names.add(d.name);
  return [...names];
}

/** 把 cURL 里常见的 shell 变量引用原样保留（不当作项目变量处理）。 */
export function randomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}
