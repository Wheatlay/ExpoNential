//go:build windows

package app

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	webview2 "github.com/jchv/go-webview2"
)

//go:embed settings.html
var settingsHTML string

const (
	settingsW = 400
	settingsH = 520
)

var (
	settingsOpen atomic.Bool
	settingsHwnd atomic.Uintptr
)

type settingsState struct {
	Theme        string            `json:"theme"`
	ThemeSetting string            `json:"themeSetting"`
	L            map[string]string `json:"L"`
	Who          string            `json:"who"`
	State        string            `json:"state"`
	Kind         string            `json:"kind"`
	Version      string            `json:"version"`
	UpdateTo     string            `json:"updateTo"`
	TeamMode     string            `json:"teamMode"`
	Notify       bool              `json:"notify"`
	AutoUpdate   bool              `json:"autoUpdate"`
	Autostart    bool              `json:"autostart"`
	Muted        bool              `json:"muted"`
	MuteLabel    string            `json:"muteLabel"`
	Runs         []runRecord       `json:"runs"`
}

func settingsLabels(lang string) map[string]string {
	if lang == "pl" {
		return map[string]string{"team": "Zlecenia zespołu", "ask": "Pytaj", "auto": "Bez pytania", "off": "Nie biorę",
			"tipAsk": "Pytaj o zgodę przed analizą cudzego zlecenia", "tipAuto": "Uruchamiaj cudze zlecenia bez pytania", "tipOff": "Nie biorę cudzych zleceń",
			"notify": "Powiadomienia o analizach dla innych", "autoUpdate": "Aktualizuj automatycznie", "autostart": "Uruchamiaj z Windows", "theme": "Motyw",
			"sys": "Systemowy", "dark": "Ciemny", "oled": "OLED", "light": "Jasny", "open": "Otwórz Exponential", "ai": "Ustawienia AI", "uninstall": "Odinstaluj…",
			"version": "agent %V", "update": "Zaktualizuj do %V",
			"tabGeneral": "Ogólne", "tabRepos": "Repo", "tabRuns": "Analizy", "showLog": "Pokaż log", "copyLog": "Kopiuj log", "copied": "Skopiowano", "back": "Wstecz",
			"loading": "Wczytuję…", "logEmpty": "Log jest pusty", "repoErr": "Brak połączenia z serwerem", "noProjects": "Brak projektów", "noRepo": "brak repo w projekcie", "unmapped": "brak mapowania",
			"ok": "ok", "pick": "Wybierz folder", "remove": "Usuń", "srcAuto": "auto", "srcManual": "ręcznie", "srcClone": "klon", "srcHook": "hook",
			"nofolder": "brak folderu", "notclone": "to nie klon repo", "norepo": "brak repo w projekcie", "noRuns": "Brak analiz",
			"resOk": "ok", "resFail": "błąd", "resLimit": "limit Claude", "resDeclined": "odmowa", "resMuted": "wyciszone"}
	}
	return map[string]string{"team": "Team jobs", "ask": "Ask", "auto": "Don't ask", "off": "Don't take",
		"tipAsk": "Ask before running someone else's analysis", "tipAuto": "Run others' analyses without asking", "tipOff": "Never take others' analyses",
		"notify": "Notifications for analyses for others", "autoUpdate": "Update automatically", "autostart": "Start with Windows", "theme": "Theme",
		"sys": "System", "dark": "Dark", "oled": "OLED", "light": "Light", "open": "Open Exponential", "ai": "AI settings", "uninstall": "Uninstall…",
		"version": "agent %V", "update": "Update to %V",
		"tabGeneral": "General", "tabRepos": "Repos", "tabRuns": "Analyses", "showLog": "Show log", "copyLog": "Copy log", "copied": "Copied", "back": "Back",
		"loading": "Loading…", "logEmpty": "The log is empty", "repoErr": "Cannot reach the server", "noProjects": "No projects", "noRepo": "no repo in the project", "unmapped": "not mapped",
		"ok": "ok", "pick": "Choose folder", "remove": "Remove", "srcAuto": "auto", "srcManual": "manual", "srcClone": "clone", "srcHook": "hook",
		"nofolder": "folder missing", "notclone": "not a clone of the repo", "norepo": "no repo in the project", "noRuns": "No analyses yet",
		"resOk": "ok", "resFail": "error", "resLimit": "Claude limit", "resDeclined": "declined", "resMuted": "muted"}
}

func buildSettingsState() (st settingsState) {
	defer func() {
		if r := recover(); r != nil {
			logf("settings state: %v", r)
			st = settingsState{Theme: "dark", ThemeSetting: "system", L: settingsLabels("en"), TeamMode: teamAsk, Runs: []runRecord{}}
		}
	}()
	lang := uiLang()
	cfg := loadConfig()
	text, kind := statusParts(lang)
	until, muted := mutedUntilOf(cfg, time.Now())
	trayMu.Lock()
	upd := updateVer
	trayMu.Unlock()
	ts := cfg.Theme
	if !validTheme(ts) {
		ts = "system"
	}
	return settingsState{
		Theme: currentTheme(), ThemeSetting: ts, L: settingsLabels(lang),
		Who:   strings.TrimSpace(cfg.UserName + " · " + hostOf(cfg.URL)),
		State: text, Kind: kind, Version: Version, UpdateTo: upd,
		TeamMode: teamModeOf(cfg), Notify: notifyOthersOn(), AutoUpdate: autoUpdateOn(), Autostart: strings.HasPrefix(autostartState(), "on"),
		Muted: muted, MuteLabel: muteItemTitle(lang, until, muted), Runs: loadRuns(),
	}
}

// guard is deferred at the top of a binding: a panic is logged instead of leaving the page waiting.
func guard(name string) {
	if r := recover(); r != nil {
		logf("settings %s: %v", name, r)
	}
}

func setAutostart(on bool) {
	if on {
		if exe, err := os.Executable(); err == nil {
			_ = autostartOn(exe)
		}
	} else {
		autostartOff()
	}
	notifyStatus()
}

func openAISettings() {
	if u := loadConfig().URL; u != "" {
		openURL(strings.TrimRight(u, "/") + "/settings#claude")
	}
}

func openApp() {
	if u := loadConfig().URL; u != "" {
		openURL(u)
	}
}

// launchUninstall: the installer window (no arguments) shows this computer with "Disconnect": the same place
// as a reinstall, with a confirmation, no system dialogs.
// launchUninstall starts a separate process in the uninstall-confirm mode ("uninstall --ask"): the installer window
// with Disconnect, or a Yes/No question when the window cannot open, so the menu item always leads somewhere.
func launchUninstall() {
	if exe, err := os.Executable(); err == nil {
		c := exec.Command(exe, "uninstall", "--ask")
		detachCmd(c)
		if c.Start() == nil {
			_ = c.Process.Release()
		}
	}
}

// runUpdate starts the update; the update card of the toast window shows the progress.
func runUpdate() { go startUpdate() }

func toggleMute() { setMuted(!isMuted()) }

// openSettings shows the mini settings window (or brings the open one to the front).
func openSettings() {
	if !settingsOpen.CompareAndSwap(false, true) {
		if h := settingsHwnd.Load(); h != 0 {
			procSetForeground.Call(h)
		}
		return
	}
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer settingsOpen.Store(false)
		defer settingsHwnd.Store(0)
		defer func() {
			if r := recover(); r != nil {
				logf("settings window: %v", r)
			}
		}()
		dataPath := filepath.Join(os.TempDir(), fmt.Sprintf("exponential-agent-webview-settings-%d", os.Getpid()))
		sc := dpiScale()
		w := webview2.NewWithOptions(webview2.WebViewOptions{
			DataPath:  dataPath,
			AutoFocus: true,
			WindowOptions: webview2.WindowOptions{
				Title:  "Exponential",
				Width:  uint(float64(settingsW) * sc),
				Height: uint(float64(settingsH) * sc),
				IconId: 1,
			},
		})
		if w == nil {
			openApp() // no WebView2: open the web settings instead
			return
		}
		defer func() { w.Destroy(); _ = os.RemoveAll(dataPath) }()
		hwnd := uintptr(w.Window())
		settingsHwnd.Store(hwnd)
		popupStyle(hwnd, true, false)
		roundCorners(hwnd)
		ww, wh := int32(float64(settingsW)*sc), int32(float64(settingsH)*sc)
		wa := workArea()
		margin := int32(12 * sc)
		placeTopmost(hwnd, wa.Right-ww-margin, wa.Bottom-wh-margin, ww, wh, true)
		procSetForeground.Call(hwnd)

		_ = w.Bind("getState", func() settingsState {
			defer guard("getState")
			return buildSettingsState()
		})
		_ = w.Bind("setTeamMode", func(m string) {
			defer guard("setTeamMode")
			setTeamMode(m)
		})
		_ = w.Bind("setNotify", func(on bool) {
			defer guard("setNotify")
			setNotifyOthers(on)
		})
		_ = w.Bind("setAutoUpdate", func(on bool) {
			defer guard("setAutoUpdate")
			setAutoUpdate(on)
		})
		_ = w.Bind("setAutostart", func(on bool) {
			defer guard("setAutostart")
			setAutostart(on)
		})
		_ = w.Bind("toggleMute", func() {
			defer guard("toggleMute")
			toggleMute()
		})
		_ = w.Bind("setTheme", func(t string) {
			defer guard("setTheme")
			setTheme(t)
		})
		_ = w.Bind("openApp", func() {
			defer guard("openApp")
			openApp()
		})
		_ = w.Bind("openAI", func() {
			defer guard("openAI")
			openAISettings()
		})
		_ = w.Bind("uninstall", func() {
			defer guard("uninstall")
			launchUninstall()
		})
		_ = w.Bind("update", func() {
			defer guard("update")
			runUpdate()
		})
		_ = w.Bind("getLog", func() string {
			defer guard("getLog")
			return logTail()
		})
		_ = w.Bind("copyLog", func() bool {
			defer guard("copyLog")
			if err := setClipboard(logTail()); err != nil {
				logf("copy log: %v", err)
				return false
			}
			return true
		})
		_ = w.Bind("openIssue", func(key string) {
			defer guard("openIssue")
			if u := loadConfig().URL; u != "" && keyRe.MatchString(key) {
				openURL(issueURL(u, key))
			}
		})
		push := func(js string) { w.Dispatch(func() { w.Eval(js) }) }
		// The repo list asks the server and runs git: off the window thread, the answer is pushed to the page.
		_ = w.Bind("loadRepos", func() {
			defer guard("loadRepos")
			go func() {
				defer func() { _ = recover() }()
				res := map[string]any{"rows": []repoRow{}}
				a, err := getAuth()
				if err == nil && a == nil {
					err = errors.New("not logged in")
				}
				if err == nil {
					var rows []repoRow
					if rows, err = buildRepoRows(a); err == nil {
						res["rows"] = rows
					}
				}
				if err != nil {
					logf("repo list: %s", shortErr(err))
					res["err"] = shortErr(err)
				}
				b, _ := json.Marshal(res)
				push("onRepos(" + string(b) + ")")
			}()
		})
		_ = w.Bind("pickFolder", func(key string) string {
			defer guard("pickFolder")
			title := "Exponential · " + key
			p, err := pickFolder(hwnd, title)
			if err != nil {
				logf("folder picker: %v", err)
				return ""
			}
			return p
		})
		_ = w.Bind("saveRepo", func(key, path string) {
			defer guard("saveRepo")
			go func() {
				defer func() { _ = recover() }()
				code, detail, err := saveManualRepo(key, path)
				if err != nil {
					code, detail = "notclone", err.Error()
				}
				k, c, d := mustJSON(key), mustJSON(code), mustJSON(detail)
				push("onRepoSaved(" + k + "," + c + "," + d + ")")
			}()
		})
		_ = w.Bind("removeRepo", func(key string) {
			defer guard("removeRepo")
			removeRepo(key)
		})
		_ = w.Bind("jsError", func(msg string) { logf("settings js: %s", msg) })
		_ = w.Bind("close", func() {
			defer guard("close")
			w.Dispatch(func() { w.Terminate() })
		})
		w.SetHtml(applyUI(settingsHTML, currentTheme()))
		w.Run()
	}()
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
