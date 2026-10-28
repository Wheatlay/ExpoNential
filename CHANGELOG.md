# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Agent [0.1.2] - 28.10.2026

- Fixed: analyses stopped at a permission prompt for `get_procedure`; it is now allowed (also in the legacy `tracker-handler.ps1`). The server no longer hands work to agent 0.1.1.

## [1.1.0] - 28.10.2026

### Server
- OAuth sign-in for MCP clients (dynamic client registration, PKCE, refresh tokens) and the device flow for the agent; `/api/connections` lists and revokes connections. Existing `trk_` API tokens keep working.
- Procedures (analyze, close) are served by the MCP server (`get_procedure` tool and MCP prompts), so clients work without the plugin.
- Repo mappings per computer; the team queue only hands a computer work for projects it has mapped.
- Per-project `agentsMayClone` option: agents may clone the project's repo themselves.
- Issue page shows "Waiting for a PC with this project's repo".
- AI setup window: one screen, a goal question and a live checklist (client, work trace, agent); hints on AI buttons instead of errors; connected AI clients with Revoke in Settings.

### Agent 0.1.1
- New standalone `exponential-agent` (single exe) replacing the PowerShell scripts. Commands: `login`, `start`, `status`, `engine`, `repos`, `hook`, `autostart`, `uninstall`.
- Hidden autostart (no console window at logon).
- Codex runs in a temporary git worktree with secret files removed.

### Plugin 1.1.0
- Thin skills that fetch the procedure from the server.
- Worklog hook tries `exponential-agent` first.
