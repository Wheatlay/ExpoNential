import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Plugin Claude Code "tracker" (skille analizy i zamykania + hook śladu pracy) z katalogu `plugin/`,
 * serwowany jako zip i marketplace pod /agent/. Jedno źródło dla wszystkich projektów i komputerów:
 *   claude plugin marketplace add <BASE_URL>/agent/marketplace.json
 *   claude plugin install tracker@tracker
 * Wersja to skrót treści, więc każda zmiana w `plugin/` po deployu jest nową wersją.
 */
const ROOT = path.join(process.cwd(), 'plugin');
const PLUGIN_VERSION: string = (JSON.parse(readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;

let cached: { zip: Buffer; sha256: string; version: string } | null = null;

function files(dir: string, rel = ''): { name: string; data: Buffer }[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const abs = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    return statSync(abs).isDirectory() ? files(abs, r) : [{ name: r, data: readFileSync(abs) }];
  });
}

/** Minimalny zip (deflate, bez katalogów i bez dat), deterministyczny: ta sama treść = ten sam skrót. */
function zip(entries: { name: string; data: Buffer }[]) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(0, 10); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    local.push(head, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(0, 12); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

export function pluginArchive() {
  if (!cached) {
    const z = zip(files(ROOT));
    const sha256 = createHash('sha256').update(z).digest('hex');
    cached = { zip: z, sha256, version: `${PLUGIN_VERSION}+${sha256.slice(0, 12)}` };
  }
  return cached;
}

export function marketplace(baseUrl: string) {
  const { sha256, version } = pluginArchive();
  return {
    name: 'tracker',
    description: 'Tracker zespołu: analiza zgłoszeń, zamykanie (HUMAN/TECH) i ślad pracy w zgłoszeniu',
    owner: { name: 'Tracker' },
    plugins: [{
      name: 'tracker',
      description: 'Skille analyze-tracker-ticket i close-ticket oraz hook śladu pracy (worklog) dla projektów trackera',
      version,
      source: { source: 'archive', url: `${baseUrl}/agent/plugin.zip`, sha256 },
    }],
  };
}
