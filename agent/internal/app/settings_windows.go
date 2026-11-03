//go:build windows

package app

import (
	_ "embed"
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
	settingsW = 380
	settingsH = 460
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
	Autostart    bool              `json:"autostart"`
	Muted        bool              `json:"muted"`
	MuteLabel    string            `json:"muteLabel"`
}

func settingsLabels(lang string) map[string]string {
	if lang == "pl" {
		return map[string]string{"team": "Zlecenia zespołu", "ask": "Pytaj", "auto": "Bez pytania", "off": "Nie biorę",
			"tipAsk": "Pytaj o zgodę przed analizą cudzego zlecenia", "tipAuto": "Uruchamiaj cudze zlecenia bez pytania", "tipOff": "Nie biorę cudzych zleceń",
			"notify": "Powiadomienia o analizach dla innych", "autostart": "Uruchamiaj z Windows", "theme": "Motyw",
			"sys": "Systemowy", "dark": "Ciemny", "light": "Jasny", "open": "Otwórz Exponential", "ai": "Ustawienia AI", "uninstall": "Odinstaluj…",
			"version": "agent %V", "update": "Zaktualizuj do %V"}
	}
	return map[string]string{"team": "Team jobs", "ask": "Ask", "auto": "Don't ask", "off": "Don't take",
		"tipAsk": "Ask before running someone else's analysis", "tipAuto": "Run others' analyses without asking", "tipOff": "Never take others' analyses",
		"notify": "Notifications for analyses for others", "autostart": "Start with Windows", "theme": "Theme",
		"sys": "System", "dark": "Dark", "light": "Light", "open": "Open Exponential", "ai": "AI settings", "uninstall": "Uninstall…",
		"version": "agent %V", "update": "Update to %V"}
}

func buildSettingsState() settingsState {
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
		TeamMode: teamModeOf(cfg), Notify: notifyOthersOn(), Autostart: strings.HasPrefix(autostartState(), "on"),
		Muted: muted, MuteLabel: muteItemTitle(lang, until, muted),
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
func launchUninstall() {
	if exe, err := os.Executable(); err == nil {
		c := exec.Command(exe)
		detachCmd(c)
		if c.Start() == nil {
			_ = c.Process.Release()
		}
	}
}

func runUpdate() {
	go func() {
		if err := doUpdate(); err != nil {
			logf("update failed: %s", err)
			notifyText(map[bool]string{true: "Aktualizacja nie powiodła się", false: "Update failed"}[uiLang() == "pl"])
		}
	}()
}

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
		dataPath := filepath.Join(os.TempDir(), "exponential-agent-webview-settings")
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

		_ = w.Bind("getState", func() settingsState { return buildSettingsState() })
		_ = w.Bind("setTeamMode", func(m string) { setTeamMode(m) })
		_ = w.Bind("setNotify", func(on bool) { setNotifyOthers(on) })
		_ = w.Bind("setAutostart", func(on bool) { setAutostart(on) })
		_ = w.Bind("toggleMute", func() { toggleMute() })
		_ = w.Bind("setTheme", func(t string) { setTheme(t) })
		_ = w.Bind("openApp", func() { openApp() })
		_ = w.Bind("openAI", func() { openAISettings() })
		_ = w.Bind("uninstall", func() { launchUninstall() })
		_ = w.Bind("update", func() { runUpdate() })
		_ = w.Bind("close", func() { w.Dispatch(func() { w.Terminate() }) })
		w.SetHtml(applyUI(settingsHTML, currentTheme()))
		w.Run()
	}()
}
