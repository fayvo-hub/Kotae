// 前置 / 后置操作列表：请求页签、集合与文件夹的共享设置、全局脚本三处共用。
//
// 每一行是一步操作（内联脚本 / 脚本库引用 / 等待时间），行内就地展开编辑。
// 顺序就是执行顺序，靠行右侧「…」里的上移/下移调，不做拖拽——拖拽要维护
// 拖影、插入位置与键盘可达性，收益不如两条菜单项。
//
// 这一层用哪份数据、写回哪里由调用方决定（onChange），组件只管渲染与局部重绘，
// 所以它在浮层里也能用：改完自己把列表重画一遍，不依赖全局 emit。

import { el, fill, icon } from "./dom";
import { openContextMenu } from "./menu";
import { selectBox } from "./select";
import { askConfirm } from "./prompt";
import { scriptCodeArea } from "./scriptEditor";
import { findLibraryScript, libraryScripts, toggleUI } from "../store";
import type { ScriptPhase, ScriptStep, ScriptSteps } from "../types";

/** 哪些步骤是展开的：键是步骤 id，跨重绘有效（请求页签每次 emit 都会重建面板）。 */
const expanded = new Set<string>();

export interface ScriptStepsSpec {
  phase: ScriptPhase;
  /**
   * 每次写回前都重新读一遍，不缓存快照：同一个弹窗里前置、后置两个面板并存，
   * 各自握着打开时的副本会把对方刚删掉的步骤又写回去。
   */
  steps: () => ScriptSteps;
  /** 写回：quiet 为真时不重绘全局（编辑源码时用，避免光标丢失）。 */
  onChange: (next: ScriptSteps, quiet: boolean) => void;
}

const KIND_LABEL: Record<ScriptStep["kind"], string> = {
  script: "脚本",
  library: "脚本库",
  wait: "等待时间",
};

function newStep(kind: ScriptStep["kind"]): ScriptStep {
  if (kind === "script") return { id: uid(), kind, enabled: true, source: "" };
  if (kind === "library") return { id: uid(), kind, enabled: true };
  return { id: uid(), kind, enabled: true, ms: 1000 };
}

let seq = 0;
function uid(): string {
  seq += 1;
  return `step-${Date.now().toString(36)}-${seq}`;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((row) => row.trim().length > 0) ?? "";
  return line.trim();
}

function summaryOf(step: ScriptStep): string {
  if (step.kind === "script") {
    const line = firstLine(step.source ?? "");
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  }
  if (step.kind === "library") {
    return step.libraryId ? findLibraryScript(step.libraryId)?.name ?? "脚本已删除" : "";
  }
  return `${step.ms ?? 0} 毫秒`;
}

/** 一行右侧的开关：关掉的步骤不执行，也不占子页签徽标。 */
function toggleSwitch(step: ScriptStep, onToggle: () => void): HTMLElement {
  const box = el("input", {
    class: "step-switch",
    attr: { type: "checkbox", "aria-label": `启用${KIND_LABEL[step.kind]}` },
    on: { change: () => onToggle() },
  });
  box.checked = step.enabled;
  return box;
}

/** 行右侧的「…」菜单：排序与增删都收在这里。 */
function rowMenu(ev: MouseEvent, actions: { up?: () => void; down?: () => void; copy?: () => void; remove: () => void }): void {
  const items = [
    { label: "上移", disabled: !actions.up, run: () => actions.up?.() },
    { label: "下移", disabled: !actions.down, run: () => actions.down?.() },
    { label: "复制一份", disabled: !actions.copy, run: () => actions.copy?.() },
    { label: "删除", danger: true, run: () => actions.remove() },
  ];
  openContextMenu(ev, items);
}

/**
 * 渲染一个阶段的操作列表。
 * 列表本身自带「添加前置操作 / 添加后置操作」入口，空态也只有一句话。
 */
export function scriptStepsPanel(spec: ScriptStepsSpec): HTMLElement {
  const list = el("div", { class: "step-list" });
  const root = el("div", { class: "step-panel" }, list);

  /** 写回并重画自己；quiet 时只落库不重画（源码输入走这条）。 */
  const commit = (next: ScriptSteps, quiet: boolean, repaint = true): void => {
    spec.onChange(next, quiet);
    if (repaint && !quiet) paint();
  };

  const writePhase = (mutator: (rows: ScriptStep[]) => ScriptStep[], quiet = false): void => {
    const steps = spec.steps();
    const rows = [...steps[spec.phase]];
    const next: ScriptSteps = { pre: [...steps.pre], post: [...steps.post] };
    next[spec.phase] = mutator(rows);
    commit(next, quiet);
  };

  const move = (id: string, delta: number): void => {
    writePhase((rows) => {
      const at = rows.findIndex((row) => row.id === id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= rows.length) return rows;
      const picked = rows[at];
      if (!picked) return rows;
      rows.splice(at, 1);
      rows.splice(to, 0, picked);
      return rows;
    });
  };

  const remove = async (step: ScriptStep): Promise<void> => {
    const risky = step.kind === "script" && Boolean(step.source?.trim());
    if (risky) {
      const ok = await askConfirm({
        title: `删除${KIND_LABEL[step.kind]}`,
        message: "这一条里的代码会一起删掉，确定吗？",
        detail: firstLine(step.source ?? ""),
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
    }
    expanded.delete(step.id);
    writePhase((rows) => rows.filter((row) => row.id !== step.id));
  };

  const addStep = (kind: ScriptStep["kind"]): void => {
    const step = newStep(kind);
    // 新加的那一行直接展开：加脚本就是为了马上写代码，多一次点击没意义。
    expanded.add(step.id);
    writePhase((rows) => [...rows, step]);
  };

  const patchStep = (id: string, patch: Partial<ScriptStep>, quiet: boolean): void => {
    const steps = spec.steps();
    const rows = steps[spec.phase];
    const target = rows.find((row) => row.id === id);
    if (!target) return;
    Object.assign(target, patch);
    if (quiet) {
      spec.onChange({ ...steps, [spec.phase]: rows }, true);
      return;
    }
    writePhase((list2) => list2);
  };

  const rowOf = (step: ScriptStep, index: number, total: number): HTMLElement => {
    const open = expanded.has(step.id);
    const hint = el("span", { class: "step-hint", text: summaryOf(step) });
    const chevron = el(
      "button",
      {
        class: `icon-btn mini step-expand${open ? " open" : ""}`,
        attr: { type: "button", title: open ? "收起" : "展开", "aria-expanded": open ? "true" : "false" },
        on: {
          click: () => {
            if (open) expanded.delete(step.id);
            else expanded.add(step.id);
            paint();
          },
        },
      },
      icon("chevron"),
    );
    const more = el(
      "button",
      {
        class: "icon-btn mini step-more",
        attr: { type: "button", title: "更多操作", "aria-label": `${KIND_LABEL[step.kind]}的更多操作` },
        on: {
          click: (ev: MouseEvent) => {
            ev.stopPropagation();
            rowMenu(ev, {
              ...(index > 0 ? { up: () => move(step.id, -1) } : {}),
              ...(index < total - 1 ? { down: () => move(step.id, 1) } : {}),
              copy: () => {
                const copy: ScriptStep = { ...step, id: uid() };
                expanded.add(copy.id);
                writePhase((rows) => {
                  const at = rows.findIndex((row) => row.id === step.id);
                  rows.splice(at + 1, 0, copy);
                  return rows;
                });
              },
              remove: () => {
                void remove(step);
              },
            });
          },
        },
      },
      icon("more"),
    );

    const head = el(
      "div",
      { class: "step-head" },
      el("span", { class: "step-index", text: String(index + 1) }),
      el("span", { class: "step-kind", text: KIND_LABEL[step.kind] }),
      step.kind === "library" && !step.libraryId
        ? el("span", { class: "step-hint empty", text: "请选择" })
        : hint,
      el("span", { class: "spacer" }),
      toggleSwitch(step, () => patchStep(step.id, { enabled: !step.enabled }, false)),
      more,
      chevron,
    );

    const row = el(
      "div",
      {
        class: `step-row${open ? " open" : ""}${step.enabled ? "" : " off"}`,
        data: { stepId: step.id, kind: step.kind },
      },
      head,
    );
    if (open) row.append(el("div", { class: "step-body" }, ...bodyOf(step, hint)));
    return row;
  };

  /** 展开后的内容：脚本给编辑框，脚本库给下拉，等待时间给毫秒输入。 */
  const bodyOf = (step: ScriptStep, hint: HTMLElement): HTMLElement[] => {
    if (step.kind === "script") {
      return [
        scriptCodeArea({
          source: step.source ?? "",
          phase: spec.phase,
          label: `${KIND_LABEL[step.kind]}内容`,
          onInput: (value) => {
            patchStep(step.id, { source: value }, true);
            // 折叠状态下标题右边那行摘要跟着变，但不动输入框自己。
            hint.textContent = summaryOf({ ...step, source: value });
          },
        }),
      ];
    }
    if (step.kind === "library") {
      const options = [
        { value: "", label: "请选择" },
        ...libraryScripts().map((lib) => ({
          value: lib.id,
          label: lib.name,
          ...(lib.trusted === false ? { hint: "未信任" } : {}),
        })),
      ];
      return [
        el(
          "div",
          { class: "step-picker" },
          selectBox({
            value: step.libraryId ?? "",
            options,
            label: "选择脚本库里的脚本",
            onPick: (id) => {
              expanded.add(step.id);
              patchStep(step.id, { libraryId: id || undefined }, false);
            },
          }),
          el("button", {
            class: "link-btn",
            attr: { type: "button" },
            text: "管理脚本库",
            on: { click: () => toggleUI("scriptsOpen", true) },
          }),
        ),
      ];
    }
    const input = el("input", {
      class: "text-input wait-input",
      attr: { type: "number", min: "0", max: "60000", step: "100", "aria-label": "等待毫秒数" },
      on: {
        input: () => {
          const ms = Math.max(0, Math.min(60000, Number(input.value) || 0));
          patchStep(step.id, { ms }, true);
          hint.textContent = `${ms} 毫秒`;
        },
      },
    });
    input.value = String(step.ms ?? 0);
    return [el("div", { class: "step-wait" }, input, el("span", { class: "pane-hint", text: "毫秒，最多 60 秒" }))];
  };

  const addButton = (): HTMLElement => {
    const label = spec.phase === "pre" ? "添加前置操作" : "添加后置操作";
    return el(
      "button",
      {
        class: "step-add",
        attr: { type: "button" },
        on: {
          click: (ev: MouseEvent) =>
            openContextMenu(ev, [
              { label: "脚本", hint: "就地写代码", run: () => addStep("script") },
              { label: "脚本库", hint: "引用脚本库里的脚本", run: () => addStep("library") },
              { label: "等待时间", hint: "停顿一会儿再继续", run: () => addStep("wait") },
            ]),
        },
      },
      el("span", { text: label }),
      icon("chevronDown"),
    );
  };

  function paint(): void {
    const rows = spec.steps()[spec.phase];
    const empty = rows.length === 0 ? [el("div", { class: "pane-hint", text: "还没有操作，请求会原样发出。" })] : [];
    fill(list, ...empty, ...rows.map((step, index) => rowOf(step, index, rows.length)), addButton());
  }

  paint();
  return root;
}
