// 脚本库浮层：全局 / 集合 / 请求的脚本全摊在一个列表里，列表顺序就是执行顺序。
// 一条脚本只做一件事（前置或后置），要几步就用几条脚本排队，和 Apifox 的用法一致。

import { el, fill, icon } from "./dom";
import { askConfirm } from "./prompt";
import { scriptApiDetails, scriptPhaseHint, scriptSourceField } from "./scriptEditor";
import { closeAll, modal } from "./overlays";
import { selectBox, type SelectOption } from "./select";
import {
  activeTab,
  allScripts,
  createScript,
  deleteScript,
  moveScript,
  scriptScopeLabel,
  state,
  updateScript,
} from "../store";
import type { Collection, ScriptEntry, ScriptScopeKind } from "../types";

/** 选中的脚本 id：浮层关掉再打开仍停在上一条，编辑体验是连续的。 */
let selected: string | null = null;

/** 作用范围的选择值：`global` / `collection:<id>` / `request:<nodeId>`。 */
function scopeValue(entry: ScriptEntry): string {
  if (entry.scope === "global") return "global";
  return `${entry.scope}:${entry.scopeId ?? ""}`;
}

function parseScope(value: string): { scope: ScriptScopeKind; scopeId?: string } {
  const at = value.indexOf(":");
  const kind = at < 0 ? value : value.slice(0, at);
  const id = at < 0 ? "" : value.slice(at + 1);
  if ((kind === "collection" || kind === "request") && id) return { scope: kind, scopeId: id };
  return { scope: "global" };
}

/** 把集合树摊成「集合 + 它下面的每个请求」的选项，请求用 hint 标出所在位置。 */
function scopeOptions(): SelectOption[] {
  const out: SelectOption[] = [{ value: "global", label: "全局（所有请求）" }];
  for (const collection of state.collections) {
    out.push({ value: `collection:${collection.id}`, label: `集合「${collection.name}」` });
    const walk = (nodes: Collection["items"], path: string): void => {
      for (const node of nodes) {
        if (node.type === "request") {
          out.push({
            value: `request:${node.id}`,
            label: `请求「${node.name}」`,
            hint: `${collection.name}${path ? ` / ${path}` : ""}`,
          });
        } else {
          walk(node.items, `${path ? `${path} / ` : ""}${node.name}`);
        }
      }
    };
    walk(collection.items, "");
  }
  return out;
}

export function scriptsDialog(): HTMLElement {
  const listHost = el("div", { class: "script-lib-list" });
  const editorHost = el("div", { class: "script-lib-editor" });

  /** 当前选中的脚本；选中项被删掉时退回第一条。 */
  const current = (): ScriptEntry | undefined => {
    const entries = allScripts();
    const hit = entries.find((entry) => entry.id === selected);
    if (hit) return hit;
    const first = entries[0];
    selected = first?.id ?? null;
    return first;
  };

  const paintList = (): void => {
    const entries = allScripts();
    const active = current();
    fill(listHost);
    if (entries.length === 0) {
      listHost.append(el("p", { class: "muted small", text: "还没有脚本，点下面的「新建」。" }));
      return;
    }
    for (const entry of entries) {
      const row = el("button", {
        class: `script-lib-item${entry.id === active?.id ? " active" : ""}${entry.enabled ? "" : " off"}`,
        attr: { type: "button", "data-script-id": entry.id, title: scriptScopeLabel(entry) },
        on: {
          click: () => {
            selected = entry.id;
            paintAll();
          },
        },
      });
      const meta = `${entry.phase === "pre" ? "前置" : "后置"} · ${scriptScopeLabel(entry)}${
        entry.trusted ? "" : " · 未信任"
      }${entry.enabled ? "" : " · 已停用"}`;
      row.append(
        el("span", { class: "script-lib-name", text: entry.name.trim() || "未命名脚本" }),
        el("span", { class: "script-lib-meta", text: meta }),
      );
      listHost.append(row);
    }
  };

  const paintEditor = (): void => {
    const entry = current();
    fill(editorHost);
    if (!entry) {
      editorHost.append(
        el("p", {
          class: "muted",
          text: "左侧「新建」后在这里写脚本；要几步就建几条，按列表顺序排队执行。",
        }),
      );
      return;
    }

    const nameInput = el("input", {
      class: "text-input",
      attr: { type: "text", placeholder: "脚本名，如「登录拿 token」", "aria-label": "脚本名" },
      on: {
        input: () => {
          // 打字只更新库与左侧名字，不重画编辑器，否则光标会跳。
          updateScript(entry.id, { name: nameInput.value }, true);
          paintList();
        },
      },
    });
    nameInput.value = entry.name;

    const values = scopeOptions();
    const own = scopeValue(entry);
    if (!values.some((option) => option.value === own)) {
      values.unshift({ value: own, label: `${scriptScopeLabel(entry)}（已失效）` });
    }

    const fields = el("div", { class: "form-grid" });
    fields.append(
      field(
        "执行阶段",
        selectBox({
          value: entry.phase,
          label: "执行阶段",
          options: [
            { value: "pre", label: "前置脚本", hint: "请求发出前" },
            { value: "post", label: "后置脚本", hint: "拿到响应后" },
          ],
          onPick: (value) => {
            updateScript(entry.id, { phase: value === "post" ? "post" : "pre" });
            paintAll();
          },
        }),
      ),
      field(
        "作用范围",
        selectBox({
          value: own,
          label: "作用范围",
          menuWidth: 260,
          options: values,
          onPick: (value) => {
            updateScript(entry.id, parseScope(value));
            paintAll();
          },
        }),
      ),
    );

    const enabled = el("input", { attr: { type: "checkbox" } });
    enabled.checked = entry.enabled;
    enabled.addEventListener("change", () => {
      updateScript(entry.id, { enabled: enabled.checked });
      paintAll();
    });
    const enableField = el("label", { class: "field checkbox-field" });
    enableField.append(
      enabled,
      el("span", { text: "启用这条脚本" }),
      el("span", { class: "field-hint", text: "关掉后不执行，内容保留。" }),
    );

    editorHost.append(
      el("div", { class: "script-lib-fields" }, field("脚本名", nameInput), fields),
      enableField,
      el("p", { class: "pane-hint", text: scriptPhaseHint(entry.phase) }),
      scriptSourceField({
        source: entry.source,
        phase: entry.phase,
        label: "脚本内容",
        onInput: (value) => updateScript(entry.id, { source: value }, true),
      }),
      scriptApiDetails(),
    );

    if (!entry.trusted) {
      const warn = el("div", { class: "script-untrusted" });
      warn.append(
        el("span", { text: "这条脚本随导入文件一起进来，默认不执行。确认内容后再信任。" }),
        el("button", {
          class: "btn small danger-solid",
          attr: { type: "button" },
          text: "信任并启用",
          on: {
            click: () => {
              updateScript(entry.id, { trusted: true, enabled: true });
              paintAll();
            },
          },
        }),
      );
      editorHost.append(warn);
    }
  };

  const paintAll = (): void => {
    paintList();
    paintEditor();
  };

  // ---- 左侧列表的操作 ----
  const addBtn = el("button", {
    class: "btn small",
    attr: { type: "button" },
    on: {
      click: () => {
        // 有保存过的请求时默认挂到它上面，省得每次去下拉里翻。
        const tab = activeTab();
        const nodeId = tab?.origin?.nodeId;
        const collectionId = tab?.origin?.collectionId;
        selected = nodeId && collectionId ? createScript("request", nodeId) : createScript("global");
        paintAll();
      },
    },
  });
  addBtn.append(icon("plus"), el("span", { text: "新建" }));

  const moveBtn = (label: string, delta: number): HTMLElement =>
    el("button", {
      class: "btn small",
      attr: { type: "button", title: `${label}一位` },
      text: label,
      on: {
        click: () => {
          const entry = current();
          if (!entry) return;
          moveScript(entry.id, delta);
          paintAll();
        },
      },
    });

  const delBtn = el("button", {
    class: "btn small",
    attr: { type: "button" },
    text: "删除",
    on: {
      click: () => {
        const entry = current();
        if (!entry) return;
        void askConfirm({
          title: "删除脚本",
          message: `删除脚本「${entry.name.trim() || "未命名脚本"}」？`,
          detail: "删除后无法恢复，其他脚本不受影响。",
          confirmText: "删除",
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          deleteScript(entry.id);
          selected = null;
          paintAll();
        });
      },
    },
  });

  const left = el("div", { class: "script-lib-side" });
  left.append(listHost, el("div", { class: "tools-row" }, addBtn, moveBtn("上移", -1), moveBtn("下移", 1), delBtn));

  paintAll();

  const body = el("div", { class: "stack" });
  body.append(
    el("p", {
      class: "pane-hint",
      text: "列表顺序就是执行顺序：同一次发送先按顺序跑完所有前置脚本，再按顺序跑后置脚本。",
    }),
    el("div", { class: "script-lib" }, left, editorHost),
  );

  const footer = el("div", { class: "dialog-foot" });
  footer.append(
    el("span", { class: "muted small", text: `共 ${allScripts().length} 条脚本` }),
    el("span", { class: "spacer" }),
    el("button", {
      class: "btn primary",
      attr: { type: "button" },
      text: "完成",
      on: { click: () => closeAll() },
    }),
  );

  return modal("脚本库", body, footer, 820);
}

function field(label: string, control: HTMLElement): HTMLElement {
  const box = el("label", { class: "field" });
  box.append(el("span", { class: "field-label", text: label }), control);
  return box;
}
