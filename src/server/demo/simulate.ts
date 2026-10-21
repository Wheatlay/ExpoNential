import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { issueLabels, labels } from '../../db/schema.ts';
import * as svc from '../service.ts';
import { identifier } from '../rules.ts';
import type { Project } from '../projects.ts';
import type { AnalysisInput } from '../analysis.ts';
import { addDemoCommit, deployDemoCommits, type DemoUser } from './seed.ts';

export type Kind = 'analyze' | 'work';
export type Step = { at: number; run: () => Promise<unknown> };
type Logger = { error: (e: unknown, msg?: string) => void };

const active = new Set<string>();
export const isBusy = (p: Project, number: number) => active.has(identifier(p.key, number));

async function issueInfo(p: Project, number: number) {
  const row = await svc.requireIssue(p, number);
  const ls = await db.select({ name: labels.name }).from(issueLabels).innerJoin(labels, eq(labels.id, issueLabels.labelId)).where(eq(issueLabels.issueId, row.id));
  return { title: row.title, isBug: ls.some((l) => l.name === 'Bug') };
}

const VAT_ANALYSIS: AnalysisInput = {
  type: 'bug',
  sections: {
    verdict: 'Yes · the VAT check runs on the raw input, so a trailing space or lowercase prefix fails validation.',
    howToCheck: "Checkout → company purchase → VAT ID 'DE123456789 ' (trailing space) → Pay → 422.",
    system: 'Same validator is used by the invoice settings page and the public API (POST /orders).',
    risk: 'Normalising on the server changes what we store; existing invoices keep the raw value.',
  },
  decisions: [
    { question: 'Where should we normalise VAT IDs?', options: [
      { label: 'Server, on save', desc: 'One fix for UI and API', recommended: true },
      { label: 'Only in the form', desc: 'API clients still fail' },
    ] },
    { question: 'Validate against the EU VIES service?', options: [
      { label: 'Not now', desc: 'Format check only, no new dependency', recommended: true },
      { label: 'Yes, async', desc: 'Catches fake numbers, slower checkout' },
    ] },
  ],
};

async function analysisFor(p: Project, number: number): Promise<AnalysisInput> {
  if (p.key === 'ACME' && number === 12) return VAT_ANALYSIS;
  const { isBug } = await issueInfo(p, number);
  if (isBug) {
    return {
      type: 'bug',
      sections: {
        verdict: 'Yes · the behaviour in the description is reproducible from the code path it describes.',
        howToCheck: 'Follow the steps in the description on a staging account and compare the result with the expected one.',
        system: 'The affected code is shared with neighbouring flows, so they need a quick check for the same behaviour.',
        risk: 'A fix can change behaviour other screens rely on; cover it with a regression test.',
      },
      decisions: [{ question: 'How wide should the fix be?', options: [
        { label: 'Targeted fix', desc: 'Smallest change, lowest risk', recommended: true },
        { label: 'Refactor the area', desc: 'Cleaner, but a bigger review' },
      ] }],
    };
  }
  return {
    type: 'feature',
    sections: {
      current: 'Today this is not supported; the closest existing flow is handled separately in the web app and the API.',
      system: 'The change touches the UI, the API and the notification templates.',
      after: 'Users can do this end to end, and the existing flows stay unchanged.',
      risk: 'New behaviour should sit behind a feature flag until support has been briefed.',
    },
    decisions: [{ question: 'Ship it behind a feature flag?', options: [
      { label: 'Yes, flag it', desc: 'Gradual rollout, easy rollback', recommended: true },
      { label: 'No, ship to all', desc: 'Faster, harder to undo' },
    ] }],
  };
}

/** Kroki symulacji agenta: te same funkcje serwisu co przy MCP, z actor.ai = true. */
export function steps(kind: Kind, p: Project, number: number, demoUser: DemoUser): Step[] {
  const actor = { id: demoUser.id, name: demoUser.name, ai: true };
  const id = identifier(p.key, number);
  const is12 = p.key === 'ACME' && number === 12;

  if (kind === 'analyze') {
    return [
      { at: 0, run: () => svc.requestAnalysis(p, actor, number) },
      { at: 1200, run: () => svc.upsertWorklog(p, actor, number, {
        session: `demo-${number}-analyze`, repo: 'acme/web', files: ['src/checkout/vat.ts'], commits: [],
        prompts: [`Analyze ${id} with tracker:analyze-tracker-ticket`],
      }) },
      { at: 3000, run: () => svc.upsertWorklog(p, actor, number, {
        session: `demo-${number}-analyze`, repo: 'acme/web', files: ['src/checkout/vat.test.ts', 'src/api/orders.ts'], commits: [], prompts: [],
      }) },
      { at: 6000, run: async () => svc.setAnalysis(p, actor, number, await analysisFor(p, number)) },
    ];
  }

  const shas: string[] = [];
  const msgs = is12
    ? [`${id}: normalise VAT IDs before validation`, `${id}: tests for VAT IDs with spaces and lowercase prefixes`]
    : [`${id}: implement the change`, `${id}: add tests`];
  const statusId = async (name: string) => {
    const s = (await svc.getMeta(p)).statuses.find((x) => x.name === name);
    if (!s) throw new Error(`No status ${name}`);
    return s.id;
  };
  return [
    { at: 0, run: async () => svc.updateIssue(p, actor, number, { statusId: await statusId('In Progress'), assigneeId: demoUser.id }) },
    { at: 1500, run: async () => {
      const { title } = await issueInfo(p, number);
      await svc.upsertWorklog(p, actor, number, {
        session: `demo-${number}-work`, repo: 'acme/web',
        files: is12 ? ['src/checkout/vat.ts', 'src/checkout/vat.test.ts', 'src/api/orders.ts'] : ['src/app/feature.ts', 'src/app/feature.test.ts'],
        commits: [], prompts: [`We are working on ${id}: ${title}. Read the analysis and the decisions on the issue first.`],
      });
    } },
    { at: 3500, run: async () => {
      const row = await svc.requireIssue(p, number);
      for (const m of msgs) shas.push(await addDemoCommit(row.id, m, demoUser.name));
      await svc.upsertWorklog(p, actor, number, { session: `demo-${number}-work`, repo: 'acme/web', files: [], prompts: [], commits: shas.map((sha, i) => ({ sha, message: msgs[i] })) });
    } },
    { at: 5500, run: async () => svc.updateIssue(p, actor, number, { statusId: await statusId('Testing') }) },
    { at: 7000, run: async () => {
      const row = await svc.requireIssue(p, number);
      await deployDemoCommits(row.id, p.id, shas);
      await svc.publish({ type: 'issue', projectKey: p.key, number });
    } },
    { at: 8500, run: async () => {
      const { title } = await issueInfo(p, number);
      await svc.updateIssue(p, actor, number, is12 ? {
        changeHuman: 'Company customers can enter VAT IDs with spaces or a lowercase country prefix; checkout accepts them.',
        changeAi: '- src/checkout/vat.ts: added normaliseVatId() (trim, strip inner spaces, uppercase the country prefix); validateVat() calls it first.\n- src/api/orders.ts: POST /orders stores the normalised value; existing invoices keep the raw one.\n- src/checkout/vat.test.ts: cases for trailing space, inner spaces and lowercase prefix.',
      } : {
        changeHuman: `${title}: done and deployed.`,
        changeAi: `- Implemented the change described in ${id} (see the commits on this issue).\n- Added tests next to the changed code.`,
      });
    } },
    { at: 9000, run: () => svc.addComment(p, actor, number, 'Done and deployed. Ready for review — the change notes are filled in.') },
  ];
}

/** Odpala kroki w tle (setTimeout); zbiór aktywnych pilnuje, żeby jedno zgłoszenie miało jednego agenta naraz. */
export function simulate(p: Project, number: number, kind: Kind, demoUser: DemoUser, log?: Logger) {
  const key = identifier(p.key, number);
  if (active.has(key)) return false;
  active.add(key);
  const list = steps(kind, p, number, demoUser);
  list.forEach((s, i) => {
    setTimeout(async () => {
      try { await s.run(); } catch (e) { log?.error(e, `demo simulation ${kind} ${key} step ${i}`); }
      if (i === list.length - 1) active.delete(key);
    }, s.at);
  });
  return true;
}

