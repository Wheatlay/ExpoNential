package app

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

// Open requests: the web app asks this computer to open a repo in an editor (or a terminal) with a prompt for
// Claude Code. GET /api/agent/open-requests returns the pending ones and clears them; the poll loop asks on every round.

type openRequest struct {
	Editor string `json:"editor"` // vscode | cursor | windsurf | terminal
	Repo   string `json:"repo"`   // owner/name
	Prompt string `json:"prompt"`
}

var (
	openReqBusy atomic.Bool
	repoNameRe  = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
)

// pollOpenRequests fetches and handles the requests one after another (a single worker at a time).
func pollOpenRequests(a *Auth) {
	if !openReqBusy.CompareAndSwap(false, true) {
		return
	}
	defer openReqBusy.Store(false)
	defer func() {
		if r := recover(); r != nil {
			logf("open requests: %v", r)
		}
	}()
	var reqs []openRequest
	if err := request(a, "GET", "/api/agent/open-requests", nil, 15*time.Second, &reqs); err != nil {
		if httpStatus(err) != 404 { // 404 = an older server without the endpoint
			logf("open requests: %s", shortErr(err))
		}
		return
	}
	for _, r := range reqs {
		handleOpenRequest(a, r)
	}
}

// normRepo: "owner/name" from "owner/name", "https://github.com/owner/name(.git)" or "git@github.com:owner/name.git".
func normRepo(s string) string {
	s = strings.TrimSpace(s)
	for _, p := range []string{"https://github.com/", "http://github.com/", "git@github.com:", "github.com/"} {
		s = strings.TrimPrefix(s, p)
	}
	s = strings.TrimSuffix(strings.TrimSuffix(s, "/"), ".git")
	return strings.ToLower(s)
}

// localRepoPath finds the folder mapped to a GitHub repo: the project whose repo it is, then its mapping in config.
func localRepoPath(a *Auth, repo string) string {
	list, err := listProjects(a)
	if err != nil {
		logf("open request: cannot list projects: %s", shortErr(err))
		return ""
	}
	want := normRepo(repo)
	cfg := loadConfig()
	for i := range list {
		if normRepo(list[i].repo()) != want {
			continue
		}
		if e, ok := cfg.Repos[list[i].Key]; ok && e.Path != "" {
			if st, err := os.Stat(e.Path); err == nil && st.IsDir() {
				return e.Path
			}
		}
	}
	return ""
}

// editorSpec: the CLI name, the URI scheme and the usual install folders (under %LOCALAPPDATA%\Programs) of an editor.
func editorSpec(editor string) (cli, scheme string, dirs []string) {
	switch editor {
	case "vscode":
		return "code", "vscode", []string{"Microsoft VS Code/bin"}
	case "cursor":
		return "cursor", "cursor", []string{"cursor/resources/app/bin", "Cursor/resources/app/bin"}
	case "windsurf":
		return "windsurf", "windsurf", []string{"Windsurf/bin", "windsurf/bin"}
	}
	return "", "", nil
}

// findEditorCLI: the editor's command line tool on PATH, else in its usual install folder.
func findEditorCLI(cli string, dirs []string) string {
	if b := whichBin(cli); b != "" {
		return b
	}
	base := os.Getenv("LOCALAPPDATA")
	if runtime.GOOS != "windows" || base == "" {
		return ""
	}
	for _, d := range dirs {
		for _, ext := range []string{".cmd", ".exe"} {
			f := filepath.Join(base, "Programs", filepath.FromSlash(d), cli+ext)
			if st, err := os.Stat(f); err == nil && !st.IsDir() {
				return f
			}
		}
	}
	return ""
}

func claudeOpenURI(scheme, prompt string) string {
	return scheme + "://anthropic.claude-code/open?prompt=" + strings.ReplaceAll(url.QueryEscape(prompt), "+", "%20")
}

func handleOpenRequest(a *Auth, r openRequest) {
	if !repoNameRe.MatchString(r.Repo) {
		logf("open request: bad repo %q, skipped", cut(r.Repo, 60))
		return
	}
	if strings.TrimSpace(r.Prompt) == "" {
		logf("open request %s: empty prompt, skipped", r.Repo)
		return
	}
	dir := localRepoPath(a, r.Repo)
	if dir == "" {
		logf("open request %s: no local folder mapped for this repo, skipped", r.Repo)
		return
	}
	if r.Editor == "terminal" {
		if err := openTerminalWithClaude(dir, r.Prompt); err != nil {
			logf("open request %s: terminal: %s", r.Repo, err)
		} else {
			logf("open request %s: terminal opened in %s", r.Repo, dir)
		}
		return
	}
	cli, scheme, dirs := editorSpec(r.Editor)
	if cli == "" {
		logf("open request %s: unknown editor %q, skipped", r.Repo, cut(r.Editor, 30))
		return
	}
	bin := findEditorCLI(cli, dirs)
	if bin == "" {
		logf("open request %s: %s not found (PATH or the usual install folder), skipped", r.Repo, cli)
		return
	}
	// The CLI activates the window that already has the folder open, or opens a new one.
	if out, err := runCmd(bin, []string{dir}, "-", 30*time.Second, ""); err != nil {
		logf("open request %s: %s: %s", r.Repo, cli, shortOut(out, err))
		return
	}
	time.Sleep(1500 * time.Millisecond)
	openURLRaw(claudeOpenURI(scheme, r.Prompt))
	logf("open request %s: opened in %s", r.Repo, r.Editor)
}
