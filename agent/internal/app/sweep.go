package app

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// sweepWebviewTemp removes the WebView2 profile folders (%TEMP%\exponential-agent-webview-<pid>, ...-settings-<pid>,
// ...-toast-<pid>) that a crashed or killed process left behind. A folder whose pid still runs is kept.
func sweepWebviewTemp() {
	defer func() { _ = recover() }()
	dirs, _ := filepath.Glob(filepath.Join(os.TempDir(), "exponential-agent-webview-*"))
	for _, d := range dirs {
		name := filepath.Base(d)
		pid, err := strconv.Atoi(name[strings.LastIndex(name, "-")+1:])
		if err != nil || pid <= 0 || pid == os.Getpid() || pidAlive(pid) {
			continue
		}
		if os.RemoveAll(d) == nil {
			logf("removed leftover %s", name)
		}
	}
}
