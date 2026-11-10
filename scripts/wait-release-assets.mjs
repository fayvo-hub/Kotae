#!/usr/bin/env node
// 发布后核对 Release 资产：轮询 expanded_assets 页面，三个产物出齐就停，
// 不用再按固定时长等流水线。口径见 .agents/skills/mygo-release/SKILL.md 第 6 步。
//
// 用法：node scripts/wait-release-assets.mjs v0.2.6 [--timeout=600] [--interval=15] [--proxy=http://127.0.0.1:7897]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CONFIG = join(ROOT, "mygo.config.ts");

const args = process.argv.slice(2);
const flag = (key, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : fallback;
};
const tag = args.find((a) => !a.startsWith("--"));
const timeoutMs = Number(flag("timeout", "600")) * 1000;
const intervalMs = Number(flag("interval", "15")) * 1000;

if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("✗ 用法：node scripts/wait-release-assets.mjs v0.2.6 [--timeout=600] [--interval=15] [--proxy=URL]");
  process.exit(1);
}

const config = readFileSync(CONFIG, "utf8");
const pick = (pattern, label) => {
  const m = config.match(pattern);
  if (!m) throw new Error(`mygo.config.ts 里读不到 ${label}，配置格式变了就更新本脚本`);
  return m[1];
};
const slug = pick(/^\s*slug:\s*"([^"]+)",/m, "slug");
const version = pick(/^\s*version:\s*"([^"]+)",/m, "version");
const github = pick(/^\s*github:\s*"([^"]+)",/m, "updates.github");

// 产物名来自 mygo.config.ts 的 version，tag 只决定 Release 名字：两者不一致必然 404。
if (tag.slice(1) !== version) {
  console.error(`✗ tag ${tag} 与 mygo.config.ts 的 version ${version} 不一致：产物名会带 ${version}，先对齐版本号`);
  process.exit(1);
}

const expected = [
  { label: "NSIS 安装包", re: new RegExp(`^${slug}-setup-${version.replace(/\./g, "\\.")}-.*\\.exe$`) },
  { label: "免安装 exe", re: new RegExp(`^${slug}-${version.replace(/\./g, "\\.")}-portable\\.exe$`) },
  { label: "macOS dmg", re: new RegExp(`^${slug}-${version.replace(/\./g, "\\.")}\\.dmg$`) },
];

// 代理优先取参数，其次环境变量，最后沿用 git 已配的 http.proxy（本机直连 github 会超时）。
const gitProxy = () => {
  try {
    return execFileSync("git", ["config", "--get", "http.proxy"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const proxy = flag("proxy", "") || process.env.RELEASE_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || gitProxy();

const url = `https://github.com/${github}/releases/expanded_assets/${tag}`;

function fetchAssets() {
  const curl = ["-sS", "--max-time", "30"];
  if (proxy) curl.push("--proxy", proxy);
  curl.push(url);
  const html = execFileSync("curl", curl, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return [...html.matchAll(/href="([^"]*\/releases\/download\/[^"]*)"/g)]
    .map((m) => decodeURIComponent(m[1].split("/").pop() ?? ""))
    .filter(Boolean);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + timeoutMs;

let attempt = 0;
for (;;) {
  attempt += 1;
  let names = [];
  let failure = "";
  try {
    names = fetchAssets();
  } catch (err) {
    failure = err instanceof Error ? err.message.split("\n")[0] : String(err);
  }

  const found = expected.filter((e) => names.some((n) => e.re.test(n)));
  const missing = expected.filter((e) => !names.some((n) => e.re.test(n)));

  if (missing.length === 0) {
    console.log(`✓ ${tag} 的三个资产已出齐（第 ${attempt} 次抓取）：`);
    for (const e of expected) console.log(`  ${names.find((n) => e.re.test(n))}  ${e.label}`);
    process.exit(0);
  }

  if (Date.now() >= deadline) {
    console.error(`✗ 等了 ${Math.round(timeoutMs / 1000)}s 资产没出齐（第 ${attempt} 次抓取）：`);
    for (const e of missing) console.error(`  缺 ${e.label}`);
    if (names.length > 0) console.error(`  已有：${names.join("、")}`);
    if (failure) console.error(`  最近一次抓取失败：${failure}`);
    console.error(`  去 https://github.com/${github}/actions 看是哪个平台的 job 红了`);
    process.exit(1);
  }

  const note = failure ? `（抓取失败：${failure}）` : "";
  console.log(`· 第 ${attempt} 次：已出 ${found.length}/3，缺 ${missing.map((e) => e.label).join("、")}${note}，${intervalMs / 1000}s 后重试`);
  await sleep(intervalMs);
}
