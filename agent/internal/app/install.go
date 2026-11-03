package app

import (
	"fmt"
	"net/url"
	"os/exec"
	"strings"
)

// checkURL: https only (http allowed for localhost, 127.0.0.1 and [::1]).
func checkURL(u string) error {
	if !httpRe.MatchString(u) {
		return fmt.Errorf("the address must start with https://")
	}
	pu, err := url.Parse(u)
	if err != nil || pu.Host == "" {
		return fmt.Errorf("bad address %q", u)
	}
	h := pu.Hostname()
	if !strings.HasPrefix(strings.ToLower(u), "https://") && h != "localhost" && h != "127.0.0.1" && h != "::1" {
		return fmt.Errorf("login requires an https:// URL (http is allowed only for localhost, 127.0.0.1 and [::1])")
	}
	return nil
}

func startDetachedExe(path string) error {
	c := exec.Command(path, "start")
	detachCmd(c)
	if err := c.Start(); err != nil {
		return err
	}
	_ = c.Process.Release()
	return nil
}

// ensureRunning starts the agent hidden when no instance holds agent.lock.
func ensureRunning(path string) {
	if agentPID() == 0 {
		if err := startDetachedExe(path); err != nil {
			logf("could not start the agent: %s", err)
		}
	}
}

func hostOf(u string) string {
	if pu, err := url.Parse(u); err == nil && pu.Host != "" {
		return pu.Host
	}
	return u
}
