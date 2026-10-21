# Exponential

The same code runs a small team's day-to-day tracker and the public demo (with `DEMO_MODE=1`).

> Your issue tracker where AI agents do the legwork and humans make the calls.

- Live demo: https://exponential-demo.onrender.com
- Live site of author: https://wheatlay.is-a.dev

## What it is

A Linear-style issue tracker built around Claude Code. Issues, sub-issues, priorities, labels, sprints with a review, meetings and polls, a realtime board. The difference is the loop around the AI agent:

1. **Issue.** Someone files a bug or an idea.
2. **Agent analysis.** An agent reads the code and writes a structured analysis (sections plus decisions) back to the issue.
3. **Human decision.** People click an option, or write their own answer. The agent never decides alone.
4. **Agent ships.** It starts from a ready prompt, commits are linked to the issue by its ID, and deploys are tracked.
5. **Change notes.** A short HUMAN note and a detailed technical note for the next agent. Together they write the sprint review.

## Try the demo

No sign-up: the landing page starts a guided 5-step tour on issue ACME-12 (Analyze, read the analysis, pick a decision, Start work, follow the activity and the Sprint review).

- The demo is a shared sandbox and resets every hour.
- The AI agent in the demo is a replay of a recorded session. No model is called.
- The service runs on Render's free plan and sleeps when idle, so the first request can take up to a minute.

## How the AI integration works

- **MCP server** at `/mcp` over Streamable HTTP, authenticated with per-user API tokens. Tools list, read and save issues, comments, relations, analyses and change notes.
- **Claude Code plugin served by the tracker itself** (`plugin/`): the skills `analyze-tracker-ticket` and `close-ticket`, plus a worklog hook that reports prompts, files and commits. Every machine gets the same version from the server.
- **Structured analysis** via the `set_analysis` tool: sections and decisions with options and a recommendation, rendered in the UI as buttons.
- **Start work** puts a ready prompt (editable per project) into Claude Code.
- **Commits** are linked to issues by ID (`ACME-12`) from a GitHub push webhook, only for the repository configured in the project.
- **Deploy events** come from a generic webhook, GitHub Deployments, or optionally Coolify.
- **Local agent** (Windows, `tracker://` protocol, `scripts/local-agent/`) runs analysis on the user's machine with an allow-list of tools, so malicious issue text (prompt injection) cannot run arbitrary commands.

## Architecture

- Fastify + TypeScript, run directly by `tsx`.
- Postgres + Drizzle ORM; `LISTEN/NOTIFY` is turned into Server-Sent Events for realtime updates.
- React 19 + TanStack Query + Vite; drag and drop with dnd-kit.
- Web Push notifications, iCal feed, Zod validation.
- Single instance by design: timers and presence live in the process.

## Where to review the code

- `src/server/service.ts` - issue, status, label and activity logic.
- `src/server/rules.ts` - domain rules (Done requires change notes, identifier parsing, commit references).
- `src/server/mcp.ts` - the MCP server and its tools.
- `src/server/analysis.ts` - structured analysis and decisions.
- `src/server/relations.ts` - blocks, duplicates and related links.
- `src/server/sprints.ts` - sprint lifecycle and review.
- `src/server/deploys.ts` - deploy status tracking.
- `src/server/hooks.ts` - GitHub and deploy webhooks, commit linking.
- `src/server/demo/` - demo mode: seed data, simulated agent, hourly reset.
- `src/web/Board.tsx` - kanban board with drag and drop.
- `src/web/IssuePage.tsx` - the issue view with analysis and decisions.
- `plugin/` - Claude Code plugin: skills and worklog hook.
- `scripts/local-agent/` - Windows local agent installer and handler.
- `tests/` - Vitest suites against a real Postgres.

## Run locally

```bash
docker compose -p tracker up -d        # Postgres on localhost:5434
npm ci
npm run dev                            # API on :3000, migrations run at start
npm run dev:web                        # UI on :5173, proxied to the API
```

Log in without GitHub: start the API with `DEV_LOGIN=1` and open `http://localhost:5173/auth/dev?login=you` (ignored when `NODE_ENV=production`).

Demo mode: start the API with `DEMO_MODE=1`. Sample data for an empty database: `npx tsx scripts/seed-demo.ts`.

## Configuration

Copy `.env.example`. Only `DATABASE_URL` is needed to start; everything else enables a feature.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (default `postgres://tracker:tracker@localhost:5434/tracker`). |
| `BASE_URL` | for login, MCP | Public URL; used for the OAuth callback and links in MCP/plugin output. |
| `PORT` | no | HTTP port (default 3000). |
| `NODE_ENV` | no | `production` disables `DEV_LOGIN`. |
| `DEV_LOGIN` | no | `1` enables `/auth/dev?login=...` for local development. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | for login | GitHub OAuth App; callback `${BASE_URL}/auth/callback`. |
| `ADMIN_LOGINS` | no | Comma-separated GitHub logins that become admins on first login. |
| `APP_TIMEZONE` | no | IANA time zone for meeting hours and default sprint review (default `UTC`). |
| `APP_LOCALE` | no | Language of server-sent messages (Discord, push, reminders): `en` (default) or `pl`. |
| `DEMO_MODE` | no | `1` runs the public demo: guest sessions, tour, simulated agent, hourly reset. |
| `DEMO_RESET_MINUTES` | no | Demo reset interval in minutes (default 60). |
| `PUBLIC_REPO_URL` | no | Repository link shown on the landing page. |
| `GITHUB_WEBHOOK_SECRET` | for commit linking | HMAC secret of the GitHub webhook (`/hooks/github`, push and deployment_status). |
| `GITHUB_API_TOKEN` | no | Token for GitHub API calls made by the server (avoids rate limits). |
| `DEPLOY_WEBHOOK_SECRET` | for deploy webhook | Secret sent in `X-Webhook-Secret` to `/hooks/deploy`. |
| `COOLIFY_API_URL`, `COOLIFY_API_TOKEN`, `COOLIFY_WEBHOOK_SECRET` | optional | Coolify deploy source. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | for Web Push | VAPID keys and contact (`mailto:`) for push notifications. |
| `UPLOADS_DIR` | no | Where uploaded images are stored (default `data/uploads`). |
| `LOG_LEVEL` | no | Fastify log level (default `info`). |

## Deploy-status webhook

A project with deploy source "webhook" accepts deploy events from any CI:

```bash
curl -X POST "$BASE_URL/hooks/deploy" \
  -H "X-Webhook-Secret: $DEPLOY_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"project":"ACME","sha":"'"$GITHUB_SHA"'","status":"finished"}'
```

`status` is one of `queued`, `in_progress`, `finished`, `failed`. As a GitHub Actions step:

```yaml
- name: Report deploy to Exponential
  if: always()
  run: |
    curl -fsS -X POST "${{ secrets.TRACKER_URL }}/hooks/deploy" \
      -H "X-Webhook-Secret: ${{ secrets.DEPLOY_WEBHOOK_SECRET }}" \
      -H "Content-Type: application/json" \
      -d '{"project":"ACME","sha":"${{ github.sha }}","status":"${{ job.status == 'success' && 'finished' || 'failed' }}"}'
```

## Database migrations

Migrations live in `drizzle/` and run at server start. The history was squashed into a single `0000_baseline.sql` generated from `src/db/schema.ts`. Its `when` in `drizzle/meta/_journal.json` is deliberately set to the timestamp of the last migration before the squash: the Drizzle migrator applies only migrations whose `when` is greater than the latest one recorded in the database, so existing databases (already at that migration) skip the baseline, and new databases create the schema from it.

Generate a new migration after editing the schema with `npm run db:generate`.

## Tests

```bash
npm test
```

68 Vitest tests run against a real Postgres (the one from `docker compose`); the service tests create their own `tracker_test` database from scratch. `npm run typecheck` runs `tsc --noEmit`.

## Limitations

- Single instance: timers, presence and realtime fan-out live in the process.
- Login is GitHub-only.
- The local agent is Windows-only.
- The UI is available in English and Polish.
- In the public demo, GitHub login, API tokens/MCP, the local agent, integrations and administration are disabled.

## License

MIT, see [LICENSE](LICENSE).
