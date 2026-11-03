package app

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const logMax = 1024 * 1024

func logFile() string { return filepath.Join(dataDir(), "log.txt") }

func logRaw(text string) {
	defer func() { _ = recover() }()
	_ = os.MkdirAll(dataDir(), 0o755)
	f := logFile()
	if st, err := os.Stat(f); err == nil && st.Size() > logMax {
		_ = os.Rename(f, filepath.Join(dataDir(), "log.old.txt"))
	}
	h, err := os.OpenFile(f, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer h.Close()
	_, _ = h.WriteString(text)
}

func isoNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func logf(format string, a ...any) {
	logRaw(fmt.Sprintf("%s agent: %s\n", isoNow(), fmt.Sprintf(format, a...)))
}
