// 代码片段：把当前请求转成可以直接粘进项目的写法，省掉手抄 URL 与请求头。
// 生成的代码如实反映「发送时会发的请求」：变量已替换、认证头已展开、查询串已拼好。

import { buildURL, toCurl } from "./curl";
import type { ApiRequest } from "./types";

export type SnippetLang = "fetch" | "axios" | "python" | "curl";

export const SNIPPET_LANGS: { key: SnippetLang; label: string; hint: string }[] = [
  { key: "fetch", label: "fetch", hint: "浏览器与 Node 18+ 通用" },
  { key: "axios", label: "axios", hint: "前端项目常用" },
  { key: "python", label: "requests", hint: "Python 脚本" },
  { key: "curl", label: "cURL", hint: "终端与文档" },
];

export interface SnippetOptions {
  resolve: (text: string) => string;
}

/** 一条完整的请求要素，四种语言共用。 */
interface Parts {
  url: string;
  method: string;
  headers: [string, string][];
  bodyMode: ApiRequest["bodyMode"];
  body: string;
  form: { key: string; value: string; isFile: boolean; fileName: string }[];
}

/** JS 与 Python 都能用 JSON 字符串字面量表示，统一走这个（含中文与引号转义）。 */
function lit(text: string): string {
  return JSON.stringify(text);
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 收集实际会发出去的请求：手写头 + 认证产生的头 + 查询串里的 API Key。 */
function collect(request: ApiRequest, opts: SnippetOptions): Parts {
  let url = buildURL(request, opts.resolve);
  const headers: [string, string][] = [];
  for (const h of request.headers) {
    if (!h.enabled || !h.key.trim()) continue;
    headers.push([h.key.trim(), opts.resolve(h.value)]);
  }

  const auth = request.auth;
  if (auth.type === "bearer" && auth.token) {
    headers.push(["Authorization", `Bearer ${opts.resolve(auth.token)}`]);
  }
  if (auth.type === "basic") {
    const pair = `${opts.resolve(auth.username)}:${opts.resolve(auth.password)}`;
    headers.push(["Authorization", `Basic ${base64(pair)}`]);
  }
  if (auth.type === "apikey" && auth.key.trim()) {
    if (auth.in === "header") headers.push([auth.key.trim(), opts.resolve(auth.value)]);
    else url = appendQuery(url, auth.key.trim(), opts.resolve(auth.value));
  }

  const form = request.form
    .filter((f) => f.enabled && f.key.trim())
    .map((f) => ({
      key: f.key.trim(),
      value: opts.resolve(f.value),
      isFile: f.kind === "file",
      fileName: f.fileName ?? "文件路径",
    }));

  return {
    url,
    method: request.method.toUpperCase(),
    headers,
    bodyMode: request.bodyMode,
    body: opts.resolve(request.body),
    form,
  };
}

function appendQuery(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

/** 请求体的形态决定用 JSON 字面量还是字符串字面量。 */
function isJSONBody(p: Parts): boolean {
  if (p.bodyMode !== "json" || !p.body.trim()) return false;
  try {
    JSON.parse(p.body);
    return true;
  } catch {
    return false;
  }
}

function hasFormData(p: Parts): boolean {
  return p.bodyMode === "form" || p.bodyMode === "urlencoded";
}

function fetchSnippet(p: Parts): string {
  const lines: string[] = [];
  const init: string[] = [`  method: ${lit(p.method)},`];

  if (p.headers.length > 0) {
    init.push("  headers: {");
    for (const [k, v] of p.headers) init.push(`    ${lit(k)}: ${lit(v)},`);
    init.push("  },");
  }

  if (hasFormData(p)) {
    const ctor = p.bodyMode === "form" ? "FormData" : "URLSearchParams";
    lines.push(`const body = new ${ctor}();`);
    for (const f of p.form) {
      if (f.isFile) {
        lines.push(`// 文件字段：换成页面里拿到的 File / Blob，例如 input.files[0]`);
        lines.push(`body.append(${lit(f.key)}, file /* ${f.fileName} */);`);
      } else {
        lines.push(`body.append(${lit(f.key)}, ${lit(f.value)});`);
      }
    }
    lines.push("");
    init.push("  body,");
  } else if (p.body.trim() && p.bodyMode !== "none") {
    const value = isJSONBody(p) ? `JSON.stringify(${p.body.trim()})` : lit(p.body);
    init.push(`  body: ${value},`);
  }

  lines.push(`const res = await fetch(${lit(p.url)}, {`);
  lines.push(...init);
  lines.push("});");
  lines.push("if (!res.ok) throw new Error(`HTTP ${res.status}`);");
  lines.push("const data = await res.json();");
  return lines.join("\n");
}

function axiosSnippet(p: Parts): string {
  const lines: string[] = ["const res = await axios.request({"];
  lines.push(`  method: ${lit(p.method.toLowerCase())},`);
  lines.push(`  url: ${lit(p.url)},`);

  if (p.headers.length > 0) {
    lines.push("  headers: {");
    for (const [k, v] of p.headers) lines.push(`    ${lit(k)}: ${lit(v)},`);
    lines.push("  },");
  }

  if (hasFormData(p)) {
    const ctor = p.bodyMode === "form" ? "FormData" : "URLSearchParams";
    lines.push("  data: (() => {");
    lines.push(`    const body = new ${ctor}();`);
    for (const f of p.form) {
      if (f.isFile) {
        lines.push(`    // 文件字段：换成你自己的 File / Blob（${f.fileName}）`);
        lines.push(`    body.append(${lit(f.key)}, file);`);
      } else {
        lines.push(`    body.append(${lit(f.key)}, ${lit(f.value)});`);
      }
    }
    lines.push("    return body;");
    lines.push("  })(),");
  } else if (p.body.trim() && p.bodyMode !== "none") {
    const value = isJSONBody(p) ? p.body.trim() : lit(p.body);
    lines.push(`  data: ${value},`);
  }

  lines.push("});");
  lines.push("console.log(res.status, res.data);");
  return lines.join("\n");
}

function pythonSnippet(p: Parts): string {
  const verb = p.method.toLowerCase();
  const lines: string[] = ["import requests", ""];
  if (p.headers.length > 0) {
    lines.push("headers = {");
    for (const [k, v] of p.headers) lines.push(`    ${lit(k)}: ${lit(v)},`);
    lines.push("}");
    lines.push("");
  }
  const args: string[] = [lit(p.url)];
  if (p.headers.length > 0) args.push("headers=headers");

  if (hasFormData(p)) {
    const data = p.form.filter((f) => !f.isFile);
    const files = p.form.filter((f) => f.isFile);
    if (data.length > 0) {
      lines.push("data = {");
      for (const f of data) lines.push(`    ${lit(f.key)}: ${lit(f.value)},`);
      lines.push("}");
      lines.push("");
      args.push("data=data");
    }
    if (files.length > 0) {
      lines.push("files = {");
      for (const f of files) lines.push(`    ${lit(f.key)}: open(${lit(f.fileName)}, "rb"),`);
      lines.push("}");
      lines.push("");
      args.push("files=files");
    }
  } else if (p.body.trim() && p.bodyMode !== "none") {
    if (isJSONBody(p)) {
      lines.push(`payload = ${p.body.trim()}`);
      lines.push("");
      args.push("json=payload");
    } else {
      args.push(`data=${lit(p.body)}`);
    }
  }

  lines.push(`response = requests.${verb}(${args.join(", ")})`);
  lines.push("print(response.status_code, response.text)");
  return lines.join("\n");
}

/** 生成指定语言的代码片段。 */
export function snippetText(request: ApiRequest, lang: SnippetLang, opts: SnippetOptions): string {
  if (lang === "curl") return toCurl(request, opts);
  const parts = collect(request, opts);
  if (lang === "fetch") return fetchSnippet(parts);
  if (lang === "axios") return axiosSnippet(parts);
  return pythonSnippet(parts);
}
