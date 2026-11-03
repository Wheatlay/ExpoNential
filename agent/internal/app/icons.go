package app

import (
	"path/filepath"
	"strings"
)

// hostExeCandidates lists where the editor that owns an engine binary keeps its exe (VS Code, Cursor), most likely first.
// bin is the engine path (…\.vscode\extensions\… or …\.cursor\extensions\…); other paths (PATH) give none.
func hostExeCandidates(bin, localAppData, pf, pf86 string) []string {
	l := strings.ToLower(filepath.ToSlash(bin))
	var subs []string
	switch {
	case strings.Contains(l, "/.vscode/extensions/"):
		subs = []string{"Microsoft VS Code/Code.exe"}
	case strings.Contains(l, "/.cursor/extensions/"):
		subs = []string{"cursor/Cursor.exe"}
	default:
		return nil
	}
	var out []string
	for _, sub := range subs {
		sub = filepath.FromSlash(sub)
		if localAppData != "" {
			out = append(out, filepath.Join(localAppData, "Programs", sub))
		}
		for _, root := range []string{pf, pf86} {
			if root != "" {
				out = append(out, filepath.Join(root, sub))
			}
		}
	}
	return out
}
