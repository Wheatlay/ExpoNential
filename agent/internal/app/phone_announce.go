package app

import "sync"

// TEMP phone-announce: remove after agent 0.5
// One-time card for users who UPDATED to the version with phone start (Remote Control) and so never saw the
// installer step. Shown after the first successful poll; "Set up" opens Settings at the phone section, "Skip"
// only sets PhoneAsked. Closing the card sets nothing: it comes back on the next agent start.

var phoneAnnounceOnce sync.Once

type phoneCardState struct {
	mu    sync.Mutex
	shown bool
}

var phoneCard phoneCardState

func (c *phoneCardState) Shown() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.shown
}

func (c *phoneCardState) set(v bool) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.shown == v {
		return false
	}
	c.shown = v
	return true
}

// phoneSettingsOpener opens the Settings window at the phone section (set on Windows, nil elsewhere).
var phoneSettingsOpener func()

// shouldAnnouncePhone is the show condition of the card.
func shouldAnnouncePhone(cfg Config, hasAccounts bool, promptOK bool) bool {
	return !cfg.PhoneAsked && cfg.PhoneAccount == "" && cfg.Engine != "codex" &&
		hasAccounts && len(cfg.Repos) > 0 && promptOK
}

// maybeAnnouncePhone runs once per agent start (after the first successful poll).
func maybeAnnouncePhone() {
	phoneAnnounceOnce.Do(func() {
		cfg := loadConfig()
		if !shouldAnnouncePhone(cfg, len(phoneAccounts()) > 0, promptSupported()) {
			return
		}
		if !showPromptWindow() {
			return
		}
		if phoneCard.set(true) {
			cardsChanged()
		}
	})
}

func markPhoneAsked() {
	updateConfig(func(c *Config) { c.PhoneAsked = true })
}

// phoneAct handles the buttons of the card: set | skip | close.
func phoneAct(action string) {
	switch action {
	case "set":
		markPhoneAsked()
		if phoneSettingsOpener != nil {
			phoneSettingsOpener()
		}
	case "skip":
		markPhoneAsked()
	}
	phoneCard.set(false)
	cardsChanged()
}

func phoneAnnounceLabels(lang string, m map[string]string) {
	if lang == "pl" {
		m["phoneAnn"], m["phoneSet"], m["phoneSkip"] = "Zadania można teraz uruchamiać z telefonu", "Ustaw", "Pomiń"
		return
	}
	m["phoneAnn"], m["phoneSet"], m["phoneSkip"] = "You can now start tasks from your phone", "Set up", "Skip"
}
