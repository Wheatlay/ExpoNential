package app

import (
	"fmt"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

// Repo actions: the web app asks this agent to clone a project's repo, pick its folder, or rescan the PC.
// GET /api/agent/repo-actions returns the pending ones and clears them; the poll loop asks on every round.

type repoAction struct {
	Kind    string `json:"kind"` // clone | pick | rescan
	Project string `json:"project"`
}

var (
	repoActionsBusy atomic.Bool
	cloneMu         sync.Mutex
)

func pollRepoActions(a *Auth) {
	if !repoActionsBusy.CompareAndSwap(false, true) {
		return
	}
	defer repoActionsBusy.Store(false)
	defer func() {
		if r := recover(); r != nil {
			logf("repo actions: %v", r)
		}
	}()
	var list []repoAction
	if err := request(a, "GET", "/api/agent/repo-actions?deviceId="+url.QueryEscape(loadConfig().DeviceID), nil, 15*time.Second, &list); err != nil {
		if httpStatus(err) != 404 { // 404 = an older server without the endpoint
			logf("repo actions: %s", shortErr(err))
		}
		return
	}
	for _, act := range list {
		handleRepoAction(a, act)
	}
}

func handleRepoAction(a *Auth, act repoAction) {
	if act.Kind == "rescan" {
		logf("repo rescan: %d new mapping(s)", forceDiscoverRepos(a))
		cachedFoundSlugs(true)
		return
	}
	if !projKeyRe.MatchString(act.Project) {
		logf("repo action %s: bad project %q, skipped", act.Kind, cut(act.Project, 20))
		return
	}
	key := act.Project
	p, err := projectOf(key)
	if err != nil {
		logf("repo action %s %s: %s", act.Kind, key, shortErr(err))
		return
	}
	switch act.Kind {
	case "clone":
		// The owner clicked it, so cloneAllowed is not checked. Clones are slow: background, one at a time.
		go func() {
			defer func() { _ = recover() }()
			cloneMu.Lock()
			defer cloneMu.Unlock()
			if _, err := cloneProject(key, p.repo()); err != nil {
				setLastErr("clone " + key + ": " + err.Error())
				logf("clone %s: %s", key, err)
				return
			}
			logf("clone %s: done", key)
		}()
	case "pick":
		path, err := pickRepoFolder(fmt.Sprintf("Choose the folder of %s (%s)", key, p.repo()))
		if err != nil {
			logf("repo action pick %s: %v", key, err)
			return
		}
		if path == "" {
			return
		}
		if problem := validateRepo(path, p.repo()); problem != "" {
			msgBox(problem, dlgError)
			return
		}
		updateConfig(func(c *Config) { c.Repos[key] = RepoEntry{Path: path, Source: "manual"} })
		logf("%s: folder set from the web app: %s", key, path)
	default:
		logf("repo action: unknown kind %q, skipped", cut(act.Kind, 20))
	}
}
