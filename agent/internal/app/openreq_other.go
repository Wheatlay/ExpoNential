//go:build !windows

package app

import "errors"

func openTerminalClaude(dir string, env []string, args []string, prompt string) error {
	return errors.New("the terminal option is only supported on Windows")
}

func openTerminalWithClaude(dir, prompt string) error {
	return errors.New("the terminal option is only supported on Windows")
}
