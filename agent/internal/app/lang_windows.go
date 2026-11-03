//go:build windows

package app

import "golang.org/x/sys/windows"

// uiLang: "pl" when the Windows user interface language is Polish (primary language 0x15), else "en".
func uiLang() string {
	r, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetUserDefaultUILanguage").Call()
	if r&0x3ff == 0x15 {
		return "pl"
	}
	return "en"
}
