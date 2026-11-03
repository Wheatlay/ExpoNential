//go:build !windows

package app

// protectSecret / unprotectSecret: at-rest encryption exists on Windows only (DPAPI); elsewhere plain text.
func protectSecret(s string) string { return s }

func unprotectSecret(s string) string { return s }
