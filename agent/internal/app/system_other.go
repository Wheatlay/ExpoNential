//go:build !windows

package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func installedPath() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".local", "bin", "exponential-agent")
}

func stopAgent(path string) {
	if pid := agentPID(); pid != 0 {
		killPID(uint32(pid))
	}
}

func installApp(self string, trailerSize int64) (string, error) {
	fmt.Println("TODO: install is implemented for Windows only.")
	return self, nil
}

func autostartOn(exe string) error {
	fmt.Println("TODO: autostart is implemented for Windows only (use systemd --user / launchd yourself for now).")
	return nil
}

func autostartOff() {
	fmt.Println("TODO: autostart is implemented for Windows only (use systemd --user / launchd yourself for now).")
}

func autostartState() string { return "not supported on this OS yet" }

// machineID: /etc/machine-id on Linux; empty elsewhere (a random device id is used then).
func machineID() string {
	b, err := os.ReadFile("/etc/machine-id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func uninstallAll() (bool, error) {
	forgot := stopAndForget("")
	return forgot, os.RemoveAll(dataDir())
}
