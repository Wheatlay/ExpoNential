package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // zone names such as Europe/Warsaw in "resets 6pm (Europe/Warsaw)" work without OS data
)

// tailBuf keeps the last n bytes written to it.
type tailBuf struct {
	mu sync.Mutex
	n  int
	b  []byte
}

func (t *tailBuf) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.n {
		t.b = append([]byte(nil), t.b[len(t.b)-t.n:]...)
	}
	return len(p), nil
}

func (t *tailBuf) Bytes() []byte {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]byte(nil), t.b...)
}

// engineFailure is what a non-zero exit of the engine told us.
type engineFailure struct {
	Reason string // short cleaned text, "" = nothing useful
	Limit  bool   // usage limit reached: not an analysis failure, the job goes back to the queue
	Raw    string // original result text (used to parse the reset time)
}

var (
	ansiRe     = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]|\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)")
	spaceRe    = regexp.MustCompile(`\s+`)
	limitTxtRe = regexp.MustCompile(`(?i)hit your .*limit`)
)

func cleanText(s string) string {
	s = ansiRe.ReplaceAllString(s, "")
	return strings.TrimSpace(spaceRe.ReplaceAllString(s, " "))
}

type claudeErrResult struct {
	Type           string `json:"type"`
	IsError        bool   `json:"is_error"`
	Result         string `json:"result"`
	APIError       any    `json:"api_error"`
	APIErrorStatus any    `json:"api_error_status"`
}

// findClaudeResult returns the final result object of `claude -p --output-format json` (object, array or JSON lines).
func findClaudeResult(out []byte) *claudeErrResult {
	out = bytes.TrimSpace(out)
	if len(out) == 0 {
		return nil
	}
	var one claudeErrResult
	if out[0] == '{' && json.Unmarshal(out, &one) == nil && (one.Type == "result" || one.IsError || one.Result != "") {
		return &one
	}
	if out[0] == '[' {
		var arr []claudeErrResult
		if json.Unmarshal(out, &arr) == nil {
			for i := len(arr) - 1; i >= 0; i-- {
				if arr[i].Type == "result" {
					return &arr[i]
				}
			}
		}
	}
	lines := bytes.Split(out, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		l := bytes.TrimSpace(lines[i])
		var r claudeErrResult
		if len(l) > 0 && l[0] == '{' && json.Unmarshal(l, &r) == nil && r.Type == "result" {
			return &r
		}
	}
	return nil
}

func lastLines(b []byte, max int) string {
	var keep []string
	lines := strings.Split(string(b), "\n")
	for i := len(lines) - 1; i >= 0 && len(keep) < max; i-- {
		l := cleanText(lines[i])
		if l == "" || l[0] == '{' || l[0] == '[' {
			continue
		}
		keep = append([]string{l}, keep...)
	}
	return strings.Join(keep, " ")
}

// analyzeFailure explains a failed run: the JSON error result when there is one, else the last lines of stderr/stdout.
func analyzeFailure(stdout, stderr []byte) engineFailure {
	var f engineFailure
	if r := findClaudeResult(stdout); r != nil {
		status := fmt.Sprint(r.APIErrorStatus)
		if r.IsError {
			f.Raw = r.Result
			f.Reason = cleanText(r.Result)
		}
		if fmt.Sprint(r.APIError) == "usage_limit_reached" || status == "429" || (r.IsError && limitTxtRe.MatchString(r.Result)) {
			f.Limit = true
			if f.Raw == "" {
				f.Raw = r.Result
			}
		}
		if f.Reason != "" {
			return f
		}
	}
	const tail = 4096
	cut4 := func(b []byte) []byte {
		if len(b) > tail {
			return b[len(b)-tail:]
		}
		return b
	}
	f.Reason = lastLines(cut4(stderr), 3)
	if f.Reason == "" {
		f.Reason = lastLines(cut4(stdout), 3)
	}
	if f.Raw == "" && limitTxtRe.MatchString(f.Reason) {
		f.Limit, f.Raw = true, f.Reason
	}
	return f
}

// failMessage: "claude exited with code N: <reason>", at most 300 characters.
func failMessage(engine string, code int, f engineFailure) string {
	m := fmt.Sprintf("%s exited with code %d", engine, code)
	if f.Reason != "" {
		m += ": " + f.Reason
	} else {
		m += " (details in log.txt)"
	}
	return cut(m, 300)
}

var resetRe = regexp.MustCompile(`(?i)resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?`)

// parseResetTime reads "resets 6pm (Europe/Warsaw)" / "resets 18:30"; unparseable = now + 60 min.
func parseResetTime(text string, now time.Time) time.Time {
	fallback := now.Add(60 * time.Minute)
	m := resetRe.FindStringSubmatch(text)
	if m == nil {
		return fallback
	}
	h, mi := 0, 0
	fmt.Sscan(m[1], &h)
	if m[2] != "" {
		fmt.Sscan(m[2], &mi)
	}
	ap := strings.ToLower(m[3])
	if ap != "" {
		if h < 1 || h > 12 {
			return fallback
		}
		h %= 12
		if ap == "pm" {
			h += 12
		}
	}
	if h > 23 || mi > 59 {
		return fallback
	}
	loc := time.Local
	if m[4] != "" {
		if l, err := time.LoadLocation(strings.TrimSpace(m[4])); err == nil {
			loc = l
		}
	}
	n := now.In(loc)
	t := time.Date(n.Year(), n.Month(), n.Day(), h, mi, 0, 0, loc)
	if !t.After(now) {
		t = t.AddDate(0, 0, 1)
	}
	return t
}

var toastedUntil time.Time

func limitText(lang string, until time.Time) string {
	hm := until.Local().Format("15:04")
	if lang == "pl" {
		return "Limit Claude do " + hm
	}
	return "Claude limit until " + hm
}

// pauseAnalyses stops taking analysis jobs until the reset time; one toast per pause.
func pauseAnalyses(until time.Time) {
	stateMu.Lock()
	first := time.Now().After(toastedUntil)
	if first {
		toastedUntil = until
	}
	stateMu.Unlock()
	time.AfterFunc(time.Until(until)+time.Second, notifyStatus)
	notifyStatus()
	if first {
		hm := until.Local().Format("15:04")
		if uiLang() == "pl" {
			notifyText("Limit Claude wyczerpany · analizy wrócą o " + hm)
		} else {
			notifyText("Claude usage limit reached · analyses resume at " + hm)
		}
	}
}
