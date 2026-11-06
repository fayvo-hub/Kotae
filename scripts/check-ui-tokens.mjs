#!/usr/bin/env node
// 设计系统闸门：拦下绕过令牌的写法（裸色值 / 裸字号 / 裸圆角 / 裸阴影 / 未定义令牌 / 未登记动画）。
// 规范见 docs/设计系统.md。退出码非 0 表示有违例，「提交前验证」与 CI 都跑它。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const STYLE = join(ROOT, "src/style.css");
const TOKEN_END = "/* ---- 基础 ---- */";
const NL = String.fromCharCode(10);

// 允许的具名动画与时长，必须与 docs/设计系统.md 3.4 一致
const ALLOWED_ANIMATION = {
  "fade-in": ["120ms"],
  "pop-in": ["90ms", "180ms"],
  spin: ["0.7s"],
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|css)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const problems = [];
const report = (file, line, message, hint) =>
  problems.push(`${relative(ROOT, file)}:${line}  ${message}${hint ? `  → ${hint}` : ""}`);

const css = readFileSync(STYLE, "utf8");
const splitAt = css.indexOf(TOKEN_END);
if (splitAt < 0) {
  console.error(`✗ src/style.css 找不到令牌段结束标记 ${TOKEN_END}`);
  process.exit(1);
}
const tokenBlock = css.slice(0, splitAt);
const rulesBlock = css.slice(splitAt);
const rulesOffset = tokenBlock.split(NL).length - 1;
const ruleLines = rulesBlock.split(NL);

const eachRuleLine = (fn) =>
  ruleLines.forEach((text, index) => fn(text, rulesOffset + index + 1));

// 1 令牌段之外出现裸色值
eachRuleLine((text, line) => {
  const hit = text.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g);
  if (hit) report(STYLE, line, `裸色值 ${hit.join(" ")}`, "改用 var(--accent/--text-2/--border …)，或先在令牌段定义语义令牌");
});

// 2 裸字号
eachRuleLine((text, line) => {
  const hit = text.match(/font-size:\s*[0-9.]+px/);
  if (hit) report(STYLE, line, `裸字号 ${hit[0]}`, "改用 var(--fs-2xs|xs|sm|md|lg|xl|2xl)");
});

// 3 裸圆角（var() / 50% / inherit 合法）
eachRuleLine((text, line) => {
  const hit = text.match(/border-radius:\s*([^;]+);/);
  if (!hit) return;
  if (/var\(|50%|inherit/.test(hit[1])) return;
  if (/[0-9.]+px/.test(hit[1])) report(STYLE, line, `裸圆角 ${hit[0]}`, "改用 var(--radius-xs|sm|radius|lg|xl|pill)");
});

// 4 裸阴影（焦点环与下划线也是阴影层，必须走令牌）
eachRuleLine((text, line) => {
  if (!/box-shadow:\s*/.test(text)) return;
  if (/var\(--(shadow|ring)/.test(text) || /\bnone\b/.test(text)) return;
  report(STYLE, line, `裸阴影 ${text.trim()}`, "改用 var(--shadow-1|2|3|btn) 或 var(--ring|--ring-bad|--shadow-tab-underline)");
});

// 5 动效：transition 统一 var(--speed)；animation 只允许登记过的档位
eachRuleLine((text, line) => {
  const decl = text.match(/\b(?:transition|animation):\s*([^;]+);/);
  if (!decl) return;
  const value = decl[1];
  if (/var\(--speed\)/.test(value)) return;
  const anim = value.match(/^([a-z-]+)\s+([0-9.]+m?s)/);
  if (anim) {
    const allowed = ALLOWED_ANIMATION[anim[1]];
    if (allowed && allowed.includes(anim[2])) return;
    report(
      STYLE,
      line,
      `未登记的动画 ${anim[1]} ${anim[2]}`,
      "具名动画与时长必须在 docs/设计系统.md 3.4 登记，并在本脚本 ALLOWED_ANIMATION 里补一项",
    );
    return;
  }
  if (/[0-9.]+m?s/.test(value)) {
    report(STYLE, line, `动效时长字面量 ${value.trim()}`, "transition 统一用 var(--speed)，或改用已登记的具名动画");
  }
});

// 6 脚本内联样式不得硬编码颜色（颜色只能来自 CSS 令牌）
for (const file of walk(join(ROOT, "src"))) {
  if (file.endsWith(".css")) continue;
  readFileSync(file, "utf8")
    .split(NL)
    .forEach((text, index) => {
      const hit = text.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\(/);
      if (hit) report(file, index + 1, `脚本内联裸色值 ${hit[0]}`, "颜色只能来自 CSS 令牌，脚本里用 class 切换");
    });
}

// 7 引用了但没定义的令牌
const defined = new Set();
for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
for (const file of walk(join(ROOT, "src"))) {
  readFileSync(file, "utf8")
    .split(NL)
    .forEach((text, index) => {
      for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!defined.has(m[1]))
          report(file, index + 1, `引用了未定义的令牌 ${m[1]}`, "在 src/style.css 的 :root 与两个暗色块里补齐");
      }
    });
}

// 8 颜色令牌必须三处成对（:root / dark / auto-dark）；字号、圆角等静态令牌不受此限
function blockAfter(needle) {
  const start = css.indexOf(needle);
  if (start < 0) return { found: false, body: "" };
  const open = css.indexOf("{", start);
  const close = css.indexOf(NL + "}", open);
  return { found: true, body: css.slice(open, close) };
}
const colorTokens = [...tokenBlock.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)]
  .map((m) => m[1])
  .filter((name) => !/^--(fs-|radius|sans|mono|speed|shadow-|ring)/.test(name));
for (const theme of ['html[data-theme="dark"]', "@media (prefers-color-scheme: dark)"]) {
  const block = blockAfter(theme);
  if (!block.found) {
    report(STYLE, 1, `缺少主题块 ${theme}`, "亮色/暗色必须成对定义");
    continue;
  }
  for (const name of colorTokens) {
    if (!new RegExp(String.raw`${name}\s*:`).test(block.body)) {
      report(STYLE, 1, `令牌 ${name} 在 ${theme} 里缺失`, "颜色令牌必须在三处成对定义");
    }
  }
}

if (problems.length === 0) {
  console.log("✓ 设计系统检查通过：裸色值 / 裸字号 / 裸圆角 / 裸阴影 0 处，令牌引用全部有定义，动画全部已登记");
  process.exit(0);
}

console.error(`✗ 设计系统检查发现 ${problems.length} 处违例（规范见 docs/设计系统.md）：`);
for (const line of problems) console.error("  " + line);
process.exit(1);
