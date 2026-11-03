//go:build windows

package app

import (
	"os"
	"strings"
	"time"

	"fyne.io/systray"
)

// runWithTray shows the tray icon and runs loop in a goroutine; it returns only when the agent is quit from the menu.
// The icon is best-effort: when it cannot be created the loop still runs.
// Left click on the icon opens the mini settings window (SetOnTapped); the menu opens on right click.
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
		systray.SetOnTapped(openSettings)
		cfg := loadConfig()
		settings := systray.AddMenuItem(tx("Ustawienia…", "Settings…"), "")
		systray.AddSeparator()
		who := strings.TrimSpace(cfg.UserName + " · " + hostOf(cfg.URL))
		head := systray.AddMenuItem(who, "")
		head.Disable()
		// State and version in the menu, not only in the icon tooltip.
		state := systray.AddMenuItem("", "")
		state.Disable()
		open := systray.AddMenuItem(tx("Otwórz Exponential", "Open Exponential"), "")
		aiSettings := systray.AddMenuItem(tx("Ustawienia AI", "AI settings"), "")
		systray.AddSeparator()
		teamHead := systray.AddMenuItem(tx("Zlecenia zespołu", "Team jobs"), "")
		teamHead.Disable()
		teamItems := map[string]*systray.MenuItem{
			teamAsk:  systray.AddMenuItemCheckbox(tx("Pytaj", "Ask"), "", false),
			teamAuto: systray.AddMenuItemCheckbox(tx("Bez pytania", "Don't ask"), "", false),
			teamOff:  systray.AddMenuItemCheckbox(tx("Nie biorę", "Don't take"), "", false),
		}
		mute := systray.AddMenuItem("", "")
		systray.AddSeparator()
		notif := systray.AddMenuItemCheckbox(tx("Powiadomienia o analizach dla innych", "Notifications for analyses for others"), "", false)
		auto := systray.AddMenuItemCheckbox(tx("Uruchamiaj z Windows", "Start with Windows"), "", false)
		systray.AddSeparator()
		upd := systray.AddMenuItem("", "")
		upd.Hide()
		uninstall := systray.AddMenuItem(tx("Odinstaluj…", "Uninstall…"), "")
		quit := systray.AddMenuItem(tx("Zakończ agenta", "Quit agent"), "")

		check := func(it *systray.MenuItem, on bool) {
			if on {
				it.Check()
			} else {
				it.Uncheck()
			}
		}
		dotShown := false
		// sync brings every item in line with config and live state (called after any change, also from the settings window).
		sync := func() {
			c := loadConfig()
			text, _ := statusParts(lang)
			systray.SetTooltip("Exponential · " + text)
			state.SetTitle(text + " · agent " + Version + updateSuffix(lang))
			until, muted := mutedUntilOf(c, time.Now())
			mute.SetTitle(muteItemTitle(lang, until, muted))
			mode := teamModeOf(c)
			for m, it := range teamItems {
				check(it, m == mode)
			}
			check(notif, notifyOthersOn())
			check(auto, strings.HasPrefix(autostartState(), "on"))
			trayMu.Lock()
			uv := updateVer
			trayMu.Unlock()
			if uv != "" {
				upd.SetTitle(tx("Zaktualizuj do ", "Update to ") + uv)
				upd.Show()
			} else {
				upd.Hide()
			}
			// the accent dot on the tray icon while a newer release exists
			if want := uv != ""; want != dotShown {
				if want {
					if d := iconDotICO(); len(d) > 0 {
						systray.SetIcon(d)
						dotShown = true
					}
				} else if len(IconICO) > 0 {
					systray.SetIcon(IconICO)
					dotShown = false
				}
			}
		}
		trayMu.Lock()
		onStatus = sync
		trayMu.Unlock()
		notifyStatus()
		go func() { // the mute ends by itself: refresh the labels now and then
			for range time.Tick(time.Minute) {
				notifyStatus()
			}
		}()
		go func() {
			for {
				select {
				case <-settings.ClickedCh:
					openSettings()
				case <-open.ClickedCh:
					openApp()
				case <-aiSettings.ClickedCh:
					openAISettings()
				case <-teamItems[teamAsk].ClickedCh:
					setTeamMode(teamAsk)
				case <-teamItems[teamAuto].ClickedCh:
					setTeamMode(teamAuto)
				case <-teamItems[teamOff].ClickedCh:
					setTeamMode(teamOff)
				case <-mute.ClickedCh:
					toggleMute()
				case <-auto.ClickedCh:
					setAutostart(!auto.Checked())
				case <-notif.ClickedCh:
					setNotifyOthers(!notif.Checked())
				case <-upd.ClickedCh:
					runUpdate()
				case <-uninstall.ClickedCh:
					launchUninstall()
				case <-quit.ClickedCh:
					systray.Quit()
					return
				}
			}
		}()
		go loop()
	}, func() {
		if !skipLockRemove.Load() {
			_ = os.Remove(lockPath())
		}
		os.Exit(0)
	})
}
