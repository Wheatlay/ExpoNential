package app

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

// Consent before an analysis for someone else runs on this computer. The prompt is a card in the toast window
// (toast_windows.go); the poll loop asks consentDecision for every offered job and never blocks on an answer.

const (
	consentTimeout = 2 * time.Minute
	allowFor       = 24 * time.Hour
	declineSkip    = 10 * time.Minute // how long a declined key is not even looked at
	onceFor        = 5 * time.Minute  // how long "Just this once" stays valid
)

type decision int

const (
	dNo decision = iota
	dYes
	dPending
)

var (
	declinedMem  = map[string]time.Time{}
	declinedMemM sync.Mutex
	onceMem      = map[string]time.Time{}
	onceMemM     sync.Mutex
)

// requesterInfo is who asked for an analysis (requestedBy and requestedAt of the work payload).
type requesterInfo struct {
	ID          int
	Name        string
	RequestedAt string
}

func newRequester(by *struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}, at *string) requesterInfo {
	var r requesterInfo
	if by != nil {
		r.ID, r.Name = by.ID, by.Name
	}
	if at != nil {
		r.RequestedAt = *at
	}
	return r
}

func allowedNow(cfg Config, requesterID int, now time.Time) bool {
	u, ok := cfg.AllowUntil[strconv.Itoa(requesterID)]
	return ok && float64(now.UnixMilli()) < u
}

// allowUntilFor24h is the stored value of "Allow for 24 h".
func allowUntilFor24h(now time.Time) float64 { return float64(now.Add(allowFor).UnixMilli()) }

func declinedID(key, requestedAt string) string { return key + "|" + requestedAt }

func recentlyDeclined(key string) bool {
	declinedMemM.Lock()
	defer declinedMemM.Unlock()
	t, ok := declinedMem[key]
	return ok && time.Since(t) < declineSkip
}

func markDeclined(key, requestedAt string) {
	declinedMemM.Lock()
	declinedMem[key] = time.Now()
	declinedMemM.Unlock()
	nowMs := float64(time.Now().UnixMilli())
	updateConfig(func(c *Config) {
		if c.Declined == nil {
			c.Declined = map[string]float64{}
		}
		for k, v := range c.Declined {
			if nowMs-v > 7*24*3600*1000 {
				delete(c.Declined, k)
			}
		}
		c.Declined[declinedID(key, requestedAt)] = nowMs
	})
}

func grantOnce(key, requestedAt string) {
	onceMemM.Lock()
	onceMem[declinedID(key, requestedAt)] = time.Now()
	onceMemM.Unlock()
}

func hasOnce(key, requestedAt string) bool {
	onceMemM.Lock()
	defer onceMemM.Unlock()
	t, ok := onceMem[declinedID(key, requestedAt)]
	return ok && time.Since(t) < onceFor
}

func takeOnce(key, requestedAt string) {
	onceMemM.Lock()
	delete(onceMem, declinedID(key, requestedAt))
	onceMemM.Unlock()
}

// decideOther is the rule for one offered analysis. own = this account's id (0 = unknown).
func decideOther(c Config, own int, rq requesterInfo, now time.Time, once, declined bool) decision {
	if own == 0 || rq.ID == 0 || rq.ID == own {
		return dYes // own request, or the requester is unknown
	}
	if _, muted := mutedUntilOf(c, now); muted {
		return dNo
	}
	switch teamModeOf(c) {
	case teamOff:
		return dNo
	case teamAuto:
		return dYes
	}
	if allowedNow(c, rq.ID, now) {
		return dYes
	}
	if declined {
		return dNo
	}
	if once {
		return dYes
	}
	return dPending
}

// consentDecision asks decideOther with the live state (config, declines, "just this once").
func consentDecision(a *Auth, key string, rq requesterInfo) decision {
	cfg := loadConfig()
	declined := recentlyDeclined(key)
	if !declined {
		if _, ok := cfg.Declined[declinedID(key, rq.RequestedAt)]; ok {
			markDeclined(key, rq.RequestedAt)
			declined = true
		}
	}
	d := decideOther(cfg, ownUserID(a), rq, time.Now(), hasOnce(key, rq.RequestedAt), declined)
	if d == dPending && !promptSupported() {
		return dYes // no prompt on this OS
	}
	return d
}

// consentFor is the last check in analyze(): true = go ahead. It never asks; the card already did.
func consentFor(a *Auth, key string, rq requesterInfo) bool {
	if consentDecision(a, key, rq) != dYes {
		logf("%s: no consent", key)
		return false
	}
	takeOnce(key, rq.RequestedAt)
	return true
}

func requesterName(rq requesterInfo) string {
	if rq.Name != "" {
		return rq.Name
	}
	if uiLang() == "pl" {
		return "Ktoś z zespołu"
	}
	return "Someone from the team"
}

// ensurePrompt shows the card for a pending job (once). false = no window could be shown, the job is skipped.
func ensurePrompt(key string, rq requesterInfo) bool {
	if !promptSupported() {
		return false
	}
	p := promptCard{Key: key, Name: requesterName(rq), RequesterID: rq.ID, RequestedAt: rq.RequestedAt}
	if _, ok := cards.Prompt(key); ok {
		return true
	}
	if !showPromptWindow() {
		return false
	}
	if cards.AddPrompt(p) {
		cardsChanged()
	}
	return true
}

// resolvePrompt applies the answer of a card: allow | once | decline | timeout | mute.
func resolvePrompt(key, action string, now time.Time) {
	if action == "mute" {
		setMuted(true)
		return
	}
	p, ok := cards.RemovePrompt(key)
	if !ok {
		return
	}
	switch action {
	case "allow":
		id := strconv.Itoa(p.RequesterID)
		until := allowUntilFor24h(now)
		updateConfig(func(c *Config) {
			if c.AllowUntil == nil {
				c.AllowUntil = map[string]float64{}
			}
			c.AllowUntil[id] = until
		})
		grantOnce(p.Key, p.RequestedAt)
	case "once":
		grantOnce(p.Key, p.RequestedAt)
	default:
		logf("%s: declined for %s", p.Key, p.Name)
		markDeclined(p.Key, p.RequestedAt)
		appendRun(runRecord{Key: p.Key, For: p.Name, Result: runDeclined})
	}
	cardsChanged()
}

func issueURL(base, key string) string { return strings.TrimRight(base, "/") + "/issue/" + key }

func toastLabels(lang string) map[string]string {
	if lang == "pl" {
		return map[string]string{"want": "chce uruchomić analizę na tym komputerze", "allow": "Zgoda na 24 h", "once": "Tylko teraz", "mute": "Wycisz 24 h", "decline": "Odmów", "waiting": "czeka", "info": "%N · analiza %K",
			"updAvail": "Dostępna wersja %V", "updBtn": "Zaktualizuj", "updDismiss": "Pomiń tę wersję", "updDownloading": "Pobieram… %P%", "updInstalling": "Instaluję…",
			"updDone": "Zaktualizowano do %V", "updFail": "Aktualizacja nie powiodła się", "updRetry": "Spróbuj ponownie"}
	}
	return map[string]string{"want": "wants to run an analysis on this computer", "allow": "Allow for 24 h", "once": "Just this once", "mute": "Mute 24 h", "decline": "Decline", "waiting": "is waiting", "info": "%N · analysis %K",
		"updAvail": "Version %V available", "updBtn": "Update", "updDismiss": "Skip this version", "updDownloading": "Downloading… %P%", "updInstalling": "Installing…",
		"updDone": "Updated to %V", "updFail": "Update failed", "updRetry": "Try again"}
}
