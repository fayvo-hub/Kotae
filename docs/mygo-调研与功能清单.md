# MyGo 调研与 mygo-api 落地文档

本文档记录三件事，顺序固定：

1. **MyGo（https://mygo.egoist.dev/）文档调研摘要** —— 模块清单、关键概念、可复用能力接口、版本与依赖要求、与"本地轻量级 API 调试工具"的契合/不契合点，以及待确认项。
2. **AI 开发手段接入与验证结果** —— 装了什么、落在哪个路径、改了哪些配置、如何验证、有哪些阻塞点。
3. **轻量 Postman 功能清单** —— 只出清单，不含实现代码。

当前实现状态、端到端测试与打包安装说明见仓库根目录的 `README.md`；本文是立项阶段的调研记录。

调研与实测环境（本机）：Windows + git bash；Go 1.24.7 → 由 `GOTOOLCHAIN=auto` 自动切换到 **go1.27.3**；Node v22.19.0 / npm 10.9.3；WebView2 Runtime 157.0.4341.42；**未安装 Bun**；未安装 makensis / gh。

---

# 一、MyGo 文档调研摘要

## 1.1 定位与能力边界

MyGo（v0.7.4，MIT，github.com/egoist/mygo）是**用 Go 写桌面应用的框架 + 打包工具链**：一个几 MB 的纯 Go 二进制（无 cgo），支持 macOS / Linux / Windows，自带安装包与签名自动更新。

一个 app 里两种窗口可以共存，共享窗口选项、事件、菜单和桌面 API：

| 窗口类型 | 渲染方式 | 前端技术栈 | 与 Go 的交互 |
| --- | --- | --- | --- |
| 网页窗口 | 系统 webview：macOS WKWebView / Linux WebKitGTK / Windows WebView2 | 任意（脚手架用 TypeScript + Vite） | `mygo generate` 从 Go 绑定生成 TypeScript 客户端（默认 `src/mygo.ts`） |
| 原生 UI 窗口 | MyGo 自绘：Metal / Direct3D 11（无驱动时 WARP）/ OpenGL，浏览器里是 WebGL 2 | 纯 Go，无 HTML / JS（package `ui`） | 直接调用 Go |

官方指标：二进制约 7 MB、原生 UI 内存约 44 MB、含 webview 约 62 MB、空闲 CPU 0%。

**能力边界**：MyGo 提供的是「窗口 + 系统集成 + 打包 + 一组官方插件」，不提供任何业务层能力（不含 HTTP 请求构建器、集合/环境变量模型、导入导出、录制代理）。凡是 Postman 式的业务模型，都在 MyGo 之上自研。

## 1.2 文档模块清单

导航结构（依据 `https://mygo.egoist.dev/llms.txt`，共 117 个页面）：

| 分组 | 页面 | 内容要点 |
| --- | --- | --- |
| Overview | Introduction | 总览，内含 Getting started / Building the app / Native UI / Web pages / Shipping / Official plugins / Reference / Requirements |
| 入门 | Getting started | 安装、`mygo init`、两种模板、目录结构、开发/构建流程 |
| Building the app | Windows | 创建/排列两种窗口、窗口选项、事件、网页窗口的行为 |
| | The application | `mygo.App`：生命周期、应用身份、与系统交互 |
| | Menus and the tray | `*mygo.MenuItem` 模板构建菜单栏、右键菜单、Dock 菜单、托盘菜单 |
| | Documents | `mygo.NewDocuments`：文档型应用（一窗一文件） |
| | Languages (i18n) | ARB JSON 语言包 → 生成 Go 包与 TypeScript 模块；ICU MessageFormat、CLDR 数字/日期格式 |
| | Desktop APIs | 文件/消息对话框、系统通知、剪贴板、拖放数据、音频、Launchers |
| | Clipboard and drag data | package `transfer`：系统剪贴板与原生拖放共享的序列化内容 |
| | Audio | 音效解码进内存、音乐流式播放、自合成声音 |
| | Launchers | Spotlight / Raycast / Alfred / PowerToys Run / Ulauncher 式唤起入口 |
| Web pages | The frontend | 网页窗口的前端构建约定（任意工具，默认 TypeScript + Vite） |
| | Calling Go from the frontend | 绑定服务：Go 值的方法暴露给页面，可用 channel 流式回传 |
| | Plugins | 插件两半结构：Go 服务 + JavaScript 包；Go 侧 `mygo.Use`，前端 import 对应包 |
| Shipping | Building and distributing | `mygo build` → 各平台安装包；资源嵌入与平台专属资源 |
| | Auto-updates | 签名发布、GitHub / 任意 HTTPS 服务器、增量更新 |
| | GitHub Actions | 打 tag 触发多平台构建、签名、上传草稿 release 的官方工作流 |
| Official plugins | Fetch / WebSocket / SQLite / Watch / Updater / Terminal / Glass / Game / Loading / Automation | 见 1.4 |
| Reference | Configuration | `mygo.config.ts` / `mygo.json` 全字段 |
| | The mygo CLI | `init`/`install-skills`/`vet`/`migrate-ui`/`generate`/`i18n check`/`dev`/`build`/`keygen`/`doctor`/`version` |
| | Go API | 指向 pkg.go.dev |
| | Architecture | 分层、线程模型、Go 不经 cgo 调原生工具链、页面与 Go 的类型化消息交换 |
| Native UI | `/docs/ui/*`（86 页） | package `ui` 的控件与机制：Accessibility、Accordion、Alert dialog、Autocomplete、Avatar、Badge、Breadcrumbs、Native UI in browsers、Button、Calendar、Charts、Checkbox、Code editor、Collapsible、Color picker、Combobox、Context menu、Custom widgets、Date input、Decimal input、Dialog、Diff viewer、Drag and drop、Drawing and animation、Editable text、Find bar、Form、Grid view、Grid、History buttons、Icon、Image、Input、Inspector、Layout、Link、List、Markdown、Menu button、Meter、Migrating to checked elements、Motion、Pages and navigation、Number input、Outline、Overlays、Native UI performance、Popover、Progress bar、Radio、Range slider、Rating、Rendering、Rich text editor、Right to left、Scroll view、Search field、Segmented control、Select、Shaders、Sidebar、Slider、Spinner、Split view、Stepper、Styling and themes、Switch、Table、Tabs、Testing、Text-input primitives、Text input、Text、Time input、Toast、Toggle、Token field、Toolbar、Tooltip、Transforms、Transitions、Tree、Video、Views、Web view、Windows with native UI |
| 站内其他 | /benchmarks、/showcase、Examples（GitHub `examples/`）、Search（⌘K） | 基准数据、案例、示例代码入口 |

**站点层面的缺口（不是"没读到"，是站点没有）**：无独立 FAQ 页、无独立 Changelog 页。更新日志只存在于 GitHub Releases（https://github.com/egoist/mygo/releases）与 `CHANGELOG.md`，站点页脚仅显示版本号。

## 1.3 关键概念表

| 概念 | 含义 |
| --- | --- |
| `mygo.App` | 应用本体：生命周期、身份（name / identifier / version）、系统交互入口；`App.WhenReady` 注册就绪回调，`App.Run()` 进入事件循环 |
| 绑定服务（bindings） | 注册给前端的 Go 值，其导出方法成为页面可调用的函数；`mygo generate` 据此生成 TypeScript 类型与调用桩 |
| 事件（event） | `mygo.NewEvent[T](name)` + `Emit(win, value)`，Go 侧向页面推送数据；前端以 `events.<name>.on(...)` 订阅 |
| 窗口（Window） | `mygo.NewWindow(WindowOptions{...})`；`URL: "/"` 加载前端（开发时是 devUrl，正式包由 `frontendDist` 嵌入后在 `mygo://localhost/` 提供）；`StateKey` 记住位置大小 |
| 插件（plugin） | 官方能力包，分 Go 半与 JS 半；Go 侧 `mygo.Use(xxx.Plugin)`，前端 `import { ... } from "@mygo-plugins/xxx"` |
| 目录约定 | `resources/`（随包资源，可按平台分目录）、`dist/`（前端产物）、`build/`（打包产物）、`.mygo/`（开发态产物） |
| 开发态与正式态隔离 | 开发版应用名 `<name> Dev`、identifier `<identifier>.dev`、产物在 `.mygo/dev/<goos>-<goarch>/`，数据与单实例锁都与正式包隔离 |
| 配置即代码 | 项目根 `mygo.config.ts`（`defineConfig`，由 Bun 或 Node ≥22.6 求值），或原生 UI 模板的 `mygo.json`；两者只能取其一 |
| 原生 UI 的心智模型 | 视图是「状态 → 界面」的函数，主线程按帧重建；元素是一次性值（下一帧即失效），长期状态放在 app 模型 / `ui.Handle` 里 |
| 自动化协议 | Automation 插件：macOS/Linux/Windows 统一用 Unix domain socket 上的行分隔 JSON 驱动运行中的 app（列窗口、读元素树、注入输入、执行页面脚本、截图、等稳定） |

## 1.4 可复用能力与接口

### Fetch 插件（本项目最核心）

Go 侧：

```go
import "github.com/egoist/mygo/plugins/fetch"

mygo.Use(fetch.Plugin)
// 或定制：
mygo.Use(fetch.New(fetch.Options{
    Client: &http.Client{Jar: jar, Timeout: time.Minute},
    Allow:  func(r *http.Request) bool { return true },
}))
```

前端：

```ts
import { fetch } from "@mygo-plugins/fetch"; // npm/bun add @mygo-plugins/fetch
const res = await fetch("https://api.example.com/items", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://example.com" },
  body: JSON.stringify({ q: 1 }),
});
```

与浏览器 `fetch` **同形**（标准 options + 标准 `Response`），但请求从 Go 侧发出，因此：

- 不受 CORS 限制；可读除 `Set-Cookie` 之外的所有响应头；可设任意请求头（含 webview 平时禁止的 `Origin` / `Cookie` / `Referer` / `User-Agent`）。
- 请求体支持 `string` / `FormData` / `URLSearchParams` / `Blob` / `ArrayBuffer`（含 `Content-Type`）；`stream` 体先整体读完再发。
- 响应体是 `ReadableStream`：页面已读未超 1 MiB 时 Go 暂停读，大响应不会堆在页面内存。
- 非 2xx **不抛错**，需查 `res.ok`；网络 / TLS / 重定向过多会 reject `TypeError`，`message` 形如 `fetch failed: Get "https://unreachable.example": dial tcp: lookup unreachable.example: no such host`（Go 侧错误链原样带回，可直接展示给用户）。
- `abort` 会在 Go 侧取消请求。
- 忽略 `mode` / `credentials` / `cache` / `referrerPolicy` / `integrity` / `keepalive` / `priority`。
- `redirect`：`manual` 返回真实重定向响应（含 `Location`）、`error` 遇重定向即失败、`follow`（默认）最多 20 次。
- Cookie 由 Go 的 `http.Client` 决定（默认无 Jar 即不保持）。
- 默认 Transport 是 `netproxy.Transport()`：遵循 `HTTPS_PROXY` / `NO_PROXY`，否则用系统代理。
- `Allow` 过滤器只对首个请求生效，不覆盖重定向。
- 非 http/https scheme（`mygo://`、`data:`、`blob:`）回落到 webview 自己的 `fetch`；相对 URL 按页面地址解析。
- 只有 app 自己的页面能调用。

### 其他官方插件

| 插件 | 能力 | 对本项目的意义 |
| --- | --- | --- |
| SQLite | 预编译 SQLite 经 purego 加载（无 cgo，macOS/Linux/Windows amd64+arm64）；页面侧 `open` / `execute` / `query` / `transaction`；文件限 `mygo.PathUserData`，禁 `ATTACH` / `VACUUM INTO` | 集合、历史、环境变量的本地持久化 |
| WebSocket | Go 建连、浏览器同款 API、可带握手 headers | 首版不做，后续扩展点 |
| Watch | 页面监听 app 允许的文件/目录变化 | 可选（配置文件变更重载） |
| Terminal | 原生 UI 内嵌伪终端（Ghostty 的终端模拟器） | 不相关 |
| Automation | 外部进程/agent 通过 `MYGO_AUTOMATION` 指定的 socket 驱动运行中的 app；需 build tag 打开，正式构建默认不含 | 端到端测试、AI agent 驱动验收 |
| Updater | 跨平台更新窗口（类似 Sparkle）；配合 `mygo keygen` | 后续分发 |
| Glass / Game / Loading | Liquid Glass 材质 / 游戏循环 / 29 种加载指示器（均面向原生 UI） | 不相关 |

### 桌面 API（Go 侧，可直接支撑前端需求）

- `mygo.Dialog.Open / Save / Message / Error`：系统文件与消息对话框（本项目导入导出的天然载体）。
- `mygo.NewNotification`：系统通知。
- 剪贴板与拖放（package `transfer`）、菜单与托盘、Launchers、i18n 目录。

## 1.5 版本与依赖要求

| 项 | 要求 | 本机状态 |
| --- | --- | --- |
| Go | 1.27+（模块实际 `go >= 1.27.3`） | Go 1.24.7 + `GOTOOLCHAIN=auto` → 自动切到 go1.27.3 ✅ |
| 有前端的项目 | 官方要求 Bun（`mygo.config.ts` 求值用 Bun） | **未安装 Bun** ❌；实测 Node ≥22.6 也可求值配置、npm 可驱动 Vite（见第二部分） |
| Node（无 Bun 时） | ≥22.6；22.18 / 23.6 之前需 `--experimental-strip-types`；仅类型抹除，不能用 `enum` 等生成代码语法 | v22.19.0 ✅ |
| Windows | Windows 10 需 WebView2 Runtime（Win11 自带） | 157.0.4341.42 ✅ |
| Linux | GTK3 + WebKitGTK 4.1（`apt install libwebkit2gtk-4.1-0`） | 未验证（非目标平台） |
| macOS | 默认最低 12.0；签名与 dmg 制作需 macOS | 未验证（非目标平台） |
| 原生 UI 模板 | 不需要 Bun，也不需要 webview | — |
| 打包额外依赖 | Windows 安装包需 NSIS（`mygo build` 会自动下载 3.13）；`-upload` 需 gh | makensis / gh 均未安装，`-skip-installer` 可绕过 ✅ |

## 1.6 与"本地轻量级 API 调试工具"的契合点

1. **纯本地、无后端**：MyGo 就是单二进制 + 系统 webview，本身不引入任何云服务；页面由二进制内嵌提供（`mygo://localhost/`），无本地 HTTP 服务暴露面。
2. **CORS 与自定义头问题被从根上解决**：浏览器里做 API 调试工具的最大障碍是跨域与受限头；fetch 插件的请求从 Go 发出，不受 CORS 限制、可写 `Origin`/`Cookie`/`Referer`/`User-Agent`，可读除 `Set-Cookie` 外的全部响应头——这恰好是 Postman 类工具的核心需求。
3. **HTTP 能力足够**：自定义 `http.Client`（Jar / Timeout）、重定向策略、代理（默认走系统代理或 `HTTPS_PROXY`）、请求体全类型、流式响应与背压、abort 取消。
4. **错误信息可直接呈现**：Go 侧 DNS/TLS 错误原文回传到前端，比浏览器只给 `Failed to fetch` 有价值得多。
5. **本地存储现成**：SQLite 插件（无 cgo、路径限用户数据目录）可做集合/历史/环境变量；避免 localStorage 被清缓存带走。
6. **桌面能力齐备**：文件对话框做导入导出、系统通知做长请求完成提示、`StateKey` 记忆窗口、`light-dark()` 跟随系统主题。
7. **分发成本低**：`mygo build` 直接产出 Windows exe + NSIS 安装包；Updater 插件提供后续自动更新路径。
8. **AI 协作有官方落点**：`mygo install-skills` 提供 MyGo 专属 agent skill，agent 改 UI/升级依赖时有明确的寿命、identity、线程与测试规则可依。

## 1.7 不契合点

| 不契合点 | 说明 | 应对 |
| --- | --- | --- |
| 无请求构建器 | MyGo 不含 URL/方法/参数/头/体的编辑模型与 UI | 自研（前端表单 + fetch 插件发送） |
| 无集合/环境变量模型 | 不含集合、文件夹、环境、变量插值等业务概念 | 自研；持久化用 SQLite 插件 |
| 无导入导出 | 不含 HAR / OpenAPI / Postman Collection / cURL 的解析与生成 | cURL 解析与生成首版自研（见 3.2、3.10）；自有格式导出用 `mygo.Dialog`；其余首版不做 |
| 无录制代理 | 没有内置 HTTP 代理或流量录制 | 首版不做（需自研 + 系统代理配置，成本高） |
| 无脚本/断言引擎 | 没有 Postman Tests 式脚本运行时 | 首版不做 |
| 无 FAQ / Changelog 页面 | 站点层面缺失，更新日志只在 GitHub Releases | 以 Releases 为准，文档内不做声明 |
| 原生 UI 生态偏 macOS 审美 | `ui` 包按 AppKit/SwiftUI 习惯设计；Web 前端路线则无此约束 | 本项目走 web 前端路线（HTML/CSS/TS） |
| 开发者体验依赖 Bun 表述 | 文档以 Bun 为准，本机未装 | 实测用 npm 等价替代（见第二部分） |

## 1.8 待确认项（不臆测）

1. **官方是否把 npm 视为一等路径**：文档写"有网页前端的项目需要 Bun"，但 `mygo.config.ts` 本身可由 Node ≥22.6 求值，Vite 也可由 npm 驱动；本机实测可行。官方是否正式支持 npm 作为替代，文档未表态 —— 待确认。
2. **是否存在未公开的 AI 集成**：文档中只出现 agent skills（`mygo install-skills`）。MCP server、编辑器插件等均未在文档出现 —— 视为**不存在**，但不排除未公开计划，待确认。
3. **站点版本号与仓库版本是否始终同步**：站点页脚只标 0.7.4，无 Changelog 页；版本差异只能对比 GitHub Releases —— 待确认。
4. **Bun 独有能力**：文档未说明哪些流程只有 Bun 能做（当前观察：无）。待确认。
5. **Automation 在 Windows 上的 socket 具体形式**：文档表述为"Unix domain socket（macOS/Linux/Windows 统一协议）"，Windows 下 AF_UNIX 的路径/权限细则未展开 —— 待确认（本项目首版不依赖它）。

---

# 二、AI 开发手段接入与验证结果

> 历史记录：本章记录的是脚手架安装当天（应用还叫 `mygo-api`、尚未改名 `MyGo API`）的实际状态与逐条命令输出。项目后续的配置、产物名与版本以 `mygo.config.ts`、`README.md` 和 `AGENTS.md` 为准。

## 2.1 结论先行

调研确认：**MyGo 官方公开的 AI 开发相关手段只有一项 —— agent skills**（`mygo install-skills` 命令 + 两个 `init` 模板自动安装的 `.agents/skills/`）。文档中没有 MCP server、没有编辑器插件、没有其他助手集成方式。

因此本项目的接入内容为：

1. 用 `mygo init` 生成官方 web 脚手架（这是官方推荐的初始化流程，也是后续所有命令的前提）。
2. 用 `mygo install-skills .` 把官方 skill 装进项目 `.agents/skills/`。
3. 配置本地开发服务（`mygo dev` + Vite dev server）并验证可用。
4. 保留 `mygo generate`（Go → TypeScript 类型化客户端生成）作为日常开发闭环的一环。

## 2.2 逐项安装记录

| # | 项目 | 落地路径 | 执行命令 | 验证方式与结果 |
| --- | --- | --- | --- | --- |
| 1 | MyGo web 脚手架 | 项目根：`main.go`、`go.mod`、`go.sum`、`mygo.config.ts`、`package.json`、`index.html`、`src/{main.ts,style.css,mygo.ts}`、`vite.config.ts`、`tsconfig.json`、`resources/icon.png`、`.gitignore`、`.agents/` | `go run github.com/egoist/mygo/cmd/mygo@latest init -name mygo-api -module mygo-api .` | 文件全部生成；`go.mod` 内 `module mygo-api`、`go 1.27.3`、`require github.com/egoist/mygo v0.7.4`；`go build` 通过 |
| 2 | Go 依赖 | `go.mod` / `go.sum` | 同上（init 自动写入） | `go build -o /tmp/mygo-api-verify.exe .` → 退出码 0，产物 14.5 MB（未 strip 的开发二进制） |
| 3 | 前端依赖 | `node_modules/`、`package-lock.json` | `npm install`（官方模板用 `bun install`，本机无 Bun） | 20 个包；`mygo-cli@0.7.4`、`mygo-runtime@0.7.4`、`typescript@7.0.2`、`vite@8.3.6` |
| 4 | **官方 agent skill** | `.agents/skills/mygo-maintenance/SKILL.md`、`.agents/skills/mygo-maintenance/agents/openai.yaml` | `npx mygo-cli install-skills .` | 输出 `• Installed skills in .agents\skills`；文件存在且内容为 MyGo 维护规则（详见 2.3） |
| 5 | TypeScript 客户端生成 | `src/mygo.ts`（`bindings` 配置项） | `npx mygo-cli generate` | 输出 `✓ Wrote src/mygo.ts`；文件含 `export const Greeter = { greet(...) }`、`SystemInfo` 接口、`events` 订阅桩 |
| 6 | 本地开发服务 | Vite dev server（`devUrl`）+ `.mygo/dev/windows-amd64/` | `npx mygo-cli dev` | 见 2.5 |
| 7 | 生产打包链路 | `dist/`（前端产物）、`build/windows-amd64/mygo-api.exe` | `npx mygo-cli build -skip-installer` | 见 2.5 |

## 2.3 装进项目的 AI 能力是什么

`mygo install-skills .` 落地的是官方唯一 AI 工件 `mygo-maintenance`，内容是一份面向 agent 的 MyGo 维护规则，覆盖：

- **UI 寿命与 identity**：`*ui.Context` 只在其窗口内有效、元素是逐帧失效的值（长期状态放 app 模型 / `ui.Handle`）、`c.Key(key)` 给控件稳定唯一 identity、`.Bind(&handle)` 绑定持久 identity。
- **输入与动作**：绑定值在构造之后更新、`Changed` / `Submitted` 到来于下一帧、`OnClick` / `OnShortcut` 的执行顺序、`handle.OnShortcut` 的作用域。
- **状态、工作与渲染**：一次事件可能重建多次视图、慢 I/O 必须离开 UI 线程并经 `Window.Update` 回写、绘制回调只能画不能做别的。
- **验证方式**：用 `ui.NewTester` 复现 UI 缺陷、`go tool mygo vet .`、`CGO_ENABLED=0 go test ./...`、升级时先 `mygo migrate-ui` 预览再 `-write`。

该 skill 声明的前置与自检方式：先 `go list -m -f '{{.Dir}}' github.com/egoist/mygo` 定位 pinned 源码（本机解析为 `C:\Users\Administrator\go\pkg\mod\github.com\egoist\mygo@v0.7.4`），再读 `ui/doc.go` 与相关实现注释确认 API 可用性 —— 即"以钉住的源码为准"，不靠记忆写代码。

**生效验证**：本机 agent 运行时（Pi）在其文档 `docs/skills.md` 中明确支持 `.agents/skills/` 作为项目级技能目录（"Project `.agents/skills/` directories are discovered from the working directory through its ancestors"），因此该 skill 属自动发现、无需额外配置。**但要注意**：本项目当前是 web 前端路线（无 package `ui`），skill 中关于原生 UI 寿命/identity 的规则目前不适用，仅在将来转原生 UI 时生效；`go tool mygo vet`、`mygo generate`、`migrate-ui` 相关条目仍适用。

## 2.4 配置改动

原始模板用 Bun 驱动前端，本机无 Bun，因此只改了一处（这是本任务对脚手架的**唯一改动**）：

`mygo.config.ts`：

```ts
  // 本机未安装 Bun，改用 npm 驱动 Vite（mygo 只要求 devUrl 能应答、
  // buildCommand 产出 frontendDist，用什么包管理器由项目自己决定）。
  devUrl: "http://localhost:5173",
  devCommand: "npm run dev:web",
  buildCommand: "npm run build:web",
```

- 原值：`devCommand: "bun run dev:web"`、`buildCommand: "bun run build:web"`。
- 其余字段保持模板默认：`name: "mygo-api"`、`identifier: "com.example.mygoapi"`、`version: "0.1.0"`、`frontendDist: "dist"`、`bindings: "src/mygo.ts"`、`out: "build"`。
- `package.json` 的 scripts 未改动（本就用 `vite` / `tsc --noEmit && vite build`，与包管理器无关）。

## 2.5 验证结果（逐条可复现）

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 环境体检 | `npx mygo-cli doctor` | ✅ go `go1.27.3 windows/amd64`；✅ webview2 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\157.0.4341.42`；✅ signtool；⚠ bun 未安装（提示 optional）；⚠ makensis 未安装（打包时自动下载）；⚠ gh 未安装（仅 `-upload` 需要） |
| Go 编译 | `go build -o /tmp/mygo-api-verify.exe .` | 退出码 0，14.5 MB |
| 静态检查 | `npx mygo-cli vet .` | 退出码 0（go vet + 原生 UI 构建寿命检查） |
| 前端类型检查 | `npm run typecheck`（`tsc --noEmit`） | 退出码 0 |
| 前端生产构建 | `npm run build:web` | 退出码 0；`dist/index.html`、`dist/assets/index-*.css`、`dist/assets/index-*.js` |
| **本地开发服务** | `npx mygo-cli dev` | ✅ `Dev server ready at http://localhost:5173`（Vite 8.3.6，381 ms 就绪）→ ✅ `Built mygo-api Dev 7.1s` → ✅ 进程 `mygo-api Dev.exe` 启动，窗口标题 `mygo-api`；开发态产物 `.mygo/dev/windows-amd64/mygo-api Dev.exe`；5173 端口处于 LISTENING 且有 webview 的 ESTABLISHED 连接 |
| 生产打包 | `npx mygo-cli build -skip-installer` | 退出码 0；`✓ Built mygo-api 0.1.0 in 17.0s`；`build/windows-amd64/mygo-api.exe` 9.6 MB + `icon.png` |

首次 `npx mygo-cli dev` 的失败与修复（保留为记录）：

```
web │ 'bun' 不是内部或外部命令，也不是可运行的程序或批处理文件。
✗ Starting the dev server  36ms
error: the dev server exited: exit status 1
```

原因：`devCommand` 仍是 `bun run dev:web`。改为 `npm run dev:web` 后即通过（见 2.4）。验证结束后已结束 dev 进程、释放 5173 端口。

## 2.6 阻塞点、影响范围与替代方案

| 阻塞点 | 影响范围 | 替代方案（已采用 / 备选） |
| --- | --- | --- |
| **未安装 Bun** | 官方 web 模板默认用 `bun install` / `bun run dev:web`；不改则 `mygo dev` 与 `mygo build` 的 web 阶段都会失败 | **已采用**：`mygo.config.ts` 的 `devCommand` / `buildCommand` 指向 npm scripts；依赖用 `npm install`。备选：安装 Bun（官方一等路径，改动可回退） |
| **未安装 makensis（NSIS）** | `mygo build` 默认要产出 `mygo-api-setup-<version>-<arch>.exe` 安装包 | **已采用**：`-skip-installer` 只产出可执行文件；若需安装包，去掉该参数，`mygo build` 会自动下载 NSIS 3.13（需联网） |
| **未安装 gh** | 仅影响 `mygo build -upload` 上传 GitHub release | 首版不需要；发布阶段再装 |
| **Go 版本低于 1.27.3** | 依赖 `GOTOOLCHAIN=auto` 自动下载工具链（首次会拉取 go1.27.3，需网络） | 已生效（`go.mod` 已写 `go 1.27.3`）；离线环境需预先安装 Go 1.27.3 |
| **项目非 git 仓库** | 无法提交、无法走 GitHub Actions 流水线 | 不阻塞本地开发；需要版本管理时先 `git init`，再接官方 GitHub Actions 工作流（见文档 Shipping / GitHub Actions 页） |

## 2.7 明确没做的部分（避免范围膨胀）

- **未安装 `@mygo-plugins/fetch`**：它是本项目后续实现"发请求"能力的核心依赖，属于**业务实现阶段**的依赖，不属于本任务（AI 开发手段接入 + 只出功能清单）的范围。功能清单中已标注哪些能力由它支撑，实施时再 `npm i @mygo-plugins/fetch` 并在 `main.go` 里 `mygo.Use(fetch.Plugin)`。
- **未安装 SQLite / WebSocket / Automation 插件**：同上，按功能清单需要再引入。
- **未创建 git 仓库、未提交任何内容**：仓库状态由用户决定。

---

# 三、轻量 Postman 功能清单

约束：纯本地、无云端无后端、全中文文案、功能精简（不做重量级测试平台）。"实现归属"列取值含义：

- **mygo 直接支撑**：MyGo 或其官方插件已提供该能力，只需接线。
- **需自研**：MyGo 不提供，需在 web 前端 / Go 绑定层自行实现。
- **首版不做**：本版本明确排除。

首版判定口径：**必须** = 第一版硬门槛，缺了不算"能用"；**可选** = 增强项，能实现更好，不影响首版闭环。"首版"列标注该条是否进入第一版交付范围。

## 3.1 请求构建与发送

| 功能 | 说明 | 优先级 | 首版 | 实现归属 |
| --- | --- | --- | --- | --- |
| 方法与 URL 编辑 | 支持 GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS，URL 输入带非法格式即时提示 | 必须 | 是 | 需自研（输入 UI）；mygo 直接支撑（发送走 fetch 插件） |
| URL 粘贴智能解析 | 粘贴带查询串的完整 URL 时自动拆出查询参数到表格，可继续编辑 | 必须 | 是 | 需自研（URL 解析器） |
| 查询参数表格 | 键值对表格编辑，自动拼接到 URL，支持启用/禁用单行、批量粘贴（每行一行对） | 必须 | 是 | 需自研 |
| 请求头表格 | 键值对表格编辑，可写任意头（含 Origin/Cookie/Referer/User-Agent）；常用头名自动补全；支持批量粘贴原始头文本 | 必须 | 是 | 需自研（UI）；mygo 直接支撑（fetch 插件不受 webview 头限制） |
| 请求体：JSON / 纯文本 | raw 编辑 + JSON 格式化/压缩/语法校验 | 必须 | 是 | 需自研（UI）；mygo 直接支撑（string 体） |
| 请求体：表单 | `application/x-www-form-urlencoded` 与 `multipart/form-data`（含文件字段，走系统文件对话框） | 必须 | 是 | 需自研（UI）；mygo 直接支撑（`URLSearchParams` / `FormData`） |
| 请求体：二进制 / 文件直传 | 选择本地文件作为原始体发送 | 可选 | 否 | mygo 直接支撑（`ArrayBuffer` / `Blob` + `mygo.Dialog.Open`） |
| 认证辅助 | Bearer Token / Basic 用户名密码 / API Key（头或查询参数）一键生成对应头 | 必须 | 是 | 需自研（本质是头模板） |
| 取消进行中的请求 | 发送中可中止，状态回落到"已取消" | 必须 | 是 | mygo 直接支撑（fetch 的 `abort` 在 Go 侧取消） |
| Cookie 会话保持开关 | 多次请求共享 Cookie（登录态链路调试）；可选开启/关闭 | 必须 | 是 | mygo 直接支撑（`fetch.New` 传带 `Jar` 的 `http.Client`）；开关与展示需自研 |
| 超时设置 | 自定义超时秒数（默认 30s，0 为不限），超时给中文提示 | 必须 | 是 | mygo 直接支撑（abort 在 Go 侧取消）；计时与 UI 需自研 |
| 重定向策略 | follow / manual（展示 3xx 与 Location）/ error 三选 | 必须 | 是 | mygo 直接支撑（fetch 的 `redirect` 选项）；UI 需自研 |
| 跟随系统代理 | 默认使用系统代理与 `HTTPS_PROXY`/`NO_PROXY` 环境变量 | 必须 | 是 | mygo 直接支撑（默认 `netproxy.Transport()`） |
| 自定义代理配置 | 手动指定 HTTP/HTTPS 代理地址 | 可选 | 否 | 需自研（自定义 `http.Transport`） |
| 忽略 TLS 证书校验 | 调试自签证书接口时跳过证书校验 | 可选 | 否 | mygo 直接支撑（可传自定义 `http.Client`）；UI 需自研 |

## 3.2 cURL 导入与导出（首版必须有）

| 功能 | 说明 | 优先级 | 首版 | 实现归属 |
| --- | --- | --- | --- | --- |
| 粘贴 cURL 命令导入 | 把浏览器 DevTools / 后端给的 curl 命令粘贴进来，自动解析为请求（方法、URL、查询参数、头、体、认证、Cookie 全部回填） | 必须 | 是 | 需自研（解析器，见 3.11 选型） |
| 支持的参数覆盖 | `-X/--request`、`-H/--header`、`-d/-data/--data-raw/--data-binary/--data-urlencode`、`-F/--form`、`-u/--user`、`-b/--cookie`、`-A/--user-agent`、`-e/--referer`、`--compressed`、`-k/--insecure`、`-L/--location`、`--max-time`、`--url`、参数间换行续行 `\` 与 `^` | 必须 | 是 | 需自研 |
| 多行与引号处理 | 支持单双引号、`$'...'` 转义、续行符拼接、`--data-binary @file` 从本地读文件 | 必须 | 是 | 需自研 |
| 导入预览与确认 | 解析后先展示识别结果（方法与 URL、头、体大小），未知参数给出中文提示，确认后再填充，避免误判 | 必须 | 是 | 需自研 |
| 导入失败定位 | 解析失败时给出出错位置与原因（如引号未闭合、未知参数名），不静默丢弃 | 必须 | 是 | 需自研 |
| 从当前请求生成 cURL | 一键把当前请求转成 curl 命令并复制到剪贴板，便于分享给同事或命令行复现 | 必须 | 是 | 需自研（生成器，与解析器共用一个中间表示） |
| 批量导入多条 cURL | 一次粘贴多条 curl，自动生成一个集合 | 可选 | 否 | 需自研 |

## 3.3 响应查看

| 功能 | 说明 | 优先级 | 首版 | 实现归属 |
| --- | --- | --- | --- | --- |
| 状态码与耗时 | 显示状态码、状态文本、总耗时、响应体大小 | 必须 | 是 | 需自研（`Response` 提供状态与头，耗时由页面计时） |
| 响应体格式化 | JSON 自动折叠树 + 语法高亮；纯文本 / HTML / XML 原样展示；可切"原始"视图 | 必须 | 是 | 需自研（JSON 树渲染） |
| 响应体搜索 | 在响应体文本中搜索关键字并高亮定位 | 必须 | 是 | 需自研 |
| 响应头列表 | 列出全部响应头，可搜索、单条复制、复制全部 | 必须 | 是 | mygo 直接支撑（可读除 `Set-Cookie` 外全部头）；列表 UI 需自研 |
| 复制响应体 | 一键复制全文（原始文本），也可复制折叠树中当前节点的值 | 必须 | 是 | mygo 直接支撑（Clipboard 模块 / webview 剪贴板） |
| 网络错误友好提示 | 把 Go 侧 DNS/TLS/连接/超时错误原文翻译成中文提示，并保留原文可展开 | 必须 | 是 | mygo 直接支撑（错误原文透传）；中文映射需自研 |
| 响应体保存为文件 | 把响应体另存到本地（系统对话框选路径） | 必须 | 是 | mygo 直接支撑（`mygo.Dialog.Save`）；写文件需 Go 侧加绑定 |
| 大响应与流式查看 | 超过阈值的响应不整体入内存，边收边展示进度 | 可选 | 否 | mygo 直接支撑（`ReadableStream` + 1 MiB 背压） |
| 图片 / 二进制响应预览 | 图片直接渲染，其他二进制给十六进制预览 | 可选 | 否 | 需自研（`Blob` → `blob:` URL） |
| 分阶段耗时 | DNS 解析 / 连接 / TLS / 首字节 / 总耗时分段展示 | 可选 | 否 | 需自研（Go 侧 httptrace 需自加绑定） |
| 重定向链路展示 | 展示 follow 模式下的 3xx 跳转链（每跳 URL 与状态码） | 可选 | 否 | 需自研（Go 侧 CheckRedirect 记录） |

## 3.4 集合与历史管理

| 功能 | 说明 | 优先级 | 首版 | 实现归属 |
| --- | --- | --- | --- | --- |
| 请求历史 | 按时间倒序列出最近请求（方法、URL、状态码、耗时），点击回填全部字段，可重发 | 必须 | 是 | 需自研（记录模型与列表 UI） |
| 历史管理 | 单条删除、一键清空，发送成功/失败都记录 | 必须 | 是 | 需自研 |
| 集合与文件夹 | 保存请求到集合，集合内可再分组 | 必须 | 是 | 需自研 |
| 请求命名与重命名 | 保存时给请求起名，列表显示名称而非 URL；支持重命名 | 必须 | 是 | 需自研 |
| 保存请求 / 另存为 | 新建请求 Ctrl+S 保存到集合；已保存的请求可另存为一个新请求 | 必须 | 是 | 需自研 |
| 复制请求 | 集合内复制一份（Duplicate），便于改参测试 | 必须 | 是 | 需自研 |
| 删除请求与集合 | 删除带二次确认，可整组删除文件夹 | 必须 | 是 | 需自研 |
| 集合内搜索 | 按名称/URL 过滤集合与历史 | 必须 | 是 | 需自研 |
| 多标签页 | 同时打开多个请求标签，标签间状态（草稿/响应）互不干扰，可关闭标签 | 必须 | 是 | 需自研（"好用"关键项） |
| 本地持久化 | 集合/历史/环境存到用户数据目录下的单个 SQLite 文件，重启不丢 | 必须 | 是 | mygo 直接支撑（SQLite 插件，文件限 `mygo.PathUserData`）；表结构需自研 |
| 启动恢复 | 启动时恢复上次打开的标签与正在编辑的草稿 | 可选 | 是 | 需自研（简单本地状态文件） |
| 拖拽排序 | 集合内请求与文件夹拖拽重排 | 可选 | 否 | 需自研 |

## 3.5 环境变量与插值

| 功能 | 说明 | 优先级 | 首版 | 实现归属 |
| --- | --- | --- | --- | --- |
| 环境与变量表 | 维护多套环境（如开发/测试/预发），每套是键值表，可切换当前环境 | 必须 | 是 | 需自研 |
| `{{变量}}` 插值 | URL、头、体、查询参数中写 `{{host}}` 之类占位符，发送前替换 | 必须 | 是 | 需自研 |
| 未定义变量告警 | 检测到未定义的 `{{xx}}` 时高亮并在发送前提示 | 必须 | 是 | 需自研 |
| 变量名自动补全 | 输入 `{{` 时弹出当前环境变量名候选 | 必须 | 是 | 需自研（"好用"关键项） |
| 动态变量 | `{{$timestamp}}`、`{{$uuid}}`、`{{$randomInt}}` 等生成值 | 可选 | 是 | 需自研（简单替换函数） |
| 全局变量 | 不随环境切换的公共变量（如固定 token） | 可选 | 是 | 需自研 |
| 敏感变量遮罩 | 标记为敏感的变量在界面上打码显示 | 可选 | 否 | 需自研 |
| 变量值内嵌引用 | 变量的值里引用其他变量（`{{a}}` 的值含 `{{b}}`） | 可选 | 否 | 需自研 |

## 3.6 导入导出与其他格式

| 功能 | 说明 | 优先级 | 首版 | 实现归属 |
| --- | --- | --- | --- | --- |
| 自有格式导入/导出 | 一键导出全部集合与环境为单个 JSON，可再导入还原（备份与迁移） | 必须 | 是 | 需自研（序列化）；mygo 直接支撑（`mygo.Dialog.Open/Save`） |
| 导入 Postman Collection v2.1 | 兼容他人分享的集合 | 可选 | 否 | 首版不做（需自研解析，变量语义映射复杂；有 cURL 导入替代） |
| 导入 OpenAPI / Swagger | 按接口文档批量生成请求 | 可选 | 否 | 首版不做（需自研解析） |
| 导入 HAR | 从浏览器 DevTools 导出的会话文件回放请求 | 可选 | 否 | 首版不做（需自研解析） |
| 导出代码片段 | 复制为 Go / JS(fetch) 等语言的调用代码 | 可选 | 否 | 需自研（模板生成） |

## 3.7 交互效率与桌面体验

| 功能 | 说明 | 优先级 | 首版 | 实现归属 |
| --- | --- | --- | --- | --- |
| 键盘快捷键 | Ctrl+Enter 发送、Ctrl+S 保存、Ctrl+N 新建请求、Ctrl+F 查找响应、Esc 取消当前请求 | 必须 | 是 | 需自研（webview 键盘事件） |
| 请求/响应分栏可拖拽 | 上下/左右分栏，分隔条可拖动调整比例 | 必须 | 是 | 需自研（布局） |
| 首次打开引导 | 空状态页提示"粘贴 cURL 或新建一个请求"，点击可直达对应操作 | 必须 | 是 | 需自研（"好用"关键项） |
| 深色 / 浅色跟随系统 | 界面跟随系统主题自动切换 | 必须 | 是 | mygo 直接支撑（webview 内 `light-dark()`；窗口 `BackgroundColor` 已用 `light-dark(#f4f5f7, #0d0e12)`） |
| 窗口位置与大小记忆 | 记住上次窗口位置、尺寸 | 必须 | 是 | mygo 直接支撑（`WindowOptions.StateKey`，脚手架已配 `"main"`） |
| 命令面板（Ctrl+K） | 快速搜索集合、历史、环境并跳转 | 可选 | 是 | 需自研（"好用"关键项） |
| 侧边栏折叠 | 集合/历史侧边栏可收起，给编辑区更多空间 | 可选 | 是 | 需自研 |
| 长请求完成通知 | 窗口切后台后请求完成弹系统通知 | 可选 | 是 | mygo 直接支撑（`mygo.NewNotification`） |
| 全局快捷键唤起 | 系统级快捷键呼出/隐藏窗口 | 可选 | 否 | mygo 直接支撑（Launchers） |
| 自动更新 | 从签名发布更新自身 | 可选 | 否 | mygo 直接支撑（Updater 插件 + `mygo keygen`） |

## 3.8 首版明确不做（能力边界）

以下能力在首版明确排除，避免扩展成重量级测试平台（均与"轻量、纯本地"目标冲突或需大改架构，后续版本若用户明确需要再评估）：

- 请求录制代理（挂系统代理抓取其他客户端流量）——需自研，改动大。
- 脚本与断言（Postman Tests 式前后置脚本与断言）——mygo 无脚本运行时，需自研。
- WebSocket / gRPC / MQTT 调试——WebSocket 有官方插件可支撑，其余需自研；首版只做 HTTP(S)。
- 团队协作与云同步——与"纯本地"硬约束冲突，明确不做。
- 账号与登录系统、多设备同步——同上，不做。
- 接口文档自动生成与分享——超出"API 调试工具"定位。
- 压测 / 性能测试——超出精简定位。

## 3.9 首版范围小结

功能表共 68 条：首版做 51 条（必须 45 + 可选但纳入首版的增强 6），首版不做 17 条。另有 3.8 列出的 7 项能力边界（录制代理、脚本断言、非 HTTP 协议、云同步协作、账号体系、文档生成、压测）不计入条目，属明确排除。

- **首版必做（45 条）**
  - 请求构建与发送（12）：方法与 URL 编辑、URL 粘贴智能解析、查询参数表格、请求头表格、JSON/纯文本体、表单体、认证辅助、取消请求、Cookie 会话保持、超时设置、重定向策略、跟随系统代理。
  - cURL 导入与导出（6）：粘贴导入、参数覆盖、多行与引号处理、导入预览与确认、导入失败定位、从请求生成 cURL。
  - 响应查看（7）：状态码与耗时、响应体格式化、响应体搜索、响应头列表、复制响应体、网络错误友好提示、响应体保存为文件。
  - 集合与历史（10）：请求历史、历史管理、集合与文件夹、命名与重命名、保存/另存为、复制请求、删除带确认、集合内搜索、多标签页、本地持久化。
  - 环境变量（4）：环境与变量表、`{{变量}}` 插值、未定义变量告警、变量名自动补全。
  - 导入导出（1）：自有格式导入/导出。
  - 交互与体验（5）：键盘快捷键、分栏可拖拽、首次打开引导、深色/浅色跟随、窗口记忆。
- **首版纳入的可选增强（6 条）**：启动恢复、动态变量、全局变量、命令面板（Ctrl+K）、侧边栏折叠、长请求完成通知。
- **首版不做（17 条）**：二进制直传体、自定义代理、忽略 TLS、批量导入多条 cURL、大响应流式、图片/二进制预览、分阶段耗时、重定向链路、拖拽排序、敏感变量遮罩、变量内嵌引用、导入 Postman v2.1、导入 OpenAPI、导入 HAR、导出代码片段、全局快捷键唤起、自动更新。
- **“能用、好用”的判定线**：能用 = 以下验收链路全通；好用 = 多标签页 + 快捷键 + 变量补全 + 命令面板四项到位（否则每次改参都要重新拉一遍侧边栏）。
- **一句话验收标准（首版闭环）**：双击启动 → 空状态页提示粘贴 cURL → 粘贴浏览器复制来的 curl 自动解析出方法与头体 → 发送并看到格式化响应、响应头、耗时 → 改个环境变量再发一次 → Ctrl+S 存进集合 → 一键复制为 cURL 分享 → 关掉重开，集合与历史仍在 → 导出 JSON 备份并成功导入还原。以上全通即首版达标。

## 3.10 cURL 解析器实现选型建议

cURL 解析是首版核心能力，实现归属为"需自研或引入开源库"。按项目规则先做开源调研，候选如下。若不新增依赖，按 3.2 第二条的覆盖范围自研轻量解析器；是否引入第三方库属新依赖决策，由用户拍板。

| 方案 | 说明 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 自研轻量解析器 | 仅覆盖 3.2 表格中的常见参数子集（DevTools "Copy as cURL (bash)" 产物即此子集） | 零依赖、体积最小、行为完全可控、出错提示可定制中文 | 极端参数（如 `$'...'` 复杂转义）需逐步补 |
| `curlconverter`（MIT，周下载 63K） | 可转 JSON/HAR/多语言，功能最全、社区验证最多 | 覆盖所有参数、出错少 | 依赖 tree-sitter/lossless-json，包体大（重），对一个调试工具偏重 |
| `@scrape-do/curl-parser`（MIT，0 依赖，25KB） | 专用 curl → JS 对象解析器，维护活跃 | 轻量、无依赖、专做解析 | 参数覆盖不如 curlconverter，需验证是否满足 3.2 覆盖表 |
| `curl-parser-ts`（MIT，周下载 2.9K） | 解析 method/url/data/params | 轻量 | 覆盖更窄（无 Cookie/引号转义等），大概率不满足 |

**建议**：第一版先采用"自研轻量解析器 + 从 `@scrape-do/curl-parser` 或 curlconverter 中做参考"，不引入重依赖；若用户倾向直接用开源库，推荐 `curlconverter`（正确性优先）或 `@scrape-do/curl-parser`（轻量优先）。该项不影响其他功能的实现顺序。

---

## 3.11 实现落地情况

第三章清单已按首版范围（必须 45 条 + 可选增强 6 条）全部实现，代码位置：

| 层 | 路径 | 内容 |
| --- | --- | --- |
| Go 桌面壳 | `main.go` | 窗口、Cookie 罐开关、剪贴板、文件选择/保存、旧工作区迁移（`workspace.json` → `workspace.db`）、系统通知、打开数据目录；`mygo.Use(fetch.New(...))` 挂 Go 侧 HTTP 客户端（跟随系统代理）、`mygo.Use(sqlite.Plugin)` 挂 SQLite |
| 请求/状态层 | `src/store.ts` | 标签页、集合树、历史、环境与全局变量、插值、发送与取消、持久化 |
| 存储层 | `src/db.ts` | SQLite 建表、整库读回、按差异提交的写回（WAL + 事务）、旧 JSON 一次性迁移 |
| cURL | `src/curl.ts` | 自研轻量解析器与 cURL 生成器（3.10 的方案一） |
| 界面 | `src/main.ts`、`src/ui/*`、`src/style.css` | 外壳、请求/响应/侧边栏面板、浮层、命令面板、设计系统 |

验证：`npm run typecheck`、`npm run build:web`、`go build ./...`、`npx mygo-cli generate`、`npx mygo-cli vet .`、`npx mygo-cli build -skip-installer`（产物 11.2 MB）均通过；`npx mygo-cli dev` 可正常起窗口。使用方法与快捷键见仓库根目录 `README.md`。

---

# 附录：常用命令速查

```bash
npm install                      # 装前端依赖（本机无 Bun，代替 bun install）
npx mygo-cli doctor              # 环境体检
npx mygo-cli generate            # 重新生成 src/mygo.ts（改了 Go 绑定后必跑）
npx mygo-cli dev                 # 开发：Vite(5173) + 开发版窗口，改 Go/Vite 自动重建
npx mygo-cli vet .               # go vet + 原生 UI 构建寿命检查
npm run typecheck                # 前端类型检查
npm run build:web                # 只构建前端到 dist/
npx mygo-cli build -skip-installer   # 打包（Windows 只出 exe；去掉参数则含 NSIS 安装包）
npx mygo-cli install-skills .    # 更新 .agents/skills/（会覆盖内置 skill 的本地改动）
```

产物位置：前端 `dist/`、开发态 `.mygo/dev/<goos>-<goarch>/`、打包 `build/<os>-<arch>/`。三者均已在 `.gitignore` 中忽略。
