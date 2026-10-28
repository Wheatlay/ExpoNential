// Bundles src/cli.ts into dist/agent.cjs (esbuild); with "exe" also builds a Node SEA executable.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const mode = process.argv[2] || 'bundle';
mkdirSync('dist', { recursive: true });
// Embed ../plugin as { 'relative/path': 'text' }; the agent extracts it at runtime (engine.ts ensurePlugin).
const pluginFiles = {};
const walk = (d, rel = '') => { for (const e of readdirSync(join(d, rel), { withFileTypes: true })) {
  const r = rel ? rel + '/' + e.name : e.name;
  if (e.isDirectory()) walk(d, r); else pluginFiles[r] = readFileSync(join(d, r), 'utf8');
} };
walk('../plugin');
await build({ define: { __PLUGIN_FILES__: JSON.stringify(pluginFiles) }, entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/agent.cjs', logLevel: 'info' });
if (mode !== 'exe') process.exit(0);

const win = process.platform === 'win32';
const exe = join('dist', win ? 'exponential-agent.exe' : 'exponential-agent');
writeFileSync('dist/sea-config.json', JSON.stringify({ main: 'dist/agent.cjs', output: 'dist/sea-prep.blob', disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json'], { stdio: 'inherit' });
copyFileSync(process.execPath, exe);
const require = createRequire(import.meta.url);
const postject = join(require.resolve('postject/package.json'), '..', 'dist', 'cli.js');
const args = [postject, exe, 'NODE_SEA_BLOB', 'dist/sea-prep.blob', '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });
console.log(`built ${exe}`);
