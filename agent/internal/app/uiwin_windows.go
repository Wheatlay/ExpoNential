//go:build windows

package app

import (
	"os"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows/registry"
)

var (
	procSetWinLong    = user32.NewProc("SetWindowLongPtrW")
	procShowWindow    = user32.NewProc("ShowWindow")
	procDestroyWindow = user32.NewProc("DestroyWindow")
	procIsWindowW     = user32.NewProc("IsWindow")
	procSetWinRgn     = user32.NewProc("SetWindowRgn")
	procSysParamInfo  = user32.NewProc("SystemParametersInfoW")
	procSetForeground = user32.NewProc("SetForegroundWindow")
	procRoundRgn      = gdi32.NewProc("CreateRoundRectRgn")
	procRectRgn       = gdi32.NewProc("CreateRectRgn")
	procCombineRgn    = gdi32.NewProc("CombineRgn")
)

type winRect struct{ Left, Top, Right, Bottom int32 }

// workArea is the primary monitor without the taskbar (physical pixels; the process is DPI aware).
func workArea() winRect {
	var r winRect
	ok, _, _ := procSysParamInfo.Call(0x0030, 0, uintptr(unsafe.Pointer(&r)), 0) // SPI_GETWORKAREA
	if ok == 0 {
		sw, _, _ := procGetMetrics.Call(0)
		sh, _, _ := procGetMetrics.Call(1)
		r = winRect{0, 0, int32(sw), int32(sh)}
	}
	return r
}

// popupStyle turns the window into a borderless tool window without a taskbar button that stays on top.
// noActivate: it never takes the focus (the toasts).
func popupStyle(hwnd uintptr, border, noActivate bool) {
	style := uintptr(0x80000000) // WS_POPUP
	if border {
		style |= 0x00800000 // WS_BORDER
	}
	ex := uintptr(0x80 | 0x8) // WS_EX_TOOLWINDOW | WS_EX_TOPMOST
	if noActivate {
		ex |= 0x08000000 // WS_EX_NOACTIVATE
	}
	gwlStyle, gwlExStyle := -16, -20
	procSetWinLong.Call(hwnd, uintptr(gwlStyle), style)
	procSetWinLong.Call(hwnd, uintptr(gwlExStyle), ex)
	// SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
	procSetWinPos.Call(hwnd, 0, 0, 0, 0, 0, 0x0001|0x0002|0x0004|0x0010|0x0020)
}

func hideWindow(hwnd uintptr) { procShowWindow.Call(hwnd, 0) }

// placeTopmost moves and sizes the window above all others without activating it.
func placeTopmost(hwnd uintptr, x, y, w, h int32, show bool) {
	flags := uintptr(0x0010) // SWP_NOACTIVATE
	if show {
		flags |= 0x0040 // SWP_SHOWWINDOW
	}
	procSetWinPos.Call(hwnd, ^uintptr(0), uintptr(x), uintptr(y), uintptr(w), uintptr(h), flags)
}

// clipToRects shows only the given rounded rectangles of the window (the gaps between toasts stay see-through).
func clipToRects(hwnd uintptr, rects [][4]int32, radius int32) {
	all, _, _ := procRectRgn.Call(0, 0, 0, 0)
	for _, r := range rects {
		rg, _, _ := procRoundRgn.Call(uintptr(r[0]), uintptr(r[1]), uintptr(r[0]+r[2]+1), uintptr(r[1]+r[3]+1), uintptr(radius*2), uintptr(radius*2))
		procCombineRgn.Call(all, all, rg, 2) // RGN_OR
		procDeleteObject.Call(rg)
	}
	if ok, _, _ := procSetWinRgn.Call(hwnd, all, 1); ok == 0 {
		procDeleteObject.Call(all) // on success the system owns the region
	}
}

// roundCorners asks Windows 11 for rounded window corners (ignored where unsupported).
func roundCorners(hwnd uintptr) {
	if procDwmSet.Find() != nil {
		return
	}
	v := uint32(2) // DWMWCP_ROUND
	procDwmSet.Call(hwnd, 33, uintptr(unsafe.Pointer(&v)), 4)
}

// systemLight: Windows apps use the light theme (AppsUseLightTheme = 1).
func systemLight() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("AppsUseLightTheme")
	return err == nil && v == 1
}

var (
	procGetFgWin   = user32.NewProc("GetForegroundWindow")
	procIsVisible  = user32.NewProc("IsWindowVisible")
	procWinThrProc = user32.NewProc("GetWindowThreadProcessId")
)

func foregroundWindow() uintptr { h, _, _ := procGetFgWin.Call(); return h }

func windowVisible(h uintptr) bool { r, _, _ := procIsVisible.Call(h); return r != 0 }

// ownWindow: the window belongs to this process (e.g. the folder picker or a toast).
func ownWindow(h uintptr) bool {
	var pid uint32
	procWinThrProc.Call(h, uintptr(unsafe.Pointer(&pid)))
	return int(pid) == os.Getpid()
}

// destroyWebview ends a WebView2 window after its message loop has returned (call on the window's thread).
// webview.Destroy only posts WM_CLOSE, which nobody reads once Run is over: the window and its whole browser
// (several processes, a few hundred MB) stayed alive until the agent exited. DestroyWindow is synchronous.
func destroyWebview(w webview2.WebView) {
	if h := uintptr(w.Window()); h != 0 && isWindow(h) {
		procDestroyWindow.Call(h)
	}
}

func isWindow(h uintptr) bool { r, _, _ := procIsWindowW.Call(h); return r != 0 }
