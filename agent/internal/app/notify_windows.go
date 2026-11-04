//go:build windows

package app

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"sync"

	toast "git.sr.ht/~jackmordaunt/go-toast/v2"
)

const toastAppID = "Exponential agent"

var toastOnce sync.Once
var toastIcon string

// iconPNG pulls the largest PNG image out of the embedded .ico and stores it for the toast.
func prepareToast() {
	toastOnce.Do(func() {
		if len(IconICO) > 22 {
			n := int(binary.LittleEndian.Uint16(IconICO[4:]))
			best, bo, bl := 0, 0, 0
			for i := 0; i < n && 6+16*(i+1) <= len(IconICO); i++ {
				e := IconICO[6+16*i:]
				w := int(e[0])
				if w == 0 {
					w = 256
				}
				if w > best {
					best, bl, bo = w, int(binary.LittleEndian.Uint32(e[8:])), int(binary.LittleEndian.Uint32(e[12:]))
				}
			}
			if bo > 0 && bo+bl <= len(IconICO) && bytes.HasPrefix(IconICO[bo:], []byte("\x89PNG")) {
				p := filepath.Join(dataDir(), "toast-icon.png")
				_ = os.MkdirAll(dataDir(), 0o755)
				if os.WriteFile(p, IconICO[bo:bo+bl], 0o644) == nil {
					toastIcon = p
				}
			}
		}
		// Registers the AppUserModelID (name + icon) under HKCU\Software\Classes\AppUserModelId.
		if err := toast.SetAppData(toast.AppData{AppID: toastAppID, GUID: "{7b1f3a52-6d0e-4c8b-9a2f-1e5d4c3b2a10}", IconPath: toastIcon}); err != nil {
			logf("toast setup: %s", err)
		}
	})
}

// notifyOther shows the small "Analysis KEY for Name" card (a Windows toast when the card window is unavailable).
// Nothing while muted or when the notification is switched off.
func notifyOther(key, name string) {
	if !notifyOthersOn() || isMuted() {
		return
	}
	showInfoCard(key, name)
}

// notifyOwn shows the same card for an own analysis (started from the phone or another browser), when switched on.
func notifyOwn(key, name string) {
	if !notifyOwnOn() || isMuted() {
		return
	}
	showInfoCard(key, name)
}

func showInfoCard(key, name string) {
	go func() {
		defer func() { _ = recover() }()
		if toastEnsure() {
			if cards.AddInfo(key, name) {
				toastPush()
			}
			return
		}
		prepareToast()
		title := name + " · analysis " + key
		if agentLang() == "pl" {
			title = name + " · analiza " + key
		}
		n := toast.Notification{AppID: toastAppID, Title: title, Icon: toastIcon}
		if err := n.Push(); err != nil {
			logf("toast: %s", err)
		}
	}()
}

// notifyText shows a plain toast.
func notifyText(title string) {
	go func() {
		defer func() { _ = recover() }()
		prepareToast()
		n := toast.Notification{AppID: toastAppID, Title: title, Icon: toastIcon}
		if err := n.Push(); err != nil {
			logf("toast: %s", err)
		}
	}()
}
