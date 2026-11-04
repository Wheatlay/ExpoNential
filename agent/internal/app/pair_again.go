package app

import (
	"strings"
	"time"

	"exponential-agent/internal/trailer"
)

// pollWake cuts the pause of the work loop short (after "Pair again", so the new sign-in is used at once).
var pollWake = make(chan struct{}, 1)

func wakePoll() {
	select {
	case pollWake <- struct{}{}:
	default:
	}
}

// sleepPoll waits d, or less when wakePoll is called.
func sleepPoll(d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-pollWake:
	}
}

// pairAgain pairs this computer again with a code from Settings > My AI, in this process (no reinstall): it runs
// the same pairOnly step as the installer and then restarts the work loop. Returns "" on success, else a text for the user.
func pairAgain(code string) string {
	code = strings.TrimSpace(code)
	if code == "" {
		return ltx("Wpisz kod parowania", "Enter the pairing code")
	}
	cfg := loadConfig()
	base := strings.TrimRight(cfg.URL, "/")
	if base == "" {
		return ltx("Brak adresu serwera w konfiguracji", "No server address in the configuration")
	}
	goal := cfg.Goal
	if goal < 1 || goal > 3 {
		goal = 3
	}
	engine := cfg.Engine
	ctx := &installCtx{base: base, goal: goal, engine: engine, tr: trailer.Config{URL: base, Pairing: code, Engine: engine, Goal: goal}}
	res, _ := pairOnly(ctx)
	if res.Code != "" {
		logf("pair again: failed (%s %s)", res.Code, res.Detail)
		switch res.Code {
		case "expired":
			return ltx("Kod wygasł lub jest błędny. Wygeneruj nowy w Ustawienia > Moje AI.", "The code expired or is wrong. Generate a new one in Settings > My AI.")
		case "ratelimit":
			return ltx("Zbyt wiele prób, spróbuj za minutę", "Too many attempts, try again in a minute")
		}
		return errText(res.Code, res.Detail, hostOf(base))
	}
	logf("pair again: paired with %s", hostOf(base))
	setLastErr("")
	setPollOK()
	notifyStatus()
	if a, err := getAuth(); err == nil && a != nil {
		go discoverRepos(a)
	}
	wakePoll()
	return ""
}
