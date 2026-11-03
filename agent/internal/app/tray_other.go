//go:build !windows

package app

// runWithTray: no tray on this OS; the poll loop runs directly.
func runWithTray(loop func()) { loop() }
