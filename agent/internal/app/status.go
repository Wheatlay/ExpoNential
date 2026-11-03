package app

import (
	"sync"
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

// statusText is the tray tooltip.
func statusText(lang string) string {
	trayMu.Lock()
	key, forName, fails := trayKey, trayFor, trayFails
	trayMu.Unlock()
	pl := lang == "pl"
	switch {
	case fails >= 3 && pl:
		return "Exponential · brak połączenia"
	case fails >= 3:
		return "Exponential · no connection"
	case key != "" && forName != "" && pl:
		return "Exponential · analiza " + key + " dla " + forName
	case key != "" && forName != "":
		return "Exponential · analyzing " + key + " for " + forName
	case key != "" && pl:
		return "Exponential · analiza " + key + "…"
	case key != "":
		return "Exponential · analyzing " + key + "…"
	case pl:
		return "Exponential · gotowy"
	}
	return "Exponential · ready"
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
