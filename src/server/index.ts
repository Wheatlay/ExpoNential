import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runMigrations } from '../db/index.ts';
import { registerAuth } from './auth.ts';
import { registerDemo } from './demo/index.ts';
import { registerApi } from './api.ts';
import { registerEvents } from './events.ts';
import { registerMcp } from './mcp.ts';
import { registerOAuth } from './oauth.ts';
import { registerHooks } from './hooks.ts';
import { seedDefaults } from './service.ts';
import { ensureSprints } from './sprints.ts';
import { registerUploads, UPLOADS_DIR } from './uploads.ts';
import { registerDeploys } from './deploys.ts';
import { registerCoolify } from './coolify.ts';
import { registerMeetings } from './meetingsApi.ts';
import { ensureSprintReviews, runReminders } from './meetings.ts';
import { onSprintsEnsured } from './sprints.ts';
import { maskUrl } from './rules.ts';
import { marketplace, pluginArchive } from './plugin.ts';
import { agentScriptsVersion } from './agents.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webDir = path.join(root, 'dist/web');

await runMigrations();
// Każdy sprint ma automatyczne sprint review (tworzone i przesuwane razem ze sprintem).
onSprintsEnsured(ensureSprintReviews);
await seedDefaults();
await ensureSprints();
setInterval(() => void ensureSprints().catch((e) => app.log.error(e)), 60 * 60 * 1000);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', serializers: { req: (req) => ({ method: req.method, url: maskUrl(req.url) }) } }, trustProxy: true, bodyLimit: 5 * 1024 * 1024 });
await app.register(cookie);
await registerAuth(app);
await registerDemo(app); // zaraz po auth: hooki blokad demo obejmują wszystkie trasy rejestrowane niżej
await registerApi(app);
await registerEvents(app);
await registerMcp(app);
await registerOAuth(app);
await registerHooks(app);
await registerUploads(app);
await registerDeploys(app);
await registerCoolify(app);
await registerMeetings(app);

// Przypomnienia o spotkaniach: co 30 s wysyłamy te, których czas minął (bez dubli, patrz reminder_sends).
const reminders = setInterval(() => void runReminders(new Date(), app.log).catch((e) => app.log.error(e)), 30_000);
app.addHook('onClose', async () => clearInterval(reminders));

app.get('/health', async () => ({ ok: true }));

// Skrypty lokalnej analizy do "irm <adres> | iex": bez sekretów, więc publiczne. Adres trackera wstawiany
// tutaj, żeby instalator nie wymagał parametrów; repo projektów instalator pobiera z /api/projects.
const AGENT_FILES = ['install.ps1', 'uninstall.ps1', 'tracker-handler.ps1', 'tracker-agent.ps1'];
app.get<{ Params: { file: string }; Querystring: { first?: string } }>('/agent/:file', async (req, reply) => {
  // Plugin Claude Code (skille + hook śladu pracy), patrz src/server/plugin.ts. Bez sekretów, więc publiczny.
  if (req.params.file === 'plugin.zip') return reply.type('application/zip').header('Cache-Control', 'no-store').send(pluginArchive().zip);
  if (req.params.file === 'marketplace.json') return reply.header('Cache-Control', 'no-store').send(marketplace(process.env.BASE_URL ?? 'http://localhost:3000'));
  // Instalator do pobrania i dwukliku: kopiowanie "irm … | iex" do schowka blokują filtry anty-ClickFix (np. uBlock Origin),
  // a plik uruchamia ten sam skrypt z serwera. Token pierwszej instalacji (?first=1) wkleja się przy uruchomieniu, w pliku go
  // nie ma; aktualizacja o nic nie pyta. Teksty ASCII: cmd.exe w stronie kodowej konsoli psuje polskie znaki.
  if (req.params.file === 'exponential-install.cmd' || req.params.file === 'exponential-uninstall.cmd') {
    const base = process.env.BASE_URL ?? 'http://localhost:3000';
    const install = req.params.file === 'exponential-install.cmd';
    const first = install && req.query.first === '1';
    const lines = install
      ? ['@echo off', `rem Exponential: ${first ? 'polaczenie tego komputera' : 'aktualizacja polaczenia'} z Claude Code (Ustawienia > Claude Code).`,
        'set "TRACKER_TOKEN="',
        ...(first ? [
          'echo Token jest w schowku (skopiowany w Exponential: Ustawienia ^> Claude Code ^> Utworz polecenie instalacji).',
          'set /p "TRACKER_TOKEN=Wklej token (prawy klik albo Ctrl+V) i nacisnij Enter: "',
        ] : ['echo Aktualizacja polaczenia z Exponential...']),
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm '${base}/agent/install.ps1' | iex"`, 'set "TRACKER_TOKEN="', 'echo.', 'pause']
      : ['@echo off', 'rem Exponential: usuniecie lokalnej analizy z tego komputera.',
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm '${base}/agent/uninstall.ps1' | iex"`, 'echo.', 'pause'];
    return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="${req.params.file}"`)
      .header('Cache-Control', 'no-store').send(lines.join('\r\n') + '\r\n');   // CRLF: cmd.exe źle czyta same LF
  }
  // Wersja skryptów PC: instalator zapisuje ją w config.json, agent zgłasza ją serwerowi (Ustawienia proszą o aktualizację).
  if (req.params.file === 'version') return reply.type('text/plain').header('Cache-Control', 'no-store').send(agentScriptsVersion());
  if (!AGENT_FILES.includes(req.params.file)) return reply.code(404).send('Not found');
  const body = readFileSync(path.join(process.cwd(), 'scripts/local-agent', req.params.file), 'utf8')
    .replaceAll('__TRACKER_URL__', process.env.BASE_URL ?? 'http://localhost:3000');
  return reply.type('text/plain; charset=utf-8').header('Cache-Control', 'no-store').send(body);
});

mkdirSync(UPLOADS_DIR, { recursive: true });
// Załączniki tylko dla zalogowanych (w Linearze też były za autoryzacją).
await app.register(async (r) => {
  r.addHook('onRequest', async (req, reply) => { if (!req.user) return reply.code(401).send({ error: 'Not signed in' }); });
  await r.register(fstatic, { root: UPLOADS_DIR, prefix: '/uploads/', decorateReply: false });
});

if (existsSync(webDir)) {
  // index.html zawsze świeży (nowy deploy widać od razu), pliki z hashem w nazwie na zawsze w cache.
  await app.register(fstatic, {
    root: webDir, prefix: '/', cacheControl: false,
    setHeaders: (res, file) => res.header('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  // SPA: każda nieznana ścieżka (np. /issue/ACME-12) dostaje index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}

// '::' słucha na IPv4 i IPv6; healthcheck Coolify woła localhost, które w kontenerze bywa ::1.
await app.listen({ host: '::', port: Number(process.env.PORT ?? 3000) });
