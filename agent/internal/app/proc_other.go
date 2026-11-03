//go:build !windows

package app

import (
	"os"
	"os/exec"
	"runtime"
	"syscall"
)

func hideCmd(c *exec.Cmd) {}

func detachCmd(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

func engineCmd(bin string, args []string) *exec.Cmd { return exec.Command(bin, args...) }

func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func attachConsole() bool { return false }

func openURLRaw(u string) {
	bin := "xdg-open"
	if runtime.GOOS == "darwin" {
		bin = "open"
	}
	c := exec.Command(bin, u)
	detachCmd(c)
	if c.Start() == nil {
		_ = c.Process.Release()
	}
}

func procsByImage(path string) []uint32 { return nil }

func killPID(pid uint32) {
	if p, err := os.FindProcess(int(pid)); err == nil {
		_ = p.Kill()
	}
}
