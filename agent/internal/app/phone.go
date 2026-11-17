package app

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// "Start on PC" from the phone: a Claude Code Remote Control session on a chosen account.

type phoneAccount struct{ Dir, Email string }

func homeDir() string { h, _ := os.UserHomeDir(); return h }

// claudeJSONPath: the .claude.json of an account ("default" = the one in the home folder).
func claudeJSONPath(acc string) string {
	if acc == "default" {
		return filepath.Join(homeDir(), ".claude.json")
	}
	return filepath.Join(acc, ".claude.json")
}

// accountConfigDir: the folder holding projects/ of an account.
func accountConfigDir(acc string) string {
	if acc == "default" {
		return filepath.Join(homeDir(), ".claude")
	}
	return acc
}

func emailFrom(data []byte) string {
	var j struct {
		OAuth struct {
			Email string `json:"emailAddress"`
		} `json:"oauthAccount"`
	}
	if json.Unmarshal(data, &j) != nil {
		return ""
	}
	return j.OAuth.Email
}

func phoneAccounts() []phoneAccount {
	var out []phoneAccount
	add := func(dir string) {
		if b, err := os.ReadFile(claudeJSONPath(dir)); err == nil {
			if e := emailFrom(b); e != "" {
				out = append(out, phoneAccount{Dir: dir, Email: e})
			}
		}
	}
	add("default")
	for _, d := range otherAccountDirs() {
		add(d)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Email) < strings.ToLower(out[j].Email) })
	return out
}

func trustPath(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimRight(p, "/")
	return strings.ToLower(p)
}

// readinessFrom: onboarding done, and which project keys (repos: key -> path) have the folder trusted.
func readinessFrom(data []byte, repos map[string]string) (onboarded bool, ready, missing []string) {
	var j struct {
		Onboarded bool `json:"hasCompletedOnboarding"`
		Projects  map[string]struct {
			Trust bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	_ = json.Unmarshal(data, &j)
	trusted := map[string]bool{}
	for p, v := range j.Projects {
		if v.Trust {
			trusted[trustPath(p)] = true
		}
	}
	for k, p := range repos {
		if trusted[trustPath(p)] {
			ready = append(ready, k)
		} else {
			missing = append(missing, k)
		}
	}
	sort.Strings(ready)
	sort.Strings(missing)
	return j.Onboarded, ready, missing
}

func phoneReadiness(acc string, repos map[string]string) (bool, []string, []string) {
	b, err := os.ReadFile(claudeJSONPath(acc))
	if err != nil {
		return readinessFrom(nil, repos)
	}
	return readinessFrom(b, repos)
}

// existingRepos: key -> path of mapped repos whose folder exists.
func existingRepos(cfg Config) map[string]string {
	m := map[string]string{}
	for k, e := range cfg.Repos {
		if e.Path == "" {
			continue
		}
		if st, err := os.Stat(e.Path); err == nil && st.IsDir() {
			m[k] = e.Path
		}
	}
	return m
}

func containsKey(list []string, key string) bool {
	for _, k := range list {
		if k == key {
			return true
		}
	}
	return false
}

func phoneReadyKeys(cfg Config) []string {
	if cfg.PhoneAccount == "" || cfg.Engine == "codex" {
		return nil
	}
	onboarded, ready, _ := phoneReadiness(cfg.PhoneAccount, existingRepos(cfg))
	if !onboarded {
		return nil
	}
	var out []string
	for _, k := range ready {
		if !containsKey(cfg.PhoneOff, k) {
			out = append(out, k)
		}
	}
	return out
}

// phoneProject: one mapped project in the phone-start list.
type phoneProject struct {
	Key     string `json:"key"`
	On      bool   `json:"on"`
	Ready   bool   `json:"ready"`
	Missing string `json:"missing"` // "" | trust | onboarding | folder
}

type phoneAccountRow struct {
	Dir   string `json:"dir"`
	Email string `json:"email"`
}

// phoneView: everything the settings window and the installer show for phone start.
type phoneView struct {
	Accounts []phoneAccountRow `json:"accounts"`
	Account  string            `json:"account"`
	Projects []phoneProject    `json:"projects"`
	Codex    bool              `json:"codex"`
}

func phoneProjects(cfg Config) []phoneProject {
	out := []phoneProject{}
	if cfg.PhoneAccount == "" || cfg.Engine == "codex" {
		return out
	}
	existing := existingRepos(cfg)
	onboarded, ready, _ := phoneReadiness(cfg.PhoneAccount, existing)
	isReady := map[string]bool{}
	for _, k := range ready {
		isReady[k] = true
	}
	for k := range cfg.Repos {
		p := phoneProject{Key: k, On: !containsKey(cfg.PhoneOff, k)}
		switch {
		case existing[k] == "":
			p.Missing = "folder"
		case !onboarded:
			p.Missing = "onboarding"
		case !isReady[k]:
			p.Missing = "trust"
		default:
			p.Ready = true
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

func buildPhoneView(cfg Config) phoneView {
	v := phoneView{Accounts: []phoneAccountRow{}, Account: cfg.PhoneAccount, Codex: cfg.Engine == "codex", Projects: phoneProjects(cfg)}
	for _, a := range phoneAccounts() {
		v.Accounts = append(v.Accounts, phoneAccountRow{Dir: a.Dir, Email: a.Email})
	}
	return v
}

// withPhoneProject: the PhoneOff list after switching key on or off (sorted, no duplicates).
func withPhoneProject(off []string, key string, on bool) []string {
	var out []string
	for _, k := range off {
		if k != key && !containsKey(out, k) {
			out = append(out, k)
		}
	}
	if !on {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func setPhoneProject(key string, on bool) {
	updateConfig(func(c *Config) { c.PhoneOff = withPhoneProject(c.PhoneOff, key, on) })
}

// childEnv: base without Claude Code's own session variables, with CLAUDE_CONFIG_DIR set for the account.
func childEnv(base []string, acc string) []string {
	out := make([]string, 0, len(base)+1)
	for _, e := range base {
		name := e
		if i := strings.IndexByte(e, '='); i >= 0 {
			name = e[:i]
		}
		u := strings.ToUpper(name)
		if u == "CLAUDECODE" || strings.HasPrefix(u, "CLAUDE_CODE_") || u == "CLAUDE_CONFIG_DIR" {
			continue
		}
		out = append(out, e)
	}
	if acc != "default" && acc != "" {
		out = append(out, "CLAUDE_CONFIG_DIR="+acc)
	}
	return out
}

// preparePhone opens plain `claude` terminals so the user can finish onboarding / trust the folders.
// only = one project key (the clicked "Needs setup" pill); "" = every enabled project that needs it.
func preparePhone(only string) {
	cfg := loadConfig()
	if cfg.PhoneAccount == "" {
		return
	}
	repos := existingRepos(cfg)
	env := childEnv(os.Environ(), cfg.PhoneAccount)
	var todo []string
	notOnboarded := false
	for _, p := range phoneProjects(cfg) {
		if !p.On || p.Ready || p.Missing == "folder" || (only != "" && p.Key != only) {
			continue
		}
		if p.Missing == "onboarding" {
			notOnboarded = true
		}
		todo = append(todo, p.Key)
	}
	if len(todo) == 0 {
		return
	}
	if notOnboarded {
		logf("phone setup: account %s not onboarded, opening a terminal in %s", accountName(cfg.PhoneAccount), todo[0])
		if err := openTerminalClaude(repos[todo[0]], env, nil, ""); err != nil {
			logf("phone setup: %v", err)
		}
		return
	}
	for _, k := range todo {
		logf("phone setup: opening a terminal in %s to trust the folder", k)
		if err := openTerminalClaude(repos[k], env, nil, ""); err != nil {
			logf("phone setup: %v", err)
		}
	}
}

// waitForSession: true once a transcript of the account that mentions key appeared after since.
func waitForSession(acc, key string, since time.Time, timeout time.Duration) bool {
	root := filepath.Join(accountConfigDir(acc), "projects")
	deadline := time.Now().Add(timeout)
	needle := []byte(key)
	for {
		files, _ := filepath.Glob(filepath.Join(root, "*", "*.jsonl"))
		for _, f := range files {
			st, err := os.Stat(f)
			if err != nil || !st.ModTime().After(since) {
				continue
			}
			if b, err := os.ReadFile(f); err == nil && bytes.Contains(b, needle) {
				return true
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(2 * time.Second)
	}
}
