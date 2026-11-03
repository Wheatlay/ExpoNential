package app

import (
	"sort"
	"strconv"
	"strings"
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
	skippedMu.Lock()
	if _, ok := skippedIDs[int(*j.ID)]; !ok {
		skippedIDs[int(*j.ID)] = time.Now()
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

// skipParam: "12,15" (sorted, at most 50) or "".
func skipParam() string {
	pruneSkipped()
	skippedMu.Lock()
	defer skippedMu.Unlock()
	ids := make([]int, 0, len(skippedIDs))
	for id := range skippedIDs {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	if len(ids) > 50 {
		ids = ids[:50]
	}
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.Itoa(id)
	}
	return strings.Join(parts, ",")
}
