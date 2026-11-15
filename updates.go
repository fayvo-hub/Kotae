package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/netproxy"
	"github.com/egoist/mygo/plugins/updater"
)

// 本文件把自动更新接进应用。
//
// 更新由 mygo 官方 updater 插件负责：它在后台每天检查一次，发现有新版本时弹自己的
// 更新窗口（发布说明、跳过此版本、下载进度、重启进入新版本），用户的偏好存在
// userData 下的 updater.json 里。我们做三件事：把插件的状态与偏好暴露给设置面板，
// 提供一个「检查更新」的入口（托盘菜单、命令面板、设置页），以及接管更新清单与更新包
// 的取法（见文件末尾的 updateSource）。
//
// 构建必须带 updates 配置（mygo.config.ts 的 publicKey + github）才谈得上更新：
// 开发版与包管理器安装的版本 mygo.Updater.Enabled() 为 false，此时一律如实告诉用户
// 「这个构建不能自我更新」，而不是假装检查。

// 免安装形态（从便携压缩包里解出来的目录）同样不能自我更新：MyGo 的 Windows 更新
// 只替换程序目录里“其它”文件、保留正在运行的可执行文件本身，单文件形态没有别的文件
// 可换，装完重启还是旧版本。安装器会把 Uninstall.exe 写进程序目录，没有它就是免安装形态。
func isPortable() bool {
	if runtime.GOOS != "windows" {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(filepath.Dir(exe), "Uninstall.exe"))
	return errors.Is(err, fs.ErrNotExist)
}

// UpdateState 是设置面板「更新」一节需要的状态。
type UpdateState struct {
	// Supported 表示这个构建能不能自我更新。
	Supported bool `json:"supported"`
	// Portable 表示这是免安装形态（从便携压缩包解出来的），此时不能自我更新。
	Portable bool `json:"portable"`
	// Available 是上次检查发现的新版本号，没有新版本时为空。
	Available string `json:"available"`
	// LastCheck 是上次检查成功的时间（Unix 毫秒），0 表示还没检查过。
	LastCheck int64 `json:"lastCheck"`
	// AutomaticChecks 是后台每天检查一次是否开启。
	AutomaticChecks bool `json:"automaticChecks"`
	// AutomaticDownloads 是「发现新版本直接下载，下次启动装好」是否开启。
	AutomaticDownloads bool `json:"automaticDownloads"`
}

// UpdateState 返回更新相关的当前状态，供设置面板渲染。
func (s *System) UpdateState() UpdateState {
	portable := isPortable()
	if !mygo.Updater.Enabled() || portable {
		return UpdateState{Portable: portable}
	}
	st := UpdateState{
		Supported:          true,
		Available:          updater.AvailableVersion(),
		AutomaticChecks:    updater.AutomaticChecks(),
		AutomaticDownloads: updater.AutomaticDownloads(),
	}
	if t := updater.LastCheck(); !t.IsZero() {
		st.LastCheck = t.UnixMilli()
	}
	return st
}

// CheckForUpdates 打开更新窗口检查新版本，用户点菜单或设置页按钮时调用。
func (s *System) CheckForUpdates() error {
	if isPortable() {
		return errors.New("免安装版不能自我更新，请到 Releases 下载新版压缩包")
	}
	if !mygo.Updater.Enabled() {
		return errors.New("这个构建没有配置更新源，无法检查更新")
	}
	updater.CheckForUpdates()
	return nil
}

// SetUpdatePrefs 保存更新偏好（后台自动检查、自动下载安装）。
func (s *System) SetUpdatePrefs(automaticChecks bool, automaticDownloads bool) error {
	if !mygo.Updater.Enabled() || isPortable() {
		return nil
	}
	updater.SetAutomaticChecks(automaticChecks)
	updater.SetAutomaticDownloads(automaticDownloads)
	return nil
}

// 以下接管更新清单与更新包的取法（mygo.Updater.SetSource，见 main.go 的接入）。
//
// mygo 自带的取法是「一次请求，失败就把原始错误交给更新窗口」：国内直连 GitHub 经常在
// 传输中途被重置，用户看到的就是一句 unexpected EOF，除了重试没别的办法。换到这一层
// 之后失败会按 updateBackoff 重试，仍然失败时给一句照着就能做的提示。签名校验仍由 mygo
// 用编进二进制的 updates.publicKey 完成，这里只负责把文件搬下来。
//
// 清单地址与 mygo build 编进二进制的是同一个（mygo.config.ts 的 updates.github，
// tagPrefix 为默认的 "v" 所以走 releases/latest）。配置里的仓库改名而这里没跟上时，
// 发布流水线的 preflight 会失败，而不是静默更新不了。
const updateFeedBase = "https://github.com/fayvo-hub/Kotae/releases/latest/download/"

// updateBackoff 是第 n 次重试前等多久：直连被重置大多是瞬时的，隔一会儿就好。
var updateBackoff = []time.Duration{500 * time.Millisecond, 1500 * time.Millisecond}

// updateTarget 是构建的目标平台名，与 mygo 写出的 update-<target>.json 对得上。
// 发布流水线的 macOS 产物只有 universal 一种，所以不按 runtime.GOARCH 取名。
func updateTarget() string {
	if runtime.GOOS == "darwin" {
		return "darwin-universal"
	}
	return runtime.GOOS + "-" + runtime.GOARCH
}

// updateSource 用应用自己的 HTTP 客户端取清单与更新包，失败会重试。
type updateSource struct {
	// feed 是清单所在目录，测试里换成 httptest 的地址。
	feed   string
	client *http.Client
}

func newUpdateSource() updateSource {
	transport := netproxy.Transport().Clone()
	// 只限等待响应头的时间：拿到响应之后的下载由调用方（mygo 下载更新包）管，
	// 不能被这里的超时掐断。
	transport.ResponseHeaderTimeout = 30 * time.Second
	return updateSource{feed: updateFeedBase, client: &http.Client{Transport: transport}}
}

// Manifest 返回本平台的更新清单；本应用没有预发布通道，prereleases 用不上。
func (s updateSource) Manifest(ctx context.Context, prereleases bool) (io.ReadCloser, error) {
	return s.fetch(ctx, s.feed+"update-"+updateTarget()+".json")
}

// Open 取出清单里指的文件：更新包或它的增量包。
func (s updateSource) Open(ctx context.Context, url string) (io.ReadCloser, error) {
	return s.fetch(ctx, url)
}

// fetch 取一个文件：网络错误与 5xx 按 updateBackoff 重试，4xx 直接返回。
func (s updateSource) fetch(ctx context.Context, rawURL string) (io.ReadCloser, error) {
	var err error
	for attempt := 0; ; attempt++ {
		var body io.ReadCloser
		var retry bool
		body, retry, err = s.get(ctx, rawURL)
		if err == nil {
			return body, nil
		}
		if !retry || attempt >= len(updateBackoff) {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(updateBackoff[attempt]):
		}
	}
	return nil, fmt.Errorf("连不上 GitHub 更新服务（%v）。请检查网络或代理后重试，也可以到 Releases 页面手动下载新版", err)
}

// get 请求一次，retryable 表示这个失败重试还有可能成功。
func (s updateSource) get(ctx context.Context, rawURL string) (body io.ReadCloser, retryable bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, false, err
	}
	// 不拿应用名当 UA：GitHub 的资产 CDN 对含非 ASCII 字节的 UA 一律回 400。
	req.Header.Set("User-Agent", "mygo-updater")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, true, err
	}
	if resp.StatusCode == http.StatusOK {
		return resp.Body, false, nil
	}
	resp.Body.Close()
	retry := resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests
	return nil, retry, fmt.Errorf("GET %s: %s", rawURL, resp.Status)
}
