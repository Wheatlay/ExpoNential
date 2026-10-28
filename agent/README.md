# Exponential agent

Standalone local agent: polls Exponential for work and runs AI analyses (Claude Code or Codex) on this computer. It replaces `scripts/local-agent/*.ps1`.

## Build

```
cd agent
npm install
npm run build        # dist/agent.cjs (bundle)
npm run build:exe    # dist/exponential-agent.exe (Node SEA, needs Node 22+)
```

Release: push a tag `agent-vX.Y.Z`; `.github/workflows/agent-release.yml` builds the exe and publishes it with `SHA256SUMS`.

## Commands

| Command | What it does |
|---|---|
| `login --url URL [--token trk_...]` | Stores a long-lived token, or (no `--token`) runs the OAuth device flow in the browser |
| `start` | Poll loop (single instance, log rotated at 1 MB) |
| `status` | URL, account, device id, engine, repos, autostart |
| `engine claude\|codex` | Choose the engine (looked up on PATH; Claude also in the VS Code / Cursor extension) |
| `repos`, `repos set KEY path`, `repos clone KEY` | Project key to folder map; the folder must be a clone of the project's GitHub repo |
| `hook Event` | Claude Code hook: sends the work trace to the issue; maps unmapped repos |
| `autostart on\|off` | Windows: `HKCU\...\Run\ExponentialAgent` |
| `uninstall --yes` | Autostart off and delete the data folder |

## Files and traces outside the repo

- Data folder: `%LOCALAPPDATA%\exponential-agent` (fallback `~/.local/share/exponential-agent`):
  `config.json` (url, token or OAuth tokens, device id, engine, repos), `log.txt` / `log.old.txt`, `mcp.json` (tracker MCP config with the token, for Claude), `agent.lock`, `<KEY>.lock`, `active-account.txt`, `repos/` (own clones), `tmp/` (temporary worktrees).
- Hook state: `<temp>/claude-tracker/` (session state, projects cache, `hook.log`).
- Registry (only with `autostart on`): `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `ExponentialAgent`.
- The old PowerShell agent used the value `TrackerAgent` and `%LOCALAPPDATA%\tracker-agent`; this agent does not touch them.

## Remove

`exponential-agent uninstall --yes` (or `autostart off` and delete the data folder), then delete the exe.
