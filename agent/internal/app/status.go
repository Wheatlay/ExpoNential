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
