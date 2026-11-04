package app

import (
	"sync"
	"sync/atomic"
	"time"
)

// Live state of the background agent, shown in the tray tooltip.
var (
	trayMu    sync.Mutex
	trayKey   string // issue being analyzed ("" = none)
	trayFor   string
	trayFails int    // consecutive failed polls
	onStatus  func() // set by the tray; called after every change
	IconICO   []byte // set by main (embedded exponential.ico)
	updateVer string // newer agent version found on GitHub ("" = none)
)

func notifyStatus() {
	trayMu.Lock()
	f := onStatus
	trayMu.Unlock()
	if f != nil {
		f()
	}
}

func setAnalyzing(key, forName string) {
	trayMu.Lock()
	trayKey, trayFor = key, forName
	trayMu.Unlock()
	notifyStatus()
}

func setPollOK() {
	trayMu.Lock()
	changed := trayFails != 0
	trayFails = 0
	trayMu.Unlock()
	if changed {
		notifyStatus()
	}
}

func setPollFail() {
	trayMu.Lock()
	trayFails++
	changed := trayFails == 3
	trayMu.Unlock()
	if changed {
		notifyStatus()
	}
}

// statusParts is the state line (without the "Exponential · " prefix) and its meaning for colouring:
// ok | ai | warn | danger.
func statusParts(lang string) (text, kind string) {
	trayMu.Lock()
	key, forName, fails := trayKey, trayFor, trayFails
	trayMu.Unlock()
	pl := lang == "pl"
	tx := func(p, e string) string {
		if pl {
			return p
		}
		return e
	}
	until, paused := pausedUntil()
	mutedTill, muted := mutedUntilOf(loadConfig(), time.Now())
	switch {
	case fails >= 3:
		return tx("brak połączenia", "no connection"), "danger"
	case paused:
		return limitText(lang, until), "warn"
	case key != "" && forName != "":
		return tx("analiza "+key+" · "+forName, "analyzing "+key+" · "+forName), "ai"
	case key != "":
		return tx("analiza "+key+"…", "analyzing "+key+"…"), "ai"
	case muted:
		return mutedText(lang, mutedTill), "warn"
	}
	return tx("gotowy", "ready"), "ok"
}

// statusText is the tray tooltip.
func statusText(lang string) string {
	t, _ := statusParts(lang)
	return "Exponential · " + t
}

// ownUserID returns the account id of this agent (cached in config.json; asked from /api/me once).
func ownUserID(a *Auth) int {
	if id := loadConfig().UserID; id != 0 {
		return id
	}
	var me struct {
		ID int `json:"id"`
	}
	if request(a, "GET", "/api/me", nil, 10*time.Second, &me) != nil || me.ID == 0 {
		return 0
	}
	updateConfig(func(c *Config) { c.UserID = me.ID })
	return me.ID
}

// updateSuffix is appended to the tray state line when a newer agent version exists.
func updateSuffix(lang string) string {
	trayMu.Lock()
	v := updateVer
	trayMu.Unlock()
	if v == "" {
		return ""
	}
	if lang == "pl" {
		return " · dostępna " + v
	}
	return " · " + v + " available"
}

// agentLang is the language of the agent's own windows: the account language mirrored from the server
// (config.Lang), else the Windows UI language. Before login (installer start/error screens) uiLang() is used directly.
func agentLang() string {
	if l := loadConfig().Lang; l == "pl" || l == "en" {
		return l
	}
	return uiLang()
}

var lastLangSync atomic.Int64 // unix seconds of the last /api/me language fetch

// syncLang reads the account language from /api/me at most every 10 minutes (called from the poll loop, so the
// window picks up a change made in the web app without a restart) and stores it in config.json when it changed.
func syncLang(a *Auth) {
	now := time.Now().Unix()
	if last := lastLangSync.Load(); now-last < 600 || !lastLangSync.CompareAndSwap(last, now) {
		return
	}
	var me struct {
		Lang *string `json:"lang"`
	}
	if request(a, "GET", "/api/me", nil, 10*time.Second, &me) != nil {
		lastLangSync.Store(0) // retry on the next poll
		return
	}
	l := ""
	if me.Lang != nil && (*me.Lang == "pl" || *me.Lang == "en") {
		l = *me.Lang
	}
	if loadConfig().Lang != l {
		updateConfig(func(c *Config) { c.Lang = l })
	}
}
