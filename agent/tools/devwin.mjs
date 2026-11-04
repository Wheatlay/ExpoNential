// Drives the agent's WebView2 windows for testing on a dev machine (no Playwright: the windows are native).
// The agent must run with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 (see agent/README.md).
// Usage: node agent/tools/devwin.mjs <command> [args]
//   list                      pages (agent windows) open now
//   eval <js>                 run JS in the settings window, print the result
//   click <text>              click the first button/tab/row whose visible text contains <text>
//   key <Key>                 press a key in the settings window (e.g. Escape)
//   shot <file.png>           screenshot of the settings window
//   health                    "Not Responding" check of the agent process (tasklist)
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const PORT = process.env.DEVWIN_PORT ?? '9333';
const [cmd, ...args] = process.argv.slice(2);

async function pages() {
  const r = await fetch(`http://localhost:${PORT}/json`);
  return (await r.json()).filter((p) => p.type === 'page');
}

async function settingsPage() {
  const ps = await pages();
  // The settings window is the one with the tablist; fall back to the first page.
  for (const p of ps) {
    const has = await cdp(p, 'Runtime.evaluate', { expression: '!!document.querySelector("[role=tablist]")', returnByValue: true }).catch(() => null);
    if (has?.result?.value) return p;
  }
  if (!ps.length) throw new Error('no agent window open (run: exponential-agent open)');
  return ps[0];
}

let nextId = 1;
function cdp(page, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const id = nextId++;
    const timer = setTimeout(() => { ws.close(); reject(new Error(`${method}: no answer in 5 s (window hung?)`)); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== id) return;
      clearTimeout(timer);
      ws.close();
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
  });
}

const evalIn = async (js) => (await cdp(await settingsPage(), 'Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })).result?.value;

const run = {
  async list() { for (const p of await pages()) console.log(p.id, p.url.slice(0, 60)); },
  async eval() { console.log(JSON.stringify(await evalIn(args.join(' ')), null, 1)); },
  async click() {
    const text = args.join(' ');
    const r = await evalIn(`(() => { const t = ${JSON.stringify(text)}.toLowerCase();
      const el = [...document.querySelectorAll('button,[role=tab],[role=switch],a')].find((e) => e.textContent.trim().toLowerCase().includes(t));
      if (!el) return 'not found'; el.click(); return 'clicked: ' + el.textContent.trim().slice(0, 40); })()`);
    console.log(r);
  },
  async key() {
    const p = await settingsPage();
    const key = args[0];
    await cdp(p, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 });
    await cdp(p, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 });
    console.log('key', key);
  },
  async shot() {
    const r = await cdp(await settingsPage(), 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(args[0], Buffer.from(r.data, 'base64'));
    console.log('saved', args[0]);
  },
  async health() {
    const out = execSync('tasklist /FI "IMAGENAME eq exponential-agent*" /FO CSV /V /NH', { encoding: 'utf8' });
    const rows = out.trim().split(/\r?\n/).filter((l) => l.includes('exponential-agent'));
    for (const l of rows) {
      const c = l.split('","').map((s) => s.replace(/"/g, ''));
      console.log(`${c[0]} pid ${c[1]}: ${c[5]} · window: ${c[8]}`);
    }
    if (!rows.length) console.log('agent not running');
  },
};

if (!run[cmd]) { console.log('commands:', Object.keys(run).join(', ')); process.exit(1); }
run[cmd]().catch((e) => { console.error('error:', e.message); process.exit(1); });
