//go:build !windows

package app

// engineIcons: no icon extraction on this OS (the page shows placeholders).
func engineIcons(bin string) (engine, host string) { return "", "" }
