package app

import (
	"strings"
	"testing"
	"time"
)

func TestMuteWindow(t *testing.T) {
	now := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	c := Config{MutedUntil: muteUntil24h(now)}
	if _, m := mutedUntilOf(c, now.Add(23*time.Hour)); !m {
		t.Fatal("muted within 24 h")
	}
	if _, m := mutedUntilOf(c, now.Add(25*time.Hour)); m {
		t.Fatal("mute over after 24 h")
	}
	if _, m := mutedUntilOf(Config{}, now); m {
		t.Fatal("never muted")
	}
	u, _ := mutedUntilOf(c, now)
	if !strings.HasPrefix(muteItemTitle("pl", u, true), "Wyłącz wyciszenie (do ") || muteItemTitle("pl", u, false) != "Wycisz na 24 h" {
		t.Fatal("mute item titles")
	}
	if !strings.HasPrefix(mutedText("pl", u), "wyciszone do ") {
		t.Fatal("state text")
	}
}

func TestTeamModeMigration(t *testing.T) {
	no, yes := false, true
	c := Config{AskOthers: &no}
	if teamModeOf(c) != teamAuto {
		t.Fatal("askOthers=false reads as auto")
	}
	if !migrateTeamMode(&c) || c.TeamMode != teamAuto || c.AskOthers != nil {
		t.Fatalf("%+v", c)
	}
	if migrateTeamMode(&c) {
		t.Fatal("second run changes nothing")
	}
	c = Config{AskOthers: &yes}
	migrateTeamMode(&c)
	if c.TeamMode != teamAsk {
		t.Fatal("askOthers=true is ask")
	}
	c = Config{AskOthers: &no, TeamMode: teamOff}
	migrateTeamMode(&c)
	if c.TeamMode != teamOff {
		t.Fatal("an existing mode wins over the legacy flag")
	}
	if teamModeOf(Config{}) != teamAsk || teamModeOf(Config{TeamMode: "bogus"}) != teamAsk {
		t.Fatal("default is ask")
	}
}

func TestAdoptServerTeamMode(t *testing.T) {
	now := time.Now()
	teamLocalAt.Store(0)
	if m, ok := adoptServerTeamMode(Config{TeamMode: teamAsk}, teamOff, now); !ok || m != teamOff {
		t.Fatal("server wins")
	}
	if _, ok := adoptServerTeamMode(Config{TeamMode: teamAsk}, "bogus", now); ok {
		t.Fatal("invalid ignored")
	}
	teamLocalAt.Store(now.UnixMilli())
	defer teamLocalAt.Store(0)
	if _, ok := adoptServerTeamMode(Config{TeamMode: teamAsk}, teamOff, now.Add(time.Second)); ok {
		t.Fatal("a stale answer must not undo a local change")
	}
}

func TestResolveTheme(t *testing.T) {
	cases := []struct {
		s     string
		light bool
		want  string
	}{
		{"dark", true, "dark"}, {"light", false, "light"}, {"system", true, "light"}, {"system", false, "dark"}, {"", true, "light"}, {"junk", false, "dark"},
	}
	for _, c := range cases {
		if got := resolveTheme(c.s, c.light); got != c.want {
			t.Errorf("%q light=%v: %s", c.s, c.light, got)
		}
	}
}

func TestDecideOther(t *testing.T) {
	now := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	other := requesterInfo{ID: 7, Name: "Ala", RequestedAt: "x"}
	own := requesterInfo{ID: 1}
	ask := Config{}
	if decideOther(ask, 1, other, now, false, false) != dPending {
		t.Fatal("ask mode: pending")
	}
	if decideOther(ask, 1, own, now, false, false) != dYes {
		t.Fatal("own job")
	}
	if decideOther(Config{TeamMode: teamAuto}, 1, other, now, false, false) != dYes {
		t.Fatal("auto")
	}
	if decideOther(Config{TeamMode: teamOff}, 1, other, now, false, false) != dNo {
		t.Fatal("off")
	}
	muted := Config{TeamMode: teamAuto, MutedUntil: muteUntil24h(now)}
	if decideOther(muted, 1, other, now, false, false) != dNo {
		t.Fatal("muted skips others even in auto")
	}
	if decideOther(muted, 1, own, now, false, false) != dYes {
		t.Fatal("muted still works on own jobs")
	}
	allowed := Config{AllowUntil: map[string]float64{"7": allowUntilFor24h(now)}}
	if decideOther(allowed, 1, other, now, false, false) != dYes {
		t.Fatal("allowed for 24 h")
	}
	if decideOther(ask, 1, other, now, false, true) != dNo {
		t.Fatal("declined")
	}
	if decideOther(ask, 1, other, now, true, false) != dYes {
		t.Fatal("just this once")
	}
	if decideOther(Config{TeamMode: teamAuto}, 0, other, now, false, false) == dYes {
		t.Fatal("unknown own id must not approve")
	}
	if decideOther(Config{TeamMode: teamAuto}, 1, requesterInfo{}, now, false, false) == dYes {
		t.Fatal("unknown requester must not approve")
	}
}
