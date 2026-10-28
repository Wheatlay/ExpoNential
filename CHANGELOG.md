# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Server [1.1.2], Agent [0.1.4] - 28.10.2026

- Security: API tokens (`trk_`, `exa_`) work only for MCP, the agent, the worklog hook and the legacy PowerShell installer; creating tokens and managing connections needs a browser session.
- Security: the agent runs Claude in repos it cloned without that repo's settings, hooks or MCP servers (`--setting-sources user --strict-mcp-config`), so a project admin cannot run code on teammates' PCs.
- Security: the Claude plugin is bundled in the agent instead of downloaded from the server on every run; `login` requires https (http only for localhost) and the agent opens only http(s) links.
- The hourly OAuth sweep also removes revoked and expired grants and unused clients older than a day.
- Release workflow: checkout without persisted credentials, write permission only on the release job.

## Server [1.1.1], Agent [0.1.3] - 28.10.2026

- Security: `/oauth/authorize` shows an error page instead of redirecting on a bad request (no open redirect); redirect addresses are limited to https, loopback and the cursor/vscode/vscode-insiders/claude app schemes.
- Security: the consent and device pages say the app name is not verified, show where access goes and when the app was registered; a device code must be typed by hand (a link with the code no longer leads straight to Allow).
- Team queue runs only on Claude agents: an agent using Codex gets only its owner's requests, because Codex can read files outside the repo. The server requires agent 0.1.3+.

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
