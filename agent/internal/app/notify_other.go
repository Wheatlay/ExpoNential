//go:build !windows

package app

func notifyOther(key, name string) {}

func notifyText(title string) {}
