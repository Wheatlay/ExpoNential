import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { inboxItems, projectMembers, userTagMembers, userTags, users } from '../db/schema.ts';
import { sendPush } from './notify.ts';
import type { Project } from './projects.ts';
import { publish, type Actor } from './service.ts';
import { SKIP, TAG_TRAILING, USER_TRAILING, findByName, tagRe, userRe } from '../shared/mentions.ts';

/**
 * Wzmianki w tekście: @login (osoba) i #tag (grupa osób). Każda nowa wzmianka trafia do skrzynki
 * adresata i jako push oznaczony jako ważny.
 */


export function parseMentions(
  body: string,
  members: { id: number; login: string }[],
  tags: { id: number; name: string }[],
): { userIds: number[]; tagIds: number[] } {
  const byLogin = new Map(members.map((m) => [m.login.toLowerCase(), m]));
  const byTag = new Map(tags.map((t) => [t.name.toLowerCase(), t]));
  const userIds: number[] = [];
  const tagIds: number[] = [];
  body.split(SKIP).forEach((part, i) => {
    if (i % 2) return;
    for (const m of part.matchAll(userRe())) {
      const id = findByName(byLogin, m[1], USER_TRAILING)?.[0].id;
      if (id != null && !userIds.includes(id)) userIds.push(id);
    }
    for (const m of part.matchAll(tagRe())) {
      const id = findByName(byTag, m[1], TAG_TRAILING)?.[0].id;
      if (id != null && !tagIds.includes(id)) tagIds.push(id);
    }
  });
  return { userIds, tagIds };
}

/** Nazwa tagu: małe litery/cyfry, - i _, do 30 znaków, z przynajmniej jedną literą (#123 to numer, nie tag). */
export function validTagName(name: string) {
  return /^[a-z0-9][a-z0-9_-]{0,29}$/.test(name) && /[a-z]/.test(name);
}

export function excerpt(body: string) {
  const t = body.replace(/[*_`>#[\]()!]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
}

type Log = { warn: (o: object, m: string) => void };

export async function notifyMentions(
  p: Project,
  actor: Actor,
  issue: { id: number; number: number; title: string },
  opts: { body: string; previousBody?: string; commentId?: number | null; questionFor?: number | null; questionForTag?: number | null },
  log?: Log,
) {
  try {
    const members = await db.select({ id: users.id, login: users.login }).from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, p.id), eq(users.active, true)));
    const tags = await db.select().from(userTags).where(eq(userTags.projectId, p.id));
    const now = parseMentions(opts.body, members, tags);
    const before = opts.previousBody ? parseMentions(opts.previousBody, members, tags) : { userIds: [], tagIds: [] };
    // Przy edycji powiadamiamy tylko o nowo dopisanych wzmiankach.
    const newUsers = now.userIds.filter((id) => !before.userIds.includes(id));
    const newTags = now.tagIds.filter((id) => !before.tagIds.includes(id));
    const memberIds = new Set(members.map((m) => m.id));
    const self = actor?.id;
    const ask = opts.questionFor ?? null;
    // Pytanie do #tagu: wszyscy aktywni członkowie projektu z tego taga (bez pytającego) dostają wiersz 'question'.
    const askTagRow = opts.questionForTag != null ? tags.find((t) => t.id === opts.questionForTag) : undefined;
    const askTagIds = askTagRow
      ? (await db.select().from(userTagMembers).where(eq(userTagMembers.tagId, askTagRow.id))).map((r) => r.userId).filter((id) => id !== self && memberIds.has(id))
      : [];

    const direct = newUsers.filter((id) => id !== self && id !== ask && memberIds.has(id));
    const reached = new Set<number>(direct);
    if (ask != null) reached.add(ask);
    askTagIds.forEach((id) => reached.add(id));
    const groups: { kind: 'mention' | 'tag' | 'question'; tagName: string | null; ids: number[] }[] = [];
    if (ask != null && ask !== self && memberIds.has(ask)) groups.push({ kind: 'question', tagName: null, ids: [ask] });
    if (askTagIds.length) groups.push({ kind: 'question', tagName: askTagRow!.name, ids: askTagIds });
    if (direct.length) groups.push({ kind: 'mention', tagName: null, ids: direct });

    const newTagRows = tags.filter((t) => newTags.includes(t.id));
    if (newTagRows.length) {
      const tm = await db.select().from(userTagMembers).where(inArray(userTagMembers.tagId, newTagRows.map((t) => t.id)));
      for (const t of newTagRows) {
        const ids = tm.filter((r) => r.tagId === t.id).map((r) => r.userId)
          .filter((id) => id !== self && memberIds.has(id) && !reached.has(id));
        ids.forEach((id) => reached.add(id));
        if (ids.length) groups.push({ kind: 'tag', tagName: t.name, ids });
      }
    }
    if (!groups.length) return;

    const text = excerpt(opts.body);
    await db.insert(inboxItems).values(groups.flatMap((g) => g.ids.map((userId) => ({
      userId, projectId: p.id, kind: g.kind, issueId: issue.id, commentId: opts.commentId ?? null,
      actorId: self ?? null, tagName: g.tagName, excerpt: text,
    }))));
    await publish({ type: 'inbox', userIds: [...reached] });

    const who = actor?.name ?? 'Someone';
    const ref = `${p.key}-${issue.number}`;
    for (const g of groups) {
      const title = g.kind === 'question' ? (g.tagName ? `${who} asks #${g.tagName}` : `${who} asks you`) : g.kind === 'mention' ? `${who} mentioned you` : `${who} mentioned #${g.tagName}`;
      await sendPush(g.ids, { title, body: `${ref} ${issue.title}: ${text}`, url: `/issue/${ref}`, tag: `issue-${ref}` }, log, { important: true });
    }
  } catch (e) {
    // Powiadomienia nie psują zapisu komentarza ani zadania.
    log?.warn({ err: (e as Error).message }, 'mention notification failed');
  }
}
