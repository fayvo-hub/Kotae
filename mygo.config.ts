import { defineConfig } from "mygo-cli";

export default defineConfig({
  // 用户看到的名字：窗口标题、开始菜单、安装器、设置里的应用列表都用它。
  name: "Kotae",
  // 文件系统里必须用纯 ASCII 的地方（安装包文件名、Debian 包名、desktop 条目）。
  slug: "kotae",
  identifier: "com.kotae.app",
  version: "0.2.1",
  copyright: "© 2025 Kotae",
  publisher: "Kotae",
  icon: "resources/icon.png",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  // 本机未安装 Bun，改用 npm 驱动 Vite（mygo 只要求 devUrl 能应答、
  // buildCommand 产出 frontendDist，用什么包管理器由项目自己决定）。
  devUrl: "http://localhost:5173",
  devCommand: "npm run dev:web",
  buildCommand: "npm run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
  // 深链：`kotae://import?curl=…` 交给 App.OnOpenURL，再转成导入浮层。
  urlSchemes: ["kotae"],
  // 双击 .har 文件直接用本应用打开并进入导入浮层。只关联 HAR 这一类抓包文件：
  // 抢 .json 的默认打开方式会干扰用户其他工具。
  // ext 是数组（同一种文件可以有多个扩展名）。不写 mimeType 时 mygo 会注册
  // application/x-kotae-har 这个应用私有类型，避免抢走系统的 application/json。
  fileAssociations: [{ ext: ["har"], name: "HAR 抓包文件", role: "Editor" }],
  windows: {
    // Windows 各处显示的名字（快捷方式、设置 > 应用）用首字母大写的形态。
    displayName: "Kotae",
    // %LOCALAPPDATA%\Programs 下的目录名保持纯 ASCII，避免中文/空格路径出问题。
    installDirName: "Kotae",
  },
  // ---- 自动更新：已启用 ----
  // publicKey 是 `npx mygo-cli keygen` 生成的公钥，私钥只在发布机上（CI secret
  // MYGO_UPDATER_PRIVATE_KEY）。tagPrefix 默认 "v"，与本仓库的 v0.2.1 这类标签一致。
  // 读发布说明：仓库根目录 CHANGELOG.md 里 `## 0.2.1` 那一段。
  // github 是 GitHub 上的仓库路径，与应用名无关。
  updates: {
    publicKey: "udSJM9PEbjCiDLdSIadYODhlRzSi/UM1sOEutcoc6FU=",
    github: "fayvo-hub/Kotae",
    tagPrefix: "v",
    changelog: "CHANGELOG.md",
  },
  // ---- 代码签名：仍未启用 ----
  // 需要真实证书，仓库里不存放。启用后 Windows 上的 SmartScreen 才会放行。
  // windows: {
  //   certificate: "证书.pfx",              // 密码走 MYGO_WINDOWS_CERTIFICATE_PASSWORD
  //   timestampUrl: "http://timestamp.digicert.com",
  // },
  // macos: {
  //   signingIdentity: "Developer ID Application: …",
  //   notarize: { keychainProfile: "AC_PASSWORD" },
  // },
  linux: {
    maintainer: "Kotae <kotae@users.noreply.github.com>",
    comment: "轻量的本地 HTTP 调试工具，请求、集合与环境变量全部留在本机",
    categories: ["Development", "Utility"],
    command: "kotae",
  },
});
