package app

// Auto repo discovery: folders the user already opened in Claude Code, VS Code and Cursor are matched against the
// GitHub repo of each project that has no mapping yet. No disk scanning.

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	maxCandidates = 300
	maxChildren   = 50
	maxPathLen    = 260
	discoverEvery = 60 * time.Minute
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
	cands := candidateFolders()
	found := map[string]string{}
	for _, p := range todo {
		for _, c := range cands {
			if validateRepo(c, p.repo()) == "" {
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

// discoverLoop runs discovery now and then every discoverEvery.
func discoverLoop() {
	for {
		if a, err := getAuth(); err == nil && a != nil {
			discoverRepos(a)
		}
		time.Sleep(discoverEvery)
	}
}
