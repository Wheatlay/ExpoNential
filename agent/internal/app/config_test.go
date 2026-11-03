package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// config.json as written by the TS agent 0.1.4 (plus a key this agent does not know).
const tsConfig = `{
  "url": "https://tracker.example.com",
  "oauth": {"access": "a1", "refresh": "r1", "expiresAt": 1790000000000, "clientId": "cid"},
  "deviceId": "11111111-2222-4333-8444-555555555555",
  "engine": "codex",
  "repos": {"ACME": {"path": "C:\\code\\acme", "source": "manual"}, "WEB": {"path": "C:\\x", "source": "hook"}},
  "version": "0.1.4",
  "futureKey": {"a": 1}
}`

func TestTSConfigCompat(t *testing.T) {
	c := parseConfig([]byte(tsConfig))
	if c.URL != "https://tracker.example.com" || c.OAuth == nil || c.OAuth.Refresh != "r1" || c.OAuth.ExpiresAt != 1790000000000 {
		t.Fatalf("bad parse: %+v", c)
	}
	if c.Engine != "codex" || c.Repos["ACME"].Path != `C:\code\acme` || c.Repos["WEB"].Source != "hook" {
		t.Fatalf("bad repos: %+v", c.Repos)
	}
	t.Setenv("LOCALAPPDATA", t.TempDir())
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dataDir(), "config.json")
	if err := os.WriteFile(file, []byte(tsConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	updateConfig(func(c *Config) { c.Token = "trk_x"; c.OAuth = nil })
	b, _ := os.ReadFile(file)
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["futureKey"]; !ok {
		t.Fatal("unknown key lost")
	}
	if _, ok := m["oauth"]; ok {
		t.Fatal("oauth should be removed")
	}
	if string(m["token"]) != `"trk_x"` || string(m["version"]) != `"`+Version+`"` || string(m["deviceId"]) != `"11111111-2222-4333-8444-555555555555"` {
		t.Fatalf("bad write: %s", b)
	}
}
