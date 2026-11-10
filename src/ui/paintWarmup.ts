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

import { el, icon } from "./dom";
import { codeEditor } from "./codeEditor";
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
      // 脚本库编辑器：自建代码框 + 语法着色 + 右侧片段栏，
      // 源码给一段带注释/字符串/关键字/内置对象的样本，着色也一并预热。
      scriptSourceField({
        source: `// 预热\nconst token = pm.environment.get("baseUrl");`,
        phase: "pre",
        label: "预热",
        onInput: () => {},
      }),
      scriptApiDetails(),
      // 请求体那种裸的等宽代码框：变量高亮与占位提示的重量都在它身上。
      codeEditor({
        value: '{\n  "name": "{{baseUrl}}"\n}',
        placeholder: '{\n  "name": "张三"\n}',
        label: "预热",
        vars: true,
        onInput: () => {},
      }),
      // 变量高亮的镜像层 + 变量浮层：着色、标签边框与阴影都是首次绘制才编译。
      el(
        "div",
        { class: "var-host" },
        el(
          "div",
          { class: "var-mirror on" },
          el(
            "div",
            { class: "var-inner" },
            el("span", { class: "var-token", text: "{{baseUrl}}" }),
            el("span", { class: "var-token missing", text: "{{nope}}" }),
          ),
        ),
        el("input", { class: "text-input var-input", attr: { "aria-label": "预热" } }),
      ),
      el(
        "div",
        { class: "var-tip on", style: { left: "40px", top: "40px" } },
        el(
          "div",
          { class: "var-tip-head" },
          el("code", { class: "var-tip-name", text: "{{baseUrl}}" }),
          el("span", { class: "var-tip-tag", text: "环境变量" }),
        ),
        el("div", { class: "var-tip-value", text: "预热" }),
      ),
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
      // 前置 / 后置操作的行：序号 + 类型 + 摘要 + 开关 + 两枚小图标按钮，展开体里是代码区与片段栏。
      el(
        "div",
        { class: "step-panel" },
        el(
          "div",
          { class: "step-list" },
          el(
            "div",
            { class: "step-row open" },
            el(
              "div",
              { class: "step-head" },
              el("span", { class: "step-index", text: "1" }),
              el("span", { class: "step-kind", text: "脚本" }),
              el("span", { class: "step-hint", text: "预热" }),
              el("span", { class: "spacer" }),
              el("span", { class: "step-switch" }, el("input", { attr: { type: "checkbox" } })),
              el("button", { class: "icon-btn mini step-more", attr: { type: "button" } }, icon("more")),
              el("button", { class: "icon-btn mini step-expand open", attr: { type: "button" } }, icon("chevron")),
            ),
            el(
              "div",
              { class: "step-body" },
              el(
                "div",
                { class: "script-code" },
                codeEditor({ value: "// 预热", className: "script-input", label: "预热", js: true, onInput: () => {} }),
                el(
                  "div",
                  { class: "script-rail" },
                  el("span", { class: "script-rail-title", text: "代码片段" }),
                  el(
                    "div",
                    { class: "script-rail-group" },
                    el("span", { class: "script-rail-head", text: "变量" }),
                    el("button", { class: "script-rail-item", attr: { type: "button" }, text: "获取环境变量" }),
                  ),
                ),
              ),
            ),
          ),
        ),
        el("button", { class: "step-add", attr: { type: "button" } }, el("span", { text: "添加前置操作" }), icon("chevronDown")),
      ),
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
