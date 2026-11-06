//go:build e2e

package main

// 端到端测试构建才会带上自动化插件：它只在 MYGO_AUTOMATION 指向一个 Unix
// socket 时监听，通过换行分隔 JSON 驱动运行中的窗口（e2e/ 目录里的测试用它）。
// 正式构建（mygo build）没有这个标签，插件不会被编进二进制。
import _ "github.com/egoist/mygo/plugins/automation"
