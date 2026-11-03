import { and, eq, inArray, ne, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  agentJobs, agentPairings, agentTombstones, agents, apiTokens, inboxItems, userDismissals, issueViews, issues, oauthCodes, oauthDeviceCodes, oauthGrants, projectInvites, pushSubscriptions,
  sessions, statuses, userNotificationSettings, userTagMembers, userViews, users,
} from '../db/schema.ts';
import { RuleError } from './rules.ts';
import { st } from './i18n.ts';

/** Zdjęcie profilowe to tylko plik wgrany na ten serwer (nie dowolny adres z internetu). */
export function uploadPath(url: string) {
  // Bez "..", "//" i schematów: sama nazwa pliku po /uploads/.
  if (!/^\/uploads\/[\w.-]+$/.test(url) || url.includes('..')) throw new RuleError('Use an uploaded image', 'invalid');
  return url;
}

/** Zmiana własnego profilu: nazwa i zdjęcie. avatar: null wraca do zdjęcia od dostawcy (albo inicjałów). */
export async function updateProfile(userId: number, input: { name?: string; avatar?: string | null }) {
  const set: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 60) throw new RuleError('Name must be 1-60 characters', 'invalid');
    set.name = name;
  }
  if (typeof input.avatar === 'string') {
    set.avatarUrl = uploadPath(input.avatar);
    set.avatarCustom = true;
  } else if (input.avatar === null) {
    const [u] = await db.select({ providerAvatarUrl: users.providerAvatarUrl }).from(users).where(eq(users.id, userId));
    set.avatarUrl = u?.providerAvatarUrl ?? null;
    set.avatarCustom = false;
  }
  if (Object.keys(set).length) await db.update(users).set(set).where(eq(users.id, userId));
}

/**
 * Usunięcie własnego konta = anonimizacja. Wiersz użytkownika zostaje (zgłoszenia, komentarze i aktywność dalej na niego wskazują
 * i pokazują "Deleted user"), ale tracimy dane osobowe i dostęp. Członkostwa w projektach ZOSTAJĄ jako nieaktywne konto:
 * lista ludzi w meta (meta.users) zawiera tylko członków, więc bez nich stare komentarze renderowałyby się jako "nieznany".
 */
export async function deleteAccount(userId: number, confirm: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || !u.active) throw new RuleError('Not found', 'not_found');
  if (confirm.trim() !== u.login) throw new RuleError('Type your login to confirm', 'invalid');

  // Jedyny admin projektu, w którym są jeszcze inni ludzie: najpierw ktoś musi przejąć projekt.
  const stuck = await db.execute<{ name: string }>(dsql`
    select p.name from project_members me join projects p on p.id = me.project_id
    where me.user_id = ${userId} and me.role = 'admin'
      and not exists (select 1 from project_members o join users ou on ou.id = o.user_id where o.project_id = me.project_id and o.role = 'admin' and o.user_id <> ${userId} and ou.active)
      and exists (select 1 from project_members o join users ou on ou.id = o.user_id where o.project_id = me.project_id and o.user_id <> ${userId} and ou.active)
    order by p.id limit 1`);
  if (stuck.length) throw new RuleError(st('Make someone else admin of {project} first', { project: stuck[0].name }), 'invalid');
  if (u.isAdmin) {
    const others = await db.select({ id: users.id }).from(users).where(and(eq(users.isAdmin, true), eq(users.active, true), ne(users.id, userId))).limit(1);
    if (!others.length) throw new RuleError(st('Make someone else a workspace admin first'), 'invalid');
  }

  await db.transaction(async (tx) => {
    await tx.update(users).set({
      name: st('Deleted user'), login: `deleted-${userId}`, email: null, githubId: null, googleId: null, passwordHash: null,
      avatarUrl: null, providerAvatarUrl: null, avatarCustom: false, isAdmin: false, active: false, calendarToken: null,
    }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await tx.delete(oauthCodes).where(eq(oauthCodes.userId, userId));
    await tx.delete(oauthGrants).where(eq(oauthGrants.userId, userId));
    await tx.delete(oauthDeviceCodes).where(eq(oauthDeviceCodes.userId, userId));
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    await tx.delete(userNotificationSettings).where(eq(userNotificationSettings.userId, userId));
    await tx.delete(userTagMembers).where(eq(userTagMembers.userId, userId));
    await tx.delete(inboxItems).where(eq(inboxItems.userId, userId));
    await tx.delete(issueViews).where(eq(issueViews.userId, userId));
    await tx.delete(userViews).where(eq(userViews.userId, userId));
    await tx.delete(projectInvites).where(eq(projectInvites.userId, userId));
    await tx.delete(agentJobs).where(eq(agentJobs.userId, userId));
    await tx.delete(agentPairings).where(eq(agentPairings.userId, userId));
    await tx.delete(agentTombstones).where(eq(agentTombstones.userId, userId));
    await tx.delete(userDismissals).where(eq(userDismissals.userId, userId));
    await tx.delete(agents).where(eq(agents.userId, userId));
    // Otwarte zgłoszenia zostają bez przypisanego; zamknięte zachowują autora pracy.
    const open = tx.select({ id: statuses.id }).from(statuses).where(inArray(statuses.type, ['backlog', 'unstarted', 'started']));
    await tx.update(issues).set({ assigneeId: null }).where(and(eq(issues.assigneeId, userId), inArray(issues.statusId, open)));
    await tx.update(issues).set({ infoFromId: null }).where(eq(issues.infoFromId, userId));
  });
}
