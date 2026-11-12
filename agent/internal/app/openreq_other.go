//go:build !windows

package app

import "errors"

func openTerminalWithClaude(dir, prompt string) error {
	return errors.New("the terminal option is only supported on Windows")
}
