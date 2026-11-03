package app

import "testing"

func TestUpdateCardFlow(t *testing.T) {
	var c updateCardState
	if c.Snapshot().Phase != updNone || c.Progress(5) || c.Installing() || c.Fail() || c.Clear() {
		t.Fatal("idle card must not move")
	}
	if !c.Available("0.4.1") || c.Snapshot() != (updateSnap{updAvailable, "0.4.1", 0}) {
		t.Fatalf("%+v", c.Snapshot())
	}
	if !c.Start("0.4.1") || c.Start("0.4.1") {
		t.Fatal("start once")
	}
	if c.Available("0.4.2") {
		t.Fatal("a running update is not replaced")
	}
	if !c.Progress(42) || c.Progress(42) || c.Snapshot().Pct != 42 {
		t.Fatal("progress")
	}
	if !c.Progress(-1) || c.Snapshot().Pct != -1 {
		t.Fatal("unknown size")
	}
	if !c.Installing() || c.Snapshot().Phase != updInstalling || c.Progress(50) {
		t.Fatal("installing")
	}
	if !c.Fail() || c.Snapshot().Phase != updFailed {
		t.Fatal("fail")
	}
	if !c.Start("") || c.Snapshot().Phase != updDownloading || c.Snapshot().Version != "0.4.1" {
		t.Fatal("retry from failed")
	}
	c.Fail()
	if v := c.Dismiss(); v != "0.4.1" || c.Snapshot().Phase != updNone {
		t.Fatal("dismiss")
	}
	if c.Available("0.4.1") || !c.Available("0.4.2") {
		t.Fatal("dismissed only for that version")
	}
	if !c.NoUpdate() || c.Snapshot().Phase != updNone {
		t.Fatal("offer gone")
	}
	if c.Dismiss() != "" {
		t.Fatal("nothing to dismiss")
	}
	c.Done("0.4.2")
	if s := c.Snapshot(); s.Phase != updDone || s.Version != "0.4.2" {
		t.Fatal("done")
	}
	if !c.Clear() || c.Snapshot().Phase != updNone || c.Clear() {
		t.Fatal("clear")
	}
}
