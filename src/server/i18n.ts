/** Język wiadomości wysyłanych przez serwer (Discord, push, przypomnienia). Instancja = jeden zespół: APP_LOCALE=en|pl. */
export const LOCALE: 'en' | 'pl' = process.env.APP_LOCALE === 'pl' ? 'pl' : 'en';

/** Klucze angielskie -> polskie. Brak wpisu = ten sam tekst (push po angielsku zostaje po angielsku). */
const pl: Record<string, string> = {
  // pytanie z Need Info (komentarz)
  'Question for {who}': 'Pytanie do {who}', 'anyone': 'kogokolwiek',
  // analiza AI (analysis.ts render)
  'Type': 'Typ', 'bug': 'błąd', 'feature': 'funkcja', 'to investigate': 'do zbadania',
  'Does it happen': 'Czy występuje', 'How to reproduce': 'Jak odtworzyć', 'Current state': 'Stan obecny', 'Answer': 'Odpowiedź',
  'Anything to do': 'Czy jest co robić', 'Also affects': 'Co jeszcze to dotyka', 'After the change': 'Po zmianie', 'Watch out for': 'Uwaga na',
  'Related': 'Powiązane', 'Decided': 'Ustalono', 'recommended': 'polecam', 'To decide': 'Do decyzji',
  'Test message from Exponential': 'Wiadomość próbna z Exponential',
  'Deleted user': 'Usunięty użytkownik',
  'Deploy failed: {env} {commit}': 'Deploy nieudany: {env} {commit}',
  'Make someone else admin of {project} first': 'Najpierw daj komuś admina w {project}',
  'Make someone else a workspace admin first': 'Najpierw daj komuś admina workspace',
  'Poll: {title}': 'Ankieta: {title}',
  '{count} to choose from, you can propose another. Organized by {name}.': '{count} do wyboru, możesz zaproponować inny. Organizuje {name}.',
  '{n} time': '{n} termin',
  '{n} times': '{n} terminów',
  '{n} times (few)': '{n} terminy',
  'New meeting: {title}': 'Nowe spotkanie: {title}',
  'New time proposal: {title}': 'Nowa propozycja terminu: {title}',
  '{name} proposes {when}{reason}. Vote.': '{name} proponuje {when}{reason}. Zagłosuj.',
  ' (“{reason}”)': ' („{reason}”)',
  'Time picked: {title}': 'Termin wybrany: {title}',
  'Cancelled: {title}': 'Odwołane: {title}',
  'everyone said yes': 'wszyscy się zgodzili',
  'Everyone voted. Pick a time.': 'Wszyscy zagłosowali. Wybierz termin.',
  'is starting now': 'zaczyna się teraz',
  'tomorrow': 'jutro',
  'in {n} h': 'za {n} h',
  'in {n} minutes': 'za {n} minut',
  '[truncated{full}]': '[ucięte{full}]',
  ', full text: get_issue {id}': ', całość: get_issue {id}',
  '## Description': '## Opis',
  '## AI analysis (from the tracker)': '## Analiza AI (z trackera)',
  '## Recent comments': '## Ostatnie komentarze',
  '… and {n} older (list_comments {id})': '… i {n} starszych (list_comments {id})',
};

export function st(s: string, vars?: Record<string, string | number>) {
  const base = LOCALE === 'pl' ? (pl[s] ?? s) : s;
  return vars ? base.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : base;
}
