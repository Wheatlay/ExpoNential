package app

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"testing"
)

func TestNormPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		cases := map[string]string{
			"c:/Users/krzys/Desktop/2-Wydane/Exponential":   `C:\Users\krzys\Desktop\2-Wydane\Exponential`,
			`C:\Users\krzys\x\`:                             `C:\Users\krzys\x`,
			"file:///c%3A/Users/krzys/My%20Proj":            `C:\Users\krzys\My Proj`,
			"file:///d:/work/app":                           `D:\work\app`,
			"vscode-remote://ssh-remote%2Bhost/home/u/proj": "",
			"relative/path":                                 "",
			"":                                              "",
		}
		for in, want := range cases {
			if got := normPath(in); got != want {
				t.Errorf("normPath(%q) = %q, want %q", in, got, want)
			}
		}
	} else if got := normPath("file:///home/u/My%20Proj"); got != "/home/u/My Proj" {
		t.Errorf("got %q", got)
	}
	long := "/" + string(make([]byte, 0))
	for i := 0; i < 30; i++ {
		long += "abcdefghij/"
	}
	if runtime.GOOS == "windows" {
		long = "C:" + long
	}
	if normPath(long) != "" {
		t.Error("path over 260 chars must be skipped")
	}
}

func TestClaudeProjectPaths(t *testing.T) {
	data := []byte(`{"numStartups":3,"projects":{"C:/Users/krzys/Desktop/2-Wydane/Exponential":{"allowedTools":[]},"c:/users/krzys/desktop/2-Wydane/exponential":{},"/home/u/app":{}}}`)
	got := claudeProjectPaths(data)
	if runtime.GOOS == "windows" {
		if len(got) != 2 || len(uniquePaths(got)) != 1 {
			t.Errorf("got %v", got)
		}
	} else if len(got) == 0 {
		t.Errorf("got %v", got)
	}
	if claudeProjectPaths([]byte("not json")) != nil {
		t.Error("bad json must give nil")
	}
}

func TestVscodeStoragePaths(t *testing.T) {
	data := []byte(`{
	  "backupWorkspaces": {"folders": [{"folderUri": "file:///c%3A/Users/krzys/Desktop/A"}], "workspaces": [], "emptyWindows": []},
	  "profileAssociations": {"workspaces": {"file:///c%3A/Users/krzys/Desktop/B": "__default__profile__"}},
	  "windowsState": {
	    "lastActiveWindow": {"folder": "file:///c%3A/Users/krzys/Desktop/C"},
	    "openedWindows": [{"folder": "file:///c%3A/Users/krzys/Desktop/a"}]
	  }
	}`)
	got := vscodeStoragePaths(data)
	if len(got) != 4 {
		t.Fatalf("got %v", got)
	}
	if runtime.GOOS == "windows" {
		u := uniquePaths(got)
		sort.Strings(u)
		want := []string{`C:\Users\krzys\Desktop\A`, `C:\Users\krzys\Desktop\B`, `C:\Users\krzys\Desktop\C`}
		if !reflect.DeepEqual(u, want) {
			t.Errorf("got %v want %v", u, want)
		}
	}
}

func TestIsGitDir(t *testing.T) {
	d := t.TempDir()
	if isGitDir(d) {
		t.Error("plain folder is not git")
	}
	_ = os.WriteFile(filepath.Join(d, ".git"), []byte("gitdir: x"), 0o644) // worktree style
	if !isGitDir(d) {
		t.Error("folder with .git file is a worktree")
	}
}
