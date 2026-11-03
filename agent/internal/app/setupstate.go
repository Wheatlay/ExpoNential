package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// What is actually set up on this computer, read from config files (no child processes) and sent with every poll,
// so Connect AI and Settings show the real state right after install and notice when something is removed.
// Claude Code in the terminal and in the VS Code / Cursor extension share these files, so one check covers them all.

type claudeSetup struct {
	Name   string `json:"name"`
	MCP    bool   `json:"mcp"`
	Plugin bool   `json:"plugin"`
}

type setupState struct {
	Claude []claudeSetup `json:"claude"`
	Codex  bool          `json:"codex"`
	Cursor bool          `json:"cursor"`
}

// pluginDir: where the account keeps plugins (~/.claude for the default account, the account folder otherwise).
func pluginDir(dir string) string {
	if dir == "" {
		h, _ := os.UserHomeDir()
		return filepath.Join(h, ".claude")
	}
	return dir
}

// pluginInstalled: tracker@tracker is in installed_plugins.json and not switched off in settings.json.
func pluginInstalled(installed, settings []byte) bool {
	var inst struct {
		Plugins map[string]json.RawMessage `json:"plugins"`
	}
	if json.Unmarshal(installed, &inst) != nil {
		return false
	}
	if _, ok := inst.Plugins["tracker@tracker"]; !ok {
		return false
	}
	var s struct {
		Enabled map[string]bool `json:"enabledPlugins"`
	}
	if json.Unmarshal(settings, &s) == nil {
		if on, ok := s.Enabled["tracker@tracker"]; ok && !on {
			return false
		}
	}
	return true
}

// codexHasTracker: config.toml has an [mcp_servers.tracker] table.
func codexHasTracker(toml []byte) bool {
	for _, l := range strings.Split(string(toml), "\n") {
		l = strings.TrimSpace(l)
		if l == "[mcp_servers.tracker]" || l == `[mcp_servers."tracker"]` {
			return true
		}
	}
	return false
}

// cursorHasTracker: ~/.cursor/mcp.json has mcpServers.tracker.
func cursorHasTracker(data []byte) bool {
	var c struct {
		MCP map[string]json.RawMessage `json:"mcpServers"`
	}
	if json.Unmarshal(data, &c) != nil {
		return false
	}
	_, ok := c.MCP["tracker"]
	return ok
}

func readSetup(base string) setupState {
	st := setupState{Claude: []claudeSetup{}}
	for _, d := range claudeConfigDirs() {
		pd := pluginDir(d)
		st.Claude = append(st.Claude, claudeSetup{
			Name:   accountName(d),
			MCP:    mcpConfigHas(readFile(configFile(d)), base),
			Plugin: pluginInstalled(readFile(filepath.Join(pd, "plugins", "installed_plugins.json")), readFile(filepath.Join(pd, "settings.json"))),
		})
	}
	home, _ := os.UserHomeDir()
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	st.Codex = codexHasTracker(readFile(filepath.Join(codexHome, "config.toml")))
	st.Cursor = cursorHasTracker(readFile(filepath.Join(home, ".cursor", "mcp.json")))
	return st
}

var setupCache struct {
	sync.Mutex
	at   time.Time
	base string
	json string
}

// setupJSON: the state as JSON, read at most once a minute (.claude.json can be large).
func setupJSON(base string) string {
	setupCache.Lock()
	defer setupCache.Unlock()
	if setupCache.json != "" && setupCache.base == base && time.Since(setupCache.at) < time.Minute {
		return setupCache.json
	}
	b, _ := json.Marshal(readSetup(base))
	setupCache.at, setupCache.base, setupCache.json = time.Now(), base, string(b)
	return setupCache.json
}
