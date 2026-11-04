//go:build !windows

package app

import "errors"

func listenForDump() {}

func fireDump() error { return errors.New("dump is only supported on Windows") }
