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
Data folder `%LOCALAPPDATA%\exponential-agent` (fallback `~/.local/share/exponential-agent`):
- `config.json` (URL, tokens, device id, engine, repo map), `log.txt` / `log.old.txt`
- `start-hidden.vbs` (starts the agent without a window), `repos/` (clones made by the agent)
- Codex runs use temporary worktrees under `tmp/` in the data folder (removed afterwards).
- Registry value `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ExponentialAgent`, only after `exponential-agent autostart on`.
- Hook state in `<temp>/claude-tracker/`.

Details: [agent/README.md](../agent/README.md).

## How to remove

| Layer | Command |
|---|---|
| MCP (Claude Code) | `claude mcp remove tracker` |
| MCP (Codex) | `codex mcp remove tracker` |
| Plugin | `claude plugin uninstall tracker@tracker` |
| Agent | `exponential-agent uninstall --yes`, then delete the exe |
| Server-side access | `DELETE /api/connections/:id` (a list with Revoke in Settings is not built yet) |

## Legacy PowerShell installer

Older installs used `scripts/local-agent/install.ps1`, which created:
- the `tracker://` protocol in `HKCU\Software\Classes\tracker`
- the `HKCU\...\Run` value `TrackerAgent`
- the folder `%LOCALAPPDATA%\tracker-agent`

`uninstall.ps1` removes all three (`irm <server>/agent/uninstall.ps1 | iex`, or `exponential-uninstall.cmd` from Settings). The new agent does not touch them.
