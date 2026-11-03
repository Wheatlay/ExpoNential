//go:build !windows

package app

// runInstallerWindow: no installer window on this OS (the message-box fallback runs instead).
func runInstallerWindow() bool { return false }

func uiLang() string { return "en" }
