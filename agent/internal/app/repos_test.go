package app

import (
	"os"
	"path/filepath"
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

func gitT(t *testing.T, dir string, args ...string) {
	t.Helper()
	full := append([]string{"-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"}, args...)
	if out, err := gitRun(full, "", 0); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

func TestDefaultRefFallback(t *testing.T) {
	d := t.TempDir()
	gitT(t, d, "init", "-q")
	if r := defaultRef(d); r != "" {
		t.Errorf("no remote: want empty, got %q", r)
	}
}

func TestPersistentWorktree(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	repo := t.TempDir()
	gitT(t, repo, "init", "-q")
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("node_modules/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, repo, "add", ".gitignore")
	gitT(t, repo, "commit", "-q", "-m", "init")
	entry := RepoEntry{Path: repo, Source: "manual"}
	wt, _, err := prepareWorkdir("TST", entry, "claude", true)
	if err != nil {
		t.Fatal(err)
	}
	if wt == repo {
		t.Fatal("must not run in the owner's folder")
	}
	ign := filepath.Join(wt, "node_modules", "x.txt")
	junk := filepath.Join(wt, "junk.txt")
	_ = os.MkdirAll(filepath.Dir(ign), 0o755)
	_ = os.WriteFile(ign, []byte("x"), 0o644)
	_ = os.WriteFile(junk, []byte("x"), 0o644)
	wt2, _, err := prepareWorkdir("TST", entry, "claude", true)
	if err != nil {
		t.Fatal(err)
	}
	if wt2 != wt {
		t.Errorf("worktree not reused: %s vs %s", wt2, wt)
	}
	if _, err := os.Stat(ign); err != nil {
		t.Error("ignored file should survive")
	}
	if _, err := os.Stat(junk); err == nil {
		t.Error("untracked file should be removed")
	}
	own, _, _ := prepareWorkdir("TST", entry, "claude", false)
	if own != repo {
		t.Errorf("own request must run in place, got %s", own)
	}
}
