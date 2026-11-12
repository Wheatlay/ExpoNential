import { and, asc, eq, gte, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  meetingAttendance, meetingReminders, meetingSlots, meetingVotes, meetings, projectMembers, projects, reminderSends, sprints, users,
  type MeetingKind, type Vote,
} from '../db/schema.ts';
import { RuleError } from './rules.ts';
import { publish } from './service.ts';
import { editDiscord, getNotifySettings, sendDiscord, sendPush, type DiscordMessage } from './notify.ts';
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
    or(inArray(meetings.status, ['polling', 'expired']), gte(meetings.startsAt, since)),
  )).orderBy(asc(meetings.startsAt), asc(meetings.id));
  if (!rows.length) return [];
  const ids = rows.map((m) => m.id);
  const [slots, rems] = await Promise.all([
    db.select().from(meetingSlots).where(inArray(meetingSlots.meetingId, ids)).orderBy(asc(meetingSlots.startsAt), asc(meetingSlots.id)),
    db.select().from(meetingReminders).where(inArray(meetingReminders.meetingId, ids)),
  ]);
  const votes = slots.length ? await db.select().from(meetingVotes).where(inArray(meetingVotes.slotId, slots.map((s) => s.id))) : [];
  const answers = await db.select().from(meetingAttendance).where(inArray(meetingAttendance.meetingId, ids));
  // Wygasła ankieta (żaden termin już nie jest przed nami) jest na liście tak długo, jak jej ostatni termin mieści się w `since`.
  const lastSlot = (id: number) => Math.max(0, ...slots.filter((s) => s.meetingId === id).map((s) => s.startsAt.getTime()));
  return rows.filter((m) => m.status !== 'expired' || lastSlot(m.id) >= since.getTime()).map((m) => ({
    ...m,
    reminders: rems.filter((r) => r.meetingId === m.id).map((r) => r.offsetMinutes).sort((a, b) => b - a),
    // Kto będzie (stały termin); odpowiedź osoby usuniętej z zaproszonych się nie liczy, jak głos w ankiecie.
    attendance: answers.filter((a) => a.meetingId === m.id && invited(m, a.userId)).map((a) => ({ userId: a.userId, answer: a.answer, note: a.note })),
    slots: slots.filter((s) => s.meetingId === m.id).map((s) => ({
      // Głos osoby, którą potem usunięto z zaproszonych, nie liczy się i nie jest pokazywany.
      ...s, votes: votes.filter((v) => v.slotId === s.id && invited(m, v.userId)).map((v) => ({ userId: v.userId, vote: v.vote, note: v.note })),
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

type Invite = { attendeeIds: number[] | null; createdBy: number | null };

/** Spotkanie dla wybranych osób (organizator jest zawsze w środku). */
function invited(m: Invite, userId: number) {
  return !m.attendeeIds || m.attendeeIds.includes(userId) || m.createdBy === userId;
}

/** Kogo powiadomić: cały projekt albo tylko zaproszeni. */
async function recipients(p: Project, m: Invite) {
  return (await memberIds(p)).filter((id) => invited(m, id));
}

/**
 * Treść wiadomości o terminie na Discordzie: przy utworzeniu ("Nowe spotkanie" / "Termin wybrany") i przy edycji tej samej
 * wiadomości po zmianie terminu, tytułu albo linku. Odwołane: ta sama wiadomość z przekreśloną datą, szara.
 */
function scheduledMessage(p: Project, m: Pick<typeof meetings.$inferSelect, 'id' | 'kind' | 'title' | 'startsAt' | 'locationUrl'>, cancelled = false): DiscordMessage {
  const description = `${formatDateTime(m.startsAt!)}${m.locationUrl ? ` · ${m.locationUrl}` : ''}`;
  const url = meetingUrl(p, m.id);
  if (cancelled) return { title: st('Cancelled: {title}', { title: m.title }), description: `~~${description}~~`, url, color: 0x6b6f76 };
  const title = st(m.kind === 'poll' ? 'Time picked: {title}' : 'New meeting: {title}', { title: m.title });
  return { title, description, url, color: m.kind === 'poll' ? 0x4cb782 : undefined };
}

/** Zapamiętuje id wiadomości o terminie, żeby późniejsza zmiana spotkania ją edytowała. */
async function rememberDiscord(meetingId: number, sent: string | false) {
  if (sent) await db.update(meetings).set({ discordMessageId: sent }).where(eq(meetings.id, meetingId));
}

/** Na kanał idzie każde spotkanie (także dla wybranych osób), chyba że organizator wyłączył u siebie Discorda (sprint review: zawsze). */
async function discordAllowed(m: Invite) {
  return m.createdBy == null || (await getNotifySettings(m.createdBy)).discord;
}

/** Pusta lista albo cały zespół = null; tylko członkowie projektu. */
async function checkAttendees(p: Project, ids: number[] | null | undefined, organizer: number | null) {
  if (!ids?.length) return null;
  const members = await memberIds(p);
  const set = [...new Set(organizer == null ? ids : [organizer, ...ids])];
  if (set.some((id) => !members.includes(id))) throw new RuleError('Attendees must be project members', 'invalid');
  return set.length >= members.length ? null : set;
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
  agenda?: string;
  reminders?: number[];
  /** Puste/brak = cały projekt. */
  attendeeIds?: number[] | null;
};

/** Pusty albo adres http(s); inne schematy (javascript:, data:) trafiłyby w href u zaproszonych. */
export function cleanLocationUrl(v: string | undefined | null) {
  const t = (v ?? '').trim();
  if (!t) return '';
  let u: URL;
  try { u = new URL(t); } catch { throw new RuleError('Meeting link must be an http(s) URL', 'invalid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RuleError('Meeting link must be an http(s) URL', 'invalid');
  return t;
}

export async function createMeeting(p: Project, actor: Actor, input: NewMeeting, log?: Log) {
  const title = input.title.trim();
  if (!title) throw new RuleError('Title cannot be empty', 'invalid');
  const reminders = checkReminders(input.reminders ?? DEFAULT_REMINDERS);
  const attendeeIds = await checkAttendees(p, input.attendeeIds, actor.id);
  let m: typeof meetings.$inferSelect;
  if (input.kind === 'poll') {
    const slots = input.slots ?? [];
    if (!slots.length) throw new RuleError('Propose at least one time', 'invalid');
    slots.forEach((s) => checkRange(s.startsAt, s.endsAt));
    [m] = await db.insert(meetings).values({
      projectId: p.id, title, kind: 'poll', status: 'polling', locationUrl: cleanLocationUrl(input.locationUrl), agenda: (input.agenda ?? '').trim(), createdBy: actor.id, attendeeIds,
    }).returning();
    await db.insert(meetingSlots).values(slots.map((s) => ({ meetingId: m.id, startsAt: s.startsAt, endsAt: s.endsAt, proposedBy: actor.id })));
  } else {
    if (!input.startsAt || !input.endsAt) throw new RuleError('Pick a start and end time', 'invalid');
    checkRange(input.startsAt, input.endsAt);
    [m] = await db.insert(meetings).values({
      projectId: p.id, title, kind: 'fixed', status: 'scheduled', startsAt: input.startsAt, endsAt: input.endsAt,
      locationUrl: cleanLocationUrl(input.locationUrl), agenda: (input.agenda ?? '').trim(), createdBy: actor.id, attendeeIds,
    }).returning();
  }
  await setReminders(m.id, reminders);
  await changed(p);

  const others = (await recipients(p, m)).filter((id) => id !== actor.id);
  const url = meetingUrl(p, m.id);
  if (m.kind === 'poll') {
    const n = input.slots!.length;
    const count = st(n === 1 ? '{n} time' : LOCALE === 'pl' && n < 5 ? '{n} times (few)' : '{n} times', { n });
    if (await discordAllowed(m)) await sendDiscord(p, { title: st('Poll: {title}', { title }), description: st('{count} to choose from, you can propose another. Organized by {name}.', { count, name: actor.name }), url, color: 0xf2994a }, log);
    await sendPush(others, { title: `Vote: ${title}`, body: `${actor.name} asks when you can meet (${n} option${n === 1 ? '' : 's'}).`, url, tag: `meeting-${m.id}` }, log);
  } else {
    if (await discordAllowed(m)) await rememberDiscord(m.id, await sendDiscord(p, scheduledMessage(p, m), log));
    await sendPush(others, { title: `New meeting: ${title}`, body: `${formatTime(m.startsAt!)} · added by ${actor.name}`, url, tag: `meeting-${m.id}` }, log);
  }
  return m;
}

/** Każdy członek może dodać termin do ankiety; jego głos na ten termin to od razu "yes". */
export async function proposeSlot(p: Project, actor: Actor, meetingId: number, input: { startsAt: Date; endsAt?: Date; reason?: string }, log?: Log) {
  const m = await requireMeeting(p, meetingId);
  if (m.status !== 'polling') throw new RuleError('Voting on this meeting is closed', 'invalid');
  if (!invited(m, actor.id)) throw new RuleError('Only invited people can propose a time', 'forbidden');
  const [first] = await db.select().from(meetingSlots).where(eq(meetingSlots.meetingId, m.id)).orderBy(asc(meetingSlots.id)).limit(1);
  const len = first ? first.endsAt.getTime() - first.startsAt.getTime() : 60 * MIN;
  const endsAt = input.endsAt ?? new Date(input.startsAt.getTime() + len);
  checkRange(input.startsAt, endsAt);
  if (input.startsAt.getTime() <= Date.now()) throw new RuleError('This time has already passed', 'invalid');
  const [dup] = await db.select().from(meetingSlots).where(and(eq(meetingSlots.meetingId, m.id), eq(meetingSlots.startsAt, input.startsAt)));
  if (dup) throw new RuleError('This time is already proposed', 'invalid');
  const reason = input.reason?.trim() || null;
  const [slot] = await db.insert(meetingSlots).values({ meetingId: m.id, startsAt: input.startsAt, endsAt, proposedBy: actor.id, reason }).returning();
  await db.insert(meetingVotes).values({ slotId: slot.id, userId: actor.id, vote: 'yes' });
  // Komplet terminów znów niepełny: "wszyscy zagłosowali" może przyjść jeszcze raz.
  await db.update(meetings).set({ allVotedNotifiedAt: null }).where(eq(meetings.id, m.id));
  await changed(p);
  const url = meetingUrl(p, m.id);
  if (await discordAllowed(m)) {
    await sendDiscord(p, { title: st('New time proposal: {title}', { title: m.title }), description: st('{name} proposes {when}{reason}. Vote.', { name: actor.name, when: formatDateTime(slot.startsAt), reason: reason ? st(' (“{reason}”)', { reason }) : '' }), url, color: 0xf2994a }, log);
  }
  const others = (await recipients(p, m)).filter((id) => id !== actor.id);
  await sendPush(others, { title: `New time for ${m.title}`, body: `${actor.name} suggests ${formatTime(slot.startsAt)}${reason ? `: ${reason}` : ''}`, url, tag: `meeting-${m.id}` }, log);
  return slot;
}

/** note: powód przy "maybe"; przy innym głosie się czyści. */
export async function vote(p: Project, actor: Actor, slotId: number, v: Vote | null, note?: string | null, log?: Log) {
  const [row] = await db.select({ slot: meetingSlots, meeting: meetings }).from(meetingSlots)
    .innerJoin(meetings, eq(meetings.id, meetingSlots.meetingId))
    .where(and(eq(meetingSlots.id, slotId), eq(meetings.projectId, p.id)));
  if (!row) throw new RuleError('Time not found', 'not_found');
  if (row.meeting.status !== 'polling') throw new RuleError('Voting on this meeting is closed', 'invalid');
  if (!invited(row.meeting, actor.id)) throw new RuleError('Only invited people can vote', 'forbidden');
  if (row.slot.startsAt.getTime() <= Date.now()) throw new RuleError('This time has already passed', 'invalid');
  if (v === null) await db.delete(meetingVotes).where(and(eq(meetingVotes.slotId, slotId), eq(meetingVotes.userId, actor.id)));
  else {
    const n = v === 'maybe' ? note?.trim() || null : null;
    await db.insert(meetingVotes).values({ slotId, userId: actor.id, vote: v, note: n })
      .onConflictDoUpdate({ target: [meetingVotes.slotId, meetingVotes.userId], set: { vote: v, note: n } });
  }
  await changed(p);
  await afterVote(p, row.meeting.id, log);
}

/** Czy będę na spotkaniu o stałym terminie: yes / maybe (z powodem) / no, null = cofnij odpowiedź. Termin się nie zmienia. */
export async function setAttendance(p: Project, actor: Actor, meetingId: number, answer: Vote | null, note?: string | null) {
  const m = await requireMeeting(p, meetingId);
  if (m.kind !== 'fixed' || m.status !== 'scheduled') throw new RuleError('Attendance is only for meetings with a fixed time', 'invalid');
  if (!invited(m, actor.id)) throw new RuleError('Only invited people can answer', 'forbidden');
  if (m.endsAt && m.endsAt.getTime() <= Date.now()) throw new RuleError('This meeting has already ended', 'invalid');
  if (answer === null) await db.delete(meetingAttendance).where(and(eq(meetingAttendance.meetingId, m.id), eq(meetingAttendance.userId, actor.id)));
  else {
    const n = answer === 'maybe' ? note?.trim() || null : null;
    await db.insert(meetingAttendance).values({ meetingId: m.id, userId: actor.id, answer, note: n })
      .onConflictDoUpdate({ target: [meetingAttendance.meetingId, meetingAttendance.userId], set: { answer, note: n } });
  }
  await changed(p);
}

/**
 * Po głosie: wszyscy zaproszeni na "yes" na jakimś przyszłym terminie = termin wybiera się sam (najwcześniejszy);
 * wszyscy odpowiedzieli, ale zgody nie ma = jedno powiadomienie dla organizatora.
 */
async function afterVote(p: Project, meetingId: number, log?: Log) {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!m || m.status !== 'polling') return;
  const now = new Date();
  const slots = (await db.select().from(meetingSlots).where(eq(meetingSlots.meetingId, m.id)).orderBy(asc(meetingSlots.startsAt), asc(meetingSlots.id)))
    .filter((s) => s.startsAt.getTime() > now.getTime());
  const voters = await recipients(p, m);
  if (!slots.length || !voters.length) return;
  const votes = await db.select().from(meetingVotes).where(inArray(meetingVotes.slotId, slots.map((s) => s.id)));
  const said = (slotId: number, userId: number) => votes.find((x) => x.slotId === slotId && x.userId === userId);
  const unanimous = slots.find((s) => voters.every((u) => said(s.id, u)?.vote === 'yes'));
  if (unanimous) {
    await applyPick(p, m, unanimous, null, log);
    return;
  }
  if (!slots.every((s) => voters.every((u) => said(s.id, u)))) return;
  const [claimed] = await db.update(meetings).set({ allVotedNotifiedAt: now })
    .where(and(eq(meetings.id, m.id), eq(meetings.status, 'polling'), isNull(meetings.allVotedNotifiedAt))).returning({ id: meetings.id });
  if (!claimed) return;
  const to = m.createdBy == null
    ? (await db.select({ id: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.role, 'admin')))).map((r) => r.id)
    : [m.createdBy];
  await sendPush(to, { title: m.title, body: st('Everyone voted. Pick a time.'), url: meetingUrl(p, m.id), tag: `meeting-${m.id}` }, log);
}

/** Organizator, admin projektu; sprint review (bez organizatora) może przesunąć każdy członek. */
function canEdit(m: { createdBy: number | null; kind: MeetingKind }, actor: Actor, isAdmin: boolean) {
  return isAdmin || m.createdBy === actor.id || m.kind === 'sprint_review';
}

export async function pickSlot(p: Project, actor: Actor, isAdmin: boolean, meetingId: number, slotId: number, log?: Log) {
  const m = await requireMeeting(p, meetingId);
  if (!(isAdmin || m.createdBy === actor.id)) throw new RuleError('Only the organizer or a project admin can pick the time', 'forbidden');
  if (m.status === 'expired') throw new RuleError('All proposed times have passed', 'invalid');
  if (m.status !== 'polling') throw new RuleError('The time is already picked', 'invalid');
  const [slot] = await db.select().from(meetingSlots).where(and(eq(meetingSlots.id, slotId), eq(meetingSlots.meetingId, m.id)));
  if (!slot) throw new RuleError('Time not found', 'not_found');
  if (slot.startsAt.getTime() <= Date.now()) throw new RuleError('This time has already passed', 'invalid');
  if (!(await applyPick(p, m, slot, actor, log))) throw new RuleError('The time is already picked', 'invalid');
}

/**
 * Zamyka ankietę na wybranym terminie. Zmiana statusu jest jednym zapytaniem z warunkiem "wciąż polling":
 * przy wyścigu (dwa ostatnie głosy naraz) skutki uboczne wykona tylko jeden. actor = null: wybór automatyczny
 * (wszyscy na "yes"), powiadomienie idzie do wszystkich, także do ostatniego głosującego.
 */
async function applyPick(p: Project, m: typeof meetings.$inferSelect, slot: typeof meetingSlots.$inferSelect, actor: Actor | null, log?: Log) {
  const [done] = await db.update(meetings).set({ status: 'scheduled', startsAt: slot.startsAt, endsAt: slot.endsAt })
    .where(and(eq(meetings.id, m.id), eq(meetings.status, 'polling'))).returning({ id: meetings.id });
  if (!done) return false;
  await changed(p);
  const url = meetingUrl(p, m.id);
  if (await discordAllowed(m)) await rememberDiscord(m.id, await sendDiscord(p, scheduledMessage(p, { ...m, startsAt: slot.startsAt }), log));
  const to = (await recipients(p, m)).filter((id) => id !== actor?.id);
  await sendPush(to, { title: `${m.title}: time picked`, body: `${formatTime(slot.startsAt)} · ${actor ? `picked by ${actor.name}` : st('everyone said yes')}`, url, tag: `meeting-${m.id}` }, log);
  return true;
}

export async function updateMeeting(p: Project, actor: Actor, isAdmin: boolean, id: number, patch: {
  title?: string; locationUrl?: string; agenda?: string; reminders?: number[]; startsAt?: Date; endsAt?: Date; attendeeIds?: number[] | null;
}, log?: Log) {
  const m = await requireMeeting(p, id);
  if (!canEdit(m, actor, isAdmin)) throw new RuleError('Only the organizer or a project admin can change this meeting', 'forbidden');
  const set: Partial<typeof meetings.$inferInsert> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new RuleError('Title cannot be empty', 'invalid');
    set.title = patch.title.trim();
  }
  if (patch.locationUrl !== undefined) set.locationUrl = cleanLocationUrl(patch.locationUrl);
  if (patch.agenda !== undefined) set.agenda = patch.agenda.trim();
  if (patch.attendeeIds !== undefined) {
    if (m.kind === 'sprint_review') throw new RuleError('Sprint review is for the whole team', 'invalid');
    set.attendeeIds = await checkAttendees(p, patch.attendeeIds, m.createdBy);
  }
  if (patch.startsAt || patch.endsAt) {
    if (m.status !== 'scheduled') throw new RuleError('Pick a time from the poll first', 'invalid');
    const startsAt = patch.startsAt ?? m.startsAt!;
    const endsAt = patch.endsAt ?? new Date(startsAt.getTime() + (m.endsAt!.getTime() - m.startsAt!.getTime()));
    checkRange(startsAt, endsAt);
    Object.assign(set, { startsAt, endsAt, manuallyEdited: true });
  }
  if (Object.keys(set).length) await db.update(meetings).set(set).where(eq(meetings.id, m.id));
  // Usunięci z zaproszonych tracą swoje głosy w ankiecie (organizator zostaje zawsze).
  if (set.attendeeIds) {
    const keep = [...(set.attendeeIds as number[]), ...(m.createdBy != null ? [m.createdBy] : [])];
    const slotIds = (await db.select({ id: meetingSlots.id }).from(meetingSlots).where(eq(meetingSlots.meetingId, m.id))).map((s) => s.id);
    if (slotIds.length) await db.delete(meetingVotes).where(and(inArray(meetingVotes.slotId, slotIds), notInArray(meetingVotes.userId, keep)));
  }
  if (patch.reminders) await setReminders(m.id, checkReminders(patch.reminders));
  await changed(p);
  // Wiadomość o terminie na Discordzie pokazuje aktualny termin, tytuł i link (edycja, bez nowego powiadomienia).
  const after = { ...m, ...set } as typeof m;
  if (m.discordMessageId && after.status === 'scheduled' && after.startsAt
    && (after.title !== m.title || after.locationUrl !== m.locationUrl || after.startsAt.getTime() !== m.startsAt?.getTime())) {
    await editDiscord(p, m.discordMessageId, scheduledMessage(p, after), log);
  }
}

export async function cancelMeeting(p: Project, actor: Actor, isAdmin: boolean, id: number, log?: Log) {
  const m = await requireMeeting(p, id);
  if (!canEdit(m, actor, isAdmin)) throw new RuleError('Only the organizer or a project admin can cancel this meeting', 'forbidden');
  // Odwołane sprint review zostaje w bazie, żeby się samo nie odtworzyło.
  await db.update(meetings).set({ status: 'cancelled' }).where(eq(meetings.id, m.id));
  await changed(p);
  if (m.discordMessageId && m.startsAt) await editDiscord(p, m.discordMessageId, scheduledMessage(p, m, true), log);
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
  // Wyłączone w ustawieniach: nadchodzące review znikają z kalendarza (włączenie tworzy je od nowa).
  if (!p.reviewMeeting) {
    const gone = await db.delete(meetings).where(and(
      inArray(meetings.sprintId, list.map((s) => s.id)), eq(meetings.kind, 'sprint_review'), gte(meetings.startsAt, new Date()),
    )).returning({ id: meetings.id });
    if (gone.length) await changed(p);
    return;
  }
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
  await expirePolls(now);
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
    await sendPush(await recipients(p, m), {
      title: m.title, body: `${whenText(offset, m.startsAt!)[0].toUpperCase()}${whenText(offset, m.startsAt!).slice(1)}.${m.locationUrl ? ' Click to join.' : ''}`,
      url: m.locationUrl || url, tag: `meeting-${m.id}`,
    }, log);
    if (await discordAllowed(m)) {
      await sendDiscord(p, { title: `${m.title} ${whenTitle(offset)}`, description: `${formatDateTime(m.startsAt!)}${m.locationUrl ? ` · ${m.locationUrl}` : ''}`, url }, log);
    }
  }
  return sent;
}

/** Ankieta, w której każdy termin już minął, wygasa: bez powiadomień, tylko odświeżenie widoku. */
export async function expirePolls(now = new Date()) {
  const gone = await db.update(meetings).set({ status: 'expired' }).where(and(
    eq(meetings.status, 'polling'),
    sql`not exists (select 1 from ${meetingSlots} where ${meetingSlots.meetingId} = ${meetings.id} and ${meetingSlots.startsAt} > ${now.toISOString()}::timestamptz)`,
  )).returning({ projectId: meetings.projectId });
  if (!gone.length) return 0;
  const keys = await db.select({ key: projects.key }).from(projects).where(inArray(projects.id, [...new Set(gone.map((g) => g.projectId))]));
  for (const k of keys) await publish({ type: 'meetings', projectKey: k.key });
  return gone.length;
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
    // Do zewnętrznego kalendarza trafiają tylko spotkania, na które osoba jest zaproszona.
    if (!invited(m, userId)) continue;
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
