//go:build !windows

package app

import "os"

func ensureStartMenuLink(target string) {}
func removeStartMenuLink()              {}
func listenForOpen()                    {}

func cmdOpen() error {
	if agentPID() != 0 {
		return nil
	}
	self, _ := os.Executable()
	return startDetachedExe(self)
}
