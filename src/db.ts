// 持久化层：所有要留下来的东西都写进 userData 目录下的 SQLite 库 workspace.db。
//
// 表结构按业务实体拆分（集合树、历史、环境、变量、标签页、设置），请求本身的
// 字段较多且整体读写，用 request 列存 ApiRequest 的 JSON；其余字段都单独成列，
// 方便直接用 SQL 查看与统计。
//
// 写入是「增量 + 事务」：把当前内存快照展开成行，和上次写成功的行比较，
// 只提交变化的 INSERT/UPDATE/DELETE，整批放在一个事务里，失败整批回滚。

import { open, type Database, type Statement } from "@mygo-plugins/sqlite";
import { System } from "./mygo";
import type {
  Collection,
  Env,
  FolderNode,
  HistoryEntry,
  KV,
  LibraryScript,
  PersistedTab,
  PersistedWorkspace,
  RequestNode,
  ScriptSteps,
  ThemeMode,
  TreeNode,
} from "./types";
import {
  emptySteps,
  normalizeScriptLibrary,
  normalizeSteps,
  parseLegacyScripts,
  splitLegacyScripts,
} from "./scriptData";

/** 数据库文件名。SQLite 插件只接受文件名，实际落在 userData 目录。 */
const DB_FILE = "workspace.db";

/** 表结构版本。2：脚本从「一个全局有序列表」改成「脚本库 + 各层的前置/后置操作」。 */
const SCHEMA_VERSION = 2;

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS collections (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     position   INTEGER NOT NULL,
     settings   TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS folders (
     id            TEXT PRIMARY KEY,
     collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
     parent_id     TEXT,
     name          TEXT NOT NULL,
     position      INTEGER NOT NULL,
     open          INTEGER NOT NULL DEFAULT 1,
     settings      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS folders_parent ON folders (collection_id, parent_id, position)`,
  `CREATE TABLE IF NOT EXISTS requests (
     id            TEXT PRIMARY KEY,
     collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
     folder_id     TEXT,
     name          TEXT NOT NULL,
     position      INTEGER NOT NULL,
     method        TEXT NOT NULL,
     url           TEXT NOT NULL,
     body_mode     TEXT NOT NULL,
     request       TEXT NOT NULL,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS requests_parent ON requests (collection_id, folder_id, position)`,
  `CREATE TABLE IF NOT EXISTS history (
     id          TEXT PRIMARY KEY,
     at          INTEGER NOT NULL,
     method      TEXT NOT NULL,
     url         TEXT NOT NULL,
     status      INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     request     TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS history_at ON history (at DESC)`,
  `CREATE TABLE IF NOT EXISTS environments (
     id       TEXT PRIMARY KEY,
     name     TEXT NOT NULL,
     position INTEGER NOT NULL,
     active   INTEGER NOT NULL DEFAULT 0,
     settings TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS variables (
     id       TEXT PRIMARY KEY,
     scope    TEXT NOT NULL,
     key_name TEXT NOT NULL,
     value    TEXT NOT NULL,
     enabled  INTEGER NOT NULL DEFAULT 1,
     position INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS variables_scope ON variables (scope, position)`,
  `CREATE TABLE IF NOT EXISTS tabs (
     id       TEXT PRIMARY KEY,
     name     TEXT NOT NULL,
     request  TEXT NOT NULL,
     dirty    INTEGER NOT NULL DEFAULT 0,
     origin   TEXT,
     position INTEGER NOT NULL,
     active   INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

let conn: Database | null = null;

/** 上次成功写入的行签名（table:id → 内容指纹），用来做增量写入。 */
let written = new Map<string, string>();

/** 打开数据库（只打开一次）并建表。 */
async function connect(): Promise<Database> {
  if (conn) return conn;
  const db = await open(DB_FILE);
  // WAL 让读写不互相阻塞；外键打开后删集合会连带删掉它的文件夹与请求。
  await db.query("PRAGMA journal_mode = WAL");
  await db.execute("PRAGMA foreign_keys = ON");
  await db.execute("PRAGMA busy_timeout = 5000");
  for (const sql of SCHEMA) await db.execute(sql);
  // 老库没有共享设置列（集合 / 文件夹的认证与变量），补上即可，不需要迁移数据。
  await ensureColumn(db, "collections", "settings", "TEXT");
  await ensureColumn(db, "folders", "settings", "TEXT");
  // 环境同理：公共查询参数与公共请求头都是后加的字段，老库补列即可，不需要迁移。
  await ensureColumn(db, "environments", "settings", "TEXT");
  conn = db;
  return db;
}

/** 集合 / 文件夹的共享设置只写有内容的字段，空值不占库。 */
function sharedJSON(node: { auth?: { type: string }; vars?: KV[]; scripts?: ScriptSteps }): string | null {
  const out: { auth?: unknown; vars?: KV[]; scripts?: ScriptSteps } = {};
  if (node.auth && node.auth.type !== "none") out.auth = node.auth;
  if (node.vars && node.vars.length > 0) out.vars = node.vars;
  const scripts = node.scripts;
  if (scripts && (scripts.pre.length > 0 || scripts.post.length > 0)) out.scripts = scripts;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** 读回共享设置：没有设置时保持字段缺失，让「继承」逻辑按缺省处理。 */
function applyShared(
  node: { auth?: unknown; vars?: KV[]; scripts?: ScriptSteps },
  raw: string,
): void {
  if (!raw) return;
  let parsed: { auth?: unknown; vars?: KV[]; scripts?: unknown };
  try {
    parsed = JSON.parse(raw) as { auth?: unknown; vars?: KV[]; scripts?: unknown };
  } catch {
    return;
  }
  const auth = parsed.auth as { type?: string } | undefined;
  if (auth && auth.type && auth.type !== "none") node.auth = auth;
  if (Array.isArray(parsed.vars) && parsed.vars.length > 0) node.vars = parsed.vars;
  const steps = normalizeSteps(parsed.scripts);
  if (steps.pre.length > 0 || steps.post.length > 0) node.scripts = steps;
}

/**
 * 环境级的公共参数：只写有内容的字段，空值整列留 null。
 * 读回来也按「没有就当空」处理，让发送侧不用到处判空。
 */
function commonJSON(env: Env): string | null {
  const out: { commonParams?: KV[]; commonHeaders?: KV[] } = {};
  if (env.commonParams && env.commonParams.length > 0) out.commonParams = env.commonParams;
  if (env.commonHeaders && env.commonHeaders.length > 0) out.commonHeaders = env.commonHeaders;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** 读回公共参数；坏值当没有，不猜。 */
function applyCommon(env: Env, raw: string): void {
  if (!raw) return;
  let parsed: { commonParams?: unknown; commonHeaders?: unknown };
  try {
    parsed = JSON.parse(raw) as { commonParams?: unknown; commonHeaders?: unknown };
  } catch {
    return;
  }
  if (Array.isArray(parsed.commonParams) && parsed.commonParams.length > 0) {
    env.commonParams = parsed.commonParams as KV[];
  }
  if (Array.isArray(parsed.commonHeaders) && parsed.commonHeaders.length > 0) {
    env.commonHeaders = parsed.commonHeaders as KV[];
  }
}

/** 设置表的写入语句，迁移与正常保存共用。 */
const SETTING_SQL = `INSERT INTO settings(key, value) VALUES(?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/** 脚本库写成一行 JSON；步骤组合同理，空值也存空壳，读回来不用猜。 */
function scriptsJSON(value: unknown): string {
  return JSON.stringify(value);
}

/** 表里没有这一列就补一列：SQLite 没有 `ADD COLUMN IF NOT EXISTS`。 */
async function ensureColumn(db: Database, table: string, column: string, type: string): Promise<void> {
  const info = await db.query(`PRAGMA table_info(${table})`);
  const has = info.rows.some((row) => text(row[1]) === column);
  if (!has) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** 数据库文件的绝对路径，设置面板里展示用。 */
export function databaseFile(): string {
  return DB_FILE;
}

/**
 * 打开数据库并把旧版的 JSON 工作区导入进来。
 * `imported` 是首次迁移得到的快照（没有可迁移内容时为 null），
 * `legacyBroken` 表示旧文件存在但不是合法 JSON（已改名备份，跳过）。
 */
export interface Migration {
  imported: PersistedWorkspace | null;
  legacyBroken: boolean;
}

export async function init(): Promise<Migration> {
  const db = await connect();
  const done = await db.query("SELECT value FROM meta WHERE key = 'schema_version'");
  if (done.rows.length > 0) {
    const version = int(done.rows[0] ? text(done.rows[0][0]) : "0", 1);
    if (version < SCHEMA_VERSION) await migrate(db, version);
    return { imported: null, legacyBroken: false };
  }

  let legacy = "";
  try {
    legacy = await System.takeLegacyState();
  } catch (err) {
    // 读旧文件失败不影响新库启动，原文件仍留在 userData 目录。
    console.warn("读取旧的工作区文件失败", err);
  }

  let imported: PersistedWorkspace | null = null;
  let legacyBroken = false;
  if (legacy.trim()) {
    try {
      imported = normalize(JSON.parse(legacy) as Partial<PersistedWorkspace>);
      await save(imported);
    } catch {
      imported = null;
      legacyBroken = true;
    }
  }
  await db.execute("INSERT INTO meta(key, value) VALUES('schema_version', ?)", [String(SCHEMA_VERSION)]);
  return { imported, legacyBroken };
}

/** 按库里的版本号往上升，每步做完才写新版本号。 */
async function migrate(db: Database, from: number): Promise<void> {
  if (from < 2) await migrateScriptsToLayers(db);
  await db.execute("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)]);
}

/**
 * v1 → v2：旧的「全局有序脚本列表」拆成脚本库 + 各层的前置/后置操作。
 * 每条旧脚本变成一个库脚本加一个引用它的步骤，作用范围跟着搬过去；
 * 集合 / 请求已经不存在的退回全局，不让脚本在迁移里凭空消失。
 */
async function migrateScriptsToLayers(db: Database): Promise<void> {
  const stored = await db.query("SELECT value FROM settings WHERE key = 'scripts'");
  const legacy = parseLegacyScripts(stored.rows.length ? text(stored.rows[0]![0]) : undefined);

  const collections = new Set<string>();
  for (const row of (await db.query("SELECT id FROM collections")).rows) collections.add(text(row[0]));
  const requestJSON = new Map<string, string>();
  for (const row of (await db.query("SELECT id, request FROM requests")).rows) {
    requestJSON.set(text(row[0]), text(row[1]));
  }
  const collectionSettings = new Map<string, string>();
  for (const row of (await db.query("SELECT id, settings FROM collections")).rows) {
    collectionSettings.set(text(row[0]), text(row[1]));
  }

  const split = splitLegacyScripts(legacy, {
    collections,
    requests: new Set(requestJSON.keys()),
  });
  const statements: Statement[] = [];
  for (const [id, steps] of split.collections) {
    const merged = mergeSharedScripts(collectionSettings.get(id) ?? "", steps);
    statements.push({ sql: "UPDATE collections SET settings = ? WHERE id = ?", params: [merged, id] });
  }
  for (const [id, steps] of split.requests) {
    const request = (parseRaw(requestJSON.get(id)) ?? {}) as Record<string, unknown>;
    request.scripts = steps;
    statements.push({
      sql: "UPDATE requests SET request = ? WHERE id = ?",
      params: [JSON.stringify(request), id],
    });
  }
  if (legacy.length > 0) {
    statements.push({ sql: SETTING_SQL, params: ["scriptLibrary", scriptsJSON(split.library)] });
    statements.push({ sql: SETTING_SQL, params: ["globalScripts", scriptsJSON(split.global)] });
  }
  // 旧的列表行必须删，不然后续保存不会再写它，它会一直留在库里。
  statements.push({ sql: "DELETE FROM settings WHERE key = 'scripts'", params: [] });
  await db.transaction(statements);
}

/** 把升级得到的操作合并进已有的共享设置 JSON。 */
function mergeSharedScripts(raw: string, steps: ScriptSteps): string {
  const shared = (parseRaw(raw) ?? {}) as Record<string, unknown>;
  shared.scripts = steps;
  return JSON.stringify(shared);
}

/** 读回整个工作区。 */
export async function load(): Promise<PersistedWorkspace> {
  const db = await connect();
  const settings = new Map<string, string>();
  for (const row of (await db.query("SELECT key, value FROM settings")).rows) {
    settings.set(text(row[0]), text(row[1]));
  }

  const collections: Collection[] = [];
  const collectionRows = await db.query("SELECT id, name, settings FROM collections ORDER BY position");
  const folderRows = await db.query(
    "SELECT id, collection_id, parent_id, name, position, open, settings FROM folders ORDER BY position",
  );
  const requestRows = await db.query(
    "SELECT id, collection_id, folder_id, name, position, request FROM requests ORDER BY position",
  );

  // 文件夹与请求在同一层里共用一个 position 序号空间，这里按 position 归并回去。
  const foldersByParent = new Map<string, Placed<FolderNode>[]>();
  for (const row of folderRows.rows) {
    const node: FolderNode = {
      id: text(row[0]),
      type: "folder",
      name: text(row[3]),
      open: num(row[5]) !== 0,
      items: [],
    };
    applyShared(node, text(row[6]));
    push(foldersByParent, `${text(row[1])}\u0000${text(row[2])}`, { pos: num(row[4]), node });
  }
  const requestsByParent = new Map<string, Placed<RequestNode>[]>();
  for (const row of requestRows.rows) {
    const node: RequestNode = {
      id: text(row[0]),
      type: "request",
      name: text(row[3]),
      request: parseJSON(text(row[5])) as RequestNode["request"],
    };
    push(requestsByParent, `${text(row[1])}\u0000${text(row[2])}`, { pos: num(row[4]), node });
  }

  for (const row of collectionRows.rows) {
    const id = text(row[0]);
    const collection: Collection = {
      id,
      name: text(row[1]),
      items: childrenOf(id, "", foldersByParent, requestsByParent),
    };
    applyShared(collection, text(row[2]));
    collections.push(collection);
  }

  const history: HistoryEntry[] = [];
  for (const row of (await db.query(
    "SELECT id, at, method, url, status, duration_ms, request FROM history ORDER BY at DESC",
  )).rows) {
    history.push({
      id: text(row[0]),
      at: num(row[1]),
      method: text(row[2]),
      url: text(row[3]),
      status: num(row[4]),
      durationMs: num(row[5]),
      request: parseJSON(text(row[6])) as HistoryEntry["request"],
    });
  }

  const envs: Env[] = [];
  for (const row of (await db.query("SELECT id, name, settings FROM environments ORDER BY position")).rows) {
    const env: Env = { id: text(row[0]), name: text(row[1]), vars: [] };
    applyCommon(env, text(row[2]));
    envs.push(env);
  }
  const envById = new Map(envs.map((e) => [e.id, e]));
  const globals: KV[] = [];
  for (const row of (await db.query(
    "SELECT id, scope, key_name, value, enabled FROM variables ORDER BY scope, position",
  )).rows) {
    const kv: KV = { id: text(row[0]), key: text(row[2]), value: text(row[3]), enabled: num(row[4]) !== 0 };
    const scope = text(row[1]);
    if (scope === "global") {
      globals.push(kv);
      continue;
    }
    envById.get(scope.slice(4))?.vars.push(kv);
  }

  const tabs: PersistedTab[] = [];
  for (const row of (await db.query(
    "SELECT id, name, request, dirty, origin FROM tabs ORDER BY position",
  )).rows) {
    const origin = text(row[4]);
    tabs.push({
      id: text(row[0]),
      name: text(row[1]),
      request: parseJSON(text(row[2])) as PersistedTab["request"],
      dirty: num(row[3]) !== 0,
      ...(origin ? { origin: parseJSON(origin) as PersistedTab["origin"] } : {}),
    } as PersistedTab);
  }

  const activeTab = await db.query("SELECT id FROM tabs WHERE active = 1 LIMIT 1");
  const activeEnv = await db.query("SELECT id FROM environments WHERE active = 1 LIMIT 1");

  const data: PersistedWorkspace = {
    version: SCHEMA_VERSION,
    collections,
    history,
    envs,
    activeEnvId: activeEnv.rows.length ? text(activeEnv.rows[0]![0]) : "",
    globals,
    scriptLibrary: normalizeScriptLibrary(parseRaw(settings.get("scriptLibrary"))),
    globalScripts: normalizeSteps(parseRaw(settings.get("globalScripts"))),
    tabs,
    activeTabId: activeTab.rows.length ? text(activeTab.rows[0]![0]) : null,
    theme: themeMode(settings.get("theme")),
    sidebarWidth: int(settings.get("sidebarWidth"), 288),
    responseHeight: int(settings.get("responseHeight"), 340),
    sidebarTab: settings.get("sidebarTab") === "history" ? "history" : "collections",
    sidebarCollapsed: settings.get("sidebarCollapsed") === "1",
    onboardingDone: settings.get("onboardingDone") === "1",
    closeToTray: settings.get("closeToTray") !== "0",
    globalShortcut: settings.get("globalShortcut") !== "0",
    directConnection: settings.get("directConnection") === "1",
    zoom: float(settings.get("zoom"), 1),
    codeFontSize: int(settings.get("codeFontSize"), 12),
    shortcuts: parseShortcuts(settings.get("shortcuts")),
  };
  // 刚读出来的内容就是库里的内容，先认账，第一次保存才不会把全部行重写一遍。
  written = new Map(rows(data).map((row) => [`${row.table}:${row.id}`, row.signature]));
  return data;
}

/** 保存整个工作区：只提交变化的行，整批放在一个事务里。 */
export async function save(data: PersistedWorkspace): Promise<void> {
  const db = await connect();
  const next = rows(data);
  const previous = written;
  const statements: Statement[] = [];
  const kept = new Set<string>();

  for (const row of next) {
    const key = `${row.table}:${row.id}`;
    kept.add(key);
    if (previous.get(key) === row.signature) continue;
    statements.push({ sql: row.sql, params: row.params });
  }
  // 剩下的 key 这次没出现，说明对应的行被删掉了（或历史被裁剪）。
  for (const key of previous.keys()) {
    if (kept.has(key)) continue;
    const cut = key.indexOf(":");
    statements.push({ sql: `DELETE FROM ${key.slice(0, cut)} WHERE id = ?`, params: [key.slice(cut + 1)] });
  }
  if (statements.length === 0) return;

  try {
    await db.transaction(statements);
  } catch (err) {
    // 写入失败时不更新签名，下一次保存会重新尝试整批差异。
    throw err;
  }
  written = new Map(next.map((row) => [`${row.table}:${row.id}`, row.signature]));
}

// ---- 行展开 ----

interface Row {
  table: string;
  id: string;
  /** 内容指纹：不含时间戳，内容没变就不重写这一行。 */
  signature: string;
  sql: string;
  params: (string | number | null)[];
}

function rows(data: PersistedWorkspace): Row[] {
  const out: Row[] = [];
  const now = Date.now();

  for (const [ci, collection] of data.collections.entries()) {
    out.push({
      table: "collections",
      id: collection.id,
      signature: JSON.stringify([
        collection.name,
        ci,
        collection.auth ?? null,
        collection.vars ?? null,
        collection.scripts ?? null,
      ]),
      sql: `INSERT INTO collections(id, name, position, settings, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, position = excluded.position,
              settings = excluded.settings, updated_at = excluded.updated_at`,
      params: [collection.id, collection.name, ci, sharedJSON(collection), now, now],
    });
    walk(collection.id, collection.items, null, out, now);
  }

  for (const entry of data.history) {
    out.push({
      table: "history",
      id: entry.id,
      signature: JSON.stringify([entry.at, entry.method, entry.url, entry.status, entry.durationMs, entry.request]),
      sql: `INSERT INTO history(id, at, method, url, status, duration_ms, request) VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET at = excluded.at, method = excluded.method, url = excluded.url,
              status = excluded.status, duration_ms = excluded.duration_ms, request = excluded.request`,
      params: [entry.id, entry.at, entry.method, entry.url, entry.status, entry.durationMs, JSON.stringify(entry.request)],
    });
  }

  for (const [i, env] of data.envs.entries()) {
    const settings = commonJSON(env);
    out.push({
      table: "environments",
      id: env.id,
      signature: JSON.stringify([env.name, i, env.id === data.activeEnvId, settings]),
      sql: `INSERT INTO environments(id, name, position, active, settings) VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, position = excluded.position,
              active = excluded.active, settings = excluded.settings`,
      params: [env.id, env.name, i, env.id === data.activeEnvId ? 1 : 0, settings],
    });
    out.push(...variableRows(`env:${env.id}`, env.vars));
  }
  out.push(...variableRows("global", data.globals));

  for (const [i, tab] of data.tabs.entries()) {
    out.push({
      table: "tabs",
      id: tab.id,
      signature: JSON.stringify([tab.name, tab.request, tab.dirty, tab.origin ?? null, i, tab.id === data.activeTabId]),
      sql: `INSERT INTO tabs(id, name, request, dirty, origin, position, active) VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, request = excluded.request, dirty = excluded.dirty,
              origin = excluded.origin, position = excluded.position, active = excluded.active`,
      params: [
        tab.id,
        tab.name,
        JSON.stringify(tab.request),
        tab.dirty ? 1 : 0,
        tab.origin ? JSON.stringify(tab.origin) : null,
        i,
        tab.id === data.activeTabId ? 1 : 0,
      ],
    });
  }

  const settings: [string, string][] = [
    ["theme", data.theme],
    ["sidebarWidth", String(data.sidebarWidth)],
    ["responseHeight", String(data.responseHeight)],
    ["sidebarTab", data.sidebarTab],
    ["sidebarCollapsed", data.sidebarCollapsed ? "1" : "0"],
    ["onboardingDone", data.onboardingDone ? "1" : "0"],
    ["closeToTray", data.closeToTray ? "1" : "0"],
    ["globalShortcut", data.globalShortcut ? "1" : "0"],
    ["directConnection", data.directConnection ? "1" : "0"],
    ["zoom", String(data.zoom)],
    ["codeFontSize", String(data.codeFontSize)],
    ["shortcuts", JSON.stringify(data.shortcuts ?? {})],
    ["scriptLibrary", scriptsJSON(data.scriptLibrary ?? [])],
    ["globalScripts", scriptsJSON(data.globalScripts ?? emptySteps())],
  ];
  for (const [key, value] of settings) {
    out.push({
      table: "settings",
      id: key,
      signature: value,
      sql: `INSERT INTO settings(key, value) VALUES(?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      params: [key, value],
    });
  }
  return out;
}

/** 递归展开集合树：同一层的文件夹与请求共用一个 position 序号空间。 */
function walk(
  collectionId: string,
  items: TreeNode[],
  parentId: string | null,
  out: Row[],
  now: number,
): void {
  for (const [i, node] of items.entries()) {
    if (node.type === "folder") {
      out.push({
        table: "folders",
        id: node.id,
        signature: JSON.stringify([
          collectionId,
          parentId,
          node.name,
          i,
          node.open,
          node.auth ?? null,
          node.vars ?? null,
          node.scripts ?? null,
        ]),
        sql: `INSERT INTO folders(id, collection_id, parent_id, name, position, open, settings) VALUES(?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET collection_id = excluded.collection_id, parent_id = excluded.parent_id,
                name = excluded.name, position = excluded.position, open = excluded.open,
                settings = excluded.settings`,
        params: [node.id, collectionId, parentId, node.name, i, node.open ? 1 : 0, sharedJSON(node)],
      });
      walk(collectionId, node.items, node.id, out, now);
      continue;
    }
    out.push({
      table: "requests",
      id: node.id,
      signature: JSON.stringify([collectionId, parentId, node.name, i, node.request]),
      sql: `INSERT INTO requests(id, collection_id, folder_id, name, position, method, url, body_mode, request, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET collection_id = excluded.collection_id, folder_id = excluded.folder_id,
              name = excluded.name, position = excluded.position, method = excluded.method, url = excluded.url,
              body_mode = excluded.body_mode, request = excluded.request, updated_at = excluded.updated_at`,
      params: [
        node.id,
        collectionId,
        parentId,
        node.name,
        i,
        node.request.method,
        node.request.url,
        node.request.bodyMode,
        JSON.stringify(node.request),
        now,
        now,
      ],
    });
  }
}

function variableRows(scope: string, vars: KV[]): Row[] {
  return vars.map((kv, i) => ({
    table: "variables",
    id: kv.id,
    signature: JSON.stringify([scope, kv.key, kv.value, kv.enabled, i]),
    sql: `INSERT INTO variables(id, scope, key_name, value, enabled, position) VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, key_name = excluded.key_name,
            value = excluded.value, enabled = excluded.enabled, position = excluded.position`,
    params: [kv.id, scope, kv.key, kv.value, kv.enabled ? 1 : 0, i],
  }));
}

// ---- 读库小工具 ----

interface Placed<T> {
  pos: number;
  node: T;
}

function childrenOf(
  collectionId: string,
  parentId: string,
  folders: Map<string, Placed<FolderNode>[]>,
  requests: Map<string, Placed<RequestNode>[]>,
): TreeNode[] {
  const key = `${collectionId}\u0000${parentId}`;
  const fs = folders.get(key) ?? [];
  const rs = requests.get(key) ?? [];
  const merged: TreeNode[] = [];
  let fi = 0;
  let ri = 0;
  // 文件夹与请求共用一个 position 序号空间，按序号交错还原原始顺序。
  while (fi < fs.length || ri < rs.length) {
    const f = fs[fi];
    const r = rs[ri];
    if (r === undefined || (f !== undefined && f.pos <= r.pos)) {
      merged.push(f!.node);
      fi += 1;
    } else {
      merged.push(r.node);
      ri += 1;
    }
  }
  // 文件夹要递归取它自己的子节点。
  for (const node of merged) {
    if (node.type === "folder") node.items = childrenOf(collectionId, node.id, folders, requests);
  }
  return merged;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 读快捷键覆盖表；坏掉的 JSON 当作没有覆盖，别让设置面板打不开。 */
function parseShortcuts(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 读一个小数设置（界面缩放）。兼容旧库里可能写成的 "1.1"。 */
function float(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 集合树里的全部节点 id，迁移时判断旧脚本的作用范围还存不存在。 */
function nodeIds(collections: Collection[]): { collections: Set<string>; requests: Set<string> } {
  const out = { collections: new Set<string>(), requests: new Set<string>() };
  for (const collection of collections) {
    out.collections.add(collection.id);
    walkRequests(collection.items, (node) => out.requests.add(node.id));
  }
  return out;
}

function walkRequests(items: TreeNode[], visit: (node: RequestNode) => void): void {
  for (const node of items) {
    if (node.type === "folder") walkRequests(node.items, visit);
    else visit(node);
  }
}

/** 迁移得到的一串操作并到已有的后面：已有的是用户在更新的版本里加的，排在后面更安全。 */
function mergeSteps(extra: ScriptSteps, current: ScriptSteps | undefined): ScriptSteps {
  return {
    pre: extra.pre.concat(current?.pre ?? []),
    post: extra.post.concat(current?.post ?? []),
  };
}

/** 坏 JSON 不抛异常，交给调用方按缺省处理。 */
function parseRaw(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parseJSON<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function themeMode(value: string | undefined): ThemeMode {
  return value === "dark" || value === "light" ? value : "auto";
}

/** 把外部 JSON（旧工作区文件、备份）补成完整结构，缺字段按默认值填。 */
function normalize(p: Partial<PersistedWorkspace>): PersistedWorkspace {
  const collections = Array.isArray(p.collections) ? p.collections : [];
  const extra = p as { scripts?: unknown; scriptLibrary?: unknown; globalScripts?: unknown };
  let scriptLibrary = normalizeScriptLibrary(extra.scriptLibrary);
  let globalScripts = normalizeSteps(extra.globalScripts);
  // 0.2.x 及更早的工作区文件里脚本是一个全局有序列表，这里顺手拆成库 + 分层操作。
  const legacy = Array.isArray(extra.scripts) ? parseLegacyScripts(JSON.stringify(extra.scripts)) : [];
  if (legacy.length > 0) {
    const split = splitLegacyScripts(legacy, nodeIds(collections));
    scriptLibrary = scriptLibrary.concat(split.library);
    globalScripts = {
      pre: globalScripts.pre.concat(split.global.pre),
      post: globalScripts.post.concat(split.global.post),
    };
    for (const collection of collections) {
      const own = split.collections.get(collection.id);
      if (own) collection.scripts = mergeSteps(own, collection.scripts);
      walkRequests(collection.items, (node) => {
        const steps = split.requests.get(node.id);
        if (steps) node.request.scripts = mergeSteps(steps, node.request.scripts);
      });
    }
  }
  return {
    version: SCHEMA_VERSION,
    collections,
    history: Array.isArray(p.history) ? p.history : [],
    envs: Array.isArray(p.envs) ? p.envs : [],
    activeEnvId: typeof p.activeEnvId === "string" ? p.activeEnvId : "",
    globals: Array.isArray(p.globals) ? p.globals : [],
    scriptLibrary,
    globalScripts,
    tabs: Array.isArray(p.tabs) ? p.tabs : [],
    activeTabId: typeof p.activeTabId === "string" ? p.activeTabId : null,
    theme: themeMode(p.theme),
    sidebarWidth: typeof p.sidebarWidth === "number" ? p.sidebarWidth : 288,
    responseHeight: typeof p.responseHeight === "number" ? p.responseHeight : 340,
    sidebarTab: p.sidebarTab === "history" ? "history" : "collections",
    sidebarCollapsed: p.sidebarCollapsed === true,
    onboardingDone: p.onboardingDone === true,
    closeToTray: p.closeToTray !== false,
    globalShortcut: p.globalShortcut !== false,
    directConnection: p.directConnection === true,
    zoom: typeof p.zoom === "number" && p.zoom > 0 ? p.zoom : 1,
    codeFontSize: typeof p.codeFontSize === "number" && p.codeFontSize > 0 ? p.codeFontSize : 12,
    shortcuts: p.shortcuts && typeof p.shortcuts === "object" ? p.shortcuts : {},
  };
}
