# Plan: PC agent that picks up work from the server

Status: approved direction, not started. Written for a local session to implement.

## Goal

Today Analyze works only on the PC where you click it: the browser opens `tracker://analyze/KEY-N` and
`scripts/local-agent/tracker-handler.ps1` runs Claude. On a phone the link goes nowhere and the request hangs
(now shown as "Stalled" after 15 minutes, with Cancel).

After this change:

1. **Phone (or any device without the agent):** Analyze / Deep only marks the issue. A PC with the agent picks it up
   within seconds.
2. **Browser on a PC with the agent:** stays as today, the `tracker://` link starts the run immediately. No waiting
   for the poll.
3. **Team queue (toggle, per project, off by default):** the first agent online processes every pending analysis on
   the board, not only its owner's. Lets one PC that's always on serve the whole team.
4. **Start work from the phone:** "Start on my PC" opens VS Code with the prompt on your PC (same channel).
5. The phone shows whether your PC is listening: "PC online" / "PC offline: runs when your PC is on".

## The one rule that makes it safe: claim before running

Both the immediate `tracker://` path and the background helper can see the same request, and with the team queue
several PCs can. Every run must first **claim** the request on the server; only the winner runs.

- New columns on `issues`: `analysis_claimed_at timestamptz null`, `analysis_claimed_by int null` (user id),
  `analysis_claimed_device text null` (agent id, see below).
- `POST /api/issues/:id/analyze/claim` with `{ deviceId }`: one SQL `UPDATE … WHERE analysis_requested_at IS NOT NULL
  AND (analysis_claimed_at IS NULL OR analysis_claimed_at < now() - interval '30 minutes') RETURNING …`.
  Returns `{ ok: true, deep, model }` or 409. The 30-minute window matches the handler's existing lock file.
- Clearing: whatever clears `analysis_requested_at` today (analysis saved, Cancel) also clears the claim.
- `tracker-handler.ps1` calls claim first (both when launched by the link and by the helper) and exits quietly on 409.
- "Stalled" in the UI (`src/web/IssuePage.tsx`, currently 15 minutes after the request) should count from
  `analysis_claimed_at` when the request is claimed, and should not count at all while no agent is online for it
  (shows "Waiting for a PC" instead). Request time alone is wrong once requests can queue while the PC is off.

## Server

1. **Agent identity.** `scripts/local-agent/install.ps1` generates a `deviceId` (GUID) once and stores it in
   `%LOCALAPPDATA%\tracker-agent\config.json` next to the existing config. Table `agents`: `id text pk` (deviceId),
   `user_id`, `name` (computer name), `last_seen_at`, `created_at`. Replaces/extends `users.local_agent_at`
   (keep that column working for the existing "installed" check in Settings > Claude Code).
2. **Heartbeat + work feed.** `GET /api/agent/work?deviceId=…` (long poll, ~25 s, or SSE if simpler with the
   existing live-update code in `useLiveUpdates`/`publish`). Updates `last_seen_at`, returns pending jobs this agent may
   take:
   - analyses: `analysis_requested_at IS NOT NULL AND unclaimed` and either requested by this user, or the project has
     the team queue on and the agent's user is a member;
   - start-work jobs for this user (below).
   Auth: the same tracker token the handler already reads from the Claude Code MCP config.
3. **Who requested.** `requestAnalysis` (`src/server/service.ts`) records `analysis_requested_by` (user id) so the
   feed can filter "mine". The activity log already has the actor; a column keeps the query simple.
4. **Team queue toggle.** `projects.agent_team_queue boolean default false`, editable by project admins in
   Settings > Claude Code; card text explains that an online teammate's PC will run analyses for everyone, using that
   teammate's Claude account and limits. The prompt still comes from the project template, so nothing personal leaks.
5. **Start work jobs.** Table `agent_jobs`: `id`, `user_id`, `kind 'start'`, `issue_id`, `created_at`, `claimed_at`,
   `done_at`. `POST /api/issues/:id/start-on-pc` creates one; it expires after 1 hour unclaimed (a PC that comes on
   the next morning should not suddenly open VS Code with yesterday's task — show "expired" instead).
6. **Presence for the UI.** `/api/me` adds `agentOnline: boolean` (any agent of mine with `last_seen_at` within
   90 s) and `agentLastSeen`. For the team queue, `GET /api/projects/:key/agents` returns online agents (name + owner).

## PC agent (`scripts/local-agent/`)

1. New `tracker-agent.ps1`: loop calling `/api/agent/work`; for each analysis job, claim it, then run the existing
   handler logic. Refactor `tracker-handler.ps1` so the run itself is a function both entry points share; keep its
   security model unchanged (only action + issue key come from outside; `--allowedTools` fixed in the script).
2. One run at a time per PC (queue locally); a failing run releases its claim (`DELETE …/analyze/claim`) so another PC
   or a retry can take it, and logs to the existing `log.txt`.
3. Start-work job: build the same `vscode://anthropic.claude-code/open?prompt=…` link as `openInClaude` in
   `src/web/startWork.ts` (prompt from `/api/issues/:id/prompt/start`, same 1900-character fallback) and
   `Start-Process` it.
4. `install.ps1` registers a per-user Scheduled Task "at logon" (no admin, hidden window) that runs
   `tracker-agent.ps1`; `uninstall.ps1` removes it. Re-running install updates the script as today.
5. If the PC sleeps, the long poll just drops; the loop reconnects with backoff (2, 4, 8 … max 60 s).

## Web app

1. `src/web/IssuePage.tsx` `analyze()`: if this device can run the link (desktop with the agent installed, see
   below), keep today's `tracker://` + toast. Otherwise just POST and toast "Queued. It runs on your PC" /
   "Queued. Your PC is offline, it runs when it's on". Fixes the phone case.
   "This device can run the link": `me.localAgentAt && !matchMedia('(pointer: coarse)').matches`, overridable by a
   per-browser "This computer has the agent" checkbox in Settings > Claude Code (localStorage) for touch laptops.
2. Status pill states: Waiting for a PC → Running on `<PC name>` (claimed) → done; Stalled after 15 min claimed
   without a result; Cancel in every state.
3. Start work from the phone: in `MobileBoard.tsx`'s long-press sheet and the issue page, "Start on my PC" when
   `agentOnline`, greyed out with the reason "Your PC is offline" otherwise (design-system rule: disabled with a reason,
   not hidden). The desktop "Start work in Claude" stays as it is.
4. Settings > Claude Code: list of my agents (name, last seen, remove), and the team queue toggle for admins.
5. UI text through `t()` with Polish in `src/web/pl.ts`; new pill/state styles from existing tokens only
   (`ai` while running, `warning` for stalled/offline). New pattern for the agents list needs a component card in
   `docs/design-system/components/`.

## Order of work (each step shippable)

1. Claim endpoint + columns + handler calls claim. (Fixes double runs even before the helper exists.)
2. `agents` table, deviceId in install, `/api/agent/work` long poll, `tracker-agent.ps1`, Scheduled Task.
3. Web: phone queues instead of opening the link; pill states; "PC online" from `/api/me`.
4. Team queue toggle.
5. Start work from the phone (`agent_jobs`).

## Tests

- `tests/`: claim is exclusive (two concurrent claims → one 200, one 409); expired claim can be reclaimed; saving the
  analysis or Cancel clears the claim; the work feed returns only my requests unless the project's team queue is on,
  and never another project's; start-work jobs expire after 1 hour.
- Manual: phone Analyze with PC on → runs within seconds; PC off → stays "Waiting for a PC", runs at logon; desktop
  click → runs immediately and the helper does not run it a second time; team queue on with two PCs → each request
  runs once.

## Open questions for the owner

- Several PCs of mine online: prefer the most recently active one, or first come first served? (Plan assumes first
  come via claim.)
- Team queue: whose Claude account pays for it is the PC owner's. OK as a visible note in Settings, or should
  requests show "ran on Anna's PC" in the activity log? (Cheap to add: log the claim.)
