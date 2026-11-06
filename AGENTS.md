# AGENTS.md — MyGo API

纯本地的轻量级 Postman：Go 桌面壳（MyGo）+ 系统 webview 里的 Vite/TypeScript 前端，HTTP 请求由 Go 侧发出。单人维护、单包、Windows 为主，已发首版 0.1.0。

AI 代理修改本仓库时的强制规则。与 `~/.pi/agent/AGENTS.md` 冲突时，**本文件优先**（本文件只能在此基础上收紧，唯一的放宽是「提交」一节，见下）。

优化顺序（冲突时按序裁决）：

1. 正确性 —— 能跑通、行为符合 README 与功能清单
2. 用户数据安全 —— `workspace.db` 里的集合、历史、环境变量是用户资产
3. 可验证 —— 有 e2e 或命令能证明，不靠感觉
4. 可维护性 —— 新代码进新模块，不把热点文件越堆越大
5. 交付速度

## 提交：本项目完成后自动提交

用户已明确要求：**本项目的任务完成后自行执行 git 提交**，不再询问。这是本条规则对全局「禁止自动 commit」的唯一放宽，其余 git 纪律不变。

- 一个逻辑改动一个提交；同一任务里的功能、测试、文档分开时按逻辑拆，不拆成「改一个文件一个提交」
- 提交消息用简体中文，保留 Conventional Commits 英文前缀：`feat:` / `fix:` / `docs:` / `test:` / `chore:` / `refactor:`
- 提交前必须跑完「验证」一节里对应的命令，绿了才提交
- 只 `git add` 本次任务实际改动的文件（可点名路径），**不用** `git add .` / `git add -A`；`dist/`、`build/`、`.mygo/`、`e2e/artifacts/` 永不入库
- 不 `push`（本机新建仓库，无 remote）；不 `--no-verify`；不 amend/rebase 已提交的 commit；不改写历史
- 工作区里有**不是本次任务**产生的改动时，先问再动，不要把别人的半成品裹进提交

## 动手之前

1. `git status` 看清工作区；未提交的他人改动保留原样，不覆盖、不 stash、不清理
2. 读 `README.md`（功能、快捷键、数据存储、测试、打包）、`docs/设计系统.md`（改界面必读）、`docs/mygo-调研与功能清单.md`（首版范围边界）
3. 读改动点周边的源码与 `e2e/` 里对应用例，确认现有不变量
4. 动存储层、桌面外壳、打包配置前，先读该文件顶部的注释——它们记录了踩过的坑

## 保持现有行为

任务未明确要求时，不得：删功能、改快捷键、改用户可见文案语义、改数据格式、改 `mygo.config.ts` 的 `name` / `slug` / `identifier`（会改变安装目录、注册表键、单实例锁名与 userData 路径）、改 HTTP 语义（超时、重定向、Cookie 罐、认证头的注入方式）。

确需破坏性变更时，先说清「破坏什么 / 为什么必须 / 影响面 / 迁移路径」，等用户确认。禁止把行为变更藏进 refactor。

## UI 与设计系统

界面的权威规范是 `docs/设计系统.md`（令牌表、布局骨架、组件原语、图标与文案规范、禁用清单、自查清单）。做任何界面改动的硬约束：

1. **先查文档再动手**：新增界面从第 5 节的组件原语里选，找不到再扩展，扩展后同一次改动里把新原语登记进文档。
2. **只用令牌**：颜色、字号、圆角、阴影、动效时长一律 `var(--…)`；不得写 `#hex`、`font-size: 12px`、`border-radius: 7px`、裸 `box-shadow`、字面量时长。新令牌必须同时补 `:root`、`html[data-theme="dark"]`、`html[data-theme="auto"]` 三处。
3. **闸门必跑**：`npm run lint:ui` 见红不得提交；它是唯一能防住“越改越花”的机械手段。
4. **两种主题都要看**：浅色与深色各截一张图（`e2e/artifacts/`），只验证一种就交属于未验证。
5. **不引入第二条视觉线**：不加第二个强调色、不加组件库/图标库/Web 字体、不用 emoji 当图标、不做玻璃拟态与超过 180ms 的入场动画。
6. **改既有原语**（高度、内边距、圆角、状态色）时，同步改 `docs/设计系统.md` 的对应表格，否则下次改动会按旧数字做。

## 存储层（最高危区）

存储层是 SQLite，入口 `src/db.ts`（表结构 `SCHEMA`、读写 `load`/`save`、迁移 `init`），Go 侧只有 `main.go` 的 `TakeLegacyState` 与 `mygo.Use(sqlite.Plugin)`。

- 数据库是 userData 下的 `workspace.db`，WAL 模式；整个工作区（集合树、历史、环境与变量、标签页、偏好）都在这一个文件里
- 改表结构：只允许**新增**表、列、索引；改列语义或删列必须升 `SCHEMA_VERSION` 并在 `init()` 里写迁移分支——`meta.schema_version` 是唯一判定入口，不许靠「表存在与否」猜版本
- `save()` 是差异提交（签名比对 + `INSERT … ON CONFLICT DO UPDATE` + 按主键 `DELETE`）；改动它必须保持「内容没变就不写」的性质，否则每次编辑都会重写全库
- 迁移/兼容代码不得删除或覆盖用户数据：旧 `workspace.json` 只允许改名成 `workspace.json.bak` 保留
- 禁止在页面层绕过 `db.ts` 直接 `open()` 另一个数据库文件；禁止把用户数据写进 `localStorage` 或新开 JSON 文件

## 生成物与版本对齐

- `src/mygo.ts` 由 `npm run generate` 生成，文件头写着 DO NOT EDIT：禁止手改。改了 Go 侧公开方法（`func (s *System) ...`、`mygo.NewEvent`）后必须重跑 `npm run generate`，并把它的 diff 一起提交，否则前端拿到的是旧签名
- `src/mygo.ts` 之外的 `src/` 全是手写代码
- 版本必须对齐：`go.mod` 的 `github.com/egoist/mygo`、`package.json` 的 `mygo-cli` / `mygo-runtime` / `@mygo-plugins/*` 当前同为 `0.7.4`。升级任何一个都要**一次全升**，然后跑 e2e 与 `npm run build`

## 架构边界与热点文件

- 页面层通过 `System.*`（生成的绑定）与 Go 通信；Go 侧不解析业务数据、不碰集合与标签页，只提供平台能力（窗口、剪贴板、文件、Cookie 罐、迁移入口）
- 业务逻辑（集合、历史、环境、发送、插值、持久化）只能写在 `src/store.ts`，`src/ui/*` 只做渲染与事件转发
- 界面可以读 `state`、也可以直接改纯 UI 字段，但改完必须触发重绘（`emit()` 或 `window.dispatchEvent(new CustomEvent("mygo:rerender-…"))`）；凡是会落库的字段（`src/db.ts` 里 settings 表登记的那些）必须同时调 `persist()`，否则重启后回到旧值
- 顶部菜单/托盘/深链只发 `desktop:command` 事件，页面复用同一套 store action；不要在 Go 侧复制一份业务逻辑
- 热点文件（每次改动只做与任务直接相关的局部编辑，新增功能优先落新模块）：
  `src/store.ts`（1405 行）、`src/ui/overlays.ts`（1274）、`src/main.ts`（1047）、`src/ui/request.ts`（812）、`src/curl.ts`（732）、`src/db.ts`（561）、`src/ui/response.ts`（626）
- 已拆出的独立模块（新增同类能力放这里，别往热点文件里塞）：`src/postman.ts`（Postman Collection / HAR 互转，451 行）、`src/snippets.ts`（fetch / axios / Python / cURL 片段生成，231 行）、`src/types.ts`、`src/util.ts`、`src/db.ts`、`src/ui/{dom,icons,kvtable,jsonview,prompt}.ts`
- 新 TS 模块约 500 行时反思职责，约 800 行必须拆
- 禁止 `as any` / `@ts-ignore` / `@ts-expect-error`（当前 0 处，保持）；`tsconfig` 是 `strict` + `noUncheckedIndexedAccess`，用真实的类型收窄解决报错

## 桌面外壳与打包

- 自动化插件只允许出现在 `//go:build e2e` 的 `automation.go` 里；禁止把它加进无条件构建（正式产物必须不带 inspector）
- `go build` 是 **dev 构建**（会读 `MYGO_DEV_URL` 加载外部前端）；只有 `mygo build` 产出内嵌前端、带 `mygo_noinspector` 的正式产物。验证「前端真的进了二进制」只能用 `MYGO_E2E_PACKAGING=1 npm run e2e`
- 图标与托盘图标的唯一来源是 `scripts/make-icons.py`：改设计就改脚本再 `python scripts/make-icons.py`，不要手改 `resources/icon.png` / `resources/tray.png`（两处尺寸与视觉要一致）
- 本机没有 Bun：`devCommand` / `buildCommand` 走 `npm`，不要改回 `bun`
- Windows 上做过安装/卸载实测：静默安装 `/S`、安装目录 `%LOCALAPPDATA%\Programs\MyGoAPI`、卸载**不会**删 `%APPDATA%\MyGo API`。手动跑真实二进制/安装包验证后，自己产生的 `%APPDATA%\MyGo API` 与 `%APPDATA%\mygo-api Dev` 必须清理干净

## 禁止清单

未获用户对当次任务的明确指示时，不得执行：

- `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash`
- `git add .` / `git add -A` / `git commit --no-verify` / 任何 force-push / 任何历史改写
- 删除或清空 `%APPDATA%\MyGo API`（用户真实数据）、删除 `workspace.db*`
- 在仓库里留下临时文件（`tmp/`、调试用 `e2e/dbg_test.go`、根目录 `.exe`）：用完即删
- 把临时/调试代码提交入库

## 依赖

- 按「现有代码 → 标准库 → 已装依赖 → 最小实现」决策，不擅自加依赖
- 需要新依赖时先搜现成方案并列 2-3 个候选（覆盖度、维护活跃度、license、与 Go/TS 栈契合度），由用户拍板
- 不为了「顺手」升级 `vite` / `typescript` / `mygo-*` 大版本

## 验证

只跑能直接证明本次声明的最窄验证，不做全量构建（除非用户要求）。常用命令：

| 改动 | 命令 |
| --- | --- |
| 只改前端 | `npm run typecheck`（= `tsc --noEmit`） |
| 改前端且会影响界面行为 | `npm run build:web` + `npm run e2e` |
| 改 Go（`main.go` / `desktop.go` / 绑定） | `go vet ./...` + `npx mygo-cli vet .` + `npm run generate` + `npm run e2e` |
| 改 `src/db.ts` 或表结构 | 上面全部，并确认 `e2e/storage_test.go` 的迁移与重启用例通过 |
| 改 `mygo.config.ts` / 图标 / 依赖 | `npm run build`，必要时 `MYGO_E2E_PACKAGING=1 npm run e2e` |
| 改 `src/style.css` 或任何界面结构 | `npm run lint:ui` + `npm run build:web` + `npm run e2e`，并比对 `e2e/artifacts/` 的浅色/深色截图 |
| 提交前 | `npm run typecheck && npm run lint:ui && go vet ./... && npm run e2e` |

- `npm run e2e` 默认会先 `npm run build:web`；前端没改动时用 `MYGO_E2E_SKIP_BUILD=1 npm run e2e`
- 排障用 `MYGO_E2E_KEEP=1 npm run e2e`（保留临时目录与应用日志），截图在 `e2e/artifacts/`
- **未实际执行的验证不得声称通过**；只跑了部分用例就写清跑了哪些

## 测试纪律

- e2e 用真实二进制 + 真实窗口 + 真实 Go 侧 HTTP（`e2e/`），页面窗口只能 `eval` / `capture` / `menu`，不能点原生控件
- 固定测试数据只允许放在 `e2e/fixtures/`，且只在 e2e 里用；为了让用例变绿去改 `src/` 的示例数据或默认行为，属于作弊
- 等待条件必须锚定「这次操作造成的可观测差异」：不许 `> 0`、不许只看元素存在、不许依赖 `sleep`；改了 A 就断言 A 变、别拿 B 当替身
- 必须加测试：修可复现 bug（先写失败用例）、改数据格式或迁移、改 Go 公开方法、改桌面集成（菜单/托盘/深链/单实例）
- 可不加测试但仍要验证：纯文案、纯样式、注释——交付时说明用什么替代验证

## 交付报告

每次任务结束（提交之后）简要说明：

- 改变了什么可观测行为或契约
- 主要修改的文件路径
- 实际运行过的检查及结果（贴关键输出，如用例数、产物大小、耗时）
- 跳过的验证及原因
- 已知风险、遗留项、需要用户决策的点

## 本文件维护

- 只有满足全部条件的规则才进来：全仓库级、持久、无法从代码推断、防止一类真实事故
- 模块级规则（如 `e2e/` 的驱动细节）优先写在代码注释与 README，本文件只留红线
- 能机械化的规则（typecheck、go vet、e2e）在这里只写入口命令，不重复其内容
- 定期删除：模型能自己推断的、从未影响过决策的、已过时的条目
