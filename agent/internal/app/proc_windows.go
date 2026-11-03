//go:build windows

package app

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const createNoWindow = 0x08000000

var procAttachConsole = windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")

// hideCmd makes a child process start without any console window.
func hideCmd(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// detachCmd: hidden and independent of this process (own process group).
func detachCmd(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow | windows.CREATE_NEW_PROCESS_GROUP}
}

// engineCmd builds the engine command; .cmd/.bat go through cmd.exe with verbatim quoting.
func engineCmd(bin string, args []string) *exec.Cmd {
	lb := strings.ToLower(bin)
	if strings.HasSuffix(lb, ".cmd") || strings.HasSuffix(lb, ".bat") {
		q := func(s string) string { return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"` }
		parts := []string{q(bin)}
		for _, a := range args {
			parts = append(parts, q(a))
		}
		c := exec.Command("cmd.exe")
		c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow, CmdLine: `cmd.exe /d /s /c "` + strings.Join(parts, " ") + `"`}
		return c
	}
	c := exec.Command(bin, args...)
	hideCmd(c)
	return c
}

func pidAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err == windows.ERROR_ACCESS_DENIED
	}
	defer windows.CloseHandle(h)
	var code uint32
	if windows.GetExitCodeProcess(h, &code) != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE
}

// attachConsole attaches to the parent's console (we are a GUI-subsystem exe) and, when the standard handles are
// not already redirected (pipe/file), binds stdout/stderr to it so typed CLI commands print.
func attachConsole() bool {
	if r, _, _ := procAttachConsole.Call(^uintptr(0)); r == 0 { // ATTACH_PARENT_PROCESS
		return false
	}
	bind := func(std uint32, target **os.File) {
		h, err := windows.GetStdHandle(std)
		if err == nil && h != 0 && h != windows.InvalidHandle {
			if t, e := windows.GetFileType(h); e == nil && t != windows.FILE_TYPE_UNKNOWN {
				return
			}
		}
		name, _ := windows.UTF16PtrFromString("CONOUT$")
		nh, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
		if err == nil {
			*target = os.NewFile(uintptr(nh), "CONOUT$")
		}
	}
	bind(windows.STD_OUTPUT_HANDLE, &os.Stdout)
	bind(windows.STD_ERROR_HANDLE, &os.Stderr)
	return true
}

func openURLRaw(u string) {
	c := exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	detachCmd(c)
	if c.Start() == nil {
		_ = c.Process.Release()
	}
}

// procsByImage returns PIDs (excluding this process) whose executable path equals path.
func procsByImage(path string) []uint32 {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	var out []uint32
	self := uint32(os.Getpid())
	want := strings.ToLower(path)
	for err = windows.Process32First(snap, &pe); err == nil; err = windows.Process32Next(snap, &pe) {
		if pe.ProcessID == self || pe.ProcessID == 0 {
			continue
		}
		h, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pe.ProcessID)
		if e != nil {
			continue
		}
		buf := make([]uint16, 1024)
		n := uint32(len(buf))
		if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) == nil && strings.ToLower(windows.UTF16ToString(buf[:n])) == want {
			out = append(out, pe.ProcessID)
		}
		windows.CloseHandle(h)
	}
	return out
}

func killPID(pid uint32) {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return
	}
	_ = windows.TerminateProcess(h, 0)
	windows.CloseHandle(h)
}
