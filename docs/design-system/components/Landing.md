Strona startowa publicznego dema (`Landing`, wariant B2); widzą ją tylko niezalogowani, gdy serwer działa w trybie demo.

- Kiedy: wejście na `/` bez sesji w `DEMO_MODE`. Zalogowany użytkownik dostaje board, nie landing.
- Budowa (`.landing`, kolumna wyśrodkowana): nagłówek `.landing-head` (do 1180: znak i nazwa po lewej, linki „How it works” i „GitHub” po prawej, GitHub tylko gdy serwer podał `repoUrl`) · hero `.landing-hero` z jednoliniowym `h1` („AI agents do the legwork.” + drugie zdanie w `text-tertiary`, rozmiar `clamp(28px, 4vw, 42px)`, bo tokeny kończą się na `text-3xl`; na mobile `text-3xl`) · przycisk „Try the live demo” (`btn primary landing-cta`, `/auth/demo?tour=1`) · podpowiedź `hint` · podgląd produktu `LandingPreview`.
- Podgląd (`.lp-wrap` > `.lp-frame`, do 1000): przycięty kadr prawdziwej strony zgłoszenia, zbudowany z klas używanych w `IssuePage` i `AnalysisView` (`issue-title`, `start-btn`, `fold-group`, `panel ai`, `decision`, `props-panel`, `prop`). Ramka `border-secondary`, górne rogi `radius-xl`, bez dolnej krawędzi, poświata z `shadow-popover`. Wysokość ograniczona (520) i 80 px przejścia `bg-app` do przezroczystego na dole.
- Podgląd jest statyczny: `aria-hidden`, `inert`, bez elementów fokusowalnych; czytnik ekranu dostaje ukryty opis (`.lp-sr`). Zawartość to dane na sztywno (ACME-12, analiza, decyzja z wybraną opcją, wiersze HUMAN i TECH, status Testing, przypisany „You”, dwa commity z rakietą wdrożenia).
- Mobile (do 760): kolumna właściwości jest ukryta, podgląd skaluje się do pełnej szerokości; strona nie przewija się poziomo.
- Pięć kroków `Flow` nie jest już na landingu (zostaje w „How it works”).
- Teksty przez `t('…')`, nowe hasła w `pl.ts`.
