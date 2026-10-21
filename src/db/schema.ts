import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb, primaryKey, uniqueIndex, index, doublePrecision, bigint,
} from 'drizzle-orm/pg-core';

export const STATUS_TYPES = ['backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'] as const;
export type StatusType = (typeof STATUS_TYPES)[number];

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  githubId: bigint('github_id', { mode: 'number' }).unique(),
  login: text('login').notNull().unique(),
  name: text('name').notNull(),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  isAdmin: boolean('is_admin').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Ostatnia aktywność (zamknięcie ostatniej karty trackera): kropka "był niedawno".
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  // Sekret w linku subskrypcji kalendarza (.ics), bez sesji.
  calendarToken: text('calendar_token').unique(),
  // Lokalna analiza (tracker://) zainstalowana na komputerze użytkownika; ustawia instalator.
  localAgentAt: timestamp('local_agent_at', { withTimezone: true }),
});

/** Projekt = osobny zespół: własny prefiks numerów, członkowie, statusy, etykiety i sprinty. */
export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#5e6ad2'),
  discordWebhookUrl: text('discord_webhook_url'),
  // Domyślne miejsce spotkań (link do kanału głosowego Discorda): nowe spotkania i sprint review.
  meetingLocationUrl: text('meeting_location_url').notNull().default(''),
  sprintLengthDays: integer('sprint_length_days').notNull().default(14),
  // Domyślny termin sprint review: ostatni dzień sprintu o tej godzinie (HH:MM, czas Polski).
  reviewTime: text('review_time').notNull().default('15:00'),
  reviewMinutes: integer('review_minutes').notNull().default(45),
  // Szablony poleceń dla Claude Code (guziki Start, Analyze, okno Done). Pusty = domyślny z prompts.ts.
  promptStart: text('prompt_start').notNull().default(''),
  promptAnalyze: text('prompt_analyze').notNull().default(''),
  promptClose: text('prompt_close').notNull().default(''),
  // Repo GitHub projektu ("owner/name"): lokalna analiza, commity z webhooka i deploye tylko z niego.
  githubRepo: text('github_repo').notNull().default(''),
  deployBranch: text('deploy_branch').notNull().default('master'),
  // Skąd bierzemy deploye (oznaczane w zadaniach). Pusty = projekt bez śledzenia deployów.
  deploySource: text('deploy_source').$type<'' | 'webhook' | 'github' | 'coolify'>().notNull().default(''),
  // Odnośnik źródła: github = środowisko (opcjonalne), coolify = uuid aplikacji.
  deploySourceRef: text('deploy_source_ref').notNull().default(''),
  // Domyślny widok boardu dla członków (Display + filtry), ustawia admin projektu. null = wartości z kodu.
  defaultView: jsonb('default_view').$type<Record<string, unknown>>(),
  // Ostatnio nadany numer zgłoszenia: numer usuniętego zgłoszenia nie wraca do obiegu.
  issueSeq: integer('issue_seq').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectMembers = pgTable('project_members', {
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<'admin' | 'member'>().notNull().default('member'),
}, (t) => [primaryKey({ columns: [t.projectId, t.userId] })]);

export const statuses = pgTable('statuses', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').$type<StatusType>().notNull(),
  color: text('color').notNull(),
  position: integer('position').notNull(),
  hiddenOnBoard: boolean('hidden_on_board').notNull().default(false),
  // Rola specjalna: need_info = status "zadaj pytanie", testing = status testów.
  role: text('role').$type<'need_info' | 'testing'>(),
}, (t) => [uniqueIndex('statuses_project_name_uniq').on(t.projectId, t.name)]);

export const labels = pgTable('labels', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull(),
}, (t) => [uniqueIndex('labels_project_name_uniq').on(t.projectId, t.name)]);

export const sprints = pgTable('sprints', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  // planned -> active -> ended (czeka na przegląd) -> reviewed
  status: text('status').$type<'planned' | 'active' | 'ended' | 'reviewed'>().notNull().default('planned'),
  reviewNotes: text('review_notes').notNull().default(''),
}, (t) => [uniqueIndex('sprints_project_starts_uniq').on(t.projectId, t.startsAt)]);

export const issues = pgTable('issues', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Numer unikalny w obrębie projektu (WEB-12 i ACME-12 to różne zadania).
  number: integer('number').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  statusId: integer('status_id').notNull().references(() => statuses.id),
  assigneeId: integer('assignee_id').references(() => users.id),
  creatorId: integer('creator_id').references(() => users.id),
  priority: integer('priority').notNull().default(0),
  parentId: integer('parent_id'),
  sprintId: integer('sprint_id').references(() => sprints.id, { onDelete: 'set null' }),
  sortOrder: doublePrecision('sort_order').notNull().default(0),
  analysis: text('analysis').notNull().default(''),
  // Analiza w sekcjach i decyzjach (src/server/analysis.ts); `analysis` to jej markdown. Null = sam tekst.
  analysisData: jsonb('analysis_data'),
  analysisRequestedAt: timestamp('analysis_requested_at', { withTimezone: true }),
  analysisUpdatedAt: timestamp('analysis_updated_at', { withTimezone: true }),
  changeHuman: text('change_human').notNull().default(''),
  changeAi: text('change_ai').notNull().default(''),
  // Need Info: kogo pytamy i o co. Czyszczone, gdy zadanie wychodzi z Need Info.
  infoFromId: integer('info_from_id').references(() => users.id, { onDelete: 'set null' }),
  infoQuestion: text('info_question').notNull().default(''),
  // Kto zapytał; pytanie "do każdego" (infoFromId = null) widzą wszyscy poza nim.
  infoById: integer('info_by_id').references(() => users.id, { onDelete: 'set null' }),
  // Status sprzed Need Info: po odpowiedzi zadanie samo do niego wraca.
  infoPrevStatusId: integer('info_prev_status_id'),
  // Komentarz z pytaniem: odpowiedź zostanie podpięta pod niego jako wątek.
  infoCommentId: integer('info_comment_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('issues_status_idx').on(t.statusId), index('issues_parent_idx').on(t.parentId),
  uniqueIndex('issues_project_number_uniq').on(t.projectId, t.number),
]);

export const issueLabels = pgTable('issue_labels', {
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  labelId: integer('label_id').notNull().references(() => labels.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.issueId, t.labelId] })]);

export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').references(() => users.id),
  body: text('body').notNull(),
  // Odpowiedź na komentarz (np. na pytanie z Need Info) wyświetlana pod nim.
  replyToId: integer('reply_to_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('comments_issue_idx').on(t.issueId)]);

export type ActivityPayload =
  | { kind: 'created' }
  | { kind: 'status'; from: string | null; to: string }
  | { kind: 'assignee'; from: string | null; to: string | null }
  | { kind: 'priority'; from: number; to: number }
  | { kind: 'labels'; added: string[]; removed: string[] }
  | { kind: 'field'; field: 'title' | 'description' | 'analysis' | 'change_human' | 'change_ai' }
  | { kind: 'analysis_requested' }
  | { kind: 'decision'; question: string; answer: string | null }
  | { kind: 'sprint'; to: string | null }
  | { kind: 'parent'; to: number | null }
  | { kind: 'commit'; sha: string; message: string; url: string; author: string }
  | { kind: 'deploy'; sha: string }
  | { kind: 'worklog'; session: string; repo: string; files: string[]; commits: { sha: string; message: string }[]; prompts: string[]; updatedAt: string }
  | { kind: 'question'; to: string; question: string }
  | { kind: 'answered'; by: string; backTo: string | null }
  | { kind: 'relation'; action: 'added' | 'removed'; relation: 'waits_on' | 'blocks' | 'related'; other: number };

export const activity = pgTable('activity', {
  id: serial('id').primaryKey(),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  actorId: integer('actor_id').references(() => users.id),
  viaAi: boolean('via_ai').notNull().default(false),   // zmiana przez MCP (agent na tokenie tej osoby)
  payload: jsonb('payload').$type<ActivityPayload>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('activity_issue_idx').on(t.issueId)]);

export const issueCommits = pgTable('issue_commits', {
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  sha: text('sha').notNull(),
  message: text('message').notNull(),
  url: text('url').notNull(),
  author: text('author').notNull(),
  committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
  deployedAt: timestamp('deployed_at', { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.issueId, t.sha] }), index('issue_commits_sha_idx').on(t.sha)]);

export const deploys = pgTable('deploys', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  sha: text('sha').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const apiTokens = pgTable('api_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (t) => [uniqueIndex('api_tokens_hash_idx').on(t.tokenHash)]);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

/**
 * Relacje między zadaniami. Tylko dwa rodzaje:
 * - 'blocks': from blokuje to (czyli "to czeka na from"),
 * - 'related': symetryczne powiązanie (zapisane raz).
 */
export const issueRelations = pgTable('issue_relations', {
  id: serial('id').primaryKey(),
  kind: text('kind').$type<'blocks' | 'related'>().notNull(),
  fromIssueId: integer('from_issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  toIssueId: integer('to_issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('issue_relations_uniq').on(t.kind, t.fromIssueId, t.toIssueId), index('issue_relations_to_idx').on(t.toIssueId)]);

/** Kiedy użytkownik ostatnio otworzył zadanie: komentarze innych po tej dacie są "nowe". */
/** Widok boardu osoby w projekcie (nadpisuje domyślny projektu), ten sam na każdym urządzeniu. */
export const userViews = pgTable('user_views', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  view: jsonb('view').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.projectId] })]);

export const issueViews = pgTable('issue_views', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  issueId: integer('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.issueId] })]);

// ---------- spotkania ----------

export type MeetingKind = 'poll' | 'fixed' | 'sprint_review';
export type MeetingStatus = 'polling' | 'scheduled' | 'cancelled';
export type Vote = 'yes' | 'maybe' | 'no';

/** Spotkanie całego projektu: ankieta na termin, stały termin albo automatyczne sprint review. */
export const meetings = pgTable('meetings', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  kind: text('kind').$type<MeetingKind>().notNull(),
  status: text('status').$type<MeetingStatus>().notNull(),
  // Puste, dopóki trwa ankieta.
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  locationUrl: text('location_url').notNull().default(''),
  sprintId: integer('sprint_id').references(() => sprints.id, { onDelete: 'cascade' }),
  // Ręcznie przesunięte sprint review nie wraca na termin z ustawień projektu.
  manuallyEdited: boolean('manually_edited').notNull().default(false),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('meetings_project_idx').on(t.projectId, t.startsAt), uniqueIndex('meetings_sprint_uniq').on(t.sprintId)]);

/** Proponowany termin ankiety; każdy członek projektu może dodać swój (z powodem). */
export const meetingSlots = pgTable('meeting_slots', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  proposedBy: integer('proposed_by').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('meeting_slots_meeting_idx').on(t.meetingId)]);

export const meetingVotes = pgTable('meeting_votes', {
  slotId: integer('slot_id').notNull().references(() => meetingSlots.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  vote: text('vote').$type<Vote>().notNull(),
}, (t) => [primaryKey({ columns: [t.slotId, t.userId] })]);

/** Przypomnienia wybrane w spotkaniu: minuty przed startem (1440, 60, 15, 0). */
export const meetingReminders = pgTable('meeting_reminders', {
  meetingId: integer('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  offsetMinutes: integer('offset_minutes').notNull(),
}, (t) => [primaryKey({ columns: [t.meetingId, t.offsetMinutes] })]);

/** Wysłane przypomnienia (z godziną startu), żeby restart serwera nie wysłał drugi raz. */
export const reminderSends = pgTable('reminder_sends', {
  meetingId: integer('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  offsetMinutes: integer('offset_minutes').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.meetingId, t.offsetMinutes, t.startsAt] })]);

/** Kanały powiadomień wybrane przez osobę (nie przez spotkanie). */
export const userNotificationSettings = pgTable('user_notification_settings', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  inApp: boolean('in_app').notNull().default(true),
  push: boolean('push').notNull().default(true),
  discord: boolean('discord').notNull().default(true),
  // Okno z prośbą o zgodę pokazujemy tylko raz.
  notifyPromptShown: boolean('notify_prompt_shown').notNull().default(false),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
