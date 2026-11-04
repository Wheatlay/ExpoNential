//go:build windows

package app

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

const (
	runKey       = `Software\Microsoft\Windows\CurrentVersion\Run`
	uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\ExponentialAgent`
	runName      = "ExponentialAgent"
)

func installedPath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		h, _ := os.UserHomeDir()
		base = filepath.Join(h, "AppData", "Local")
	}
	return filepath.Join(base, "Programs", "Exponential", "exponential-agent.exe")
}

// stopAgent stops the running agent: processes started from path, and the pid in agent.lock.
func stopAgent(path string) {
	for _, p := range procsByImage(path) {
		killPID(p)
	}
	if pid := agentPID(); pid != 0 {
		killPID(uint32(pid))
	}
	time.Sleep(700 * time.Millisecond)
	_ = os.Remove(lockPath())
}

func sameContent(a, b string, limitA int64) bool {
	fa, err := os.Open(a)
	if err != nil {
		return false
	}
	defer fa.Close()
	fb, err := os.Open(b)
	if err != nil {
		return false
	}
	defer fb.Close()
	sb, _ := fb.Stat()
	if sb.Size() != limitA {
		return false
	}
	ra, rb := io.LimitReader(fa, limitA), fb
	ba, bb := make([]byte, 1<<20), make([]byte, 1<<20)
	for {
		na, ea := io.ReadFull(ra, ba)
		nb, _ := io.ReadFull(rb, bb)
		if na != nb || !bytes.Equal(ba[:na], bb[:nb]) {
			return false
		}
		if ea != nil {
			return true
		}
	}
}

// installApp copies the exe (without the config trailer) to the install folder, registers it in Apps & features
// and in autostart. Returns the installed path.
func installApp(self string, trailerSize int64) (string, error) {
	target := installedPath()
	if !strings.EqualFold(self, target) {
		st, err := os.Stat(self)
		if err != nil {
			return "", err
		}
		want := st.Size() - trailerSize
		if !sameContent(self, target, want) {
			stopAgent(target)
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return "", err
			}
			tmp := target + ".new"
			src, err := os.Open(self)
			if err != nil {
				return "", err
			}
			dst, err := os.Create(tmp)
			if err != nil {
				src.Close()
				return "", err
			}
			_, err = io.Copy(dst, io.LimitReader(src, want))
			src.Close()
			if cerr := dst.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				_ = os.Remove(tmp)
				return "", err
			}
			var rerr error
			for i := 0; i < 15; i++ {
				if rerr = os.Rename(tmp, target); rerr == nil {
					break
				}
				time.Sleep(300 * time.Millisecond)
			}
			if rerr != nil {
				_ = os.Remove(tmp)
				return "", fmt.Errorf("cannot replace %s: %w", target, rerr)
			}
		}
	}
	if err := registerApp(target); err != nil {
		return "", err
	}
	return target, nil
}

func registerApp(target string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	var kb uint32
	if st, err := os.Stat(target); err == nil {
		kb = uint32(st.Size() / 1024)
	}
	for name, v := range map[string]string{
		"DisplayName": "Exponential agent", "DisplayVersion": Version, "Publisher": "Exponential",
		"InstallLocation": filepath.Dir(target), "DisplayIcon": target,
		"UninstallString": `"` + target + `" uninstall --yes`,
	} {
		if err := k.SetStringValue(name, v); err != nil {
			return err
		}
	}
	for name, v := range map[string]uint32{"NoModify": 1, "NoRepair": 1, "EstimatedSize": kb} {
		if err := k.SetDWordValue(name, v); err != nil {
			return err
		}
	}
	_ = os.Remove(filepath.Join(dataDir(), "start-hidden.vbs"))
	dir := filepath.Dir(target)
	userPathEdit(func(p string) string { return pathWith(p, dir) }) // so `exponential-agent hook ...` resolves
	ensureStartMenuLink(target)
	return autostartOn(target)
}

// userPathEdit rewrites HKCU\Environment\Path (REG_EXPAND_SZ) with f and tells running programs about it.
func userPathEdit(f func(string) string) {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Environment`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	cur, _, _ := k.GetStringValue("Path") // unexpanded for REG_EXPAND_SZ
	next := f(cur)
	if next == cur {
		return
	}
	if err := k.SetExpandStringValue("Path", next); err != nil {
		return
	}
	env, _ := syscall.UTF16PtrFromString("Environment")
	var res uintptr
	// WM_SETTINGCHANGE = 0x1A, HWND_BROADCAST = 0xFFFF, SMTO_ABORTIFHUNG = 2
	_, _, _ = user32.NewProc("SendMessageTimeoutW").Call(0xFFFF, 0x1A, 0, uintptr(unsafe.Pointer(env)), 2, 2000, uintptr(unsafe.Pointer(&res)))
}

func autostartOn(exe string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(runName, `"`+exe+`" start`)
}

func autostartOff() {
	if k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE); err == nil {
		_ = k.DeleteValue(runName)
		k.Close()
	}
	_ = os.Remove(filepath.Join(dataDir(), "start-hidden.vbs"))
}

func autostartState() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return "off"
	}
	defer k.Close()
	v, _, err := k.GetStringValue(runName)
	if err != nil {
		return "off"
	}
	return "on (" + v + ")"
}

// uninstallAll stops the agent, removes autostart, the Apps & features entry and the data folder, and schedules
// the deletion of the installed exe (it may be the running one).
// machineID: Windows' own per-installation id (HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid).
func machineID() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue("MachineGuid")
	if err != nil {
		return ""
	}
	return v
}

func uninstallAll() (bool, error) {
	target := installedPath()
	forgot := stopAndForget(target) // stop first: a running agent would re-create the device with its next poll
	autostartOff()
	removeStartMenuLink()
	userPathEdit(func(p string) string { return pathWithout(p, filepath.Dir(target)) })
	_ = registry.DeleteKey(registry.CURRENT_USER, uninstallKey)
	_ = registry.DeleteKey(registry.CURRENT_USER, `Software\Classes\AppUserModelId\Exponential agent`)
	if err := os.RemoveAll(dataDir()); err != nil {
		return forgot, err
	}
	if _, err := os.Stat(target); err == nil {
		dir := filepath.Dir(target)
		c := exec.Command("cmd.exe")
		c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow,
			CmdLine: fmt.Sprintf(`cmd.exe /d /c ping -n 2 127.0.0.1 >nul & del /f /q "%s" & rmdir "%s"`, target, dir)}
		if err := c.Start(); err != nil {
			return forgot, errors.New("could not schedule the removal of " + target)
		}
		_ = c.Process.Release()
	}
	return forgot, nil
}
