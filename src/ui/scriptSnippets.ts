// 脚本编辑区右侧的「代码片段」栏：点一行就往光标处插一段能直接用的代码。
//
// 片段按用途分组，前置脚本只给变量与请求，后置脚本才给响应相关的那几组——
// 前置执行时响应还不存在，把响应断言摆在那里只会让人写出必错的脚本。
import { el } from "./dom";
import type { CodeEditorElement } from "./codeEditor";
import type { ScriptPhase } from "../types";

interface Snippet {
  label: string;
  code: string;
}

const VARIABLE_SNIPPETS: Snippet[] = [
  { label: "获取环境变量", code: `const value = pm.environment.get("变量名");` },
  { label: "设置环境变量", code: `pm.environment.set("变量名", "值");` },
  { label: "获取临时变量", code: `const value = pm.variables.get("变量名");` },
  { label: "设置临时变量", code: `pm.variables.set("变量名", "值");` },
];

const REQUEST_SNIPPETS: Snippet[] = [
  {
    label: "请求接口",
    code: [
      "pm.sendRequest({",
      '  url: "https://example.com/api",',
      '  method: "POST",',
      '  header: { "Content-Type": "application/json" },',
      '  body: { mode: "raw", raw: JSON.stringify({}) },',
      "}, (err, res) => {",
      '  if (err) throw new Error("请求失败：" + err.message);',
      "  console.log(res.code, res.text());",
      "});",
    ].join("\n"),
  },
];

const RESPONSE_SNIPPETS: Snippet[] = [
  {
    label: "Response 状态码为 200",
    code: [
      'pm.test("状态码为 200", () => {',
      "  if (pm.response.code !== 200) throw new Error(\"状态码是 \" + pm.response.code);",
      "});",
    ].join("\n"),
  },
  {
    label: "Response Body 包含指定字符串",
    code: [
      'pm.test("响应体包含期望内容", () => {',
      '  if (!pm.response.text().includes("要查的内容")) throw new Error("响应体里没有这段文字");',
      "});",
    ].join("\n"),
  },
  {
    label: "Response Body JSON 值检查",
    code: [
      'pm.test("JSON 字段符合预期", () => {',
      "  const body = pm.response.json();",
      '  if (body.code !== 0) throw new Error("code 是 " + body.code);',
      "});",
    ].join("\n"),
  },
  {
    label: "修改 Response Body",
    code: [
      "// 改写后的响应体会替代原始响应显示在响应区",
      'pm.response.setBody(pm.response.text() + "\\n<!-- 已检查 -->");',
    ].join("\n"),
  },
  {
    label: "Header 包含 Content-Type",
    code: [
      'pm.test("Content-Type 是 JSON", () => {',
      '  const type = pm.response.headers.get("Content-Type") ?? "";',
      '  if (!type.includes("application/json")) throw new Error("Content-Type 是 " + type);',
      "});",
    ].join("\n"),
  },
  {
    label: "Response 耗时小于 200 毫秒",
    code: [
      'pm.test("耗时在 200ms 内", () => {',
      "  if (pm.response.responseTime > 200) throw new Error(\"耗时 \" + pm.response.responseTime + \"ms\");",
      "});",
    ].join("\n"),
  },
  {
    label: "重发请求（换掉登录态后重试）",
    code: [
      "// 最多自动重发 3 次，别在这里写死循环",
      "pm.environment.set(\"token\", pm.response.json().token);",
      "pm.execution.resend();",
    ].join("\n"),
  },
];

interface SnippetGroup {
  title: string;
  items: Snippet[];
}

/** 某一阶段可用的片段分组，前置/后置各一套。 */
function groupsOf(phase: ScriptPhase): SnippetGroup[] {
  const groups: SnippetGroup[] = [
    { title: "变量", items: VARIABLE_SNIPPETS },
    { title: "请求", items: REQUEST_SNIPPETS },
  ];
  if (phase === "post") groups.push({ title: "响应与断言", items: RESPONSE_SNIPPETS });
  return groups;
}

/**
 * 把片段插到光标处（有选区就替换选区），插完把焦点还回输入框。
 * 插入动作在编辑器内部完成，它自己会派发 input，上层的安静落库与 dirty 标记因此能跟上。
 */
export function insertSnippet(area: CodeEditorElement, code: string): void {
  area.insertSnippet(code);
}

/** 片段栏：一列分组标题 + 可点的片段行。 */
export function snippetRail(phase: ScriptPhase, area: () => CodeEditorElement | undefined): HTMLElement {
  return el(
    "div",
    { class: "script-rail", attr: { "aria-label": "代码片段" } },
    el("div", { class: "script-rail-title", text: "代码片段" }),
    ...groupsOf(phase).map((group) =>
      el(
        "div",
        { class: "script-rail-group" },
        el("div", { class: "script-rail-head", text: group.title }),
        ...group.items.map((item) =>
          el("button", {
            class: "script-rail-item",
            attr: { type: "button", title: item.code },
            text: item.label,
            on: {
              click: () => {
                const target = area();
                if (target) insertSnippet(target, item.code);
              },
            },
          }),
        ),
      ),
    ),
  );
}
