package app

import (
	"sync"
	"time"
)

// The poll tells the server the state of every mapped folder, so a computer with a broken mapping is not given
// the job (a failed validation after the claim would otherwise fail the analysis for everyone).

type repoReport struct {
	Path   string `json:"path"`
	Source string `json:"source"`
	Status string `json:"status,omitempty"` // ok | error ("" = unknown, the server assumes ok)
	Error  string `json:"error,omitempty"`
}

const (
	repoStatusTTL = 60 * time.Second
	projectsTTL2  = 5 * time.Minute
)

type repoStatusEntry struct {
	at           time.Time
	path, gh     string
	status, emsg string
}

var (
	repoStatMu  sync.Mutex
	repoStat    = map[string]repoStatusEntry{}
	projCache   []Project
	projCacheAt time.Time
)

// cachedProjects: the account's projects, refreshed at most every few minutes (the poll runs every 2 s).
func cachedProjects(a *Auth) []Project {
	repoStatMu.Lock()
	defer repoStatMu.Unlock()
	if projCache != nil && time.Since(projCacheAt) < projectsTTL2 {
		return projCache
	}
	if l, err := listProjects(a); err == nil {
		projCache, projCacheAt = l, time.Now()
	}
	return projCache
}

// repoStatusOf validates one mapping with the same check the Repo tab uses (repoProblem); cached for a minute.
func repoStatusOf(key string, e RepoEntry, projects []Project) (status, emsg string) {
	var p *Project
	for i := range projects {
		if projects[i].Key == key {
			p = &projects[i]
		}
	}
	if p == nil {
		return "", "" // project unknown here: no verdict
	}
	gh := p.repo()
	repoStatMu.Lock()
	c, ok := repoStat[key]
	repoStatMu.Unlock()
	if ok && c.path == e.Path && c.gh == gh && time.Since(c.at) < repoStatusTTL {
		return c.status, c.emsg
	}
	status = "ok"
	if _, detail := repoProblem(e.Path, gh); detail != "" {
		status, emsg = "error", cut(detail, 200)
	}
	repoStatMu.Lock()
	repoStat[key] = repoStatusEntry{time.Now(), e.Path, gh, status, emsg}
	repoStatMu.Unlock()
	return status, emsg
}

// repoReports is the `repos` parameter of the poll.
func repoReports(a *Auth, repos map[string]RepoEntry) map[string]repoReport {
	out := make(map[string]repoReport, len(repos))
	if len(repos) == 0 {
		return out
	}
	projects := cachedProjects(a)
	for k, e := range repos {
		st, em := repoStatusOf(k, e, projects)
		out[k] = repoReport{Path: e.Path, Source: e.Source, Status: st, Error: em}
	}
	return out
}
