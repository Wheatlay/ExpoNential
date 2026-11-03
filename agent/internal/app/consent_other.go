//go:build !windows

package app

// No prompt on this OS: analyses for others are allowed.
func promptSupported() bool  { return false }
func showPromptWindow() bool { return false }
func systemLight() bool      { return false }
