import { randomBytes } from 'node:crypto';
import { getTableName, is, sql as dsql, eq } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { db } from '../../db/index.ts';
import * as schema from '../../db/schema.ts';
import { activity, issueCommits, labels, meetingSlots, sprints, users } from '../../db/schema.ts';
import { createProject, addMember, type Project } from '../projects.ts';
import * as svc from '../service.ts';
import { ensureProjectSprints, listSprints } from '../sprints.ts';
import { addRelation } from '../relations.ts';
import { createMeeting, vote } from '../meetings.ts';
import type { AnalysisInput } from '../analysis.ts';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const DAY = 24 * 60 * 60 * 1000;

export type DemoUser = { id: number; name: string; login: string };

/** Fałszywy commit: wpis w issue_commits + aktywność, jak z webhooka GitHuba. */
export async function addDemoCommit(issueId: number, message: string, author: string, committedAt = new Date()) {
  const sha = randomBytes(20).toString('hex');
  const url = `${BASE_URL}/about#how-commits-link`;
  await db.insert(issueCommits).values({ issueId, sha, message, url, author, committedAt });
  await db.insert(activity).values({ issueId, actorId: null, createdAt: committedAt, payload: { kind: 'commit', sha, message, url, author } });
  return sha;
}

/** Oznacza commity zgłoszenia jako wdrożone (jedno wdrożenie = jeden wpis aktywności). */
export async function deployDemoCommits(issueId: number, projectId: number, shas: string[]) {
  const now = new Date();
  for (const sha of shas) await db.update(issueCommits).set({ deployedAt: now }).where(dsql`${issueCommits.issueId} = ${issueId} and ${issueCommits.sha} = ${sha}`);
  const last = shas[shas.length - 1];
  await db.insert(activity).values({ issueId, actorId: null, createdAt: now, payload: { kind: 'deploy', sha: last } });
  await db.insert(schema.deploys).values({ projectId, sha: last, at: now });
}

type Seed = {
  title: string; status: string; prio: number; assignee?: string; labels: string[]; desc: string; creator?: string;
  parent?: number; sprint?: 'active' | 'ended'; notes?: { human: string; ai: string };
};

const LABELS: [string, string][] = [
  ['Bug', '#eb5757'], ['Feature', '#3b82f6'], ['Investigate', '#f2994a'], ['Checkout', '#26b5ce'],
  ['Auth', '#9b51e0'], ['Performance', '#4cb782'], ['Design', '#e5a3c8'],
];

const VAT_DESC = `Customers who enter an EU VAT number with a trailing space (or a lowercase country prefix) can't complete a company purchase.

**Steps to reproduce**
1. Add any product to the cart and open checkout
2. Choose "Company purchase"
3. Enter the VAT ID \`DE123456789 \` (note the trailing space)
4. Click Pay

**Expected:** the order goes through and the VAT ID is accepted.
**Actual:** checkout fails with a generic error toast. The API response:

\`\`\`
POST /api/orders
422 Unprocessable Entity: vat_id invalid
{"field":"vat_id","value":"DE123456789 "}
\`\`\`

Reported by three customers this week, all of them pasted the number from an invoice PDF.`;

// Kolejność ma znaczenie: numer = pozycja + 1, a zgłoszenie nr 12 musi być tym z VAT-em.
const ISSUES: Seed[] = [
  { title: 'Checkout redesign', status: 'In Progress', prio: 2, assignee: 'maya', labels: ['Feature', 'Checkout', 'Design'], creator: 'maya', sprint: 'active',
    desc: 'Umbrella for the new checkout. Goal: fewer steps, fewer abandoned carts.\n\n- One page instead of four steps\n- Saved payment methods for returning customers\n- A summary that stays visible on mobile\n\nTarget: checkout conversion +3 pp compared to September.' },
  { title: 'Single-page checkout layout', status: 'Testing', prio: 2, assignee: 'leo', labels: ['Feature', 'Checkout', 'Design'], creator: 'maya', parent: 1, sprint: 'active',
    desc: 'Merge address, shipping and payment into one page with inline validation.\n\nFigma: "Checkout v3 / single page". The old multi-step flow stays behind the `checkout_v2` flag until the rollout is finished.' },
  { title: 'Saved payment methods in checkout', status: 'In Progress', prio: 3, assignee: 'sara', labels: ['Feature', 'Checkout'], creator: 'maya', parent: 1, sprint: 'active',
    desc: 'Returning customers should be able to pick a saved card instead of retyping it.\n\n- Tokenised cards only, nothing stored on our side\n- "Remove card" in account settings\n- Default card preselected' },
  { title: 'Sticky order summary on mobile', status: 'Todo', prio: 3, assignee: 'tom', labels: ['Feature', 'Checkout', 'Design'], creator: 'maya', parent: 1, sprint: 'active',
    desc: 'On phones the order summary scrolls away, so people lose track of the total. Collapse it into a bar at the bottom that expands on tap.' },
  { title: 'Password reset emails arrive twice', status: 'Done', prio: 2, assignee: 'tom', labels: ['Bug', 'Auth'], creator: 'sara', sprint: 'ended',
    desc: 'Users report two identical reset emails a few seconds apart. The second link invalidates the first, so half of them land on an "expired" page.',
    notes: { human: 'Password reset now sends a single email, and the link works the first time.', ai: '- src/auth/reset.ts: sendResetEmail() was called from both the controller and the `user.reset_requested` event handler; removed the controller call.\n- Added an idempotency key (user id + 5 min bucket) in the mailer queue.\n- tests/auth/reset.test.ts: asserts exactly one email per request.' } },
  { title: 'Rate limit the login endpoint', status: 'Done', prio: 2, assignee: 'leo', labels: ['Feature', 'Auth'], creator: 'maya', sprint: 'ended',
    desc: 'We see credential stuffing attempts in the logs (up to 40 req/s from single IPs). Add a per-IP and per-account limit on `POST /api/login`.',
    notes: { human: 'Login attempts are now limited per IP and per account; repeated failures get a short cool-down instead of unlimited retries.', ai: '- src/auth/rateLimit.ts: sliding window, 10 attempts / 5 min per IP, 5 / 15 min per account, backed by Redis.\n- src/api/login.ts: returns 429 with Retry-After.\n- Config: RATE_LIMIT_LOGIN_* env vars, documented in docs/ops.md.' } },
  { title: 'Product list is slow with 500+ items', status: 'In Progress', prio: 2, assignee: 'sara', labels: ['Bug', 'Performance'], creator: 'tom', sprint: 'active',
    desc: 'Large categories (e.g. "Accessories") take 4-5 s to render on mid-range phones. The list renders every card at once and every card loads its own price request.' },
  { title: 'Add Apple Pay', status: 'Backlog', prio: 0, labels: ['Feature', 'Checkout'], creator: 'maya',
    desc: 'Several customers asked for it. Depends on the payment provider enabling the wallet for our account. Park until the checkout redesign ships.' },
  { title: 'Coupon codes are case sensitive', status: 'Todo', prio: 3, labels: ['Bug', 'Checkout'], creator: 'sara', sprint: 'active',
    desc: 'Entering `welcome10` fails while `WELCOME10` works. Support gets about five tickets a week about this.\n\nExpected: codes are matched case-insensitively and ignore surrounding spaces.' },
  { title: 'Order confirmation email shows the wrong currency', status: 'Testing', prio: 2, assignee: 'tom', labels: ['Bug', 'Checkout'], creator: 'leo', sprint: 'active',
    desc: 'Customers paying in GBP receive a confirmation with prices in EUR (the shop default). The order itself and the invoice are correct, only the email template is wrong.' },
  { title: 'Dark mode for the storefront', status: 'Backlog', prio: 4, labels: ['Feature', 'Design'], creator: 'sara',
    desc: 'Nice to have. Tokens are already in CSS variables, so this is mostly a design pass on product imagery and badges.' },
  { title: 'Checkout fails for EU VAT numbers', status: 'Todo', prio: 2, labels: ['Bug', 'Checkout'], creator: 'sara', sprint: 'active', desc: VAT_DESC },
  { title: 'Guest checkout drops the cart after login', status: 'In Progress', prio: 2, assignee: 'leo', labels: ['Bug', 'Auth', 'Checkout'], creator: 'maya', sprint: 'active',
    desc: 'A guest fills the cart, clicks "Sign in" in the header and comes back to an empty cart. It happens only for some accounts, which makes it hard to reproduce.' },
  { title: 'Move product images to a CDN', status: 'Backlog', prio: 4, labels: ['Performance'], creator: 'tom',
    desc: 'Images are served from the app server today. A CDN with automatic WebP/AVIF would cut load time for visitors outside the EU.' },
  { title: 'Search ignores accents (cafe vs café)', status: 'Todo', prio: 3, assignee: 'maya', labels: ['Bug'], creator: 'leo', sprint: 'active',
    desc: 'Searching "cafe" does not find "Café Racer Helmet" and the other way around. Probably the Postgres full-text config without `unaccent`.' },
  { title: 'Shareable wishlist link', status: 'Backlog', prio: 4, labels: ['Feature'], creator: 'sara',
    desc: 'Let customers share a read-only link to their wishlist (gift lists around the holidays).' },
  { title: 'Session expires mid-checkout on slow connections', status: 'In Progress', prio: 3, assignee: 'sara', labels: ['Investigate', 'Auth', 'Checkout'], creator: 'maya', sprint: 'active',
    desc: 'A few customers on mobile data lose their session on the payment step. Could be the 15 min idle timeout, could be the token refresh failing silently.' },
  { title: 'Reduce JS bundle size of the product page', status: 'In Progress', prio: 3, assignee: 'leo', labels: ['Performance'], creator: 'tom', sprint: 'active',
    desc: 'The product page ships 410 KB of JS (gzip). Lighthouse flags the image gallery and the reviews widget. Target: under 250 KB.' },
  { title: 'Order tracking page', status: 'Todo', prio: 3, assignee: 'sara', labels: ['Feature'], creator: 'maya', sprint: 'active',
    desc: 'Customers should see where their parcel is without writing to support. Pull tracking events from the carrier API and show them on the order page and in the shipping email.' },
  { title: 'Two-factor authentication for staff accounts', status: 'Todo', prio: 2, assignee: 'tom', labels: ['Feature', 'Auth'], creator: 'maya', sprint: 'active',
    desc: 'Staff accounts can refund orders and export customer data, but are protected by a password only. Add TOTP-based 2FA, required for the admin role.' },
  { title: 'Shipping estimate shows NaN for remote postcodes', status: 'Done', prio: 1, assignee: 'leo', labels: ['Bug', 'Checkout'], creator: 'sara', sprint: 'ended',
    desc: 'For postcodes outside the main delivery zones the estimate shows "NaN days". Blocks checkout for those customers.',
    notes: { human: 'Customers in remote areas now see a real delivery estimate instead of "NaN days", and can finish checkout.', ai: '- src/shipping/estimate.ts: estimateDays() assumed every zone has `maxDays`; remote zones only define `baseDays`. Added a fallback of baseDays + 3.\n- src/shipping/zones.ts: made the zone type explicit.\n- src/shipping/estimate.test.ts: cases for remote, island and unknown postcodes.' } },
  { title: 'Product gallery images have no alt text', status: 'Done', prio: 4, assignee: 'sara', labels: ['Bug', 'Design'], creator: 'tom', sprint: 'ended',
    desc: 'Accessibility audit: gallery images have empty alt attributes.',
    notes: { human: 'Product images now have descriptive alt text for screen readers.', ai: '- src/components/Gallery.tsx: alt falls back to `${product.name} - view ${index + 1}`.\n- Added an eslint rule (jsx-a11y/alt-text) to keep it that way.' } },
  { title: 'Upgrade to Node 22 LTS', status: 'Done', prio: 3, assignee: 'tom', labels: ['Performance'], creator: 'tom', sprint: 'ended',
    desc: 'Node 20 reaches end of life next year. Upgrade the runtime, CI images and the Docker base image.',
    notes: { human: 'The platform runs on Node 22 LTS now; no change for customers.', ai: '- Dockerfile and .github/workflows/ci.yml: node:22-alpine.\n- Bumped sharp and bcrypt to versions with Node 22 prebuilt binaries.\n- All 412 tests pass; p95 latency on staging unchanged.' } },
  { title: 'Returns portal: printable return labels', status: 'Testing', prio: 3, assignee: 'maya', labels: ['Feature'], creator: 'maya', sprint: 'active',
    desc: 'Customers can request a return in the portal, but then wait for support to email a label. Generate the PDF label automatically for eligible orders.' },
  { title: 'Order export fails above 10k rows', status: 'Testing', prio: 2, assignee: 'tom', labels: ['Bug', 'Performance'], creator: 'leo', sprint: 'active',
    desc: 'The admin CSV export times out for large date ranges. Needs streaming instead of building the file in memory.' },
  { title: 'Cart total flickers when applying a coupon', status: 'In Progress', prio: 3, assignee: 'sara', labels: ['Bug', 'Design'], creator: 'tom', sprint: 'active',
    desc: 'The total briefly shows the old value, then the discounted one, then the old one again. Looks like two requests racing.' },
  { title: 'Link to the status page in the footer', status: 'Done', prio: 4, assignee: 'maya', labels: ['Feature'], creator: 'maya', sprint: 'active',
    desc: 'Add a "System status" link to the footer.',
    notes: { human: 'The footer now links to our public status page.', ai: '- src/components/Footer.tsx: added link, reads STATUS_PAGE_URL from config.' } },
  { title: 'Remove the legacy PayPal button', status: 'Canceled', prio: 4, labels: ['Checkout'], creator: 'tom',
    desc: 'Cancelled: the new provider integration covers PayPal, and the old button is removed together with the checkout redesign.' },
];

const analysis = (a: AnalysisInput): AnalysisInput => a;

const ANALYSES: Record<number, AnalysisInput> = {
  9: analysis({
    type: 'bug',
    sections: {
      verdict: 'Yes · the coupon lookup uses an exact string match, so `welcome10` never finds `WELCOME10`.',
      howToCheck: 'Add an item, enter `welcome10` in the coupon field and apply it. Compare with `WELCOME10`.',
      system: 'The same lookup runs when a coupon is pre-applied from a campaign link (`?coupon=`), so those links fail too.',
      risk: 'Existing codes that differ only by case would collide after normalising. A quick query shows none today.',
    },
    decisions: [{ question: 'How should codes be normalised?', options: [
      { label: 'Store upper-case', desc: 'Migration once, fast lookups', recommended: true },
      { label: 'Compare case-insensitively', desc: 'No migration, slightly slower query' },
    ] }],
  }),
  15: analysis({
    type: 'bug',
    sections: {
      verdict: 'Yes · the search index is built without accent folding, so "cafe" and "café" are different tokens.',
      howToCheck: 'Search for "cafe" in the storefront. "Café Racer Helmet" is missing from the results.',
      system: 'Used by the storefront search, the admin product search and the "related products" widget.',
      risk: 'Re-indexing the catalogue takes about 8 minutes; search quality drops briefly while it runs.',
    },
    decisions: [{ question: 'Where should accents be folded?', options: [
      { label: 'In the index', desc: 'Best ranking, needs a re-index', recommended: true },
      { label: 'In the query only', desc: 'Quick, but misses accented queries' },
    ] }],
  }),
  19: analysis({
    type: 'feature',
    sections: {
      current: 'Customers get a confirmation and a "shipped" email with a carrier link. The order page shows only the status.',
      system: 'New carrier client (webhook plus polling fallback), a `tracking_events` table, and a section on the order page and in the shipping email.',
      after: 'The order page shows a timeline (packed, in transit, out for delivery, delivered) and the email links to it.',
      risk: 'Carrier APIs differ in quality; unknown events need a safe fallback instead of an error.',
    },
    decisions: [
      { question: 'How do we get tracking updates?', options: [
        { label: 'Carrier webhooks', desc: 'Near real time, needs public endpoint', recommended: true },
        { label: 'Polling', desc: 'Simple, delayed by up to 30 min' },
      ] },
    ],
  }),
  20: analysis({
    type: 'feature',
    sections: {
      current: 'Staff sign in with email and password. There is no second factor and no session limit for the admin role.',
      system: 'Touches the login flow, the account settings page and the admin role checks. A recovery path is needed for lost devices.',
      after: 'Admins must enrol an authenticator app on next login; recovery codes are shown once and can be regenerated.',
      risk: 'Locked-out admins. Keep a documented break-glass procedure before enforcing it.',
    },
    decisions: [
      { question: 'Which second factor first?', options: [
        { label: 'TOTP app', desc: 'Works offline, one library', recommended: true },
        { label: 'SMS codes', desc: 'Easier for users, weaker security' },
        { label: 'Passkeys', desc: 'Best UX, larger project' },
      ] },
      { question: 'When do we enforce it?', options: [
        { label: 'Admins only, now', desc: 'Covers the risky accounts first', recommended: true },
        { label: 'All staff, later', desc: 'Needs onboarding and support' },
      ] },
    ],
  }),
};

const COMMENTS: Record<number, [string, string][]> = {
  2: [['leo', 'Layout is in. I kept the old flow behind `checkout_v2` so we can roll back per customer.'], ['maya', 'Looks great on desktop. On a 360px screen the card number field overflows, can you check?'], ['leo', 'Fixed in the last push, retested on a small Android.']],
  7: [['sara', 'Profiling shows 60% of the time goes into the per-card price requests. Batching them into one call.'], ['tom', 'Do we also virtualise the list? 500 DOM nodes of cards is still heavy on low-end phones.']],
  9: [['sara', 'Support counted 23 tickets about this in the last month.'], ['maya', 'Quick win, let\'s get it into this sprint.']],
  10: [['tom', 'Fix is in staging: the template now reads the currency from the order, not from the shop settings.'], ['leo', 'Checked with a GBP and a CHF order, both show the right symbol.']],
  13: [['maya', 'Seen it on three accounts so far, all created before March.'], ['leo', 'Looks like the cart is keyed by the anonymous session id and not merged after login. Still digging.']],
  21: [['sara', 'Can confirm: a postcode in the Shetland Islands now shows "5 days".']],
  26: [['sara', 'Reproduced with the network throttled to Slow 3G. The second request wins even if it was sent first.'], ['tom', 'We could ignore stale responses by tagging each request with a counter.']],
};

export async function seedDemo() {
  // Wszystkie tabele aplikacji naraz (bez tabeli migracji drizzle).
  const tables = (Object.values(schema) as unknown[]).filter((t): t is PgTable => is(t, PgTable)).map((t) => `"${getTableName(t)}"`);
  await db.execute(dsql.raw(`truncate table ${tables.join(', ')} restart identity cascade`));

  const people = await db.insert(users).values([
    { login: 'demo', name: 'You' },
    { login: 'maya', name: 'Maya Chen' },
    { login: 'leo', name: 'Leo Park' },
    { login: 'sara', name: 'Sara Novak' },
    { login: 'tom', name: 'Tom Reyes' },
  ]).returning();
  const U = Object.fromEntries(people.map((u) => [u.login, u]));
  const actorOf = (login: string) => ({ id: U[login].id, name: U[login].name });
  const demo = U.demo;

  // ---- ACME ----
  const acme = await createProject(U.maya.id, { key: 'ACME', name: 'Acme Web', color: '#5e6ad2' });
  const admin = { id: U.maya.id, isAdmin: true };
  await addMember(admin, acme.id, 'demo', 'admin');
  for (const l of ['leo', 'sara', 'tom']) await addMember(admin, acme.id, l, 'member');
  await db.update(schema.projects).set({ githubRepo: 'acme/web' }).where(eq(schema.projects.id, acme.id));
  const P: Project = { ...acme, githubRepo: 'acme/web' };

  const lbl = await db.insert(labels).values(LABELS.map(([name, color]) => ({ projectId: P.id, name, color }))).returning();
  const L = Object.fromEntries(lbl.map((l) => [l.name, l.id]));

  // Wcześniejszy, zakończony sprint (do widoku Sprint review); aktywny i planowany dokłada ensureProjectSprints.
  const now = Date.now();
  const [ended] = await db.insert(sprints).values({
    projectId: P.id, name: 'Sprint 1', startsAt: new Date(now - 28 * DAY), endsAt: new Date(now - 14 * DAY), status: 'ended',
    reviewNotes: 'Shipped the login hardening and the shipping-estimate fix. Password reset duplicates are gone. The VAT problem came up after the sprint closed.',
  }).returning();
  await ensureProjectSprints(P);
  const active = (await listSprints(P)).find((s) => s.status === 'active')!;

  const meta = await svc.getMeta(P);
  const S = Object.fromEntries(meta.statuses.map((s) => [s.name, s.id]));

  const created: Record<number, number> = {}; // numer -> id
  for (const [i, s] of ISSUES.entries()) {
    const row = await svc.createIssue(P, actorOf(s.creator ?? 'maya'), {
      title: s.title, description: s.desc, statusId: S[s.status], priority: s.prio,
      assigneeId: s.assignee ? U[s.assignee].id : null, labelIds: s.labels.map((n) => L[n]),
      parentNumber: s.parent ?? null, sprintId: s.sprint === 'ended' ? ended.id : s.sprint === 'active' ? active.id : null,
      ...(s.notes ? { changeHuman: s.notes.human, changeAi: s.notes.ai } : {}),
    });
    if (row.number !== i + 1) throw new Error(`Demo seed: expected number ${i + 1}, got ${row.number}`);
    created[row.number] = row.id;
  }
  if (!ISSUES[11].title.startsWith('Checkout fails for EU VAT')) throw new Error('Demo seed: issue 12 must be the VAT bug');

  // Pytania Need Info: do Toma (od Leo) i do Mai (od Sary). Nie do gościa: pierwsze wejście ma pokazać
  // jedną historię (przewodnik), bez odznak i banerów "czeka na Ciebie".
  const needInfo = S['Need Info'];
  await svc.updateIssue(P, actorOf('leo'), 13, {
    statusId: needInfo, infoFromId: U.tom.id,
    infoQuestion: 'Do the affected customers use the same browser profile for guest and signed-in sessions? I suspect the anonymous cart cookie is replaced on login. Can you check one of the support tickets?',
  });
  await svc.updateIssue(P, actorOf('sara'), 17, {
    statusId: needInfo, infoFromId: U.maya.id,
    infoQuestion: 'Is the 15 min idle timeout a product decision, or can we raise it to 30 min on the payment step?',
  });

  // Komentarze ludzi.
  for (const [n, list] of Object.entries(COMMENTS)) for (const [who, body] of list) await svc.addComment(P, actorOf(who), Number(n), body);

  // Relacje.
  await addRelation(P, actorOf('maya'), 4, 'waits_on', 2);
  await addRelation(P, actorOf('sara'), 9, 'blocks', 26);

  // Analizy od "agenta" (ta sama ścieżka co set_analysis przez MCP), jedna decyzja już podjęta.
  const ai = { ...actorOf('demo'), ai: true };
  for (const n of [9, 15, 19, 20]) await svc.setAnalysis(P, ai, n, ANALYSES[n]);
  await svc.chooseDecision(P, actorOf('maya'), 19, 0, 0, '');

  // Ślad pracy, commity, wdrożenie i opisy zmian: #21 (Done, wdrożone) i #24 (Testing).
  await svc.upsertWorklog(P, ai, 21, {
    session: 'demo-seed-21', repo: 'acme/web', files: ['src/shipping/estimate.ts', 'src/shipping/zones.ts', 'src/shipping/estimate.test.ts'],
    commits: [], prompts: ['We are working on ACME-21: Shipping estimate shows NaN for remote postcodes. Read the issue and fix the root cause.'],
  });
  const sha21a = await addDemoCommit(created[21], 'ACME-21: fall back to baseDays when a zone has no maxDays', 'leo');
  const sha21b = await addDemoCommit(created[21], 'ACME-21: tests for remote postcodes', 'leo');
  await deployDemoCommits(created[21], P.id, [sha21a, sha21b]);
  await svc.upsertWorklog(P, ai, 24, {
    session: 'demo-seed-24', repo: 'acme/web', files: ['src/returns/label.ts', 'src/returns/portal.tsx', 'src/returns/label.test.ts'],
    commits: [], prompts: ['We are working on ACME-24: Returns portal: printable return labels. Start with the label PDF generator.'],
  });
  await addDemoCommit(created[24], 'ACME-24: generate return label PDF for eligible orders', 'maya');
  await addDemoCommit(created[24], 'ACME-24: show the download button in the returns portal', 'maya');
  await svc.updateIssue(P, actorOf('maya'), 24, {
    changeHuman: 'Customers can download a return label straight from the returns portal when their order is eligible.',
    changeAi: '- src/returns/label.ts: buildLabel(order) renders the PDF with the carrier barcode; eligibility check in isReturnable().\n- src/returns/portal.tsx: download button, disabled with a reason when the order is not eligible.\n- src/returns/label.test.ts: eligible, expired window and partial return cases.',
  });

  // ---- MOB ----
  const mob = await createProject(U.leo.id, { key: 'MOB', name: 'Acme Mobile', color: '#26b5ce' });
  await addMember({ id: U.leo.id, isAdmin: true }, mob.id, 'demo', 'member');
  await addMember({ id: U.leo.id, isAdmin: true }, mob.id, 'maya', 'member');
  await addMember({ id: U.leo.id, isAdmin: true }, mob.id, 'sara', 'member');
  await ensureProjectSprints(mob);
  const mobSprint = (await listSprints(mob)).find((s) => s.status === 'active')!;
  const mobMeta = await svc.getMeta(mob);
  const MS = Object.fromEntries(mobMeta.statuses.map((s) => [s.name, s.id]));
  const mobIssues: [string, string, number, string | null, string][] = [
    ['Push notification opens the wrong screen', 'In Progress', 2, 'leo', 'Tapping an order update opens the home tab instead of the order.'],
    ['Biometric login on Android 14', 'Todo', 3, 'sara', 'Fingerprint prompt does not appear on some Pixel devices after the October update.'],
    ['Offline mode for the order history', 'Backlog', 0, null, 'Cache the last 20 orders so the screen works without a connection.'],
    ['App icon is blurry on iPad', 'Todo', 4, null, 'The 1024px icon was exported without the large variant.'],
    ['Crash when scanning a damaged barcode', 'Testing', 2, 'maya', 'The scanner throws on malformed EAN-13 codes. Return a friendly error instead.'],
    ['Update the store screenshots', 'Done', 4, 'maya', 'New screenshots for the redesigned home screen, 6.7" and 6.1" sizes.'],
  ];
  for (const [title, status, prio, who, desc] of mobIssues) {
    await svc.createIssue(mob, actorOf('leo'), {
      title, description: desc, statusId: MS[status], priority: prio, assigneeId: who ? U[who].id : null, sprintId: mobSprint.id,
    });
  }

  // ---- Spotkanie: ankieta terminów ----
  const at = (days: number, hour: number) => { const d = new Date(now + days * DAY); d.setUTCHours(hour, 0, 0, 0); return d; };
  const m = await createMeeting(P, actorOf('maya'), {
    title: 'Checkout redesign: launch planning', kind: 'poll',
    slots: [{ startsAt: at(2, 13), endsAt: at(2, 14) }, { startsAt: at(3, 15), endsAt: at(3, 16) }],
  });
  const slots = await db.select().from(meetingSlots).where(eq(meetingSlots.meetingId, m.id)).orderBy(meetingSlots.id);
  await vote(P, actorOf('maya'), slots[0].id, 'yes');
  await vote(P, actorOf('maya'), slots[1].id, 'maybe');
  await vote(P, actorOf('leo'), slots[0].id, 'no');
  await vote(P, actorOf('leo'), slots[1].id, 'yes');
  // Gość już zagłosował: bez banera "Vote" i odznaki w kalendarzu przy pierwszym wejściu.
  await vote(P, actorOf('demo'), slots[0].id, 'yes');
  await vote(P, actorOf('demo'), slots[1].id, 'yes');

  // ---- Daty: zgłoszenia mają wyglądać na prowadzone od tygodni ----
  for (const [i, s] of ISSUES.entries()) {
    const number = i + 1;
    const age = s.sprint === 'ended' ? 26 : Math.max(0, Math.round(22 - number * 0.75));
    if (!age) continue;
    const id = created[number];
    const iv = dsql`make_interval(days => ${age}::int)`;
    await db.execute(dsql`update issues set created_at = created_at - ${iv}, updated_at = updated_at - ${iv} where id = ${id}`);
    await db.execute(dsql`update comments set created_at = created_at - ${iv}, updated_at = updated_at - ${iv} where issue_id = ${id}`);
    await db.execute(dsql`update activity set created_at = created_at - ${iv} where issue_id = ${id}`);
    await db.execute(dsql`update issue_commits set committed_at = committed_at - ${iv}, deployed_at = deployed_at - ${iv} where issue_id = ${id}`);
  }
  for (const [i, s] of ISSUES.entries()) {
    if (s.status !== 'Done') continue;
    const done = s.sprint === 'ended' ? new Date(now - (16 + (i % 4)) * DAY) : new Date(now - 2 * DAY);
    await db.update(schema.issues).set({ completedAt: done }).where(eq(schema.issues.id, created[i + 1]));
  }

  await svc.publish({ type: 'projects' });
  return { users: U, project: P };
}
