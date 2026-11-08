// 脚本相关数据的形状校正与旧数据迁移。
//
// 库里的脚本（LibraryScript）与各处的前置 / 后置操作（ScriptSteps）都要从这里过一遍：
// 数据库里存的是 JSON，备份文件、导入的集合也可能是老版本写的，读进来一律先校正再用。

import type { LibraryScript, ScriptPhase, ScriptStep, ScriptStepKind, ScriptSteps } from "./types";
import { uid } from "./util";

const KINDS: ScriptStepKind[] = ["script", "library", "wait"];

export function emptySteps(): ScriptSteps {
  return { pre: [], post: [] };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 一步操作的形状校正；kind 不认识的步骤直接丢弃（返回 null）。 */
export function normalizeStep(raw: unknown): ScriptStep | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const kind = KINDS.includes(item.kind as ScriptStepKind) ? (item.kind as ScriptStepKind) : null;
  if (!kind) return null;
  const step: ScriptStep = {
    id: text(item.id) || uid("step"),
    kind,
    enabled: flag(item.enabled, true),
  };
  if (kind === "script") step.source = text(item.source);
  if (kind === "library") step.libraryId = text(item.libraryId);
  if (kind === "wait") step.ms = typeof item.ms === "number" && item.ms >= 0 ? Math.floor(item.ms) : 0;
  const note = text(item.note);
  if (note) step.note = note;
  return step;
}

function stepList(raw: unknown): ScriptStep[] {
  if (!Array.isArray(raw)) return [];
  const list: ScriptStep[] = [];
  for (const item of raw) {
    const step = normalizeStep(item);
    if (step) list.push(step);
  }
  return list;
}

/** 两串操作列表的形状校正；缺字段按空处理。 */
export function normalizeSteps(raw: unknown): ScriptSteps {
  if (!raw || typeof raw !== "object") return emptySteps();
  const data = raw as Record<string, unknown>;
  return { pre: stepList(data.pre), post: stepList(data.post) };
}

/** 脚本库的形状校正：没有名字或源码的条目丢掉。 */
export function normalizeScriptLibrary(raw: unknown): LibraryScript[] {
  if (!Array.isArray(raw)) return [];
  const list: LibraryScript[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const source = text(entry.source);
    const name = text(entry.name);
    if (!source.trim() && !name.trim()) continue;
    list.push({
      id: text(entry.id) || uid("lib"),
      name: name.trim() || "未命名脚本",
      description: text(entry.description),
      source,
      trusted: flag(entry.trusted, true),
    });
  }
  return list;
}

// ---- 旧数据（0.2.x 及更早）----
// 旧模型：一个全局有序的脚本列表，每条自带阶段（pre/post）与作用范围（global/collection/request）。
// 新模型把"内容"和"挂在哪一层"拆开，所以迁移时每条旧脚本变成一个库脚本 + 一个引用它的步骤。

export interface LegacyScriptEntry {
  id: string;
  name: string;
  phase: ScriptPhase;
  scope: "global" | "collection" | "request";
  scopeId?: string;
  source: string;
  enabled: boolean;
  trusted: boolean;
}

export function parseLegacyScripts(raw: string | undefined): LegacyScriptEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const list: LegacyScriptEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const phase: ScriptPhase = entry.phase === "post" ? "post" : "pre";
    const scope =
      entry.scope === "collection" ? "collection" : entry.scope === "request" ? "request" : "global";
    list.push({
      id: text(entry.id) || uid("script"),
      name: text(entry.name) || "未命名脚本",
      phase,
      scope,
      scopeId: text(entry.scopeId) || undefined,
      source: text(entry.source),
      enabled: flag(entry.enabled, true),
      trusted: flag(entry.trusted, true),
    });
  }
  return list;
}

export interface LegacySplit {
  library: LibraryScript[];
  global: ScriptSteps;
  /** 集合 id → 该集合上的操作 */
  collections: Map<string, ScriptSteps>;
  /** 请求节点 id → 该请求上的操作 */
  requests: Map<string, ScriptSteps>;
}

function pushStep(steps: ScriptSteps, phase: ScriptPhase, step: ScriptStep): void {
  steps[phase].push(step);
}

/**
 * 旧脚本按作用范围拆到各层。scopeId 指向已经不存在的集合 / 请求时退回全局，
 * 免得用户的脚本在迁移里凭空消失。
 */
export function splitLegacyScripts(
  entries: LegacyScriptEntry[],
  known: { collections: Set<string>; requests: Set<string> },
): LegacySplit {
  const split: LegacySplit = {
    library: [],
    global: emptySteps(),
    collections: new Map(),
    requests: new Map(),
  };
  const layer = (map: Map<string, ScriptSteps>, id: string): ScriptSteps => {
    let steps = map.get(id);
    if (!steps) {
      steps = emptySteps();
      map.set(id, steps);
    }
    return steps;
  };
  for (const entry of entries) {
    const lib: LibraryScript = {
      id: uid("lib"),
      name: entry.name.trim() || "未命名脚本",
      description: "",
      source: entry.source,
      trusted: entry.trusted,
    };
    split.library.push(lib);
    const step: ScriptStep = {
      id: uid("step"),
      kind: "library",
      enabled: entry.enabled,
      libraryId: lib.id,
    };
    if (entry.scope === "collection" && entry.scopeId && known.collections.has(entry.scopeId)) {
      pushStep(layer(split.collections, entry.scopeId), entry.phase, step);
    } else if (entry.scope === "request" && entry.scopeId && known.requests.has(entry.scopeId)) {
      pushStep(layer(split.requests, entry.scopeId), entry.phase, step);
    } else {
      pushStep(split.global, entry.phase, step);
    }
  }
  return split;
}

/** 把两串步骤拼成一段源码（导出到 Postman / HAR 时用）：等待步骤跳过。 */
export function stepsSource(
  steps: ScriptStep[],
  sourceOf: (step: ScriptStep) => string | undefined,
): string {
  const parts: string[] = [];
  for (const step of steps) {
    if (!step.enabled) continue;
    const source = sourceOf(step);
    if (source && source.trim()) parts.push(source);
  }
  return parts.join("\n\n");
}
