// 前置 / 后置脚本的运行时。
//
// 脚本是用户自己写的本地 JavaScript，用 AsyncFunction 在页面里直接跑：
// 没有沙箱隔离（同 Postman 的 vm，但我们不假装有），所以来自导入文件的脚本
// 必须由用户先「信任」才执行 —— 这一个开关就是唯一的安全边界。
//
// 提供的是 Postman `pm` API 的一个子集，够写签名、改响应体、在脚本里再发一个请求、
// 以及拿到响应后让主请求重发一次（登录换 token 那套）：
//   pm.variables / pm.environment / pm.globals
//   pm.request.{method,url,headers,body.raw}
//   pm.response.{code,status,headers,text,json,setBody}
//   pm.sendRequest(spec[, callback]) —— 真发一次 HTTP，地址与头里的 {{变量}} 会插值
//   pm.execution.resend() —— 仅后置脚本：本次响应处理完后把同一个请求再发一遍
//   pm.utils.{hmacSha256,sha256,base64Encode,base64Decode,now,uuid,randomInt}
//   console.log / warn / error

import type { ScriptLog, ScriptScope, ScriptTest } from "./types";

export type ScriptPhase = "pre" | "post";

export interface ScriptRequestState {
  method: string;
  url: string;
  headers: [string, string][];
  /** 文本请求体的当前内容；表单类请求体为 null（脚本改不了文件）。 */
  body: string | null;
}

export interface ScriptResponseState {
  code: number;
  status: string;
  headers: [string, string][];
  body: string;
}

/** pm.sendRequest 归一化后交给宿主发送的请求。 */
export interface ScriptHttpRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
}

/** pm.sendRequest 拿到的响应，字段与主请求的响应不共享。 */
export interface ScriptHttpResponse {
  code: number;
  status: string;
  headers: [string, string][];
  body: string;
  ms: number;
}

export interface ScriptContext {
  request: ScriptRequestState;
  response?: ScriptResponseState;
  /** 读当前作用域里的变量（环境优先于全局，再退回上次脚本设置的值）。 */
  getVar(name: string): string | undefined;
  /** 写环境变量：会立刻落到当前环境并在界面上生效。 */
  setEnvVar(name: string, value: string): void;
  setGlobalVar(name: string, value: string): void;
  /** pm.sendRequest 的真实发送实现，由 store 注入（走 Go 侧类型的 HTTP 栈）。 */
  http(request: ScriptHttpRequest): Promise<ScriptHttpResponse>;
  /** 把 {{变量}} 换成实际值，给 pm.sendRequest 的地址 / 头 / 请求体用。 */
  resolve(text: string): string;
}

export interface ScriptOutcome {
  logs: ScriptLog[];
  error?: string;
  request: ScriptRequestState;
  /** 后置脚本改了响应体时才有值。 */
  responseBody?: string;
  /** 脚本里 pm.variables.set 收集到的值，前置的能在后置里读到。 */
  vars: Record<string, string>;
  /** pm.test 断言结果。 */
  tests: ScriptTest[];
  /** 脚本里调了 pm.execution.resend()，这次响应处理完要把同一个请求再发一遍。 */
  resend?: boolean;
  ms: number;
}

const SCRIPT_TIMEOUT_MS = 5000;

type AsyncFn = (pm: unknown, console: unknown) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => AsyncFn;

export function emptyScriptOutcome(request: ScriptRequestState): ScriptOutcome {
  return { logs: [], request, vars: {}, tests: [], ms: 0 };
}

/** 层级的中文叫法，界面提示与日志表头共用（name 只在集合 / 文件夹层上有）。 */
export function scriptScopeLabel(scope: ScriptScope, name?: string): string {
  switch (scope) {
    case "global":
      return "全局";
    case "collection":
      return name ? `集合「${name}」` : "集合";
    case "folder":
      return name ? `文件夹「${name}」` : "文件夹";
    default:
      return "本请求";
  }
}

/** 把脚本里 console.log 的多个参数拼成一行可读文本。 */
function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function cloneHeaders(list: [string, string][]): [string, string][] {
  return list.map(([k, v]) => [k, v]);
}

class HeaderList {
  items: [string, string][];
  constructor(items: [string, string][]) {
    this.items = cloneHeaders(items);
  }
  /** 大小写不敏感地找回第一次出现的位置。 */
  private indexOf(name: string): number {
    const lower = name.toLowerCase();
    return this.items.findIndex(([k]) => k.toLowerCase() === lower);
  }
  add(name: string, value: string): void {
    this.items.push([name, String(value)]);
  }
  upsert(name: string, value: string): void {
    const i = this.indexOf(name);
    const hit = i >= 0 ? this.items[i] : undefined;
    if (hit) this.items[i] = [hit[0], String(value)];
    else this.items.push([name, String(value)]);
  }
  remove(name: string): void {
    const lower = name.toLowerCase();
    this.items = this.items.filter(([k]) => k.toLowerCase() !== lower);
  }
  get(name: string): string | undefined {
    const i = this.indexOf(name);
    return i >= 0 ? this.items[i]?.[1] : undefined;
  }
  has(name: string): boolean {
    return this.indexOf(name) >= 0;
  }
  all(): [string, string][] {
    return cloneHeaders(this.items);
  }
}

async function digest(algo: "SHA-1" | "SHA-256" | "SHA-512", text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest(algo, new TextEncoder().encode(text));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const HMAC_ALGOS = { sha1: "SHA-1", sha256: "SHA-256", sha512: "SHA-512" } as const;

/** pm.sendRequest 的 header / headers 支持对象与 [{key,value}] 两种写法。 */
function specHeaders(raw: unknown): [string, string][] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out: [string, string][] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const kv = item as Record<string, unknown>;
      const key = typeof kv.key === "string" ? kv.key : "";
      if (!key.trim()) continue;
      out.push([key, kv.value === undefined || kv.value === null ? "" : String(kv.value)]);
    }
    return out;
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
      key,
      value === undefined || value === null ? "" : String(value),
    ]);
  }
  return [];
}

/** 把 pm.sendRequest 的 body 归一成字符串；只支持 raw 与 urlencoded。 */
function specBody(
  raw: unknown,
  resolve: (text: string) => string,
): { body?: string; contentType?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") return { body: resolve(raw) };
  if (typeof raw !== "object") return { body: resolve(String(raw)) };
  const spec = raw as Record<string, unknown>;
  const mode = typeof spec.mode === "string" ? spec.mode : "raw";
  if (mode === "urlencoded") {
    const params = new URLSearchParams();
    const rows = Array.isArray(spec.urlencoded) ? spec.urlencoded : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const kv = row as Record<string, unknown>;
      const key = typeof kv.key === "string" ? kv.key : "";
      if (!key) continue;
      const value = kv.value === undefined || kv.value === null ? "" : String(kv.value);
      params.append(key, resolve(value));
    }
    return { body: params.toString(), contentType: "application/x-www-form-urlencoded" };
  }
  if (mode === "raw") {
    return { body: resolve(spec.raw === undefined || spec.raw === null ? "" : String(spec.raw)) };
  }
  throw new Error(`pm.sendRequest 不支持 ${mode} 请求体，只支持 raw 与 urlencoded`);
}

function normalizeSendRequest(spec: unknown, resolve: (text: string) => string): ScriptHttpRequest {
  if (typeof spec === "string") {
    const url = resolve(spec).trim();
    if (!url) throw new Error("pm.sendRequest 需要一个地址");
    return { method: "GET", url, headers: [] };
  }
  if (!spec || typeof spec !== "object") {
    throw new Error("pm.sendRequest 需要一个地址字符串，或 { url, method, header, body }");
  }
  const obj = spec as Record<string, unknown>;
  const url = resolve(typeof obj.url === "string" ? obj.url : "").trim();
  if (!url) throw new Error("pm.sendRequest 需要一个地址");
  const headers = [...specHeaders(obj.headers), ...specHeaders(obj.header)].map(
    ([key, value]) => [key, resolve(value)] as [string, string],
  );
  const body = specBody(obj.body, resolve);
  if (!headers.some(([key]) => key.toLowerCase() === "content-type")) {
    if (body.contentType) headers.push(["Content-Type", body.contentType]);
  }
  const method = typeof obj.method === "string" && obj.method ? obj.method : "GET";
  return { method: method.toUpperCase(), url, headers, body: body.body };
}

/** 包装成脚本里能直接用的响应对象（与 pm.response 形状一致，另有 responseTime）。 */
function wrapHttpResponse(res: ScriptHttpResponse) {
  let body = res.body;
  const find = (name: string): string | undefined => {
    const lower = String(name).toLowerCase();
    return res.headers.find(([key]) => key.toLowerCase() === lower)?.[1];
  };
  return {
    code: res.code,
    status: res.status,
    responseTime: res.ms,
    headers: {
      get: (name: string) => find(name),
      has: (name: string) => find(name) !== undefined,
      all: () => cloneHeaders(res.headers),
    },
    text: () => body,
    json: () => JSON.parse(body),
    /** 在脚本里改写这次 sendRequest 的响应体（对主请求无影响）。 */
    setBody: (value: unknown) => {
      body = value === undefined || value === null ? "" : String(value);
    },
    get body(): string {
      return body;
    },
  };
}

function buildUtils() {
  return {
    /** HMAC 签名，默认输出 hex；写签名头基本就靠它。 */
    async hmac(
      algo: keyof typeof HMAC_ALGOS,
      key: string,
      message: string,
      encoding: "hex" | "base64" = "hex",
    ): Promise<string> {
      const name = HMAC_ALGOS[algo];
      if (!name) throw new Error(`不支持的算法：${algo}`);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(key),
        { name: "HMAC", hash: name },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
      return encoding === "base64" ? toBase64(sig) : toHex(sig);
    },
    hmacSha256(key: string, message: string, encoding: "hex" | "base64" = "hex"): Promise<string> {
      return this.hmac("sha256", key, message, encoding);
    },
    async sha256(text: string, encoding: "hex" | "base64" = "hex"): Promise<string> {
      const buf = await digest("SHA-256", text);
      return encoding === "base64" ? toBase64(buf) : toHex(buf);
    },
    async md5Unsupported(): Promise<never> {
      throw new Error("浏览器只提供 sha1/sha256/sha512，md5 需要自己实现");
    },
    base64Encode(text: string): string {
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary);
    },
    base64Decode(text: string): string {
      const binary = atob(text);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    },
    now(): number {
      return Date.now();
    },
    uuid(): string {
      return crypto.randomUUID();
    },
    randomInt(min = 0, max = 999): number {
      return min + Math.floor(Math.random() * (max - min + 1));
    },
    /** 把对象拼成 queryString，签名时常用。 */
    queryString(params: Record<string, string>): string {
      return new URLSearchParams(params).toString();
    },
  };
}

export async function runScript(
  phase: ScriptPhase,
  source: string,
  ctx: ScriptContext,
  inheritedVars: Record<string, string> = {},
): Promise<ScriptOutcome> {
  const request: ScriptRequestState = {
    method: ctx.request.method,
    url: ctx.request.url,
    headers: cloneHeaders(ctx.request.headers),
    body: ctx.request.body,
  };
  const headers = new HeaderList(request.headers);
  const vars: Record<string, string> = { ...inheritedVars };
  const logs: ScriptLog[] = [];
  let responseBody = ctx.response?.body;
  const started = performance.now();
  let resend = false;

  // 5 秒是给「脚本自己算」的预算：pm.sendRequest 等网络的时间不算在内，
  // 否则一次登录请求就能把整个脚本拖进超时。disarm 时把已用时间扣掉，
  // 所以连发多个请求也不会每次重新领满 5 秒。
  let remaining = SCRIPT_TIMEOUT_MS;
  let armedAt = 0;
  let budgetTimer = 0;
  let failBudget: (err: Error) => void = () => {};
  const budget = new Promise<never>((_, reject) => {
    failBudget = reject;
  });
  const timeoutError = () => new Error(`脚本执行超过 ${SCRIPT_TIMEOUT_MS / 1000} 秒，已中止`);
  const armBudget = (): void => {
    if (budgetTimer) return;
    armedAt = performance.now();
    if (remaining <= 0) {
      failBudget(timeoutError());
      return;
    }
    budgetTimer = window.setTimeout(() => {
      budgetTimer = 0;
      remaining = 0;
      failBudget(timeoutError());
    }, remaining);
  };
  const disarmBudget = (): void => {
    if (!budgetTimer) return;
    window.clearTimeout(budgetTimer);
    budgetTimer = 0;
    remaining = Math.max(0, remaining - (performance.now() - armedAt));
  };
  armBudget();

  const log = (level: ScriptLog["level"]) => (...args: unknown[]) => {
    logs.push({ level, text: args.map(formatArg).join(" ") });
  };

  // pm.test 断言：通过就记一条绿的，抛错记一条红的，不打断脚本后续逻辑。
  const tests: ScriptTest[] = [];
  const pending: Promise<void>[] = [];
  const test = (name: string, fn?: unknown): void => {
    const entry: ScriptTest = { name: String(name ?? "").trim() || "未命名断言", passed: true };
    tests.push(entry);
    if (typeof fn !== "function") return;
    try {
      const result = (fn as () => unknown)();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        pending.push(
          (result as Promise<unknown>).then(
            () => undefined,
            (err: unknown) => {
              entry.passed = false;
              entry.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            },
          ),
        );
      }
    } catch (err) {
      entry.passed = false;
      entry.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  };

  const pm = {
    variables: {
      get: (name: string) => vars[name] ?? ctx.getVar(name),
      set: (name: string, value: unknown) => {
        vars[name] = value === undefined || value === null ? "" : String(value);
      },
      unset: (name: string) => {
        delete vars[name];
      },
      toObject: () => ({ ...vars }),
    },
    environment: {
      get: (name: string) => ctx.getVar(name),
      set: (name: string, value: unknown) => {
        const text = value === undefined || value === null ? "" : String(value);
        vars[name] = text;
        ctx.setEnvVar(name, text);
      },
      unset: (name: string) => ctx.setEnvVar(name, ""),
    },
    globals: {
      get: (name: string) => ctx.getVar(name),
      set: (name: string, value: unknown) => {
        const text = value === undefined || value === null ? "" : String(value);
        vars[name] = text;
        ctx.setGlobalVar(name, text);
      },
    },
    request: {
      get method() {
        return request.method;
      },
      set method(value: string) {
        request.method = String(value).toUpperCase();
      },
      get url() {
        return request.url;
      },
      set url(value: string) {
        request.url = String(value);
      },
      headers: {
        add: (arg: { key: string; value: string } | string, value?: string) => {
          if (typeof arg === "string") headers.add(arg, value ?? "");
          else if (arg && typeof arg.key === "string") headers.add(arg.key, arg.value ?? "");
        },
        upsert: (arg: { key: string; value: string } | string, value?: string) => {
          if (typeof arg === "string") headers.upsert(arg, value ?? "");
          else if (arg && typeof arg.key === "string") headers.upsert(arg.key, arg.value ?? "");
        },
        remove: (name: string) => headers.remove(name),
        get: (name: string) => headers.get(name),
        has: (name: string) => headers.has(name),
        all: () => headers.all(),
      },
      body: {
        get raw() {
          return request.body;
        },
        set raw(value: string | null) {
          if (request.body === null) {
            throw new Error("表单类请求体不能用脚本改写，请改用文本或 JSON 请求体");
          }
          request.body = value === null || value === undefined ? "" : String(value);
        },
      },
    },
    response:
      phase === "post" && ctx.response
        ? {
            get code() {
              return ctx.response!.code;
            },
            get status() {
              return ctx.response!.status;
            },
            get headers() {
              return {
                get: (name: string) => {
                  const lower = name.toLowerCase();
                  return ctx.response!.headers.find(([k]) => k.toLowerCase() === lower)?.[1];
                },
                all: () => cloneHeaders(ctx.response!.headers),
              };
            },
            text: () => responseBody ?? "",
            json: () => JSON.parse(responseBody ?? ""),
            /** 改写响应体：只影响界面显示与后续导出，不改变原始字节数。 */
            setBody: (value: unknown) => {
              responseBody = value === undefined || value === null ? "" : String(value);
            },
          }
        : undefined,
    utils: buildUtils(),
    /**
     * 在脚本里真发一个 HTTP 请求（登录换 token 就靠它）。
     * 传了 callback 就走回调风格，错误交回回调而不抛；不传则返回 Promise。
     */
    sendRequest: async (spec: unknown, callback?: unknown) => {
      const requestSpec = normalizeSendRequest(spec, ctx.resolve);
      const cb =
        typeof callback === "function"
          ? (callback as (err: Error | null, res?: ReturnType<typeof wrapHttpResponse>) => void)
          : undefined;
      const perform = async () => {
        disarmBudget();
        try {
          return wrapHttpResponse(await ctx.http(requestSpec));
        } finally {
          armBudget();
        }
      };
      if (!cb) return perform();
      try {
        const result = await perform();
        cb(null, result);
        return result;
      } catch (err) {
        cb(err instanceof Error ? err : new Error(String(err)));
        return undefined;
      }
    },
    execution: {
      /** 正在跑的是前置还是后置脚本。 */
      phase,
      /**
       * 后置脚本专用：等这次响应处理完，用新的变量值把同一个请求再发一遍。
       * 前置脚本里请求还没发出去，调它只能算写错。
       */
      resend: () => {
        if (phase !== "post") {
          throw new Error("只有后置脚本能重发请求：前置脚本执行时请求还没发出去");
        }
        resend = true;
      },
    },
    test,
    expect: undefined,
  };

  const fakeConsole = {
    log: log("log"),
    info: log("log"),
    warn: log("warn"),
    error: log("error"),
    debug: log("log"),
  };

  let error: string | undefined;
  try {
    const fn = new AsyncFunction("pm", "console", `"use strict";\n${source}`);
    await Promise.race([fn(pm, fakeConsole), budget]);
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } finally {
    disarmBudget();
  }

  request.headers = headers.all();
  return {
    logs,
    error,
    request,
    responseBody: phase === "post" && responseBody !== ctx.response?.body ? responseBody : undefined,
    vars,
    tests,
    resend,
    ms: Math.max(0, Math.round(performance.now() - started)),
  };
}
