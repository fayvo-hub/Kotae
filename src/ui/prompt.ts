// 应用内输入与确认对话框。
// webview 里 window.prompt / confirm 未必可用（某些平台不弹出），所以自己实现一套。

import { el, icon } from "./dom";

interface TextOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmText?: string;
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

function backdropOf(dialog: HTMLElement, onDismiss: () => void): HTMLElement {
  const backdrop = el("div", {
    class: "backdrop prompt-backdrop",
    on: {
      mousedown: (ev) => {
        if (ev.target === backdrop) onDismiss();
      },
    },
  });
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
    const input = el("input", {
      class: "text-input",
      attr: {
        placeholder: options.placeholder ?? "",
        spellcheck: "false",
        autocomplete: "off",
      },
      on: {
        keydown: (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            finish(input.value.trim() || null);
          }
        },
      },
    });
    input.value = options.value ?? "";

    const body = el("div", { class: "dialog-body" });
    const field = el("label", { class: "field" });
    if (options.label) field.append(el("span", { class: "field-label", text: options.label }));
    field.append(input);
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
    const backdrop = backdropOf(dialog, () => finish(null));
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
    const backdrop = backdropOf(dialog, () => finish(false));
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
    backdrop = backdropOf(shell(title, body, foot), () => finish());

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
