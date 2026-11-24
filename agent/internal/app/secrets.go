package app

import (
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

// One list of secret-looking files, used by both the Claude deny rules (relative to the repo) and the Codex
// worktree cleanup (scrubSecrets in repos.go).
var secretGlobs = []string{"**/.env*", "**/*.pem", "**/*.key", "**/*.pfx", "**/*.p12",
	"**/secrets*.json", "**/appsettings.*.json", "**/id_rsa*", "**/id_*", "**/*.keystore", "**/credentials*",
	"**/.credentials*", "**/.npmrc", "**/.git-credentials", "**/*.tfvars"}

// isSecretName: the basename matches one of secretGlobs (case-insensitive).
func isSecretName(name string) bool {
	n := strings.ToLower(name)
	for _, g := range secretGlobs {
		if ok, _ := path.Match(strings.ToLower(strings.TrimPrefix(g, "**/")), n); ok {
			return true
		}
	}
	return false
}

// homeSecretPaths are absolute secrets outside any repo, as Claude Code rule paths (~/ = home).
var homeSecretPaths = []string{"~/.claude/.credentials.json", "~/.claude-accounts/**/.credentials.json", "~/.ssh/**", "~/.aws/**",
	"~/.npmrc", "~/.git-credentials", "~/.config/gh/**"}

// ruleAbs turns an absolute OS path into a Claude Code permission path ("//" = from the filesystem root;
// on Windows C:\x\y -> //c/x/y). "" when the path cannot be written safely in a rule.
func ruleAbs(p string) string {
	if p == "" || strings.ContainsAny(p, ",()") {
		return ""
	}
	s := filepath.ToSlash(p)
	if runtime.GOOS == "windows" {
		if len(s) >= 2 && s[1] == ':' {
			s = "/" + strings.ToLower(s[:1]) + s[2:]
		}
	}
	return "/" + strings.TrimRight(s, "/")
}

// dataDirSecretFiles: the agent's own files at the top of the data dir (config.json with the token, mcp-*.json with
// the bearer, log.txt, runs.json, locks, stack dumps). Only top-level files ("*" does not cross "/"): the analysis
// worktrees, clones and temp worktrees also live in the data dir (worktrees/, repos/, tmp/) and must stay readable.
// A blanket dataDir/** deny blocked every run requested by someone else (CHUB-240).
var dataDirSecretFiles = []string{"*.json", "*.txt", "*.lock"}

// secretDenyPaths: every absolute location a run must not read. extraDirs are more Claude config dirs (accounts).
func secretDenyPaths(extraDirs ...string) []string {
	out := []string{}
	if d := ruleAbs(dataDir()); d != "" {
		for _, f := range dataDirSecretFiles {
			out = append(out, d+"/"+f)
		}
	}
	out = append(out, homeSecretPaths...)
	for _, d := range extraDirs {
		if r := ruleAbs(d); r != "" {
			out = append(out, r+"/.credentials.json")
		}
	}
	return out
}

// denyRules builds the --disallowedTools list.
func denyRules(extraDirs ...string) string {
	parts := []string{"Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"}
	for _, s := range secretGlobs {
		parts = append(parts, "Read("+s+")", "Grep("+s+")")
	}
	for _, p := range secretDenyPaths(extraDirs...) {
		parts = append(parts, "Read("+p+")", "Grep("+p+")")
	}
	return strings.Join(parts, ",")
}

