//go:build windows

package app

import "golang.org/x/sys/windows"

const (
	idYes = 6
	// kinds
	dlgInfo  = windows.MB_OK | windows.MB_ICONINFORMATION
	dlgError = windows.MB_OK | windows.MB_ICONERROR
	dlgAsk   = windows.MB_YESNO | windows.MB_ICONQUESTION
	// MB_SETFOREGROUND | MB_TOPMOST
	dlgFront = 0x10000 | 0x40000
)

// msgBox shows a native message box and returns the pressed button (idYes for Yes).
func msgBox(text string, kind uint32) int {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("Exponential agent")
	r, _ := windows.MessageBox(0, t, c, kind|dlgFront)
	return int(r)
}
