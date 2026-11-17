package app

import "testing"

// TEMP phone-announce: remove after agent 0.5
func TestShouldAnnouncePhone(t *testing.T) {
	ok := Config{Repos: map[string]RepoEntry{"A": {}}}
	if !shouldAnnouncePhone(ok, true, true) {
		t.Fatal("should show")
	}
	cases := map[string]func() (Config, bool, bool){
		"asked":     func() (Config, bool, bool) { c := ok; c.PhoneAsked = true; return c, true, true },
		"account":   func() (Config, bool, bool) { c := ok; c.PhoneAccount = "default"; return c, true, true },
		"codex":     func() (Config, bool, bool) { c := ok; c.Engine = "codex"; return c, true, true },
		"noaccs":    func() (Config, bool, bool) { return ok, false, true },
		"norepos":   func() (Config, bool, bool) { return Config{}, true, true },
		"nopromptw": func() (Config, bool, bool) { return ok, true, false },
	}
	for n, f := range cases {
		c, a, p := f()
		if shouldAnnouncePhone(c, a, p) {
			t.Errorf("%s: should not show", n)
		}
	}
}
