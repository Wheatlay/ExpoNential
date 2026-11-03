package app

import (
	"sort"
	"strconv"
	"sync"
	"time"
)

// Analyze jobs this agent declined or skipped: their issue ids go in `skip` of the next polls so the server offers
// the next job instead. Entries expire after skipTTL (the server omits skipped jobs, so their absence from the
// answer says nothing; expiry lets a job come back, e.g. after the user changes consent).
const skipTTL = 30 * time.Minute

var (
	skippedIDs = map[int]time.Time{}
	skippedMu  sync.Mutex
)

func skipJob(j *pollJob) {
	if j.ID == nil {
		return
	}
	skipID(int(*j.ID))
}

func skipID(id int) {
	if id <= 0 {
		return
	}
	skippedMu.Lock()
	if _, ok := skippedIDs[id]; !ok {
		skippedIDs[id] = time.Now()
	}
	skippedMu.Unlock()
}

// pruneSkipped drops expired entries.
func pruneSkipped() {
	skippedMu.Lock()
	defer skippedMu.Unlock()
	for id, at := range skippedIDs {
		if time.Since(at) > skipTTL {
			delete(skippedIDs, id)
		}
	}
}

// skipMaxLen: the server accepts at most 400 characters; stay below.
const skipMaxLen = 380

// skipParam: "12,15" (sorted, at most skipMaxLen characters) or "".
func skipParam() string {
	pruneSkipped()
	skippedMu.Lock()
	defer skippedMu.Unlock()
	ids := make([]int, 0, len(skippedIDs))
	for id := range skippedIDs {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	out := ""
	for _, id := range ids {
		next := strconv.Itoa(id)
		if out != "" {
			next = out + "," + next
		}
		if len(next) > skipMaxLen {
			break
		}
		out = next
	}
	return out
}
