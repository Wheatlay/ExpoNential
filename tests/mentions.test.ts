/**
 * Wzmianki: parser (czysty) i powiadomienia na prawdziwej bazie (osobna baza tracker_test_mentions).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_mentions';

let mentions: typeof import('../src/server/mentions.ts');
let svc: typeof import('../src/server/service.ts');
let dbmod: typeof import('../src/db/index.ts');

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_mentions with (force)');
  await admin.unsafe('create database tracker_test_mentions');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  svc = await import('../src/server/service.ts');
  mentions = await import('../src/server/mentions.ts');
});
afterAll(async () => { await dbmod?.sql.end(); });

const members = [{ id: 1, login: 'rafal' }, { id: 2, login: 'ola.k' }, { id: 3, login: 'Marek' }];
const tags = [{ id: 10, name: 'frontend' }, { id: 11, name: 'qa-team' }];
const parse = (s: string) => mentions.parseMentions(s, members, tags);

describe('parseMentions', () => {
  it('finds logins case-insensitively, also with dots', () => {
    expect(parse('hi @RAFAL and @ola.k').userIds).toEqual([1, 2]);
  });
  it('ignores trailing punctuation', () => {
    expect(parse('thanks @rafal. And @ola.k, ok? @marek-').userIds).toEqual([1, 2, 3]);
  });
  it('ignores unknown names', () => {
    expect(parse('@nobody #nothing')).toEqual({ userIds: [], tagIds: [] });
  });
  it('ignores code spans, code blocks and links', () => {
    const body = '`@rafal` ```\n@ola.k #frontend\n``` [@marek](http://x/@marek#qa-team) https://x.io/@rafal#frontend';
    expect(parse(body)).toEqual({ userIds: [], tagIds: [] });
  });
  it('does not take e-mails as mentions', () => {
    expect(parse('mail me: foo@rafal.com').userIds).toEqual([]);
  });
  it('finds tags, but not numbers or headings', () => {
    expect(parse('# Title\n#frontend and #QA-team, see #123 and &#10;').tagIds).toEqual([10, 11]);
  });
  it('dedupes and keeps order', () => {
    const r = parse('@marek @rafal @marek #qa-team #frontend #qa-team');
    expect(r.userIds).toEqual([3, 1]);
    expect(r.tagIds).toEqual([11, 10]);
  });
});

describe('validTagName', () => {
  it('accepts simple names', () => {
    expect(mentions.validTagName('frontend')).toBe(true);
    expect(mentions.validTagName('qa-team_2')).toBe(true);
    expect(mentions.validTagName('2fa')).toBe(true);
  });
  it('rejects numbers only, upper case, bad chars and too long', () => {
    expect(mentions.validTagName('123')).toBe(false);
    expect(mentions.validTagName('Front')).toBe(false);
    expect(mentions.validTagName('a b')).toBe(false);
    expect(mentions.validTagName('-a')).toBe(false);
    expect(mentions.validTagName('')).toBe(false);
    expect(mentions.validTagName('a'.repeat(31))).toBe(false);
  });
});

describe('excerpt', () => {
  it('strips markdown and shortens', () => {
    expect(mentions.excerpt('**bold**  `x`\n> quote')).toBe('bold x quote');
    const long = mentions.excerpt('a'.repeat(300));
    expect(long.length).toBe(140);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('notifications', () => {
  it('writes inbox rows for mentions, tags and questions', async () => {
    const { users, projectMembers, userTags, userTagMembers, inboxItems, comments } = await import('../src/db/schema.ts');
    const { eq } = await import('drizzle-orm');
    const projects = await import('../src/server/projects.ts');
    const db = dbmod.db;
    const [a, b, c] = await db.insert(users).values([
      { login: 'author', name: 'Author' }, { login: 'alice', name: 'Alice' }, { login: 'bob', name: 'Bob' },
    ]).returning();
    const P = await projects.createProject(a.id, { key: 'MEN', name: 'Mentions' });
    await db.insert(projectMembers).values([{ projectId: P.id, userId: b.id, role: 'member' }, { projectId: P.id, userId: c.id, role: 'member' }]).onConflictDoNothing();
    const [tag] = await db.insert(userTags).values({ projectId: P.id, name: 'crew', color: 'green', createdBy: a.id }).returning();
    await db.insert(userTagMembers).values([{ tagId: tag.id, userId: c.id }, { tagId: tag.id, userId: a.id }]);
    const actor = { id: a.id, name: a.name };
    const issue = await svc.createIssue(P, actor, { title: 'Talk' });
    const rows = () => db.select().from(inboxItems).orderBy(inboxItems.id);

    const cm = await svc.addComment(P, actor, issue.number, 'ping @alice and #crew');
    let r = await rows();
    expect(r.map((x) => [x.userId, x.kind, x.tagName])).toEqual([[b.id, 'mention', null], [c.id, 'tag', 'crew']]);
    expect(r.every((x) => x.commentId === cm.id && x.actorId === a.id && x.readAt === null)).toBe(true);

    // Edycja bez nowych wzmianek nie dubluje powiadomień; nowa wzmianka dodaje tylko swoje.
    await svc.updateComment(P, actor, cm.id, 'ping @alice and #crew (edited)');
    expect(await rows()).toHaveLength(2);
    await svc.updateComment(P, actor, cm.id, 'ping @alice and #crew (edited) @bob');
    r = await rows();
    expect(r).toHaveLength(3);
    expect(r[2].userId).toBe(c.id);
    expect(r[2].kind).toBe('mention');

    // Otwarcie zadania czyta wzmianki.
    await svc.markSeen(b.id, issue.id);
    expect((await rows()).find((x) => x.userId === b.id)!.readAt).toBeInstanceOf(Date);

    // Pytanie: pytany dostaje 'question', ktoś wspomniany w tekście 'mention'.
    const need = (await svc.getMeta(P)).statuses.find((s) => s.name === 'Need Info') ?? (await svc.getMeta(P)).statuses[0];
    await svc.updateIssue(P, actor, issue.number, { statusId: need.id, infoFromId: b.id, infoQuestion: 'what about this, @bob?' });
    r = await rows();
    const q = r.filter((x) => x.kind === 'question');
    expect(q.map((x) => x.userId)).toEqual([b.id]);
    expect(r.slice(3).map((x) => [x.userId, x.kind])).toEqual(expect.arrayContaining([[b.id, 'question'], [c.id, 'mention']]));
    const [qc] = await db.select().from(comments).where(eq(comments.id, q[0].commentId!));
    expect(qc.body.startsWith('**Question for @alice:**')).toBe(true);
    // Autor nigdy nie dostaje własnych powiadomień.
    expect(r.some((x) => x.userId === a.id)).toBe(false);
  });
});
