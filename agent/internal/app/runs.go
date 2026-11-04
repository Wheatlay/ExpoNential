package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The last runs, kept locally in <dataDir>/runs.json for the "Analizy" tab of the settings window.

const runsKeep = 300 // enough for the 30-day usage summary

// Results of a run.
const (
	runOK       = "ok"
	runFail     = "fail"
	runLimit    = "limit"
	runDeclined = "declined"
	runMuted    = "muted"
)

type runRecord struct {
	Time     int64  `json:"time"` // ms since epoch (end of the run)
	Key      string `json:"key"`
	For      string `json:"for,omitempty"` // requester name when the run was for someone else
	Engine   string `json:"engine,omitempty"`
	Model    string `json:"model,omitempty"`
	Duration int64  `json:"durationMs,omitempty"`
	Tokens   int    `json:"tokens,omitempty"`
	Result   string `json:"result"`
	Reason   string `json:"reason,omitempty"`
	Account  string `json:"account,omitempty"` // Claude account folder name
}

var runsMu sync.Mutex

func runsPath() string { return filepath.Join(dataDir(), "runs.json") }

func readRuns() []runRecord {
	b, err := os.ReadFile(runsPath())
	if err != nil {
		return nil
	}
	var l []runRecord
	if json.Unmarshal(b, &l) != nil {
		return nil
	}
	return l
}

// loadRuns returns the stored runs, oldest first.
func loadRuns() []runRecord {
	runsMu.Lock()
	defer runsMu.Unlock()
	return readRuns()
}

// appendRun adds a run and keeps only the last runsKeep. Best effort: errors are only logged.
func appendRun(r runRecord) {
	defer func() { _ = recover() }()
	if r.Time == 0 {
		r.Time = time.Now().UnixMilli()
	}
	runsMu.Lock()
	defer runsMu.Unlock()
	l := append(readRuns(), r)
	if len(l) > runsKeep {
		l = append([]runRecord(nil), l[len(l)-runsKeep:]...)
	}
	b, err := json.Marshal(l)
	if err == nil {
		_ = os.MkdirAll(dataDir(), 0o755)
		tmp := runsPath() + ".tmp"
		if err = os.WriteFile(tmp, b, 0o600); err == nil {
			err = os.Rename(tmp, runsPath())
		}
	}
	if err != nil {
		logf("runs write failed: %v", err)
	}
}

// usageTokens is the number shown for a run: input plus output tokens (0 = not reported).
func usageTokens(u *runUsage) int {
	if u == nil {
		return 0
	}
	n := 0
	if u.InputTokens != nil {
		n += *u.InputTokens
	}
	if u.OutputTokens != nil {
		n += *u.OutputTokens
	}
	return n
}
