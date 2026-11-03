package app

import (
	"strings"
	"testing"
)

func TestCardQueue(t *testing.T) {
	var q cardQueue
	if !q.AddPrompt(promptCard{Key: "A-1", Name: "Ala"}) || !q.AddPrompt(promptCard{Key: "A-2", Name: "Ola"}) {
		t.Fatal("add")
	}
	if q.AddPrompt(promptCard{Key: "A-1", Name: "Ala"}) {
		t.Fatal("same key must not add a second card")
	}
	if a, _ := q.Active(); a.Key != "A-1" {
		t.Fatal("the oldest prompt is active")
	}
	// A-1 was taken by another computer: it disappears from the poll, its card closes, A-2 becomes active.
	gone := q.SyncPrompts(map[string]bool{"A-2": true, "A-9": true})
	if len(gone) != 1 || gone[0].Key != "A-1" {
		t.Fatalf("gone: %+v", gone)
	}
	if a, _ := q.Active(); a.Key != "A-2" || q.PendingCount() != 1 {
		t.Fatal("A-2 is active now")
	}
	if len(q.SyncPrompts(map[string]bool{"A-2": true})) != 0 {
		t.Fatal("nothing else to close")
	}
	if _, ok := q.RemovePrompt("A-2"); !ok {
		t.Fatal("remove")
	}
	if _, ok := q.Active(); ok {
		t.Fatal("empty")
	}
}

func TestInfoCards(t *testing.T) {
	var q cardQueue
	if !q.AddInfo("A-1", "Ala") || q.AddInfo("A-1", "Ala") {
		t.Fatal("one info card per key")
	}
	_, infos := q.Snapshot()
	q.RemoveInfo(infos[0].ID)
	if _, infos = q.Snapshot(); len(infos) != 0 {
		t.Fatal("removed")
	}
}

func TestApplyUI(t *testing.T) {
	out := applyUI(`<html data-theme="{{THEME}}"><style>/*{{CSS}}*/</style>`, "light")
	if out == "" || !strings.Contains(out, `data-theme="light"`) || !strings.Contains(out, "--bg-popover: #fff") || strings.Contains(out, "{{") {
		t.Fatal(out)
	}
	if !strings.Contains(applyUI("{{THEME}}", "weird"), "dark") {
		t.Fatal("unknown theme falls back to dark")
	}
}
