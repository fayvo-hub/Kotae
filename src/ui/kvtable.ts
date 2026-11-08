// 键值表格：查询参数、请求头、表单、环境变量共用。
// 功能：逐行启用开关、批量粘贴、变量名 {{ }} 自动补全、行内删除。

import { el, fill, icon, iconButton } from "./dom";
import { visibleVarNames } from "../util";
import { pasteText, scope, toast } from "../store";
import { DYNAMIC_VARS } from "../util";
import { askAlert, askText } from "./prompt";
import { enableVarHighlight } from "./varTokens";

export interface KVRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  /** 标记为敏感：界面上默认遮住值，只影响显示，发送与导出仍用真实值。 */
  secret?: boolean;
}

export interface KVTableOptions<T extends KVRow> {
  rows: T[];
  /** 键与值的占位提示。 */
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** 变更后回调（调用方负责持久化与重绘）。 */
  onChange: () => void;
  /** 是否显示启用开关。 */
  toggle?: boolean;
  /** 键盘按下 Enter 时的行为（通常是聚焦下一行）。 */
  onEnter?: () => void;
  /** 额外的行尾按钮（如文件选择）。 */
  extra?: (row: T, index: number) => HTMLElement[];
  /** 值列是文本域（长值更舒服）。 */
  multiline?: boolean;
  /** 是否启用变量补全。 */
  autocomplete?: boolean;
  /** 键列的候选值（显示为可下拉的候选列表）。 */
  keyList?: string[];
  /** 空状态提示。 */
  emptyHint?: string;
  /** 是否显示「遮住值」开关（环境变量用）。 */
  secretToggle?: boolean;
}

/** 构建一张键值表格。每次数据变更都通过 onChange 让外层重绘。 */
export function kvTable<T extends KVRow>(opts: KVTableOptions<T>): HTMLElement {
  const wrap = el("div", { class: "kv" });
  const rows = opts.rows;

  const body = el("div", { class: "kv-body" });

  const addRow = (focus = false): void => {
    const row = { id: "", key: "", value: "", enabled: true } as unknown as T;
    (row as KVRow).id = newId();
    rows.push(row);
    refresh();
    if (focus) {
      const inputs = body.querySelectorAll<HTMLInputElement>(".kv-key");
      inputs[inputs.length - 1]?.focus();
    }
  };

  // 行数变化时自己重绘（增/删/粘贴），调用方不必重建整块界面：
  // 重建会重播浮层动画、丢失输入焦点，环境与全局变量编辑器就靠这个避免闪烁。
  const paint = (): void => {
    body.replaceChildren();
    if (rows.length === 0) {
      body.append(
        el("div", {
          class: "kv-empty",
          text: opts.emptyHint ?? "还没有内容，点击下方按钮添加一行",
        }),
      );
      return;
    }
    rows.forEach(paintRow);
  };

  /** 结构变化：先重绘再交给调用方持久化。 */
  const refresh = (): void => {
    paint();
    opts.onChange();
  };

  function paintRow(row: T, index: number): void {
    const line = el("div", { class: "kv-row" });
    if (opts.toggle !== false) {
      const check = el("input", {
        class: "kv-check",
        attr: { type: "checkbox", "aria-label": "启用这一行" },
        on: {
          change: () => {
            row.enabled = check.checked;
            opts.onChange();
          },
        },
      });
      check.checked = row.enabled;
      line.append(el("label", { class: "kv-switch" }, check));
    }

    const keyInput = el("input", {
      class: "kv-key",
      attr: {
        placeholder: opts.keyPlaceholder ?? "名称",
        spellcheck: "false",
        autocomplete: "off",
      },
      on: {
        input: () => {
          row.key = keyInput.value;
          opts.onChange();
        },
        keydown: (ev) => onRowKeydown(ev, row, "key"),
      },
    });
    keyInput.value = row.key;
    // 补全在创建时就挂上：靠 focus 挂会让「已经被聚焦的输入框」漏掉（重绘后焦点是恢复出来的，
    // 不会再派发一次 focus）。
    enableVarAssist(keyInput, `kv:${row.id}:key`);
    enableVarHighlight(keyInput);
    if (opts.keyList && opts.keyList.length > 0) {
      const listId = `dl_${newId()}`;
      const dl = el("datalist", { attr: { id: listId } });
      for (const name of opts.keyList) dl.append(el("option", { attr: { value: name } }));
      keyInput.setAttribute("list", listId);
      wrap.append(dl);
    }

    const valueInput: HTMLInputElement | HTMLTextAreaElement = opts.multiline
      ? el("textarea", {
          class: "kv-value",
          attr: { placeholder: opts.valuePlaceholder ?? "值", spellcheck: "false", rows: "1" },
          on: {
            input: () => {
              row.value = valueInput.value;
              autoGrow(valueInput as HTMLTextAreaElement);
              opts.onChange();
            },
            keydown: (ev) => onRowKeydown(ev, row, "value"),
          },
        })
      : el("input", {
          class: "kv-value",
          attr: {
            placeholder: opts.valuePlaceholder ?? "值",
            spellcheck: "false",
            autocomplete: "off",
            type: row.secret ? "password" : "text",
          },
          on: {
            input: () => {
              row.value = valueInput.value;
              opts.onChange();
            },
            keydown: (ev) => onRowKeydown(ev, row, "value"),
          },
        });
    valueInput.value = row.value;
    enableVarAssist(valueInput, `kv:${row.id}:value`);
    enableVarHighlight(valueInput);
    if (opts.multiline) queueMicrotask(() => autoGrow(valueInput as HTMLTextAreaElement));

    line.append(keyInput, valueInput);

    for (const extra of opts.extra?.(row, index) ?? []) line.append(extra);

    if (opts.secretToggle) {
      const toggle = iconButton(
        "lock",
        row.secret ? "值已遮住，点击显示" : "遮住这个值（只影响显示，发送仍用真实值）",
        () => {
          row.secret = !row.secret;
          opts.onChange();
          paint();
        },
        "kv-secret",
      );
      if (row.secret) toggle.classList.add("active");
      line.append(toggle);
    }

    line.append(
      iconButton(
        "close",
        "删除这一行",
        () => {
          const i = rows.indexOf(row);
          if (i >= 0) rows.splice(i, 1);
          refresh();
        },
        "kv-del",
      ),
    );

    body.append(line);
  }

  // Enter 跳到下一行，末尾自动新增。
  const onRowKeydown = (ev: KeyboardEvent, row: T, which: "key" | "value"): void => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const inputs = [...body.querySelectorAll<HTMLElement>(which === "key" ? ".kv-key" : ".kv-value")];
      const idx = inputs.findIndex((n) => n === document.activeElement);
      if (idx >= 0 && idx + 1 < inputs.length) inputs[idx + 1]!.focus();
      else if (which === "value") addRow(true);
    }
    if (ev.key === "Backspace") {
      // 键与值都为空时，Backspace 直接删掉这一行。
      const input = ev.target as HTMLInputElement;
      if (input.value === "" && row.key === "") {
        const i = rows.indexOf(row);
        if (i >= 0) {
          ev.preventDefault();
          rows.splice(i, 1);
          refresh();
        }
      }
    }
  };

  const foot = el("div", { class: "kv-foot" });
  const addBtn = el("button", {
    class: "link-btn",
    attr: { type: "button" },
    on: { click: () => addRow(true) },
  });
  addBtn.append(icon("plus"), el("span", { text: "添加一行" }));

  const pasteBtn = el("button", {
    class: "link-btn",
    attr: { type: "button", title: "每行一对「名称: 值」，或粘贴原始请求头文本" },
    on: {
      click: () => {
        void pasteInto(rows, opts, refresh);
      },
    },
  });
  pasteBtn.append(icon("table"), el("span", { text: "批量粘贴" }));

  fill(foot, addBtn, pasteBtn);
  fill(wrap, body, foot);
  paint();
  return wrap;
}

function newId(): string {
  return `kv_${Math.random().toString(36).slice(2, 10)}`;
}

function autoGrow(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  area.style.height = `${Math.min(160, area.scrollHeight)}px`;
}

/** 把表格里的行拍成批量粘贴的文本，禁用行加 `# ` 前缀。 */
export function rowsToText(rows: KVRow[]): string {
  return rows
    .filter((row) => row.key.trim() !== "" || row.value.trim() !== "")
    .map((row) => `${row.enabled ? "" : "# "}${row.key}: ${row.value}`)
    .join("\n")
    .trim();
}

/** 批量粘贴：按行拆分，支持「k: v」「k=v」「k	v」三种分隔；行首 `#` 表示禁用。 */
async function pasteInto<T extends KVRow>(
  rows: T[],
  opts: KVTableOptions<T>,
  repaint: () => void,
): Promise<void> {
  // 预填表格里已有的行，让人整体改一遍再覆盖，而不是每次粘贴都从零开始。
  const current = rowsToText(rows);
  const clip = (await pasteText()).trim();
  const submitted = await askText({
    title: "批量粘贴",
    label: "每行一对，支持 name: value 或 name=value；行首加 # 表示禁用该行",
    value: current,
    placeholder: "Content-Type: application/json\nAuthorization: Bearer {{token}}",
    multiline: true,
    rows: 8,
    hint: current
      ? `已填入当前 ${rows.length} 行，确定后整体替换；空行会被忽略。`
      : "Enter 换行，Ctrl+Enter 确定；空行会被忽略。",
    replaceAction:
      clip && clip !== current ? { label: "用剪贴板内容替换", text: clip } : undefined,
  });
  // 取消就什么都不做：不能把「取消」当成一份空内容去解析，那样会弹出「没有识别出键值对」。
  if (submitted === null) return;
  const next = submitted.trim();
  if (next === current.trim()) return;
  const parsed = parsePairs(next);
  if (parsed.length === 0) {
    // 主动清空内容是一种明确意图：把表格清空。
    if (next === "") {
      const count = rows.length;
      rows.length = 0;
      repaint();
      toast(`已清空 ${count} 项`);
      return;
    }
    await askAlert({
      title: "没有识别出键值对",
      message: "请检查格式：每行一条，用冒号、等号或制表符分隔名称与值。",
      tone: "error",
    });
    return;
  }
  rows.length = 0;
  for (const p of parsed) {
    const row = { id: newId(), key: p.key, value: p.value, enabled: !p.disabled } as unknown as T;
    rows.push(row);
  }
  repaint();
  toast(`已粘贴 ${parsed.length} 项`);
}

/** 从文本里解析键值对，供批量粘贴复用；行首 `#` 表示这一行禁用。 */
export function parsePairs(text: string): { key: string; value: string; disabled?: boolean }[] {
  const out: { key: string; value: string; disabled?: boolean }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    let disabled = false;
    if (line.startsWith("#")) {
      disabled = true;
      line = line.slice(1).trim();
      if (!line) continue;
    }
    let m = /^([^:=]+?):\s*(.*)$/.exec(line);
    if (!m) m = /^([^=]+?)=(.*)$/.exec(line);
    if (!m) {
      const tab = line.indexOf("	");
      if (tab > 0) {
        out.push({ key: line.slice(0, tab).trim(), value: line.slice(tab + 1).trim(), disabled });
        continue;
      }
      out.push({ key: line, value: "", disabled });
      continue;
    }
    out.push({ key: m[1]!.trim(), value: m[2]!.trim(), disabled });
  }
  return out;
}

// ---- 变量补全 ----

const assistHost = el("div", { class: "assist", attr: { role: "listbox" } });
let assistTarget: HTMLInputElement | HTMLTextAreaElement | null = null;
let assistItems: { name: string; desc: string }[] = [];
let assistIndex = 0;
let assistTriggerAt = -1;
/**
 * 当前补全所属字段的稳定标识。整块请求面板每次 emit 都会重建，输入框元素会被换掉，
 * 靠这个 key 在重绘后把补全接回新元素上，否则弹层会因为旧元素失焦而一闪就没。
 */
let assistKey = "";

/** 把补全层挂到 body 上，跟随输入框位置。 */
export function mountAssist(): void {
  if (!assistHost.isConnected) document.body.append(assistHost);
}

const assistBound = new WeakSet<HTMLElement>();

/**
 * 给任意输入框接上 {{变量}} 补全。表格的行内输入框、地址栏、请求体、cURL 导入框
 * 都走这一份实现，行为保持一致。
 */
export function enableVarAssist(target: HTMLInputElement | HTMLTextAreaElement, key: string): void {
  target.dataset.assistKey = key;
  if (assistBound.has(target)) return;
  assistBound.add(target);
  target.addEventListener("blur", () => {
    window.setTimeout(() => {
      // 元素被重绘换掉了（不是用户主动离开）：交给 resumeAssist 接手，不要收起。
      if (!target.isConnected) return;
      if (document.activeElement === target) return;
      hideAssist();
    }, 120);
  });
  target.addEventListener("input", () => {
    assistTarget = target;
    assistKey = target.dataset.assistKey ?? "";
    updateAssist();
  });
  target.addEventListener("keydown", (ev) => handleAssistKey(ev as KeyboardEvent));
  target.addEventListener("scroll", () => hideAssist());
}

/**
 * 重绘之后把开着的补全接回新元素：整页重绘会替换输入框，不重接就只能看到弹层闪一下。
 * 在 render 末尾（焦点与选区都恢复之后）调用。
 */
export function resumeAssist(): void {
  if (!assistHost.classList.contains("open") || !assistKey) return;
  const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-assist-key="${assistKey}"]`,
  );
  if (!node) {
    hideAssist();
    return;
  }
  if (node === assistTarget && node.isConnected) return;
  assistTarget = node;
  updateAssist();
}

function updateAssist(): void {
  const target = assistTarget;
  if (!target) return;
  const value = target.value;
  const caret = target.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const open = before.lastIndexOf("{{");
  if (open < 0) return hideAssist();
  if (before.slice(open).includes("}}")) return hideAssist();
  const typed = before.slice(open + 2);
  if (/\s/.test(typed)) return hideAssist();

  const names = visibleVarNames(scope());
  const query = typed.toLowerCase();
  assistItems = names
    .filter((n) => n.toLowerCase().startsWith(query))
    .slice(0, 8)
    .map((n) => ({ name: n, desc: DYNAMIC_VARS.find((d) => d.name === n)?.desc ?? "环境或全局变量" }));
  if (assistItems.length === 0) return hideAssist();

  assistIndex = 0;
  assistTriggerAt = open;
  renderAssist();
  positionAssist(target);
}

function renderAssist(): void {
  fill(assistHost, ...assistItems.map((item, i) => {
    const row = el("div", {
      class: `assist-item${i === assistIndex ? " active" : ""}`,
      attr: { role: "option" },
      on: {
        // 按下时挡掉焦点转移，抬起时才应用：输入框的选区要留着才能算出替换范围。
        mousedown: (ev) => ev.preventDefault(),
        click: () => applyAssist(item.name),
      },
    });
    row.append(el("code", { text: `{{${item.name}}}` }), el("span", { class: "assist-desc", text: item.desc }));
    return row;
  }));
  assistHost.classList.add("open");
}

function positionAssist(target: HTMLElement): void {
  const rect = target.getBoundingClientRect();
  assistHost.style.left = `${Math.round(rect.left)}px`;
  assistHost.style.top = `${Math.round(rect.bottom + 4)}px`;
  assistHost.style.minWidth = `${Math.max(220, Math.round(rect.width))}px`;
}

function handleAssistKey(ev: KeyboardEvent): boolean {
  if (!assistHost.classList.contains("open")) return false;
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    assistIndex = (assistIndex + 1) % assistItems.length;
    renderAssist();
    return true;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    assistIndex = (assistIndex - 1 + assistItems.length) % assistItems.length;
    renderAssist();
    return true;
  }
  if (ev.key === "Enter" || ev.key === "Tab") {
    const item = assistItems[assistIndex];
    if (!item) return false;
    ev.preventDefault();
    applyAssist(item.name);
    return true;
  }
  if (ev.key === "Escape") {
    hideAssist();
    return true;
  }
  return false;
}

function applyAssist(name: string): void {
  const target = assistTarget;
  if (!target) return;
  const value = target.value;
  const caret = target.selectionStart ?? value.length;
  const before = value.slice(0, assistTriggerAt);
  const after = value.slice(caret);
  target.value = `${before}{{${name}}}${after}`;
  const pos = before.length + name.length + 4;
  target.setSelectionRange(pos, pos);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  hideAssist();
  target.focus();
}

/** 补全层是否正开着：开着时 Enter/Tab 归补全用，不要触发发送或缩进。 */
export function assistOpen(): boolean {
  return assistHost.classList.contains("open");
}

function hideAssist(): void {
  assistHost.classList.remove("open");
  assistKey = "";
  fill(assistHost);
}
