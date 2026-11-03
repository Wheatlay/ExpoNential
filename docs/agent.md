# Exponential on your computer: what gets installed and removed

Three optional layers. Install only what you need.

## What gets installed and where

### 1. MCP connection
- One `tracker` entry in the client's config: `~/.claude.json` (Claude Code), `~/.codex/config.toml` (Codex), or Cursor's `mcp.json`.
- The OAuth token is stored by the client itself, not by Exponential.

### 2. Claude Code plugin
- Installed into Claude's plugins directory (marketplace `tracker`, plugin `tracker@tracker`), served by your Exponential server.
- Contains thin skills and the worklog hook.

### 3. exponential-agent (runs analyses on this computer)
Installed by double-clicking the file downloaded from Settings > AI (it carries the server address and a one-time pairing code).
- Program: `%LOCALAPPDATA%\Programs\Exponential\exponential-agent.exe`
- Data folder `%LOCALAPPDATA%\exponential-agent` (fallback `~/.local/share/exponential-agent`): `config.json` (URL, tokens, device id, engine, repo map), `log.txt`, `plugin-<version>/` (bundled Claude plugin), `toast-icon.png`, `repos/` (clones made by the agent). Codex runs use temporary worktrees there.
- Registry (current user only):
  - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ExponentialAgent` (Apps & features entry)
  - `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ExponentialAgent` (starts with Windows; not written when unchecked in the installer)
  - `HKCU\Software\Classes\AppUserModelId\Exponential agent` (name and icon of its notifications)
  - `HKCU\Environment\Path` gets the program folder appended (no duplicates), so the plugin's Claude Code hooks can run `exponential-agent hook ...`; uninstall removes it
- Hook state in `<temp>/claude-tracker/`.

Details: [agent/README.md](../agent/README.md).

## How to remove

| Layer | Command |
|---|---|
| MCP (Claude Code) | `claude mcp remove tracker` |
| MCP (Codex) | `codex mcp remove tracker` |
| Plugin | `claude plugin uninstall tracker@tracker` |
| Agent | Windows Settings > Apps > Exponential agent > Uninstall (or `exponential-agent uninstall --yes`); also removes this computer and its sign-in from the server |
| Server-side access | Settings > My AI > Connected AI clients: Revoke |

## Legacy PowerShell installer

Older installs used `scripts/local-agent/install.ps1`, which created:
- the `tracker://` protocol in `HKCU\Software\Classes\tracker`
- the `HKCU\...\Run` value `TrackerAgent`
- the folder `%LOCALAPPDATA%\tracker-agent`

The server stopped serving these scripts on 03.11.2026 (Server 1.3.4); remove leftovers by hand. The new agent does not touch them.
