//go:build windows

package app

func pickRepoFolder(title string) (string, error) { return pickFolder(0, title) }
