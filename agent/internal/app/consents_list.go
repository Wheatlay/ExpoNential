package app

import (
	"sort"
	"strconv"
	"time"
)

// consentRow is one active "Allow for 24 h" grant (config allowUntil) for the settings window.
type consentRow struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Until float64 `json:"until"` // ms since epoch
}

// activeConsents lists the grants that have not expired, soonest expiry first.
func activeConsents(cfg Config, now time.Time) []consentRow {
	rows := []consentRow{}
	ms := float64(now.UnixMilli())
	for id, until := range cfg.AllowUntil {
		if until <= ms {
			continue
		}
		name := cfg.AllowNames[id]
		if name == "" {
			name = "#" + id
		}
		rows = append(rows, consentRow{ID: id, Name: name, Until: until})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Until != rows[j].Until {
			return rows[i].Until < rows[j].Until
		}
		return rows[i].ID < rows[j].ID
	})
	return rows
}

// revokeConsent removes the grant of a requester from the config and saves it.
func revokeConsent(id string) {
	if _, err := strconv.Atoi(id); err != nil {
		return
	}
	updateConfig(func(c *Config) {
		delete(c.AllowUntil, id)
		delete(c.AllowNames, id)
	})
	logf("consent for requester %s revoked in the settings window", id)
}
