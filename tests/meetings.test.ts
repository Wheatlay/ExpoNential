/**
 * Spotkania: ankiety, propozycje terminów, wybór terminu, automatyczne sprint review,
 * przypomnienia bez dubli, Discord (lokalny serwer zamiast prawdziwego webhooka) i .ics.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_meetings';
process.env.APP_TIMEZONE = 'Europe/Warsaw';
process.env.APP_LOCALE = 'pl';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let mt: typeof import('../src/server/meetings.ts');
let pr: typeof import('../src/server/projects.ts');
let sp: typeof import('../src/server/sprints.ts');
let nt: typeof import('../src/server/notify.ts');
let tz: typeof import('../src/server/tz.ts');
let P: import('../src/server/projects.ts').Project;
let alice: { id: number; name: string };
let pawel: { id: number; name: string };

// Udawany Discord: zapisuje, co przyszło na webhook.
const discord: { content: string; allowed_mentions: unknown; embeds: { title: string; description: string }[] }[] = [];
let hook: Server;
let hookUrl = '';

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_meetings with (force)');
  await admin.unsafe('create database tracker_test_meetings');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  mt = await import('../src/server/meetings.ts');
  pr = await import('../src/server/projects.ts');
  sp = await import('../src/server/sprints.ts');
  nt = await import('../src/server/notify.ts');
  tz = await import('../src/server/tz.ts');
  const svc = await import('../src/server/service.ts');
  await svc.seedDefaults();
  sp.onSprintsEnsured(mt.ensureSprintReviews);
  const [k] = await dbmod.db.insert(schema.users).values({ login: 'alice', name: 'Alice' }).returning();
  const acme = await pr.createProject(k.id, { key: 'ACME', name: 'Acme' });
  const p = await pr.addMember({ id: 0, isAdmin: true }, acme.id, 'bob');
  alice = { id: k.id, name: 'Alice' };
  pawel = { id: p.id, name: 'Paweł' };

  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { discord.push(JSON.parse(body)); res.writeHead(204).end(); });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/api/webhooks/1/x`;
  // Prosto w bazie: walidacja w ustawieniach wpuszcza tylko discord.com.
  const { eq } = await import('drizzle-orm');
  await dbmod.db.update(schema.projects).set({ discordWebhookUrl: hookUrl }).where(eq(schema.projects.key, 'ACME'));
  P = (await pr.getProjectByKey('ACME'))!;
});
afterAll(async () => { hook?.close(); await dbmod?.sql.end(); });

const at = (iso: string) => new Date(iso);

describe('time zone', () => {
  it('converts Polish wall time to UTC across the DST change', () => {
    expect(tz.zonedToUtc('2026-10-21', '15:00').toISOString()).toBe('2026-10-21T13:00:00.000Z');
    expect(tz.zonedToUtc('2026-11-02', '15:00').toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(tz.zonedDate(at('2026-10-21T22:30:00Z'))).toBe('2026-10-22');
    expect(tz.formatDateTime(at('2026-10-21T14:00:00Z'))).toBe('środa 21.10, 16:00');
  });

  it('formats date and time per locale', () => {
    expect(tz.formatDateTime(at('2026-10-20T14:00:00Z'), 'pl')).toBe('wtorek 20.10, 16:00');
    expect(tz.formatDateTime(at('2026-10-20T14:00:00Z'), 'en')).toBe('Tuesday 20 Oct, 16:00');
  });

  it('sprint ending Monday 00:00 gets its review on Friday', () => {
    const r = mt.reviewSlot({ reviewTime: '15:00', reviewMinutes: 45 }, tz.zonedToUtc('2026-11-02', '00:00'));
    expect(r.startsAt.toISOString()).toBe('2026-10-30T14:00:00.000Z');
    expect(tz.lastWorkday('2026-10-31')).toBe('2026-10-30');
    expect(tz.lastWorkday('2026-10-29')).toBe('2026-10-29');
  });
});

describe('time poll', () => {
  let meetingId = 0;

  it('creates a poll and announces it on Discord with @here', async () => {
    discord.length = 0;
    const m = await mt.createMeeting(P, alice, {
      title: 'Planowanie Q4', kind: 'poll', locationUrl: 'https://discord.com/channels/1/2',
      slots: [{ startsAt: at('2026-10-21T09:00:00Z'), endsAt: at('2026-10-21T10:00:00Z') }, { startsAt: at('2026-10-23T12:00:00Z'), endsAt: at('2026-10-23T13:00:00Z') }],
    });
    meetingId = m.id;
    expect(m.status).toBe('polling');
    expect(discord).toHaveLength(1);
    expect(discord[0].content).toBe('**Ankieta: Planowanie Q4** @here');
    expect(discord[0].allowed_mentions).toEqual({ parse: ['everyone'] });
    expect(discord[0].embeds[0].title).toBe('Ankieta: Planowanie Q4');
  });

  it('anyone can suggest another time (with reason), which pings Discord and counts as their yes', async () => {
    discord.length = 0;
    const slot = await mt.proposeSlot(P, pawel, meetingId, { startsAt: at('2026-10-21T10:00:00Z'), reason: '11:00 mam call' });
    expect(slot.endsAt.toISOString()).toBe('2026-10-21T11:00:00.000Z'); // długość jak pierwszy termin
    expect(discord[0].embeds[0].description).toContain('11:00 mam call');
    await expect(mt.proposeSlot(P, pawel, meetingId, { startsAt: at('2026-10-21T10:00:00Z') })).rejects.toThrow(/already proposed/);
    const [m] = (await mt.listMeetings(P, at('2026-01-01'))).filter((x) => x.id === meetingId);
    const s = m.slots.find((x) => x.id === slot.id)!;
    expect([s.proposedBy, s.reason, s.votes]).toEqual([pawel.id, '11:00 mam call', [{ userId: pawel.id, vote: 'yes' }]]);
  });

  it('votes can be changed and removed', async () => {
    const [m] = (await mt.listMeetings(P, at('2026-01-01'))).filter((x) => x.id === meetingId);
    await mt.vote(P, alice, m.slots[0].id, 'maybe');
    await mt.vote(P, alice, m.slots[0].id, 'no');
    await mt.vote(P, alice, m.slots[1].id, 'yes');
    await mt.vote(P, alice, m.slots[1].id, null);
    const [m2] = (await mt.listMeetings(P, at('2026-01-01'))).filter((x) => x.id === meetingId);
    expect(m2.slots[0].votes).toEqual([{ userId: alice.id, vote: 'no' }]);
    expect(m2.slots[1].votes.some((v) => v.userId === alice.id)).toBe(false);
  });

  it('only the organizer (or a project admin) picks the time; then voting is closed', async () => {
    const [m] = (await mt.listMeetings(P, at('2026-01-01'))).filter((x) => x.id === meetingId);
    const best = m.slots.find((s) => s.proposedBy === pawel.id)!;
    await expect(mt.pickSlot(P, pawel, false, meetingId, best.id)).rejects.toThrow(/organizer/);
    discord.length = 0;
    await mt.pickSlot(P, alice, false, meetingId, best.id);
    const [m2] = (await mt.listMeetings(P, at('2026-01-01'))).filter((x) => x.id === meetingId);
    expect([m2.status, m2.startsAt?.toISOString()]).toEqual(['scheduled', '2026-10-21T10:00:00.000Z']);
    expect(discord[0].embeds[0].title).toBe('Termin wybrany: Planowanie Q4');
    await expect(mt.vote(P, alice, best.id, 'yes')).rejects.toThrow(/closed/);
    await expect(mt.proposeSlot(P, alice, meetingId, { startsAt: at('2026-10-22T10:00:00Z') })).rejects.toThrow(/closed/);
  });

  it('organizer who turned Discord off does not post to the channel', async () => {
    await nt.saveNotifySettings(pawel.id, { discord: false });
    discord.length = 0;
    await mt.createMeeting(P, pawel, { title: 'Cicho', kind: 'fixed', startsAt: at('2026-10-24T09:00:00Z'), endsAt: at('2026-10-24T09:30:00Z') });
    expect(discord).toHaveLength(0);
    await nt.saveNotifySettings(pawel.id, { discord: true });
  });

  it('refuses bad input and meetings of other projects', async () => {
    await expect(mt.createMeeting(P, alice, { title: 'x', kind: 'poll', slots: [] })).rejects.toThrow(/at least one/);
    await expect(mt.createMeeting(P, alice, { title: 'x', kind: 'fixed', startsAt: at('2026-10-24T10:00:00Z'), endsAt: at('2026-10-24T09:00:00Z') })).rejects.toThrow(/end after/);
    await expect(mt.createMeeting(P, alice, { title: 'x', kind: 'fixed', startsAt: at('2026-10-24T10:00:00Z'), endsAt: at('2026-10-24T11:00:00Z'), reminders: [30] })).rejects.toThrow(/Reminders/);
    const web = await pr.createProject(alice.id, { key: 'WEB', name: 'Web' });
    await expect(mt.updateMeeting(web, alice, true, meetingId, { title: 'hack' })).rejects.toThrow(/not found/);
  });
});

describe('sprint review', () => {
  it('is created for every planned and active sprint on its last day at the project time', async () => {
    await sp.ensureSprints();
    const sprints = await sp.listSprints(P);
    const reviews = (await mt.listMeetings(P, at('2000-01-01'))).filter((m) => m.kind === 'sprint_review');
    expect(reviews).toHaveLength(sprints.length);
    for (const s of sprints) {
      const r = reviews.find((m) => m.sprintId === s.id)!;
      expect(r.title).toBe(`${s.name} review`);
      expect(r.startsAt!.toISOString()).toBe(tz.zonedToUtc(tz.lastWorkday(tz.zonedDate(new Date(s.endsAt.getTime() - 60_000))), '15:00').toISOString());
      expect(r.endsAt!.getTime() - r.startsAt!.getTime()).toBe(45 * 60_000);
      expect(r.reminders).toEqual([60, 15, 0]);
    }
  });

  it('follows the project review time unless moved by hand; cancelled one is not recreated', async () => {
    const [a, b] = (await mt.listMeetings(P, at('2000-01-01'))).filter((m) => m.kind === 'sprint_review');
    await mt.updateMeeting(P, pawel, false, a.id, { startsAt: new Date(a.startsAt!.getTime() + 3600_000) }); // każdy może przesunąć review
    P = (await pr.updateProject(P.id, { reviewTime: '10:30', reviewMinutes: 30 }))!;
    await sp.ensureProjectSprints(P);
    const after = (await mt.listMeetings(P, at('2000-01-01'))).filter((m) => m.kind === 'sprint_review');
    const a2 = after.find((m) => m.id === a.id)!;
    const b2 = after.find((m) => m.id === b.id)!;
    expect(a2.startsAt!.getTime()).toBe(a.startsAt!.getTime() + 3600_000);
    expect(tz.formatTime(b2.startsAt!)).toBe('10:30');
    await mt.cancelMeeting(P, alice, true, b.id);
    await sp.ensureProjectSprints(P);
    expect((await mt.listMeetings(P, at('2000-01-01'))).filter((m) => m.kind === 'sprint_review').map((m) => m.id)).toEqual([a.id]);
  });
});

describe('reminders', () => {
  it('sends each due reminder once, skips stale ones, and again after the meeting moves', async () => {
    const now = new Date(Date.UTC(2030, 0, 10, 12, 0));
    const m = await mt.createMeeting(P, alice, {
      title: 'Demo dla szefa', kind: 'fixed', startsAt: new Date(now.getTime() + 15 * 60_000), endsAt: new Date(now.getTime() + 75 * 60_000), reminders: [1440, 60, 15, 0],
    });
    discord.length = 0;
    // 1440 i 60 min przed minęły dawno (> 10 min): nie idą; 15 min przed: teraz.
    expect(await mt.runReminders(now)).toBe(1);
    expect(discord.map((d) => d.embeds[0].title)).toEqual(['Demo dla szefa za 15 minut']);
    expect(await mt.runReminders(new Date(now.getTime() + 30_000))).toBe(0);
    expect(await mt.runReminders(new Date(now.getTime() + 15 * 60_000 + 20_000))).toBe(1);
    expect(discord.at(-1)!.embeds[0].title).toBe('Demo dla szefa zaczyna się teraz');
    await mt.updateMeeting(P, alice, false, m.id, { startsAt: new Date(now.getTime() + 2 * 3600_000) });
    expect(await mt.runReminders(new Date(now.getTime() + 60 * 60_000))).toBe(1); // 60 min przed nowym terminem
  });
});

describe('calendar feed', () => {
  it('lists scheduled meetings of my projects as valid iCalendar', async () => {
    const ics = await mt.icsFor(alice.id, at('2026-10-01T00:00:00Z'));
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('SUMMARY:Planowanie Q4');
    expect(ics).toContain('DTSTART:20261021T100000Z');
    expect(ics).toContain('LOCATION:https://discord.com/channels/1/2');
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    const outsider = await pr.addMember({ id: 0, isAdmin: true }, (await pr.getProjectByKey('WEB'))!.id, 'outsider');
    const theirs = await mt.icsFor(outsider.id, at('2026-10-01T00:00:00Z'));
    expect(theirs).toContain('project=WEB');
    expect(theirs).not.toContain('Planowanie Q4');
  });
});
