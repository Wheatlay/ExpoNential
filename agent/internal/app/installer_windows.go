//go:build windows

package app

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

//go:embed installer.html
var installerHTML string

var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	procGetDpi      = user32.NewProc("GetDpiForSystem")
	procGetMetrics  = user32.NewProc("GetSystemMetrics")
	procGetWinRect  = user32.NewProc("GetWindowRect")
	procSetWinPos   = user32.NewProc("SetWindowPos")
	installerWidth  = 480
	installerHeight = 480
)

func dpiScale() float64 {
	if procGetDpi.Find() != nil {
		return 1
	}
	d, _, _ := procGetDpi.Call()
	if d < 96 {
		return 1
	}
	return float64(d) / 96
}

// centerWindow puts the window in the middle of the primary screen.
func centerWindow(hwnd uintptr) {
	var r struct{ Left, Top, Right, Bottom int32 }
	procGetWinRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	sw, _, _ := procGetMetrics.Call(0) // SM_CXSCREEN
	sh, _, _ := procGetMetrics.Call(1) // SM_CYSCREEN
	x := (int32(sw) - (r.Right - r.Left)) / 2
	y := (int32(sh) - (r.Bottom - r.Top)) / 2
	// SWP_NOSIZE | SWP_NOZORDER
	procSetWinPos.Call(hwnd, 0, uintptr(x), uintptr(y), 0, 0, 0x0001|0x0004)
}

// runInstallerWindow shows the branded installer window and blocks until it closes.
// mode: "" = install / connected; "uninstall" = ask first; "uninstall-run" = uninstall right away.
// It returns false when the window could not be created (WebView2 runtime missing), so the caller falls back.
func runInstallerWindow(mode string) (shown bool) {
	defer func() {
		if r := recover(); r != nil {
			logf("installer window: %v", r)
			shown = false
		}
	}()
	dataPath := filepath.Join(os.TempDir(), fmt.Sprintf("exponential-agent-webview-%d", os.Getpid())) // per process: a shared folder in use by the running agent blocks a second WebView2
	sc := dpiScale()
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  dataPath,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "Exponential",
			Width:  uint(float64(installerWidth) * sc),
			Height: uint(float64(installerHeight) * sc),
			IconId: 1,
		},
	})
	if w == nil {
		return false
	}
	defer func() { w.Destroy(); _ = os.RemoveAll(dataPath) }()
	w.SetTitle("Exponential")
	w.SetSize(int(float64(installerWidth)*sc), int(float64(installerHeight)*sc), webview2.HintFixed)
	darkTitleBar(uintptr(w.Window()))
	centerWindow(uintptr(w.Window()))

	push := func(js string) { w.Dispatch(func() { w.Eval(js) }) }
	var mu sync.Mutex
	var ctx *installCtx
	getCtx := func() *installCtx { mu.Lock(); defer mu.Unlock(); return ctx }
	// fail pushes an error screen from an install/uninstall goroutine.
	fail := func(code, detail string) {
		b, _ := json.Marshal(map[string]string{"errCode": code, "errDetail": detail})
		push("showError(" + string(b) + ")")
	}

	_ = w.Bind("info", func() installInfo {
		go func() {
			if mode != "" {
				cfg := loadConfig()
				info := installInfo{Lang: uiLang(), State: mode, User: cfg.UserName, Host: hostOf(cfg.URL)}
				b, _ := json.Marshal(info)
				push("setInfo(" + string(b) + ")")
				return
			}
			info, c := prepareInstall()
			mu.Lock()
			ctx = c
			mu.Unlock()
			b, _ := json.Marshal(info)
			push("setInfo(" + string(b) + ")")
		}()
		return installInfo{Lang: uiLang(), State: "loading"}
	})
	_ = w.Bind("install", func(autostart bool) {
		c := getCtx()
		if c == nil {
			return
		}
		go func() {
			defer func() {
				if r := recover(); r != nil {
					fail("install", "internal error")
				}
			}()
			out := runSetup(c, autostart, func(level int, state, note string) {
				b, _ := json.Marshal(note)
				push(fmt.Sprintf("setRow(%d,%q,%s)", level, state, b))
			})
			if out.Res.Code != "" {
				fail(out.Res.Code, out.Res.Detail)
				return
			}
			b, _ := json.Marshal(map[string]any{"errors": out.Errors, "done": out.Done, "agentSeen": out.AgentSeen, "goal": c.goal})
			push("finish(" + string(b) + ")")
		}()
	})
	_ = w.Bind("disconnect", func() {
		go func() {
			forgot, err := uninstallAll()
			if err != nil {
				fail("install", err.Error())
				return
			}
			if forgot {
				push("removed(false)")
			} else {
				push("removed(true)")
			}
		}()
	})
	_ = w.Bind("openExponential", func() {
		u := ""
		if c := getCtx(); c != nil {
			u = c.openURL
		}
		if u == "" {
			u = loadConfig().URL
		}
		u = strings.TrimRight(u, "/")
		if u != "" {
			openURL(u + "/settings")
		}
	})
	_ = w.Bind("close", func() { w.Dispatch(func() { w.Terminate() }) })

	w.SetHtml(applyUI(installerHTML, currentTheme()))
	w.Run()
	return true
}

var procDwmSet = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute")

func colorRef(r, g, b uint32) uint32 { return r | g<<8 | b<<16 }

// darkTitleBar makes the title bar match the page: dark mode, page-colored caption, light text (Windows 11 for the colors).
func darkTitleBar(hwnd uintptr) {
	if procDwmSet.Find() != nil {
		return
	}
	set := func(attr uintptr, v uint32) { procDwmSet.Call(hwnd, attr, uintptr(unsafe.Pointer(&v)), 4) }
	if currentTheme() == "light" {
		set(20, 0)
		set(35, colorRef(255, 255, 255))
		set(36, colorRef(0x1a, 0x1b, 0x1f))
		return
	}
	set(20, 1)                          // DWMWA_USE_IMMERSIVE_DARK_MODE
	set(35, colorRef(15, 16, 18))       // DWMWA_CAPTION_COLOR = #0f1012
	set(36, colorRef(0xc9, 0xcc, 0xd3)) // DWMWA_TEXT_COLOR
}
