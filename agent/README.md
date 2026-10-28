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
| `start [--detach]` | Poll loop (single instance, log rotated at 1 MB); `--detach` runs it hidden in the background (via `start-hidden.vbs`) |
| `status` | URL, account, device id, engine, repos, autostart |
| `engine claude\|codex` | Choose the engine (looked up on PATH; Claude also in the VS Code / Cursor extension) |
| `repos`, `repos set KEY path`, `repos clone KEY` | Project key to folder map; the folder must be a clone of the project's GitHub repo |
| `hook Event` | Claude Code hook: sends the work trace to the issue; maps unmapped repos |
| `autostart on\|off` | Windows: `HKCU\...\Run\ExponentialAgent` runs `wscript.exe "<data folder>\start-hidden.vbs"`, so no console window appears at logon; `off` removes the value and the VBS |
| `uninstall --yes` | Autostart off and delete the data folder |

## Engines and secrets

- Claude runs with a tool denylist (secret files cannot be read); in a user folder it runs in place.
- Codex has no such denylist, so it never runs in a user folder: each run uses a temporary `git worktree add --detach` of the mapped repo's local HEAD (no fetch for user folders), files matching `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.pfx`, `*.p12`, `secrets.*`, `credentials*` are deleted in it, and the worktree is removed afterwards (also on failure or timeout). Uncommitted changes are not visible to Codex.

## Server mapping

The poll response may carry `repos` (project to folder map set in the tracker) and `cloneAllowed` (project keys the agent may clone itself). Manually set server entries replace the local mapping; local hook/clone entries are kept and sent back with each poll (`repoMap`). If an analysis arrives for an unmapped project listed in `cloneAllowed`, the agent clones the repo into `repos/` first.

## Files and traces outside the repo

- Data folder: `%LOCALAPPDATA%\exponential-agent` (fallback `~/.local/share/exponential-agent`):
  `config.json` (url, token or OAuth tokens, device id, engine, repos), `log.txt` / `log.old.txt`, `mcp.json` (tracker MCP config with the token, for Claude), `agent.lock`, `<KEY>.lock`, `start-hidden.vbs` (3-line script that starts the agent with a hidden window; written by `autostart on` and `start --detach`), `active-account.txt`, `repos/` (own clones), `tmp/` (temporary worktrees).
- Hook state: `<temp>/claude-tracker/` (session state, projects cache, `hook.log`).
- Registry (only with `autostart on`): `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `ExponentialAgent`.
- The old PowerShell agent used the value `TrackerAgent` and `%LOCALAPPDATA%\tracker-agent`; this agent does not touch them.

## Remove

`exponential-agent uninstall --yes` (or `autostart off` and delete the data folder), then delete the exe.
