package app

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const help = `exponential-agent %s
  (no arguments)                      install / connect (double-click)
  login [--url URL] [--token TOKEN]   sign in (device flow when no token)
  start [--detach]                    run the poll loop (--detach: hidden, in the background)
  status                              show url, account, engine, repos, autostart
  engine claude|codex                 choose the AI engine
  repos | repos set <KEY> <path> | repos clone <KEY>
  hook <Event>                        Claude Code hook (reads JSON on stdin)
  autostart on|off                    start at Windows logon
  uninstall --yes                     remove autostart, the app entry and %s
`

func optArg(args []string, n string) string {
	for i, a := range args {
		if a == n && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func contains(args []string, n string) bool {
	for _, a := range args {
		if a == n {
			return true
		}
	}
	return false
}

func cmdLogin(args []string) error {
	u := optArg(args, "--url")
	if u == "" {
		u = os.Getenv("EXPONENTIAL_URL")
	}
	u = strings.TrimRight(u, "/")
	token := optArg(args, "--token")
	if !httpRe.MatchString(u) {
		return errors.New("usage: login --url https://your-tracker [--token trk_...]")
	}
	if err := checkURL(u); err != nil {
		return err
	}
	if token != "" { // trk_ tokens are long-lived, no refresh
		updateConfig(func(c *Config) { c.URL, c.Token, c.OAuth = u, token, nil })
		fmt.Printf("Logged in to %s with a token.\n", u)
		return nil
	}
	// OAuth device flow (RFC 8628) with dynamic client registration.
	reg, err := oauthPost(u, "/oauth/register", map[string]any{"client_name": "Exponential agent", "redirect_uris": []string{"http://127.0.0.1/cb"}}, true)
	if err != nil {
		return err
	}
	clientID := str(reg["client_id"])
	if clientID == "" {
		return fmt.Errorf("registration failed: %s", orDefault(str(reg["error"]), "no client_id"))
	}
	dev, err := oauthPost(u, "/oauth/device_authorization", map[string]any{"client_id": clientID}, false)
	if err != nil {
		return err
	}
	if str(dev["device_code"]) == "" {
		return fmt.Errorf("device authorization failed: %s", orDefault(str(dev["error"]), "no device_code"))
	}
	fmt.Printf("Your code: %s\n", str(dev["user_code"]))
	fmt.Printf("Type this code in the browser: %s\n", str(dev["verification_uri"]))
	openURL(str(dev["verification_uri"]))
	interval := num(dev["interval"])
	if interval == 0 {
		interval = 5
	}
	expIn := num(dev["expires_in"])
	if expIn == 0 {
		expIn = 600
	}
	deadline := time.Now().Add(time.Duration(expIn) * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(time.Duration(interval) * time.Second)
		r, err := oauthPost(u, "/oauth/token", map[string]any{"grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": str(dev["device_code"]), "client_id": clientID}, false)
		if err != nil {
			return err
		}
		if at := str(r["access_token"]); at != "" {
			exp := num(r["expires_in"])
			if exp == 0 {
				exp = 3600
			}
			updateConfig(func(c *Config) {
				c.URL, c.Token = u, ""
				c.OAuth = &OAuth{Access: at, Refresh: str(r["refresh_token"]), ExpiresAt: nowMs() + exp*1000, ClientID: clientID}
			})
			fmt.Printf("Logged in to %s.\n", u)
			return nil
		}
		switch str(r["error"]) {
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5
			continue
		}
		return fmt.Errorf("login failed: %s", orDefault(str(r["error"]), "unknown error"))
	}
	return errors.New("login timed out")
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func status() {
	cfg := loadConfig()
	fmt.Printf("version:   %s\n", Version)
	fmt.Printf("data dir:  %s\n", dataDir())
	fmt.Printf("url:       %s\n", orDefault(cfg.URL, "(not set, run: login)"))
	account := "(not logged in)"
	a, err := getAuth()
	if err != nil {
		account = "error: " + err.Error()
	} else if a != nil {
		var me struct {
			Name  string `json:"name"`
			Email string `json:"email"`
		}
		if err := request(a, "GET", "/api/me", nil, 10*time.Second, &me); err != nil {
			account = "error: " + err.Error()
		} else {
			account = strings.TrimSpace(me.Name + " " + func() string {
				if me.Email != "" {
					return "<" + me.Email + ">"
				}
				return ""
			}())
			if account == "" {
				account = "ok"
			}
		}
	}
	fmt.Printf("account:   %s\n", account)
	fmt.Printf("deviceId:  %s\n", orDefault(cfg.DeviceID, "(not generated yet)"))
	eng := orDefault(cfg.Engine, "claude")
	fmt.Printf("engine:    %s -> %s\n", eng, orDefault(findEngine(eng), "NOT FOUND"))
	if len(cfg.Repos) == 0 {
		fmt.Println("repos:     (none)")
	} else {
		fmt.Println("repos:     ")
	}
	for k, r := range cfg.Repos {
		fmt.Printf("  %s  %s  (%s)\n", k, r.Path, r.Source)
	}
	fmt.Printf("autostart: %s\n", autostartState())
}

// Main runs the command line; no arguments = the double-click install flow.
func Main(args []string) {
	hadConsole := attachConsole()
	if len(args) > 0 && args[0] == "hook" {
		ev := ""
		if len(args) > 1 {
			ev = args[1]
		}
		RunHook(ev)
		os.Exit(0)
	}
	if len(args) == 0 {
		runInstall()
		return
	}
	cmd, rest := args[0], args[1:]
	var err error
	switch cmd {
	case "login":
		err = cmdLogin(rest)
	case "start":
		if contains(rest, "--detach") {
			self, _ := os.Executable()
			if err = startDetachedExe(self); err == nil {
				fmt.Println("Agent started in the background.")
			}
		} else {
			cmdStart()
		}
	case "status":
		status()
	case "engine":
		e := ""
		if len(rest) > 0 {
			e = rest[0]
		}
		if e != "claude" && e != "codex" {
			fmt.Printf("engine: %s (usage: engine claude|codex)\n", orDefault(loadConfig().Engine, "claude"))
			break
		}
		bin := findEngine(e)
		if bin == "" {
			extra := ""
			if e == "claude" {
				extra = " or in the VS Code / Cursor extension"
			}
			err = fmt.Errorf("%s not found on PATH%s", e, extra)
			break
		}
		updateConfig(func(c *Config) { c.Engine = e })
		fmt.Printf("engine: %s (%s)\n", e, bin)
	case "repos":
		err = cmdRepos(rest)
	case "autostart":
		if len(rest) == 0 || (rest[0] != "on" && rest[0] != "off") {
			err = errors.New("usage: autostart on|off")
		} else if rest[0] == "on" {
			self, _ := os.Executable()
			if err = autostartOn(self); err == nil {
				fmt.Println("Autostart on.")
			}
		} else {
			autostartOff()
			fmt.Println("Autostart off.")
		}
	case "uninstall":
		if contains(rest, "--ask") {
			askUninstall()
			break
		}
		if !contains(rest, "--yes") {
			fmt.Printf("This removes autostart and deletes %s (config, token, logs, clones). Re-run with --yes.\n", dataDir())
			break
		}
		var forgot bool
		if forgot, err = uninstallAll(); err == nil {
			msg := "Exponential agent was removed."
			kind := uint32(dlgInfo)
			if !forgot {
				msg += "\n" + forgetFailedMsg(uiLang())
				kind = dlgError
			}
			if hadConsole {
				fmt.Println(msg)
			} else {
				msgBox(msg, kind)
			}
		}
	default:
		fmt.Printf(help, Version, dataDir())
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %s\n", err)
		os.Exit(1)
	}
}

// askUninstall: from the tray. The installer window shows this computer with Disconnect; when the window cannot open,
// a Yes/No question does the same, so uninstalling never depends on WebView2.
func askUninstall() {
	if runInstallerWindow() {
		return
	}
	pl := uiLang() == "pl"
	q := "Uninstall the Exponential agent from this computer?"
	if pl {
		q = "Odinstalować agenta Exponential z tego komputera?"
	}
	if msgBox(q, dlgAsk) != idYes {
		return
	}
	forgot, err := uninstallAll()
	msg, kind := "Exponential agent was removed.", uint32(dlgInfo)
	if pl {
		msg = "Agent Exponential został odinstalowany."
	}
	if err != nil {
		msg, kind = err.Error(), dlgError
	} else if !forgot {
		msg += "\n" + forgetFailedMsg(uiLang())
		kind = dlgError
	}
	msgBox(msg, kind)
}
