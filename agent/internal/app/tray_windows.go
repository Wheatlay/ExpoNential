//go:build windows

package app

import (
	"os"
	"os/exec"
	"strings"

	"fyne.io/systray"
)

// runWithTray shows the tray icon and runs loop in a goroutine; it returns only when the agent is quit from the menu.
// The icon is best-effort: when it cannot be created the loop still runs.
func runWithTray(loop func()) {
	lang := uiLang()
	pl := lang == "pl"
	tx := func(p, e string) string {
		if pl {
			return p
		}
		return e
	}
	systray.Run(func() {
		if len(IconICO) > 0 {
			systray.SetIcon(IconICO)
		}
		systray.SetTitle("Exponential")
		systray.SetTooltip(statusText(lang))
		cfg := loadConfig()
		who := strings.TrimSpace(cfg.UserName + " · " + hostOf(cfg.URL))
		head := systray.AddMenuItem(who, "")
		head.Disable()
		// Stan i wersja w menu, nie tylko w podpowiedzi ikony.
		state := systray.AddMenuItem(strings.TrimPrefix(statusText(lang), "Exponential · ")+" · agent "+Version, "")
		state.Disable()
		open := systray.AddMenuItem(tx("Otwórz Exponential", "Open Exponential"), "")
		settings := systray.AddMenuItem(tx("Ustawienia AI", "AI settings"), "")
		systray.AddSeparator()
		notif := systray.AddMenuItemCheckbox(tx("Powiadomienia o analizach dla innych", "Notifications for analyses for others"), "", notifyOthersOn())
		auto := systray.AddMenuItemCheckbox(tx("Uruchamiaj z Windows", "Start with Windows"), "", strings.HasPrefix(autostartState(), "on"))
		systray.AddSeparator()
		uninstall := systray.AddMenuItem(tx("Odinstaluj…", "Uninstall…"), "")
		quit := systray.AddMenuItem(tx("Zakończ agenta", "Quit agent"), "")
		trayMu.Lock()
		onStatus = func() {
			systray.SetTooltip(statusText(lang))
			state.SetTitle(strings.TrimPrefix(statusText(lang), "Exponential · ") + " · agent " + Version)
		}
		trayMu.Unlock()
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					if u := loadConfig().URL; u != "" {
						openURL(u)
					}
				case <-settings.ClickedCh:
					if u := loadConfig().URL; u != "" {
						openURL(strings.TrimRight(u, "/") + "/settings#claude")
					}
				case <-auto.ClickedCh:
					if auto.Checked() {
						autostartOff()
						auto.Uncheck()
					} else if exe, err := os.Executable(); err == nil && autostartOn(exe) == nil {
						auto.Check()
					}
				case <-uninstall.ClickedCh:
					// The installer window (no arguments) shows this computer with "Disconnect": the same place
					// as a reinstall, with a confirmation, no system dialogs.
					if exe, err := os.Executable(); err == nil {
						c := exec.Command(exe)
						detachCmd(c)
						if c.Start() == nil {
							_ = c.Process.Release()
						}
					}
				case <-notif.ClickedCh:
					on := !notif.Checked()
					if on {
						notif.Check()
					} else {
						notif.Uncheck()
					}
					updateConfig(func(c *Config) { c.NotifyOthers = &on })
				case <-quit.ClickedCh:
					systray.Quit()
					return
				}
			}
		}()
		go loop()
	}, func() {
		_ = os.Remove(lockPath())
		os.Exit(0)
	})
}
