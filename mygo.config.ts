import { defineConfig } from "mygo-cli";

export default defineConfig({
  // 用户看到的名字：窗口标题、开始菜单、安装器、设置里的应用列表都用它。
  name: "MyGo API",
  // 文件系统里必须用纯 ASCII 的地方（安装包文件名、Debian 包名、desktop 条目）。
  slug: "mygo-api",
  identifier: "com.mygoapi.app",
  version: "0.1.0",
  copyright: "© 2025 MyGo API",
  publisher: "MyGo API",
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
  // 深链：`mygo-api://import?curl=…` 交给 App.OnOpenURL，再转成导入浮层。
  urlSchemes: ["mygo-api"],
  // 双击 .har 文件直接用本应用打开并进入导入浮层。只关联 HAR 这一类抓包文件：
  // 抢 .json 的默认打开方式会干扰用户其他工具。
  // ext 是数组（同一种文件可以有多个扩展名）。不写 mimeType 时 mygo 会注册
  // application/x-mygo-api-har 这个应用私有类型，避免抢走系统的 application/json。
  fileAssociations: [{ ext: ["har"], name: "HAR 抓包文件", role: "Editor" }],
  windows: {
    // Windows 各处显示的名字（快捷方式、设置 > 应用）用带空格的大写形态。
    displayName: "MyGo API",
    // %LOCALAPPDATA%\Programs 下的目录名保持纯 ASCII，避免中文/空格路径出问题。
    installDirName: "MyGoAPI",
  },
  // ---- 代码签名与自动更新：当前未启用 ----
  // 这两项都需要真实证书/密钥，仓库里不存放。要启用时取消下面的注释并补齐文件，
  // 然后按 README「发布与签名」一节验证：签名后 Windows 上的 SmartScreen 才会放行，
  // 自动更新则要求 publicKey 与私钥配对（私钥由 `npx mygo-cli keygen` 生成）。
  // windows: {
  //   certificate: "证书.pfx",              // 密码走 MYGO_WINDOWS_CERTIFICATE_PASSWORD
  //   timestampUrl: "http://timestamp.digicert.com",
  // },
  // macos: {
  //   signingIdentity: "Developer ID Application: …",
  //   notarize: { keychainProfile: "AC_PASSWORD" },
  // },
  // updates: {
  //   publicKey: "<mygo keygen 生成的公钥>",
  //   github: "owner/repo",                 // 用 GitHub Releases 作为更新源
  //   changelog: true,
  // },
  linux: {
    maintainer: "MyGo API <mygo-api@users.noreply.github.com>",
    comment: "轻量的本地 HTTP 调试工具，请求、集合与环境变量全部留在本机",
    categories: ["Development", "Utility"],
    command: "mygo-api",
  },
});
