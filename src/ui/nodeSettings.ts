// 集合 / 文件夹的共享设置：认证与变量。子请求没自己设时自动继承。

import { el, fill } from "./dom";
import { authEditor } from "./authEditor";
import { scriptEditor } from "./scriptEditor";
import { kvTable } from "./kvtable";
import { closeAll, modal } from "./overlays";
import { emptyAuth, findNode, setNodeSettings, state } from "../store";
import type { ScriptPhase } from "../script";
import type { Collection, FolderNode, KV, RequestScript } from "../types";

export function nodeSettingsDialog(): HTMLElement {
  const target = state.nodeSettings;
  if (!target) return el("div");
  const collection = state.collections.find((c) => c.id === target.collectionId);
  if (!collection) return el("div");

  const folder =
    target.nodeId !== undefined ? findNode(target.collectionId, target.nodeId)?.node : undefined;
  const node: Collection | FolderNode =
    folder && folder.type === "folder" ? folder : collection;

  const write = (patch: Parameters<typeof setNodeSettings>[2]): void =>
    setNodeSettings(target.collectionId, node === collection ? undefined : node.id, patch);

  const body = el("div", { class: "stack" });
  body.append(
    el("p", {
      class: "pane-hint",
      text: node === collection
        ? "这里的认证与变量对集合里的所有请求生效，除非请求自己（或更深的文件夹）另设了一份。"
        : "这里的认证与变量对这个文件夹里的所有请求生效，文件夹越深优先级越高。",
    }),
  );

  // ---- 认证 ----
  const authHost = el("div", { class: "stack" });
  const paintAuth = (): void => {
    const current = node.auth ?? emptyAuth();
    fill(
      authHost,
      authEditor(current, {
        update: (recipe) => {
          const draft = { ...(node.auth ?? emptyAuth()) };
          recipe(draft);
          write({ auth: draft });
        },
        rebuild: paintAuth,
        emptyText: "不额外添加认证信息，继续沿用上层的设置",
      }),
    );
  };
  paintAuth();
  body.append(section("认证", "请求自己没选认证方式时，用这里的这一份。", authHost));

  // ---- 变量 ----
  // 抓住交给表格的那个数组：重绘/持久化期间它可能被换成新的空数组，
  // 若 onChange 里再读 node.vars，就会把输入写进一个已经脱离 state 的数组。
  if (!node.vars) node.vars = [];
  const rows: KV[] = node.vars;
  const table = kvTable({
    rows,
    keyPlaceholder: "变量名（如 baseUrl）",
    valuePlaceholder: "变量值",
    emptyHint: "还没有变量，点击下面的按钮添加",
    secretToggle: true,
    onChange: () => write({ vars: rows }),
  });
  body.append(
    section("变量", "发送请求时按「环境 > 文件夹 > 集合 > 全局」的顺序取值，同名变量深层优先。", table),
  );

  // ---- 脚本 ----
  // 这段脚本对这个集合（文件夹）里的每个请求都跑：前置在请求自己的脚本之前，
  // 后置在请求自己的脚本之后。弹窗不随 emit 重建，所以阶段状态放在本地。
  let scriptPhase: ScriptPhase = "pre";
  const scriptHost = el("div", { class: "stack" });
  const paintScript = (): void => {
    const current: RequestScript = node.script ?? { pre: "", post: "", trusted: true };
    fill(
      scriptHost,
      scriptEditor({
        script: current,
        phase: scriptPhase,
        onPhase: (phase) => {
          scriptPhase = phase;
          paintScript();
        },
        onInput: (phase, value) => write({ script: { ...current, [phase]: value } }),
      }),
    );
  };
  paintScript();
  body.append(
    section(
      "脚本",
      `这里的脚本对${node === collection ? "集合" : "文件夹"}里的每个请求都会执行：前置比请求自己的脚本先跑，后置比它后跑。`,
      scriptHost,
    ),
  );

  const footer = el("div", { class: "dialog-foot" });
  footer.append(
    el("span", { class: "muted small", text: `作用范围：${target.name}` }),
    el("span", { class: "spacer" }),
    el("button", {
      class: "btn primary",
      attr: { type: "button" },
      text: "完成",
      on: { click: () => closeAll() },
    }),
  );

  const kind = node === collection ? "集合" : "文件夹";
  return modal(`共享设置 · ${kind}「${node.name}」`, body, footer, 680);
}

function section(title: string, hint: string, content: HTMLElement): HTMLElement {
  const box = el("section", { class: "settings-section" });
  box.append(
    el("h3", { text: title }),
    el("p", { class: "muted small", text: hint }),
    content,
  );
  return box;
}
