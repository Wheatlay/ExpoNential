/**
 * Testy na prawdziwej bazie z docker compose: osobna baza tracker_test, tworzona od zera.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test';

let svc: typeof import('../src/server/service.ts');
let dbmod: typeof import('../src/db/index.ts');
let hooks: typeof import('../src/server/hooks.ts');
let sprints: typeof import('../src/server/sprints.ts');
let projects: typeof import('../src/server/projects.ts');
let P: import('../src/server/projects.ts').Project;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test with (force)');
  await admin.unsafe('create database tracker_test');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  svc = await import('../src/server/service.ts');
  hooks = await import('../src/server/hooks.ts');
  sprints = await import('../src/server/sprints.ts');
  projects = await import('../src/server/projects.ts');
  await svc.seedDefaults();
  // Baseline-owa migracja nie tworzy projektu: testy tworzą neutralny projekt ACME same.
  const { users, projectMembers } = await import('../src/db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const [creator] = await dbmod.db.insert(users).values({ login: 'seed-creator', name: 'Seed' }).returning();
  P = await projects.createProject(creator.id, { key: 'ACME', name: 'Acme' });
  await dbmod.db.delete(projectMembers).where(eq(projectMembers.userId, creator.id));
  P = await projects.updateProject(P.id, { githubRepo: 'acme/web' });
});
afterAll(async () => { await dbmod?.sql.end(); });

const statusId = async (name: string) => (await svc.getMeta(P)).statuses.find((s) => s.name === name)!.id;

describe('issues', () => {
  it('numbers issues sequentially, also in parallel', async () => {
    const rows = await Promise.all(Array.from({ length: 5 }, (_, i) => svc.createIssue(P, null, { title: `t${i}` })));
    expect(rows.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('allows Done without change notes (soft rule) and records the status change', async () => {
    const done = await statusId('Done');
    const r = await svc.updateIssue(P, null, 1, { statusId: done });
    expect(r.completedAt).toBeInstanceOf(Date);
    const d = await svc.getIssueDetail(P, 1);
    expect(d.activity.map((a) => a.payload.kind)).toContain('status');
  });

  it('notes and status can be set in one update', async () => {
    const r = await svc.updateIssue(P, null, 2, { statusId: await statusId('Done'), changeHuman: 'a', changeAi: 'b' });
    expect(r.completedAt).toBeInstanceOf(Date);
  });

  it('canceled needs no notes', async () => {
    await expect(svc.updateIssue(P, null, 3, { statusId: await statusId('Canceled') })).resolves.toBeTruthy();
  });

  it('analysis request flag is cleared by writing the analysis', async () => {
    await svc.requestAnalysis(P, null, 4);
    expect((await svc.listIssues(P, { analysisRequested: true })).map((i) => i.number)).toEqual([4]);
    await svc.updateIssue(P, null, 4, { analysis: '## Analiza' });
    expect(await svc.listIssues(P, { analysisRequested: true })).toEqual([]);
  });

  it('sub-issues: parent link and progress', async () => {
    const child = await svc.createIssue(P, null, { title: 'child', parentNumber: 5 });
    const [row] = (await svc.listIssues(P)).filter((i) => i.number === 5);
    expect(row.subTotal).toBe(1);
    expect((await svc.getIssueDetail(P, child.number)).parent?.number).toBe(5);
    await expect(svc.updateIssue(P, null, 5, { parentNumber: 5 })).rejects.toThrow(/own parent/);
  });
});

describe('claude code worklog', () => {
  it('merges repeated sends of one session into a single entry, separate per session', async () => {
    const i = await svc.createIssue(P, null, { title: 'worklog' });
    const send = (session: string, files: string[], sha?: string) =>
      svc.upsertWorklog(P, null, i.number, { session, repo: 'r', files, commits: sha ? [{ sha, message: 'm' }] : [], prompts: ['zażółć'] });
    await send('s1', ['a.ts']);
    await send('s1', ['a.ts', 'b.ts'], 'abc');
    await send('s1', ['b.ts'], 'abc');
    await send('s2', ['c.ts']);
    const logs = (await svc.getIssueDetail(P, i.number)).activity.flatMap((a) => (a.payload.kind === 'worklog' ? [a.payload] : []));
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ session: 's1', files: ['a.ts', 'b.ts'], commits: [{ sha: 'abc' }], prompts: ['zażółć'] });
    expect(logs[1]).toMatchObject({ session: 's2', files: ['c.ts'] });
  });
});

describe('github commits', () => {
  it('records each commit once per issue', async () => {
    const c = { id: 'abc123', message: 'fix ACME-4 and ACME-999', url: 'https://x', timestamp: new Date().toISOString(), author: { name: 'K', username: 'Wheatlay' } };
    expect(await hooks.recordCommits([c], 'acme/web')).toEqual(['ACME-4']);
    expect(await hooks.recordCommits([c], 'acme/web')).toEqual([]);
    expect((await svc.getIssueDetail(P, 4)).commits).toHaveLength(1);
  });
});

describe('sprints', () => {
  it('keeps an active and a planned sprint, and carries over open issues', async () => {
    await sprints.ensureSprints();
    const all = await sprints.listSprints(P);
    const active = all.find((s) => s.status === 'active')!;
    expect(all.some((s) => s.status === 'planned')).toBe(true);
    await svc.updateIssue(P, null, 5, { sprintId: active.id });
    const r = await sprints.carryOver(P, active.id);
    expect(r.moved).toBe(1);
    await expect(sprints.closeReview(P, active.id)).rejects.toThrow(/ended/);
  });

  it('ends an expired sprint and starts the next one', async () => {
    await sprints.ensureSprints(new Date(Date.now() + 40 * 864e5));
    const all = await sprints.listSprints(P);
    expect(all.filter((s) => s.status === 'ended').length).toBeGreaterThan(0);
    expect(all.filter((s) => s.status === 'active')).toHaveLength(1);
  });
});

describe('relations', () => {
  it('waits on: shown on the list until the blocker is closed, loops refused', async () => {
    const rel = await import('../src/server/relations.ts');
    const a = await svc.createIssue(P, null, { title: 'A' });
    const b = await svc.createIssue(P, null, { title: 'B' });
    await rel.addRelation(P, null, a.number, 'waits_on', b.number);
    const rowA = () => svc.listIssues(P).then((l) => l.find((i) => i.number === a.number)!);
    expect((await rowA()).waitingOn).toEqual([b.number]);
    await expect(rel.addRelation(P, null, a.number, 'blocks', b.number)).rejects.toThrow(/already/);
    const detailB = await svc.getIssueDetail(P, b.number);
    expect(detailB.relations.blocking.map((x) => x.number)).toEqual([a.number]);
    await svc.updateIssue(P, null, b.number, { statusId: await statusId('Canceled') });
    expect((await rowA()).waitingOn).toEqual([]);
    await rel.removeRelation(P, null, b.number, 'blocks', a.number);
    expect((await svc.getIssueDetail(P, a.number)).relations.waitingOn).toEqual([]);
  });

  it('related is symmetric and stored once', async () => {
    const rel = await import('../src/server/relations.ts');
    const a = await svc.createIssue(P, null, { title: 'C' });
    const b = await svc.createIssue(P, null, { title: 'D' });
    await rel.addRelation(P, null, a.number, 'related', b.number);
    await rel.addRelation(P, null, b.number, 'related', a.number);
    expect((await svc.getIssueDetail(P, b.number)).relations.related.map((x) => x.number)).toEqual([a.number]);
    await expect(rel.addRelation(P, null, a.number, 'related', a.number)).rejects.toThrow(/itself/);
  });
});

describe('need info question', () => {
  it('sets the question with a comment and clears it when leaving Need Info', async () => {
    const dbm = await import('../src/db/index.ts');
    const { users } = await import('../src/db/schema.ts');
    const u = await member('pawel-test', 'Paweł');
    const i = await svc.createIssue(P, null, { title: 'Q' });
    await svc.updateIssue(P, null, i.number, { statusId: await statusId('Need Info'), infoFromId: u.id, infoQuestion: 'Który numer?' });
    const d = await svc.getIssueDetail(P, i.number);
    expect(d.infoFromId).toBe(u.id);
    expect(d.comments.at(-1)?.body).toBe('**Question for Paweł:** Który numer?');
    await svc.updateIssue(P, null, i.number, { statusId: await statusId('In Progress') });
    const d2 = await svc.getIssueDetail(P, i.number);
    expect([d2.infoFromId, d2.infoQuestion]).toEqual([null, '']);
  });
});

describe('answering a question', () => {
  it('a comment from the asked person closes the question and restores the status', async () => {
    const dbm = await import('../src/db/index.ts');
    const { users } = await import('../src/db/schema.ts');
    const asker = await member('asker', 'Asker');
    const who = await member('who', 'Who');
    const i = await svc.createIssue(P, null, { title: 'Ask', statusId: await statusId('In Progress') });
    await svc.updateIssue(P, { id: asker.id, name: asker.name }, i.number, { statusId: await statusId('Need Info'), infoFromId: who.id, infoQuestion: 'Jak?' });
    // komentarz kogoś innego nie zamyka pytania
    await svc.addComment(P, { id: asker.id, name: asker.name }, i.number, 'ping');
    expect((await svc.getIssueDetail(P, i.number)).infoQuestion).toBe('Jak?');
    await svc.addComment(P, { id: who.id, name: who.name }, i.number, 'Tak.');
    const d = await svc.getIssueDetail(P, i.number);
    expect(d.infoQuestion).toBe('');
    expect(d.statusId).toBe(await statusId('In Progress'));
    expect(d.activity.some((a) => a.payload.kind === 'answered')).toBe(true);
  });

  it('counts unread comments from others since the last visit', async () => {
    const dbm = await import('../src/db/index.ts');
    const { users } = await import('../src/db/schema.ts');
    const a = await member('reader', 'Reader');
    const b = await member('writer', 'Writer');
    const i = await svc.createIssue(P, null, { title: 'Unread' });
    const unread = async () => (await svc.listIssues(P, { viewerId: a.id })).find((x) => x.number === i.number)!.unreadComments;
    await svc.addComment(P, { id: b.id, name: b.name }, i.number, 'hej');
    expect(await unread()).toBe(1);
    await svc.markSeen(a.id, i.id);
    expect(await unread()).toBe(0);
    await svc.addComment(P, { id: a.id, name: a.name }, i.number, 'moje');
    expect(await unread()).toBe(0);
  });
});

/** Konto + członkostwo w ACME (przypisywać i pytać można tylko członków projektu). */
async function member(login: string, name: string) {
  const u = await projects.addMember({ id: 0, isAdmin: true }, P.id, login);
  const { users } = await import('../src/db/schema.ts');
  const { eq } = await import('drizzle-orm');
  await dbmod.db.update(users).set({ name }).where(eq(users.id, u.id));
  return { ...u, name };
}

describe('projects', () => {
  it('new project gets default statuses', async () => {
    expect(P.name).toBe('Acme');
    expect((await svc.getMeta(P)).statuses.map((s) => s.name)).toContain('Need Info');
  });

  it('numbers issues per project and keeps projects isolated', async () => {
    const owner = await member('owner', 'Owner');
    const web = await projects.createProject(owner.id, { key: 'web', name: 'Website' });
    expect(web.key).toBe('WEB');
    const meta = await svc.getMeta(web);
    expect(meta.statuses).toHaveLength(9);
    expect(meta.users.map((u) => u.login)).toEqual(['owner']);
    const w1 = await svc.createIssue(web, null, { title: 'first on web' });
    const w2 = await svc.createIssue(web, null, { title: 'second on web' });
    expect([w1.number, w2.number]).toEqual([1, 2]);
    // ACME-1 i WEB-1 to różne zadania
    expect((await svc.getIssueDetail(web, 1)).title).toBe('first on web');
    expect((await svc.getIssueDetail(P, 1)).title).not.toBe('first on web');
    expect((await svc.listIssues(web)).map((i) => i.title).sort()).toEqual(['first on web', 'second on web']);
    expect((await svc.listIssues(P)).some((i) => i.title === 'first on web')).toBe(false);
    await expect(svc.getIssueDetail(web, 99)).rejects.toThrow(/WEB-99 not found/);
  });

  it('refuses statuses, labels, sprints and people from another project', async () => {
    const web = (await projects.getProjectByKey('WEB'))!;
    const acmeStatus = (await svc.getMeta(P)).statuses[0].id;
    await expect(svc.createIssue(web, null, { title: 'x', statusId: acmeStatus })).rejects.toThrow(/Unknown status/);
    const acmeLabel = await svc.saveLabel(P, { name: 'OnlyAcme', color: '#fff' });
    await expect(svc.createIssue(web, null, { title: 'x', labelIds: [acmeLabel.id] })).rejects.toThrow(/Unknown label/);
    await sprints.ensureSprints();
    const acmeSprint = (await sprints.listSprints(P))[0];
    expect((await sprints.listSprints(web)).length).toBeGreaterThanOrEqual(2);
    await expect(svc.updateIssue(web, null, 1, { sprintId: acmeSprint.id })).rejects.toThrow(/Unknown sprint/);
    const outsider = (await dbmod.db.insert((await import('../src/db/schema.ts')).users).values({ login: 'outsider', name: 'O' }).returning())[0];
    await expect(svc.updateIssue(web, null, 1, { assigneeId: outsider.id })).rejects.toThrow(/not a member/);
    // label w WEB o tej samej nazwie co w ACME jest dozwolony
    await expect(svc.saveLabel(web, { name: 'OnlyAcme', color: '#000' })).resolves.toBeTruthy();
  });

  it('membership: only members see a project, last admin cannot leave', async () => {
    const web = (await projects.getProjectByKey('WEB'))!;
    const owner = (await svc.getMeta(web)).users.find((u) => u.login === 'owner')!;
    const reader = await member('reader2', 'Reader2');
    await expect(projects.requireMember({ id: reader.id, isAdmin: false }, 'WEB')).rejects.toThrow(/not found/);
    await projects.addMember({ id: 0, isAdmin: true }, web.id, 'reader2');
    await expect(projects.requireMember({ id: reader.id, isAdmin: false }, 'web')).resolves.toMatchObject({ role: 'member' });
    // bez klucza: ACME, jeśli jest członkiem
    expect((await projects.requireMember({ id: reader.id, isAdmin: false }, null)).project.key).toBe('ACME');
    await expect(projects.removeMember(web.id, owner.id)).rejects.toThrow(/at least one admin/);
    await projects.removeMember(web.id, reader.id);
    await expect(projects.requireMember({ id: reader.id, isAdmin: false }, 'WEB')).rejects.toThrow(/not found/);
    await expect(projects.createProject(owner.id, { key: 'WEB', name: 'dup' })).rejects.toThrow(/already exists/);
    await expect(projects.createProject(owner.id, { key: 'W3B', name: 'bad' })).rejects.toThrow(/2-6 letters/);
  });

  it('commits link issues of any project by key', async () => {
    const c = { id: 'def456', message: 'WEB-2: fix, see ACME-1', url: 'https://x', timestamp: new Date().toISOString(), author: { name: 'K' } };
    expect((await hooks.recordCommits([c], 'Acme/Web')).sort()).toEqual(['ACME-1', 'WEB-2']);
    const web = (await projects.getProjectByKey('WEB'))!;
    expect((await svc.getIssueDetail(web, 2)).commits).toHaveLength(1);
  });

  it('a project with a repo takes commits only from that repo', async () => {
    const web = (await projects.getProjectByKey('WEB'))!;
    await projects.updateProject(web.id, { githubRepo: 'https://github.com/acme/site.git' });
    expect((await projects.getProjectByKey('WEB'))!.githubRepo).toBe('acme/site');
    const c = { id: 'aaa111', message: 'WEB-2 and ACME-1', url: 'https://x', timestamp: new Date().toISOString(), author: { name: 'K' } };
    expect(await hooks.recordCommits([c], 'acme/web')).toEqual(['ACME-1']);
    const d = { ...c, id: 'bbb222' };
    expect(await hooks.recordCommits([d], 'acme/site')).toEqual(['WEB-2']);
    await expect(projects.updateProject(web.id, { githubRepo: 'not a repo' })).rejects.toThrow(/owner\/name/);
    await projects.updateProject(web.id, { githubRepo: '' });
  });

  it('workspace admin sees every project; project admin cannot create accounts', async () => {
    const boss = await member('boss', 'Boss');
    const bossU = { id: boss.id, isAdmin: true };
    expect((await projects.projectsOf(bossU)).map((x) => x.project.key)).toEqual(expect.arrayContaining(['ACME', 'WEB']));
    await expect(projects.requireMember(bossU, 'WEB')).resolves.toMatchObject({ role: 'admin' });
    const web = (await projects.getProjectByKey('WEB'))!;
    await expect(projects.addMember({ id: boss.id, isAdmin: false }, web.id, 'nobody-yet')).rejects.toThrow(/no tracker account/);
    await expect(projects.addMember(bossU, web.id, 'nobody-yet')).resolves.toBeTruthy();
  });
});

describe('structured analysis', () => {
  const input = (q = 'Kiedy wymagać daty?') => ({
    type: 'bug' as const,
    sections: { verdict: 'Tak · zapis bez daty', after: 'Data wymagana' },
    decisions: [{ question: q, options: [{ label: 'Przy zapisie', desc: 'zawsze', recommended: true }, { label: 'Przy zatwierdzeniu', desc: 'szkic bez daty' }] }],
  });

  it('saves sections as markdown, labels the type (created on demand), swaps it on re-analysis, keeps human labels', async () => {
    const human = await svc.saveLabel(P, { name: 'Ręczna', color: '#fff' });
    const row = await svc.createIssue(P, null, { title: 'analiza', labelIds: [human.id] });
    await svc.requestAnalysis(P, null, row.number);
    await svc.setAnalysis(P, null, row.number, input());
    const names = async () => {
      const meta = await svc.getMeta(P);
      return (await svc.getIssueDetail(P, row.number)).labelIds.map((id) => meta.labels.find((l) => l.id === id)!.name).sort();
    };
    expect(await names()).toEqual(['Bug', 'Ręczna']);
    await svc.setAnalysis(P, null, row.number, { ...input(), type: 'feature' });
    expect(await names()).toEqual(['Feature', 'Ręczna']);
    await svc.setAnalysis(P, null, row.number, input());
    const d = await svc.getIssueDetail(P, row.number);
    expect(d.analysisRequestedAt).toBeNull();
    expect((await svc.getMeta(P)).labels.filter((l) => l.name === 'Bug')).toHaveLength(1);
    expect(d.analysis).toContain('**Does it happen:** Tak · zapis bez daty');
    expect(d.analysis).toContain('**Przy zapisie (recommended):** zawsze');
  });

  it('records a choice in data, markdown and history; re-analysis keeps it by question and option name', async () => {
    const row = await svc.createIssue(P, null, { title: 'decyzja' });
    await svc.setAnalysis(P, null, row.number, input());
    await svc.chooseDecision(P, { id: 1, name: 'Ala' }, row.number, 0, 1, '');
    let d = await svc.getIssueDetail(P, row.number);
    expect(d.analysis).toContain('**Decided: Przy zatwierdzeniu** (Ala)');
    expect(d.activity.some((a) => a.payload.kind === 'decision' && a.payload.answer === 'Przy zatwierdzeniu')).toBe(true);
    // Te same pytanie i opcja w innej kolejności: wybór idzie za nazwą opcji.
    const again = input();
    again.decisions[0].options.reverse();
    await svc.setAnalysis(P, null, row.number, again);
    d = await svc.getIssueDetail(P, row.number);
    expect((d.analysisData as { decisions: { choice?: { option: number } }[] }).decisions[0].choice?.option).toBe(0);
    // Inne pytanie: wybór przepada.
    await svc.setAnalysis(P, null, row.number, input('Inne pytanie?'));
    d = await svc.getIssueDetail(P, row.number);
    expect(d.analysis).not.toContain('Decided');
  });

  it('own answer, clearing, and editing the text drops the structure', async () => {
    const row = await svc.createIssue(P, null, { title: 'inne' });
    await svc.setAnalysis(P, null, row.number, input());
    await svc.chooseDecision(P, null, row.number, 0, null, 'Tylko w szkicu');
    expect((await svc.getIssueDetail(P, row.number)).analysis).toContain('Decided: Tylko w szkicu');
    await svc.chooseDecision(P, null, row.number, 0, null, '');
    expect((await svc.getIssueDetail(P, row.number)).analysis).not.toContain('Decided');
    await expect(svc.chooseDecision(P, null, row.number, 5, 0, '')).rejects.toThrow(/Unknown decision/);
    await svc.updateIssue(P, null, row.number, { analysis: 'ręczny tekst' });
    expect((await svc.getIssueDetail(P, row.number)).analysisData).toBeNull();
  });
});

describe('hardening', () => {
  it('issue numbers are not reused after delete', async () => {
    const a = await svc.createIssue(P, null, { title: 'del-a' });
    await svc.deleteIssue(P, a.number);
    const b = await svc.createIssue(P, null, { title: 'del-b' });
    expect(b.number).toBeGreaterThan(a.number);
  });

  it('rejects parent loops', async () => {
    const a = await svc.createIssue(P, null, { title: 'pl-a' });
    const b = await svc.createIssue(P, null, { title: 'pl-b' });
    await svc.updateIssue(P, null, b.number, { parentNumber: a.number });
    await expect(svc.updateIssue(P, null, a.number, { parentNumber: b.number })).rejects.toThrow(/loop/);
  });

  it('rejects indirect blocking loops', async () => {
    const rel = await import('../src/server/relations.ts');
    const [a, b, c] = await Promise.all(['bl-a', 'bl-b', 'bl-c'].map((t) => svc.createIssue(P, null, { title: t })));
    await rel.addRelation(P, null, a.number, 'blocks', b.number);
    await rel.addRelation(P, null, b.number, 'blocks', c.number);
    await expect(rel.addRelation(P, null, c.number, 'blocks', a.number)).rejects.toThrow(/loop/);
  });

  it('an AI comment does not close a question to a human', async () => {
    const u = await member('ai-q-user', 'AiQ');
    const i = await svc.createIssue(P, null, { title: 'ai-q' });
    await svc.updateIssue(P, null, i.number, { statusId: await statusId('Need Info'), infoFromId: u.id, infoQuestion: 'Czy?' });
    await svc.addComment(P, { id: u.id, name: 'AiQ', ai: true }, i.number, 'odp od agenta');
    expect((await svc.getIssueDetail(P, i.number)).infoQuestion).toBe('Czy?');
  });

  it('addMember without a role keeps an existing admin role', async () => {
    const u = await projects.addMember({ id: 0, isAdmin: true }, P.id, 'keep-admin', 'admin');
    await projects.addMember({ id: 0, isAdmin: true }, P.id, 'keep-admin');
    expect((await projects.membership(u.id, P.id))?.role).toBe('admin');
  });

  it('parallel ensureProjectSprints does not duplicate sprints', async () => {
    const now = new Date(Date.UTC(2031, 0, 10, 12));
    await Promise.all([1, 2, 3].map(() => sprints.ensureProjectSprints(P, now)));
    const list = await sprints.listSprints(P);
    const starts = list.map((s) => s.startsAt.getTime());
    expect(new Set(starts).size).toBe(starts.length);
  });
});

describe('status roles', () => {
  it('Need Info is recognised by role, not by name', async () => {
    const { isNeedInfo } = await import('../src/server/rules.ts');
    expect(isNeedInfo({ role: 'need_info' })).toBe(true);
    expect(isNeedInfo({ role: 'testing' })).toBe(false);
    expect(isNeedInfo({ role: null })).toBe(false);
    expect(isNeedInfo({})).toBe(false);
  });

  it('wasTested follows the testing role even after renaming the status', async () => {
    const meta = await svc.getMeta(P);
    const testing = meta.statuses.find((s) => s.role === 'testing')!;
    expect(testing.name).toBe('Testing');
    await svc.saveStatus(P, { id: testing.id, name: 'QA' });
    const i = await svc.createIssue(P, null, { title: 'role test' });
    expect((await svc.listIssues(P)).find((x) => x.number === i.number)!.wasTested).toBe(false);
    await svc.updateIssue(P, null, i.number, { statusId: testing.id });
    expect((await svc.listIssues(P)).find((x) => x.number === i.number)!.wasTested).toBe(true);
    await svc.saveStatus(P, { id: testing.id, name: 'Testing' });
  });
});

describe('reportDeploy', () => {
  it('a finished deploy marks commits as deployed and keeps the status', async () => {
    const deploys = await import('../src/server/deploys.ts');
    const { issueCommits } = await import('../src/db/schema.ts');
    const { eq } = await import('drizzle-orm');
    const web = await projects.createProject((await member('deployer', 'Deployer')).id, { key: 'DEP', name: 'Deploy' });
    await projects.updateProject(web.id, { githubRepo: 'acme/dep', deploySource: 'webhook' });
    const p = (await projects.getProjectByKey('DEP'))!;
    expect(p.deploySource).toBe('webhook');
    const i = await svc.createIssue(p, null, { title: 'deployed' });
    const c = { id: 'dep0001', message: `fix DEP-${i.number}`, url: 'https://x', timestamp: new Date().toISOString(), author: { name: 'K' } };
    expect(await hooks.recordCommits([c], 'acme/dep')).toEqual([`DEP-${i.number}`]);
    const now = new Date().toISOString();
    await deploys.reportDeploy(p, { status: 'finished', startedAt: now, finishedAt: now, commit: 'dep0001', message: null, author: null });
    expect(deploys.deployStatusOf(p.id)?.status).toBe('finished');
    const [row] = await dbmod.db.select().from(issueCommits).where(eq(issueCommits.sha, 'dep0001'));
    expect(row.deployedAt).toBeInstanceOf(Date);
    expect((await svc.getIssueDetail(p, i.number)).activity.map((a) => a.payload.kind)).toContain('deploy');
  });
});
