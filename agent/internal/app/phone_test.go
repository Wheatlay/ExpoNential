package app

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestReadinessFrom(t *testing.T) {
	data := []byte(`{"hasCompletedOnboarding": true, "projects": {
		"C:/Users/krzys/Desktop/2-Wydane/Exponential": {"hasTrustDialogAccepted": true},
		"C:/Users/krzys/Desktop/Other": {"hasTrustDialogAccepted": false}}}`)
	repos := map[string]string{
		"EXP": `c:\users\KRZYS\Desktop\2-Wydane\Exponential\`,
		"OTH": `C:\Users\krzys\Desktop\Other`,
		"NEW": `C:\x\y`,
	}
	on, ready, missing := readinessFrom(data, repos)
	if !on {
		t.Fatal("expected onboarded")
	}
	if !reflect.DeepEqual(ready, []string{"EXP"}) {
		t.Fatalf("ready = %v", ready)
	}
	if !reflect.DeepEqual(missing, []string{"NEW", "OTH"}) {
		t.Fatalf("missing = %v", missing)
	}
	on, ready, _ = readinessFrom([]byte(`{"projects":{}}`), repos)
	if on || len(ready) != 0 {
		t.Fatal("expected not onboarded and nothing ready")
	}
	on, _, _ = readinessFrom(nil, repos)
	if on {
		t.Fatal("empty data must not be onboarded")
	}
}

func TestChildEnv(t *testing.T) {
	base := []string{"PATH=x", "CLAUDECODE=1", "CLAUDE_CODE_CHILD_SESSION=1", "claude_code_entrypoint=cli", "CLAUDE_CONFIG_DIR=old", "HOME=h"}
	got := childEnv(base, `C:\acc\personal`)
	want := []string{"PATH=x", "HOME=h", `CLAUDE_CONFIG_DIR=C:\acc\personal`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	got = childEnv(base, "default")
	if !reflect.DeepEqual(got, []string{"PATH=x", "HOME=h"}) {
		t.Fatalf("default: got %v", got)
	}
	for _, e := range got {
		if strings.HasPrefix(e, "CLAUDE") {
			t.Fatalf("leaked %s", e)
		}
	}
}

func TestPhoneReadyKeysEmpty(t *testing.T) {
	if k := phoneReadyKeys(Config{Repos: map[string]RepoEntry{"A": {Path: t.TempDir()}}}); len(k) != 0 {
		t.Fatalf("no account: %v", k)
	}
	if k := phoneReadyKeys(Config{PhoneAccount: "default", Engine: "codex", Repos: map[string]RepoEntry{"A": {Path: t.TempDir()}}}); len(k) != 0 {
		t.Fatalf("codex: %v", k)
	}
}

func TestPhoneReadyKeysExcludesOff(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	data := `{"hasCompletedOnboarding": true, "projects": {"` + filepath.ToSlash(dir) + `": {"hasTrustDialogAccepted": true}}}`
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{PhoneAccount: "default", Repos: map[string]RepoEntry{"A": {Path: dir}}}
	if k := phoneReadyKeys(cfg); !reflect.DeepEqual(k, []string{"A"}) {
		t.Fatalf("on: %v", k)
	}
	cfg.PhoneOff = []string{"A"}
	if k := phoneReadyKeys(cfg); len(k) != 0 {
		t.Fatalf("off: %v", k)
	}
	cfg.PhoneOff = nil
	cfg.Repos["B"] = RepoEntry{Path: filepath.Join(dir, "nope")}
	got := phoneProjects(cfg)
	want := []phoneProject{{Key: "A", On: true, Ready: true}, {Key: "B", On: true, Missing: "folder"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("projects = %+v", got)
	}
}

func TestWithPhoneProject(t *testing.T) {
	got := withPhoneProject(nil, "B", false)
	got = withPhoneProject(got, "A", false)
	got = withPhoneProject(got, "A", false)
	if !reflect.DeepEqual(got, []string{"A", "B"}) {
		t.Fatalf("got %v", got)
	}
	got = withPhoneProject(got, "A", true)
	if !reflect.DeepEqual(got, []string{"B"}) {
		t.Fatalf("got %v", got)
	}
	if got = withPhoneProject(got, "B", true); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}
