package app

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"exponential-agent/internal/trailer"
)

// installInfo is what the installer shows (window or fallback message boxes).
type installInfo struct {
	Lang    string `json:"lang"`
	State   string `json:"state"` // loading | start | connected | error
	User    string `json:"user"`
	Host    string `json:"host"`
	Running bool   `json:"running"`
	// error states: expired | notrailer | badurl | network | http | exe
	ErrCode   string `json:"errCode"`
	ErrDetail string `json:"errDetail"`
	// start screen: the AI engine this computer will use
	Engine      string `json:"engine"`
	EngineFound bool   `json:"engineFound"`
	EngineSrc   string `json:"engineSrc"` // VS Code | Cursor | PATH
	// data:image/png icons of the engine binary and of its host app ("" = page shows a placeholder)
	EngineIcon string `json:"engineIcon"`
	HostIcon   string `json:"hostIcon"`
}

// installCtx keeps what the install steps need (not sent to the UI).
type installCtx struct {
	self    string
	tr      trailer.Config
	trSize  int64
	base    string
	openURL string // server address for "Open Exponential"
}

func installErr(code, detail, host string) installInfo {
	return installInfo{Lang: uiLang(), State: "error", Host: host, ErrCode: code, ErrDetail: detail}
}

// prepareInstall looks at the trailer and the config and decides which screen applies. It may call the server.
func prepareInstall() (installInfo, *installCtx) {
	ctx := &installCtx{}
	self, err := os.Executable()
	if err != nil {
		return installErr("exe", err.Error(), ""), ctx
	}
	ctx.self = self
	tr, trSize, trErr := trailer.ReadFile(self)
	hasTr := trErr == nil && tr.URL != "" && tr.Pairing != ""
	if !hasTr {
		trSize = 0
	}
	ctx.tr, ctx.trSize = tr, trSize
	cfg := loadConfig()
	ctx.openURL = cfg.URL
	configured := cfg.URL != "" && (cfg.Token != "" || cfg.OAuth != nil)

	if configured && (!hasTr || tr.Pairing == cfg.LastPairing) {
		name := cfg.UserName
		if name == "" {
			if a, err := getAuth(); err == nil && a != nil {
				var me struct {
					Name string `json:"name"`
				}
				if request(a, "GET", "/api/me", nil, 10*time.Second, &me) == nil {
					name = me.Name
				}
			}
		}
		run := self
		if _, err := os.Stat(installedPath()); err == nil {
			run = installedPath()
		}
		ensureRunning(run)
		for i := 0; i < 10 && agentPID() == 0; i++ {
			time.Sleep(200 * time.Millisecond)
		}
		ci := installInfo{Lang: uiLang(), State: "connected", User: name, Host: hostOf(cfg.URL), Running: agentPID() != 0, Engine: cfg.Engine}
		if ci.Engine != "codex" {
			ci.Engine = "claude"
		}
		fillEngine(&ci)
		return ci, ctx
	}
	if !hasTr {
		return installErr("notrailer", "", hostOf(cfg.URL)), ctx
	}
	base := strings.TrimRight(tr.URL, "/")
	ctx.base, ctx.openURL = base, base
	if err := checkURL(base); err != nil {
		return installErr("badurl", err.Error(), ""), ctx
	}
	host := hostOf(base)
	status, body, err := httpDo("GET", base+"/api/agent/pair/"+url.PathEscape(tr.Pairing), map[string]string{"Accept": "application/json"}, nil, 20*time.Second)
	if err != nil {
		return installErr("network", err.Error(), host), ctx
	}
	if status == 404 {
		return installErr("expired", "", host), ctx
	}
	var who struct {
		User struct {
			Name string `json:"name"`
		} `json:"user"`
	}
	if status != 200 || json.Unmarshal(body, &who) != nil {
		return installErr("http", fmt.Sprintf("HTTP %d", status), host), ctx
	}
	info := installInfo{Lang: uiLang(), State: "start", User: who.User.Name, Host: host}
	info.Engine = tr.Engine
	if info.Engine != "claude" && info.Engine != "codex" {
		info.Engine = cfg.Engine
	}
	if info.Engine != "codex" {
		info.Engine = "claude"
	}
	fillEngine(&info)
	return info, ctx
}

type installResult struct {
	Code, Detail string // empty Code = success
	Base, Token  string
}

// doInstall pairs, installs the exe and starts the agent. progress(n) = n steps are done.
func doInstall(ctx *installCtx, autostart bool, progress func(int)) installResult {
	host := hostOf(ctx.base)
	hn, _ := os.Hostname()
	payload, _ := json.Marshal(map[string]string{"pairing": ctx.tr.Pairing, "name": hn})
	status, body, err := httpDo("POST", ctx.base+"/api/agent/pair", map[string]string{"Content-Type": "application/json", "Accept": "application/json"}, payload, 30*time.Second)
	if err != nil {
		return installResult{Code: "network", Detail: err.Error()}
	}
	if status == 404 {
		return installResult{Code: "expired"}
	}
	var pr struct {
		ClientID     string `json:"client_id"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    any    `json:"expires_in"`
		User         struct {
			Name string `json:"name"`
		} `json:"user"`
	}
	if status != 200 || json.Unmarshal(body, &pr) != nil || pr.AccessToken == "" {
		return installResult{Code: "http", Detail: fmt.Sprintf("HTTP %d (%s)", status, host)}
	}
	exp := num(pr.ExpiresIn)
	if exp == 0 {
		exp = 3600
	}
	updateConfig(func(c *Config) {
		c.URL, c.Token = ctx.base, ""
		c.OAuth = &OAuth{Access: pr.AccessToken, Refresh: pr.RefreshToken, ExpiresAt: nowMs() + exp*1000, ClientID: pr.ClientID}
		c.LastPairing = ctx.tr.Pairing
		c.UserName = pr.User.Name
		if e := ctx.tr.Engine; e == "claude" || e == "codex" {
			c.Engine = e
		}
	})
	progress(1)
	installed, err := installApp(ctx.self, ctx.trSize)
	if err != nil {
		return installResult{Code: "install", Detail: err.Error()}
	}
	if !autostart {
		autostartOff()
	}
	progress(2)
	discoverBeforeStart()
	if err := startDetachedExe(installed); err != nil {
		return installResult{Code: "start", Detail: err.Error()}
	}
	progress(3)
	return installResult{Base: ctx.base, Token: pr.AccessToken}
}

// waitForAgent polls /api/me until the server reports the agent online (up to 20 s).
func waitForAgent(base, token string) bool {
	for i := 0; i < 20; i++ {
		status, body, err := httpDo("GET", base+"/api/me", map[string]string{"Authorization": "Bearer " + token, "Accept": "application/json"}, nil, 5*time.Second)
		if err == nil && status == 200 {
			var me struct {
				AiStatus struct {
					Agent any `json:"agent"`
				} `json:"aiStatus"`
			}
			if json.Unmarshal(body, &me) == nil && truthy(me.AiStatus.Agent) {
				return true
			}
		}
		time.Sleep(time.Second)
	}
	return false
}

// errText is the English text for the fallback message boxes.
func errText(code, detail, host string) string {
	switch code {
	case "expired":
		return "This download link has expired. Download the agent again from Exponential > Settings > AI."
	case "notrailer":
		return "Download the agent from Exponential > Settings > AI to connect this computer."
	case "badurl":
		return "Invalid server address in this download: " + detail
	case "network":
		return fmt.Sprintf("Could not reach %s: %s", host, detail)
	case "http":
		return fmt.Sprintf("Could not connect to %s (%s).", host, detail)
	case "install":
		return "Installing failed: " + detail
	case "start":
		return "Could not start the agent: " + detail
	}
	return "Cannot find the agent file: " + detail
}

// runInstall is the double-click flow (no arguments): the branded window, or message boxes when WebView2 is missing.
func runInstall() {
	if runInstallerWindow() {
		return
	}
	info, ctx := prepareInstall()
	switch info.State {
	case "connected":
		name := info.User
		if name == "" {
			name = "your account"
		}
		msgBox(fmt.Sprintf("Exponential agent is connected as %s to %s.", name, info.Host), dlgInfo)
	case "error":
		kind := uint32(dlgError)
		if info.ErrCode == "notrailer" {
			kind = dlgInfo
		}
		msgBox(errText(info.ErrCode, info.ErrDetail, info.Host), kind)
	case "start":
		if msgBox(fmt.Sprintf("Connect this computer to Exponential (%s) as %s?", info.Host, info.User), dlgAsk) != idYes {
			return
		}
		if r := doInstall(ctx, true, func(int) {}); r.Code != "" {
			msgBox(errText(r.Code, r.Detail, info.Host), dlgError)
			return
		}
		msgBox("Exponential agent is running. It starts with Windows; remove it in Settings > Apps.", dlgInfo)
	}
}

// fillEngine detects the engine binary and its host app and fills the start-screen fields (icons included).
func fillEngine(info *installInfo) {
	bin := findEngine(info.Engine)
	if bin == "" {
		return
	}
	info.EngineFound = true
	info.EngineSrc = "PATH"
	if l := strings.ToLower(filepath.ToSlash(bin)); strings.Contains(l, "/.cursor/") {
		info.EngineSrc = "Cursor"
	} else if strings.Contains(l, "/.vscode/") {
		info.EngineSrc = "VS Code"
	}
	info.EngineIcon, info.HostIcon = engineIcons(bin)
}

// discoverBeforeStart maps already opened repos right after pairing; capped at 20 s so the install never hangs.
func discoverBeforeStart() {
	a, err := getAuth()
	if err != nil || a == nil {
		return
	}
	done := make(chan struct{})
	go func() { defer close(done); discoverRepos(a) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
	}
}
