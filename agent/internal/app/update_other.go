//go:build !windows

package app

import "errors"

func restartAfterUpdate(exe string) error { return errors.New("self-update is Windows only") }

func refreshAppVersion() {}
