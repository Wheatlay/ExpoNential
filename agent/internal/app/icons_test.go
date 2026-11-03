package app

import (
	"path/filepath"
	"testing"
)

func TestHostExeCandidates(t *testing.T) {
	j := filepath.Join
	la, pf, pf86 := j("C:", "Users", "u", "AppData", "Local"), j("C:", "Program Files"), j("C:", "Program Files (x86)")
	vs := j("C:", "Users", "u", ".vscode", "extensions", "anthropic.claude-code-2.0.0", "resources", "native-binary", "claude.exe")
	got := hostExeCandidates(vs, la, pf, pf86)
	want := []string{j(la, "Programs", "Microsoft VS Code", "Code.exe"), j(pf, "Microsoft VS Code", "Code.exe"), j(pf86, "Microsoft VS Code", "Code.exe")}
	if len(got) != len(want) {
		t.Fatalf("vscode: got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("vscode[%d]: got %q want %q", i, got[i], want[i])
		}
	}
	cu := j("C:", "Users", "u", ".cursor", "extensions", "x", "claude.exe")
	got = hostExeCandidates(cu, la, pf, pf86)
	if len(got) == 0 || got[0] != j(la, "Programs", "cursor", "Cursor.exe") {
		t.Errorf("cursor: got %v", got)
	}
	if got := hostExeCandidates(j("C:", "tools", "claude.exe"), la, pf, pf86); got != nil {
		t.Errorf("PATH binary should have no host, got %v", got)
	}
}
