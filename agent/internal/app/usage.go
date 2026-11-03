package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"
)

// runUsage is what the engine reported about a run (claude --output-format json). Nil fields = not reported.
type runUsage struct {
	InputTokens      *int     `json:"inputTokens,omitempty"`
	OutputTokens     *int     `json:"outputTokens,omitempty"`
	CacheReadTokens  *int     `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens *int     `json:"cacheWriteTokens,omitempty"`
	CostUSD          *float64 `json:"costUsd,omitempty"`
}

func (u *runUsage) empty() bool {
	return u == nil || (u.InputTokens == nil && u.OutputTokens == nil && u.CacheReadTokens == nil && u.CacheWriteTokens == nil && u.CostUSD == nil)
}

type claudeResult struct {
	Type         string   `json:"type"`
	TotalCostUSD *float64 `json:"total_cost_usd"`
	Usage        *struct {
		Input      *float64 `json:"input_tokens"`
		Output     *float64 `json:"output_tokens"`
		CacheRead  *float64 `json:"cache_read_input_tokens"`
		CacheWrite *float64 `json:"cache_creation_input_tokens"`
	} `json:"usage"`
}

func toInt(f *float64) *int {
	if f == nil || *f < 0 {
		return nil
	}
	n := int(*f + 0.5)
	return &n
}

func (r *claudeResult) usage() *runUsage {
	u := &runUsage{}
	if r.Usage != nil {
		u.InputTokens, u.OutputTokens = toInt(r.Usage.Input), toInt(r.Usage.Output)
		u.CacheReadTokens, u.CacheWriteTokens = toInt(r.Usage.CacheRead), toInt(r.Usage.CacheWrite)
	}
	if r.TotalCostUSD != nil && *r.TotalCostUSD >= 0 {
		u.CostUSD = r.TotalCostUSD
	}
	if u.empty() {
		return nil
	}
	return u
}

// parseClaudeUsage reads the final result of `claude -p --output-format json` from stdout. Defensive: the output may be
// one JSON object, a JSON array of events (the object with "type":"result" is used), or lines of JSON with noise around.
func parseClaudeUsage(out []byte) *runUsage {
	out = bytes.TrimSpace(out)
	if len(out) == 0 {
		return nil
	}
	var one claudeResult
	if out[0] == '{' && json.Unmarshal(out, &one) == nil && (one.Usage != nil || one.TotalCostUSD != nil) {
		return one.usage()
	}
	if out[0] == '[' {
		var arr []claudeResult
		if json.Unmarshal(out, &arr) == nil {
			for i := len(arr) - 1; i >= 0; i-- {
				if arr[i].Type == "result" {
					return arr[i].usage()
				}
			}
		}
	}
	lines := bytes.Split(out, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		l := bytes.TrimSpace(lines[i])
		var r claudeResult
		if len(l) > 0 && l[0] == '{' && json.Unmarshal(l, &r) == nil && (r.Type == "result" || r.Usage != nil || r.TotalCostUSD != nil) {
			return r.usage()
		}
	}
	return nil
}

// reportRun sends a finished run to the server; failures are only logged.
func reportRun(a *Auth, deviceID, key, kind, engine, model string, started time.Time, exit int, usage *runUsage) {
	defer func() { _ = recover() }()
	body := map[string]any{
		"deviceId": deviceID, "key": key, "kind": kind, "engine": engine, "model": model,
		"startedAt": started.UTC().Format("2006-01-02T15:04:05.000Z"), "durationMs": time.Since(started).Milliseconds(), "exitCode": exit,
	}
	if !usage.empty() {
		body["usage"] = usage
	}
	if err := request(a, "POST", "/api/agent/runs", body, 20*time.Second, nil); err != nil {
		logf("run report failed: %s", fmt.Sprint(err))
	}
}
