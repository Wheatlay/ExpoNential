import { oauthPost } from './api';
import { updateConfig } from './config';
import { openUrl } from './util';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function cmdLogin(args: string[]) {
  const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const url = (opt('--url') || process.env.EXPONENTIAL_URL || '').replace(/\/+$/, '');
  const token = opt('--token');
  if (!/^https?:\/\//.test(url)) throw new Error('usage: login --url https://your-tracker [--token trk_...]');

  if (token) {   // trk_ tokens are long-lived, no refresh
    updateConfig((c) => { c.url = url; c.token = token; delete c.oauth; });
    console.log(`Logged in to ${url} with a token.`);
    return;
  }

  // OAuth device flow (RFC 8628) with dynamic client registration.
  // TODO(verify): endpoint request encoding against the server implementation (register: JSON, others: form).
  const reg = await oauthPost(url, '/oauth/register', { client_name: 'Exponential agent', redirect_uris: ['http://127.0.0.1/cb'] }, true);
  const clientId: string = reg.client_id;
  if (!clientId) throw new Error(`registration failed: ${reg.error || 'no client_id'}`);
  const dev = await oauthPost(url, '/oauth/device_authorization', { client_id: clientId });
  if (!dev.device_code) throw new Error(`device authorization failed: ${dev.error || 'no device_code'}`);
  console.log(`Your code: ${dev.user_code}`);
  console.log(`Type this code in the browser: ${dev.verification_uri}`);
  openUrl(dev.verification_uri);

  let interval = Number(dev.interval) || 5;
  const deadline = Date.now() + (Number(dev.expires_in) || 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const r = await oauthPost(url, '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dev.device_code, client_id: clientId });
    if (r.access_token) {
      updateConfig((c) => {
        c.url = url; delete c.token;
        c.oauth = { access: r.access_token, refresh: r.refresh_token ?? '', expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000, clientId };
      });
      console.log(`Logged in to ${url}.`);
      return;
    }
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') { interval += 5; continue; }
    throw new Error(`login failed: ${r.error || 'unknown error'}`);
  }
  throw new Error('login timed out');
}
