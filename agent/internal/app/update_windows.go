//go:build windows

package app

import (
	"os"

	"fyne.io/systray"
	"golang.org/x/sys/windows/registry"
)

// restartAfterUpdate starts the new exe and quits this process without deleting the new instance's lock.
func restartAfterUpdate(exe string) error {
	skipLockRemove.Store(true)
	_ = os.Remove(lockPath())
	if err := startDetachedExe(exe); err != nil {
		skipLockRemove.Store(false)
		return err
	}
	systray.Quit()
	return nil
}

// refreshAppVersion keeps the Apps & features version in step with the running exe (after a self-update).
func refreshAppVersion() {
	if exe, err := os.Executable(); err != nil || !sameDir(exe, installedPath()) {
		return
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, uninstallKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.SetStringValue("DisplayVersion", Version)
}
