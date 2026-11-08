// 首帧预热：把常用控件的形状在启动后先画两帧再扔掉。
//
// WebView2 的 GPU 着色器/栅格缓存（userData 下的 GPUCache）是冷的时，
// 某一类控件第一次被绘制要现场编译，实测一次 20–80ms：用户看到的就是
// 「第一次新建脚本」「第一次切到请求体」卡一下，之后再点就不卡了。
// 这里在启动完成、用户还没动手时把这份开销提前付掉。
//
// 两个前提不能省：节点必须在视口内且真的被绘制——`display: none`、
// `opacity: 0` 或挪到视口外（left: -4000px）都不会触发绘制，预热就白做；
// 所以用 `.paint-warmup` 的 opacity 0.01（肉眼不可见）+ pointer-events: none。
// 实测：冷缓存下「新建脚本」首帧长帧 74ms，预热后 0ms。

import { el } from "./dom";
import { selectBox } from "./select";
import { scriptApiDetails, scriptSourceField } from "./scriptEditor";

/** 画够两帧再移除：第一帧提交绘制，第二帧确保结果落到合成器。 */
const HOLD_FRAMES = 2;

/** 启动后调用一次；对已热的缓存只是几毫秒的重绘。 */
export function warmUpFirstPaint(): void {
  const dialog = el("div", { class: "dialog" });
  const head = el("div", { class: "dialog-head" });
  head.append(el("h2", { text: "预热" }));
  dialog.append(
    head,
    el(
      "div",
      { class: "dialog-body" },
      // 脚本库编辑器：等宽文本域 + 可折叠的 API 速查。
      scriptSourceField({ source: "", phase: "pre", label: "预热", onInput: () => {} }),
      scriptApiDetails(),
      // 请求体那种裸的等宽文本域。
      el("textarea", { class: "code-input", attr: { spellcheck: "false", "aria-label": "预热" } }),
      el(
        "div",
        { class: "form-grid" },
        selectBox({
          value: "pre",
          label: "预热",
          options: [
            { value: "pre", label: "前置脚本" },
            { value: "post", label: "后置脚本" },
          ],
          onPick: () => {},
        }),
      ),
      el("label", { class: "field checkbox-field" }, el("input", { attr: { type: "checkbox" } })),
    ),
    el("div", { class: "dialog-foot" }),
  );
  const root = el("div", { class: "paint-warmup", attr: { "aria-hidden": "true" } });
  root.append(dialog);
  document.body.append(root);
  // 读一次几何信息，让样式与布局在这一帧就发生，别拖到后面的用户操作里。
  void root.getBoundingClientRect();

  let frames = 0;
  const tick = (): void => {
    frames += 1;
    if (frames < HOLD_FRAMES) requestAnimationFrame(tick);
    else root.remove();
  };
  requestAnimationFrame(tick);
}
