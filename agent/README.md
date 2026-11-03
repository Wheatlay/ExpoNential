# Exponential agent

Local agent: polls Exponential for work and runs AI analyses (Claude Code or Codex) on this computer. A small Go program (about 7 MB), a Windows GUI-subsystem exe: no console window ever appears. It replaces `scripts/local-agent/*.ps1` and the earlier Node version (0.1.x).

## Install (user)

Download the agent from Exponential > Settings > AI and double-click it. The server appends your one-time pairing to the downloaded exe. The agent opens one branded window (WebView2, dark Exponential colors, Polish when the Windows UI language is Polish, else English; no system dialogs, no console) showing the account and server, with a "Start with Windows" checkbox (on by default). After "Connect and install" it shows progress (connected, copied, starting, waiting until the server sees the agent, up to 20 s) and then "Done". It copies itself to `%LOCALAPPDATA%\Programs\Exponential\exponential-agent.exe`, registers itself in Settings > Apps (Apps & features), turns on autostart (unless unchecked) and starts hidden. Double-clicking again shows the account with "running / not running", makes sure the agent runs, and offers "Disconnect" (uninstall). Errors (expired link, no pairing in the file, network or server error) show in the same window with "Open Exponential". If the WebView2 runtime is missing (it ships with Windows 10/11), the old message boxes are used instead.

Remove: Settings > Apps > Exponential agent (runs `exponential-agent.exe uninstall --yes`).

## Tray icon and app icon

The background agent (`start`) shows a tray icon (brand mark). Tooltip: "Exponential · ready", "Exponential · analyzing KEY-N…" during an analysis, "Exponential · no connection" after 3 failed polls (Polish texts on a Polish Windows). Menu: account and server (disabled), "Open Exponential", "Quit agent" (stops the process; autostart stays). The exe carries the icon and version info (company Exponential, product Exponential agent), so Explorer, the taskbar, Apps & features and SmartScreen show them. Non-Windows builds have no window or tray.

## Building

Go 1.27 (`winget install GoLang.Go`).

```
cd agent
./build.ps1 [-Version 0.2.4]    # plugin copy, icon (tools/mkicon, only if assets/exponential.ico is missing), go-winres (icon + version info, winres/winres.template.json), builds dist/exponential-agent.exe
go vet ./...
go test ./...
```

Libraries: github.com/jchv/go-webview2 (installer window), fyne.io/systray (tray), golang.org/x/image (icon generator), github.com/tc-hib/go-winres v0.3.3 (via `go run`, resources; generates git-ignored `winres/winres.json` and `rsrc_windows_amd64.syso`). Regenerate the icon with `go run ./tools/mkicon assets/exponential.ico`.

Release: push a tag `agent-vX.Y.Z`; `.github/workflows/agent-release.yml` builds the exe and publishes it with `SHA256SUMS`. Non-Windows builds compile (`GOOS=linux go vet ./...`) but only print for dialogs and autostart (TODO).

## Commands

Typed in a terminal (the exe attaches to the parent console, so output appears). With no arguments it is the install flow above.

| Command | What it does |
|---|---|
| `login --url URL [--token trk_...]` | Stores a long-lived token, or (no `--token`) runs the OAuth device flow in the browser |
| `start [--detach]` | Poll loop (single instance, log rotated at 1 MB); `--detach` starts it hidden in the background |
| `status` | URL, account, device id, engine, repos, autostart |
| `engine claude\|codex` | Choose the engine (looked up on PATH; Claude also in the VS Code / Cursor extension) |
| `repos`, `repos set KEY path`, `repos clone KEY` | Project key to folder map; the folder must be a clone of the project's GitHub repo |
| `hook Event` | Claude Code hook: sends the work trace to the issue; maps unmapped repos (never opens a window, always exit 0) |
| `autostart on\|off` | `HKCU\...\Run\ExponentialAgent` = `"<exe>" start` |
| `uninstall --yes` | Stops the agent, removes autostart, the Apps & features entry, the data folder and the installed exe |

## Engines and secrets

- Claude runs with a tool denylist (secret files cannot be read); in a user folder it runs in place.
- Codex has no such denylist, so it never runs in a user folder: each run uses a temporary `git worktree add --detach` of the mapped repo's local HEAD (no fetch for user folders), files matching `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.pfx`, `*.p12`, `secrets.*`, `credentials*` are deleted in it, and the worktree is removed afterwards (also on failure or timeout). Uncommitted changes are not visible to Codex.
- A run is killed after 30 minutes.

## Server mapping

The poll response may carry `repos` (project to folder map set in the tracker) and `cloneAllowed` (project keys the agent may clone itself). Manually set server entries replace the local mapping; local hook/clone entries are kept and sent back with each poll (`repos` query parameter, together with `engine`). If an analysis arrives for an unmapped project listed in `cloneAllowed`, the agent clones the repo into `repos/` first.

## Files and traces outside the repo

- Install folder: `%LOCALAPPDATA%\Programs\Exponential\exponential-agent.exe`.
- Data folder: `%LOCALAPPDATA%\exponential-agent` (fallback `~/.local/share/exponential-agent`): `config.json` (url, token or OAuth tokens, device id, engine, repos, last pairing, user name; same format as 0.1.x), `log.txt` / `log.old.txt`, `mcp.json` (tracker MCP config with the token, for Claude), `agent.lock`, `<KEY>.lock`, `active-account.txt`, `repos/` (own clones), `tmp/` (temporary worktrees), `plugin-<version>/` (extracted plugin).
- Installer window: WebView2 user data in `<temp>/exponential-agent-webview` (deleted when the window closes). Tray icon: fyne.io/systray writes the icon to a temp file.
- Hook state: `<temp>/claude-tracker/` (session state, projects cache, `hook.log`).
- Registry (HKCU): `Software\Microsoft\Windows\CurrentVersion\Run\ExponentialAgent` (autostart) and `Software\Microsoft\Windows\CurrentVersion\Uninstall\ExponentialAgent` (Apps & features entry: DisplayName, DisplayVersion, Publisher, InstallLocation, DisplayIcon, UninstallString, NoModify, NoRepair, EstimatedSize). Installing removes the old `start-hidden.vbs` of 0.1.x and replaces its `wscript` Run value.
- The old PowerShell agent used the value `TrackerAgent` and `%LOCALAPPDATA%\tracker-agent`; this agent does not touch them.

## Plugin and untrusted repos

- The Claude plugin (`../plugin`: skills, hooks) is embedded in the agent at build time (`build.ps1` copies it to `internal/plugin/files/`, git-ignored) and extracted to `<data dir>/plugin-<agent version>/` on first use; Claude gets it with `--plugin-dir`. The plugin version is the one bundled in the agent.
- Repos with source `clone` (from the project's GitHub repo, controlled by a project admin) run Claude with `--setting-sources user --strict-mcp-config`: the repo's `.claude/settings*.json`, hooks and `.mcp.json` are not loaded. Your own folders (`manual`, `hook`) keep `--setting-sources project`.
- `login` and the install flow require an `https://` URL (http only for localhost, 127.0.0.1, [::1]); only http(s) addresses are opened in the browser.

## Requesters, toasts and usage

- Claim responses carry `requester {id, name}`. The agent stores its own account id (`userId` in `config.json`, from `GET /api/me`). When an analysis is for someone else, the tray tooltip reads "Exponential · analiza KEY-N dla Name" and a Windows toast "Analiza KEY-N dla Name" appears (library `git.sr.ht/~jackmordaunt/go-toast/v2`, AppID "Exponential agent"). The tray item "Powiadomienia o analizach dla innych" toggles `notifyOthers` (default on). Traces: `HKCU\Software\Classes\AppUserModelId\Exponential agent` (toast name and icon, removed by uninstall) and `<data dir>\toast-icon.png`.
- Claude runs with `--output-format json`; the final result's `total_cost_usd` and `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` are parsed (defensively; stdout still goes to `log.txt`). Codex reports no usage. After each run the agent POSTs `/api/agent/runs` (failures are only logged).
- The installer window title bar is dark (DWM attributes 20, 35, 36; Windows 11 for the colors).
