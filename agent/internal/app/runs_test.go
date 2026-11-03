package app

import (
	"fmt"
	"strings"
	"testing"
)

func TestRunsAppendTrim(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	if len(loadRuns()) != 0 {
		t.Fatal("empty at first")
	}
	for i := 1; i <= 25; i++ {
		appendRun(runRecord{Time: int64(i), Key: fmt.Sprintf("A-%d", i), Result: runOK})
	}
	l := loadRuns()
	if len(l) != runsKeep || l[0].Key != "A-6" || l[len(l)-1].Key != "A-25" {
		t.Fatalf("got %d runs, first %q last %q", len(l), l[0].Key, l[len(l)-1].Key)
	}
	appendRun(runRecord{Key: "A-26", Result: runFail, Reason: "boom", For: "Ola", Tokens: 1234})
	l = loadRuns()
	last := l[len(l)-1]
	if len(l) != runsKeep || l[0].Key != "A-7" || last.Reason != "boom" || last.For != "Ola" || last.Tokens != 1234 || last.Time == 0 {
		t.Fatalf("%+v", last)
	}
}

func TestUsageTokens(t *testing.T) {
	a, b := 100, 20
	if usageTokens(nil) != 0 || usageTokens(&runUsage{InputTokens: &a, OutputTokens: &b}) != 120 {
		t.Fatal("tokens")
	}
}

func TestScrubLog(t *testing.T) {
	in := "x Authorization: Bearer eyJhbGci.abc-def_1/2= y\nkey exa_AbC123-x_9 and trk_0123abcd\nbearer  secret2 ok"
	out := scrubLog(in)
	for _, bad := range []string{"eyJhbGci", "AbC123", "0123abcd", "secret2"} {
		if strings.Contains(out, bad) {
			t.Errorf("%q left in %q", bad, out)
		}
	}
	if !strings.Contains(out, "Bearer ***") || !strings.Contains(out, "exa_***") || !strings.Contains(out, "trk_***") || !strings.Contains(out, " ok") {
		t.Fatal(out)
	}
	if scrubLog("plain line") != "plain line" {
		t.Fatal("plain text must stay")
	}
}

func TestLastLines(t *testing.T) {
	var sb strings.Builder
	for i := 1; i <= 300; i++ {
		fmt.Fprintf(&sb, "line %d\r\n", i)
	}
	out := tailLines(sb.String(), logViewLines)
	l := strings.Split(out, "\n")
	if len(l) != 200 || l[0] != "line 101" || l[199] != "line 300" {
		t.Fatalf("%d %q %q", len(l), l[0], l[len(l)-1])
	}
	if tailLines("", 5) != "" {
		t.Fatal("empty")
	}
}

func TestLogTailScrubs(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	logRaw("one\n")
	logf("token trk_SECRET99 used")
	out := logTail()
	if !strings.Contains(out, "one") || strings.Contains(out, "SECRET99") || !strings.Contains(out, "trk_***") {
		t.Fatal(out)
	}
}
