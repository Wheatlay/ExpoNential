package app

import (
	"os"
	"regexp"
	"strings"
)

// The log view of the settings window: the last lines of log.txt with token values removed.

const logViewLines = 200

var (
	bearerRe = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=\-]+`)
	tokenRe  = regexp.MustCompile(`\b(exa|trk)_[A-Za-z0-9_\-]+`)
)

// scrubLog hides bearer values and exa_ / trk_ tokens.
func scrubLog(s string) string {
	s = bearerRe.ReplaceAllString(s, "${1}***")
	return tokenRe.ReplaceAllString(s, "${1}_***")
}

// tailLines keeps the last n lines of text.
func tailLines(text string, n int) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.TrimRight(text, "\n")
	if text == "" {
		return ""
	}
	l := strings.Split(text, "\n")
	if len(l) > n {
		l = l[len(l)-n:]
	}
	return strings.Join(l, "\n")
}

// logTail is the last logViewLines lines of log.txt, scrubbed ("" = no log).
func logTail() string {
	f, err := os.Open(logFile())
	if err != nil {
		return ""
	}
	defer f.Close()
	const win = 256 * 1024
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	off := int64(0)
	if st.Size() > win {
		off = st.Size() - win
	}
	buf := make([]byte, st.Size()-off)
	n, _ := f.ReadAt(buf, off)
	return scrubLog(tailLines(string(buf[:n]), logViewLines))
}
