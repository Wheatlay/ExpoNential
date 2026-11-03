package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The installer does every level up to the chosen goal:
//   1 issue access (MCP server "tracker" in Claude Code / Codex), 2 work trace (Claude Code plugin), 3 background agent.

func ltx(p, e string) string {
	if uiLang() == "pl" {
		return p
	}
	return e
}

// setupEvent reports one row: state is now | ok | err | skip; note is a short reason (err, skip).
type setupEvent func(level int, state, note string)

type setupOutcome struct {
	Res       installResult // Code != "" = the pairing failed (fatal)
	Errors    int
	Done      []int // levels that finished fine
	AgentSeen bool  // level 3: the server confirmed the agent
}

// ---- pure helpers (unit tested) ----

func claudeMcpRemoveArgs() []string {
	return []string{"mcp", "remove", "tracker", "--scope", "user"}
}

func claudeMcpAddArgs(base, token string) []string {
	return []string{"mcp", "add", "--transport", "http", "--scope", "user", "tracker", base + "/mcp", "--header", "Authorization: Bearer " + token}
}

// claudePluginSteps are run in order for every config dir. The first (marketplace remove) and the update steps may
// fail harmlessly; an error of marketplace add / install is reported (an "already ..." answer is normal).
func claudePluginSteps(base string) [][]string {
	return [][]string{
		{"plugin", "marketplace", "remove", "tracker"},
		{"plugin", "marketplace", "add", base + "/agent/marketplace.json"},
		{"plugin", "marketplace", "update", "tracker"},
		{"plugin", "install", "tracker@tracker"},
		{"plugin", "update", "tracker@tracker"},
	}
}

// mcpConfigHas: .claude.json has mcpServers.tracker pointing at base/mcp.
func mcpConfigHas(data []byte, base string) bool {
	var c struct {
		MCP map[string]struct {
			URL string `json:"url"`
		} `json:"mcpServers"`
	}
	if json.Unmarshal(data, &c) != nil {
		return false
	}
	s, ok := c.MCP["tracker"]
	return ok && strings.TrimRight(s.URL, "/") == base+"/mcp"
}

func pluginListHas(out string) bool { return strings.Contains(out, "tracker@tracker") }

func stripEnv(env []string, name string) []string {
	var out []string
	for _, e := range env {
		if k, _, ok := strings.Cut(e, "="); ok && strings.EqualFold(k, name) {
			continue
		}
		out = append(out, e)
	}
	return out
}

func scrub(s, secret string) string {
	if secret != "" {
		s = strings.ReplaceAll(s, secret, "***")
	}
	return s
}

// claudeConfigDirs: "" = the default account (~/.claude.json), the folders in ~/.claude-accounts/* that hold a
// .claude.json, and $CLAUDE_CONFIG_DIR. At least the default one.
func claudeConfigDirs() []string {
	home, _ := os.UserHomeDir()
	var out []string
	add := func(d string) {
		for _, x := range out {
			if (x == "" && d == "") || (x != "" && d != "" && sameDir(x, d)) {
				return
			}
		}
		out = append(out, d)
	}
	if home != "" {
		if _, err := os.Stat(filepath.Join(home, ".claude.json")); err == nil {
			add("")
		}
		if ents, err := os.ReadDir(filepath.Join(home, ".claude-accounts")); err == nil {
			for _, e := range ents {
				d := filepath.Join(home, ".claude-accounts", e.Name())
				if e.IsDir() {
					if _, err := os.Stat(filepath.Join(d, ".claude.json")); err == nil {
						add(d)
					}
				}
			}
		}
	}
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			add(d)
		}
	}
	if len(out) == 0 {
		out = []string{""}
	}
	return out
}

func configFile(dir string) string {
	if dir == "" {
		h, _ := os.UserHomeDir()
		return filepath.Join(h, ".claude.json")
	}
	return filepath.Join(dir, ".claude.json")
}

// runCmd runs a child process without a window; CLAUDE_CONFIG_DIR is set for account folders and removed for the default.
func runCmd(bin string, args []string, claudeDir string, timeout time.Duration, secret string) (string, error) {
	c := engineCmd(bin, args)
	env := os.Environ()
	if bin != "" && claudeDir != "-" {
		env = stripEnv(env, "CLAUDE_CONFIG_DIR")
		if claudeDir != "" {
			env = append(env, "CLAUDE_CONFIG_DIR="+claudeDir)
		}
	}
	c.Env = env
	var buf bytes.Buffer
	c.Stdout, c.Stderr = &buf, &buf
	if err := c.Start(); err != nil {
		return "", err
	}
	t := time.AfterFunc(timeout, func() { _ = c.Process.Kill() })
	defer t.Stop()
	err := c.Wait()
	return scrub(buf.String(), secret), err
}

func shortOut(out string, err error) string {
	s := cleanText(out)
	if s == "" && err != nil {
		s = err.Error()
	}
	return cut(s, 120)
}

func fetchMCPKey(a *Auth) (string, error) {
	host, _ := os.Hostname()
	var r struct {
		Token string `json:"token"`
	}
	if err := request(a, "POST", "/api/agent/mcp-key", map[string]string{"client": "Claude Code", "device": host}, 30*time.Second, &r); err != nil {
		return "", err
	}
	if r.Token == "" {
		return "", errors.New("the server returned no key")
	}
	return r.Token, nil
}

// ---- level 1 and 2 ----

func setupAccess(engine, base string) error {
	bin := findEngine(engine)
	if bin == "" {
		return errors.New(ltx("nie znaleziono ", "not found: ") + map[bool]string{true: "Codex", false: "Claude Code"}[engine == "codex"])
	}
	if engine == "codex" {
		out, err := runCmd(bin, []string{"mcp", "add", "tracker", "--url", base + "/mcp"}, "-", 60*time.Second, "")
		if err != nil && !strings.Contains(strings.ToLower(out), "already") {
			return errors.New(shortOut(out, err))
		}
		out, err = runCmd(bin, []string{"mcp", "login", "tracker"}, "-", 3*time.Minute, "")
		if err != nil {
			return errors.New(shortOut(out, err))
		}
		return nil
	}
	a, err := getAuth()
	if err != nil || a == nil {
		return errors.New(ltx("brak logowania", "not signed in"))
	}
	tok, err := fetchMCPKey(a)
	if err != nil {
		return err
	}
	var bad []string
	for _, d := range claudeConfigDirs() {
		_, _ = runCmd(bin, claudeMcpRemoveArgs(), d, 60*time.Second, tok)
		out, err := runCmd(bin, claudeMcpAddArgs(base, tok), d, 60*time.Second, tok)
		if mcpConfigHas(readFile(configFile(d)), base) {
			continue // claude may exit silently, the config is what counts
		}
		bad = append(bad, accountName(d)+": "+shortOut(out, err))
	}
	if len(bad) > 0 {
		return errors.New(strings.Join(bad, "; "))
	}
	return nil
}

func setupTrace(base string) error {
	bin := findEngine("claude")
	if bin == "" {
		return errors.New(ltx("nie znaleziono Claude Code", "Claude Code not found"))
	}
	var bad []string
	for _, d := range claudeConfigDirs() {
		last := ""
		for _, args := range claudePluginSteps(base) {
			out, err := runCmd(bin, args, d, 90*time.Second, "")
			if err != nil && !strings.Contains(strings.ToLower(out), "already") {
				if args[1] == "marketplace" && args[2] == "remove" || args[1] == "update" || args[2] == "update" {
					continue // best effort
				}
				last = shortOut(out, err) // marketplace add / install failed
			}
		}
		out, err := runCmd(bin, []string{"plugin", "list"}, d, 60*time.Second, "")
		if last != "" || !pluginListHas(out) {
			if last == "" {
				last = shortOut(out, err)
			}
			bad = append(bad, accountName(d)+": "+last)
		}
	}
	if len(bad) > 0 {
		return errors.New(strings.Join(bad, "; "))
	}
	return nil
}

// ---- the whole flow ----

// pairOnly pairs with the server and stores the sign-in.
func pairOnly(ctx *installCtx) (installResult, string) {
	host := hostOf(ctx.base)
	hn, _ := os.Hostname()
	devID := loadConfig().DeviceID
	if devID == "" {
		devID = updateConfig(func(c *Config) {}).DeviceID // generates the stable id
	}
	payload, _ := json.Marshal(map[string]string{"pairing": ctx.tr.Pairing, "name": hn, "deviceId": devID})
	status, body, err := httpDo("POST", ctx.base+"/api/agent/pair", map[string]string{"Content-Type": "application/json", "Accept": "application/json"}, payload, 30*time.Second)
	if err != nil {
		return installResult{Code: "network", Detail: err.Error()}, ""
	}
	if status == 404 {
		return installResult{Code: "expired"}, ""
	}
	if status == 429 {
		return installResult{Code: "ratelimit"}, ""
	}
	var pr struct {
		ClientID     string `json:"client_id"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    any    `json:"expires_in"`
		User         struct {
			Name string `json:"name"`
		} `json:"user"`
	}
	if status != 200 || json.Unmarshal(body, &pr) != nil || pr.AccessToken == "" {
		return installResult{Code: "http", Detail: fmt.Sprintf("HTTP %d (%s)", status, host)}, ""
	}
	exp := num(pr.ExpiresIn)
	if exp == 0 {
		exp = 3600
	}
	goal := ctx.goal
	updateConfig(func(c *Config) {
		c.URL, c.Token = ctx.base, ""
		c.OAuth = &OAuth{Access: pr.AccessToken, Refresh: pr.RefreshToken, ExpiresAt: nowMs() + exp*1000, ClientID: pr.ClientID}
		c.LastPairing = ctx.tr.Pairing
		c.UserName = pr.User.Name
		c.UserID = 0
		if e := ctx.tr.Engine; e == "claude" || e == "codex" {
			c.Engine = e
		}
		c.Goal = 0
		if goal < 3 {
			c.Goal = goal
		}
	})
	return installResult{Base: ctx.base, Token: pr.AccessToken}, pr.User.Name
}

// installAgent: copy the exe, Apps & features, autostart (when asked), start.
func installAgent(ctx *installCtx, autostart bool) error {
	installed, err := installApp(ctx.self, ctx.trSize)
	if err != nil {
		return err
	}
	if !autostart {
		autostartOff()
	}
	discoverBeforeStart()
	return startDetachedExe(installed)
}

// runSetup pairs, then does level 1, 2 and 3 up to ctx.goal. A failing level is reported and the next one still runs.
func runSetup(ctx *installCtx, autostart bool, ev setupEvent) (out setupOutcome) {
	goal, engine := ctx.goal, ctx.engine
	if goal < 1 || goal > 3 {
		goal = 3
	}
	if engine != "codex" {
		engine = "claude"
	}
	ev(1, "now", "")
	res, _ := pairOnly(ctx)
	if res.Code != "" {
		out.Res = res
		return out
	}
	out.Res = res
	step := func(level int, f func() error) {
		ev(level, "now", "")
		func() {
			defer func() {
				if r := recover(); r != nil {
					ev(level, "err", fmt.Sprint(r))
					out.Errors++
				}
			}()
			if err := f(); err != nil {
				logf("setup level %d: %s", level, err)
				ev(level, "err", err.Error())
				out.Errors++
				return
			}
			out.Done = append(out.Done, level)
			ev(level, "ok", "")
		}()
	}
	step(1, func() error { return setupAccess(engine, ctx.base) })
	if goal >= 2 {
		if engine == "codex" {
			ev(2, "skip", ltx("tylko Claude Code", "Claude Code only"))
		} else {
			step(2, func() error { return setupTrace(ctx.base) })
		}
	}
	if goal >= 3 {
		step(3, func() error {
			if err := installAgent(ctx, autostart); err != nil {
				return err
			}
			out.AgentSeen = waitForAgent(res.Base, res.Token)
			return nil
		})
	}
	return out
}
