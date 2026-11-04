package app

import (
	"testing"
	"time"
)

func TestActiveConsents(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ms := float64(now.UnixMilli())
	cfg := Config{AllowUntil: map[string]float64{"7": ms + 5000, "3": ms + 1000, "9": ms - 1}, AllowNames: map[string]string{"3": "Ann"}}
	rows := activeConsents(cfg, now)
	if len(rows) != 2 || rows[0].ID != "3" || rows[0].Name != "Ann" || rows[1].Name != "#7" {
		t.Fatalf("%+v", rows)
	}
}

func TestOpenRequestHelpers(t *testing.T) {
	if normRepo("https://github.com/Wheatlay/Exponential.git") != "wheatlay/exponential" || normRepo("git@github.com:A/b.git") != "a/b" {
		t.Fatal("normRepo")
	}
	u := claudeOpenURI("vscode", "fix a&b")
	if u != "vscode://anthropic.claude-code/open?prompt=fix%20a%26b" {
		t.Fatal(u)
	}
	if c, s, _ := editorSpec("cursor"); c != "cursor" || s != "cursor" {
		t.Fatal("editor")
	}
	if c, _, _ := editorSpec("rm"); c != "" {
		t.Fatal("unknown editor accepted")
	}
}
