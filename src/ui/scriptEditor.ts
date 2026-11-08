// 单条脚本的源码编辑器与 API 速查：脚本库浮层用它改脚本。
// 只负责渲染与事件转发，脚本存在哪、什么时候落库由调用方决定。

import { el } from "./dom";
import type { ScriptPhase } from "../script";

export interface ScriptSourceSpec {
  source: string;
  /** 这条脚本是前置还是后置：决定标题、提示与占位文案。 */
  phase: ScriptPhase;
  /** 文本域的无障碍名字，也是 e2e 定位编辑框的锚点。 */
  label: string;
  onInput: (value: string) => void;
}

const HINTS: Record<ScriptPhase, string> = {
  pre: "发送前执行：能改请求头、地址与请求体，适合算签名、时间戳，或者先登录拿 token 再写进环境变量。脚本是本地 JavaScript，单次最多 5 秒（等网络的时间不算）。",
  post: "拿到响应后执行：能改写响应体、写环境变量，还能用 pm.execution.resend() 让同一个请求再发一次。脚本是本地 JavaScript，单次最多 5 秒（等网络的时间不算）。",
};

const PLACEHOLDERS: Record<ScriptPhase, string> = {
  pre: "加签名头，例如：pm.request.headers.upsert('X-Sign', await pm.utils.hmacSha256(pm.environment.get('secret'), pm.request.url))",
  post: "解密响应体，例如：pm.response.setBody(pm.utils.base64Decode(pm.response.text()))",
};

const API_LINES = [
  "pm.variables / pm.environment / pm.globals：get、set，环境会写回当前环境",
  "pm.request.method、pm.request.url、pm.request.headers.{add,upsert,remove,get,has}",
  "pm.request.body.raw：文本或 JSON 请求体的当前内容，可读写",
  "pm.sendRequest({ url, method, header, body })：脚本里再发一个请求，地址与头里的 {{变量}} 会先替换，返回 { code, status, headers, text(), json() }",
  "pm.response.{code,status,headers,text,json,setBody}：仅后置脚本可用",
  "pm.execution.resend()：仅后置脚本，处理完这次响应后把同一个请求重发（一次发送最多重发 3 次）",
  "pm.utils.{hmac,hmacSha256,sha256,base64Encode,base64Decode,now,uuid,randomInt,queryString}",
  "console.log / warn / error：输出显示在响应区的「脚本」里",
];

/** 这个阶段的脚本能干什么（列表与编辑器上方共用一句话）。 */
export function scriptPhaseHint(phase: ScriptPhase): string {
  return HINTS[phase];
}

/** 一条脚本的源码编辑框：标题 + 等宽文本域。 */
export function scriptSourceField(spec: ScriptSourceSpec): HTMLElement {
  const box = el("section", { class: "script-block" });
  const head = el("div", { class: "script-block-head" });
  head.append(
    el("span", {
      class: "script-block-title",
      text: spec.phase === "pre" ? "前置脚本" : "后置脚本",
    }),
    el("span", {
      class: "script-block-hint",
      text: spec.phase === "pre" ? "发送前执行" : "拿到响应后执行",
    }),
  );
  const area = el("textarea", {
    class: "code-input script-input",
    attr: {
      spellcheck: "false",
      placeholder: PLACEHOLDERS[spec.phase],
      "aria-label": spec.label,
      "data-phase": spec.phase,
    },
    on: { input: () => spec.onInput(area.value) },
  });
  area.value = spec.source;
  box.append(head, area);
  return box;
}

/** 默认折叠：对话框高度有限，先把编辑器露出来，需要查 API 时再展开。 */
export function scriptApiDetails(): HTMLElement {
  const api = el("details", { class: "script-api" });
  api.append(
    el("summary", {
      class: "script-api-title",
      text: "可用对象（pm.sendRequest / pm.execution / pm.utils …）",
    }),
  );
  const list = el("ul", { class: "script-api-list" });
  for (const line of API_LINES) list.append(el("li", { text: line }));
  api.append(list);
  return api;
}
