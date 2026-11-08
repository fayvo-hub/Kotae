---
name: mygo-release
description: 给 MyGo 桌面应用发版：打 tag 触发 GitHub Actions 并行构建 Windows 安装包/免安装 exe 与 macOS dmg，自动挂到 GitHub Release，并核对资产。当用户说「发版」「发布新版本」「打个 tag」「出安装包」「重新发同一版本」「Release 里没文件/名字不对」「发布流水线红了」时使用。覆盖版本对齐、发布前闸门、推送与打标签、资产命名规则、Release 核对、重发与失败排查。
---

# Kotae 发版

本仓库的发布是一条单行道：`main` 上全绿 → 打 `vX.Y.Z` 标签 → GitHub Actions 并行构建 → Release 自动挂产物。
**不要手工上传安装包，不要本地凑 dmg**（`mygo build` 的说明写明磁盘镜像需要 macOS）。

## 本仓库的固定事实

| 项 | 值 |
| --- | --- |
| 远端 | `origin` = `https://github.com/fayvo-hub/Kotae.git`（仓库原名 `mygo-api`，GitHub 上 301 重定向，本地 remote 已改到新名） |
| 版本号唯一真源 | `mygo.config.ts` 的 `version`（`slug` = `kotae` 决定产物名） |
| 发布流水线 | `.github/workflows/release.yml`（`push: tags: v*` 或手动触发） |
| 构建矩阵 | Windows `windows/amd64`、macOS `darwin/universal`，`fail-fast: false` |
| Release 产物 | `kotae-setup-<版本>-amd64.exe`、`kotae-<版本>-portable.exe`、`kotae-<版本>.dmg` |
| 网络 | 直连 github.com 会超时；git 已在本仓库配 `http.proxy`，`curl` 要显式加 `--proxy` |

## 发版步骤

### 1. 对齐版本号

改 `mygo.config.ts` 的 `version`（tag 只决定 Release 名字，产物名来自这个字段，两者必须一致）。
仓库里还有几处写死的版本号，发版时**一起改**（已核对过的清单）：

| 文件 | 位置 | 要不要改 |
| --- | --- | --- |
| `mygo.config.ts` | `version:` | 要，它是唯一真源 |
| `README.md` | 「下载」示例路径、「发布」小节里的 `git tag` 示例 | 要 |
| `docs/设计系统.md` | 第 1 行标题里的版本号 | 要 |
| `AGENTS.md` | 第 3 行「已发首版 0.1.0」 | 要 |
| `docs/mygo-调研与功能清单.md` | 调研时的命令输出与配置片段 | **不改**，它是历史归档 |

`grep -rn "<旧版本>" --include="*.ts" --include="*.go" --include="*.json" --include="*.md" . | grep -v node_modules | grep -v package-lock` 抽一遍，确认没有漏改的。

### 2. 跑发布前闸门

```bash
npm run typecheck && npm run lint:ui && go vet ./... && npx mygo-cli vet . && npm run e2e
```

- 改了打包配置、`mygo.config.ts`、图标、Go 侧 binding 时，追加 `MYGO_E2E_PACKAGING=1 npm run e2e`（验证前端真的嵌进了二进制）
- 红了就停，不要带红打 tag：Release 一旦发出，用户拿到的是坏包

### 3. 本地先打一次 Windows 包

比等 CI 快，能提前抓到 `mygo.config.ts` 的语法错误与图标缺失：

```bash
npx mygo-cli build -skip-installer
ls -lh "build/windows-amd64/Kotae.exe"
```

`build/` 已被 gitignore，产物不入库。

### 4. 提交并推送 main

提交信息中文、Conventional Commits 前缀（`chore(release): 发布 0.1.1`）。只 `git add` 本次涉及的路径。

```bash
git push origin main
```

推送超时说明代理掉了，先 `git config --get http.proxy`；没有就补 `git config http.proxy http://127.0.0.1:7897`，确保代理软件在跑。

### 5. 打标签并推送

```bash
git tag -a v0.1.1 -m "Kotae 0.1.1"
git push origin v0.1.1
```

推到标签的那一刻流水线就开始跑，两平台并行。

### 6. 核对 Release 资产

**不要用 GitHub REST API**：匿名调用会 403 限流（本机未装 `gh`）。直接抓资产列表网页：

```bash
curl -s --proxy http://127.0.0.1:7897 \
  "https://github.com/fayvo-hub/Kotae/releases/expanded_assets/v0.1.1" \
  | grep -oE "kotae[a-zA-Z0-9._-]*\.(exe|dmg)" | sort -u
```

期望**恰好三个**：setup 安装包、portable、dmg。少一个说明对应平台构建失败，去 Actions 页面看 job 日志。
从打标签到资产出齐常要 5 分钟上下（本次首发实测最后一分多钟才齐），没出齐先等，不要急着重发。

### 7. 发布后

- README「下载」表里的文件名模板要不要跟着改（版本号是占位符，通常不用动）
- 界面有可见变化时重出截图：

```bash
MYGO_E2E_SCREENSHOTS=1 go test -tags e2e ./e2e/ -run TestScreenshots -count=1
```

## 重发同一个版本

产物命名方式改了、某个平台构建挂了要重跑，都会遇到「tag 已存在」。流程：

```bash
git push origin --delete v0.1.1   # 删远端标签
git tag -d v0.1.1                 # 删本地标签
git tag -a v0.1.1 -m "Kotae 0.1.1"
git push origin v0.1.1
```

流水线的 release job 会先 `gh release delete <tag> --cleanup-tag` 清掉旧 Release，所以不会残留上一次的资产名。
**不要 `git push -f` 去改已有 tag 指向**，也不要在旧 Release 上手工删文件凑数。

## 产物命名为什么这样

- 裸可执行文件叫 `Kotae.exe`，不带版本号 → 流水线在 Windows job 里把它复制成 `kotae-<版本>-portable.exe` 再删原件，资产名一眼能看出是哪个版本
- 安装包由 `mygo build` 生成，名字是 `<slug>-setup-<版本>-<arch>.exe`，NSIS 装在 `%LOCALAPPDATA%\Programs\Kotae`（按用户安装，不需要管理员）
- dmg 名字是 `<slug>-<版本>.dmg`，`darwin/universal` 时**不带架构后缀**

## 失败排查

| 现象 | 原因与处置 |
| --- | --- |
| 流水线没触发 | 标签没推上去，或标签名不是 `v*`；`git ls-remote --tags origin` 确认 |
| Windows job 红在「打包安装包」 | 多半是 NSIS 下载失败；重跑 job 即可，`mygo build` 会自动下载 makensis |
| macOS job 红在 dmg | `-skip-notarize` 已加；若报签名相关，检查是否误配了 `macos.signingIdentity` |
| Release 只有一个平台的包 | 另一个 job 挂了；`fail-fast: false` 保证不会互相取消，去 Actions 看是哪个 |
| 资产里出现 `Kotae.exe` | 便携版改名步骤没跑到；检查 Windows job 里 `整理便携版` 的 pwsh 步骤 |
| 打包时读不到版本号 | pwsh 里用正则读 `mygo.config.ts` 的 `version:`，改配置格式（比如换成反引号）会打断它 |

## 不要做

- 不带标签就手动 `workflow_dispatch` 发正式版：那条路径会用 `v<版本>-build<run_number>` 当标签，只适合试跑
- 手工往 Release 传文件，或本地 `mygo build` 之后直接发出去
- 在未签名的情况下向用户承诺「没有安全提示」：Windows 首次运行会被 SmartScreen 拦一次，macOS 要右键「打开」
- 声称 macOS 包已验证：Windows 机器验证不了 dmg，只能确认资产存在
