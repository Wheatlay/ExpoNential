package app

import "sync"

// The update card of the toast window: one card that goes available -> downloading -> installing (the agent
// restarts) or failed -> (retry) downloading; "done" is the short card shown by the new process.

type updPhase string

const (
	updNone        updPhase = ""
	updAvailable   updPhase = "available"
	updDownloading updPhase = "downloading"
	updInstalling  updPhase = "installing"
	updFailed      updPhase = "failed"
	updDone        updPhase = "done"
)

type updateSnap struct {
	Phase   updPhase `json:"phase"`
	Version string   `json:"version"`
	Pct     int      `json:"pct"` // -1 = size unknown
}

type updateCardState struct {
	mu        sync.Mutex
	phase     updPhase
	version   string
	pct       int
	dismissed string
}

var updCard updateCardState

func (c *updateCardState) Snapshot() updateSnap {
	c.mu.Lock()
	defer c.mu.Unlock()
	return updateSnap{c.phase, c.version, c.pct}
}

// Available shows the card for version v. false = not shown (dismissed, or an update is already running).
func (c *updateCardState) Available(v string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v == "" || v == c.dismissed {
		return false
	}
	switch c.phase {
	case updNone, updAvailable, updDone:
		c.phase, c.version, c.pct = updAvailable, v, 0
		return true
	}
	return false
}

// NoUpdate removes an offer that is gone (the card of a running update stays).
func (c *updateCardState) NoUpdate() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.phase == updAvailable {
		c.phase, c.version = updNone, ""
		return true
	}
	return false
}

// Dismiss hides the offer or the failure for this version; returns the dismissed version.
func (c *updateCardState) Dismiss() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.phase != updAvailable && c.phase != updFailed {
		return ""
	}
	v := c.version
	c.dismissed = v
	c.phase, c.version = updNone, ""
	return v
}

// Start moves to downloading from nothing, an offer or a failure. false = already running.
func (c *updateCardState) Start(v string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch c.phase {
	case updDownloading, updInstalling:
		return false
	}
	if v != "" {
		c.version = v
	}
	c.phase, c.pct = updDownloading, 0
	return true
}

// Progress sets the percentage (-1 = unknown); only while downloading.
func (c *updateCardState) Progress(pct int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.phase != updDownloading || pct == c.pct {
		return false
	}
	if pct > 100 {
		pct = 100
	}
	c.pct = pct
	return true
}

func (c *updateCardState) Installing() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.phase != updDownloading {
		return false
	}
	c.phase, c.pct = updInstalling, 100
	return true
}

func (c *updateCardState) Fail() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.phase != updDownloading && c.phase != updInstalling {
		return false
	}
	c.phase = updFailed
	return true
}

// Done shows "updated to v" (new process after the restart).
func (c *updateCardState) Done(v string) {
	c.mu.Lock()
	c.phase, c.version = updDone, v
	c.mu.Unlock()
}

// Clear hides the done card.
func (c *updateCardState) Clear() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.phase != updDone {
		return false
	}
	c.phase, c.version = updNone, ""
	return true
}
