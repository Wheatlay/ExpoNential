package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

const releaseAPI = "https://api.github.com/repos/Wheatlay/ExpoNential/releases/latest"

var tagRe = regexp.MustCompile(`^agent-v(\d+\.\d+\.\d+)$`)

type releaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

type releaseInfo struct {
	Tag    string         `json:"tag_name"`
	Assets []releaseAsset `json:"assets"`
}

type updateInfo struct {
	Version, ExeURL, SumsURL string
}

// newerAgentVersion: "agent-v0.3.1" is newer than cur "0.3.0" -> "0.3.1".
func newerAgentVersion(tag, cur string) (string, bool) {
	m := tagRe.FindStringSubmatch(strings.TrimSpace(tag))
	if m == nil || verCmp(m[1], cur) <= 0 {
		return "", false
	}
	return m[1], true
}

// parseSHA256Sums finds the hash of name in `sha256sum` output ("<hex>  name" or "<hex> *name").
func parseSHA256Sums(text, name string) (string, bool) {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 || strings.TrimPrefix(f[1], "*") != name || len(f[0]) != 64 {
			continue
		}
		if _, err := hex.DecodeString(f[0]); err == nil {
			return strings.ToLower(f[0]), true
		}
	}
	return "", false
}

func ghGet(url string, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "exponential-agent")
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return res, nil
}

// checkUpdate asks GitHub for the latest release; nil = already current (or the latest is not an agent release).
func checkUpdate() (*updateInfo, error) {
	res, err := ghGet(releaseAPI, 20*time.Second)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var rel releaseInfo
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&rel); err != nil {
		return nil, err
	}
	v, ok := newerAgentVersion(rel.Tag, Version)
	if !ok {
		return nil, nil
	}
	u := &updateInfo{Version: v}
	for _, a := range rel.Assets {
		switch a.Name {
		case "exponential-agent.exe":
			u.ExeURL = a.URL
		case "SHA256SUMS":
			u.SumsURL = a.URL
		}
	}
	if u.ExeURL == "" || u.SumsURL == "" {
		return nil, errors.New("release without exe or SHA256SUMS")
	}
	return u, nil
}

var pendingUpdate atomic.Pointer[updateInfo]

// updateLoop: once at start, then every 24 h (Windows only).
func updateLoop() {
	if runtime.GOOS != "windows" {
		return
	}
	for {
		func() {
			defer func() { _ = recover() }()
			u, err := checkUpdate()
			if err != nil {
				logf("update check: %s", err)
				return
			}
			pendingUpdate.Store(u)
			trayMu.Lock()
			updateVer = ""
			if u != nil {
				updateVer = u.Version
			}
			trayMu.Unlock()
			notifyStatus()
			offerUpdateCard(u)
		}()
		time.Sleep(24 * time.Hour)
	}
}

func oldExePath(exe string) string { return strings.TrimSuffix(exe, ".exe") + ".old.exe" }

// cleanupOldExe removes the exe left by the previous update (the old process may still be exiting).
func cleanupOldExe() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	old := oldExePath(exe)
	for i := 0; i < 10; i++ {
		if _, err := os.Stat(old); err != nil || os.Remove(old) == nil {
			return
		}
		time.Sleep(time.Second)
	}
}

var updating atomic.Bool

// downloadUpdate fetches the exe next to the running one and verifies it against SHA256SUMS. Returns the temp path.
// progress gets the percentage (0-100, -1 = size unknown) whenever it changes; may be nil.
func downloadUpdate(u *updateInfo, dir string, progress func(pct int)) (string, error) {
	sres, err := ghGet(u.SumsURL, 30*time.Second)
	if err != nil {
		return "", fmt.Errorf("SHA256SUMS: %w", err)
	}
	sums, err := io.ReadAll(io.LimitReader(sres.Body, 64<<10))
	sres.Body.Close()
	if err != nil {
		return "", err
	}
	want, ok := parseSHA256Sums(string(sums), "exponential-agent.exe")
	if !ok {
		return "", errors.New("no hash for exponential-agent.exe in SHA256SUMS")
	}
	res, err := ghGet(u.ExeURL, 10*time.Minute)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	f, err := os.CreateTemp(dir, "exponential-agent-*.tmp")
	if err != nil {
		return "", err
	}
	h := sha256.New()
	pw := &progressWriter{total: res.ContentLength, fn: progress}
	if progress != nil && res.ContentLength <= 0 {
		progress(-1)
	}
	_, err = io.Copy(io.MultiWriter(f, h, pw), io.LimitReader(res.Body, 200<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		_ = os.Remove(f.Name())
		return "", errors.New("SHA256 mismatch")
	}
	return f.Name(), nil
}

// progressWriter reports the share of total written so far, once per percent.
type progressWriter struct {
	total, n int64
	last     int
	fn       func(pct int)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.n += int64(len(b))
	if p.fn != nil && p.total > 0 {
		pct := int(p.n * 100 / p.total)
		if pct > 100 {
			pct = 100
		}
		if pct != p.last {
			p.last = pct
			p.fn(pct)
		}
	}
	return len(b), nil
}

// swapExe: running exe -> exponential-agent.old.exe, new file -> exe. Undone when the second rename fails.
func swapExe(exe, newFile string) error {
	old := oldExePath(exe)
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(newFile, exe); err != nil {
		_ = os.Rename(old, exe)
		return err
	}
	return nil
}

// doUpdate downloads, verifies, swaps and restarts. On success it does not return (the process quits).
// onProgress and onInstalling may be nil.
func doUpdate(onProgress func(pct int), onInstalling func()) error {
	u := pendingUpdate.Load()
	if u == nil {
		return errors.New("no update")
	}
	if !updating.CompareAndSwap(false, true) {
		return errors.New("already updating")
	}
	defer updating.Store(false)
	if running.Load() {
		return errors.New("an analysis is running")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	tmp, err := downloadUpdate(u, filepath.Dir(exe), onProgress)
	if err != nil {
		return err
	}
	if onInstalling != nil {
		onInstalling()
	}
	if err := swapExe(exe, tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	updateConfig(func(c *Config) { c.UpdatedTo = u.Version }) // the new process shows "updated" once
	if err := restartAfterUpdate(exe); err != nil {
		updateConfig(func(c *Config) { c.UpdatedTo = "" })
		return err
	}
	return nil
}

var skipLockRemove atomic.Bool

// offerUpdateCard shows the update card for a found release (nil = none), unless it was dismissed for that version.
func offerUpdateCard(u *updateInfo) {
	if u == nil {
		if updCard.NoUpdate() {
			cardsChanged()
		}
		return
	}
	if loadConfig().UpdateDismissed == u.Version || !promptSupported() {
		return
	}
	if !showPromptWindow() {
		return
	}
	if updCard.Available(u.Version) {
		cardsChanged()
	}
}

// showUpdatedCard: the new process after a self-update shows "updated to X" once.
func showUpdatedCard() {
	to := loadConfig().UpdatedTo
	if to == "" {
		return
	}
	updateConfig(func(c *Config) { c.UpdatedTo = "" })
	if to != Version || !promptSupported() || !showPromptWindow() {
		return
	}
	updCard.Done(to)
	cardsChanged()
}

// startUpdate runs the update with the card showing the progress; the failure turns the card into "try again".
func startUpdate() {
	u := pendingUpdate.Load()
	if u == nil {
		return
	}
	if promptSupported() {
		showPromptWindow()
	}
	if !updCard.Start(u.Version) {
		return
	}
	cardsChanged()
	go func() {
		err := doUpdate(func(pct int) {
			if updCard.Progress(pct) {
				cardsChanged()
			}
		}, func() {
			if updCard.Installing() {
				cardsChanged()
			}
		})
		if err != nil {
			logf("update failed: %s", err)
			updCard.Fail()
			cardsChanged()
		}
	}()
}
