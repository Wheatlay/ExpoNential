package app

import (
	"reflect"
	"strings"
	"testing"
)

func TestClaudeMcpArgs(t *testing.T) {
	got := claudeMcpAddArgs("https://x.example", "trk_abc")
	want := []string{"mcp", "add", "--transport", "http", "--scope", "user", "expo", "https://x.example/mcp", "--header", "Authorization: Bearer trk_abc"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%q", got)
	}
	if strings.Join(claudeMcpRemoveArgs(), " ") != "mcp remove expo --scope user" {
		t.Fatal("remove")
	}
	if len(claudePluginSteps("https://x.example")) != 5 {
		t.Fatal("plugin steps")
	}
}

func TestMcpConfigHas(t *testing.T) {
	if !mcpConfigHas([]byte(`{"mcpServers":{"expo":{"type":"http","url":"https://x.example/mcp"}}}`), "https://x.example") {
		t.Fatal("present")
	}
	if mcpConfigHas([]byte(`{"mcpServers":{"other":{}}}`), "https://x.example") || mcpConfigHas([]byte(`bad`), "https://x.example") {
		t.Fatal("absent")
	}
}

func TestStripEnvAndScrub(t *testing.T) {
	got := stripEnv([]string{"A=1", "claude_config_dir=x", "B=2"}, "CLAUDE_CONFIG_DIR")
	if len(got) != 2 {
		t.Fatal(got)
	}
	if scrub("Bearer trk_secret", "trk_secret") != "Bearer ***" {
		t.Fatal("scrub")
	}
	if !pluginListHas("expo@expo  enabled") || pluginListHas("nothing") {
		t.Fatal("list")
	}
}

func TestSameURLMarketplaces(t *testing.T) {
	known := []byte(`{"tracker":{"source":{"source":"url","url":"https://t.example/agent/marketplace.json"}},
		"expo":{"source":{"source":"url","url":"https://t.example/agent/marketplace.json"}},
		"other":{"source":{"source":"github","repo":"a/b"}}}`)
	got := sameURLMarketplaces(known, "https://t.example/agent/marketplace.json", "expo")
	if len(got) != 1 || got[0] != "tracker" {
		t.Fatalf("got %v, want [tracker]", got)
	}
	if got := sameURLMarketplaces([]byte("not json"), "x", "expo"); got != nil {
		t.Fatalf("bad json: got %v", got)
	}
}
