# Plan: Release v1 — AI integration for outside users

Status: approved 28.10.2026, not started. Written for the coordinating session; stages are delegated to executor agents.

## Why

Today's integration (MCP + plugin + local agent) works, but is tailored to one machine: Claude Code only from the
VS Code extension, `irm | iex` / unsigned `.cmd`, token pasted into a console, hidden PowerShell with
`-ExecutionPolicy Bypass`, registry writes (`tracker://`, `HKCU\...\Run`), repo search by folder names (misses OneDrive
Desktop, other drives, worktrees, needs Claude's folder history), and a missing repo aborts the install before the
plugin. The worklog hook needs Node, which many users do not have.

Goal: a user of the hosted version connects Claude Code or Codex (VS Code, Cursor, CLI) in a few clicks, choosing
what to install. No bloat: one source of content (the server), optional layers.

## Decisions

| Area | Decision |
|---|---|
| Audience | users of the hosted version |
| Clients | Claude Code and Codex; VS Code, Cursor, CLI |
| Setup | wizard in the web app (step bar, one row per client, live "connected" confirmation, "Skip") |
| Sign-in | OAuth in the browser; the agent uses the device flow (`exponential-agent login`) |
| Skills | content lives in the MCP server (instructions + prompts); thin Claude plugin in a marketplace |
| Worklog | the hook calls the agent binary instead of `node` |
| Repos | one repo per project, many projects; `project → folder` mapping stored on the server per device. Sources: hook (session in a matching repo), folder picked in the wizard/Settings, agent auto-clone (opt-in). Team queue only hands a device work for projects it has mapped |
| Agent | single `.exe` (Node SEA, no new tools on the machine), Windows first, portable code |
| Distribution | GitHub Releases + SHA256, unsigned for now; signing and winget later |
| Release v1 | all four: wizard + OAuth, plugin, agent, release housekeeping |

## What exists (reuse)

- Auth: `src/server/auth.ts` — `createSession`, `userFromSession`, `userFromToken`, `req.user` hook, `beginOAuth` and
  PKCE in the Google flow. Tokens in `api_tokens` (`src/db/schema.ts`), sha256.
- MCP: `src/server/mcp.ts` — stateless `buildServer(req.user)`, server instructions, `tool()` wrapper, `/mcp` route.
  No MCP prompts yet.
- Agent queue from `pc-agent-queue.md` is implemented: `src/server/agents.ts` (`claimAnalysis`, `heartbeat`,
  `pendingWork`, `waitForWork`, `claimStartJob`), `/api/agent/*` and `/api/issues/:id/analyze/claim` in `api.ts`,
  `agents` table. The new agent speaks the same protocol.
- Agent files served from `src/server/index.ts` (`/agent/:file`), plugin built by `src/server/plugin.ts`, worklog at
  `POST /api/issues/:id/worklog`.
- Web: `ClaudeConnect` in `src/web/Settings.tsx`; closest step pattern: `src/web/DemoTour.tsx`
  (`docs/design-system/components/DemoTour.md`). No generic modal/stepper.
- Tests: `tests/agents.test.ts`, `tests/auth.test.ts`, `tests/security.test.ts`.

## Stages

### Before stage 1
Check Codex and Cursor docs for MCP OAuth and MCP prompts support. Where missing, the wizard shows a token path.

### Stage 1 — parallel (3 executors, disjoint files)

**E1. OAuth server** — new `src/server/oauth.ts`, `src/db/schema.ts` + migration, registration in `index.ts`,
`WWW-Authenticate` on the `/mcp` 401 (only that function in `mcp.ts`), `tests/oauth.test.ts`.
- `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`.
- Dynamic client registration, `/oauth/authorize` (needs a session, otherwise login and return), consent screen,
  `/oauth/token` (authorization_code + PKCE S256, refresh_token), device flow with a code-entry page.
- Tables `oauth_clients`, `oauth_codes`, `oauth_grants` (hashed like `api_tokens`, `lastUsedAt`, client name).
- `userFromToken` also accepts OAuth tokens; existing `trk_` tokens keep working.
- `GET/DELETE /api/connections` for the wizard and Settings.

**E2. Skills in the server + thin plugin** — `mcp.ts` (instructions and new prompts only), new `src/server/skills/`,
`src/server/plugin.ts`, `plugin/`.
- Move `plugin/skills/*/SKILL.md` content to the server; MCP prompts `analyze_issue`, `close_issue`; server
  instructions good enough for a client without the plugin.
- Plugin skills become short: fetch the procedure from the MCP prompt and follow it.
- `hooks.json`: `exponential-agent hook <Event>`, falling back to `node worklog.mjs` until the agent ships. Drop the
  multi-account specifics (`active-account.txt`).

**E3. Agent `.exe`** — new `agent/` (TypeScript, own `package.json`), Node SEA build script,
`.github/workflows/agent-release.yml` (tag `agent-v*` → `.exe` + `SHA256SUMS`).
- Commands: `login` (device flow; token argument until E1 lands), `start`, `status`, `autostart on|off`,
  `hook <event>` (port of `plugin/scripts/worklog.mjs`), `repos clone <KEY>`, `uninstall`.
- Port the logic of `scripts/local-agent/tracker-agent.ps1` and `tracker-handler.ps1` (tool allowlist, secret
  blocking, 30-minute lock) onto the existing endpoints.
- Engines: `claude -p` and `codex exec`; choice in config; detect binaries (PATH, VS Code/Cursor extensions).
- Repos: no disk scan. Mapping comes from the server and refreshes on every poll. Sources: (1) the hook reports a folder
  whose remote matches `githubRepo`; (2) folder picked in the wizard/Settings; (3) clone into
  `%LOCALAPPDATA%\exponential-agent\repos\<owner>-<name>` with the user's git credentials, then `git fetch` and work in a
  fresh worktree of `origin/<deployBranch>` (never touches the owner's own clone).
- Before each run: folder exists and remote matches `githubRepo`; otherwise release the claim and report a repo error.
- Config in `%LOCALAPPDATA%\exponential-agent`; autostart only after `autostart on`.

### Stage 2 — parallel (2 executors, after stage 1)

**E4. Server: repos per device, team-queue routing, connection status** — `agents.ts`, `api.ts`, `schema.ts`.
- Table `agent_repos (agentId, projectKey, path, source: hook|manual|clone, status: ok|error, error)`,
  `PUT /api/agents/:id/repos`, mapping returned by `/api/agent/work`.
- `pendingWork` and `claimAnalysis` only consider projects with status `ok` for that device; an issue no device can
  take shows "Waiting for a PC with the repo" (`IssuePage.tsx`).
- Project flag "agents may clone the repo" (off by default, project admin). Changing `githubRepo` invalidates that
  project's mappings.
- "Repos on this computer" per device in Settings (`AgentList`).
- Status endpoint "client X connected" (first MCP call after a grant) for the wizard's live dot.

**E5. Web wizard** — needs the design-system owner's approval before commit (new component pattern). First a card
`docs/design-system/components/SetupWizard.md` based on DemoTour, then new `src/web/SetupWizard.tsx`, `Settings.tsx`
(replaces `ClaudeConnect`), `styles.css` (tokens only), `pl.ts`.
- Steps: Start → Client (rows: Claude Code / Codex + where: VS Code / Cursor / CLI; deeplink button or command; live
  dot) → Scope (MCP always; "Work trace" for Claude only; "Background work") → Background work (download `.exe`, honest
  SmartScreen note, `login`, repos on this device) → Done.
- Shown on first sign-in, "Skip, issues access only"; can be reopened from Settings. Texts via `t()`, dates `dd.mm.yyyy`.

### Stage 3 — release housekeeping (1 executor)
- Semver for server, plugin (`plugin/.claude-plugin/plugin.json`) and agent; `CHANGELOG.md`.
- `docs/agent.md`: what gets installed where (files, registry, variables) and how to remove it.
- Plugin marketplace as a public GitHub repo (publishing confirmed by the owner).
- Hide `.cmd` / `install.ps1` from new users in `index.ts` (kept for existing installs until they migrate); README
  install section and "Limitations".

## Who does what
- Coordinator: detailed executor briefs (files, functions, expected behavior, tests), the SetupWizard card, diff review,
  running tests, decisions.
- Executors (Sonnet, low): E1, E2, E3 at once; then E4, E5 at once; then stage 3.
- `ui-checker`: end of E5 only, with Playwright approval and a yes/no checklist.

## Verification
- `docker compose -p tracker up -d`, `npm test` from `C:\` (uppercase drive letter).
- `git archive HEAD | docker build -` + healthcheck.
- `claude mcp add --transport http tracker <url>/mcp` without a header → browser sign-in → `list_projects`; same in
  Codex and Cursor; `analyze_issue` prompt visible in Claude Code.
- Agent: `login` → `start` → Analyze from the phone → analysis saved; worklog hook on a machine without Node.
- Team queue: two projects, PC A has only project 1's repo, PC B both → project 2's issue goes only to B; with B off it
  waits with a message; PC A with cloning allowed clones and takes it; changing `githubRepo` invalidates mappings.
- Wizard (ui-checker): steps visible, dot turns "connected", "Skip" ends with MCP only.
