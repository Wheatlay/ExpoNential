package app

import (
	"strings"
	"testing"
)

func TestIsSecretName(t *testing.T) {
	for _, n := range []string{".env", ".env.local", "a.PEM", "x.key", "id_ed25519", ".npmrc", ".git-credentials", ".credentials.json", "prod.tfvars", "credentials.json"} {
		if !isSecretName(n) {
			t.Errorf("%s should be secret", n)
		}
	}
	for _, n := range []string{"main.go", "README.md", "package.json"} {
		if isSecretName(n) {
			t.Errorf("%s should not be secret", n)
		}
	}
}

func TestDenyRules(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	r := denyRules()
	for _, want := range []string{"Bash", "Read(**/.npmrc)", "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.config/gh/**)", "Read(~/.claude/.credentials.json)"} {
		if !strings.Contains(r, want) {
			t.Errorf("missing %s in %s", want, r)
		}
	}
	d := ruleAbs(dataDir())
	for _, want := range []string{"Read(" + d + "/*.json)", "Grep(" + d + "/*.txt)", "Read(" + d + "/*.lock)"} {
		if !strings.Contains(r, want) {
			t.Errorf("missing %s in %s", want, r)
		}
	}
	// The analysis worktrees (worktrees/KEY), clones and temp worktrees live in the data dir: no blanket deny.
	if strings.Contains(r, d+"/**") {
		t.Errorf("data dir denied as a whole, worktrees unreadable: %s", r)
	}
}
