package app

import "testing"

func TestPluginInstalled(t *testing.T) {
	inst := []byte(`{"version":2,"plugins":{"tracker@tracker":[{"scope":"user"}]}}`)
	if !pluginInstalled(inst, nil) || !pluginInstalled(inst, []byte(`{"enabledPlugins":{"tracker@tracker":true}}`)) {
		t.Fatal("installed plugin not seen")
	}
	if pluginInstalled(inst, []byte(`{"enabledPlugins":{"tracker@tracker":false}}`)) {
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
