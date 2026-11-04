# Exponential on your computer: what gets installed and removed

Three optional layers. Install only what you need.

## What gets installed and where

### 1. MCP connection
- One `tracker` entry in the client's config: `~/.claude.json` (Claude Code), `~/.codex/config.toml` (Codex), or Cursor's `mcp.json`.
- The OAuth token is stored by the client itself, not by Exponential.

### 2. Claude Code plugin
- Installed into Claude's plugins directory (marketplace `expo`, plugin `expo@expo`), served by your Exponential server.
- Contains thin skills and the worklog hook.

### 3. exponential-agent (runs analyses on this computer)
Installed by double-clicking the file downloaded from Settings > AI (it carries the server address and a one-time pairing code).
- Program: `%LOCALAPPDATA%\Programs\Exponential\exponential-agent.exe`
- Data folder `%LOCALAPPDATA%\exponential-agent` (fallback `~/.local/share/exponential-agent`): `config.json` (URL, tokens, device id, engine, repo map), `log.txt`, `plugin-<version>/` (bundled Claude plugin), `toast-icon.png`, `repos/` (clones made by the agent). Codex runs use temporary worktrees there.
- Start Menu shortcut `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Exponential agent.lnk` (runs `exponential-agent open`: starts the agent if it is not running and opens its window; created on install and at agent start if missing; uninstall removes it)
- Registry (current user only):
  - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ExponentialAgent` (Apps & features entry)
  - `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ExponentialAgent` (starts with Windows; not written when unchecked in the installer)
  - `HKCU\Software\Classes\AppUserModelId\Exponential agent` (name and icon of its notifications)
  - `HKCU\Environment\Path` gets the program folder appended (no duplicates), so the plugin's Claude Code hooks can run `exponential-agent hook ...`; uninstall removes it
- Hook state in `<temp>/claude-tracker/`.
- WebView2 profile folders of the agent windows: `%TEMP%\exponential-agent-webview-<pid>`, `...-webview-settings-<pid>`, `...-webview-toast-<pid>`. They are removed on exit; the agent also deletes leftovers of crashed processes (pid no longer running) at startup.
- Lock files in the data folder: `agent.lock` (one agent per user) and `<KEY>.lock` (a running analysis), created exclusively.
- Per-run `mcp-<pid>-<time>.json` (tracker address and bearer token for the AI engine): deleted when the run ends.
- At rest, the tokens in `config.json` (refresh token, `trk_` token) are encrypted with Windows DPAPI for the current user (`dpapi:...` values; an old plain-text file is migrated on start). The short-lived access token stays plain.

#### Safety rules for analyses run for other people
- Claude runs with `--permission-mode default`; its deny list covers repo secret files (shared list in `agent/internal/app/secrets.go`) and absolute secrets: the agent data folder, `~/.claude/.credentials.json`, `~/.claude-accounts/**/.credentials.json`, `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.git-credentials`, `~/.config/gh`. A blanket `Read(//**)` deny is NOT used: deny rules win over allow rules in Claude Code, so it would block the repo too.
- The tracker MCP of such a run carries `X-Exponential-Issue: <KEY>`; the server limits the tools to that issue.
- Codex cannot be limited to the repo, so it refuses other people's jobs.
- Repo paths from the server must be local drive paths (UNC `\\host\...`, `\\?\...` and non-existing drives are rejected); `githubRepo` must match `owner/name`. Folders inside `repos/` are always untrusted (project settings do not load) and a server entry never downgrades a local clone.
- Team mode `auto` set on the server is ignored unless it is already set on this computer (tray menu / settings window); the agent keeps its local mode and tells the server. There is no extra confirmation card.
- Self-update installs only a release whose `SHA256SUMS.sig` (ed25519 over `SHA256SUMS`, key built into the exe) verifies; the release workflow signs with the secret `AGENT_SIGNING_KEY`. The only copy of the private key outside GitHub is on the maintainer's PC: `C:\Users\krzys\.exponential-signing\agent-signing-key.pem` (public key next to it). Lost key = new key pair + a release that still verifies with the old key, otherwise installed agents can't update.

Details: [agent/README.md](../agent/README.md).

## How to remove

| Layer | Command |
|---|---|
| MCP (Claude Code) | `claude mcp remove tracker` |
| MCP (Codex) | `codex mcp remove tracker` |
| Plugin | `claude plugin uninstall expo@expo` |
| Agent | Windows Settings > Apps > Exponential agent > Uninstall (or `exponential-agent uninstall --yes`); also removes the Start Menu shortcut, this computer and its sign-in from the server |
| Server-side access | Settings > My AI > AI clients: Revoke |

## Legacy PowerShell installer

Older installs used `scripts/local-agent/install.ps1`, which created:
- the `tracker://` protocol in `HKCU\Software\Classes\tracker`
- the `HKCU\...\Run` value `TrackerAgent`
- the folder `%LOCALAPPDATA%\tracker-agent`

The server stopped serving these scripts on 03.11.2026 (Server 1.3.4); remove leftovers by hand. The new agent does not touch them.
