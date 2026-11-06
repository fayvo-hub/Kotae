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
  windows: {
    // Windows 各处显示的名字（快捷方式、设置 > 应用）用带空格的大写形态。
    displayName: "MyGo API",
    // %LOCALAPPDATA%\Programs 下的目录名保持纯 ASCII，避免中文/空格路径出问题。
    installDirName: "MyGoAPI",
  },
  linux: {
    maintainer: "MyGo API <mygo-api@users.noreply.github.com>",
    comment: "轻量的本地 HTTP 调试工具，请求、集合与环境变量全部留在本机",
    categories: ["Development", "Utility"],
    command: "mygo-api",
  },
});
