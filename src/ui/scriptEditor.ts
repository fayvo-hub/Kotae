// 脚本编辑器：请求面板、集合/文件夹共享设置、设置面板的全局脚本共用这一套控件。
// 只负责渲染与事件转发，脚本存在哪、什么时候落库由调用方决定。

import { el } from "./dom";
import type { ScriptPhase } from "../script";
import type { RequestScript } from "../types";

export interface ScriptEditorSpec {
  script: RequestScript;
  /** 当前显示前置还是后置；切换由调用方持有状态后重绘。 */
  phase: ScriptPhase;
  onPhase: (phase: ScriptPhase) => void;
  onInput: (phase: ScriptPhase, value: string) => void;
}

const HINTS: Record<ScriptPhase, string> = {
  pre: "发送前执行：能改请求头、地址与请求体，适合算签名、时间戳，或者先登录拿 token 再写进环境变量。脚本是本地 JavaScript，单次最多 5 秒（等网络的时间不算）。",
  post:
    "拿到响应后执行：能改写响应体、写环境变量，还能用 pm.execution.resend() 让同一个请求重发一次。脚本是本地 JavaScript，单次最多 5 秒（等网络的时间不算）。",
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

/** 分段控件切换前置 / 后置。 */
function phaseSwitch(script: RequestScript, phase: ScriptPhase, onPhase: (p: ScriptPhase) => void): HTMLElement {
  const row = el("div", { class: "script-switch" });
  const modes = el("div", { class: "segmented", attr: { role: "radiogroup", "aria-label": "脚本阶段" } });
  for (const item of [
    { key: "pre" as const, label: "前置脚本", has: script.pre.trim() !== "" },
    { key: "post" as const, label: "后置脚本", has: script.post.trim() !== "" },
  ]) {
    const active = phase === item.key;
    const btn = el("button", {
      class: `segmented-item${active ? " active" : ""}`,
      attr: { type: "button", role: "radio", "aria-checked": active ? "true" : "false" },
      text: item.label,
      on: { click: () => onPhase(item.key) },
    });
    if (item.has && !active) btn.append(el("span", { class: "script-dot", attr: { "aria-hidden": "true" } }));
    modes.append(btn);
  }
  row.append(modes);
  return row;
}

/** 一块脚本编辑区：分段切换 + 提示 + 等宽文本域 + 折叠的 API 速查。 */
export function scriptEditor(spec: ScriptEditorSpec): HTMLElement {
  const host = el("div", { class: "stack" });
  const title = spec.phase === "pre" ? "前置脚本" : "后置脚本";
  const box = el("section", { class: "script-block" });
  const head = el("div", { class: "script-block-head" });
  head.append(
    el("span", { class: "script-block-title", text: title }),
    el("span", { class: "script-block-hint", text: spec.phase === "pre" ? "发送前执行" : "拿到响应后执行" }),
  );
  const area = el("textarea", {
    class: "code-input script-input",
    attr: {
      spellcheck: "false",
      placeholder: PLACEHOLDERS[spec.phase],
      "aria-label": title,
      "data-phase": spec.phase,
    },
    on: { input: () => spec.onInput(spec.phase, area.value) },
  });
  area.value = spec.phase === "pre" ? spec.script.pre : spec.script.post;
  box.append(head, area);

  host.append(
    phaseSwitch(spec.script, spec.phase, spec.onPhase),
    el("p", { class: "pane-hint", text: HINTS[spec.phase] }),
    box,
    apiDetails(),
  );
  return host;
}

/** 默认折叠：面板高度有限，先把编辑器露出来，需要查 API 时再展开。 */
function apiDetails(): HTMLElement {
  const api = el("details", { class: "script-api" });
  api.append(el("summary", { class: "script-api-title", text: "可用对象（pm.sendRequest / pm.execution / pm.utils …）" }));
  const list = el("ul", { class: "script-api-list" });
  for (const line of API_LINES) list.append(el("li", { text: line }));
  api.append(list);
  return api;
}
