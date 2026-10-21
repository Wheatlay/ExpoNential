Strona „How Exponential works” (`About`) dla technicznego czytelnika; dostępna bez logowania pod `/about`.

- Kiedy: opis tezy, przepływu pracy, architektury i decyzji projektowych; link z landingu i z dema. Treść zmienia się razem z produktem.
- Budowa (`.about` > `.about-inner`, kolumna do 720): przycisk „Back” (`btn sm`, „Back to board” dla zalogowanych) · nagłówek `.about-head` ze znakiem marki i `h1` (`text-3xl`) · sekcje z `id` (`why`, `workflow`, `how-commits-link`, `architecture`, `decisions`, `run-it`, `demo`), każda z `h2` (`text-2xl`).
- Tekst: akapity i listy `text-lg`, `text-secondary`, interlinia 1,6. `code` w tekście: `bg-tertiary`, ramka `border-secondary`, `radius-sm`.
- Kroki `.about-steps`: lista kart (`bg-card`, `border-primary`, `radius-lg`), nazwa kroku pogrubiona w `text-primary`, pod nią opis.
- Blok kodu `.about-code`: `bg-secondary`, ramka `border-secondary`, `radius-lg`, przewija się poziomo.
- Diagram architektury `.about-diagram` (SVG): węzły `bg-card` z ramką `border-tertiary`; rdzeń (Fastify) z ramką `accent`, Claude Code z ramką `ai`; krawędzie `text-tertiary`, podpisy `text-xs`. Ma `role="img"` i `aria-label`.
- Przyciski: „Source on GitHub” (tylko gdy jest `repoUrl`) i „Try the live demo” (`primary`, tylko niezalogowani).
- `scroll-margin-top: 16` na sekcjach, żeby kotwice nie przyklejały się do krawędzi.
- Mobile: kolumna zajmuje całą szerokość z marginesem 16; kod i diagram przewijają się poziomo (diagram ma minimalną szerokość 520), strona nie przewija się poziomo.
