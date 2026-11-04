package app

import "testing"

func TestPluginInstalled(t *testing.T) {
	inst := []byte(`{"version":2,"plugins":{"expo@expo":[{"scope":"user"}]}}`)
	if !pluginInstalled(inst, nil) || !pluginInstalled(inst, []byte(`{"enabledPlugins":{"expo@expo":true}}`)) {
		t.Fatal("installed plugin not seen")
	}
	if pluginInstalled(inst, []byte(`{"enabledPlugins":{"expo@expo":false}}`)) {
		t.Fatal("disabled plugin counted")
	}
	if pluginInstalled([]byte(`{"plugins":{"other@x":[]}}`), nil) || pluginInstalled([]byte(`bad`), nil) {
		t.Fatal("missing plugin counted")
	}
}

func TestCodexCursorTracker(t *testing.T) {
	if !codexHasTracker([]byte("model = \"x\"\n\n[mcp_servers.tracker]\nurl = \"https://x/mcp\"\n")) || codexHasTracker([]byte("[mcp_servers.other]\n")) {
		t.Fatal("codex")
	}
	if !cursorHasTracker([]byte(`{"mcpServers":{"tracker":{"url":"https://x/mcp"}}}`)) || cursorHasTracker([]byte(`{"mcpServers":{}}`)) {
		t.Fatal("cursor")
	}
}

func TestLegacyClaudeSetup(t *testing.T) {
	m, p := legacyClaudeSetup([]byte(`{"mcpServers":{"tracker":{}}}`), []byte(`{"plugins":{"tracker@tracker":[]}}`))
	if !m || !p {
		t.Fatal("legacy not seen")
	}
	m, p = legacyClaudeSetup([]byte(`{"mcpServers":{"expo":{}}}`), []byte(`{"plugins":{"expo@expo":[]}}`))
	if m || p {
		t.Fatal("new names counted as legacy")
	}
}
