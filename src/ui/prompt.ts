// 应用内输入与确认对话框。
// webview 里 window.prompt / confirm 未必可用（某些平台不弹出），所以自己实现一套。

import { el, icon } from "./dom";

interface TextOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmText?: string;
  /** 多行输入：Enter 换行，Ctrl/Cmd+Enter 提交。 */
  multiline?: boolean;
  rows?: number;
  hint?: string;
}

interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface AlertOptions {
  title: string;
  message: string;
  confirmText?: string;
  tone?: "info" | "error";
}

function shell(head: HTMLElement, body: HTMLElement, foot: HTMLElement): HTMLElement {
  const dialog = el("div", { class: "dialog prompt-dialog", attr: { role: "dialog" } });
  const headBox = el("div", { class: "dialog-head" });
  headBox.append(head);
  dialog.append(headBox, body, foot);
  return dialog;
}

// 点遮罩不关闭：这类对话框里常有刚粘贴进来的一批内容，误点外部就丢数据。
// 关闭只有两条路——Esc 或底部按钮。
function backdropOf(dialog: HTMLElement): HTMLElement {
  const backdrop = el("div", { class: "backdrop prompt-backdrop" });
  backdrop.append(dialog);
  return backdrop;
}

/** 单行文本输入，返回 null 表示取消。 */
export function askText(options: TextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };

    const title = el("h2", { text: options.title });
    const multiline = options.multiline === true;
    const input = multiline
      ? el("textarea", {
          class: "text-input prompt-textarea",
          attr: {
            placeholder: options.placeholder ?? "",
            spellcheck: "false",
            rows: String(options.rows ?? 6),
            "aria-label": options.label ?? options.title,
          },
          on: {
            keydown: (ev) => {
              if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                finish((input as HTMLTextAreaElement).value.trim() || null);
              }
            },
          },
        })
      : el("input", {
          class: "text-input",
          attr: {
            placeholder: options.placeholder ?? "",
            spellcheck: "false",
            autocomplete: "off",
            "aria-label": options.label ?? options.title,
          },
          on: {
            keydown: (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                finish((input as HTMLInputElement).value.trim() || null);
              }
            },
          },
        });
    input.value = options.value ?? "";

    const body = el("div", { class: "dialog-body" });
    const field = el("label", { class: "field" });
    if (options.label) field.append(el("span", { class: "field-label", text: options.label }));
    field.append(input);
    if (options.hint) field.append(el("span", { class: "field-hint", text: options.hint }));
    body.append(field);

    const foot = el("div", { class: "dialog-foot" });
    const cancel = el("button", {
      class: "btn",
      attr: { type: "button" },
      text: "取消",
      on: { click: () => finish(null) },
    });
    const ok = el("button", {
      class: "btn primary",
      attr: { type: "button" },
      text: options.confirmText ?? "确定",
      on: { click: () => finish(input.value.trim() || null) },
    });
    foot.append(el("span", { class: "spacer" }), cancel, ok);

    const dialog = shell(title, body, foot);
    if (multiline) dialog.classList.add("wide");
    const backdrop = backdropOf(dialog);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  });
}

/** 二选一确认，返回 true 表示确认。 */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };

    const title = el("h2", { text: options.title });
    const body = el("div", { class: "dialog-body" });
    const box = el("div", { class: "confirm-box" });
    box.append(icon(options.danger ? "warn" : "info", "confirm-icon"));
    const text = el("div");
    text.append(el("p", { class: "confirm-message", text: options.message }));
    if (options.detail) text.append(el("p", { class: "muted small", text: options.detail }));
    box.append(text);
    body.append(box);

    const foot = el("div", { class: "dialog-foot" });
    const cancel = el("button", {
      class: "btn",
      attr: { type: "button" },
      text: options.cancelText ?? "取消",
      on: { click: () => finish(false) },
    });
    const ok = el("button", {
      class: `btn ${options.danger ? "danger-solid" : "primary"}`,
      attr: { type: "button" },
      text: options.confirmText ?? "确定",
      on: { click: () => finish(true) },
    });
    foot.append(el("span", { class: "spacer" }), cancel, ok);

    const dialog = shell(title, body, foot);
    const backdrop = backdropOf(dialog);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        finish(false);
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    queueMicrotask(() => ok.focus());
  });
}

/** 只读提示。 */
export function askAlert(options: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    const title = el("h2", { text: options.title });
    const body = el("div", { class: "dialog-body" });
    const box = el("div", { class: "confirm-box" });
    box.append(icon(options.tone === "error" ? "warn" : "info", "confirm-icon"));
    box.append(el("p", { class: "confirm-message", text: options.message }));
    body.append(box);

    let settled = false;
    let backdrop: HTMLElement | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop?.remove();
      resolve();
    };

    const foot = el("div", { class: "dialog-foot" });
    const ok = el("button", {
      class: "btn primary",
      attr: { type: "button" },
      text: options.confirmText ?? "知道了",
      on: { click: () => finish() },
    });
    foot.append(el("span", { class: "spacer" }), ok);
    backdrop = backdropOf(shell(title, body, foot));

    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape" || ev.key === "Enter") {
        ev.preventDefault();
        finish();
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    queueMicrotask(() => ok.focus());
  });
}
