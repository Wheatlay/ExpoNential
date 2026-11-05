package app

// Auto repo discovery: folders the user already opened in Claude Code, VS Code and Cursor are matched against the
// GitHub repo of each project that has no mapping yet. No disk scanning.

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxCandidates = 300
	maxChildren   = 50
	maxPathLen    = 260
	discoverEvery = 5 * time.Minute
	foundEvery    = 5 * time.Minute
	maxFound      = 100
)

var driveRe = regexp.MustCompile(`^[A-Za-z]:`)

// normPath turns a folder path or file:// URI (as written by Claude Code, VS Code, Cursor) into a clean OS path.
// Returns "" for anything that is not a local folder path.
func normPath(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if i := strings.Index(s, "://"); i > 0 || strings.HasPrefix(s, "file:") {
		u, err := url.Parse(s)
		if err != nil || u.Scheme != "file" {
			return ""
		}
		s = u.Path
		if u.Host != "" && u.Host != "localhost" {
			s = "//" + u.Host + s
		}
		if len(s) > 2 && s[0] == '/' && driveRe.MatchString(s[1:]) {
			s = s[1:]
		}
	}
	if runtime.GOOS == "windows" && driveRe.MatchString(s) {
		s = strings.ToUpper(s[:1]) + s[1:]
	}
	s = filepath.Clean(filepath.FromSlash(s))
	if len(s) > maxPathLen || !filepath.IsAbs(s) {
		return ""
	}
	return s
}

func dedupKey(p string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(p)
	}
	return p
}

// claudeProjectPaths: keys of the "projects" object of a .claude.json.
func claudeProjectPaths(data []byte) []string {
	var v struct {
		Projects map[string]json.RawMessage `json:"projects"`
	}
	if json.Unmarshal(data, &v) != nil {
		return nil
	}
	var out []string
	for k := range v.Projects {
		if p := normPath(k); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// vscodeStoragePaths: recent workspaces from a VS Code / Cursor globalStorage/storage.json. Keys read:
// backupWorkspaces.folders[].folderUri, profileAssociations.workspaces (object keys),
// windowsState.lastActiveWindow.folder, windowsState.openedWindows[].folder.
func vscodeStoragePaths(data []byte) []string {
	var v struct {
		Backup struct {
			Folders []struct {
				FolderURI string `json:"folderUri"`
			} `json:"folders"`
		} `json:"backupWorkspaces"`
		Profiles struct {
			Workspaces map[string]json.RawMessage `json:"workspaces"`
		} `json:"profileAssociations"`
		Windows struct {
			Last struct {
				Folder string `json:"folder"`
			} `json:"lastActiveWindow"`
			Opened []struct {
				Folder string `json:"folder"`
			} `json:"openedWindows"`
		} `json:"windowsState"`
	}
	if json.Unmarshal(data, &v) != nil {
		return nil
	}
	var raw []string
	for _, f := range v.Backup.Folders {
		raw = append(raw, f.FolderURI)
	}
	for k := range v.Profiles.Workspaces {
		raw = append(raw, k)
	}
	raw = append(raw, v.Windows.Last.Folder)
	for _, w := range v.Windows.Opened {
		raw = append(raw, w.Folder)
	}
	var out []string
	for _, r := range raw {
		if p := normPath(r); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func isGitDir(p string) bool {
	st, err := os.Stat(p)
	if err != nil || !st.IsDir() {
		return false
	}
	_, err = os.Stat(filepath.Join(p, ".git")) // a directory, or a file for worktrees
	return err == nil
}

// uniquePaths dedups (case-insensitively on Windows), keeping order.
func uniquePaths(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range in {
		k := dedupKey(p)
		if p == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, p)
	}
	return out
}

func readFile(p string) []byte {
	b, _ := os.ReadFile(p)
	return b
}

// candidateFolders collects existing git folders from Claude Code, VS Code and Cursor history.
func candidateFolders() []string {
	var raw []string
	home, _ := os.UserHomeDir()
	if home != "" {
		raw = append(raw, claudeProjectPaths(readFile(filepath.Join(home, ".claude.json")))...)
		if ents, err := os.ReadDir(filepath.Join(home, ".claude-accounts")); err == nil {
			for _, e := range ents {
				if e.IsDir() {
					raw = append(raw, claudeProjectPaths(readFile(filepath.Join(home, ".claude-accounts", e.Name(), ".claude.json")))...)
				}
			}
		}
	}
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		raw = append(raw, claudeProjectPaths(readFile(filepath.Join(d, ".claude.json")))...)
	}
	if ad := os.Getenv("APPDATA"); ad != "" {
		for _, app := range []string{"Code", "Cursor"} {
			raw = append(raw, vscodeStoragePaths(readFile(filepath.Join(ad, app, "User", "globalStorage", "storage.json")))...)
		}
	}
	raw = append(raw, codexProjectPaths(readFile(codexConfigPath()))...)
	raw = uniquePaths(raw)
	if len(raw) > maxCandidates {
		raw = raw[:maxCandidates]
	}
	var out []string
	for _, p := range raw {
		if isGitDir(p) {
			out = append(out, p)
			continue
		}
		if par := filepath.Dir(p); par != p && isGitDir(par) { // parent only, no recursion
			out = append(out, par)
			continue
		}
		// A folder opened one level above the repo (e.g. Desktop\Umowy holding umowy_projekt): its direct
		// subfolders only, capped, no deeper.
		if ents, err := os.ReadDir(p); err == nil {
			n := 0
			for _, e := range ents {
				if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || e.Name() == "node_modules" {
					continue
				}
				if n++; n > maxChildren {
					break
				}
				if c := filepath.Join(p, e.Name()); isGitDir(c) {
					out = append(out, c)
				}
			}
		}
	}
	if len(out) > maxCandidates {
		out = out[:maxCandidates]
	}
	return uniquePaths(out)
}

var discoverMu sync.Mutex

// discoverRepos maps projects without a mapping to a matching folder the user already opened (source "auto").
// Never overrides an existing mapping. Returns the number of new mappings.
func discoverRepos(a *Auth) int {
	discoverMu.Lock()
	defer discoverMu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			logf("repo discovery: %v", r)
		}
	}()
	list, err := listProjects(a)
	if err != nil {
		return 0
	}
	have := loadConfig().Repos
	var todo []Project
	for _, p := range list {
		if _, ok := have[p.Key]; !ok && p.repo() != "" && projKeyRe.MatchString(p.Key) {
			todo = append(todo, p)
		}
	}
	if len(todo) == 0 {
		return 0
	}
	// Nothing changed since the last pass (same history files, same projects to find): skip the folder walk.
	sig := discoverSignature(todo)
	if sig == lastDiscoverSig {
		return 0
	}
	lastDiscoverSig = sig
	cands := candidateFolders()
	found := map[string]string{}
	for _, p := range todo {
		for _, c := range cands {
			if hasRemote(c, p.repo()) {
				found[p.Key] = c
				break
			}
		}
	}
	if len(found) == 0 {
		return 0
	}
	n := 0
	updateConfig(func(c *Config) {
		for k, p := range found {
			if _, ok := c.Repos[k]; !ok {
				c.Repos[k] = RepoEntry{Path: p, Source: "auto"}
				logf("repo discovery: %s -> %s", k, p)
				n++
			}
		}
	})
	return n
}

var lastDiscoverSig string

// codexConfigPath: Codex keeps folders the user trusted as [projects."<path>"] tables in $CODEX_HOME/config.toml.
func codexConfigPath() string {
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return filepath.Join(h, "config.toml")
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".codex", "config.toml")
}

var codexProjectRe = regexp.MustCompile(`(?m)^\s*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]`)

// codexProjectPaths reads the project table names from Codex's config.toml (basic or literal TOML strings).
func codexProjectPaths(data []byte) []string {
	var out []string
	for _, m := range codexProjectRe.FindAllSubmatch(data, -1) {
		p := string(m[2])
		if len(m[1]) > 0 {
			if u, err := strconv.Unquote(`"` + string(m[1]) + `"`); err == nil {
				p = u
			}
		}
		if p = normPath(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// historyFiles: the files candidate folders come from. Their modification times decide whether to look again.
func historyFiles() []string {
	var fs []string
	if home, _ := os.UserHomeDir(); home != "" {
		fs = append(fs, filepath.Join(home, ".claude.json"))
		if ents, err := os.ReadDir(filepath.Join(home, ".claude-accounts")); err == nil {
			for _, e := range ents {
				if e.IsDir() {
					fs = append(fs, filepath.Join(home, ".claude-accounts", e.Name(), ".claude.json"))
				}
			}
		}
	}
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		fs = append(fs, filepath.Join(d, ".claude.json"))
	}
	if ad := os.Getenv("APPDATA"); ad != "" {
		for _, app := range []string{"Code", "Cursor"} {
			fs = append(fs, filepath.Join(ad, app, "User", "globalStorage", "storage.json"))
		}
	}
	if c := codexConfigPath(); c != "" {
		fs = append(fs, c)
	}
	return fs
}

func discoverSignature(todo []Project) string {
	var b strings.Builder
	for _, f := range historyFiles() {
		if st, err := os.Stat(f); err == nil {
			fmt.Fprintf(&b, "%s|%d|%d;", f, st.ModTime().UnixNano(), st.Size())
		}
	}
	for _, p := range todo {
		fmt.Fprintf(&b, "%s=%s;", p.Key, strings.ToLower(p.repo()))
	}
	return b.String()
}

// gitConfigOf returns the contents of the repo's git config (no git process), or nil. Handles worktrees and
// submodules, where .git is a file pointing to the real git dir.
func gitConfigOf(dir string) []byte {
	gitDir := filepath.Join(dir, ".git")
	if st, err := os.Stat(gitDir); err == nil && !st.IsDir() {
		line := strings.TrimSpace(string(readFile(gitDir)))
		if !strings.HasPrefix(line, "gitdir:") {
			return nil
		}
		gitDir = strings.TrimSpace(strings.TrimPrefix(line, "gitdir:"))
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(dir, gitDir)
		}
		// A worktree's own git dir has "commondir" pointing to the main repository, where the config lives.
		if c := strings.TrimSpace(string(readFile(filepath.Join(gitDir, "commondir")))); c != "" {
			if !filepath.IsAbs(c) {
				c = filepath.Join(gitDir, c)
			}
			gitDir = c
		}
	}
	return readFile(filepath.Join(gitDir, "config"))
}

// configURLs lists every "url =" value of a git config.
func configURLs(cfg []byte) []string {
	var out []string
	for _, l := range strings.Split(string(cfg), "\n") {
		l = strings.TrimSpace(l)
		if k, v, ok := strings.Cut(l, "="); ok && strings.TrimSpace(k) == "url" {
			out = append(out, strings.TrimSpace(v))
		}
	}
	return out
}

// hasRemote reads the repo's git config directly (no git process) and says whether a remote points to githubRepo.
func hasRemote(dir, githubRepo string) bool {
	want := strings.ToLower(githubRepo)
	for _, u := range configURLs(gitConfigOf(dir)) {
		if slug(u) == want {
			return true
		}
	}
	return false
}

var foundSlugRe = regexp.MustCompile(`^[a-z0-9_.-]+/[a-z0-9_.-]+$`)

// foundRepoSlugs lists the GitHub repos (owner/name, lowercase) of the candidate folders on this PC.
func foundRepoSlugs() []string {
	seen := map[string]bool{}
	var out []string
	for _, c := range candidateFolders() {
		for _, u := range configURLs(gitConfigOf(c)) {
			if s := slug(u); foundSlugRe.MatchString(s) && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	sort.Strings(out)
	if len(out) > maxFound {
		out = out[:maxFound]
	}
	return out
}

var (
	foundMu      sync.Mutex
	foundCache   []string
	foundAt      time.Time
	foundRunning bool
)

// cachedFoundSlugs returns the last computed list and starts a background refresh when it is older than foundEvery
// (or force is true), so the poll never waits for the folder walk.
func cachedFoundSlugs(force bool) []string {
	foundMu.Lock()
	defer foundMu.Unlock()
	if (force || time.Since(foundAt) >= foundEvery) && !foundRunning {
		foundRunning = true
		go func() {
			defer func() {
				_ = recover()
				foundMu.Lock()
				foundRunning = false
				foundMu.Unlock()
			}()
			l := foundRepoSlugs()
			foundMu.Lock()
			foundCache, foundAt = l, time.Now()
			foundMu.Unlock()
		}()
	}
	return foundCache
}

// discoverLoop runs discovery now and then every discoverEvery.
func discoverLoop() {
	for {
		if a, err := getAuth(); err == nil && a != nil {
			discoverRepos(a)
		}
		time.Sleep(discoverEvery)
	}
}

// forceDiscoverRepos is the "Rescan" button: the same discovery as at first setup, but without the shortcut that
// skips the folder walk when nothing changed since the last pass.
func forceDiscoverRepos(a *Auth) int {
	discoverMu.Lock()
	lastDiscoverSig = ""
	discoverMu.Unlock()
	return discoverRepos(a)
}
