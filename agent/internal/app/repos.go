package app

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// validateRepo returns an error text when path is not a git clone of githubRepo; "" when it is.
func validateRepo(p, githubRepo string) string {
	if githubRepo == "" {
		return "the project has no GitHub repo set (Settings > project > GitHub repo)"
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

// Same patterns as the Claude denylist (engine.go), as basename regexes.
var secretFiles = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^\.env`), regexp.MustCompile(`(?i)\.pem$`), regexp.MustCompile(`(?i)\.key$`),
	regexp.MustCompile(`(?i)^id_rsa`), regexp.MustCompile(`(?i)\.pfx$`), regexp.MustCompile(`(?i)\.p12$`),
	regexp.MustCompile(`(?i)^secrets\.`), regexp.MustCompile(`(?i)^credentials`),
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
		for _, re := range secretFiles {
			if re.MatchString(d.Name()) {
				if os.Remove(p) == nil {
					n++
				}
				break
			}
		}
		return nil
	})
	return n
}

// prepareWorkdir: own clones run in a fresh detached worktree of the up-to-date branch. Codex has no file denylist,
// so it NEVER runs in a user folder: always a temp worktree of the local HEAD (no fetch), with secret-looking files
// deleted. Claude on a user folder runs in place.
func prepareWorkdir(key string, entry RepoEntry, engine string) (string, func(), error) {
	noop := func() {}
	isClone := entry.Source == "clone"
	if !isClone && engine != "codex" {
		return entry.Path, noop, nil
	}
	ref := "HEAD"
	if isClone {
		if _, err := gitRun([]string{"-C", entry.Path, "fetch", "--prune", "origin"}, "", 300*time.Second); err != nil {
			return "", noop, err
		}
		// TODO: /api/projects does not expose a deploy branch; the remote default branch is used.
		ref = gitSafe([]string{"-C", entry.Path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"}, "", 0)
		for _, c := range []string{"origin/main", "origin/master"} {
			if ref == "" && gitSafe([]string{"-C", entry.Path, "rev-parse", "--verify", c}, "", 0) != "" {
				ref = c
			}
		}
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
	target := filepath.Join(dataDir(), "repos", strings.Replace(githubRepo, "/", "-", 1))
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
