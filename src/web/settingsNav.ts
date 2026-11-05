import { navigate } from './router.ts';

/** Przejście do Ustawienia › My AI z otwartą sekcją Repos (np. z pigułki "brak PC z repo" przy analizie). */
export function openAgentRepos() {
  navigate('/settings#claude');
  let tries = 0;
  const go = () => {
    const el = document.getElementById('agent-repos');
    if (!el) { if (++tries < 20) setTimeout(go, 150); return; }
    if (el instanceof HTMLDetailsElement) el.open = true;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  };
  setTimeout(go, 150);
}
