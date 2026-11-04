import { pl } from './pl.ts';

/**
 * Język interfejsu: angielski tekst w kodzie jest kluczem, słownik pl.ts go tłumaczy. Wybór zapisany
 * na koncie (Settings › Appearance) i w przeglądarce, domyślnie język przeglądarki. Zmiana przeładowuje stronę,
 * więc t() nie potrzebuje kontekstu Reacta. Kompletność słownika sprawdza tests/i18n.test.ts.
 */
export type Lang = 'en' | 'pl';

function detect(): Lang {
  try {
    const saved = localStorage.getItem('lang');
    if (saved === 'en' || saved === 'pl') return saved;
  } catch { /* prywatne okno */ }
  return navigator.language?.toLowerCase().startsWith('pl') ? 'pl' : 'en';
}

export const lang: Lang = detect();
/** Locale do dat i godzin (24h w obu językach). */
export const locale = lang === 'pl' ? 'pl-PL' : 'en-GB';
document.documentElement.lang = lang;

/** Zapisuje wybór w koncie (serwer to źródło prawdy dla przeglądarki i agenta), potem w przeglądarce i przeładowuje. */
export async function setLang(l: Lang) {
  try {
    await fetch('/api/me', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'exponential' }, body: JSON.stringify({ lang: l }), credentials: 'same-origin' });
  } catch { /* offline: wybór i tak zostaje w przeglądarce */ }
  try { localStorage.setItem('lang', l); } catch { /* prywatne okno */ }
  location.reload();
}

/** Po załadowaniu /api/me: język z konta wygrywa z lokalnym. Jedno przeładowanie (flaga w sessionStorage chroni przed pętlą). */
export function syncLangFromServer(serverLang: Lang | null | undefined) {
  if (serverLang !== 'en' && serverLang !== 'pl') {
    // Profile empty but this browser has a choice from before the profile setting existed: move it to the profile once
    // (the agent and other browsers follow the profile).
    let saved: string | null = null;
    try { saved = localStorage.getItem('lang'); } catch { /* storage blocked */ }
    if (serverLang === null && (saved === 'en' || saved === 'pl')) {
      void fetch('/api/me', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'exponential' }, body: JSON.stringify({ lang: saved }) }).catch(() => {});
    }
    return;
  }
  if (serverLang === lang) return;
  try {
    if (sessionStorage.getItem('langSynced')) return;
    sessionStorage.setItem('langSynced', '1');
    localStorage.setItem('lang', serverLang);
  } catch { return; }
  location.reload();
}

type Vars = Record<string, string | number | null | undefined>;
const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m)) : s);

/** t('Delete {id}?', { id }) */
export function t(s: string, vars?: Vars): string {
  return fill(lang === 'pl' ? (pl[s] ?? s) : s, vars);
}

const plural = new Intl.PluralRules(locale);

/**
 * Liczebnik: tn(n, '{n} issue', '{n} issues'). Po polsku trzy formy w słowniku pod kluczem
 * "one|other": '{n} zgłoszenie|{n} zgłoszenia|{n} zgłoszeń' (1 / 2-4 / 5+).
 */
export function tn(n: number, one: string, other: string, vars?: Vars): string {
  const all = { n, ...vars };
  if (lang === 'pl') {
    const forms = pl[`${one}|${other}`]?.split('|');
    if (forms) {
      const r = plural.select(n);
      return fill(r === 'one' ? forms[0] : r === 'few' ? forms[1] : forms[2] ?? forms[1], all);
    }
  }
  return fill(n === 1 ? one : other, all);
}
