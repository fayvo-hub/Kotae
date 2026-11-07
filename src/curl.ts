// cURL 解析与生成。零依赖，行为对齐 curl 手册里最常用的那部分参数：
// -X/--request、-H/--header、-d/--data*、-F/--form、-u/--user、-b/--cookie、
// -A/--user-agent、-e/--referer、--compressed、-k/--insecure、-L/--location、
// --max-time、--url、--json、-G/--get、-I/--head。其余参数忽略并给出提示。

import type { ApiRequest, FormField, HttpMethod, KV, RequestOptions, RequestScript } from "./types";
import { METHODS } from "./types";
import { splitURL, stripSchemeBeforeVar, uid } from "./util";

export class CurlError extends Error {
  /** 出错位置在原始文本中的行号（从 1 开始）。 */
  line: number;
  /** 出错的片段，用于在提示里回显。 */
  snippet: string;
  constructor(message: string, line = 0, snippet = "") {
    super(message);
    this.name = "CurlError";
    this.line = line;
    this.snippet = snippet;
  }
}

export interface CurlParseResult {
  request: ApiRequest;
  /** 导入过程中被忽略或需要用户注意的点，中文描述。 */
  warnings: string[];
}

interface Token {
  value: string;
  /** 该 token 在原文本中的 0 基偏移，用于出错定位。 */
  offset: number;
}

/**
 * 把命令文本切成 shell 风格的 token。
 * 支持：单引号（内部原样）、双引号（支持 \" \\ \$ \` 转义）、
 * $'...'（ANSI-C 转义）、反斜杠续行、Windows cmd 的 ^ 续行、反引号续行。
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let buf = "";
  let started = false;
  let offset = 0;
  let i = 0;
  const text = input.replace(/\r\n/g, "\n");

  const push = () => {
    if (started) {
      tokens.push({ value: buf, offset });
      buf = "";
      started = false;
    }
  };

  while (i < text.length) {
    const ch = text[i]!;

    // 续行：行尾的反斜杠、^ 或反引号都视为「命令未结束」。
    if (ch === "\\" || ch === "^" || ch === "`") {
      const rest = text.slice(i + 1);
      const m = /^[ \t]*\n/.exec(rest);
      if (m) {
        i += 1 + m[0].length;
        continue;
      }
    }

    if (ch === "\n" || ch === " " || ch === "\t") {
      push();
      i += 1;
      continue;
    }

    if (ch === "#" && !started) {
      // 整行注释
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }

    if (!started) {
      started = true;
      offset = i;
    }

    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new CurlError("单引号没有闭合", lineAt(text, i), "'");
      buf += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (ch === "$" && text[i + 1] === "'") {
      const end = text.indexOf("'", i + 2);
      if (end < 0) throw new CurlError("$'…' 没有闭合", lineAt(text, i), "$'");
      buf += decodeAnsiC(text.slice(i + 2, end));
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        const c = text[j]!;
        if (c === "\\") {
          const n = text[j + 1];
          if (n === '"' || n === "\\" || n === "$" || n === "`") {
            buf += n;
            j += 2;
            continue;
          }
          buf += c;
          j += 1;
          continue;
        }
        if (c === '"') break;
        buf += c;
        j += 1;
      }
      if (j >= text.length) throw new CurlError("双引号没有闭合", lineAt(text, i), '"');
      i = j + 1;
      continue;
    }

    if (ch === "\\") {
      const n = text[i + 1];
      if (n === undefined) {
        buf += "\\";
        i += 1;
        continue;
      }
      buf += n;
      i += 2;
      continue;
    }

    buf += ch;
    i += 1;
  }
  push();
  return tokens;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function decodeAnsiC(raw: string): string {
  return raw.replace(
    /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|[nrtvbaf0\\'"])/g,
    (_all, seq: string) => {
      if (seq.startsWith("x")) return String.fromCharCode(parseInt(seq.slice(1), 16));
      if (seq.startsWith("u")) return String.fromCharCode(parseInt(seq.slice(1), 16));
      switch (seq) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "v":
          return "\v";
        case "b":
          return "\b";
        case "f":
          return "\f";
        case "a":
          return "\x07";
        case "0":
          return "\0";
        default:
          return seq;
      }
    },
  );
}

function kv(key: string, value: string): KV {
  return { id: uid("kv"), key, value, enabled: true };
}

/** 新建一份空白请求。 */
export function emptyRequest(url = ""): ApiRequest {
  const { base, params } = splitURL(url);
  return {
    protocol: "http",
    method: "GET",
    url: base,
    params: params.map((p) => kv(p.key, p.value)),
    headers: [],
    bodyMode: "none",
    body: "",
    form: [],
    auth: { type: "none", token: "", username: "", password: "", key: "", value: "", in: "header" },
    options: { timeoutMs: 30_000, redirect: "follow", keepCookies: true },
    script: { pre: "", post: "", trusted: true },
  };
}

/** 老数据里没有 script 字段，统一在这里兜底；用户自己写的脚本默认是受信任的。 */
export function scriptOf(request: ApiRequest): RequestScript {
  const s = request.script;
  if (!s) return { pre: "", post: "", trusted: true };
  return { pre: s.pre ?? "", post: s.post ?? "", trusted: s.trusted !== false };
}

/** 深拷贝请求（结构化克隆即可，请求里没有函数）。 */
export function cloneRequest(r: ApiRequest): ApiRequest {
  return JSON.parse(JSON.stringify(r)) as ApiRequest;
}

const METHOD_SET = new Set(METHODS as string[]);

interface RawParse {
  url?: string;
  method?: string;
  headers: [string, string][];
  dataParts: string[];
  urlencodeParts: string[];
  formParts: string[];
  user?: string;
  cookie?: string;
  userAgent?: string;
  referer?: string;
  timeoutSec?: number;
  follow?: boolean;
  head?: boolean;
  getMode?: boolean;
  jsonBody?: string;
  warnings: string[];
  ignored: Set<string>;
}

/** 解析一条 cURL 命令。任何无法映射到请求模型的部分都进 warnings。 */
export function parseCurl(input: string): CurlParseResult {
  const trimmed = input.trim();
  if (!trimmed) throw new CurlError("内容为空，请粘贴一条 curl 命令");

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) throw new CurlError("内容为空，请粘贴一条 curl 命令");

  // 允许粘贴带 shell 提示符的行。
  const first = tokens[0]!;
  const head = stripPrompt(first.value);
  if (head !== "curl" && head !== "curl.exe") {
    throw new CurlError(
      "没有找到 curl 命令：请确认粘贴的内容以 curl 开头",
      lineAt(trimmed, first.offset),
      first.value.slice(0, 40),
    );
  }

  const raw = parseArgs(tokens.slice(1), trimmed);
  if (!raw.url) {
    throw new CurlError("命令里没有 URL：请补上地址或使用 --url 指定");
  }

  const warnings = raw.warnings;
  const request = emptyRequest("");
  const { base, params } = splitURL(raw.url);
  request.url = base;
  request.params = params.map((p) => kv(p.key, p.value));

  // 方法推断：显式 -X 优先，其次是 -I（HEAD），再按有无请求体判断。
  const hasBody = raw.dataParts.length > 0 || raw.formParts.length > 0 || raw.jsonBody !== undefined;
  let method = raw.method?.toUpperCase();
  if (raw.head) method = "HEAD";
  if (!method) method = hasBody ? "POST" : "GET";
  if (!METHOD_SET.has(method)) {
    warnings.push(`无法识别的方法 ${method}，已按 POST 处理`);
    method = "POST";
  }
  request.method = method as HttpMethod;

  // 请求头
  for (const [k, v] of raw.headers) {
    if (k.toLowerCase() === "content-length") continue;
    request.headers.push(kv(k, v));
  }
  if (raw.userAgent) request.headers.push(kv("User-Agent", raw.userAgent));
  if (raw.referer) request.headers.push(kv("Referer", raw.referer));
  if (raw.cookie) request.headers.push(kv("Cookie", raw.cookie));

  // 认证
  if (raw.user !== undefined) {
    const idx = raw.user.indexOf(":");
    request.auth = {
      type: "basic",
      token: "",
      username: idx < 0 ? raw.user : raw.user.slice(0, idx),
      password: idx < 0 ? "" : raw.user.slice(idx + 1),
      key: "",
      value: "",
      in: "header",
    };
  } else {
    const bearer = request.headers.find(
      (h) => h.key.toLowerCase() === "authorization" && /^bearer\s+/i.test(h.value),
    );
    if (bearer) {
      request.auth = {
        type: "bearer",
        token: bearer.value.replace(/^bearer\s+/i, ""),
        username: "",
        password: "",
        key: "",
        value: "",
        in: "header",
      };
      request.headers = request.headers.filter((h) => h !== bearer);
    }
  }

  // 请求体
  if (raw.formParts.length > 0) {
    request.bodyMode = "form";
    request.form = raw.formParts.map(parseFormPart);
    const fileFields = request.form.filter((f) => f.kind === "file");
    if (fileFields.length > 0) {
      warnings.push(
        `表单里有 ${fileFields.length} 个文件字段（如 ${fileFields[0]!.key}），请手动点「选择文件」补上文件内容`,
      );
    }
  } else if (raw.jsonBody !== undefined) {
    request.bodyMode = "json";
    request.body = raw.jsonBody;
    if (!request.headers.some((h) => h.key.toLowerCase() === "content-type")) {
      request.headers.push(kv("Content-Type", "application/json"));
    }
  } else if (raw.dataParts.length > 0 || raw.urlencodeParts.length > 0) {
    const merged = [...raw.dataParts, ...raw.urlencodeParts].join("&");
    request.bodyMode = looksLikeJSON(merged) ? "json" : "text";
    request.body = merged;
    if (!request.headers.some((h) => h.key.toLowerCase() === "content-type")) {
      request.headers.push(
        kv(
          "Content-Type",
          request.bodyMode === "json" ? "application/json" : "application/x-www-form-urlencoded",
        ),
      );
    }
  }

  // -G/--get：把请求体内容挪到查询参数上
  if (raw.getMode) {
    if (request.body) {
      const { params: extra } = splitURL(`?${request.body}`);
      for (const p of extra) request.params.push(kv(p.key, p.value));
      request.body = "";
      request.bodyMode = "none";
      if (method === "POST" && !raw.method) request.method = "GET";
    }
  }

  // 选项
  const options: RequestOptions = {
    timeoutMs: raw.timeoutSec !== undefined ? Math.max(0, Math.round(raw.timeoutSec * 1000)) : 30_000,
    redirect: raw.follow === false ? "manual" : "follow",
    keepCookies: true,
  };
  request.options = options;

  return { request, warnings };
}

function stripPrompt(value: string): string {
  // 去掉 `$ curl`、`> curl`、`PS C:\> curl` 之类的提示符前缀。
  const m = /(?:^|\s)(curl(?:\.exe)?)$/.exec(value.trim());
  if (m) return m[1]!;
  return value.trim();
}

function looksLikeJSON(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function parseFormPart(part: string): FormField {
  const eq = part.indexOf("=");
  const key = eq < 0 ? part : part.slice(0, eq);
  let value = eq < 0 ? "" : part.slice(eq + 1);
  // 去掉 ;type=... 、;filename=... 这类修饰
  value = value.replace(/;(type|filename|headers)=("[^"]*"|[^;]*)/gi, "").trim();
  if (value.startsWith("@") || value.startsWith("<")) {
    const path = value.slice(1).trim();
    const name = path.split(/[\\/]/).pop() ?? path;
    return {
      id: uid("ff"),
      key,
      value: "",
      enabled: true,
      kind: "file",
      fileName: name,
    };
  }
  return { id: uid("ff"), key, value, enabled: true, kind: "text" };
}

const BOOL_LONG = new Set([
  "--compressed",
  "--insecure",
  "--location",
  "--head",
  "--get",
  "--silent",
  "--show-error",
  "--verbose",
  "--globoff",
  "--fail",
  "--include",
  "--no-buffer",
  "--basic",
  "--no-progress-meter",
  "--http1.1",
  "--http2",
  "--http2-prior-knowledge",
  "--tlsv1.2",
  "--tlsv1.3",
  "--ipv4",
  "--ipv6",
]);

function parseArgs(tokens: Token[], text: string): RawParse {
  const out: RawParse = {
    headers: [],
    dataParts: [],
    urlencodeParts: [],
    formParts: [],
    warnings: [],
    ignored: new Set(),
  };

  const takeValue = (i: number, flag: string): string => {
    const next = tokens[i + 1];
    if (!next) {
      throw new CurlError(`参数 ${flag} 后面缺少内容`, lineAt(text, tokens[i]!.offset), flag);
    }
    return next.value;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    let arg = tok.value;

    // --flag=value 形式
    let inlineValue: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    } else if (/^-[A-Za-z]{1,5}.+/.test(arg) && !arg.startsWith("--")) {
      // 短参数紧跟值，例如 -XPOST、-H"a: b" 已被 tokenize 拆开；
      // 这里处理 -d{...} 这种没有空格的写法（仅限已知需要值的短参数）。
      const shortWithValue = arg.slice(0, 2);
      if ("XHdFubAeTm".includes(shortWithValue[1] ?? "")) {
        inlineValue = arg.slice(2);
        arg = shortWithValue;
      }
    }

    const value = (flag: string): string =>
      inlineValue !== undefined ? inlineValue : takeValue(i, flag);

    const consume = (flag: string): string => {
      const v = value(flag);
      if (inlineValue === undefined) i += 1;
      return v;
    };

    switch (arg) {
      case "curl":
      case "curl.exe":
        // 粘贴了多条命令：忽略后续命令的开头，只解析第一条。
        out.warnings.push("检测到多条命令，只导入了第一条");
        return out;
      case "-X":
      case "--request":
        out.method = consume(arg);
        break;
      case "-H":
      case "--header": {
        const h = consume(arg);
        const idx = h.indexOf(":");
        if (idx < 0) {
          out.warnings.push(`请求头「${h}」格式不合法（缺少冒号），已跳过`);
        } else if (h.slice(0, idx).trim().toLowerCase() === "cookie") {
          // 合并到 cookie 里，避免 -b 与 -H 各存一份
          out.cookie = [out.cookie, h.slice(idx + 1).trim()].filter(Boolean).join("; ");
        } else {
          out.headers.push([h.slice(0, idx).trim(), h.slice(idx + 1).trim()]);
        }
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-ascii":
      case "--data-binary": {
        const d = consume(arg);
        if (d.startsWith("@")) {
          out.warnings.push(
            `参数 ${arg} 引用了本地文件 ${d.slice(1)}，无法自动读取，已留空，请手动粘贴文件内容`,
          );
        } else {
          out.dataParts.push(d);
        }
        break;
      }
      case "--data-urlencode": {
        const d = consume(arg);
        const eq = d.indexOf("=");
        out.urlencodeParts.push(
          eq < 0 ? encodeURIComponent(d) : `${d.slice(0, eq)}=${encodeURIComponent(d.slice(eq + 1))}`,
        );
        break;
      }
      case "--json":
        out.jsonBody = consume(arg);
        break;
      case "-F":
      case "--form":
        out.formParts.push(consume(arg));
        break;
      case "-u":
      case "--user":
        out.user = consume(arg);
        break;
      case "-b":
      case "--cookie": {
        const c = consume(arg);
        if (c.startsWith("@")) {
          out.warnings.push(`参数 -b 引用了 Cookie 文件 ${c.slice(1)}，无法读取，已跳过`);
        } else {
          out.cookie = [out.cookie, c].filter(Boolean).join("; ");
        }
        break;
      }
      case "-A":
      case "--user-agent":
        out.userAgent = consume(arg);
        break;
      case "-e":
      case "--referer":
        out.referer = consume(arg);
        break;
      case "--max-time": {
        const n = Number(consume(arg));
        if (Number.isFinite(n) && n > 0) out.timeoutSec = n;
        break;
      }
      case "--connect-timeout":
        consume(arg);
        out.warnings.push("连接超时已并入整体超时，未单独设置");
        break;
      case "--url":
        out.url = consume(arg);
        break;
      case "-L":
      case "--location":
        out.follow = true;
        break;
      case "-I":
      case "--head":
        out.head = true;
        break;
      case "-G":
      case "--get":
        out.getMode = true;
        break;
      case "-o":
      case "--output":
        consume(arg);
        out.warnings.push("输出文件参数已忽略（在响应区用「保存」按钮保存）");
        break;
      case "-w":
      case "--write-out":
        consume(arg);
        out.warnings.push("输出格式参数已忽略");
        break;
      case "--proxy":
      case "-x":
        consume(arg);
        out.warnings.push("单条命令的代理设置首版不支持，将使用系统代理设置");
        break;
      case "-k":
      case "--insecure":
        out.warnings.push("跳过 TLS 证书校验首版不支持，仍会正常校验证书");
        break;
      case "-T":
      case "--upload-file":
        consume(arg);
        out.warnings.push("文件上传（-T）首版不支持，请改用表单文件字段");
        break;
      case "-c":
      case "--cookie-jar":
        consume(arg);
        break;
      case "-s":
      case "--silent":
      case "--show-error":
      case "-i":
      case "--include":
      case "-v":
      case "--verbose":
      case "--compressed":
      case "-g":
      case "--globoff":
      case "-f":
      case "--fail":
      case "--no-buffer":
      case "-N":
      case "--basic":
      case "--http1.1":
      case "--http2":
        // 对结果没有影响，静默忽略
        break;
      default: {
        if (out.url === undefined && !arg.startsWith("-")) {
          out.url = arg;
          break;
        }
        if (BOOL_LONG.has(arg)) break;
        if (arg.startsWith("-")) {
          out.ignored.add(arg);
          // 未知参数若看起来需要一个值，避免把后面的 URL 吃掉：
          // 只有在还没有 URL 且下一个 token 不像参数时才吞掉。
        } else {
          out.warnings.push(`无法识别的内容「${arg}」，已忽略`);
        }
        break;
      }
    }
  }

  if (out.ignored.size > 0) {
    out.warnings.push(`以下参数首版不支持，已忽略：${[...out.ignored].join(" ")}`);
  }
  return out;
}

// ---- 生成 cURL ----

function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) && !value.includes("{{")) return value;
  if (!value.includes("'") && !value.includes("\n")) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

/** 把查询参数拼回完整 URL。 */
export function buildURL(request: ApiRequest, resolve: (t: string) => string): string {
  // 变量外面写的协议先摘掉，协议交给变量值（发送与预览都走这里）。
  const base = resolve(stripSchemeBeforeVar(request.url)).trim();
  const pairs = request.params
    .filter((p) => p.enabled && p.key.trim() !== "")
    .map((p) => `${encodeURIComponent(resolve(p.key))}=${encodeURIComponent(resolve(p.value))}`);
  if (pairs.length === 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${pairs.join("&")}`;
}

interface CurlExportOptions {
  /** 变量是否已替换成实际值；未替换时保留 {{var}} 便于分享。 */
  resolve: (text: string) => string;
}

/** 根据请求生成 cURL 命令文本，按 curl 常见风格用反斜杠换行。 */
function appendQuery(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    // 地址还没补协议（相对地址）时 new URL 会抛错，退回手拼。
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

export function toCurl(request: ApiRequest, opts: CurlExportOptions): string {
  let url = buildURL(request, opts.resolve);
  const lines: string[] = [];
  const method = request.method.toUpperCase();
  const auth = request.auth;
  // API Key 放在查询串时，导出的地址必须把它拼回去，否则对方拿到命令会 401。
  if (auth.type === "apikey" && auth.in === "query" && auth.key.trim()) {
    url = appendQuery(url, opts.resolve(auth.key), opts.resolve(auth.value));
  }

  if (method !== "GET") lines.push(`-X ${method}`);
  lines.push(`${shellQuote(url)}`);

  for (const h of request.headers) {
    if (!h.enabled || !h.key.trim()) continue;
    lines.push(`-H ${shellQuote(`${h.key}: ${opts.resolve(h.value)}`)}`);
  }

  if (auth.type === "bearer" && auth.token) {
    lines.push(`-H ${shellQuote(`Authorization: Bearer ${opts.resolve(auth.token)}`)}`);
  }
  if (auth.type === "basic") {
    lines.push(`-u ${shellQuote(`${opts.resolve(auth.username)}:${opts.resolve(auth.password)}`)}`);
  }
  if (auth.type === "apikey" && auth.key) {
    if (auth.in === "header") {
      lines.push(`-H ${shellQuote(`${auth.key}: ${opts.resolve(auth.value)}`)}`);
    }
  }

  if (request.bodyMode === "form") {
    for (const f of request.form) {
      if (!f.enabled || !f.key.trim()) continue;
      if (f.kind === "file") {
        lines.push(`-F ${shellQuote(`${f.key}=@${f.fileName ?? "文件路径"}`)}`);
      } else {
        lines.push(`-F ${shellQuote(`${f.key}=${opts.resolve(f.value)}`)}`);
      }
    }
  } else if (request.body && request.bodyMode !== "none") {
    lines.push(`--data-raw ${shellQuote(opts.resolve(request.body))}`);
  }

  if (request.options.timeoutMs > 0) {
    lines.push(`--max-time ${String(Math.round(request.options.timeoutMs / 1000))}`);
  }
  if (request.options.redirect === "manual") lines.push("--max-redirs 0");

  const joined = lines.join(" \\\n  ");
  return `curl ${joined}`;
}
