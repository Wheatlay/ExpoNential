package app

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Version is set by main (ldflags -X main.version).
var Version = "0.4.17"

type RepoEntry struct {
	Path   string `json:"path"`
	Source string `json:"source"` // manual | clone | hook
}

type OAuth struct {
	Access    string  `json:"access"`
	Refresh   string  `json:"refresh"`
	ExpiresAt float64 `json:"expiresAt"` // ms since epoch (same as the TS agent)
	ClientID  string  `json:"clientId"`
}

// Config is config.json. Unknown keys are kept on write.
type Config struct {
	URL             string               `json:"url,omitempty"`
	Token           string               `json:"token,omitempty"`
	OAuth           *OAuth               `json:"oauth,omitempty"`
	DeviceID        string               `json:"deviceId,omitempty"`
	Engine          string               `json:"engine,omitempty"`
	Repos           map[string]RepoEntry `json:"repos"`
	Version         string               `json:"version,omitempty"`
	LastPairing     string               `json:"lastPairing,omitempty"`     // pairing id of the last install (Go agent)
	UserName        string               `json:"userName,omitempty"`        // account name shown in dialogs (Go agent)
	UserID          int                  `json:"userId,omitempty"`          // own account id (to tell own analyses from others)
	NotifyOthers    *bool                `json:"notifyOthers,omitempty"`    // toast when an analysis runs for someone else (default on)
	NotifyOwn       *bool                `json:"notifyOwn,omitempty"`       // card when an own analysis starts on this PC (default on)
	AskOthers       *bool                `json:"askOthers,omitempty"`       // legacy, migrated to teamMode
	AllowUntil      map[string]float64   `json:"allowUntil,omitempty"`      // requester id -> ms until which analyses for them are allowed
	AllowNames      map[string]string    `json:"allowNames,omitempty"`      // requester id -> name shown in the consents list
	Declined        map[string]float64   `json:"declined,omitempty"`        // "KEY|requestedAt" -> ms of the decline
	Goal            int                  `json:"goal,omitempty"`            // installer goal 1-3 (Go agent)
	MutedUntil      float64              `json:"mutedUntil,omitempty"`      // ms until which the agent is muted (no prompts, others' jobs skipped)
	TeamMode        string               `json:"teamMode,omitempty"`        // ask | auto | off (source of truth: the server)
	Theme           string               `json:"theme,omitempty"`           // system | dark | light
	Lang            string               `json:"lang,omitempty"`            // en | pl, mirrors the account language on the server (empty = Windows UI language)
	AutoUpdate      *bool                `json:"autoUpdate,omitempty"`      // install new versions by itself when idle (default on)
	UpdateDismissed string               `json:"updateDismissed,omitempty"` // agent version whose update card was dismissed
	UpdatedTo       string               `json:"updatedTo,omitempty"`       // version a self-update was started for (the new process shows "updated" once)

	raw map[string]json.RawMessage
}

var knownKeys = []string{"url", "token", "oauth", "deviceId", "engine", "repos", "version", "lastPairing", "userName", "userId", "notifyOthers", "notifyOwn", "askOthers", "allowUntil", "allowNames", "declined", "goal", "mutedUntil", "teamMode", "theme", "lang", "updateDismissed", "updatedTo"}

func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		h, _ := os.UserHomeDir()
		base = filepath.Join(h, ".local", "share")
	}
	return filepath.Join(base, "exponential-agent")
}

func parseConfig(b []byte) Config {
	var c Config
	if json.Unmarshal(b, &c) != nil {
		return Config{Repos: map[string]RepoEntry{}}
	}
	_ = json.Unmarshal(b, &c.raw)
	if c.Repos == nil {
		c.Repos = map[string]RepoEntry{}
	}
	c.Token = unprotectSecret(c.Token)
	if c.OAuth != nil {
		o := *c.OAuth
		o.Refresh = unprotectSecret(o.Refresh)
		c.OAuth = &o
	}
	return c
}

func loadConfig() Config {
	b, err := os.ReadFile(filepath.Join(dataDir(), "config.json"))
	if err != nil {
		return Config{Repos: map[string]RepoEntry{}}
	}
	return parseConfig(b)
}

func (c *Config) marshal() ([]byte, error) {
	// Tokens are encrypted at rest (DPAPI on Windows); the in-memory config keeps plain text.
	enc := *c
	enc.Token = protectSecret(c.Token)
	if c.OAuth != nil {
		o := *c.OAuth
		o.Refresh = protectSecret(o.Refresh)
		enc.OAuth = &o
	}
	own, err := json.Marshal(&enc)
	if err != nil {
		return nil, err
	}
	var m map[string]json.RawMessage
	_ = json.Unmarshal(own, &m)
	out := map[string]json.RawMessage{}
	for k, v := range c.raw {
		out[k] = v
	}
	for _, k := range knownKeys {
		delete(out, k)
	}
	for k, v := range m {
		out[k] = v
	}
	return json.MarshalIndent(out, "", "  ")
}

// updateConfig reads the fresh file, applies fn and writes atomically (the hook and the agent both write).
func updateConfig(fn func(c *Config)) Config {
	c := loadConfig()
	fn(&c)
	c.Version = Version
	if c.DeviceID == "" {
		c.DeviceID = stableDeviceID()
	}
	dir := dataDir()
	_ = os.MkdirAll(dir, 0o755)
	b, err := c.marshal()
	if err == nil {
		tmp := filepath.Join(dir, fmt.Sprintf("config.json.%d.tmp", os.Getpid()))
		if err = os.WriteFile(tmp, b, 0o600); err == nil {
			err = os.Rename(tmp, filepath.Join(dir, "config.json"))
		}
	}
	if err != nil {
		logf("config write failed: %v", err)
	}
	return c
}

// stableDeviceID: the same id after a reinstall on the same computer and account, so the server keeps one entry
// per computer instead of a new one for every install. Falls back to a random id when the machine id is unknown.
func stableDeviceID() string {
	m := machineID()
	if m == "" {
		return newUUID()
	}
	user, _ := os.UserHomeDir()
	sum := sha256.Sum256([]byte("exponential-agent|" + m + "|" + user))
	return formatUUID(sum[:16])
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return formatUUID(b)
}

func formatUUID(b []byte) string {
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// autoUpdateOn: new versions install by themselves (when no analysis runs) unless switched off.
func autoUpdateOn() bool {
	c := loadConfig()
	return c.AutoUpdate == nil || *c.AutoUpdate
}

// notifyOthersOn: the toast for analyses requested by others is on unless switched off.
func notifyOthersOn() bool {
	c := loadConfig()
	return c.NotifyOthers == nil || *c.NotifyOthers
}

// notifyOwnOn: the card for own analyses (e.g. started from the phone) is on unless switched off.
func notifyOwnOn() bool {
	c := loadConfig()
	return c.NotifyOwn == nil || *c.NotifyOwn
}

// forgetOnServer: on uninstall, remove this computer from the server so it does not linger in the list. Best effort.
// Returns true when the server confirmed (2xx) or there was nothing to unregister.
func forgetOnServer() bool {
	cfg := loadConfig()
	ok := true
	if cfg.DeviceID != "" {
		ok = false
		if a, aerr := getAuth(); aerr == nil && a != nil { // getAuth refreshes an expired access token
			var err error
			err = request(a, "DELETE", "/api/agents/"+cfg.DeviceID, nil, 5*time.Second, nil)
			if httpStatus(err) == 401 && cfg.OAuth != nil { // access token expired: force a refresh and retry once
				updateConfig(func(c *Config) {
					if c.OAuth != nil {
						c.OAuth.ExpiresAt = 0
					}
				})
				if a2, e2 := getAuth(); e2 == nil && a2 != nil {
					err = request(a2, "DELETE", "/api/agents/"+cfg.DeviceID, nil, 5*time.Second, nil)
				}
			}
			ok = err == nil
		}
	}
	// The sign-in itself goes too, so it does not stay in Settings as a connection.
	if cfg.OAuth != nil && cfg.OAuth.Refresh != "" && cfg.URL != "" {
		_, _ = oauthPost(strings.TrimRight(cfg.URL, "/"), "/oauth/revoke", map[string]any{"token": cfg.OAuth.Refresh, "client_id": cfg.OAuth.ClientID}, false)
	}
	return ok
}

// forgetFailedMsg: shown after an uninstall when the server did not confirm the removal.
func forgetFailedMsg(lang string) string {
	if lang == "pl" {
		return "Nie udało się wyrejestrować komputera z serwera. Usuń go w Ustawieniach > AI."
	}
	return "Could not unregister this computer from the server. Remove it in Settings > AI."
}
