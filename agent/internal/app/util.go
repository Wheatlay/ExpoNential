package app

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// gitRun runs git with an argument array (no shell). Returns trimmed stdout; the error carries stderr text.
func gitRun(args []string, cwd string, timeout time.Duration) (string, error) {
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	c := exec.CommandContext(ctx, "git", args...)
	hideCmd(c)
	c.Dir = cwd
	var out, errOut bytes.Buffer
	c.Stdout, c.Stderr = &out, &errOut
	if err := c.Run(); err != nil {
		m := strings.TrimSpace(errOut.String())
		if m == "" {
			m = err.Error()
		}
		if len(m) > 300 {
			m = m[:300]
		}
		return "", fmt.Errorf("%s", m)
	}
	return strings.TrimSpace(out.String()), nil
}

func gitSafe(args []string, cwd string, timeout time.Duration) string {
	s, _ := gitRun(args, cwd, timeout)
	return s
}

var httpRe = regexp.MustCompile(`(?i)^https?://`)

// openURL opens an http(s) URL with the default handler. Anything else is only printed.
func openURL(u string) {
	if !httpRe.MatchString(u) {
		fmt.Printf("Not opening a non-http(s) address, open it yourself if you trust it: %s\n", u)
		return
	}
	openURLRaw(u)
}

// whichBin: first match for a program name on PATH (on Windows .exe, then .cmd/.bat).
func whichBin(name string) string {
	exts := []string{""}
	if runtime.GOOS == "windows" {
		exts = []string{".exe", ".cmd", ".bat"}
	}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" {
			continue
		}
		for _, e := range exts {
			f := filepath.Join(dir, name+e)
			if _, err := os.Stat(f); err == nil {
				return f
			}
		}
	}
	return ""
}

func verCmp(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

var extRe = regexp.MustCompile(`^anthropic\.claude-code-(\d+(?:\.\d+)*)`)

// extensionClaude: newest bundled claude binary from the VS Code / Cursor extension.
func extensionClaude() string {
	home, _ := os.UserHomeDir()
	bestV, bestF := "", ""
	bin := "claude"
	if runtime.GOOS == "windows" {
		bin = "claude.exe"
	}
	for _, root := range []string{filepath.Join(home, ".vscode", "extensions"), filepath.Join(home, ".cursor", "extensions")} {
		ents, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range ents {
			m := extRe.FindStringSubmatch(e.Name())
			if m == nil {
				continue
			}
			f := filepath.Join(root, e.Name(), "resources", "native-binary", bin)
			if _, err := os.Stat(f); err == nil && (bestF == "" || verCmp(m[1], bestV) > 0) {
				bestV, bestF = m[1], f
			}
		}
	}
	return bestF
}

var (
	slugA = regexp.MustCompile(`(?i)^.*?github\.com[:/]`)
	slugB = regexp.MustCompile(`^[^:]+:`)
	slugC = regexp.MustCompile(`\.git$|/+$`)
)

// slug: "owner/name" (lowercase) from a git remote URL (https or ssh).
func slug(u string) string {
	u = slugA.ReplaceAllString(u, "")
	u = slugB.ReplaceAllString(u, "")
	u = slugC.ReplaceAllString(u, "")
	return strings.ToLower(u)
}
