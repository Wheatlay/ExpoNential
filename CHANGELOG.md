# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Server [1.3.35] - 12.11.2026

- MCP `save_meeting`: schedules a fixed-time meeting in a project (title, start with UTC offset, end or length, agenda, link, attendees; default whole team, 60 min), with the usual notifications and reminders.

## Server [1.3.34] - 09.11.2026

- Activity reads easier: no empty "worked in Claude Code" entries, no separate commit line when the commit is already in a Claude Code entry (linked there), one avatar per series of one person, minor changes dimmed, field edits indented, sparkle icon for Claude work.
- Testing and Done cards (and the issue header) show the environment all the issue's commits reached (Stage, Prod).
- Board cards show both sides of a blocking relation (Blocks X) and remove a relation with the x on its pill.

## Server [1.3.33], Agent [0.4.24] - 09.11.2026

- The Claude Code worklog no longer keeps the conversation: the "Asked" list is gone from the issue history and MCP, the server drops prompts sent by older agents and a migration erases the stored ones; the agent stops collecting them.

## Agent [0.4.23] - 09.11.2026

- Check for updates no longer installs by itself: it shows the update card, the install starts from its Update button.

## Server [1.3.32], Agent [0.4.22] - 09.11.2026

- Change notes (HUMAN/AI) are marked Outdated when a commit lands after they were written: badge on the issue, Done asks about it, MCP get_issue returns changeNotesStale.
- close-ticket updates existing notes instead of rewriting them (approved HUMAN lines stay).
- Agent: when a Claude Code session commits after the notes were written, it asks Claude to update them before the turn ends.
- Start work button renamed to Open in Claude Code; the default prompt enters plan mode first.

## Server [1.3.31] - 09.11.2026

- Default Start work prompt asks Claude Code to write the plan in plan mode (EnterPlanMode, then ExitPlanMode), so it opens as an editable, commentable plan instead of chat text. Projects with their own Start work template need the line added by hand.

## Server [1.3.30], Agent [0.4.21] - 09.11.2026

- Start work through the agent keeps at most one waiting request per person: clicking several times before the PC picks it up opens one Claude Code tab (the last click), not one per click.
- Agent: rescan also replaces a repo folder set by hand (Choose folder) or cloned when that folder no longer exists; a folder that exists is never replaced.

## Server [1.3.29], Agent [0.4.20] - 09.11.2026

- Start work when your PC has no folder for the project repo no longer opens Claude Code in whatever editor window was active (often another repo): it only copies the prompt, shows the warning, opens Settings › My AI at the PC's Repos and asks the agent to rescan right away.
- Requesting an analysis asks the online PCs of project members that lack the repo to rescan right away.
- Agent: repo discovery is event-driven (agent start, Rescan, Start work or analysis without the repo); the timed pass runs every 60 minutes as a safety net (was 5).
- Agent: clicking Update while the automatic update started by "Check for updates" is already installing showed "update failed" before the restart; the card now shows the install in progress.

## Server [1.3.28], Agent [0.4.19] - 09.11.2026

- Start work no longer does nothing when your PC has no working folder for the project repo: the agent used to skip the request silently while the browser said "Opening in VS Code". Now the browser opens the editor link itself, copies the prompt and warns that the repo folder needs to be set in Settings › My AI.
- Start work through the agent shortens long prompts the same way as the browser link (Windows cuts app links over ~2000 characters).
- Agent: a repo folder found automatically and later moved (e.g. into another folder on the Desktop) is found again at its new place on the next scan, instead of staying broken.

## Server [1.3.27] - 06.11.2026

- Duplicates: new relation "duplicate of" (issue page, Add relation menu, MCP `set_relation` with `duplicate_of` / `duplicated_by`, `get_issue` returns duplicateOf / duplicatedBy). Marking an issue as a duplicate moves it to the project's Duplicate status. Dragging a card to the Duplicate column or picking that status first asks for the original; closing the list changes nothing. Stored in issue_relations with kind `duplicate` (no migration).
- Board options: the "Show Backlog / Canceled columns" switch is replaced by a collapsed "Hidden columns" row (n of total shown) that expands to one switch per hidden column (Backlog, Canceled, Duplicate). The old switch carries over as all shown.

## Agent [0.4.18] - 05.11.2026

- Agent in the tray no longer keeps ~160 MB: the settings window and the card window (consents, updates, notifications) are closed for real a minute after they are hidden, instead of staying alive until the agent exits. Idle: 1 process, ~57 MB (was 7 processes, ~215 MB after the first card).
- The tracker -> expo plugin migration works: it failed on every start for everyone who had the old plugin ("Plugin expo not found in marketplace expo"), because the old marketplace with the same URL blocked adding the new one.
- Dev tool `agent/tools/devwin.mjs key` dispatches the key in the page (Escape did nothing in a dev window without focus).

## Server [1.3.26] - 05.11.2026

- Project history (Settings › History, project admins): who added, removed or changed the role of members, created or revoked invite links, created the project, and changed which settings (names of the fields only; secrets such as the Discord webhook are never stored), with date and time. 100 entries per page, Load more for older ones. Migration 0038 adds project_log; new endpoint GET /api/projects/:key/log.

## Server [1.3.25], Agent [0.4.17] - 05.11.2026

- GitHub repo field (Settings › Integrations): a pasted URL (`https://github.com/owner/name.git`, `git@github.com:owner/name.git`) is reduced to `owner/name`, the repo is checked on GitHub (found / not found), and repos found on your own PCs are offered as one-click suggestions (only names, never paths; teammates' PCs are not used). A new switch lets agents clone the repo.
- Settings › My AI: each PC has a Repos section (state per project, Choose folder, Clone, Rescan sent to the agent; needs agent 0.4.17). The "no PC has the repo" pill on an analysis opens it.
- Discord: a Test button sends a test message to the project channel. Meeting place: recent places from the project's meetings as quick picks.
- Agent heartbeat carries the repos found on the PC (`found`); new endpoints repo-suggestions, repo-action, repo-actions, repo-check, discord-test, recent-places.
- Meetings: an agenda field (markdown, issue IDs become links) in new meetings, polls and fixed meetings; editable by the organizer or a project admin. Not sent in notifications or .ics.
- Phone/tablet: the poll dialog shows one card per time instead of the wide vote table; Display › Rows groups the list, ID/Assignee/Priority switch row parts, board-only options are greyed out; list+preview shows the title before the properties.
- Agent 0.4.17: reports repo names found on the PC, looks for repos every 5 min, runs Clone / Choose folder / Rescan from Settings, and runs other people's requests in a reusable worktree per project (data folder/worktrees/KEY, reset to the default branch, ignored files such as node_modules kept); own requests still run in place.
- Polls: a poll whose times have all passed expires quietly (no notification), stays greyed in the calendar and opens read-only with "No time was set"; a single past time can no longer be voted on, proposed or picked and is greyed in the poll dialog.
- Polls: when every invited person said yes to the same future time, it is picked automatically (the earliest such time), and everyone gets a push. When everyone has voted but there is no agreement, the organizer gets one push (a new time re-arms it) and the calendar lists the poll under "Ready to pick".
- Report a bug or idea: a flag button next to the bell and a Ctrl+K command open a small dialog (Bug / Idea, title, description with pasted screenshots). It creates an issue in the project a workspace admin picks in Settings › Workspace (labels Bug / Feature, page, browser and app version attached for bugs); the reporter does not need to be a member of that project. Limit: 10 per person per hour.
- Migration 0037 adds meetings.all_voted_notified_at.

## Server [1.3.24] - 05.11.2026

- Deploys are detected automatically: Settings › Integrations no longer asks for a deploy source. GitHub Deployments events, Coolify apps built from the project repo and the CI webhook create their environments from the first event (shown with a source label); removed ones are not re-added, and a manually added environment can still be created.

## Server [1.3.23], Agent [0.4.16] - 05.11.2026

- Analyze needs a project repo: without one the button explains it instead of starting an analysis that no PC can run.
- An analysis that no PC takes within 24 hours now fails with a message instead of waiting forever; the failure is also written to the issue activity (as is any failure reported by a PC). Clicking Analyze twice no longer adds a second "requested" entry.
- The analysis bar says why it is waiting: team queue off, no PC online, no PC with the repo, or waiting for the owner's consent.
- Project admins can add people to and remove them from any tag; other members can only change their own membership.
- Any project member can create a label right from the issue page.
- Unread comments: if you only appear in an issue through a mention, only comments from that mention on count as new.
- Settings › Notifications: shows whether this browser's push subscription is still registered, can send a test push, lists the projects with a Discord channel, and lets you choose whether the analysis notification stays until closed.
- A failed deploy is posted to the project's Discord channel (environment and commit).
- An agent error that was followed by a successful run on an online PC is no longer shown as a problem.
- Choose your editor (VS Code, Cursor, Windsurf or terminal) in Settings; Start work opens the repo window in it through the agent on your PC, or copies the prompt when no PC is online.
- Plugin and MCP server renamed from tracker to expo: skills are now expo:analyze-ticket and expo:close-ticket, tools mcp__expo__*. Reinstall the plugin (`claude plugin install expo@expo`) and re-add the MCP server under the name expo.
- Agent window: Pair again, Rescan and a list of consents.
- Login in two steps (e-mail, then password; an account added by e-mail sets its password here). The "Allow" field is gone from Settings › Accounts; Accounts shows each account's projects and role.
- Issue page: activity newest first with an order toggle, images in the description edited as short `![image N]`, title and description flash when someone else changes them, analysis toast stays until the analysis ends (can be turned off).
- Settings is at the bottom of the sidebar, the bell is bigger, people with no issues are shown on the board by default, Settings entries a non-admin cannot change are grayed out.
- Mouse wheel over the project name scrolls projects like a drum; the calendar day header and long titles in pills and toasts no longer overlap.
- Issue cards have their shadow back (the token was never defined).
- Start work goes through the agent only with agent 0.4.16+ and one PC online; otherwise the editor link opens as before.
- Agent: the old tracker plugin and MCP server are removed only after expo installs; custom project prompts are migrated to the new names.

## Server [1.3.22] - 04.11.2026

- An account added by e-mail in Settings › Accounts sets its password on the first login: enter the e-mail and a new password on the login page.
- "Reset password" in Accounts also works for accounts without a password.
- Settings › General no longer crashes the page when you switch projects.

## Server [1.3.21] - 04.11.2026

- Issue page: a label can be removed with the ✕ on its chip (on hover; always visible on touch).

## Server [1.3.20], Agent [0.4.15] - 04.11.2026

- The agent shows a card when your own analysis starts on your PC (e.g. requested from the phone). Switch "Notifications for my analyses" off in the agent window to hide it.
- An analysis that cannot confidently assign a type no longer adds a Bug / Feature / Investigate label.
- Phone and fold: issue properties are grouped with dividers, the analysis bar keeps its buttons readable, the sidebar rail badge is no longer cut off, the calendar panel spans the full width.

## Server [1.3.19] - 04.11.2026

- Project settings › AI agent: with the team queue off, the PCs in the list are grayed out and their mode is shown as inactive, with the reason on hover.

## Server [1.3.18], Agent [0.4.14] - 04.11.2026

- The agent window closes when you click outside it (another program comes to the front).
- Usage tab in the agent window shows who used how much (30 days, and the last 24 h).
- Changing a PC's team mode or limit (on the web or in the agent window) updates your open pages right away, without a reload.

## Server [1.3.17], Agent [0.4.13] - 04.11.2026

- The agent window opens instantly and without a white flash: closing only hides it, and the first open shows it once the page is drawn.
- Limit for others per day is 10x smaller (100k, 500k, 1M, 5M) and can also be set in the agent window (Usage tab), next to today's use for others.

## Server [1.3.16], Agent [0.4.12] - 04.11.2026

- Language is saved in your profile: every browser, the phone and the agent window use it (until you choose, the browser or Windows language is used; an earlier choice in this browser moves to the profile by itself).
- The language setting is a list: English, Polski, and "Help translate…" with a guide to adding a language (docs/translating.md).

## Agent [0.4.11] - 04.11.2026

- Agent window: "Check" next to the version; "Mute for 24 h" and notifications are grayed out with the reason when you do not take requests from others; the Analyses tab is now Usage (30-day summary for you and for others, then recent analyses); cleaner Repo tab (status, folder, where it came from, actions as links); the log wraps lines, shows local dd.mm times and opens at the newest entries.

## Agent [0.4.10] - 04.11.2026

- After a self-update the Start menu shortcut opens the window again (the new process did not listen while the old one was closing).

## Agent [0.4.9] - 04.11.2026

- The agent window no longer turns into a dead "Not responding" window after Escape or clicking outside it (it was closed without being destroyed).
- No white window flashing in the top-left corner when the window opens; dark background before the page paints.
- Close button; "Check for updates" under "Update automatically"; "Mute for 24 h" under team requests; "Not taking" shown in red.
- The Start menu shortcut opens the window also when the agent was not running.
- Dev mode for testing (EXPONENTIAL_DEV=1) and a goroutine dump command for diagnosing hangs.

## Agent [0.4.8] - 04.11.2026

- The agent window no longer hangs after a click: setting changes run in the background, the state read answers within 2 s (last known state otherwise), and any action slower than 3 s is written to the log by name.

## Server [1.3.15] - 04.11.2026

- My AI: one main "Connect AI" button; an empty "Your PCs" card offers a "Connect this PC" link (opens the wizard at the agent step).

## Server [1.3.14] - 04.11.2026

- My AI: with nothing connected, "Connect AI" sits in the empty row like "Connect this PC" (it had a hidden dot that pushed its label off-center).

## Server [1.3.13] - 04.11.2026

- Your PCs: the Claude Code setup line is gone; a "Claude Code: incomplete setup" warning appears only when an account is missing the tracker or the work trace.

## Server [1.3.12] - 04.11.2026

- Your PCs: team requests and the limit can be changed while the PC is offline; "Without asking" is turned on only in the agent window on that PC (grayed out on the web with the reason). Claude Code setup reads "tracker and work trace in all accounts (3)".

## Agent [0.4.7] - 04.11.2026

- "Exponential agent" in the Start menu: starts the agent if it is not running and opens its window (also added to existing installs at start; removed on uninstall).

## Agent [0.4.6] - 04.11.2026

- The agent window is the one place for settings; the right-click tray menu keeps only shortcuts (Settings, Open Exponential, Mute for 24 h, Quit).
- The window tabs look like tabs; the window is shorter; OLED theme added.
- The window no longer stops updating when an answer from the agent gets lost; window errors are written to the log.

## Agent [0.4.5] - 04.11.2026

- Updates install by themselves by default (after a running analysis finishes); "Update automatically" in the agent window turns it off, then the update is only offered. The agent checks for new versions every 6 h.

## Server [1.3.11] - 04.11.2026

- Settings › My AI: one "AI clients" list (sign-ins and API keys together), "Your PCs" always shown (with "Connect this PC" when empty); each PC row shows online state, version and update status without overlapping; team settings are grayed out with the reason while the PC is offline or outdated.
- Pairing the same PC again replaces the old entry instead of adding a duplicate; agent sign-ins are no longer listed as AI clients. Old orphaned agent sign-ins and duplicate PCs were cleaned up (scripts/cleanup-agents.sql).

## Server [1.3.10] - 04.11.2026

- Connect AI shows the state of the client you picked (Claude Code, Codex or Cursor), not of whichever client is connected; work trace is grayed out for clients other than Claude Code and does not count toward progress; the wizard opens on the client you already use.

## Server [1.3.9] - 04.11.2026

- Connect AI: "Other ways to connect" always opens a step; finished steps show their status instead of "Waiting"; one download button and one client switch; "Download again" once everything is set up; one footer button (Later / Done).

## Server [1.3.8] - 04.11.2026

- Board cards show which PC is running the analysis ("Running on DESKTOP-…").
- The highlight glow is back on "asked you" cards, the question banner and the demo tour.

## Server [1.3.7] - 04.11.2026

UI and UX consistency pass.

- One vocabulary everywhere: "PC" for the machine (also in Polish), "agent" for what runs on it, "AI" for features; paths written "Settings › My AI". Start buttons read "Start work".
- Unavailable options are grayed out with the reason when knowing about them helps (Deep, Today, Carry over all); the reason can be read from the keyboard too. Clutter stays hidden (empty counters, admin-only settings).
- Dialogs: Cancel on the left, the main action on the right, destructive actions on the left edge; New issue has a Cancel button.
- Colors for projects, labels and statuses are picked from the palette.
- Explanatory sentences moved into tooltips; empty and error views share one layout (Inbox, Calendar, Sprint review, issue not found, empty board).
- Dates are dd.mm.yyyy everywhere; poll days read "Tue 04.11".
- Duplicate names (e.g. labels) show "This name is already taken" instead of "Server error"; server errors are translated.
- Visual cleanup: sizes, shadows and widths follow the design system.
- Connect AI no longer offers the removed terminal login.

## Server [1.3.6] - 03.11.2026

- Opening an uploaded image no longer crashes the server (regression in 1.3.5).

## Server [1.3.5], Agent [0.4.4] - 03.11.2026

Fixes from the full code audit. Agents older than 0.4.4 get no work until they update.

Security:
- AI clients' tokens can no longer approve sign-ins themselves; the device sign-in page never takes the code from a link; the agent can only be connected by pairing.
- Only the agent's own sign-in can take analyses, report runs or change computers.
- Agent sign-ins are listed in "Connected AI clients" and can be revoked. "Sign out everywhere" in the profile; a password reset also revokes AI sign-ins and API keys. API keys expire after 180 days without use.
- Rate limits see the real client address (`TRUST_PROXY`, default one proxy); login is also limited per e-mail.
- Admins can be set by GitHub id (`ADMIN_GITHUB_IDS`).
- Demo blocks can't be bypassed with encoded addresses; uploads are checked by content and size, 200 MB per person.
- Each project has its own deploy webhook secret (shown in project settings).
- Analyses for other people: the agent forces the default permission mode, blocks secret files on the whole computer (agent data, Claude credentials, ~/.ssh, ~/.aws and more) and can only touch the one issue in the tracker. Codex computers don't take other people's analyses. The server can't switch a computer to automatic team mode on its own.
- Agent updates must be signed. Agent sign-in tokens are encrypted on disk (Windows). Repo paths from the server are checked (no network paths, no escaping the data folder).
- Meeting links must be http(s); Discord notifications can't ping @everyone through a title.

Bugs and consistency:
- "Start on my PC" works with the agent again (phone); the old tracker:// launcher is gone. The agent reports broken repo folders, and such a computer hands the analysis back to the queue instead of failing it.
- Errors show a message with Retry instead of a blank board, a "not found" issue or the login screen.
- Long log pastes and emoji in commit messages no longer break the work trace; issues opened by the work trace are not marked as read.
- `exponential-agent login` is gone; computers are connected by pairing from Settings > My AI.

Performance and housekeeping:
- Database indexes for the agent queue, inbox and activity; missing foreign keys; logins unique regardless of case; old agent jobs cleaned up hourly.
- The agent's poll wakes on events instead of querying every 2 s.
- The app loads about half as much code up front.
- Dialogs keep keyboard focus inside, tooltips work from the keyboard, toasts are read by screen readers.

## Server [1.3.4], Agent [0.4.3] - 03.11.2026

Security and bugs:
- The agent is recognized by its fixed client id, not by its name: a client registered as "Exponential agent" no longer gets agent rights or an MCP key, and that name can't be registered.
- Removing a computer in Settings revokes its sign-in and its MCP key; it stays removed until it is paired again. Pairing again (reinstall) works right away.
- Consent: a job whose requester or owner is unknown is not run (it used to be). After pairing or login the agent re-reads who its owner is.
- Analyses for other people always run without the repo's own Claude Code settings and hooks; more secret files are blocked (secrets*.json, appsettings.*.json, id_rsa*, *.keystore, credentials*).
- An agent update waits for a running analysis to finish instead of killing it, and takes no new work while updating.
- The owner's own analyses come first in the queue, and jobs a computer declined no longer block the next ones.
- @mentions work for logins that are e-mail addresses; server and app use one parser (trailing punctuation is not part of the mention).
- Deploy environments: exactly one is production, the first one added is production.
- The Coolify webhook no longer fails when the Coolify API is not configured.
- MCP save_issue with only a #tag no longer clears the open question.
- Demo: profile, project logo and deploy environments can't be changed.

Consistency and UX:
- The bell shows only issues from projects you are still a member of; inbox events go only to their recipients.
- Connect AI with Cursor: steps 2 and 3 are shown as unavailable, step 1 is done only when Cursor is connected; "Close" until the goal is fully done.
- Settings: the personal section is "My AI" (the project section stays "AI agent"); /settings/ai opens it; offline pill and an id hint for computers with the same name.
- A poll waiting for your vote is in the bell and the Calendar counter, no longer in the banner.
- Board counters appear together with the cards.

Housekeeping:
- The Claude Code hooks call the agent directly (the installer adds its folder to the user PATH); the Node script is gone. Plugin 1.2.0 named Exponential. The installer re-adds the plugin marketplace and reports when that fails.
- The legacy PowerShell installer is no longer served.
- Lighter /api/me and job start queries.

## Server [1.3.3], Agent [0.4.2] - 03.11.2026

- The agent reports what is actually set up on the computer, read from config files: the tracker MCP server and plugin for every Claude account (terminal and VS Code / Cursor extension share them), Codex, Cursor. Connect AI shows "Done" right after install and goes back to "Waiting" when something is removed; the computer card in Settings > AI shows "issues 2/2 · work trace 2/2" with the accounts in a tooltip. Without the agent, usage from the last 14 days still counts (work trace too, no longer "ever").
- The downloaded file name carries the version again (taken from GitHub's first redirect).

## Server [1.3.2], Agent [0.4.1] - 03.11.2026

- Wording follows the current setup everywhere: "Settings > AI" instead of "Settings > Claude Code", "agent" instead of "PowerShell command" / "install command" / "old scripts", in the issue page, phone board, settings, Connect AI and server errors.
- The agent's mute action reads "Mute for 24 h" in the toast too, like the tray menu and window.

## Server [1.3.1], Agent [0.4.0] - 03.11.2026

- The tray window has tabs: General (as before, plus Show log / Copy log with tokens removed), Repo (projects with folder, source and state; "Choose folder" opens the Windows folder picker), Analyses (last 20 runs: time, issue, for whom, tokens, result with the reason).
- Updates without opening a window: a dot on the tray icon and a toast "Version X available" → Update → download progress → restart → "Updated to X".
- Uninstall, install errors and "link expired" are shown in the Exponential window; system message boxes only when WebView2 is missing.
- Uninstalling removes the computer for good: the agent is stopped before it is unregistered, and the server does not re-create a computer removed within the last hour.
- The downloaded file carries the agent version in its name (`exponential-agent-0.4.0.exe`).

## Agent [0.3.1] - 03.11.2026

- "Uninstall…" in the tray and the settings window works again: it opens the window with Disconnect in its own process, and asks Yes/No when that window cannot open. Each agent window uses its own WebView2 data folder per process, so a running agent no longer blocks a second window.

## Server [1.3.0], Agent [0.3.0] - 03.11.2026

- Installer sets up every level up to the goal chosen in Connect AI: issue access in Claude Code (MCP on every account, key issued during pairing), work trace (plugin), background agent. Connect AI is one "Download and run" button; manual commands moved under a link.
- Before running an analysis someone else requested, the agent asks in an Exponential-styled toast: "Allow for 24 h", "Just this once", ✕ to decline, "Mute 24 h"; 2 minutes to answer. Each computer has one team mode: Ask (default), Without asking, Not taking; the per-project opt-in is gone (computers that had joined got "Without asking").
- Claude usage limit: the agent retries on the next Claude account (`~/.claude-accounts`), and only when all are limited returns the request to the queue and pauses until the reset; Settings show "Claude limit until HH:MM" instead of an error. Real Claude errors are reported with their reason.
- Tray: left click opens a small settings window (team mode, notifications, autostart, mute, theme system/dark/light, update, uninstall); the agent updates itself from GitHub releases after checking SHA256.
- Usage in tokens instead of dollars; the daily limit for others is in tokens.

## Agent [0.2.4] - 03.11.2026

- Tray menu: state and agent version, "AI settings", "Start with Windows" toggle, "Uninstall…" (opens the installer window with Disconnect).

## Server [1.2.2], Agent [0.2.3] - 03.11.2026

- A connection error that healed by itself (for example the server restarting during a deploy) is no longer shown as "Error" or marked for attention once the computer is back online; real errors stay.
- The agent reports errors without the request's query string (device id, repo map).

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
