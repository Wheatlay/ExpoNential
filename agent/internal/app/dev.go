package app

import "os"

// devMode: EXPONENTIAL_DEV=1 marks a test build run on a developer machine. It shows "DEV" in the window and the
// tray tooltip, opens the WebView2 debug port (agent/tools/devwin.mjs drives the windows through it) and turns
// self-update off, so a test build is never replaced by the published release.
func devMode() bool { return os.Getenv("EXPONENTIAL_DEV") == "1" }

// devSetup runs first in Main: WebView2 reads its extra browser arguments from the environment of the process.
func devSetup() {
	if devMode() && os.Getenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") == "" {
		_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9333")
	}
}

// openAtStart: `start --open` (the Start menu shortcut when the agent was not running) opens the window.
var openAtStart bool

func devPrefix() string {
	if devMode() {
		return "DEV · "
	}
	return ""
}
