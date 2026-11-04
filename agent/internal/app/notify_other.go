//go:build !windows

package app

func notifyOther(key, name string) {}

func notifyOwn(key, name string) {}

func notifyText(title string) {}
