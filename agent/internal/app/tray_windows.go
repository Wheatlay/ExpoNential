//go:build windows

package app

import (
	"os"
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
		open := systray.AddMenuItem(tx("Otwórz Exponential", "Open Exponential"), "")
		systray.AddSeparator()
		notif := systray.AddMenuItemCheckbox(tx("Powiadomienia o analizach dla innych", "Notifications for analyses for others"), "", notifyOthersOn())
		quit := systray.AddMenuItem(tx("Zakończ agenta", "Quit agent"), "")
		trayMu.Lock()
		onStatus = func() { systray.SetTooltip(statusText(lang)) }
		trayMu.Unlock()
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					if u := loadConfig().URL; u != "" {
						openURL(u)
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
