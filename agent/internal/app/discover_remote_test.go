package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCodexProjectPaths(t *testing.T) {
	cfg := []byte(`model = "gpt-5"

[projects."C:\\Users\\krzys\\Desktop\\Umowy\\umowy_projekt"]
trust_level = "trusted"

[projects.'D:/dev/web']
trust_level = "trusted"

[mcp_servers.tracker]
url = "https://example.com/mcp"
`)
	got := codexProjectPaths(cfg)
	if len(got) != 2 {
		t.Fatalf("want 2 paths, got %v", got)
	}
	if filepath.Base(got[0]) != "umowy_projekt" || filepath.Base(got[1]) != "web" {
		t.Fatalf("unexpected paths %v", got)
	}
}

func TestHasRemoteReadsGitConfig(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	must(t, os.MkdirAll(filepath.Join(repo, ".git"), 0o755))
	must(t, os.WriteFile(filepath.Join(repo, ".git", "config"), []byte("[remote \"origin\"]\n\turl = https://github.com/contracthub-team/umowy_projekt.git\n"), 0o644))
	if !hasRemote(repo, "contracthub-team/umowy_projekt") {
		t.Fatal("expected the origin remote to match")
	}
	if hasRemote(repo, "someone/else") {
		t.Fatal("unexpected match for another repo")
	}

	// Worktree: .git is a file pointing to <repo>/.git/worktrees/wt, whose commondir leads back to the main config.
	wtGit := filepath.Join(repo, ".git", "worktrees", "wt")
	must(t, os.MkdirAll(wtGit, 0o755))
	must(t, os.WriteFile(filepath.Join(wtGit, "commondir"), []byte("../..\n"), 0o644))
	wt := filepath.Join(dir, "wt")
	must(t, os.MkdirAll(wt, 0o755))
	must(t, os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+wtGit+"\n"), 0o644))
	if !hasRemote(wt, "contracthub-team/umowy_projekt") {
		t.Fatal("expected the worktree to resolve to the main repo's remote")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
