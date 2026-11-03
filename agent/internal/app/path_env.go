package app

import "strings"

// pathHas: the ';'-separated PATH value already lists dir (case-insensitive, trailing slashes ignored).
func pathHas(path, dir string) bool {
	want := normPathEntry(dir)
	for _, p := range strings.Split(path, ";") {
		if p != "" && normPathEntry(p) == want {
			return true
		}
	}
	return false
}

func normPathEntry(p string) string {
	return strings.ToLower(strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(p), "/", `\`), `\`))
}

// pathWith returns path with dir appended once.
func pathWith(path, dir string) string {
	if pathHas(path, dir) {
		return path
	}
	if path == "" {
		return dir
	}
	return strings.TrimRight(path, ";") + ";" + dir
}

// pathWithout returns path without any entry equal to dir.
func pathWithout(path, dir string) string {
	want := normPathEntry(dir)
	var out []string
	for _, p := range strings.Split(path, ";") {
		if p == "" || normPathEntry(p) == want {
			continue
		}
		out = append(out, p)
	}
	return strings.Join(out, ";")
}
