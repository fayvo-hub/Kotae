// 快捷键：动作清单、组合键解析与录制。
//
// 每个动作有一个稳定的 id（落库只存 id → 组合键），界面文案与默认键位都在这里，
// 设置页的「快捷键」一节、命令面板和 main.ts 的 keydown 共用同一份定义。

export interface ShortcutAction {
  /** 稳定 id，落库只存它。 */
  id: string;
  /** 设置页显示的动作名。 */
  label: string;
  /** 默认组合键，格式见 comboOf()："Ctrl+Shift+C"。 */
  def: string;
  /** 动作所在的场景说明，设置页右侧的小字。 */
  hint?: string;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "send", label: "发送请求 / 连接", def: "Ctrl+Enter" },
  { id: "new-request", label: "新建请求", def: "Ctrl+N" },
  { id: "new-collection", label: "新建集合", def: "Ctrl+Shift+N" },
  { id: "save", label: "保存请求到集合", def: "Ctrl+S" },
  { id: "import-curl", label: "导入 cURL 命令", def: "Ctrl+I" },
  { id: "import-postman", label: "导入 Postman / HAR", def: "Ctrl+Shift+I" },
  { id: "snippets", label: "生成代码片段", def: "Ctrl+Shift+G" },
  { id: "copy-curl", label: "复制当前请求为 cURL", def: "Ctrl+Shift+C" },
  { id: "env", label: "管理环境变量", def: "Ctrl+E" },
  { id: "palette", label: "打开命令面板", def: "Ctrl+K" },
  { id: "search", label: "在响应体中查找", def: "Ctrl+F" },
  { id: "settings", label: "打开设置", def: "Ctrl+," },
  { id: "sidebar", label: "收起 / 展开侧边栏", def: "Ctrl+B" },
  { id: "close-tab", label: "关闭当前标签页", def: "Ctrl+W" },
  { id: "zoom-in", label: "放大界面", def: "Ctrl+=" },
  { id: "zoom-out", label: "缩小界面", def: "Ctrl+-" },
  { id: "zoom-reset", label: "复位界面缩放", def: "Ctrl+0" },
];

const ACTIONS = new Map(SHORTCUT_ACTIONS.map((a) => [a.id, a]));

export function shortcutAction(id: string): ShortcutAction | undefined {
  return ACTIONS.get(id);
}

/** 把 KeyboardEvent 归一成组合键字符串；没有 Ctrl/⌘ 的一律返回 null（单键不拦）。 */
export function comboOf(ev: KeyboardEvent): string | null {
  if (!ev.ctrlKey && !ev.metaKey) return null;
  const key = keyName(ev);
  if (!key) return null;
  const parts = ["Ctrl"];
  if (ev.altKey) parts.push("Alt");
  if (ev.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** 键名归一：字母一律大写，带 Shift 出来的符号还原成基础键，保证同一物理键只有一种写法。 */
function keyName(ev: KeyboardEvent): string | null {
  const raw = ev.key;
  if (!raw || raw === "Control" || raw === "Meta" || raw === "Alt" || raw === "Shift") return null;
  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    if (/[A-Z0-9]/.test(upper)) return upper;
    const symbols: Record<string, string> = {
      "+": "=",
      "_": "-",
      "|": "\\",
      "{": "[",
      "}": "]",
      ":": ";",
      '"': "'",
      "<": ",",
      ">": ".",
      "?": "/",
      "~": "`",
    };
    return symbols[raw] ?? raw;
  }
  const named: Record<string, string> = {
    " ": "Space",
    Spacebar: "Space",
    Escape: "Esc",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Delete: "Delete",
    Backspace: "Backspace",
    Tab: "Tab",
    Enter: "Enter",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  return named[raw] ?? null;
}

/** 显示用文案：把 "Ctrl+Shift+C" 原样展示，和界面里其它提示保持一致。 */
export function comboLabel(combo: string): string {
  return combo;
}

// ---- 录制：设置页点「修改」后捕获下一次按键 ----

let capture: ((combo: string | null) => void) | null = null;

function onCapture(ev: KeyboardEvent): void {
  if (!capture) return;
  // 录制期间不让按键落到全局快捷键上。
  ev.preventDefault();
  ev.stopImmediatePropagation();
  if (ev.key === "Escape") {
    finishCapture(null);
    return;
  }
  const combo = comboOf(ev);
  if (!combo) return; // 还没按到带 Ctrl/⌘ 的组合，继续等
  finishCapture(combo);
}

function finishCapture(combo: string | null): void {
  const fn = capture;
  capture = null;
  window.removeEventListener("keydown", onCapture, true);
  fn?.(combo);
}

/** 开始录制下一次组合键；传入 null 表示用户按了 Esc 取消。 */
export function beginShortcutCapture(handler: (combo: string | null) => void): void {
  finishCapture(null);
  capture = handler;
  window.addEventListener("keydown", onCapture, true);
}

export function endShortcutCapture(): void {
  finishCapture(null);
}

export function isCapturing(): boolean {
  return capture !== null;
}
