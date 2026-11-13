#!/usr/bin/env node
// 发版前对齐版本号：mygo.config.ts 的 version 是唯一真源，这里把仓库里手写的副本
// 一次改完，并检查两件容易漏的事——CHANGELOG 有对应段落、没有残留的旧版本号。
// 用法与手工清单见 .agents/skills/mygo-release/SKILL.md 第 1 步。

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const CONFIG = join(ROOT, "mygo.config.ts");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

// 旧版本号允许保留的地方：CHANGELOG 记的是历史，调研文档是发布期的归档快照。
const SKIP_FILES = new Set(["package-lock.json", "CHANGELOG.md", "docs/mygo-调研与功能清单.md"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "build-local", ".git", "artifacts"]);
const SCAN_EXT = /\.(ts|go|json|md|mjs|yml|yaml|css|html)$/;

const args = process.argv.slice(2);
const next = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error("✗ 用法：node scripts/bump-version.mjs <新版本> [--dry-run]，版本形如 1.2.3");
  process.exit(1);
}

const config = readFileSync(CONFIG, "utf8");
const pick = (pattern, label) => {
  const m = config.match(pattern);
  if (!m) throw new Error(`mygo.config.ts 里读不到 ${label}，配置格式变了就更新本脚本`);
  return m[1];
};
const name = pick(/^\s*name:\s*"([^"]+)",/m, "name");
const slug = pick(/^\s*slug:\s*"([^"]+)",/m, "slug");
const current = pick(/^\s*version:\s*"([^"]+)",/m, "version");

// 每一处都是精确文本：格式一变就报「未匹配」，不会静默跳过。
const edits = [
  { file: "mygo.config.ts", from: `version: "${current}"`, to: `version: "${next}"` },
  { file: "mygo.config.ts", from: `与本仓库的 v${current} 这类标签一致`, to: `与本仓库的 v${next} 这类标签一致` },
  { file: "mygo.config.ts", from: "`## " + current + "` 那一段", to: "`## " + next + "` 那一段" },
  { file: "README.md", from: `${slug}-setup-${current}-amd64.exe`, to: `${slug}-setup-${next}-amd64.exe` },
  { file: "docs/设计系统.md", from: `# 设计系统 —— ${name} ${current}`, to: `# 设计系统 —— ${name} ${next}` },
  { file: "AGENTS.md", from: `已发 ${current}。`, to: `已发 ${next}。` },
];

const problems = [];
const byFile = new Map();
for (const edit of edits) {
  if (!byFile.has(edit.file)) byFile.set(edit.file, []);
  byFile.get(edit.file).push(edit);
}

const writes = [];
const summary = [];
for (const [file, list] of byFile) {
  const full = join(ROOT, file);
  let text = readFileSync(full, "utf8");
  let changed = 0;
  for (const edit of list) {
    const count = text.split(edit.from).length - 1;
    if (count !== 1) {
      problems.push(`${file} 待替换文本出现 ${count} 次（应为 1 次）：${edit.from}`);
      continue;
    }
    text = text.replace(edit.from, edit.to);
    changed += 1;
  }
  if (changed > 0) writes.push({ full, text });
  summary.push({ file, changed });
}

// CHANGELOG 必须先有这一段：mygo build 从 `## <version>` 里取发布说明，缺了打包会失败。
const changelog = readFileSync(CHANGELOG, "utf8");
if (!new RegExp(`^## ${next.replace(/\./g, "\\.")}\\s*$`, "m").test(changelog)) {
  problems.push(`CHANGELOG.md 缺少「## ${next}」段落（打包要读它当发布说明，先写更新日志）`);
}

const norm = (p) => p.split("\\").join("/");
const pending = new Set([...byFile.keys()].map(norm));
const sameVersion = current === next;

const fail = (list) => {
  console.error(`✗ 版本 ${next} 对齐存在问题（${list.length} 条）：`);
  for (const line of list) console.error("  " + line);
  process.exit(1);
};

// 文本没匹配上、或 CHANGELOG 缺段时一律不写盘：先拦下来，别改一半才发现写不了发布说明。
if (problems.length > 0) fail(problems);

if (sameVersion) {
  console.log(`· 版本已经是 ${next}，不写盘`);
} else if (dryRun) {
  for (const { file, changed } of summary) console.log(`· ${file} 将改 ${changed} 处`);
  console.log(`· 版本 ${current} → ${next}（--dry-run，未写盘）`);
} else {
  for (const { full, text } of writes) writeFileSync(full, text);
  for (const { file, changed } of summary) if (changed > 0) console.log(`✓ ${file} 改了 ${changed} 处`);
}

// 写盘之后再扫残留：改完还留着旧版本号的地方就是漏改（dry-run 时扫现状，排除待改文件）。
const leftovers = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (SKIP_DIRS.has(entry)) continue;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }
    if (!SCAN_EXT.test(entry) || SKIP_FILES.has(norm(rel))) continue;
    if (dryRun && pending.has(norm(rel))) continue;
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (text.includes(current)) leftovers.push(rel);
  }
};
walk(ROOT);

if (leftovers.length > 0) {
  fail([`以下文件仍含旧版本号 ${current}（确认是否需要改）：${leftovers.join("、")}`]);
}

console.log(`✓ 版本 ${next} 对齐完成，CHANGELOG 有对应段落，没有漏改的旧版本号`);
