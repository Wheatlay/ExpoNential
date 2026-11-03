package app

import (
	"reflect"
	"testing"
	"time"
)

func TestOrderAccounts(t *testing.T) {
	got := orderAccounts("/h/.claude-accounts/b", []string{"/h/.claude-accounts/a", "/h/.claude-accounts/b"})
	want := []string{"/h/.claude-accounts/b", "/h/.claude-accounts/a", ""}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%q", got)
	}
	got = orderAccounts("", []string{"/x/a"})
	if !reflect.DeepEqual(got, []string{"", "/x/a"}) {
		t.Fatalf("%q", got)
	}
}

func TestNextAccount(t *testing.T) {
	now := time.Now()
	list := []string{"/a", "/b", ""}
	lim := map[string]time.Time{"/a": now.Add(time.Hour), "/b": now.Add(-time.Minute)}
	if a, ok := nextAccount(list, lim, nil, now); !ok || a != "/b" {
		t.Fatalf("%q %v", a, ok)
	}
	if a, ok := nextAccount(list, lim, map[string]bool{"/b": true}, now); !ok || a != "" {
		t.Fatalf("%q %v", a, ok)
	}
	lim[""] = now.Add(2 * time.Hour)
	lim["/b"] = now.Add(30 * time.Minute)
	if _, ok := nextAccount(list, lim, nil, now); ok {
		t.Fatal("all limited")
	}
	u, ok := earliestReset(list, lim, now)
	if !ok || !u.Equal(now.Add(30*time.Minute)) {
		t.Fatal(u, ok)
	}
	delete(lim, "")
	if _, ok := earliestReset(list, lim, now); ok {
		t.Fatal("one is free")
	}
}
