// Package e2e 是 MyGo API 的端到端测试设施：一个 MyGo Automation 协议客户端，
// 加上测试用的固定数据与本地桩服务。
//
// 应用侧的自动化入口由 `MYGO_AUTOMATION` 环境变量打开（见 automation.go 的
// e2e 构建标签），协议是 Unix domain socket 上的换行分隔 JSON。页面窗口不能
// 读元素树，所以驱动方式是 eval 执行页面脚本 + capture 截图。
//
// 这个包只被 e2e 测试使用，不会编译进应用二进制。
package e2e

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// Client 是一条到自动化 socket 的连接。调用串行化：协议按行应答，
// 并发调用会让应答串位。
type Client struct {
	conn net.Conn
	rd   *bufio.Scanner
	enc  *json.Encoder

	mu   sync.Mutex
	next int
}

// Error 是服务端返回的失败，Code 是协议定义的错误码。
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

type response struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *Error          `json:"error"`
}

// Dial 连接自动化 socket。应用还没开始监听时返回错误，调用方负责重试。
func Dial(path string) (*Client, error) {
	conn, err := net.DialTimeout("unix", path, 2*time.Second)
	if err != nil {
		return nil, err
	}
	sc := bufio.NewScanner(conn)
	// 截图响应可能有几 MB，默认 64 KB 的行缓冲不够。
	sc.Buffer(make([]byte, 0, 64<<10), 64<<20)
	return &Client{conn: conn, rd: sc, enc: json.NewEncoder(conn)}, nil
}

// Close 关闭连接。
func (c *Client) Close() error { return c.conn.Close() }

// Call 发一条请求并读出它的应答，把 result 解到 out（out 可为 nil）。
func (c *Client) Call(method string, params any, out any) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.next++
	req := map[string]any{"id": c.next, "method": method}
	if params != nil {
		req["params"] = params
	}
	if err := c.enc.Encode(req); err != nil {
		return fmt.Errorf("发送 %s 失败：%w", method, err)
	}
	if !c.rd.Scan() {
		if err := c.rd.Err(); err != nil {
			return fmt.Errorf("读取 %s 应答失败：%w", method, err)
		}
		return fmt.Errorf("读取 %s 应答失败：连接已关闭", method)
	}
	var res response
	if err := json.Unmarshal(c.rd.Bytes(), &res); err != nil {
		return fmt.Errorf("解析 %s 应答失败：%w", method, err)
	}
	if res.Error != nil {
		return res.Error
	}
	if out != nil && len(res.Result) > 0 {
		if err := json.Unmarshal(res.Result, out); err != nil {
			return fmt.Errorf("解析 %s 结果失败：%w", method, err)
		}
	}
	return nil
}

// Window 是一个窗口的概况。
type Window struct {
	ID      int    `json:"id"`
	Title   string `json:"title"`
	Kind    string `json:"kind"`
	URL     string `json:"url"`
	Focused bool   `json:"focused"`
	Visible bool   `json:"visible"`
	Bounds  Rect   `json:"bounds"`
}

// Rect 是窗口或元素的屏幕矩形（逻辑像素）。
type Rect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Windows 列出应用当前的窗口。
func (c *Client) Windows() ([]Window, error) {
	var out struct {
		Windows []Window `json:"windows"`
	}
	if err := c.Call("windows", struct{}{}, &out); err != nil {
		return nil, err
	}
	return out.Windows, nil
}

// PageWindow 返回第一个网页窗口（kind == "page"）。
func (c *Client) PageWindow() (Window, error) {
	ws, err := c.Windows()
	if err != nil {
		return Window{}, err
	}
	for _, w := range ws {
		if w.Kind == "page" {
			return w, nil
		}
	}
	return Window{}, errors.New("应用还没有网页窗口")
}

// evalResult 是 eval 的应答：页面脚本的返回值。
type evalResult struct {
	Value json.RawMessage `json:"value"`
}

// EvalRaw 在窗口里执行脚本，返回原始 JSON 值。
func (c *Client) EvalRaw(window int, script string) (json.RawMessage, error) {
	var out evalResult
	params := map[string]any{"window": window, "script": script}
	if err := c.Call("eval", params, &out); err != nil {
		return nil, err
	}
	return out.Value, nil
}

// Eval 在窗口里执行脚本并把结果解到 out。脚本是一个表达式，
// 需要多语句时自己包成 IIFE 或返回对象字面量。
func (c *Client) Eval(window int, script string, out any) error {
	raw, err := c.EvalRaw(window, script)
	if err != nil {
		return err
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// EvalBool 执行一个布尔表达式。
func (c *Client) EvalBool(window int, script string) (bool, error) {
	var v bool
	if err := c.Eval(window, script, &v); err != nil {
		return false, err
	}
	return v, nil
}

// EvalString 执行一个字符串表达式。
func (c *Client) EvalString(window int, script string) (string, error) {
	var v string
	if err := c.Eval(window, script, &v); err != nil {
		return "", err
	}
	return v, nil
}

// EvalInt 执行一个整数表达式。
func (c *Client) EvalInt(window int, script string) (int, error) {
	var v int
	if err := c.Eval(window, script, &v); err != nil {
		return 0, err
	}
	return v, nil
}

// Capture 截图窗口，返回 PNG 字节。
func (c *Client) Capture(window int) ([]byte, error) {
	var out struct {
		PNG []byte `json:"png"`
	}
	if err := c.Call("capture", map[string]any{"window": window}, &out); err != nil {
		return nil, err
	}
	return out.PNG, nil
}

// Menu 按标签路径选择菜单项，例如 []string{"文件", "新建请求"}。
func (c *Client) Menu(window int, path ...string) error {
	return c.Call("menu", map[string]any{"window": window, "path": path}, nil)
}

// WaitFor 轮询脚本直到它返回 true，超时报最后一次的错误或超时本身。
func (c *Client) WaitFor(window int, timeout time.Duration, what, script string) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		ok, err := c.EvalBool(window, script)
		if err == nil && ok {
			return nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			if lastErr != nil {
				return fmt.Errorf("等待「%s」超时：%w", what, lastErr)
			}
			return fmt.Errorf("等待「%s」超时（%s）", what, timeout)
		}
		time.Sleep(60 * time.Millisecond)
	}
}
