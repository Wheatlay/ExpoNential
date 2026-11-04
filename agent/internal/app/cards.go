package app

import (
	"sync"
	"time"
)

// The cards of the toast window: pending consent prompts (the first one is active, the rest wait as one-line
// cards) and small info cards ("Analysis KEY for Name") that hide on their own.

type promptCard struct {
	Key         string
	Name        string
	RequesterID int
	IssueID     int
	RequestedAt string
	Added       time.Time
}

type infoCard struct {
	ID   int
	Key  string
	Name string
}

type cardQueue struct {
	mu      sync.Mutex
	prompts []promptCard
	infos   []infoCard
	nextID  int
}

var cards cardQueue

// cardsChanged is set by the toast window to redraw; no-op elsewhere.
var cardsChanged = func() {}

// AddPrompt appends a prompt; false when one for the same issue key is already there (no duplicates).
func (q *cardQueue) AddPrompt(p promptCard) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, x := range q.prompts {
		if x.Key == p.Key {
			return false
		}
	}
	if p.Added.IsZero() {
		p.Added = time.Now()
	}
	q.prompts = append(q.prompts, p)
	return true
}

func (q *cardQueue) Prompt(key string) (promptCard, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, x := range q.prompts {
		if x.Key == key {
			return x, true
		}
	}
	return promptCard{}, false
}

func (q *cardQueue) RemovePrompt(key string) (promptCard, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, x := range q.prompts {
		if x.Key == key {
			q.prompts = append(q.prompts[:i:i], q.prompts[i+1:]...)
			return x, true
		}
	}
	return promptCard{}, false
}

// SyncPrompts closes the prompts whose job is no longer offered (taken by another computer or cancelled).
func (q *cardQueue) SyncPrompts(live map[string]bool) []promptCard {
	q.mu.Lock()
	defer q.mu.Unlock()
	var gone, keep []promptCard
	for _, x := range q.prompts {
		if live[x.Key] {
			keep = append(keep, x)
		} else {
			gone = append(gone, x)
		}
	}
	q.prompts = keep
	return gone
}

func (q *cardQueue) ClearPrompts() {
	q.mu.Lock()
	q.prompts = nil
	q.mu.Unlock()
}

// Active is the prompt that shows buttons (the oldest).
func (q *cardQueue) Active() (promptCard, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.prompts) == 0 {
		return promptCard{}, false
	}
	return q.prompts[0], true
}

func (q *cardQueue) PendingCount() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.prompts)
}

// AddInfo adds an info card; one per issue key.
func (q *cardQueue) AddInfo(key, name string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, x := range q.infos {
		if x.Key == key {
			return false
		}
	}
	q.nextID++
	q.infos = append(q.infos, infoCard{ID: q.nextID, Key: key, Name: name})
	return true
}

func (q *cardQueue) RemoveInfo(id int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, x := range q.infos {
		if x.ID == id {
			q.infos = append(q.infos[:i:i], q.infos[i+1:]...)
			return
		}
	}
}

func (q *cardQueue) Snapshot() ([]promptCard, []infoCard) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]promptCard(nil), q.prompts...), append([]infoCard(nil), q.infos...)
}
