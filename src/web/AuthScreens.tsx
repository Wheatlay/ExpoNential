import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api, useConfig } from './api.ts';
import { BrandMark } from './icons.tsx';
import { linkProps } from './router.ts';
import { t } from './i18n.ts';

const providerStyle = { height: 40, padding: '0 20px' };

function GitHubLogo() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 0z" /></svg>;
}

function GoogleLogo() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" /></svg>;
}

/** Przyciski włączonych dostawców; z `invite` prowadzą przez logowanie z zaproszeniem. */
function ProviderButtons({ invite }: { invite?: string }) {
  const providers = useConfig().data?.providers;
  const q = invite ? `?invite=${encodeURIComponent(invite)}` : '';
  return (
    <>
      {providers?.google && <a className="btn" href={`/auth/google${q}`} style={providerStyle}><GoogleLogo />{t('Continue with Google')}</a>}
      {providers?.github && <a className="btn" href={`/auth/login${q}`} style={providerStyle}><GitHubLogo />{t('Continue with GitHub')}</a>}
    </>
  );
}

const errText = (e: unknown) => (e instanceof ApiError ? t(e.message) : t('Something went wrong'));

export function Login() {
  const demo = useConfig().data?.demo;
  const err = new URLSearchParams(location.search).get('error');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const messages: Record<string, string> = {
    not_allowed: t('Your account is not on the team list. Ask an admin to add you.'),
    state: t('Login expired, try again.'),
    github: t('GitHub login failed, try again.'),
    google: t('Google login failed, try again.'),
    invite: t('This invite is no longer valid.'),
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    api('/auth/password', { method: 'POST', body: { email: email.trim(), password } })
      .then(() => location.assign('/'))
      .catch((x) => { setError(errText(x)); setBusy(false); });
  };
  return (
    <div className="login">
      <div className="login-card">
        <BrandMark size={44} />
        <h1>{t('Log in to Exponential')}</h1>
        {err && <div className="err">{messages[err] ?? t('Login failed')}</div>}
        <form className="login-card" onSubmit={submit}>
          <input className="input" type="email" autoComplete="username" placeholder={t('E-mail')} aria-label={t('E-mail')} value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="password" autoComplete="current-password" placeholder={t('Password')} aria-label={t('Password')} value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="err">{error}</div>}
          <button className="btn primary" type="submit" disabled={busy || !email.trim() || !password}>{t('Log in')}</button>
        </form>
        <ProviderButtons />
        {demo && <a className="btn" href="/auth/demo?tour=1" style={providerStyle}>{t('Try the live demo')}</a>}
      </div>
    </div>
  );
}

/** Ekran zaproszenia (/invite/:token): niezalogowany zakłada konto (hasło, Google albo GitHub), zalogowany tylko dołącza. */
// loggedIn z App, nie własne useMe(): drugi obserwator zapytania w stanie błędu (401) odpala je od nowa przy montowaniu,
// App wtedy chowa ekran na czas ładowania i powstaje pętla zapytań /api/me.
export function Invite({ token, loggedIn }: { token: string; loggedIn: boolean }) {
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => api<{ projectName: string; role: 'admin' | 'member' }>(`/api/invites/${token}`), retry: false, staleTime: Infinity });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (info.isLoading) return null;
  if (!info.data) {
    return (
      <div className="login">
        <div className="login-card">
          <BrandMark size={44} />
          <h1>{t('This invite is no longer valid.')}</h1>
          <div className="hint">{t('Ask the person who sent it for a new link.')}</div>
          <a className="btn" {...linkProps('/')}>{t('Back to board')}</a>
        </div>
      </div>
    );
  }
  const { projectName, role } = info.data;
  const goTo = (key: string) => location.assign(`/?project=${key}`);
  const fail = (x: unknown) => { setError(errText(x)); setBusy(false); };
  const accept = () => { setBusy(true); setError(''); api<{ projectKey: string }>(`/api/invites/${token}/accept`, { method: 'POST' }).then((r) => goTo(r.projectKey)).catch(fail); };
  const register = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    api<{ projectKey: string }>(`/auth/invite/${token}/register`, { method: 'POST', body: { name: name.trim(), email: email.trim(), password } }).then((r) => goTo(r.projectKey)).catch(fail);
  };
  return (
    <div className="login">
      <div className="login-card">
        <BrandMark size={44} />
        <h1>{t('Invitation to {project}', { project: projectName })}</h1>
        <div className="hint">{role === 'admin' ? t('You will join as an admin.') : t('You will join as a member.')}</div>
        {error && <div className="err">{error}</div>}
        {loggedIn ? (
          <button className="btn primary" disabled={busy} onClick={accept}>{t('Join {project}', { project: projectName })}</button>
        ) : (
          <>
            <form className="login-card" onSubmit={register}>
              <input className="input" autoComplete="name" placeholder={t('Name')} aria-label={t('Name')} value={name} onChange={(e) => setName(e.target.value)} />
              <input className="input" type="email" autoComplete="username" placeholder={t('E-mail')} aria-label={t('E-mail')} value={email} onChange={(e) => setEmail(e.target.value)} />
              <input className="input" type="password" autoComplete="new-password" placeholder={t('Password (at least 10 characters)')} aria-label={t('Password')} value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className="btn primary" type="submit" disabled={busy || !name.trim() || !email.trim() || password.length < 10}>{t('Create account')}</button>
            </form>
            <div className="hint">{t('or continue with')}</div>
            <ProviderButtons invite={token} />
            <a className="btn" {...linkProps('/login')}>{t('I already have an account')}</a>
          </>
        )}
      </div>
    </div>
  );
}

/** Ekran resetu hasła (/reset/:token): link od admina, jednorazowy. */
export function Reset({ token }: { token: string }) {
  const info = useQuery({ queryKey: ['reset', token], queryFn: () => api<{ name: string }>(`/api/reset/${token}`), retry: false, staleTime: Infinity });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (info.isLoading) return null;
  if (!info.data) {
    return (
      <div className="login">
        <div className="login-card">
          <BrandMark size={44} />
          <h1>{t('This link is no longer valid.')}</h1>
          <div className="hint">{t('Ask an admin for a new password link.')}</div>
          <a className="btn" {...linkProps('/login')}>{t('Log in')}</a>
        </div>
      </div>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    api(`/auth/reset/${token}`, { method: 'POST', body: { password } }).then(() => location.assign('/')).catch((x) => { setError(errText(x)); setBusy(false); });
  };
  return (
    <div className="login">
      <div className="login-card">
        <BrandMark size={44} />
        <h1>{t('New password for {name}', { name: info.data.name })}</h1>
        <form className="login-card" onSubmit={submit}>
          <input className="input" type="password" autoComplete="new-password" placeholder={t('Password (at least 10 characters)')} aria-label={t('Password')} value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="err">{error}</div>}
          <button className="btn primary" type="submit" disabled={busy || password.length < 10}>{t('Save password')}</button>
        </form>
      </div>
    </div>
  );
}
