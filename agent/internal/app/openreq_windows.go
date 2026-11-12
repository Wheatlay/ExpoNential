//go:build windows

package app

import (
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

// openTerminalWithClaude opens a new Windows Terminal (else a plain console) window in dir running `claude "<prompt>"`.
// The prompt goes through a temporary file read by PowerShell, so no character of it is ever parsed as a command.
func openTerminalWithClaude(dir, prompt string) error {
	return openTerminalClaude(dir, nil, nil, prompt)
}

// openTerminalClaude is openTerminalWithClaude with extra claude arguments (before the prompt), an optional
// prompt (empty = none) and an optional child environment (nil = inherit). With env set, the script also
// applies it inside PowerShell, because a running Windows Terminal may start the tab with its own environment.
func openTerminalClaude(dir string, env []string, args []string, prompt string) error {
	claude := findEngine("claude")
	if claude == "" {
		return errors.New("Claude Code not found")
	}
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	script := ""
	if env != nil {
		cfgDir := ""
		for _, e := range env {
			if strings.HasPrefix(strings.ToUpper(e), "CLAUDE_CONFIG_DIR=") {
				cfgDir = e[len("CLAUDE_CONFIG_DIR="):]
			}
		}
		script += "Get-ChildItem Env: | Where-Object { $_.Name -eq 'CLAUDECODE' -or $_.Name -like 'CLAUDE_CODE_*' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }; "
		if cfgDir != "" {
			script += "$env:CLAUDE_CONFIG_DIR = " + q(cfgDir) + "; "
		} else {
			script += "Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; "
		}
	}
	call := "& " + q(claude)
	for _, a := range args {
		call += " " + q(a)
	}
	if prompt != "" {
		pdir := filepath.Join(dataDir(), "open-prompts")
		if err := os.MkdirAll(pdir, 0o700); err != nil {
			return err
		}
		f := filepath.Join(pdir, "prompt-"+time.Now().Format("150405.000")+".txt")
		if err := os.WriteFile(f, []byte(prompt), 0o600); err != nil {
			return err
		}
		go func() { time.Sleep(2 * time.Minute); _ = os.Remove(f) }() // read at the start; this is only the safety net
		script += "$p = Get-Content -Raw -Encoding UTF8 -LiteralPath " + q(f) + "; Remove-Item -LiteralPath " + q(f) + " -ErrorAction SilentlyContinue; "
		call += " $p"
	}
	script += call
	u16 := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(u16)*2)
	for _, c := range u16 {
		b = append(b, byte(c), byte(c>>8))
	}
	enc := base64.StdEncoding.EncodeToString(b)
	psArgs := []string{"-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc}
	dir = filepath.Clean(dir)

	if wt, err := exec.LookPath("wt.exe"); err == nil {
		c := exec.Command(wt, append([]string{"-d", dir, "powershell.exe"}, psArgs...)...)
		if env != nil {
			c.Env = env
		}
		c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
		if c.Start() == nil {
			_ = c.Process.Release()
			return nil
		}
	}
	c := exec.Command("powershell.exe", psArgs...)
	c.Dir = dir
	if env != nil {
		c.Env = env
	}
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_CONSOLE}
	if err := c.Start(); err != nil {
		return err
	}
	_ = c.Process.Release()
	return nil
}
