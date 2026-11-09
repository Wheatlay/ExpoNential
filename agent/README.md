# Exponential agent

Local agent: polls Exponential for work and runs AI analyses (Claude Code or Codex) on this computer. A small Go program (about 7 MB), a Windows GUI-subsystem exe: no console window ever appears. It replaces `scripts/local-agent/*.ps1` and the earlier Node version (0.1.x).

## Install (user)

Download the agent from Exponential > Settings > AI and double-click it. The server appends your one-time pairing to the downloaded exe. The agent opens one branded window (WebView2, dark Exponential colors, Polish when the Windows UI language is Polish, else English; no system dialogs, no console) showing the account and server, with a "Start with Windows" checkbox (on by default). After "Connect and install" it shows progress (connected, copied, starting, waiting until the server sees the agent, up to 20 s) and then "Done". It copies itself to `%LOCALAPPDATA%\Programs\Exponential\exponential-agent.exe`, registers itself in Settings > Apps (Apps & features), turns on autostart (unless unchecked) and starts hidden. Double-clicking again shows the account with "running / not running", makes sure the agent runs, and offers "Disconnect" (uninstall). Errors (expired link, no pairing in the file, network or server error) show in the same window with "Open Exponential". If the WebView2 runtime is missing (it ships with Windows 10/11), the old message boxes are used instead.

Remove: Settings > Apps > Exponential agent (runs `exponential-agent.exe uninstall --yes`).

## Tray icon and app icon

The background agent (`start`) shows a tray icon (brand mark). Tooltip: "Exponential · ready", "Exponential · analyzing KEY-N…" during an analysis, "Exponential · no connection" after 3 failed polls (Polish texts on a Polish Windows). Left click opens the mini settings window. Menu: "Ustawienia…", account and server (disabled), state, "Open Exponential", team mode, mute, toggles, "Quit agent" (stops the process; autostart stays). The exe carries the icon and version info (company Exponential, product Exponential agent), so Explorer, the taskbar, Apps & features and SmartScreen show them. Non-Windows builds have no window or tray.

## Building

Go 1.27 (`winget install GoLang.Go`).

```
cd agent
./build.ps1 [-Version 0.4.0]    # plugin copy, icon (tools/mkicon, only if assets/exponential.ico is missing), go-winres (icon + version info, winres/winres.template.json), builds dist/exponential-agent.exe
go vet ./...
go test ./...
```

Libraries: github.com/jchv/go-webview2 (installer window), fyne.io/systray (tray), golang.org/x/image (icon generator), github.com/tc-hib/go-winres v0.3.3 (via `go run`, resources; generates git-ignored `winres/winres.json` and `rsrc_windows_amd64.syso`). Regenerate the icon with `go run ./tools/mkicon assets/exponential.ico`.

Release: push a tag `agent-vX.Y.Z`; `.github/workflows/agent-release.yml` builds the exe and publishes it with `SHA256SUMS` and `SHA256SUMS.sig` (ed25519, secret `AGENT_SIGNING_KEY`; the job fails without it). Non-Windows builds compile (`GOOS=linux go vet ./...`) but only print for dialogs and autostart (TODO).

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

## Levels, MCP key, update check, limits and consent (0.3.0)

- **Install levels.** The download carries `"goal": 1|2|3` in the trailer (missing = 3). The installer does every level up to the goal, shown as rows (icon, then a check or spinner; a failed row turns red with the reason in its tooltip, the end screen says "Gotowe z błędami"): 1 issue access, 2 work trace, 3 background agent (copy, Apps & features, autostart if checked, start). Goals 1-2 never install or start the background agent; the choice is stored as `goal` in `config.json`.
  - Level 1 (Claude Code): `POST <url>/api/agent/mcp-key` with the agent's OAuth bearer and `{"client":"Claude Code","device":"<hostname>"}` returns a long-lived `trk_...` key (never logged). For every config dir (default `~/.claude.json` account, each `~/.claude-accounts/*` holding a `.claude.json`, `$CLAUDE_CONFIG_DIR`; `CLAUDE_CONFIG_DIR` set for account dirs, removed for the default): `claude mcp remove tracker --scope user`, then `claude mcp add --transport http --scope user tracker <url>/mcp --header "Authorization: Bearer <key>"`. The result is verified by reading `mcpServers.tracker` in that `.claude.json`. The key is stored by Claude Code in `.claude.json`.
  - Level 2 (Claude Code only): in the same dirs `claude plugin marketplace add <url>/agent/marketplace.json`, `claude plugin marketplace update tracker`, `claude plugin install tracker@tracker`, `claude plugin update tracker@tracker` ("already" errors ignored), verified with `claude plugin list` containing `tracker@tracker`.
  - Codex: level 1 runs `codex mcp add tracker --url <url>/mcp` and `codex mcp login tracker` (opens the browser); level 2 shows "tylko Claude Code".
  - All child processes run with CREATE_NO_WINDOW.
- **Update check (Windows).** The background agent asks `GET https://api.github.com/repos/Wheatlay/ExpoNential/releases/latest` (User-Agent `exponential-agent`) at start and every 6 h: an outbound request to api.github.com. By default (setting "Update automatically" in the agent window, on unless switched off; config `autoUpdate`) a newer version installs by itself in the background, after a running analysis finishes, and the restarted agent shows "Updated to X" once. With the setting off it only offers the update as below. If the tag `agent-vX.Y.Z` is newer, the tray shows "Zaktualizuj do X.Y.Z" and the state line "dostępna X.Y.Z". Click: download `exponential-agent.exe` and `SHA256SUMS` from the release, verify the ed25519 signature of `SHA256SUMS` (public key in `update.go`) and the SHA256, rename the running exe to `exponential-agent.old.exe`, put the new one in place, start it, quit (the `.old.exe` is deleted on the next start). Failure (hash, network, running analysis): toast "Aktualizacja nie powiodła się", the agent keeps running. Apps & features `DisplayVersion` is refreshed at start.
- **Failure messages.** When the engine exits non-zero the agent keeps the last 4 KB of stdout and stderr; the message is `claude exited with code N: <reason>` (the `result` of a JSON `is_error` result, else the last lines of stderr/stdout, ANSI stripped), cut to 300 characters, sent with the claim release and as the next `error`.
- **Usage limit.** A result with `api_error` `usage_limit_reached`, status 429 or text "hit your ... limit" is not a failure: the account is marked limited until the parsed reset (`resets 6pm (Europe/Warsaw)`, `resets 18:30`, else 60 min) and the same analysis retries on the next account. Accounts in order: active (`active-account.txt`), the other `~/.claude-accounts/*` with `.claude.json` or `.credentials.json`, the default. When every account is limited the claim is released without `error`, polls send `busy=1` until the earliest reset, the tray shows "Limit Claude do HH:MM", `lastErr` carries it and one toast appears per pause. Time zone data is embedded (`time/tzdata`).
- **Consent for others.** For an analysis with `requestedBy.id` other than your own the agent asks before claiming. The question is a card in one borderless, always-on-top, non-activating WebView2 window at the bottom right of the work area (markup in `toast.html`, window code in `toast_windows.go`, card queue in `cards.go`): avatar with the requester's initial, "<Name> · <KEY>", "Zgoda na 24 h" (`allowUntil[requesterId]` = now + 24 h in `config.json`), "Tylko teraz", small "Wycisz na 24 h", and an ✕ (tooltip "Odmów") that declines; the countdown bar (2 min, paused while the mouse is over the window) also declines, and the `KEY|requestedAt` is stored in `declined`. Click on the text opens `<url>/issue/<KEY>`. Several questions: one active card, the others one-line cards above it. A card closes by itself when its job disappears from the poll. After "Zgoda na 24 h" later jobs of that person only show a 6 s card "Analiza KEY dla X". Other OSes do not ask.
- **Own analyses** (`notifyOwn` in `config.json`, default on; toggle "Notifications for my analyses" in the mini settings window): the same small card when an analysis you requested yourself (e.g. from the phone) starts on this computer. Muting hides it too.
- **Mute for 24 h** (`mutedUntil` in `config.json`; tray menu, mini settings window, toast): no cards, no "for others" cards, others' jobs are skipped (not claimed) so other computers can take them; own jobs work. The tray state line shows "wyciszone do HH:MM".
- **Team mode** (`teamMode`: `ask` | `auto` | `off`, default `ask`; replaces the old `askOthers` checkbox, `askOthers=false` is migrated once to `auto`). The server is the source of truth: the poll answer carries `teamMode`; a change made in the agent is sent as `PATCH /api/agents/<deviceId> {"teamMode": ...}` with the agent token (a 4xx is only logged). `auto` = no question, `off` = never take others' jobs.
- **Mini settings window** (left click on the tray icon, or "Ustawienia…" in the right-click menu; `settings.html`, `settings_windows.go`): account and state line, version (+ update button), team mode, notification and autostart toggles, mute, theme, "Otwórz Exponential", "Ustawienia AI", "Odinstaluj…". Closes on Esc and when it loses focus.
- **Theme** (`theme`: `system` | `dark` | `light`; system follows `AppsUseLightTheme`): applies to the installer, toast and mini settings windows. The colour block shared by all pages is `uiCSS` in `agentui.go` and mirrors the theme blocks of `src/web/styles.css`.

## 0.4.0: tabbed window, repo picker, runs, update card, log

- **One settings window, three tabs** (left click on the tray icon, or "Ustawienia…" in the menu, always opens on "Ogólne"; 400x520, closes on Esc or focus loss): "Ogólne" (what the mini window had, plus "Pokaż log" / "Kopiuj log"), "Repo", "Analizy".
- **Repo tab**: the projects of the account (`GET /api/projects`) with the mapped folder, source badge (auto / ręcznie / klon / hook) and the check result. "Wybierz folder" opens the native Windows folder picker (IFileOpenDialog, fallback SHBrowseForFolder), validates the folder against the project's GitHub repo and stores it as source `manual`; the next poll sends the mapping to the server. "Usuń" deletes the local mapping. Projects without a GitHub repo show "brak repo w projekcie".
- **Analizy tab**: the last 20 runs, kept in `<data dir>\runs.json` (time, key, requester when for someone else, engine, model, duration, input+output tokens, result ok / error reason / "limit Claude" / "odmowa" / "wyciszone", Claude account folder name). Click on the key opens `<url>/issue/KEY`.
- **Log**: "Pokaż log" shows the last 200 lines of `log.txt` inside the window, "Kopiuj log" copies them to the clipboard. Bearer values and `exa_` / `trk_` tokens are replaced with `***`.
- **No system dialogs**: uninstall ("Odinstalować agenta?" then progress and result), expired link, install errors and "already connected" are views of the branded window; message boxes remain only when WebView2 cannot be created. `uninstall` stops the agent first and only then unregisters the computer (a running agent would re-create it); an expired access token is refreshed (and the DELETE retried once on 401).
- **Updates**: a newer release puts an accent dot on the tray icon (drawn at runtime into the .ico frames) and shows one card in the toast window: "Dostępna wersja X" / "Zaktualizuj" / ✕ (skip this version, `updateDismissed` in `config.json`). The click turns it into "Pobieram… 42%" (Content-Length), "Instaluję…", then the agent restarts and the new process shows "Zaktualizowano do X" for 6 s (`updatedTo` flag in `config.json`). Failure shows "Aktualizacja nie powiodła się" with "Spróbuj ponownie". The tray menu item stays.
- Data folder additions: `runs.json`. No new registry keys or outside traces.

## Dev mode (testing the windows on a developer machine)

`EXPONENTIAL_DEV=1` marks a test build: "DEV" next to the version in the window and in the tray tooltip, self-update
off (a test build is never replaced by the published release), and the WebView2 debug port 9333 open. Build to a
scratch folder (`GOOS=windows go build -ldflags "-H windowsgui" -o <dir>/exponential-agent-dev.exe .`), stop the
installed agent, then run `<dir>/exponential-agent-dev.exe open` with `EXPONENTIAL_DEV=1` set.
`node agent/tools/devwin.mjs` drives the windows through the debug port: `health` (Not Responding check),
`eval <js>`, `click <text>`, `key Escape`, `shot <file.png>`. `exponential-agent dump` makes a running agent write the
stacks of all goroutines to `stack-<time>.txt` in its data folder (a hung window without a debugger).

## 0.4.16

- **Consent card.** A pending consent logs `waiting for consent from <name> for <KEY>` and tells the server (`POST /api/agent/consent-pending {issueId, pending}`, `false` on allow, decline, timeout, mute or when the job disappears). The card window is now recreated after a failure or close (it used to stay dead until the agent restarted, so no card and the job silently skipped); a skipped job with unknown identity and a failed window are logged.
- **Settings window:** list of active 24 h consents (`allowUntil`, names in `allowNames`) with "Revoke"; "Pair again" (pairing code from Settings > My AI, runs the pairing in-process and restarts the work loop); "Rescan" on the Repos tab (repeats the first-setup discovery).
- **Installer** always stops a running agent before replacing or starting, and comes to the foreground.
- **Open requests:** every poll asks `GET /api/agent/open-requests`; the repo's folder is opened with the editor CLI (`code`, `cursor`, `windsurf`; PATH, else `%LOCALAPPDATA%\Programs\...`), then `<scheme>://anthropic.claude-code/open?prompt=...`; `terminal` opens Windows Terminal (or a console) in the folder with `claude`.
- **Rename tracker -> expo:** the Claude Code MCP server and plugin are `expo` / `expo@expo`; at start the agent removes a leftover `tracker` MCP server and `tracker@tracker` plugin and installs the new ones.

## 0.4.18

- **Memory in the tray:** the settings and card windows (WebView2, a whole embedded browser: 6 processes, ~160 MB) are closed for real after 60 s hidden (`webviewIdleClose`) and created again when needed. Before, both stayed alive until the agent exited, and `webview.Destroy` after `Run` did nothing (it only posts WM_CLOSE to a loop that has ended); `destroyWebview` now calls DestroyWindow. Idle agent: 1 process, ~57 MB (was 7 processes, ~215 MB after any card).
- **tracker -> expo plugin migration fixed:** the old `tracker` marketplace has the same URL, so `marketplace add` answered "already on disk", `expo` never existed and the install failed on every start. A marketplace with another name and the same URL is removed first.

## 0.4.19

- **Moved repo folders are found again:** a mapping made by discovery (`source: auto`) whose folder no longer exists counts as missing, so the next discovery pass maps the project to the folder's new place. Manual and cloned mappings are never replaced.

## 0.4.24

- **No conversation in the worklog:** the hook no longer collects the prompts of a pinned session; the worklog carries only files and commits.

## 0.4.23

- **Check for updates only checks:** a newer version shows the update card with the Update button, also with auto-update on (the daily check still installs silently), and also when that version was dismissed before.

## 0.4.22

- **Change notes kept current:** when a session pinned to an issue commits after the issue's HUMAN/AI change notes were written, the Stop hook keeps the turn going once per new commit and asks Claude to update the notes with expo:close-ticket (update mode). No notes yet = no prompt.

## 0.4.21

- **Gone folders are replaced whatever their source:** a manual or cloned mapping whose folder no longer exists counts as missing too, so discovery maps the project to a found clone (`source: auto`). Mappings to existing folders are never replaced.

## 0.4.20

- **Discovery on events:** the server queues a `rescan` repo action when Start work or an analysis finds this PC without a working folder for the project; with agent start and the Rescan button that covers moved folders. The timed pass runs every 60 minutes as a safety net (was 5).
- **Update card:** clicking Update while the auto-update started by "Check for updates" is already installing shows the install in progress instead of "update failed".


- **Found repos:** every poll sends `found` (JSON array of lowercase `owner/name` GitHub slugs from the git configs of the folders opened in Claude Code, VS Code, Cursor and Codex; max 100). The list is cached and refreshed in the background at most every 5 minutes.
- **Discovery** runs every 5 minutes (was 60); the unchanged-history shortcut still keeps it cheap.
- **Repo actions:** every poll asks `GET /api/agent/repo-actions` (`clone`, `pick`, `rescan`). `clone` ignores `cloneAllowed` (the owner clicked it) and runs one at a time; `pick` opens the folder picker (Windows) and validates the folder; `rescan` repeats discovery and refreshes the found list.
- **Other people's requests** run in a persistent detached worktree (`worktrees/<KEY>` in the data folder) of the remote default branch (the owner's HEAD when there is none), after `fetch`. It is reset with `checkout --detach -f` and `clean -fd` (ignored files such as `node_modules` stay), so the owner's folder and uncommitted work are not used.
