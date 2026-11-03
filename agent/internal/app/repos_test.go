package app

import (
	"testing"
	"time"
)

func TestUnsafePathAndRepoName(t *testing.T) {
	for _, p := range []string{`\\attacker\share\x`, `//attacker/share`, `\\?\C:\x`, `\\.\pipe\x`, `/\host\x`} {
		if unsafePath(p) == "" {
			t.Errorf("%s should be rejected", p)
		}
	}
	for _, r := range []string{"a/../../x", "a/b/c", "a", "../b", "a/b..c", "a b/c"} {
		if validGithubRepo(r) {
			t.Errorf("%s should be invalid", r)
		}
	}
	if !validGithubRepo("Wheatlay/ExpoNential") || !validGithubRepo("a.b/c_d-e") {
		t.Error("valid names rejected")
	}
}

func TestCutUTF16(t *testing.T) {
	if cut("ab\U0001F600cd", 3) != "ab" {
		t.Errorf("emoji must count as 2 units: %q", cut("ab\U0001F600cd", 3))
	}
	if cut("ab\U0001F600cd", 4) != "ab\U0001F600" || cut("żółw", 10) != "żółw" {
		t.Error("bad cut")
	}
}

func TestSkipParamCap(t *testing.T) {
	skippedMu.Lock()
	skippedIDs = map[int]time.Time{}
	skippedMu.Unlock()
	for i := 0; i < 200; i++ {
		skipID(100000 + i)
	}
	if got := skipParam(); len(got) == 0 || len(got) > skipMaxLen {
		t.Errorf("skip param length %d", len(got))
	}
}
