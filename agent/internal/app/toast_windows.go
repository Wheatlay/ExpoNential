//go:build windows

package app

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"

	webview2 "github.com/jchv/go-webview2"
)

//go:embed toast.html
var toastHTML string

const toastWidth = 356 // CSS px: the card (340) plus the 8 px stack padding

// The toast window: one borderless, always-on-top, non-activating window at the bottom right of the work area
// that holds the whole stack of cards and is clipped to them. It is created on first use and hidden when empty.
var toastW struct {
	mu     sync.Mutex
	w      webview2.WebView
	hwnd   uintptr
	sc     float64
	ready  bool
	failed bool
	start  bool
	ch     chan struct{}
}

func init() { cardsChanged = toastPush }

func promptSupported() bool { return true }

// showPromptWindow makes sure the window exists. false = it cannot be created (WebView2 missing).
func showPromptWindow() bool { return toastEnsure() }

func toastEnsure() bool {
	toastW.mu.Lock()
	if !toastW.start {
		toastW.start = true
		toastW.ch = make(chan struct{})
		go toastThread()
	}
	ch := toastW.ch
	toastW.mu.Unlock()
	select {
	case <-ch:
	case <-time.After(15 * time.Second):
		return false
	}
	toastW.mu.Lock()
	defer toastW.mu.Unlock()
	return !toastW.failed && toastW.ready
}

func toastThread() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	done := sync.OnceFunc(func() { close(toastW.ch) })
	fail := func() {
		toastW.mu.Lock()
		toastW.failed = true
		toastW.mu.Unlock()
		done()
	}
	defer func() {
		if r := recover(); r != nil {
			logf("toast window: %v", r)
			fail()
		}
	}()
	dataPath := filepath.Join(os.TempDir(), fmt.Sprintf("exponential-agent-webview-toast-%d", os.Getpid()))
	sc := dpiScale()
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  dataPath,
		AutoFocus: false,
		WindowOptions: webview2.WindowOptions{
			Title:  "Exponential",
			Width:  uint(float64(toastWidth) * sc),
			Height: uint(120 * sc),
			IconId: 1,
		},
	})
	if w == nil {
		fail()
		return
	}
	defer func() { w.Destroy(); _ = os.RemoveAll(dataPath) }()
	hwnd := uintptr(w.Window())
	popupStyle(hwnd, false, true)
	hideWindow(hwnd)
	toastW.mu.Lock()
	toastW.w, toastW.hwnd, toastW.sc = w, hwnd, sc
	toastW.mu.Unlock()

	_ = w.Bind("ready", func() {
		toastW.mu.Lock()
		toastW.ready = true
		toastW.mu.Unlock()
		done()
		toastPush()
	})
	_ = w.Bind("act", func(key, action string) { toastAct(key, action) })
	_ = w.Bind("report", func(h int, rects string) { toastReport(h, rects) })
	w.SetHtml(applyUI(toastHTML, currentTheme()))
	w.Run()
	toastW.mu.Lock()
	toastW.failed, toastW.ready, toastW.w = true, false, nil
	toastW.mu.Unlock()
	done()
}

// updateAct handles the buttons of the update card.
func updateAct(action string) {
	switch action {
	case "update", "retry":
		runUpdate()
		return
	case "dismiss":
		if v := updCard.Dismiss(); v != "" {
			updateConfig(func(c *Config) { c.UpdateDismissed = v })
		}
	case "update-done":
		updCard.Clear()
	}
	cardsChanged()
}

func toastAct(key, action string) {
	if key == "__update" {
		updateAct(action)
		return
	}
	switch action {
	case "open":
		if u := loadConfig().URL; u != "" {
			openURL(issueURL(u, key))
		}
	case "info-done":
		id, _ := strconv.Atoi(key)
		cards.RemoveInfo(id)
	default:
		resolvePrompt(key, action, time.Now())
	}
}

// toastReport runs on the window thread when the page reports its height and the card boxes (CSS px).
func toastReport(h int, rectsJSON string) {
	toastW.mu.Lock()
	hwnd, sc := toastW.hwnd, toastW.sc
	toastW.mu.Unlock()
	if hwnd == 0 {
		return
	}
	if h <= 0 {
		hideWindow(hwnd)
		return
	}
	var raw [][4]float64
	_ = json.Unmarshal([]byte(rectsJSON), &raw)
	px := func(v float64) int32 { return int32(v*sc + 0.5) }
	wa := workArea()
	ww, wh := px(toastWidth), px(float64(h))
	placeTopmost(hwnd, wa.Right-ww, wa.Bottom-wh, ww, wh, true)
	rects := make([][4]int32, 0, len(raw))
	for _, r := range raw {
		rects = append(rects, [4]int32{px(r[0]), px(r[1]), px(r[2]), px(r[3])})
	}
	clipToRects(hwnd, rects, px(12))
}

// toastPush sends the current cards to the page (from any goroutine).
func toastPush() {
	toastW.mu.Lock()
	w, ready := toastW.w, toastW.ready
	toastW.mu.Unlock()
	if w == nil || !ready {
		return
	}
	prompts, infos := cards.Snapshot()
	type pc struct {
		Key  string `json:"key"`
		Name string `json:"name"`
	}
	type ic struct {
		ID   int    `json:"id"`
		Key  string `json:"key"`
		Name string `json:"name"`
	}
	st := struct {
		Theme   string            `json:"theme"`
		L       map[string]string `json:"L"`
		Prompts []pc              `json:"prompts"`
		Infos   []ic              `json:"infos"`
		Update  *updateSnap       `json:"update"`
	}{Theme: currentTheme(), L: toastLabels(uiLang()), Prompts: []pc{}, Infos: []ic{}}
	if u := updCard.Snapshot(); u.Phase != updNone {
		st.Update = &u
	}
	for _, p := range prompts {
		st.Prompts = append(st.Prompts, pc{p.Key, p.Name})
	}
	for _, i := range infos {
		st.Infos = append(st.Infos, ic{i.ID, i.Key, i.Name})
	}
	b, _ := json.Marshal(st)
	w.Dispatch(func() { w.Eval("render(" + string(b) + ")") })
}
