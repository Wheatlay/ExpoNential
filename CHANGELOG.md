# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Agent [0.2.2] - 03.11.2026

- Repo discovery looks again only when Claude Code, VS Code, Cursor or Codex history changed, and reads remotes straight from `.git/config` (worktrees included) instead of starting `git`: the hourly check is a few file timestamps.
- Also finds folders trusted in Codex (`[projects."…"]` in `~/.codex/config.toml`), so Codex used only in the terminal is covered.

## Server [1.2.1], Agent [0.2.1] - 03.11.2026

- Agent finds repos by itself in folders already opened in Claude Code (`~/.claude.json` projects, also per account) and in VS Code / Cursor recent folders, including one level below an opened folder; no disk scan, never overrides a mapping set by hand.
- Uninstall says so when the computer could not be removed from the server.
- Computers not seen for 3 days are marked "Inactive"; after 14 days they disappear from the list (usage stays).
- Meeting polls: removing someone from the invitees drops their votes, and votes of people no longer invited are not counted.

## Server [1.2.0], Agent [0.2.0] - 03.11.2026

- Agent rewritten in Go: about 10 MB instead of 80 MB, no console windows. Downloaded from Settings > AI with the server address and a one-time pairing code inside; double-click opens an Exponential-styled installer (Claude Code or Codex icon taken from this computer, progress, done), installs to `%LOCALAPPDATA%\Programs\Exponential`, appears in Apps & features, starts with Windows on request.
- Tray icon: state, "analysis KEY-N for <person>", a notification when your computer works for someone else (can be switched off).
- Usage per run (tokens, cost) is recorded; Settings shows 30-day usage per computer and per requester, and a daily limit for others. A dot on Settings marks what needs attention.
- Team queue is opt-in per computer: the admin allows it for a project, each person joins with their own computer; members with the agent and the repo get a quiet invite.
- Settings: "Claude Code" section renamed to "AI", tokens moved under "API keys", the legacy Windows script installer is hidden (removal plan in docs/plans/release-v1.md). The Connect AI window shows done steps as chips and one step at a time.
- Analyze with the team queue on goes straight to the queue; otherwise the hint offers "Request anyway".
- Reinstalling keeps the same computer entry; uninstalling removes it and its sign-in from the server.

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
