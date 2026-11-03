// Package plugin embeds the Claude plugin (../plugin of the repo). build.ps1 copies it to files/ before go build.
package plugin

import "embed"

//go:embed all:files
var FS embed.FS
