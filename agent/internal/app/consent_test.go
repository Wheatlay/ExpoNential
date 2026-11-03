package app

import (
	"testing"
	"time"
)

func TestNewRequester(t *testing.T) {
	if r := newRequester(nil, nil); r.ID != 0 {
		t.Fatal("nil")
	}
	at := "2026-11-03T10:00:00Z"
	r := newRequester(&struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	}{7, "Ala"}, &at)
	if r.ID != 7 || r.Name != "Ala" || r.RequestedAt != at {
		t.Fatalf("%+v", r)
	}
}

func TestAllow24h(t *testing.T) {
	now := time.Date(2026, 11, 3, 23, 0, 0, 0, time.UTC)
	cfg := Config{AllowUntil: map[string]float64{"7": allowUntilFor24h(now)}}
	if !allowedNow(cfg, 7, now.Add(23*time.Hour)) {
		t.Fatal("within 24 h")
	}
	if allowedNow(cfg, 7, now.Add(25*time.Hour)) {
		t.Fatal("after 24 h")
	}
	if allowedNow(cfg, 8, now) {
		t.Fatal("other requester")
	}
}
