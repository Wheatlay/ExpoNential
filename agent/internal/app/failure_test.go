package app

import (
	"strings"
	"testing"
	"time"
)

const limitJSON = `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"api_error":"usage_limit_reached","result":"You've hit your 5-hour limit · resets 6pm (Europe/Warsaw)","usage":{"input_tokens":0}}`

func TestFailureJSONError(t *testing.T) {
	f := analyzeFailure([]byte(`{"type":"result","is_error":true,"result":"Something  broke\n badly"}`), []byte("noise"))
	if f.Reason != "Something broke badly" || f.Limit {
		t.Fatalf("%+v", f)
	}
}

func TestFailurePlainStderr(t *testing.T) {
	f := analyzeFailure(nil, []byte("\x1b[31mInvalid API key · Please run /login\x1b[0m\n\n"))
	if f.Reason != "Invalid API key · Please run /login" || f.Limit {
		t.Fatalf("%+v", f)
	}
	m := failMessage("claude", 1, f)
	if m != "claude exited with code 1: Invalid API key · Please run /login" {
		t.Fatal(m)
	}
	if len(failMessage("claude", 1, engineFailure{Reason: strings.Repeat("x", 500)})) > 303 {
		t.Fatal("not cut")
	}
}

func TestLimitDetection(t *testing.T) {
	f := analyzeFailure([]byte(limitJSON), nil)
	if !f.Limit || !strings.Contains(f.Reason, "5-hour limit") {
		t.Fatalf("%+v", f)
	}
	if f := analyzeFailure([]byte(`{"type":"result","is_error":true,"result":"x","api_error_status":429}`), nil); !f.Limit {
		t.Fatal("429")
	}
	if f := analyzeFailure([]byte(`{"type":"result","is_error":true,"result":"You've hit your weekly limit"}`), nil); !f.Limit {
		t.Fatal("text")
	}
}

func TestParseReset(t *testing.T) {
	loc, _ := time.LoadLocation("Europe/Warsaw")
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, loc)
	got := parseResetTime("You've hit your 5-hour limit · resets 6pm (Europe/Warsaw)", now)
	if !got.Equal(time.Date(2026, 11, 3, 18, 0, 0, 0, loc)) {
		t.Fatal(got)
	}
	got = parseResetTime("resets 18:30 (Europe/Warsaw)", now)
	if !got.Equal(time.Date(2026, 11, 3, 18, 30, 0, 0, loc)) {
		t.Fatal(got)
	}
	got = parseResetTime("resets 6am (Europe/Warsaw)", now) // already past today: tomorrow
	if !got.Equal(time.Date(2026, 11, 4, 6, 0, 0, 0, loc)) {
		t.Fatal(got)
	}
	if got = parseResetTime("limit reached, try later", now); !got.Equal(now.Add(60 * time.Minute)) {
		t.Fatal(got)
	}
}
