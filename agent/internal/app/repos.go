package app

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// validateRepo returns an error text when path is not a git clone of githubRepo; "" when it is.
func validateRepo(p, githubRepo string) string {
	if githubRepo == "" {
		return "the project has no GitHub repo set (Settings > project > GitHub repo)"
	}
	if !validGithubRepo(githubRepo) {
		return "the project's GitHub repo name is not valid"
	}
	if why := unsafePath(p); why != "" {
		return fmt.Sprintf("folder %s rejected: %s", p, why)
	}
	if _, err := os.Stat(p); err != nil {
		return fmt.Sprintf("folder %s does not exist", p)
	}
	remotes := gitSafe([]string{"-C", p, "remote", "-v"}, "", 0)
	want := strings.ToLower(githubRepo)
	for _, l := range strings.Split(remotes, "\n") {
		f := strings.Fields(l)
		if len(f) > 1 && slug(f[1]) == want {
			return ""
		}
	}
	return fmt.Sprintf("%s is not a clone of %s (git remote -v does not list it)", p, githubRepo)
}

var ghRepoRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// validGithubRepo: owner/name with safe characters and no "..".
func validGithubRepo(r string) bool {
	return ghRepoRe.MatchString(r) && !strings.Contains(r, "..")
}

// unsafePath rejects paths the agent must never touch before any stat/git: UNC and device paths (a stat on
// \\host\share sends the user's NTLM credentials) and drives that do not exist. "" = fine.
func unsafePath(p string) string {
	n := strings.ReplaceAll(p, "/", "\\")
	if strings.HasPrefix(n, "\\\\") {
		return "network and device paths are not allowed"
	}
	if runtime.GOOS == "windows" {
		vol := filepath.VolumeName(p)
		if vol != "" {
			if len(vol) != 2 || vol[1] != ':' {
				return "network and device paths are not allowed"
			}
			if _, err := os.Stat(vol + "\\"); err != nil {
				return "drive " + vol + " does not exist"
			}
		}
	}
	return ""
}

// underClones: the path is inside the folder where the agent clones project repos (untrusted content).
func underClones(p string) bool {
	rel, err := filepath.Rel(filepath.Join(dataDir(), "repos"), p)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// scrubSecrets deletes secret-looking files inside a worktree (skips .git). Returns how many were removed.
func scrubSecrets(root string) int {
	n := 0
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Name() == ".git" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if isSecretName(d.Name()) && os.Remove(p) == nil {
			n++
		}
		return nil
	})
	return n
}

// defaultRef: the remote default branch of a repo (origin/HEAD, then origin/main, origin/master); "" if none.
func defaultRef(repoDir string) string {
	ref := gitSafe([]string{"-C", repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"}, "", 0)
	for _, c := range []string{"origin/main", "origin/master"} {
		if ref == "" && gitSafe([]string{"-C", repoDir, "rev-parse", "--verify", c}, "", 0) != "" {
			ref = c
		}
	}
	return ref
}

// persistentWorktree: a reusable detached worktree of the default branch, kept between requests (ignored files such
// as node_modules stay, untracked files go).
func persistentWorktree(key string, entry RepoEntry) (string, func(), error) {
	noop := func() {}
	start := time.Now()
	wt := filepath.Join(dataDir(), "worktrees", key)
	if _, err := gitRun([]string{"-C", entry.Path, "fetch", "--prune", "origin"}, "", 300*time.Second); err != nil {
		logf("%s: fetch failed, using what is local: %s", key, shortErr(err))
	}
	ref := defaultRef(entry.Path)
	if ref == "" {
		ref = "HEAD"
	}
	// Resolve in the owner's repo: inside the worktree "HEAD" would mean the worktree's own (stale) HEAD.
	if sha := gitSafe([]string{"-C", entry.Path, "rev-parse", "--verify", ref + "^{commit}"}, "", 0); sha != "" {
		ref = sha
	}
	if st, err := os.Stat(wt); err == nil && st.IsDir() && gitSafe([]string{"-C", wt, "rev-parse", "--is-inside-work-tree"}, "", 0) == "true" {
		_, e1 := gitRun([]string{"-C", wt, "checkout", "--detach", "-f", ref}, "", 0)
		_, e2 := gitRun([]string{"-C", wt, "clean", "-fd"}, "", 0)
		if e1 == nil && e2 == nil {
			logf("%s: worktree ready in %.1fs (%s)", key, time.Since(start).Seconds(), ref)
			return wt, noop, nil
		}
	}
	gitSafe([]string{"-C", entry.Path, "worktree", "remove", "--force", wt}, "", 0)
	_ = os.RemoveAll(wt)
	gitSafe([]string{"-C", entry.Path, "worktree", "prune"}, "", 0)
	_ = os.MkdirAll(filepath.Dir(wt), 0o755)
	if _, err := gitRun([]string{"-C", entry.Path, "worktree", "add", "--detach", wt, ref}, "", 600*time.Second); err != nil {
		return "", noop, err
	}
	logf("%s: worktree ready in %.1fs (%s)", key, time.Since(start).Seconds(), ref)
	return wt, noop, nil
}

// prepareWorkdir: own clones run in a fresh detached worktree of the up-to-date branch. Codex has no file denylist,
// so it NEVER runs in a user folder: always a temp worktree of the local HEAD (no fetch), with secret-looking files
// deleted. Claude on a user folder runs in place for the owner's own requests; for other people's requests
// (forOthers) it runs in a persistent worktree (data dir/worktrees/KEY) reset to the default branch before each run
// (HEAD of the owner's folder when there is none), so the owner's uncommitted work is never used or touched.
func prepareWorkdir(key string, entry RepoEntry, engine string, forOthers bool) (string, func(), error) {
	noop := func() {}
	isClone := entry.Source == "clone"
	if !isClone && engine != "codex" {
		if forOthers {
			return persistentWorktree(key, entry)
		}
		return entry.Path, noop, nil
	}
	ref := "HEAD"
	if isClone {
		if _, err := gitRun([]string{"-C", entry.Path, "fetch", "--prune", "origin"}, "", 300*time.Second); err != nil {
			return "", noop, err
		}
		// TODO: /api/projects does not expose a deploy branch; the remote default branch is used.
		ref = defaultRef(entry.Path)
		if ref == "" {
			return "", noop, errors.New("cannot determine the default branch of the clone")
		}
	}
	tmp := filepath.Join(dataDir(), "tmp", fmt.Sprintf("%s-%d", key, time.Now().UnixMilli()))
	_ = os.MkdirAll(filepath.Join(dataDir(), "tmp"), 0o755)
	cleanup := func() {
		gitSafe([]string{"-C", entry.Path, "worktree", "remove", "--force", tmp}, "", 0)
		_ = os.RemoveAll(tmp)
		gitSafe([]string{"-C", entry.Path, "worktree", "prune"}, "", 0)
	}
	if _, err := gitRun([]string{"-C", entry.Path, "worktree", "add", "--detach", tmp, ref}, "", 120*time.Second); err != nil {
		cleanup()
		return "", noop, err
	}
	if engine == "codex" {
		logf("%s: removed %d secret-looking files from the worktree", key, scrubSecrets(tmp))
	}
	return tmp, cleanup, nil
}

// cloneProject clones the project's GitHub repo into the data folder and maps the key to it (source clone).
func cloneProject(key, githubRepo string) (string, error) {
	if githubRepo == "" {
		return "", errors.New("the project has no GitHub repo set")
	}
	if !validGithubRepo(githubRepo) {
		return "", errors.New("the project's GitHub repo name is not valid")
	}
	target := filepath.Join(dataDir(), "repos", strings.ReplaceAll(githubRepo, "/", "-"))
	if !underClones(target) {
		return "", errors.New("clone target is outside the agent data folder")
	}
	if _, err := os.Stat(target); err != nil {
		_ = os.MkdirAll(filepath.Join(dataDir(), "repos"), 0o755)
		if _, err := gitRun([]string{"clone", "https://github.com/" + githubRepo + ".git", target}, "", 900*time.Second); err != nil {
			return "", err
		}
	}
	if p := validateRepo(target, githubRepo); p != "" {
		return "", errors.New(p)
	}
	updateConfig(func(c *Config) { c.Repos[key] = RepoEntry{Path: target, Source: "clone"} })
	return target, nil
}

func projectOf(key string) (*Project, error) {
	a, err := getAuth()
	if err != nil {
		return nil, err
	}
	if a == nil {
		return nil, errors.New("not logged in, run: exponential-agent login")
	}
	list, err := listProjects(a)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].Key == strings.ToUpper(key) {
			return &list[i], nil
		}
	}
	return nil, fmt.Errorf("no project %s on your account", strings.ToUpper(key))
}

var keyArgRe = regexp.MustCompile(`^[A-Za-z]{2,10}$`)

func cmdRepos(args []string) error {
	var sub, rawKey, p string
	if len(args) > 0 {
		sub = args[0]
	}
	if len(args) > 1 {
		rawKey = args[1]
	}
	if len(args) > 2 {
		p = args[2]
	}
	const usage = "usage: repos set <KEY> <path> | repos clone <KEY>"
	if sub == "" {
		repos := loadConfig().Repos
		if len(repos) == 0 {
			fmt.Println("No repos mapped. Use: repos set <KEY> <path> | repos clone <KEY>")
		}
		for k, r := range repos {
			fmt.Printf("%s  %s  (%s)\n", k, r.Path, r.Source)
		}
		return nil
	}
	if !keyArgRe.MatchString(rawKey) {
		return errors.New(usage)
	}
	key := strings.ToUpper(rawKey)
	pr, err := projectOf(key)
	if err != nil {
		return err
	}
	switch sub {
	case "set":
		if p == "" {
			return errors.New("usage: repos set <KEY> <path>")
		}
		full, _ := filepath.Abs(p)
		if problem := validateRepo(full, pr.repo()); problem != "" {
			return errors.New(problem)
		}
		updateConfig(func(c *Config) { c.Repos[key] = RepoEntry{Path: full, Source: "manual"} })
		fmt.Printf("%s -> %s\n", key, full)
	case "clone":
		t, err := cloneProject(key, pr.repo())
		if err != nil {
			return err
		}
		fmt.Printf("%s -> %s\n", key, t)
	default:
		return errors.New(usage)
	}
	return nil
}
