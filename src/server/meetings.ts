import { and, asc, eq, gte, inArray, lte, ne, or } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  meetingReminders, meetingSlots, meetingVotes, meetings, projectMembers, projects, reminderSends, sprints, users,
  type MeetingKind, type Vote,
} from '../db/schema.ts';
import { RuleError } from './rules.ts';
import { publish } from './service.ts';
import { getNotifySettings, sendDiscord, sendPush } from './notify.ts';
import { formatDateTime, formatTime, lastWorkday, zonedDate, zonedToUtc } from './tz.ts';
import { LOCALE, st } from './i18n.ts';
import type { Project } from './projects.ts';

/**
 * Spotkania projektu: ankieta na termin (każdy może zaproponować swój), stały termin
 * i automatyczne sprint review na ostatni dzień sprintu. Bez notatek ze spotkań.
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
export const REMINDER_OFFSETS = [1440, 60, 15, 0] as const;
const DEFAULT_REMINDERS = [60, 15, 0];
const MIN = 60_000;
type Log = { warn: (o: object, m: string) => void };
type Actor = { id: number; name: string };

export function meetingUrl(p: Project, id: number) {
  return `${BASE_URL}/calendar?project=${p.key}&meeting=${id}`;
}

// ---------- odczyt ----------

export type MeetingDto = Awaited<ReturnType<typeof listMeetings>>[number];

/** Spotkania od `since` (domyślnie 14 dni wstecz) plus wszystkie trwające ankiety. */
export async function listMeetings(p: Project, since = new Date(Date.now() - 14 * 864e5)) {
  const rows = await db.select().from(meetings).where(and(
    eq(meetings.projectId, p.id), ne(meetings.status, 'cancelled'),
    or(eq(meetings.status, 'polling'), gte(meetings.startsAt, since)),
  )).orderBy(asc(meetings.startsAt), asc(meetings.id));
  if (!rows.length) return [];
  const ids = rows.map((m) => m.id);
  const [slots, rems] = await Promise.all([
    db.select().from(meetingSlots).where(inArray(meetingSlots.meetingId, ids)).orderBy(asc(meetingSlots.startsAt), asc(meetingSlots.id)),
    db.select().from(meetingReminders).where(inArray(meetingReminders.meetingId, ids)),
  ]);
  const votes = slots.length ? await db.select().from(meetingVotes).where(inArray(meetingVotes.slotId, slots.map((s) => s.id))) : [];
  return rows.map((m) => ({
    ...m,
    reminders: rems.filter((r) => r.meetingId === m.id).map((r) => r.offsetMinutes).sort((a, b) => b - a),
    slots: slots.filter((s) => s.meetingId === m.id).map((s) => ({
      ...s, votes: votes.filter((v) => v.slotId === s.id).map((v) => ({ userId: v.userId, vote: v.vote })),
    })),
  }));
}

async function requireMeeting(p: Project, id: number) {
  const [m] = await db.select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.projectId, p.id)));
  if (!m) throw new RuleError('Meeting not found', 'not_found');
  return m;
}

async function memberIds(p: Project) {
  return (await db.select({ id: projectMembers.userId }).from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(and(eq(projectMembers.projectId, p.id), eq(users.active, true)))).map((r) => r.id);
}

/** Na kanał idzie, chyba że organizator wyłączył u siebie Discorda (sprint review: zawsze). */
async function discordAllowed(m: { createdBy: number | null }) {
  return m.createdBy == null || (await getNotifySettings(m.createdBy)).discord;
}

function checkRange(startsAt: Date, endsAt: Date) {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new RuleError('Invalid date', 'invalid');
  if (endsAt <= startsAt) throw new RuleError('A meeting must end after it starts', 'invalid');
  if (endsAt.getTime() - startsAt.getTime() > 12 * 60 * MIN) throw new RuleError('A meeting can last at most 12 hours', 'invalid');
}

function checkReminders(r: number[]) {
  const bad = r.filter((x) => !(REMINDER_OFFSETS as readonly number[]).includes(x));
  if (bad.length) throw new RuleError(`Reminders must be ${REMINDER_OFFSETS.join(', ')} minutes before`, 'invalid');
  return [...new Set(r)];
}

async function setReminders(meetingId: number, r: number[]) {
  await db.delete(meetingReminders).where(eq(meetingReminders.meetingId, meetingId));
  if (r.length) await db.insert(meetingReminders).values(r.map((offsetMinutes) => ({ meetingId, offsetMinutes })));
}

const changed = (p: Project) => publish({ type: 'meetings', projectKey: p.key });

// ---------- zapis ----------

export type NewMeeting = {
  title: string;
  kind: 'poll' | 'fixed';
  slots?: { startsAt: Date; endsAt: Date }[];
  startsAt?: Date;
  endsAt?: Date;
  locationUrl?: string;
  reminders?: number[];
};

export async function createMeeting(p: Project, actor: Actor, input: NewMeeting, log?: Log) {
  const title = input.title.trim();
  if (!title) throw new RuleError('Title cannot be empty', 'invalid');
  const reminders = checkReminders(input.reminders ?? DEFAULT_REMINDERS);
  let m: typeof meetings.$inferSelect;
  if (input.kind === 'poll') {
    const slots = input.slots ?? [];
    if (!slots.length) throw new RuleError('Propose at least one time', 'invalid');
    slots.forEach((s) => checkRange(s.startsAt, s.endsAt));
    [m] = await db.insert(meetings).values({
      projectId: p.id, title, kind: 'poll', status: 'polling', locationUrl: input.locationUrl?.trim() ?? '', createdBy: actor.id,
    }).returning();
    await db.insert(meetingSlots).values(slots.map((s) => ({ meetingId: m.id, startsAt: s.startsAt, endsAt: s.endsAt, proposedBy: actor.id })));
  } else {
    if (!input.startsAt || !input.endsAt) throw new RuleError('Pick a start and end time', 'invalid');
    checkRange(input.startsAt, input.endsAt);
    [m] = await db.insert(meetings).values({
      projectId: p.id, title, kind: 'fixed', status: 'scheduled', startsAt: input.startsAt, endsAt: input.endsAt,
      locationUrl: input.locationUrl?.trim() ?? '', createdBy: actor.id,
    }).returning();
  }
  await setReminders(m.id, reminders);
  await changed(p);

  const others = (await memberIds(p)).filter((id) => id !== actor.id);
  const url = meetingUrl(p, m.id);
  if (m.kind === 'poll') {
    const n = input.slots!.length;
    const count = st(n === 1 ? '{n} time' : LOCALE === 'pl' && n < 5 ? '{n} times (few)' : '{n} times', { n });
    if (await discordAllowed(m)) await sendDiscord(p, { title: st('Poll: {title}', { title }), description: st('{count} to choose from, you can propose another. Organized by {name}.', { count, name: actor.name }), url, color: 0xf2994a }, log);
    await sendPush(others, { title: `Vote: ${title}`, body: `${actor.name} asks when you can meet (${n} option${n === 1 ? '' : 's'}).`, url, tag: `meeting-${m.id}` }, log);
  } else {
    if (await discordAllowed(m)) await sendDiscord(p, { title: st('New meeting: {title}', { title }), description: `${formatDateTime(m.startsAt!)}${m.locationUrl ? ` · ${m.locationUrl}` : ''}`, url }, log);
    await sendPush(others, { title: `New meeting: ${title}`, body: `${formatTime(m.startsAt!)} · added by ${actor.name}`, url, tag: `meeting-${m.id}` }, log);
  }
  return m;
}

/** Każdy członek może dodać termin do ankiety; jego głos na ten termin to od razu "yes". */
export async function proposeSlot(p: Project, actor: Actor, meetingId: number, input: { startsAt: Date; endsAt?: Date; reason?: string }, log?: Log) {
  const m = await requireMeeting(p, meetingId);
  if (m.status !== 'polling') throw new RuleError('Voting on this meeting is closed', 'invalid');
  const [first] = await db.select().from(meetingSlots).where(eq(meetingSlots.meetingId, m.id)).orderBy(asc(meetingSlots.id)).limit(1);
  const len = first ? first.endsAt.getTime() - first.startsAt.getTime() : 60 * MIN;
  const endsAt = input.endsAt ?? new Date(input.startsAt.getTime() + len);
  checkRange(input.startsAt, endsAt);
  const [dup] = await db.select().from(meetingSlots).where(and(eq(meetingSlots.meetingId, m.id), eq(meetingSlots.startsAt, input.startsAt)));
  if (dup) throw new RuleError('This time is already proposed', 'invalid');
  const reason = input.reason?.trim() || null;
  const [slot] = await db.insert(meetingSlots).values({ meetingId: m.id, startsAt: input.startsAt, endsAt, proposedBy: actor.id, reason }).returning();
  await db.insert(meetingVotes).values({ slotId: slot.id, userId: actor.id, vote: 'yes' });
  await changed(p);
  const url = meetingUrl(p, m.id);
  if (await discordAllowed(m)) {
    await sendDiscord(p, { title: st('New time proposal: {title}', { title: m.title }), description: st('{name} proposes {when}{reason}. Vote.', { name: actor.name, when: formatDateTime(slot.startsAt), reason: reason ? st(' (“{reason}”)', { reason }) : '' }), url, color: 0xf2994a }, log);
  }
  const others = (await memberIds(p)).filter((id) => id !== actor.id);
  await sendPush(others, { title: `New time for ${m.title}`, body: `${actor.name} suggests ${formatTime(slot.startsAt)}${reason ? `: ${reason}` : ''}`, url, tag: `meeting-${m.id}` }, log);
  return slot;
}

export async function vote(p: Project, actor: Actor, slotId: number, v: Vote | null) {
  const [row] = await db.select({ slot: meetingSlots, meeting: meetings }).from(meetingSlots)
    .innerJoin(meetings, eq(meetings.id, meetingSlots.meetingId))
    .where(and(eq(meetingSlots.id, slotId), eq(meetings.projectId, p.id)));
  if (!row) throw new RuleError('Time not found', 'not_found');
  if (row.meeting.status !== 'polling') throw new RuleError('Voting on this meeting is closed', 'invalid');
  if (v === null) await db.delete(meetingVotes).where(and(eq(meetingVotes.slotId, slotId), eq(meetingVotes.userId, actor.id)));
  else {
    await db.insert(meetingVotes).values({ slotId, userId: actor.id, vote: v })
      .onConflictDoUpdate({ target: [meetingVotes.slotId, meetingVotes.userId], set: { vote: v } });
  }
  await changed(p);
}

/** Organizator, admin projektu; sprint review (bez organizatora) może przesunąć każdy członek. */
function canEdit(m: { createdBy: number | null; kind: MeetingKind }, actor: Actor, isAdmin: boolean) {
  return isAdmin || m.createdBy === actor.id || m.kind === 'sprint_review';
}

export async function pickSlot(p: Project, actor: Actor, isAdmin: boolean, meetingId: number, slotId: number, log?: Log) {
  const m = await requireMeeting(p, meetingId);
  if (!(isAdmin || m.createdBy === actor.id)) throw new RuleError('Only the organizer or a project admin can pick the time', 'forbidden');
  if (m.status !== 'polling') throw new RuleError('The time is already picked', 'invalid');
  const [slot] = await db.select().from(meetingSlots).where(and(eq(meetingSlots.id, slotId), eq(meetingSlots.meetingId, m.id)));
  if (!slot) throw new RuleError('Time not found', 'not_found');
  await db.update(meetings).set({ status: 'scheduled', startsAt: slot.startsAt, endsAt: slot.endsAt }).where(eq(meetings.id, m.id));
  await changed(p);
  const url = meetingUrl(p, m.id);
  if (await discordAllowed(m)) await sendDiscord(p, { title: st('Time picked: {title}', { title: m.title }), description: `${formatDateTime(slot.startsAt)}${m.locationUrl ? ` · ${m.locationUrl}` : ''}`, url, color: 0x4cb782 }, log);
  const others = (await memberIds(p)).filter((id) => id !== actor.id);
  await sendPush(others, { title: `${m.title}: time picked`, body: `${formatTime(slot.startsAt)} · picked by ${actor.name}`, url, tag: `meeting-${m.id}` }, log);
}

export async function updateMeeting(p: Project, actor: Actor, isAdmin: boolean, id: number, patch: {
  title?: string; locationUrl?: string; reminders?: number[]; startsAt?: Date; endsAt?: Date;
}) {
  const m = await requireMeeting(p, id);
  if (!canEdit(m, actor, isAdmin)) throw new RuleError('Only the organizer or a project admin can change this meeting', 'forbidden');
  const set: Partial<typeof meetings.$inferInsert> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new RuleError('Title cannot be empty', 'invalid');
    set.title = patch.title.trim();
  }
  if (patch.locationUrl !== undefined) set.locationUrl = patch.locationUrl.trim();
  if (patch.startsAt || patch.endsAt) {
    if (m.status !== 'scheduled') throw new RuleError('Pick a time from the poll first', 'invalid');
    const startsAt = patch.startsAt ?? m.startsAt!;
    const endsAt = patch.endsAt ?? new Date(startsAt.getTime() + (m.endsAt!.getTime() - m.startsAt!.getTime()));
    checkRange(startsAt, endsAt);
    Object.assign(set, { startsAt, endsAt, manuallyEdited: true });
  }
  if (Object.keys(set).length) await db.update(meetings).set(set).where(eq(meetings.id, m.id));
  if (patch.reminders) await setReminders(m.id, checkReminders(patch.reminders));
  await changed(p);
}

export async function cancelMeeting(p: Project, actor: Actor, isAdmin: boolean, id: number) {
  const m = await requireMeeting(p, id);
  if (!canEdit(m, actor, isAdmin)) throw new RuleError('Only the organizer or a project admin can cancel this meeting', 'forbidden');
  // Odwołane sprint review zostaje w bazie, żeby się samo nie odtworzyło.
  await db.update(meetings).set({ status: 'cancelled' }).where(eq(meetings.id, m.id));
  await changed(p);
}

// ---------- sprint review ----------

/** Termin review: ostatni dzień roboczy sprintu (w strefie instancji; weekend cofa na piątek) o godzinie z ustawień projektu. */
export function reviewSlot(p: Pick<Project, 'reviewTime' | 'reviewMinutes'>, sprintEndsAt: Date) {
  const day = lastWorkday(zonedDate(new Date(sprintEndsAt.getTime() - MIN)));
  const startsAt = zonedToUtc(day, p.reviewTime);
  return { startsAt, endsAt: new Date(startsAt.getTime() + p.reviewMinutes * MIN) };
}

/**
 * Każdy aktywny i zaplanowany sprint ma swoje sprint review. Zmiana daty sprintu albo godziny
 * w ustawieniach przesuwa spotkanie, o ile nikt go nie przesunął ręcznie.
 */
export async function ensureSprintReviews(p: Project) {
  const list = await db.select().from(sprints).where(and(eq(sprints.projectId, p.id), inArray(sprints.status, ['planned', 'active'])));
  if (!list.length) return;
  const existing = await db.select().from(meetings).where(inArray(meetings.sprintId, list.map((s) => s.id)));
  let touched = false;
  for (const s of list) {
    const want = reviewSlot(p, s.endsAt);
    const title = `${s.name} review`;
    const m = existing.find((x) => x.sprintId === s.id);
    if (!m) {
      const [row] = await db.insert(meetings).values({
        projectId: p.id, title, kind: 'sprint_review', status: 'scheduled', ...want, sprintId: s.id, locationUrl: p.meetingLocationUrl,
      }).onConflictDoNothing().returning();
      if (row) await setReminders(row.id, DEFAULT_REMINDERS);
      touched = true;
    } else if (m.status === 'scheduled' && !m.manuallyEdited
      && (m.startsAt?.getTime() !== want.startsAt.getTime() || m.endsAt?.getTime() !== want.endsAt.getTime() || m.title !== title)) {
      await db.update(meetings).set({ ...want, title }).where(eq(meetings.id, m.id));
      touched = true;
    }
    // Review bez miejsca dostaje domyślny kanał projektu.
    if (m && !m.locationUrl && p.meetingLocationUrl) {
      await db.update(meetings).set({ locationUrl: p.meetingLocationUrl }).where(eq(meetings.id, m.id));
      touched = true;
      touched = true;
    }
  }
  if (touched) await changed(p);
}

// ---------- przypomnienia ----------

/** Przypomnienie spóźnione o więcej (np. serwer leżał) już nie idzie. */
const LATE_LIMIT = 10 * MIN;

function whenText(offset: number, startsAt: Date) {
  if (offset === 0) return 'starts now';
  if (offset >= 1440) return `tomorrow at ${formatTime(startsAt)}`;
  if (offset >= 60) return `starts in ${offset / 60} h (${formatTime(startsAt)})`;
  return `starts in ${offset} min (${formatTime(startsAt)})`;
}

function whenTitle(offset: number) {
  if (offset === 0) return st('is starting now');
  if (offset >= 1440) return st('tomorrow');
  if (offset >= 60) return st('in {n} h', { n: offset / 60 });
  return st('in {n} minutes', { n: offset });
}

/**
 * Wołane co 30 s: wysyła przypomnienia, których czas minął. Wpis w reminder_sends (z godziną
 * startu) zabezpiecza przed dublem po restarcie i przy kilku instancjach; przesunięte spotkanie
 * dostaje przypomnienia od nowa.
 */
export async function runReminders(now = new Date(), log?: Log) {
  const rows = await db.select({ m: meetings, offset: meetingReminders.offsetMinutes, project: projects })
    .from(meetings)
    .innerJoin(meetingReminders, eq(meetingReminders.meetingId, meetings.id))
    .innerJoin(projects, eq(projects.id, meetings.projectId))
    .where(and(
      eq(meetings.status, 'scheduled'),
      gte(meetings.startsAt, new Date(now.getTime() - LATE_LIMIT)),
      lte(meetings.startsAt, new Date(now.getTime() + 1441 * MIN)),
    ));
  let sent = 0;
  for (const { m, offset, project: p } of rows) {
    const due = m.startsAt!.getTime() - offset * MIN;
    if (due > now.getTime() || now.getTime() - due > LATE_LIMIT) continue;
    const claimed = await db.insert(reminderSends).values({ meetingId: m.id, offsetMinutes: offset, startsAt: m.startsAt! })
      .onConflictDoNothing().returning();
    if (!claimed.length) continue;
    sent++;
    const url = meetingUrl(p, m.id);
    // Tylko identyfikatory: SSE idzie do wszystkich, szczegóły klient pobiera z API (z kontrolą członkostwa).
    await publish({ type: 'meeting_reminder', projectKey: p.key, meetingId: m.id });
    await sendPush(await memberIds(p), {
      title: m.title, body: `${whenText(offset, m.startsAt!)[0].toUpperCase()}${whenText(offset, m.startsAt!).slice(1)}.${m.locationUrl ? ' Click to join.' : ''}`,
      url: m.locationUrl || url, tag: `meeting-${m.id}`,
    }, log);
    if (await discordAllowed(m)) {
      await sendDiscord(p, { title: `${m.title} ${whenTitle(offset)}`, description: `${formatDateTime(m.startsAt!)}${m.locationUrl ? ` · ${m.locationUrl}` : ''}`, url }, log);
    }
  }
  return sent;
}

// ---------- kalendarz .ics ----------

/** Zaplanowane spotkania ze wszystkich projektów osoby (link subskrypcji, tylko odczyt). */
export async function icsFor(userId: number, now = new Date()) {
  const rows = await db.select({ m: meetings, key: projects.key, projectName: projects.name }).from(meetings)
    .innerJoin(projects, eq(projects.id, meetings.projectId))
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, meetings.projectId), eq(projectMembers.userId, userId)))
    .where(and(eq(meetings.status, 'scheduled'), gte(meetings.startsAt, new Date(now.getTime() - 60 * 864e5))))
    .orderBy(asc(meetings.startsAt));
  const stamp = icsDate(now);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tracker//Meetings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Tracker meetings'];
  for (const { m, key, projectName } of rows) {
    const url = `${BASE_URL}/calendar?project=${key}&meeting=${m.id}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:meeting-${m.id}@tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(m.startsAt!)}`,
      `DTEND:${icsDate(m.endsAt!)}`,
      `SUMMARY:${icsText(m.title)}`,
      `DESCRIPTION:${icsText(`${projectName} · ${url}`)}`,
      `URL:${url}`,
      ...(m.locationUrl ? [`LOCATION:${icsText(m.locationUrl)}`] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function icsDate(d: Date) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Linie dłuższe niż 75 bajtów zawijamy (RFC 5545), nie tnąc znaków UTF-8. */
function fold(line: string) {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
