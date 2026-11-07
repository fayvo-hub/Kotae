package main

import (
	"errors"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
)

// 本文件把自动更新接进应用。
//
// 更新由 mygo 官方 updater 插件负责：它在后台每天检查一次，发现有新版本时弹自己的
// 更新窗口（发布说明、跳过此版本、下载进度、重启进入新版本），用户的偏好存在
// userData 下的 updater.json 里。我们只做两件事：把插件的状态与偏好暴露给设置面板，
// 以及提供一个「检查更新」的入口（托盘菜单、命令面板、设置页）。
//
// 构建必须带 updates 配置（mygo.config.ts 的 publicKey + github）才谈得上更新：
// 开发版与包管理器安装的版本 mygo.Updater.Enabled() 为 false，此时一律如实告诉用户
// 「这个构建不能自我更新」，而不是假装检查。

// UpdateState 是设置面板「更新」一节需要的状态。
type UpdateState struct {
	// Supported 表示这个构建能不能自我更新。
	Supported bool `json:"supported"`
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
	if !mygo.Updater.Enabled() {
		return UpdateState{}
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
	if !mygo.Updater.Enabled() {
		return errors.New("这个构建没有配置更新源，无法检查更新")
	}
	updater.CheckForUpdates()
	return nil
}

// SetUpdatePrefs 保存更新偏好（后台自动检查、自动下载安装）。
func (s *System) SetUpdatePrefs(automaticChecks bool, automaticDownloads bool) error {
	if !mygo.Updater.Enabled() {
		return nil
	}
	updater.SetAutomaticChecks(automaticChecks)
	updater.SetAutomaticDownloads(automaticDownloads)
	return nil
}
