//go:build windows

package app

import (
	"os"
	"syscall"
	"unsafe"
)

var (
	procSetHook    = user32.NewProc("SetWindowsHookExW")
	procUnhook     = user32.NewProc("UnhookWindowsHookEx")
	procCallNext   = user32.NewProc("CallNextHookEx")
	procCurThread  = syscall.NewLazyDLL("kernel32.dll").NewProc("GetCurrentThreadId")
	offscreenProc  = syscall.NewCallback(offscreenHook)
	offscreenHookH uintptr
)

// createStruct mirrors CREATESTRUCTW (64-bit layout).
type createStruct struct {
	CreateParams, Instance, Menu, Parent uintptr
	Cy, Cx, Y, X                         int32
	Style                                int32
	Name, Class                          uintptr
	ExStyle                              uint32
}

func offscreenHook(code, wParam uintptr, lParam unsafe.Pointer) uintptr {
	const hcbtCreateWnd = 3
	if code == hcbtCreateWnd {
		cbt := (*struct {
			Cs    *createStruct
			After uintptr
		})(unsafe.Pointer(lParam))
		if cbt.Cs != nil && cbt.Cs.Parent == 0 {
			cbt.Cs.X, cbt.Cs.Y = -32000, -32000 // born off screen: the empty white window is never seen
		}
	}
	r, _, _ := procCallNext.Call(offscreenHookH, code, wParam, uintptr(lParam))
	return r
}

// offscreen runs f (which creates a WebView2 window on this locked thread) with top-level windows created off
// screen; the caller moves the window into place once the page engine is ready. The library shows the window at
// the Windows default position with a white background before it embeds the browser (the white flash).
func offscreen(f func()) {
	tid, _, _ := procCurThread.Call()
	h, _, _ := procSetHook.Call(5 /* WH_CBT */, offscreenProc, 0, tid)
	offscreenHookH = h
	f()
	if h != 0 {
		procUnhook.Call(h)
	}
	offscreenHookH = 0
}

// webviewBackground: the WebView2 default background follows the theme (dark instead of white before the page paints).
func webviewBackground() {
	if os.Getenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR") != "" {
		return
	}
	if currentTheme() == "light" {
		_ = os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FFFFFFFF")
	} else {
		_ = os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF000000")
	}
}
