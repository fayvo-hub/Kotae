package main

import (
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// toggleJar 是一个可以整体开关的 Cookie 罐：界面上关闭「保持 Cookie」时，
// 请求不再携带、也不再记录 Cookie；关闭时清空已保存的 Cookie。
//
// 除了真正参与请求的 cookiejar，它还自己记一份清单，用来支持在界面上
// 浏览与逐条删除 Cookie —— 标准库的 cookiejar 只提供 SetCookies/Cookies，
// 没法枚举。
type toggleJar struct {
	mu      sync.Mutex
	jar     http.CookieJar
	open    bool
	records map[string]CookieRecord
}

func newToggleJar() *toggleJar {
	jar, err := cookiejar.New(nil)
	if err != nil {
		log.Printf("创建 Cookie 罐失败：%v", err)
	}
	return &toggleJar{jar: jar, open: true, records: map[string]CookieRecord{}}
}

func (j *toggleJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.open || j.jar == nil {
		return
	}
	j.jar.SetCookies(u, cookies)
	for _, c := range cookies {
		record, expired := recordOf(u, c)
		key := record.key()
		if expired {
			delete(j.records, key)
			continue
		}
		j.records[key] = record
	}
}

func (j *toggleJar) Cookies(u *url.URL) []*http.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.open || j.jar == nil {
		return nil
	}
	return j.jar.Cookies(u)
}

// reset 换上一个空的 Cookie 罐。
func (j *toggleJar) reset() {
	jar, err := cookiejar.New(nil)
	if err != nil {
		log.Printf("创建 Cookie 罐失败：%v", err)
		return
	}
	j.mu.Lock()
	j.jar = jar
	j.records = map[string]CookieRecord{}
	j.mu.Unlock()
}

func (j *toggleJar) setOpen(open bool) {
	j.mu.Lock()
	j.open = open
	j.mu.Unlock()
	if !open {
		j.reset()
	}
}

// list 返回当前保存的 Cookie，按域名 / 路径 / 名字排序，界面上顺序才稳定。
func (j *toggleJar) list() []CookieRecord {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]CookieRecord, 0, len(j.records))
	for _, r := range j.records {
		out = append(out, r)
	}
	sort.Slice(out, func(a, b int) bool {
		if out[a].Domain != out[b].Domain {
			return out[a].Domain < out[b].Domain
		}
		if out[a].Path != out[b].Path {
			return out[a].Path < out[b].Path
		}
		return out[a].Name < out[b].Name
	})
	return out
}

// remove 删掉单条 Cookie：清单里直接删，同时给 jar 塞一个已过期的同位置
// Cookie，让后续请求也不再带上它。
func (j *toggleJar) remove(name string, domain string, path string) bool {
	j.mu.Lock()
	if j.records == nil {
		j.mu.Unlock()
		return false
	}
	found := false
	for key, r := range j.records {
		if r.Name == name && r.Domain == domain && r.Path == path {
			delete(j.records, key)
			found = true
		}
	}
	jar := j.jar
	j.mu.Unlock()
	if !found {
		return false
	}
	if jar != nil {
		scheme := "https"
		target := &url.URL{Scheme: scheme, Host: domain, Path: path}
		jar.SetCookies(target, []*http.Cookie{{
			Name:   name,
			Value:  "",
			Path:   path,
			Domain: domain,
			MaxAge: -1,
		}})
	}
	return true
}

// CookieRecord 是界面上看到的一条 Cookie。Expires 用毫秒时间戳，0 表示会话
// Cookie（关应用就没了）。
type CookieRecord struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Secure   bool   `json:"secure"`
	HttpOnly bool   `json:"httpOnly"`
	HostOnly bool   `json:"hostOnly"`
	Expires  int64  `json:"expires"`
}

func (r CookieRecord) key() string {
	return r.Domain + "\x00" + r.Path + "\x00" + r.Name
}

// recordOf 把 http.Cookie 归一成一条记录，并判断它是不是「删除」语义
// （MaxAge < 0 或已过期）。
func recordOf(u *url.URL, c *http.Cookie) (CookieRecord, bool) {
	record := CookieRecord{
		Name:     c.Name,
		Value:    c.Value,
		Domain:   c.Domain,
		Path:     c.Path,
		Secure:   c.Secure,
		HttpOnly: c.HttpOnly,
		HostOnly: c.Domain == "",
	}
	if record.Domain == "" {
		record.Domain = u.Hostname()
	}
	record.Domain = strings.ToLower(strings.TrimPrefix(record.Domain, "."))
	if record.Path == "" {
		record.Path = "/"
	}
	expired := c.MaxAge < 0
	if !c.Expires.IsZero() {
		record.Expires = c.Expires.UnixMilli()
		if c.Expires.Before(time.Now()) {
			expired = true
		}
	}
	return record, expired
}

// Cookies 返回当前 Cookie 罐里的全部 Cookie。界面上的「Cookie 管理器」用它。
func (s *System) Cookies() []CookieRecord {
	if s.jar == nil {
		return nil
	}
	return s.jar.list()
}

// DeleteCookie 删掉一条 Cookie；域名与路径同时匹配才算同一条。
func (s *System) DeleteCookie(name string, domain string, path string) error {
	if s.jar == nil {
		return nil
	}
	if path == "" {
		path = "/"
	}
	s.jar.remove(name, strings.ToLower(domain), path)
	return nil
}
