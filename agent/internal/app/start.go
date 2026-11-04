package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
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

// acquireLock creates path exclusively (O_EXCL), so two processes cannot both win. An existing file that
// isStale says is dead is removed once and the creation retried.
func acquireLock(path string, content []byte, isStale func(os.FileInfo) bool) bool {
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = f.Write(content)
			_ = f.Close()
			return true
		}
		if !errors.Is(err, fs.ErrExist) {
			return false
		}
		if st, serr := os.Stat(path); serr == nil && !isStale(st) {
			return false
		}
		_ = os.Remove(path)
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
	if !acquireLock(lockPath(), []byte(strconv.Itoa(os.Getpid())), func(os.FileInfo) bool { return agentPID() == 0 }) {
		return false
	}
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
		if why := unsafePath(r.Path); why != "" {
			logf("%s: server path rejected (%s)", r.Project, why)
			continue
		}
		have, ok := cur[r.Project]
		if r.Source == "manual" || r.Source == "set" {
			if ok && have.Source == "clone" {
				continue // a local clone is never downgraded to a trusted manual folder by the server
			}
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
				if underClones(r.Path) {
					src = "clone" // inside the agent's clone folder: untrusted content
				}
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

func analyze(a *Auth, key string, deepJob bool, deviceID string, rq requesterInfo, issueID int) {
	if !keyRe.MatchString(key) {
		panic(fmt.Sprintf("rejected key from server: %s", key))
	}
	lock := filepath.Join(dataDir(), key+".lock")
	if !acquireLock(lock, []byte(strconv.Itoa(os.Getpid())), func(st os.FileInfo) bool { return time.Since(st.ModTime()) >= lockMin }) {
		logf("%s already running, skipping", key)
		return
	}
	claimed, failMsg, requeue := false, "", false
	requeueMsg := ""                                    // local repo-mapping problem: back to the queue, not a failure
	failCat := "agent error (details in the agent log)" // what the server hears about someone else's failed run
	others := othersRun(ownUserID(a), rq)
	forName, recorded := "", false // requester name when the run is for someone else; the run is in runs.json
	cleanup := func() {}
	defer func() {
		cleanup()
		if claimed && failMsg != "" && !recorded && !requeue {
			appendRun(runRecord{Key: key, For: forName, Result: runFail, Reason: cut(failMsg, 160)})
		}
		_ = os.Remove(lock)
		// Release only after an error. After code 0 NOT: if the engine ran but saved nothing, the job should go to
		// Stalled, not back to the queue forever (every run is paid usage).
		if claimed && requeue {
			// usage limit on every account or a local repo-mapping problem: not a failure, back to the queue
			body := map[string]any{"deviceId": deviceID, "requeue": true}
			if requeueMsg != "" {
				body["error"] = "repo mapping failed on this computer"
				if !others {
					body["error"] = cut(requeueMsg, 200)
				}
			}
			if err := request(a, "DELETE", "/api/issues/"+key+"/analyze/claim", body, 0, nil); err != nil {
				logf("release: %s", err)
			}
		} else if claimed && failMsg != "" {
			// Someone else's run: the server (and so the requester) hears only a category, the detail stays in the local log.
			srvMsg := failMsg
			if others {
				srvMsg = failCat
			}
			setLastErr(cut(hhmm()+" "+srvMsg, 300))
			if err := request(a, "DELETE", "/api/issues/"+key+"/analyze/claim", map[string]any{"deviceId": deviceID, "error": cut(srvMsg, 300)}, 0, nil); err != nil {
				logf("release: %s", err)
			}
		}
	}()
	fail := func(err error) { failMsg = err.Error(); logf("error: %s", failMsg) }
	mapFail := func(err error) {
		requeue, requeueMsg = true, err.Error()
		logf("%s: repo mapping problem, back to the queue: %s", key, requeueMsg)
		setLastErr(cut(hhmm()+" "+key+": "+requeueMsg, 300))
		skipID(issueID)
	}

	if !consentFor(a, key, rq) {
		return
	}

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
	// Consent follows the requester the claim reports, not the poll's copy.
	own := ownUserID(a)
	rq2 := rq
	if claim.Requester != nil {
		rq2 = requesterInfo{ID: claim.Requester.ID, Name: claim.Requester.Name, RequestedAt: rq.RequestedAt}
	}
	nowOthers := othersRun(own, rq2)
	if rq2.ID != rq.ID || nowOthers != others {
		if nowOthers {
			switch consentDecision(a, key, rq2) {
			case dYes:
				takeOnce(key, rq2.RequestedAt)
			case dPending:
				logf("%s: the claim names another requester, asking again", key)
				ensurePrompt(key, rq2)
				requeue = true
				return
			default:
				logf("%s: the claim names another requester, no consent", key)
				skipID(issueID)
				requeue = true
				return
			}
		}
		rq = rq2
	}
	others = nowOthers
	if claim.Requester != nil {
		if own != 0 && claim.Requester.ID != own && claim.Requester.Name != "" {
			forName = claim.Requester.Name
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
				mapFail(err)
				return
			}
			entry, ok = loadConfig().Repos[projectKey]
		}
	}
	if !ok {
		mapFail(fmt.Errorf("no repo mapped for %s (exponential-agent repos set %s <path>)", projectKey, projectKey))
		return
	}
	if p := validateRepo(entry.Path, project.repo()); p != "" {
		mapFail(errors.New(p))
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
	if engine == "codex" {
		if q == "" {
			q = "?"
		} else {
			q += "&"
		}
		q += "engine=codex"
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
	accts := []string{""}
	if engine == "claude" {
		accts = claudeAccounts()
	}
	skip := map[string]bool{}
	for {
		acct, ok := nextAccount(accts, limitedSnapshot(), skip, time.Now())
		if !ok {
			// Every Claude account is at its limit: back to the queue without an error, pause until the earliest reset.
			until, all := earliestReset(accts, limitedSnapshot(), time.Now())
			if !all {
				until = time.Now().Add(60 * time.Minute)
			}
			requeue = true
			setLastErr(limitText(agentLang(), until))
			pauseAnalyses(until)
			return
		}
		if engine == "claude" {
			logf("%s: account %s", key, accountName(acct))
		}
		started := time.Now()
		code, usage, f := runEngine(runOpts{engine: engine, bin: bin, prompt: res.Prompt, model: model, untrusted: entry.Source == "clone" || underClones(entry.Path) || others, others: others, issueKey: key, cwd: dir, base: a.Base, auth: a.Auth, activeAccount: acct})
		logf("end %s (code %d)", key, code)
		reportRun(a, deviceID, key, "analyze", engine, model, started, code, usage)
		rec := runRecord{Key: key, For: forName, Engine: engine, Model: model, Duration: time.Since(started).Milliseconds(), Tokens: usageTokens(usage), Result: runOK}
		if engine == "claude" {
			rec.Account = accountName(acct)
		}
		if code != 0 {
			if engine == "claude" && f.Limit {
				rec.Result = runLimit
			} else {
				rec.Result, rec.Reason = runFail, cut(failMessage(engine, code, f), 160)
			}
		}
		appendRun(rec)
		recorded = true
		if code == 0 {
			return
		}
		if engine == "claude" && f.Limit {
			until := parseResetTime(f.Raw, time.Now())
			setLimited(acct, until)
			skip[acct] = true
			logf("%s: account %s at its limit until %s", key, accountName(acct), until.Local().Format("15:04"))
			continue
		}
		failMsg = failMessage(engine, code, f)
		failCat = fmt.Sprintf("engine exited %d", code)
		return
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
	rec := runRecord{Key: claim.Key, Engine: "claude", Duration: time.Since(started).Milliseconds(), Result: runOK}
	if claim.Requester != nil && claim.Requester.ID != 0 {
		if own := ownUserID(a); own != 0 && claim.Requester.ID != own {
			rec.For = claim.Requester.Name
		}
	}
	appendRun(rec)
	return nil
}

func jobIssueID(j *pollJob) int {
	if j.ID == nil {
		return 0
	}
	return int(*j.ID)
}

type pollJob struct {
	Kind        string   `json:"kind"`
	Key         string   `json:"key"`
	Deep        any      `json:"deep"`
	ID          *float64 `json:"id"`
	RequestedAt *string  `json:"requestedAt"`
	RequestedBy *struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	} `json:"requestedBy"`
}

func cmdStart() {
	if !singleInstance() {
		fmt.Println("Agent is already running.")
		return
	}
	logf("start (PID %d, v%s)", os.Getpid(), Version)
	migrateTeamModeOnDisk()
	updateConfig(func(c *Config) {}) // rewrites config.json so a plain-text token from an older version gets encrypted
	go sweepWebviewTemp()
	runWithTray(func() {
		listenForOpen()
		if openAtStart {
			go openSettings()
		}
		listenForDump()
		go ensureStartMenuLink(installedPath())
		go updateLoop()
		go cleanupOldExe()
		go showUpdatedCard()
		go refreshAppVersion()
		pollLoop()
	})
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
	busyOther := running.Load() || freshLocks() || updating.Load() // no new work while an update waits to swap the exe
	_, paused := pausedUntil()
	busy := busyOther || paused // while every Claude account is at its limit the server offers no jobs
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
	// Mapping with paths, sources and the validation result ({KEY: {path, source, status, error}}), so the server can show and route by it.
	reposJSON, _ := json.Marshal(repoReports(a, cfg.Repos))
	qs := url.Values{"deviceId": {cfg.DeviceID}, "name": {host}, "busy": {b}, "version": {ver}, "engine": {eng}, "repos": {string(reposJSON)}, "setup": {setupJSON(strings.TrimRight(cfg.URL, "/"))}}
	if le := getLastErr(); le != "" {
		qs.Set("error", cut(le, 300))
	}
	if sk := skipParam(); sk != "" {
		qs.Set("skip", sk)
	}
	var res struct {
		Jobs         []pollJob         `json:"jobs"`
		Repos        []json.RawMessage `json:"repos"`
		CloneAllowed []any             `json:"cloneAllowed"`
		TeamMode     string            `json:"teamMode"`
		Limit        *int64            `json:"maxOthersTokensPerDay"`
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
	syncTeamMode(a, cfg, res.TeamMode)
	setOthersLimit(res.Limit)
	go syncLang(a)
	*delay, *errLogged = 2, false
	var job *pollJob
	pending := 0
	if !busyOther {
		live := map[string]bool{}
		for i := range res.Jobs {
			if res.Jobs[i].Kind == "analyze" {
				live[res.Jobs[i].Key] = true
			}
		}
		if !busy && len(cards.SyncPrompts(live)) > 0 {
			cardsChanged() // the job was taken by another computer or cancelled: its card closes
		}
		for i := range res.Jobs {
			j := &res.Jobs[i]
			if j.Kind == "analyze" {
				if paused {
					continue
				}
				if recentlyDeclined(j.Key) {
					skipJob(j)
					continue
				}
				rq := newRequester(j.RequestedBy, j.RequestedAt)
				d := consentDecision(a, j.Key, rq)
				if d == dPending {
					if ensurePrompt(j.Key, rq) {
						pending++
					}
					continue
				}
				if d == dNo {
					skipJob(j)
					continue
				}
				if _, ok := cards.RemovePrompt(j.Key); ok {
					cardsChanged()
				}
			}
			job = j
			break
		}
	}
	if job != nil && job.Kind == "analyze" {
		logf("analysis %s", job.Key)
		running.Store(true)
		rq := newRequester(job.RequestedBy, job.RequestedAt)
		// Not awaited: the loop keeps polling (busy=1) so the server keeps the claim fresh during a long run.
		go func(key string, deep bool, issueID int) {
			setAnalyzing(key, "")
			defer setAnalyzing("", "")
			defer running.Store(false)
			defer func() {
				if r := recover(); r != nil {
					logf("error: %v", r)
				}
			}()
			analyze(a, key, deep, cfg.DeviceID, rq, issueID)
		}(job.Key, truthy(job.Deep), jobIssueID(job))
	} else if job != nil && job.Kind == "start" && job.ID != nil {
		if err := startJob(a, int(*job.ID), cfg.DeviceID); err != nil {
			m := hhmm() + " could not open VS Code: " + err.Error()
			setLastErr(m)
			logf("%s", m)
		}
	}
	// No pause after a successful poll: the server holds the request (long poll). Only guards against a tight loop.
	if pending > 0 && job == nil {
		time.Sleep(time.Second) // cards are waiting for an answer: do not hammer the server
	} else if !busy && job == nil {
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

// syncTeamMode adopts the team mode the server reports (it is the source of truth). Right after the legacy
// askOthers=false migration the local 'auto' goes to the server instead.
func syncTeamMode(a *Auth, cfg Config, server string) {
	if migratedAuto.CompareAndSwap(true, false) {
		go patchTeamMode(teamAuto)
		return
	}
	if m, ok := adoptServerTeamMode(cfg, server, time.Now()); ok {
		if m == teamAuto && teamModeOf(cfg) != teamAuto {
			// The server must not switch consent off by itself: 'auto' is only accepted when set on this computer
			// (tray menu or the settings window). Local mode stays and the server is told so.
			logf("server asked for team mode auto: ignored, set it on this computer to allow it (staying on %s)", teamModeOf(cfg))
			setLastErr(cut(hhmm()+" team mode 'auto' can only be turned on at this computer (tray menu); staying on "+teamModeOf(cfg), 300))
			if now := time.Now().UnixMilli(); now-lastAutoRevert.Load() > int64(10*time.Minute/time.Millisecond) {
				lastAutoRevert.Store(now)
				go patchTeamMode(teamModeOf(cfg))
			}
			return
		}
		updateConfig(func(c *Config) { c.TeamMode = m })
		notifyStatus()
	}
}

var lastAutoRevert atomic.Int64
