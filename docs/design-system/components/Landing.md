Strona startowa publicznego dema (`Landing`); widzą ją tylko niezalogowani, gdy serwer działa w trybie demo.

- Kiedy: wejście na `/` bez sesji w `DEMO_MODE`. Zalogowany użytkownik dostaje board, nie landing.
- Budowa (`.landing` > `.landing-inner`, kolumna do 720, wyśrodkowana): znak i nazwa (`.landing-brand`, `text-xl`) · `h1` z tezą (`text-3xl`) · opis `.landing-sub` (`text-lg`, `text-secondary`) · pięć kroków `.flow` · przyciski `.landing-actions` · podpowiedź `hint` · link „Team login with GitHub” (`.landing-team`, `hint`).
- Krok `.flow-step`: karta (`bg-card`, ramka `border-primary`, `radius-lg`, wypełnienie 12) z ikoną w `step-dot`, numerem (`hint`), nazwą (pogrubiona) i jednym zdaniem (`hint`). Kroki: Issue, Agent analysis, Your decision, Agent ships, Change notes.
- Przyciski `.landing-cta`: wysokość `control-lg`, odstęp poziomy 16. „Try the live demo” jest `primary` i prowadzi do `/auth/demo?tour=1`; „How it works” otwiera `/about`; „GitHub” tylko gdy serwer podał `repoUrl`.
- Błąd logowania (`.err`, `danger-text`) pokazuje się nad krokami, gdy w adresie jest `?error=`.
- Teksty przez `t('…')`, nowe hasła w `pl.ts`.
- Mobile: do 900 szerokości kroki układają się w jedną kolumnę (`.flow`), przyciski zawijają się i są wyśrodkowane; strona przewija się w pionie (`overflow-y: auto`).
