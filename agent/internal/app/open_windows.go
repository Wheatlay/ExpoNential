//go:build windows

package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

const openEventName = `Local\ExponentialAgentOpen`

func startMenuLink() string {
	base := os.Getenv("APPDATA")
	if base == "" {
		h, _ := os.UserHomeDir()
		base = filepath.Join(h, "AppData", "Roaming")
	}
	return filepath.Join(base, "Microsoft", "Windows", "Start Menu", "Programs", "Exponential agent.lnk")
}

// ensureStartMenuLink creates the Start Menu shortcut (exe + argument "open") when it is missing.
func ensureStartMenuLink(target string) {
	lnk := startMenuLink()
	if _, err := os.Stat(lnk); err == nil {
		return
	}
	if _, err := os.Stat(target); err != nil {
		return
	}
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	script := "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" + q(lnk) + ");" +
		"$s.TargetPath=" + q(target) + ";$s.Arguments='open';$s.WorkingDirectory=" + q(filepath.Dir(target)) + ";" +
		"$s.IconLocation=" + q(target+",0") + ";$s.Description='Exponential agent';$s.Save()"
	c := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	hideCmd(c)
	if err := c.Run(); err != nil {
		logf("could not create the Start Menu shortcut: %s", err)
	}
}

func removeStartMenuLink() { _ = os.Remove(startMenuLink()) }

// listenForOpen makes the running agent open its window whenever `exponential-agent open` signals the event.
func listenForOpen() {
	name, _ := windows.UTF16PtrFromString(openEventName)
	h, err := windows.CreateEvent(nil, 0, 0, name) // auto-reset
	if err != nil {
		logf("open event: %s", err)
		return
	}
	go func() {
		for {
			if ev, err := windows.WaitForSingleObject(h, windows.INFINITE); err != nil || ev != windows.WAIT_OBJECT_0 {
				return
			}
			openSettings()
		}
	}()
}

func signalOpen() bool {
	name, _ := windows.UTF16PtrFromString(openEventName)
	h, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, name)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	return windows.SetEvent(h) == nil
}

// cmdOpen: starts the agent when none runs, then asks it to show its window.
func cmdOpen() error {
	if agentPID() != 0 && signalOpen() {
		return nil
	}
	if agentPID() == 0 {
		self, _ := os.Executable()
		if err := startDetachedExe(self); err != nil {
			return err
		}
	}
	for i := 0; i < 50; i++ {
		if signalOpen() {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}
