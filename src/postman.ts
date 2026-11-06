// 与 Postman / HAR 互换：把别人的 collection 引进来，也把自己的集合导出去。
// 只处理请求本身（方法、地址、头、体、认证），脚本、测试、变量作用域这些
// 属于 Postman 的重型能力，本工具不做，导入时以 warnings 的形式说明被忽略的部分。

import { emptyRequest } from "./curl";
import type { ApiRequest, AuthConfig, Collection, FormField, KV, TreeNode } from "./types";
import { uid } from "./util";

export type ImportKind = "postman" | "har";

export interface ImportResult {
  kind: ImportKind;
  collection: Collection;
  warnings: string[];
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function kvItem(key: string, value: string, enabled = true): KV {
  return { id: uid("kv"), key, value, enabled };
}

function formItem(key: string, value: string, enabled = true, fileName?: string): FormField {
  return fileName
    ? { id: uid("form"), key, value, enabled, kind: "file", fileName }
    : { id: uid("form"), key, value, enabled, kind: "text" };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arrayOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ---- Postman 数据结构（只声明用到的字段） ----

interface PMKeyVal {
  key?: unknown;
  value?: unknown;
  disabled?: unknown;
  type?: unknown;
  src?: unknown;
  fileName?: unknown;
}

interface PMURL {
  raw?: unknown;
  protocol?: unknown;
  host?: unknown;
  path?: unknown;
  query?: unknown;
}

interface PMRequest {
  method?: unknown;
  url?: unknown;
  header?: unknown;
  body?: unknown;
  auth?: unknown;
}

interface PMItem {
  name?: unknown;
  item?: unknown;
  request?: unknown;
}

function keyValList(raw: unknown): PMKeyVal[] {
  return arrayOf(raw).filter(isObject).map((o) => o as PMKeyVal);
}

function pmAuthValue(list: unknown, key: string): string {
  const found = keyValList(list).find((p) => asString(p.key).toLowerCase() === key);
  return found ? asString(found.value) : "";
}

function urlFromPM(url: unknown): string {
  if (typeof url === "string") return url;
  if (!isObject(url)) return "";
  const u = url as PMURL;
  const raw = asString(u.raw).trim();
  if (raw) return raw;
  const host = Array.isArray(u.host) ? u.host.map(asString).join(".") : asString(u.host);
  const path = Array.isArray(u.path)
    ? u.path
        .map((p) => (isObject(p) ? asString((p as Record<string, unknown>).value) : asString(p)))
        .join("/")
    : asString(u.path);
  const proto = asString(u.protocol) || "http";
  const joined = [host, path].filter(Boolean).join("/");
  return joined ? `${proto}://${joined}` : "";
}

function applyAuth(req: ApiRequest, raw: unknown, warnings: string[]): void {
  if (!isObject(raw)) return;
  const auth = raw as Record<string, unknown>;
  const type = asString(auth.type).toLowerCase();
  const target: AuthConfig = req.auth;
  if (type === "bearer") {
    target.type = "bearer";
    target.token = pmAuthValue(auth.bearer, "token");
    return;
  }
  if (type === "basic") {
    target.type = "basic";
    target.username = pmAuthValue(auth.basic, "username");
    target.password = pmAuthValue(auth.basic, "password");
    return;
  }
  if (type === "apikey") {
    target.type = "apikey";
    target.key = pmAuthValue(auth.apikey, "key");
    target.value = pmAuthValue(auth.apikey, "value");
    target.in = pmAuthValue(auth.apikey, "in").toLowerCase() === "query" ? "query" : "header";
    return;
  }
  if (type && type !== "noauth") warnings.push(`认证类型 ${type} 暂不支持，已跳过`);
}

function applyBody(req: ApiRequest, raw: unknown, warnings: string[]): void {
  if (!isObject(raw)) return;
  const body = raw as Record<string, unknown>;
  const mode = asString(body.mode).toLowerCase();

  if (mode === "raw") {
    const options = isObject(body.options) ? (body.options as Record<string, unknown>) : {};
    const rawOptions = isObject(options.raw) ? (options.raw as Record<string, unknown>) : {};
    const language = asString(rawOptions.language).toLowerCase();
    req.body = asString(body.raw);
    req.bodyMode = language === "json" || looksJSON(req.body) ? "json" : "text";
    return;
  }
  if (mode === "urlencoded") {
    req.bodyMode = "urlencoded";
    req.form = keyValList(body.urlencoded).map((p) =>
      formItem(asString(p.key), asString(p.value), p.disabled !== true),
    );
    return;
  }
  if (mode === "formdata") {
    req.bodyMode = "form";
    req.form = keyValList(body.formdata).map((p) => {
      const isFile = asString(p.type).toLowerCase() === "file";
      return isFile
        ? formItem(asString(p.key), "", p.disabled !== true, "原文件未随集合导出")
        : formItem(asString(p.key), asString(p.value), p.disabled !== true);
    });
    return;
  }
  if (mode === "graphql") {
    warnings.push("GraphQL 请求体已按文本导入，变量需要手动补");
  }
}

function looksJSON(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function requestFromPM(raw: unknown, warnings: string[]): ApiRequest {
  if (typeof raw === "string") {
    // 老版本允许 request 只写一个地址字符串。
    return emptyRequest(raw);
  }
  const pm = (isObject(raw) ? raw : {}) as PMRequest;
  const url = urlFromPM(pm.url);
  const req = emptyRequest(url);

  const method = asString(pm.method).toUpperCase();
  if (METHODS.has(method)) req.method = method as ApiRequest["method"];

  const headers = keyValList(pm.header);
  if (headers.length > 0) {
    req.headers = headers
      .filter((h) => asString(h.key).trim() !== "")
      .map((h) => kvItem(asString(h.key), asString(h.value), h.disabled !== true));
  }

  // URL 里的 query 数组带 enabled 状态，比拆 raw 更准确，有就以它为准。
  if (isObject(pm.url)) {
    const query = keyValList((pm.url as PMURL).query);
    if (query.length > 0) {
      req.params = query.map((p) => kvItem(asString(p.key), asString(p.value), p.disabled !== true));
    }
  }

  applyBody(req, pm.body, warnings);
  applyAuth(req, pm.auth, warnings);
  return req;
}

function walkPMItems(items: unknown, warnings: string[]): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const raw of arrayOf(items)) {
    if (!isObject(raw)) continue;
    const item = raw as PMItem;
    const name = asString(item.name).trim() || "未命名";
    if (Array.isArray(item.item)) {
      nodes.push({ id: uid("folder"), type: "folder", name, open: true, items: walkPMItems(item.item, warnings) });
      continue;
    }
    if (item.request !== undefined) {
      nodes.push({ id: uid("req"), type: "request", name, request: requestFromPM(item.request, warnings) });
    }
  }
  return nodes;
}

/** 解析 Postman Collection v2.0 / v2.1。 */
export function parsePostman(raw: unknown): ImportResult {
  if (!isObject(raw)) throw new Error("不是合法的 JSON 对象");
  const info = isObject(raw.info) ? (raw.info as Record<string, unknown>) : {};
  const items = raw.item;
  if (!Array.isArray(items)) throw new Error("缺少 item 字段，不像是 Postman Collection");
  const schema = asString(info.schema);
  const warnings: string[] = [];
  if (schema && !/v2\.(0|1)/.test(schema)) warnings.push(`Collection 版本 ${schema} 未经验证，按 v2.1 解析`);
  const name = asString(info.name).trim() || "导入的集合";
  return {
    kind: "postman",
    collection: { id: uid("col"), name, items: walkPMItems(items, warnings) },
    warnings,
  };
}

// ---- HAR ----

interface HARRequest {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  postData?: unknown;
}

function requestFromHAR(raw: unknown, warnings: string[]): ApiRequest {
  const har = (isObject(raw) ? raw : {}) as HARRequest;
  const req = emptyRequest(asString(har.url));

  const method = asString(har.method).toUpperCase();
  if (METHODS.has(method)) req.method = method as ApiRequest["method"];

  const headers = arrayOf(har.headers).filter(isObject) as Record<string, unknown>[];
  const usable = headers
    .map((h) => [asString(h.name), asString(h.value)] as [string, string])
    .filter(([k]) => k.trim() !== "");
  if (usable.length > 0) req.headers = usable.map(([k, v]) => kvItem(k, v));

  if (isObject(har.postData)) {
    const post = har.postData as Record<string, unknown>;
    const mime = asString(post.mimeType).toLowerCase();
    const text = asString(post.text);
    const params = arrayOf(post.params).filter(isObject) as Record<string, unknown>[];

    if (mime.includes("json")) {
      req.bodyMode = "json";
      req.body = text;
    } else if (mime.includes("x-www-form-urlencoded")) {
      req.bodyMode = "urlencoded";
      req.form = params.length
        ? params.map((p) => formItem(asString(p.name), asString(p.value)))
        : text.split("&").filter(Boolean).map((pair) => {
            const idx = pair.indexOf("=");
            const k = idx < 0 ? pair : pair.slice(0, idx);
            const v = idx < 0 ? "" : pair.slice(idx + 1);
            return formItem(decodeURIComponent(k), decodeURIComponent(v));
          });
    } else if (mime.includes("multipart")) {
      req.bodyMode = "form";
      req.form = params.map((p) =>
        asString(p.fileName)
          ? formItem(asString(p.name), "", true, asString(p.fileName))
          : formItem(asString(p.name), asString(p.value)),
      );
    } else if (text) {
      req.bodyMode = "text";
      req.body = text;
    }
    if (post.params && !params.length && text && mime.includes("multipart")) {
      warnings.push("multipart 请求体的字段无法从 HAR 还原，已跳过");
    }
  }
  return req;
}

/** 解析浏览器导出的 HAR：每个请求变成一条记录，整体装进一个集合。 */
export function parseHar(raw: unknown): ImportResult {
  if (!isObject(raw)) throw new Error("不是合法的 JSON 对象");
  const log = isObject(raw.log) ? (raw.log as Record<string, unknown>) : {};
  const entries = arrayOf(log.entries);
  if (entries.length === 0) throw new Error("HAR 里没有 entries，可能是空文件");

  const warnings: string[] = [];
  const items: TreeNode[] = [];
  entries.forEach((entry, i) => {
    if (!isObject(entry)) return;
    const request = (entry as Record<string, unknown>).request;
    if (!request) return;
    const rec = requestFromHAR(request, warnings);
    const host = hostOf(rec.url);
    const name = `${rec.method} ${host || rec.url || `#${i + 1}`}`;
    items.push({ id: uid("req"), type: "request", name, request: rec });
  });
  if (items.length === 0) throw new Error("HAR 里的请求都无法解析");

  const creator = isObject(log.creator) ? asString((log.creator as Record<string, unknown>).name) : "";
  const collectionName = creator ? `HAR 导入（${creator}）` : "HAR 导入";
  return { kind: "har", collection: { id: uid("col"), name: collectionName, items }, warnings };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** 按内容猜格式：HAR 有 log.entries，Postman 有 info + item。 */
export function detectKind(raw: unknown): ImportKind | null {
  if (!isObject(raw)) return null;
  if (isObject(raw.log) && Array.isArray((raw.log as Record<string, unknown>).entries)) return "har";
  if (Array.isArray(raw.item)) return "postman";
  return null;
}

/** 一次性解析：自动判断是 Postman 还是 HAR。 */
export function parseImport(raw: unknown): ImportResult {
  const kind = detectKind(raw);
  if (kind === "har") return parseHar(raw);
  if (kind === "postman") return parsePostman(raw);
  throw new Error("无法识别格式：既不是 Postman Collection，也不是 HAR");
}

// ---- 导出为 Postman Collection v2.1 ----

function toPMAuth(auth: AuthConfig): Record<string, unknown> | undefined {
  if (auth.type === "bearer") {
    return { type: "bearer", bearer: [{ key: "token", value: auth.token, type: "string" }] };
  }
  if (auth.type === "basic") {
    return {
      type: "basic",
      basic: [
        { key: "username", value: auth.username, type: "string" },
        { key: "password", value: auth.password, type: "string" },
      ],
    };
  }
  if (auth.type === "apikey") {
    return {
      type: "apikey",
      apikey: [
        { key: "key", value: auth.key, type: "string" },
        { key: "value", value: auth.value, type: "string" },
        { key: "in", value: auth.in, type: "string" },
      ],
    };
  }
  return undefined;
}

function toPMBody(req: ApiRequest): Record<string, unknown> | undefined {
  if (req.bodyMode === "json") {
    return { mode: "raw", raw: req.body, options: { raw: { language: "json" } } };
  }
  if (req.bodyMode === "text") {
    return { mode: "raw", raw: req.body, options: { raw: { language: "text" } } };
  }
  if (req.bodyMode === "urlencoded") {
    return {
      mode: "urlencoded",
      urlencoded: req.form.map((f) => ({ key: f.key, value: f.value, disabled: !f.enabled, type: "text" })),
    };
  }
  if (req.bodyMode === "form") {
    return {
      mode: "formdata",
      formdata: req.form.map((f) =>
        f.kind === "file"
          ? { key: f.key, type: "file", src: f.fileName ?? "", disabled: !f.enabled }
          : { key: f.key, value: f.value, type: "text", disabled: !f.enabled },
      ),
    };
  }
  return undefined;
}

function toPMRequest(req: ApiRequest): Record<string, unknown> {
  const query = req.params.map((p) => ({ key: p.key, value: p.value, disabled: !p.enabled }));
  const suffix = query
    .filter((p) => !p.disabled && p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join("&");
  const raw = suffix ? `${req.url}${req.url.includes("?") ? "&" : "?"}${suffix}` : req.url;

  const out: Record<string, unknown> = {
    method: req.method,
    header: req.headers.map((h) => ({ key: h.key, value: h.value, type: "text", disabled: !h.enabled })),
    url: { raw, query },
  };
  const auth = toPMAuth(req.auth);
  if (auth) out.auth = auth;
  const body = toPMBody(req);
  if (body) out.body = body;
  return out;
}

function toPMItems(nodes: TreeNode[], prefix: string): Record<string, unknown>[] {
  return nodes.map((node, i) => {
    const name = node.name || `${prefix}${i + 1}`;
    if (node.type === "folder") {
      return { name, item: toPMItems(node.items, `${name} / `) };
    }
    return { name, request: toPMRequest(node.request) };
  });
}

/**
 * 导出为 Postman Collection v2.1：多个集合会各自变成一个顶层文件夹，
 * 这样一个文件就能整包导入 Postman，不用逐个导。
 */
export function toPostmanCollection(collections: Collection[], envs: { name: string; vars: KV[] }[]): string {
  const items: Record<string, unknown>[] =
    collections.length === 1
      ? toPMItems(collections[0]?.items ?? [], "")
      : collections.map((c) => ({ name: c.name, item: toPMItems(c.items, "") }));

  const dump = {
    info: {
      name: collections.length === 1 ? (collections[0]?.name ?? "MyGo API") : "MyGo API 全部集合",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: items,
    variable: envs.flatMap((e) =>
      e.vars.filter((v) => v.enabled && v.key).map((v) => ({ key: v.key, value: v.value })),
    ),
  };
  return JSON.stringify(dump, null, 2);
}
