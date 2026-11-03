package app

import (
	"slices"
	"testing"
	"time"
)

func TestStopThenForgetOrder(t *testing.T) {
	var ev []string
	polls := 0
	got := stopThenForget(
		func() { ev = append(ev, "stop") },
		func() bool { polls++; ev = append(ev, "alive?"); return polls < 3 },
		func() bool { ev = append(ev, "forget"); return true },
		5*time.Second)
	if !got || ev[0] != "stop" || ev[len(ev)-1] != "forget" || slices.Index(ev, "forget") < slices.Index(ev, "alive?") || polls != 3 {
		t.Fatal(ev)
	}
}
