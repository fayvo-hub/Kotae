// 请求体在「纯文本」与「表单编码」之间搬运内容。
//
// 两处需要它：curl 里 `-d 'a=1&b=2'` 本来就是表单编码，导入后只落成一段原文，
// 用户还得手抄进键值表；以及界面上从纯文本切到表单编码时，粘贴进来的
// `name=张三&age=12` 应当自己拆成字段，而不是给一张空表。
//
// 判定故意保守：只认「每段都是 key=value、没有换行、不以 { [ < 开头」的文本，
// 拆不出来就保持原样——宁可少转，也不要把一段自由文本悄悄剁成字段。

import type { ApiRequest, BodyMode, FormField } from "./types";
import { uid } from "./util";

/** 把 `%E4%B8%AD` / `+` 还原成字符；不是合法编码就原样留着。 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * 把 `a=1&b=2` 这样的表单编码文本拆成字段；不像表单编码时返回 null。
 *
 * 值里的 `=` 不算分隔符（只按每段第一个 `=` 切），`%XX` 与 `+` 会解码——
 * 与发送时的编码互为逆运算，所以 curl 里 `-d 'a=%41'` 导入后仍是 `a=A`。
 */
export function parseFormEncoded(text: string): FormField[] | null {
  const raw = text.trim();
  if (!raw) return null;
  // 多行基本是自由文本（JSON 片段、日志、SQL）；`{ [ <` 开头是 JSON/XML/HTML。
  if (/[\r\n]/.test(raw)) return null;
  if (/^[\[{<]/.test(raw)) return null;

  const fields: FormField[] = [];
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    // 有一段没有 `=` 就整体判负：`a=1&note` 这种更像自由文本而不是缺值的字段。
    if (eq < 0) return null;
    const key = safeDecode(pair.slice(0, eq)).trim();
    if (!key) return null;
    fields.push({
      id: uid("ff"),
      key,
      value: safeDecode(pair.slice(eq + 1)),
      enabled: true,
      kind: "text",
    });
  }
  return fields.length > 0 ? fields : null;
}

/** 键或值里出现这些字符会破坏 `&`/`=` 结构或换行，只能编码。 */
function escape(s: string): string {
  return /[&=\r\n]/.test(s) ? encodeURIComponent(s) : s;
}

/**
 * 把字段拼回可读的 `a=1&b=2` 文本（给纯文本编辑框显示，不做整体编码）。
 *
 * 只有会破坏结构的字符才百分号编码，中文/空格原样保留——切过去是为了「能读」，
 * 全编码反而又变成一串看不懂的 `%E4%B8%AD`。
 */
export function stringifyFormEncoded(fields: FormField[]): string {
  return fields
    .filter((f) => f.enabled && f.kind === "text" && f.key.trim() !== "")
    .map((f) => `${escape(f.key.trim())}=${escape(f.value)}`)
    .join("&");
}

/**
 * 切换请求体类型，顺带把内容搬到对应的编辑方式上。
 *
 * 「纯文本 / JSON」共用 `body`，「表单编码 / 表单」共用 `form`，同一组里切来切去
 * 不需要搬运；只有跨组时才解析或拼回。（从表单切走时文件字段也还留在 `form` 里，
 * 切回来还在。）
 */
export function switchBodyMode(request: ApiRequest, next: BodyMode): void {
  const from = request.bodyMode;
  if (from === next) return;
  request.bodyMode = next;

  if ((next === "urlencoded" || next === "form") && (from === "text" || from === "json")) {
    const parsed = parseFormEncoded(request.body);
    if (parsed) request.form = parsed;
    // 文本拆不成字段就别留着旧字段冒充这次的正文：那会让用户在表格里看不见、
    // 发送时却真的把它们带出去。空文本（刚清空）才保留原有字段。
    else if (request.body.trim()) request.form = [];
    return;
  }
  if ((next === "text" || next === "json") && (from === "urlencoded" || from === "form")) {
    const text = stringifyFormEncoded(request.form);
    if (text) request.body = text;
  }
}
