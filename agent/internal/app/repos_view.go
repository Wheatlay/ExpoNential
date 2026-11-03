package app

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// The "Repo" tab of the settings window: the user's projects with the folder each one is mapped to.

type repoRow struct {
	Key     string `json:"key"`
	Name    string `json:"name"`
	Repo    string `json:"repo"`    // GitHub repo of the project ("" = none set)
	Path    string `json:"path"`    // mapped folder ("" = not mapped)
	Source  string `json:"source"`  // auto | manual | clone | hook
	OK      bool   `json:"ok"`      // the folder is a clone of the project's repo
	Problem string `json:"problem"` // nofolder | notclone | "" (when OK or not mapped)
	Detail  string `json:"detail"`  // full text of the validation problem
}

var (
	repoMu    sync.Mutex
	repoCache = map[string]string{} // project key -> GitHub repo, from the last list
)

// repoProblem classifies a validateRepo result: nofolder | notclone | "" (valid).
func repoProblem(path, githubRepo string) (code, detail string) {
	detail = validateRepo(path, githubRepo)
	if detail == "" {
		return "", ""
	}
	if _, err := os.Stat(path); err != nil {
		return "nofolder", detail
	}
	return "notclone", detail
}

// buildRepoRows lists the projects of the account (server) with their local mapping (config), sorted by key.
func buildRepoRows(a *Auth) ([]repoRow, error) {
	list, err := listProjects(a)
	if err != nil {
		return nil, err
	}
	cfg := loadConfig()
	rows := make([]repoRow, 0, len(list))
	repoMu.Lock()
	repoCache = map[string]string{}
	for i := range list {
		repoCache[list[i].Key] = list[i].repo()
	}
	repoMu.Unlock()
	for i := range list {
		p := &list[i]
		r := repoRow{Key: p.Key, Name: p.Name, Repo: p.repo()}
		if e, ok := cfg.Repos[p.Key]; ok && e.Path != "" {
			r.Path, r.Source = e.Path, e.Source
			if r.Repo != "" {
				r.Problem, r.Detail = repoProblem(e.Path, r.Repo)
				r.OK = r.Problem == ""
			}
		}
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Key < rows[j].Key })
	return rows, nil
}

// saveManualRepo validates the folder against the project's repo and maps it with source "manual".
// Returns the problem code and its text; both empty = saved. The poll sends the mapping to the server.
func saveManualRepo(key, path string) (code, detail string, err error) {
	if !projKeyRe.MatchString(key) {
		return "", "", errors.New("bad project key")
	}
	repoMu.Lock()
	gh, known := repoCache[key]
	repoMu.Unlock()
	if !known {
		return "", "", errors.New("unknown project")
	}
	full, _ := filepath.Abs(strings.TrimSpace(path))
	if full == "" {
		return "", "", errors.New("no folder")
	}
	if gh == "" {
		return "norepo", "the project has no GitHub repo set", nil
	}
	if code, detail = repoProblem(full, gh); code != "" {
		return code, detail, nil
	}
	updateConfig(func(c *Config) { c.Repos[key] = RepoEntry{Path: full, Source: "manual"} })
	logf("%s: folder set in the settings window: %s", key, full)
	return "", "", nil
}

// removeRepo deletes the local mapping of a project; the server learns on the next poll.
func removeRepo(key string) {
	if !projKeyRe.MatchString(key) {
		return
	}
	updateConfig(func(c *Config) { delete(c.Repos, key) })
	logf("%s: mapping removed in the settings window", key)
}
