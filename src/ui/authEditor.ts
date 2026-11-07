// 认证编辑器：请求自己的认证、集合 / 文件夹的共享认证共用同一份实现。

import { el, icon } from "./dom";
import type { AuthConfig, AuthType } from "../types";

export const AUTH_TYPES: { value: AuthType; label: string }[] = [
  { value: "none", label: "无认证" },
  { value: "bearer", label: "Bearer Token" },
  { value: "basic", label: "Basic 用户名密码" },
  { value: "apikey", label: "API Key" },
];

/** 认证方式的中文短名，用于「继承自 XX 的 Bearer Token」这类提示。 */
export function authLabel(type: AuthType): string {
  return AUTH_TYPES.find((t) => t.value === type)?.label ?? "无认证";
}

export interface AuthEditorHooks {
  /** 改字段值：不重建界面，输入框不失焦。 */
  update: (recipe: (auth: AuthConfig) => void) => void;
  /** 切认证方式、切 API Key 位置这类要重画界面的操作。 */
  rebuild: () => void;
  /** 无认证时的空态文案。 */
  emptyText?: string;
}

export function authEditor(auth: AuthConfig, hooks: AuthEditorHooks): HTMLElement {
  const host = el("div", { class: "auth-editor" });

  const toolbar = el("div", { class: "pane-toolbar" });
  const seg = el("div", { class: "segmented", attr: { role: "radiogroup", "aria-label": "认证方式" } });
  for (const t of AUTH_TYPES) {
    const active = auth.type === t.value;
    seg.append(
      el("button", {
        class: `segmented-item${active ? " active" : ""}`,
        attr: { type: "button", role: "radio", "aria-checked": active ? "true" : "false" },
        text: t.label,
        on: {
          click: () => {
            hooks.update((a) => {
              a.type = t.value;
            });
            hooks.rebuild();
          },
        },
      }),
    );
  }
  toolbar.append(seg);
  host.append(toolbar);

  const form = el("div", { class: "form-grid" });
  const field = (
    label: string,
    value: string,
    placeholder: string,
    onInput: (v: string) => void,
    type = "text",
  ): HTMLElement => {
    const input = el("input", {
      class: "text-input",
      attr: { placeholder, type, spellcheck: "false", autocomplete: "off" },
      on: {
        input: () => onInput(input.value),
      },
    });
    input.value = value;
    return el("label", { class: "field" }, el("span", { class: "field-label", text: label }), input);
  };

  if (auth.type === "none") {
    host.append(
      el(
        "div",
        { class: "pane-empty" },
        icon("info"),
        el("span", { text: hooks.emptyText ?? "不额外添加认证信息" }),
      ),
    );
    return host;
  }

  if (auth.type === "bearer") {
    // 只有 Token 一个字段时让它独占整行，避免左半边输入框看着像没填完。
    form.classList.add("form-single");
    form.append(
      field("Token", auth.token, "粘贴 token，支持 {{token}}", (v) =>
        hooks.update((a) => (a.token = v)),
      ),
      el("p", { class: "field-hint", text: "发送时会加上 Authorization: Bearer <token> 请求头。" }),
    );
  }
  if (auth.type === "basic") {
    form.append(
      field("用户名", auth.username, "username", (v) => hooks.update((a) => (a.username = v))),
      field(
        "密码",
        auth.password,
        "password",
        (v) => hooks.update((a) => (a.password = v)),
        "password",
      ),
      el("p", { class: "field-hint", text: "发送时会加上 Authorization: Basic base64(用户名:密码)。" }),
    );
  }
  if (auth.type === "apikey") {
    form.append(
      field("名称", auth.key, "例如 X-Api-Key", (v) => hooks.update((a) => (a.key = v))),
      field("值", auth.value, "支持 {{变量}}", (v) => hooks.update((a) => (a.value = v))),
    );
    const seg2 = el("div", { class: "segmented small" });
    for (const where of [
      { value: "header" as const, label: "放在请求头" },
      { value: "query" as const, label: "放在查询参数" },
    ]) {
      seg2.append(
        el("button", {
          class: `segmented-item${auth.in === where.value ? " active" : ""}`,
          attr: { type: "button" },
          text: where.label,
          on: {
            click: () => {
              hooks.update((a) => {
                a.in = where.value;
              });
              hooks.rebuild();
            },
          },
        }),
      );
    }
    form.append(seg2);
  }
  host.append(form);
  return host;
}
