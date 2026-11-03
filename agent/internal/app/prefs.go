package app

import (
	"sync/atomic"
	"time"
)

// Mute, team mode and theme: settings shared by the tray menu, the mini settings window and the poll loop.

const muteFor = 24 * time.Hour

// mutedUntilOf returns the end of the mute and whether it is still in force.
func mutedUntilOf(c Config, now time.Time) (time.Time, bool) {
	if c.MutedUntil <= 0 {
		return time.Time{}, false
	}
	u := time.UnixMilli(int64(c.MutedUntil))
	return u, now.Before(u)
}

func muteUntil24h(now time.Time) float64 { return float64(now.Add(muteFor).UnixMilli()) }

func isMuted() bool {
	_, m := mutedUntilOf(loadConfig(), time.Now())
	return m
}

// setMuted starts (24 h) or ends the mute. Starting it closes every open prompt without answering it.
func setMuted(on bool) {
	now := time.Now()
	updateConfig(func(c *Config) {
		if on {
			c.MutedUntil = muteUntil24h(now)
		} else {
			c.MutedUntil = 0
		}
	})
	if on {
		pending, _ := cards.Snapshot()
		for _, pc := range pending {
			appendRun(runRecord{Key: pc.Key, For: pc.Name, Result: runMuted})
		}
		cards.ClearPrompts()
		cardsChanged()
	}
	notifyStatus()
}

func clock(t time.Time) string { return t.Local().Format("15:04") }

func mutedText(lang string, until time.Time) string {
	if lang == "pl" {
		return "wyciszone do " + clock(until)
	}
	return "muted until " + clock(until)
}

// muteItemTitle is the label of the mute action: start, or end when already muted.
func muteItemTitle(lang string, until time.Time, muted bool) string {
	switch {
	case muted && lang == "pl":
		return "Wyłącz wyciszenie (do " + clock(until) + ")"
	case muted:
		return "Unmute (until " + clock(until) + ")"
	case lang == "pl":
		return "Wycisz na 24 h"
	}
	return "Mute for 24 h"
}

// Team mode: what to do with analyses requested by other people.
const (
	teamAsk  = "ask"
	teamAuto = "auto"
	teamOff  = "off"
)

func validTeamMode(m string) bool { return m == teamAsk || m == teamAuto || m == teamOff }

// teamModeOf: the stored mode; without one the legacy askOthers=false means auto, anything else ask.
func teamModeOf(c Config) string {
	if validTeamMode(c.TeamMode) {
		return c.TeamMode
	}
	if c.AskOthers != nil && !*c.AskOthers {
		return teamAuto
	}
	return teamAsk
}

// migrateTeamMode moves the legacy askOthers flag into teamMode once. Returns true when it changed c.
func migrateTeamMode(c *Config) bool {
	if c.AskOthers == nil {
		return false
	}
	if !validTeamMode(c.TeamMode) {
		if !*c.AskOthers {
			c.TeamMode = teamAuto
		} else {
			c.TeamMode = teamAsk
		}
	}
	c.AskOthers = nil
	return true
}

var (
	migratedAuto  atomic.Bool  // the migration produced 'auto': tell the server on the next good poll
	teamLocalAt   atomic.Int64 // unix ms of the last local change (a stale poll answer must not undo it)
	teamLocalWait = 15 * time.Second
)

func migrateTeamModeOnDisk() {
	c := loadConfig()
	if c.AskOthers == nil {
		return
	}
	updateConfig(func(c *Config) { migrateTeamMode(c) })
	if loadConfig().TeamMode == teamAuto {
		migratedAuto.Store(true)
	}
}

// adoptServerTeamMode stores the mode the server reported, unless we just changed it here.
func adoptServerTeamMode(c Config, server string, now time.Time) (string, bool) {
	if !validTeamMode(server) || server == teamModeOf(c) {
		return "", false
	}
	if now.Sub(time.UnixMilli(teamLocalAt.Load())) < teamLocalWait {
		return "", false
	}
	return server, true
}

// setTeamMode stores the mode and tells the server (best effort; a 4xx is only logged).
func setTeamMode(mode string) {
	if !validTeamMode(mode) {
		return
	}
	teamLocalAt.Store(time.Now().UnixMilli())
	updateConfig(func(c *Config) { c.TeamMode = mode; c.AskOthers = nil })
	notifyStatus()
	go patchTeamMode(mode)
}

func patchTeamMode(mode string) {
	defer func() { _ = recover() }()
	cfg := loadConfig()
	if cfg.DeviceID == "" {
		return
	}
	a, err := getAuth()
	if err != nil || a == nil {
		return
	}
	if err := request(a, "PATCH", "/api/agents/"+cfg.DeviceID, map[string]any{"teamMode": mode}, 10*time.Second, nil); err != nil {
		logf("team mode not saved on the server: %s", shortErr(err))
	}
}

func setNotifyOthers(on bool) { updateConfig(func(c *Config) { c.NotifyOthers = &on }); notifyStatus() }

// Theme.
func validTheme(t string) bool { return t == "system" || t == "dark" || t == "light" }

// resolveTheme turns the setting into "dark" or "light"; "system" (or anything unknown) follows Windows.
func resolveTheme(setting string, systemLight bool) string {
	switch setting {
	case "dark":
		return "dark"
	case "light":
		return "light"
	}
	if systemLight {
		return "light"
	}
	return "dark"
}

func currentTheme() string { return resolveTheme(loadConfig().Theme, systemLight()) }

func setTheme(t string) {
	if validTheme(t) {
		updateConfig(func(c *Config) { c.Theme = t })
		cardsChanged()
		notifyStatus()
	}
}
