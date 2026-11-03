//go:build !windows

package app

// runInstallerWindow: no installer window on this OS (the message-box fallback runs instead).
func runInstallerWindow(mode string) bool { return false }

func uiLang() string { return "en" }
