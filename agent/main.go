// Exponential agent: polls Exponential for work and runs AI analyses on this computer.
// Built as a Windows GUI-subsystem exe (no console window); see build.ps1.
package main

import (
	_ "embed"
	"os"

	"exponential-agent/internal/app"
)

var version = "0.2.4"

//go:embed assets/exponential.ico
var icon []byte

func main() {
	if version != "" {
		app.Version = version
	}
	app.IconICO = icon
	app.Main(os.Args[1:])
}
