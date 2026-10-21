# Skill prompt evals

A small harness for testing the prompts of the `analysis` and `close` skills against a set of tickets.

- `run.mjs` runs Claude Code (the binary from the VS Code extension) once per ticket in `fixtures.json`,
  using the `SKILL.md` of a chosen variant. Each ticket runs against a snapshot of your repo at its `base` commit.
  Results go to `results/<variant>/<id>-<run>.json`.
- `score.mjs` scores those results: objective metrics plus an optional LLM judge (`--judge`) that knows the real fix.

Usage (from the repo root):

    node evals/analysis/run.mjs --variant baseline --runs 3 [--model sonnet] [--only PROJ-1] [--parallel 4] [--repo <path>]
    node evals/analysis/score.mjs baseline v1 [--judge]
    node evals/close/run.mjs --variant baseline --runs 3
    node evals/close/score.mjs baseline v1 [--judge]

Required files (not included, the original fixtures came from a private project):

- `evals/<skill>/fixtures.json`: a list of `{id, title, description, base, truthFiles, fixCommits}`.
  `close` fixtures additionally use `commits` and `humanReference`.
- `evals/<skill>/variants/<variant>/SKILL.md`: the skill prompt under test.
- The target repository, via `--repo` or the `TARGET_REPO` env var (git history needed for `base`).
- In `analysis/run.mjs`, fill the `LABELS` constant with your project's labels.
