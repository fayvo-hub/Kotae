# MyGo API

纯本地的轻量级 Postman：请求构建、发包、响应查看、集合与历史管理全部在这台机器上完成，不连云端、不需要后端服务。界面文案全部中文。

技术形态：Go 写桌面壳（[MyGo](https://mygo.egoist.dev/)）+ 系统 webview 里的 Vite/TypeScript 前端，HTTP 请求由 Go 侧发出（借 MyGo 的 fetch 插件），因此不受浏览器 CORS 限制，可以任意设置请求头与 Cookie。

设计取舍与功能清单见 `docs/mygo-调研与功能清单.md`；**界面规范见 `docs/设计系统.md`**（改 UI 前的权威依据，`npm run lint:ui` 检查硬编码色值/字号/圆角/阴影）。

## 功能

- **请求构建**：GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS；查询参数与请求头表格（启用开关、批量粘贴——打开时预填当前行、行首加 `#` 即禁用、取消不改数据、清空内容即清空表格、同名键全发送）；请求体支持 JSON / 纯文本 / 表单编码 / 含文件的 multipart 表单；认证支持 Bearer、Basic、API Key（头部或查询串）；逐请求超时、重定向策略（跟随/手动/报错）、Cookie 开关。
- **发送与取消**：发送中可取消；窗口不在前台时用系统通知提示完成。
- **cURL 互转**：粘贴整条 cURL 命令自动还原成请求（也支持粘贴到地址栏直接识别）；任意请求可一键复制成 cURL。
- **响应查看**：状态码/耗时/大小/类型；JSON 结构化折叠树（前 3 层默认展开，可一键展开全部/收起全部）与原始文本双视图，HTML/XML 高亮；响应体关键词高亮查找；响应头筛选与逐条复制；响应体保存到本地文件。
- **集合与历史**：集合/文件夹/请求三级树，重命名、复制、删除；标签页多开、脏标记、保存与另存；最近 200 条历史，可单条删除或清空。
- **环境变量与插值**：多环境 + 全局变量，`{{name}}` 插值，内置动态变量（`{{$timestamp}}`、`{{$uuid}}`、`{{$randomInt}}` 等）；输入时的变量补全；未定义变量在发送前拦下提示。顶栏的环境胶囊左侧点击展开下拉（切换环境、新建环境、进入管理），右侧的编辑按钮直达变量面板；请求区子页签行右侧也有一枚同款胶囊。
- **地址栏**：支持 `{{变量}}` 模板，变量片段带底色与悬停提示（悬停可看到解析后的值与未定义项），下方「实际地址」随输入实时更新；失焦不会改写你写的地址，协议只在发请求时按解析结果兜底（`{{baseUrl}}` 自带 `https://` 时不会被拼成双协议）。
- **导入导出**：工作区备份导出为 JSON、导入时合并到现有数据。
- **交互效率**：命令面板（Ctrl+K）、快捷键、可拖拽侧边栏与响应区分割、跟随系统/浅色/深色主题、首次启动引导页。

## 开发

```bash
npm install                 # 安装前端依赖
npm run generate            # 生成 src/mygo.ts（Go 方法 → TypeScript 客户端）
npm run dev                 # mygo dev：起 Vite + 编译并启动应用窗口
npm run typecheck           # TypeScript 类型检查
npm run build               # 产出 build/<os>-<arch>/（Windows 含 NSIS 安装包）
npx mygo-cli build -skip-installer   # 只出可执行文件，跳过安装包
npx mygo-cli vet .          # go vet + 原生 UI 生命周期检查
```

修改 Go 侧公开方法后必须重跑 `npm run generate`，否则前端拿到的客户端类型是旧的。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| Ctrl+Enter | 发送请求 |
| Ctrl+N | 新建请求标签页 |
| Ctrl+S | 保存请求到集合 |
| Ctrl+Shift+N | 新建集合 |
| Ctrl+I | 导入 cURL |
| Ctrl+Shift+C | 复制当前请求为 cURL |
| Ctrl+K | 命令面板 |
| Ctrl+E | 环境变量 |
| Ctrl+B | 收起/展开侧边栏 |
| Ctrl+F | 在响应体中查找 |
| Ctrl+W | 关闭当前标签页 |
| Ctrl+, | 设置 |
| Esc | 关闭浮层 / 取消发送中的请求 |

## 数据存储

存储层是 SQLite：整个工作区（集合、文件夹、请求、历史、环境与变量、标签页、界面偏好、是否关闭到托盘）都落在一个文件里——MyGo userData 目录下的 `workspace.db`。路径可在「设置 → 关于」看到，并可用同行的「打开数据目录」直接打开。

- 驱动是 MyGo 的 sqlite 插件（`@mygo-plugins/sqlite` + Go 侧 `mygo.Use(sqlite.Plugin)`）：预编译的 sqlite3 通过 purego 加载，不需要 cgo；`mygo dev` / `mygo build` 会把对应平台的原生库打进产物，想换自编译版本可用环境变量 `MYGO_SQLITE_LIBRARY` 指定。
- 建表语句在 `src/db.ts` 的 `SCHEMA` 里：`collections` / `folders` / `requests` / `history` / `environments` / `variables` / `tabs` / `settings` / `meta`。集合树的层级与顺序由 `position` 列还原，文件夹与请求共用一个序号空间。
- 写入用 WAL 模式 + `busy_timeout`，每次保存只提交与上次快照不同的行（`INSERT … ON CONFLICT DO UPDATE` 与按主键 `DELETE`），整批包在一个 `BEGIN IMMEDIATE` 事务里；界面上的连续编辑由 220ms 防抖合批。
- 从旧版本升级时，首次启动会把 `workspace.json` 读进来迁进数据库，然后把原文件改名成 `workspace.json.bak`（不删除；解析失败则跳过迁移并在界面提示）。桌面的 `desktop.json` 已经取消，偏好并入 `settings` 表。
- 整个数据目录可以删掉，应用会从头开始。

## 测试

端到端测试在 `e2e/`，用真实二进制、真实窗口跑，不依赖浏览器自动化库：应用在 `-tags e2e` 构建下链接 MyGo 的 Automation 插件，测试通过本机 Unix socket 驱动页面（`eval` 执行脚本、`capture` 截图）、点系统菜单、再启动第二个实例模拟双击图标与深链。

```bash
npm run e2e                        # 跑全部用例：先构建前端，再编译 e2e 二进制并启动
npm run e2e:verbose                # 带每个用例的输出与截图名称
MYGO_E2E_SKIP_BUILD=1 npm run e2e  # 前端没改动时跳过 npm run build:web
MYGO_E2E_KEEP=1 npm run e2e        # 保留临时目录（含应用日志）便于事后排查
MYGO_E2E_PACKAGING=1 npm run e2e   # 追加验证打包产物：跑一次 mygo build，断言界面来自二进制
```

覆盖率（30 个用例）：首屏与固定数据加载、GET/POST 发送与保真（方法、头、查询串、认证）、重定向、错误状态码、超时中文提示、未定义变量拦截、纯文本与二进制响应、Cookie 罐、cURL 导入与导入后发送、保存对话框与新建集合、环境变量面板、环境胶囊下拉与编辑入口、地址栏变量高亮与不自动补协议、命令面板、主题切换、历史记录、批量粘贴对话框（多行输入、Enter 换行、点遮罩不关闭、Ctrl+Enter 提交、预填已有行与 `#` 禁用、不改内容时点取消或确定都不改动数据）、表单文件行的删除按钮不与文件按钮重叠、页面无未捕获错误；存储层：`workspace.json` 一次性迁移成 `workspace.db`、新建集合后连续重启两次数据仍在（证明写的是数据库而不是内存）；以及桌面层：深链导入、系统菜单新建请求、关闭到托盘后从第二个实例恢复窗口。

固定测试数据在 `e2e/fixtures/workspace.json`，只在 e2e 里用（以旧版 JSON 工作区的形式投喂，启动时走一次真实的迁移路径）：测试每次复制到临时目录作为 userData 再启动应用，占位符 `__BASE_URL__` 会替换成本地桩服务的随机端口，所以不会碰到你本机的工作区。桩服务在 `e2e/echo.go`（回显请求、慢响应、重定向、错误码、Cookie、二进制、文本）。截图写到 `e2e/artifacts/`（已 gitignore）。

## 桌面集成

- **菜单栏**：文件（新建请求 Ctrl+N、导入 cURL Ctrl+I、保存到集合 Ctrl+S、收起/展开侧边栏 Ctrl+B、关闭当前标签页 Ctrl+W、关闭窗口 Ctrl+Shift+W、退出）、编辑（撤销/重做/剪切/复制/粘贴/删除/全选，用系统 Role 保留输入框语义）、视图（命令面板 Ctrl+K、管理环境 Ctrl+E、设置 Ctrl+,、切换深色/浅色、重新加载界面、开发者工具、缩放、全屏）、帮助（关于 MyGo API、打开数据目录）。菜单项把动作作为 `desktop:command` 事件发给页面，页面复用同一套 store 逻辑，快捷键与页面内的监听不会打架。Ctrl+W 留给标签页、关窗口退到 Ctrl+Shift+W，是浏览器里养成的肌肉记忆。
- **分栏**：侧边栏宽度与响应区高度可拖拽，双击分隔条复位到默认值（288px / 340px）；拖拽范围与读回数据库时的钳制范围一致，重启不会把尺寸悄悄改掉。
- **托盘**：托盘菜单提供显示主窗口、新建请求、导入 cURL、关闭到托盘开关、退出。关闭窗口时按该开关隐藏窗口而不是退出（默认开启），偏好存在数据库的 `settings` 表里，启动时由页面交给 Go 侧。Linux 需要 `libayatana-appindicator3`，未安装时托盘创建失败会被记日志，应用其余部分照常工作。
- **单实例与深链**：第二次启动不会开新窗口，参数转给已在运行的实例。支持 `mygo-api://new`、`mygo-api://settings`、`mygo-api://import?curl=<URL 编码的 cURL>`，最后一种会直接把命令送进导入浮层并自动解析。
- **关于面板**：走系统标准面板（`ShowAboutPanel`），应用名与版本取自构建时的配置。

## 打包与安装

元数据都在 `mygo.config.ts`：`name`（用户看到的名字，安装包与快捷方式用它）、`slug`（安装包文件名、Debian 包名等纯 ASCII 场景）、`identifier`（系统登记用的反向域名）、`icon`、`windows.displayName` / `windows.installDirName`（Windows 显示名与 `%LOCALAPPDATA%\Programs\MyGoAPI` 目录名）、`linux.*`（Debian 包与 desktop 条目）、`urlSchemes`（深链）。

```bash
npm run build                         # build/windows-amd64/：MyGo API.exe + mygo-api-setup-0.1.0-amd64.exe
npx mygo-cli build -skip-installer    # 只要可执行文件
npx mygo-cli build -platform linux/amd64,darwin/universal   # 交叉编译（需要各平台的打包工具）
```

Windows 安装包是 NSIS 做的按用户安装：装到 `%LOCALAPPDATA%\Programs\MyGoAPI`，建开始菜单快捷方式，完成页可勾选桌面快捷方式，卸载项出现在「设置 → 应用」（显示名、版本、发布者取自上面的配置）。支持 `/S` 静默安装，卸载同样支持 `/S`；卸载会删掉程序目录、快捷方式与卸载注册项，**不会删** userData 里的工作区数据——那是用户资产，需要的话自己删。NSIS 未安装时 mygo 会自己下载一份。SQLite 的原生库（Windows 上是 `mygo-sqlite3.dll`，约 1.4 MB）由 `mygo build` 自动放到可执行文件旁边并一起打进安装包，所以安装后的目录里有它，不用额外装数据库。macOS 出 `.app` 与 `.dmg`，Linux 出可执行文件、`.deb`、`.tar.gz`（含 install.sh）与 PKGBUILD。

签名与更新：

- Windows 代码签名：在 `mygo.config.ts` 里配 `windows.certificate`（.pfx 路径）并设置环境变量 `MYGO_WINDOWS_CERTIFICATE_PASSWORD`，时间戳服务用 `windows.timestampUrl`；也可以改用 `windows.signCommand`（`%1` 是待签文件路径）。
- macOS 签名与公证：`macos.signingIdentity` + `macos.notarize.keychainProfile`。
- 自动更新：配好 `updates`（`publicKey` + `github`/`url`，`mygo keygen` 生成密钥）后，构建会额外产出签名更新包与 `update-<platform>.json`。当前版本没有配置更新通道，发布前再补。

图标由 `scripts/make-icons.py` 生成（需要 Pillow）：`python scripts/make-icons.py` 会重写 `resources/icon.png`（1024×1024 应用图标）与 `resources/tray.png`（32×32 托盘图标），两者是同一套品牌渐变加 `>_` 字形，改配色只改脚本顶部的两个颜色常量。
