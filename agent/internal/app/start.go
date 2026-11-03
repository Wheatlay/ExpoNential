package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var keyRe = regexp.MustCompile(`^[A-Z]{2,10}-\d{1,6}$`)
var projKeyRe = regexp.MustCompile(`^[A-Z]{2,10}$`)
var keyNumRe = regexp.MustCompile(`-\d+$`)

const lockMin = 30 * time.Minute

func hhmm() string { return time.Now().Format("15:04") }

var (
	running      atomic.Bool
	stateMu      sync.Mutex
	cloneAllowed []string // project keys the server lets this agent clone on its own
	lastErr      string   // goes to the tracker with the next successful poll
)

func getLastErr() string  { stateMu.Lock(); defer stateMu.Unlock(); return lastErr }
func setLastErr(s string) { stateMu.Lock(); lastErr = s; stateMu.Unlock() }

func activeAccount() string {
	b, err := os.ReadFile(filepath.Join(dataDir(), "active-account.txt"))
	if err != nil {
		return ""
	}
	a := strings.TrimSpace(string(b))
	if a != "" {
		if _, err := os.Stat(a); err == nil {
			return a
		}
	}
	return ""
}

// freshLocks: another job started elsewhere shows as a fresh *.lock file.
func freshLocks() bool {
	ents, err := os.ReadDir(dataDir())
	if err != nil {
		return false
	}
	for _, e := range ents {
		n := e.Name()
		if strings.HasSuffix(n, ".lock") && n != "agent.lock" {
			if st, err := os.Stat(filepath.Join(dataDir(), n)); err == nil && time.Since(st.ModTime()) < lockMin {
				return true
			}
		}
	}
	return false
}

func lockPath() string { return filepath.Join(dataDir(), "agent.lock") }

// agentPID returns the pid in agent.lock when that process is alive.
func agentPID() int {
	b, err := os.ReadFile(lockPath())
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if pid > 0 && pid != os.Getpid() && pidAlive(pid) {
		return pid
	}
	return 0
}

func singleInstance() bool {
	_ = os.MkdirAll(dataDir(), 0o755)
	if agentPID() != 0 {
		return false
	}
	_ = os.WriteFile(lockPath(), []byte(strconv.Itoa(os.Getpid())), 0o644)
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	go func() { <-ch; _ = os.Remove(lockPath()); os.Exit(0) }()
	return true
}

type serverRepo struct {
	Project string `json:"project"`
	Path    string `json:"path"`
	Source  string `json:"source"`
}

// mergeServerRepos: server mapping wins for manually set entries; local hook/clone entries stay.
func mergeServerRepos(list []serverRepo) {
	cur := loadConfig().Repos
	var changes []serverRepo
	for _, r := range list {
		if !projKeyRe.MatchString(r.Project) || r.Path == "" {
			continue
		}
		have, ok := cur[r.Project]
		if r.Source == "manual" || r.Source == "set" {
			if !ok || have.Path != r.Path || have.Source != "manual" {
				changes = append(changes, r)
			}
			continue
		}
		if !ok {
			if _, err := os.Stat(r.Path); err == nil {
				changes = append(changes, r)
			}
		}
	}
	if len(changes) == 0 {
		return
	}
	updateConfig(func(c *Config) {
		for _, r := range changes {
			src := "hook"
			if r.Source == "manual" || r.Source == "set" {
				src = "manual"
			} else if r.Source == "clone" || r.Source == "auto" {
				src = r.Source
			}
			c.Repos[r.Project] = RepoEntry{Path: r.Path, Source: src}
		}
	})
	names := []string{}
	for _, r := range changes {
		names = append(names, r.Project)
	}
	logf("mapping from server: %s", strings.Join(names, ", "))
}

func analyze(a *Auth, key string, deepJob bool, deviceID string) {
	if !keyRe.MatchString(key) {
		panic(fmt.Sprintf("rejected key from server: %s", key))
	}
	lock := filepath.Join(dataDir(), key+".lock")
	if st, err := os.Stat(lock); err == nil && time.Since(st.ModTime()) < lockMin {
		logf("%s already running, skipping", key)
		return
	}
	_ = os.WriteFile(lock, []byte(strconv.Itoa(os.Getpid())), 0o644)
	claimed, failMsg := false, ""
	cleanup := func() {}
	defer func() {
		cleanup()
		_ = os.Remove(lock)
		// Release only after an error. After code 0 NOT: if the engine ran but saved nothing, the job should go to
		// Stalled, not back to the queue forever (every run is paid usage).
		if claimed && failMsg != "" {
			e := hhmm() + " " + failMsg
			setLastErr(cut(e, 300))
			if err := request(a, "DELETE", "/api/issues/"+key+"/analyze/claim", map[string]any{"deviceId": deviceID, "error": cut(failMsg, 2000)}, 0, nil); err != nil {
				logf("release: %s", err)
			}
		}
	}()
	fail := func(err error) { failMsg = err.Error(); logf("error: %s", failMsg) }

	cfg := loadConfig()
	engine := cfg.Engine
	if engine == "" {
		engine = "claude"
	}
	var claim struct {
		Deep      bool   `json:"deep"`
		Model     string `json:"model"`
		Requester *struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
		} `json:"requester"`
	}
	if err := request(a, "POST", "/api/issues/"+key+"/analyze/claim", map[string]any{"deviceId": deviceID, "version": Version, "engine": engine}, 0, &claim); err != nil {
		switch httpStatus(err) {
		case 409:
			logf("%s taken or no longer requested, skipping", key)
		case 426:
			logf("%s skipped: agent version rejected by server", key)
		default:
			fail(err)
		}
		return
	}
	claimed = true
	if claim.Requester != nil {
		if own := ownUserID(a); own != 0 && claim.Requester.ID != own && claim.Requester.Name != "" {
			setAnalyzing(key, claim.Requester.Name)
			notifyOther(key, claim.Requester.Name)
		}
	}
	cfg = loadConfig()
	engine = cfg.Engine
	if engine == "" {
		engine = "claude"
	}
	model := "sonnet"
	if claim.Deep {
		model = "opus"
	}
	if claim.Model != "" && isModel(claim.Model) {
		model = claim.Model
	}

	// Never run in a folder that was not validated against the project's repo.
	projectKey := keyNumRe.ReplaceAllString(key, "")
	projects, err := listProjects(a)
	if err != nil {
		fail(err)
		return
	}
	var project *Project
	for i := range projects {
		if projects[i].Key == projectKey {
			project = &projects[i]
		}
	}
	entry, ok := cfg.Repos[projectKey]
	if !ok {
		allowed := false
		stateMu.Lock()
		for _, k := range cloneAllowed {
			if k == projectKey {
				allowed = true
			}
		}
		stateMu.Unlock()
		if allowed {
			logf("%s: no mapping, cloning (allowed by the server)", projectKey)
			if _, err := cloneProject(projectKey, project.repo()); err != nil {
				fail(err)
				return
			}
			entry, ok = loadConfig().Repos[projectKey]
		}
	}
	if !ok {
		fail(fmt.Errorf("no repo mapped for %s (exponential-agent repos set %s <path>)", projectKey, projectKey))
		return
	}
	if p := validateRepo(entry.Path, project.repo()); p != "" {
		fail(errors.New(p))
		return
	}
	bin := findEngine(engine)
	if bin == "" {
		fail(fmt.Errorf("engine \"%s\" not found (PATH or VS Code extension)", engine))
		return
	}
	q := ""
	if claim.Deep {
		q = "?deep=1"
	}
	var res struct {
		Prompt string `json:"prompt"`
		Model  string `json:"model"`
	}
	if err := request(a, "GET", "/api/issues/"+key+"/prompt/analyze"+q, nil, 0, &res); err != nil {
		fail(err)
		return
	}
	if res.Model != "" && isModel(res.Model) {
		model = res.Model
	}
	logf("start %s (%s, %s)", key, engine, model)
	dir, cl, err := prepareWorkdir(projectKey, entry, engine)
	if err != nil {
		fail(err)
		return
	}
	cleanup = cl
	started := time.Now()
	code, usage := runEngine(runOpts{engine: engine, bin: bin, prompt: res.Prompt, model: model, untrusted: entry.Source == "clone", cwd: dir, base: a.Base, auth: a.Auth, activeAccount: activeAccount()})
	logf("end %s (code %d)", key, code)
	reportRun(a, deviceID, key, "analyze", engine, model, started, code, usage)
	if code != 0 {
		failMsg = fmt.Sprintf("%s exited with code %d (details in log.txt)", engine, code)
	}
}

// encodeURIComponent equivalent.
func encodeURIComponent(s string) string {
	const keep = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var b strings.Builder
	for _, c := range []byte(s) {
		if strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func startJob(a *Auth, id int, deviceID string) error {
	var claim struct {
		Key       string `json:"key"`
		Requester *struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
		} `json:"requester"`
	}
	if err := request(a, "POST", fmt.Sprintf("/api/agent/start-jobs/%d/claim", id), map[string]any{"deviceId": deviceID}, 0, &claim); err != nil {
		if httpStatus(err) == 409 {
			return nil // someone was first or the job expired
		}
		return err
	}
	if !keyRe.MatchString(claim.Key) {
		return fmt.Errorf("rejected key from server: %s", claim.Key)
	}
	mk := func(p string) string { return "vscode://anthropic.claude-code/open?prompt=" + encodeURIComponent(p) }
	const max = 1900 // Windows truncates longer links
	get := func(q string) (string, error) {
		var r struct {
			Prompt string `json:"prompt"`
		}
		err := request(a, "GET", "/api/issues/"+claim.Key+"/prompt/start"+q, nil, 0, &r)
		return r.Prompt, err
	}
	p, err := get("")
	if err != nil {
		if httpStatus(err) == 409 {
			return nil
		}
		return err
	}
	link := mk(p)
	if len(link) > max {
		if p, err = get("?compact=1"); err != nil {
			return err
		}
		link = mk(p)
	}
	if len(link) > max {
		link = mk(fmt.Sprintf("Working on %s. Full data: get_issue %s.", claim.Key, claim.Key))
	}
	started := time.Now()
	logf("start work %s", claim.Key)
	openURLRaw(link)
	reportRun(a, deviceID, claim.Key, "start", "claude", "", started, 0, nil)
	return nil
}

type pollJob struct {
	Kind string   `json:"kind"`
	Key  string   `json:"key"`
	Deep any      `json:"deep"`
	ID   *float64 `json:"id"`
}

func cmdStart() {
	if !singleInstance() {
		fmt.Println("Agent is already running.")
		return
	}
	logf("start (PID %d, v%s)", os.Getpid(), Version)
	runWithTray(pollLoop)
}

func pollLoop() {
	go discoverLoop()
	delay := 2
	errLogged := false
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					setLastErr(hhmm() + " " + fmt.Sprint(r))
					time.Sleep(time.Duration(delay) * time.Second)
				}
			}()
			err := pollOnce(&delay, &errLogged)
			if err != nil {
				setPollFail()
				setLastErr(hhmm() + " " + shortErr(err))
				if !errLogged {
					logf("error: %s", err)
					errLogged = true
				}
				time.Sleep(time.Duration(delay) * time.Second)
				if delay < 30 {
					delay *= 2
				} else {
					delay = 60
				}
			}
		}()
	}
}

func pollOnce(delay *int, errLogged *bool) error {
	cfg := loadConfig() // fresh each round: login/repos changes work without a restart
	if cfg.DeviceID == "" {
		return errors.New("no deviceId in config.json (run: exponential-agent login)")
	}
	a, err := getAuth()
	if err != nil {
		return err
	}
	if a == nil {
		return errors.New("not logged in (run: exponential-agent login)")
	}
	busy := running.Load() || freshLocks()
	b := "0"
	if busy {
		b = "1"
	}
	host, _ := os.Hostname()
	eng := cfg.Engine
	if eng == "" {
		eng = "claude"
	}
	ver := cfg.Version
	if ver == "" {
		ver = Version
	}
	// Mapping with paths and sources ({KEY: {path, source}}), so the server can show and route by it.
	reposJSON, _ := json.Marshal(cfg.Repos)
	qs := url.Values{"deviceId": {cfg.DeviceID}, "name": {host}, "busy": {b}, "version": {ver}, "engine": {eng}, "repos": {string(reposJSON)}}
	if le := getLastErr(); le != "" {
		qs.Set("error", cut(le, 300))
	}
	var res struct {
		Jobs         []pollJob         `json:"jobs"`
		Repos        []json.RawMessage `json:"repos"`
		CloneAllowed []any             `json:"cloneAllowed"`
	}
	if err := request(a, "GET", "/api/agent/work?"+qs.Encode(), nil, 0, &res); err != nil {
		return err
	}
	setLastErr("") // the server received it
	setPollOK()
	stateMu.Lock()
	cloneAllowed = nil
	for _, k := range res.CloneAllowed {
		if s, ok := k.(string); ok {
			cloneAllowed = append(cloneAllowed, s)
		}
	}
	stateMu.Unlock()
	var sr []serverRepo
	for _, raw := range res.Repos {
		var r serverRepo
		if json.Unmarshal(raw, &r) == nil {
			sr = append(sr, r)
		}
	}
	if len(sr) > 0 {
		mergeServerRepos(sr)
	}
	*delay, *errLogged = 2, false
	var job *pollJob
	if !busy && len(res.Jobs) > 0 {
		job = &res.Jobs[0]
	}
	if job != nil && job.Kind == "analyze" {
		logf("analysis %s", job.Key)
		running.Store(true)
		// Not awaited: the loop keeps polling (busy=1) so the server keeps the claim fresh during a long run.
		go func(key string, deep bool) {
			setAnalyzing(key, "")
			defer setAnalyzing("", "")
			defer running.Store(false)
			defer func() {
				if r := recover(); r != nil {
					logf("error: %v", r)
				}
			}()
			analyze(a, key, deep, cfg.DeviceID)
		}(job.Key, truthy(job.Deep))
	} else if job != nil && job.Kind == "start" && job.ID != nil {
		if err := startJob(a, int(*job.ID), cfg.DeviceID); err != nil {
			m := hhmm() + " could not open VS Code: " + err.Error()
			setLastErr(m)
			logf("%s", m)
		}
	}
	// No pause after a successful poll: the server holds the request (long poll). Only guards against a tight loop.
	if !busy && job == nil {
		time.Sleep(200 * time.Millisecond)
	} else if busy {
		time.Sleep(2 * time.Second)
	}
	return nil
}

// shortErr: what the server shows in Settings. Network errors carry the whole request URL (with the
// device id and repos), which says nothing to a person; keep only the reason.
func shortErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		if ue.Timeout() {
			return "server did not answer in time"
		}
		return "cannot reach the server: " + cut(ue.Err.Error(), 120)
	}
	return cut(err.Error(), 200)
}
