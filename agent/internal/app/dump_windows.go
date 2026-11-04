//go:build windows

package app

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"golang.org/x/sys/windows"
)

const dumpEventName = `Local\ExponentialAgentDump`

// listenForDump: on the named event the running agent writes the stacks of all goroutines to a file in the data
// folder (diagnosing a hung window without a debugger). `exponential-agent dump` fires the event.
func listenForDump() {
	name, _ := windows.UTF16PtrFromString(dumpEventName)
	h, err := windows.CreateEvent(nil, 0, 0, name)
	if h == 0 && err != nil {
		return
	}
	go func() {
		for {
			if ev, _ := windows.WaitForSingleObject(h, windows.INFINITE); ev != windows.WAIT_OBJECT_0 {
				return
			}
			buf := make([]byte, 4<<20)
			n := runtime.Stack(buf, true)
			p := filepath.Join(dataDir(), fmt.Sprintf("stack-%s.txt", time.Now().Format("20060102-150405")))
			if os.WriteFile(p, buf[:n], 0o600) == nil {
				logf("goroutine dump written: %s", p)
			}
		}
	}()
}

// fireDump signals a running agent to write its goroutine dump.
func fireDump() error {
	name, _ := windows.UTF16PtrFromString(dumpEventName)
	h, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, name)
	if err != nil {
		return fmt.Errorf("no running agent with dump support: %w", err)
	}
	defer windows.CloseHandle(h)
	return windows.SetEvent(h)
}
