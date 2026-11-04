package app

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"exponential-agent/internal/plugin"
)

var models = []string{"haiku", "sonnet", "opus", "fable"}

func isModel(m string) bool {
	for _, x := range models {
		if x == m {
			return true
		}
	}
	return false
}

// ensurePlugin extracts the bundled plugin to <dataDir>/plugin-<version>/ (once per agent version).
func ensurePlugin() (string, error) {
	dir := filepath.Join(dataDir(), "plugin-"+Version)
	if _, err := os.Stat(filepath.Join(dir, ".claude-plugin", "plugin.json")); err == nil {
		return dir, nil
	}
	tmp := fmt.Sprintf("%s.tmp-%d", dir, os.Getpid())
	_ = os.RemoveAll(tmp)
	err := fs.WalkDir(plugin.FS, "files", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() == ".gitkeep" {
			return err
		}
		b, err := plugin.FS.ReadFile(p)
		if err != nil {
			return err
		}
		out := filepath.Join(tmp, filepath.FromSlash(strings.TrimPrefix(p, "files/")))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		return os.WriteFile(out, b, 0o644)
	})
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(tmp, ".claude-plugin", "plugin.json")); err != nil {
		return "", fmt.Errorf("bundled plugin is missing (build without copying plugin/)")
	}
	_ = os.RemoveAll(dir)
	return dir, os.Rename(tmp, dir)
}

func findEngine(engine string) string {
	if b := whichBin(engine); b != "" {
		return b
	}
	if engine == "claude" {
		return extensionClaude()
	}
	return ""
}

// Issue text is written by every project member, so it is untrusted (prompt injection). Read/Grep/Glob are NOT
// allowed explicitly and --permission-mode default is forced (a user defaultMode/allow must not widen it), so in -p mode
// reads outside the repo are not approved. Secrets (repo-relative and absolute, see secrets.go) are denied on top.
// Deny rules win over allow rules in Claude Code, so a blanket Read(//**) deny would also block the repo: not used.
const allowedTools = "Skill,mcp__expo__get_procedure,mcp__expo__get_issue,mcp__expo__list_comments,mcp__expo__list_issues,mcp__expo__set_analysis"

// othersRun: the analysis was requested by someone other than this account (or the identity is unknown), so the
// repo's own .claude settings must not load.
func othersRun(own int, rq requesterInfo) bool { return own == 0 || rq.ID == 0 || rq.ID != own }

type runOpts struct {
	untrusted     bool
	others        bool   // requested by someone else: the tracker MCP is limited to this one issue
	issueKey      string // KEY-N of the analysis
	engine, bin   string
	prompt, model string
	cwd           string
	base, auth    string
	activeAccount string
}

// runEngine runs the engine non-interactively in cwd, prompt on stdin, output appended to the log. Returns the exit code.
func runEngine(o runOpts) (int, *runUsage, engineFailure) {
	env := append(os.Environ(), "TRACKER_HOOKS=0") // a background session leaves no worklog
	var args []string
	if o.engine == "claude" {
		// Only the tracker MCP, none of the user's other servers.
		mcpFile := filepath.Join(dataDir(), fmt.Sprintf("mcp-%d-%d.json", os.Getpid(), time.Now().UnixNano()))
		_ = os.MkdirAll(dataDir(), 0o755)
		hdr := map[string]string{"Authorization": o.auth}
		if o.others && o.issueKey != "" {
			hdr["X-Exponential-Issue"] = o.issueKey // the server limits the tools to this one issue
		}
		mcp, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"expo": map[string]any{"type": "http", "url": o.base + "/mcp", "headers": hdr}}})
		_ = os.WriteFile(mcpFile, mcp, 0o600)
		defer os.Remove(mcpFile) // the bearer token must not stay on disk
		pdir, err := ensurePlugin()
		if err != nil {
			logRaw("agent: plugin error " + err.Error() + "\n")
			return -1, nil, engineFailure{Reason: "plugin error: " + err.Error()}
		}
		// A 'clone' repo comes from the project's githubRepo, which a project admin controls: its .claude/settings*.json,
		// hooks and .mcp.json must not run on this machine. So only user settings load; --strict-mcp-config ignores every
		// MCP source except our --mcp-config. Own folders (manual/hook) keep project settings.
		src := "project"
		if o.untrusted {
			src = "user"
		}
		args = []string{"-p", "--model", o.model, "--plugin-dir", pdir, "--permission-mode", "default", "--allowedTools", allowedTools, "--disallowedTools", denyRules(o.activeAccount, activeAccount()),
			"--setting-sources", src, "--strict-mcp-config", "--mcp-config", mcpFile, "--output-format", "json"}
		if o.activeAccount != "" {
			env = append(env, "CLAUDE_CONFIG_DIR="+o.activeAccount)
		}
	} else {
		// TODO(verify): codex config keys for streamable-HTTP MCP with a bearer token (bearer_token_env_var).
		// The token goes through the environment, not the command line.
		env = append(env, "EXPONENTIAL_AGENT_TOKEN="+regexp.MustCompile(`(?i)^Bearer `).ReplaceAllString(o.auth, ""))
		urlJSON, _ := json.Marshal(o.base + "/mcp")
		args = []string{"exec", "--sandbox", "read-only",
			"-c", "mcp_servers.expo.url=" + string(urlJSON),
			"-c", `mcp_servers.expo.bearer_token_env_var="EXPONENTIAL_AGENT_TOKEN"`, "-"}
	}
	_ = path.Base // keep import set stable
	_ = os.MkdirAll(dataDir(), 0o755)
	out, err := os.OpenFile(logFile(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return -1, nil, engineFailure{Reason: "cannot open log.txt"}
	}
	defer out.Close()
	c := engineCmd(o.bin, args)
	c.Dir, c.Env = o.cwd, env
	c.Stdin = strings.NewReader(o.prompt)
	var captured limitedBuf
	var outTail, errTail tailBuf
	outTail.n, errTail.n = 4096, 4096
	if o.engine == "claude" {
		c.Stdout = io.MultiWriter(out, &captured, &outTail)
	} else {
		c.Stdout = io.MultiWriter(out, &outTail)
	}
	c.Stderr = io.MultiWriter(out, &errTail)
	if err := c.Start(); err != nil {
		_, _ = out.WriteString("agent: spawn error " + err.Error() + "\n")
		return -1, nil, engineFailure{Reason: "cannot start: " + err.Error()}
	}
	timer := time.AfterFunc(30*time.Minute, func() {
		_, _ = out.WriteString("agent: timeout 30 min, killing\n")
		_ = c.Process.Kill()
	})
	defer timer.Stop()
	code := 0
	if err := c.Wait(); err != nil {
		code = -1
		if ee, ok := err.(interface{ ExitCode() int }); ok && ee.ExitCode() >= 0 {
			code = ee.ExitCode()
		}
	}
	var fail engineFailure
	if code != 0 {
		stdout := outTail.Bytes()
		if o.engine == "claude" {
			stdout = captured.b
		}
		fail = analyzeFailure(stdout, errTail.Bytes())
	}
	if o.engine == "claude" {
		return code, parseClaudeUsage(captured.b), fail
	}
	return code, nil, fail // codex: no usage option checked (codex is not installed here), so none is sent
}

// limitedBuf keeps the last 4 MB written to it (the JSON result is at the end).
type limitedBuf struct{ b []byte }

func (l *limitedBuf) Write(p []byte) (int, error) {
	l.b = append(l.b, p...)
	if len(l.b) > 4<<20 {
		l.b = l.b[len(l.b)-(4<<20):]
	}
	return len(p), nil
}
