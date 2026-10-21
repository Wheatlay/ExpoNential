# Exponential - rules for agents

## The design system is binding

Every change in `src/web` (look, component, UI text) follows the design system:

- Repo: `docs/design-system/README.md` (rules), `docs/design-system/tokens.json` (values),
  `docs/design-system/components/<Component>.md` (component cards).

Before changing the UI, read the system README and the card of the component you touch.

**A deviation needs the repo owner's approval before committing.** A deviation is: a new color, font size, radius,
control height or shadow outside the tokens; a literal (`#hex`, `13px`, `border-radius: 10px`) in `styles.css` or in
`style={{...}}` outside the exceptions list in the README; a new component pattern or behavior different from the card
(e.g. hiding instead of graying out, the system `confirm()`, native `<input type="date|time">`). No token for what you
need? Ask, do not add one.

A change to the system itself (tokens, scales, cards) also needs approval, and after it: `src/web/styles.css` (theme
blocks and `:root` scales) and `docs/design-system/` change in the same commit.

## Other repo rules

- UI texts go through `t('...')` from `src/web/i18n.ts`; add the new key to `src/web/pl.ts` (enforced by `tests/i18n.test.ts`).
- Commit files by name, not `git add -A`: several people work in the repo at the same time.
- Before deploying: `git archive HEAD | docker build -` and a healthcheck (the Dockerfile runs `tsc --noEmit`).
- Tests run against a real Postgres: `docker compose -p tracker up -d`, then `npm test`.
