package app

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Claude accounts: "" is the default account (no CLAUDE_CONFIG_DIR change), other values are CLAUDE_CONFIG_DIR folders.

func sameDir(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// orderAccounts: [active first, the other account folders, the default account]. Without an active account the
// default one (what ran so far) stays first.
func orderAccounts(active string, others []string) []string {
	var out []string
	add := func(d string) {
		for _, x := range out {
			if (x == "" && d == "") || (x != "" && d != "" && sameDir(x, d)) {
				return
			}
		}
		out = append(out, d)
	}
	if active == "" {
		add("")
	} else {
		add(active)
	}
	for _, o := range others {
		add(o)
	}
	add("")
	return out
}

// otherAccountDirs: ~/.claude-accounts/* folders that hold .claude.json or .credentials.json.
func otherAccountDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	root := filepath.Join(home, ".claude-accounts")
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		d := filepath.Join(root, e.Name())
		for _, f := range []string{".claude.json", ".credentials.json"} {
			if _, err := os.Stat(filepath.Join(d, f)); err == nil {
				out = append(out, d)
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

func claudeAccounts() []string { return orderAccounts(activeAccount(), otherAccountDirs()) }

// accountName is what goes to the log: the folder name only.
func accountName(dir string) string {
	if dir == "" {
		return "default"
	}
	return filepath.Base(dir)
}

// nextAccount: the first account in list that is not limited at now and not in skip.
func nextAccount(list []string, limited map[string]time.Time, skip map[string]bool, now time.Time) (string, bool) {
	for _, a := range list {
		if skip[a] {
			continue
		}
		if u, ok := limited[a]; ok && now.Before(u) {
			continue
		}
		return a, true
	}
	return "", false
}

// earliestReset: when every account in list is limited, the earliest reset; ok=false when some account is free.
func earliestReset(list []string, limited map[string]time.Time, now time.Time) (time.Time, bool) {
	var best time.Time
	for _, a := range list {
		u, ok := limited[a]
		if !ok || !now.Before(u) {
			return time.Time{}, false
		}
		if best.IsZero() || u.Before(best) {
			best = u
		}
	}
	return best, !best.IsZero()
}

var limitedUntil = map[string]time.Time{} // guarded by stateMu

func setLimited(acct string, until time.Time) {
	stateMu.Lock()
	limitedUntil[acct] = until
	stateMu.Unlock()
}

func limitedSnapshot() map[string]time.Time {
	stateMu.Lock()
	defer stateMu.Unlock()
	m := make(map[string]time.Time, len(limitedUntil))
	for k, v := range limitedUntil {
		m[k] = v
	}
	return m
}

// pausedUntil: analyses are paused while every Claude account is limited (claude engine only).
func pausedUntil() (time.Time, bool) {
	if e := loadConfig().Engine; e == "codex" {
		return time.Time{}, false
	}
	return earliestReset(claudeAccounts(), limitedSnapshot(), time.Now())
}
