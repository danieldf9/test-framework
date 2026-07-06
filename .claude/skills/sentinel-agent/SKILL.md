---
name: sentinel-agent
description: This skill should be used when the user asks to "run the sentinel tests", "check sentinel status", "review heals", "review unverified heals", "answer escalations", "promote heals", "migrate tests to sentinel", "integrate sentinel into a project", "set up sentinel", "write a sentinel test", "write intents", "fill in TODO intents", "generate the sentinel report", "run the chaos test", "why did this test heal", "set up LLM healing", or otherwise wants to onboard, author tests for, operate, inspect, or troubleshoot the Sentinel self-healing Playwright framework (integration, intents, suites, healing, escalations, promotion, flake stats, LLM spend).
---

# Sentinel Agent

Operate and manage Sentinel, the self-healing Playwright test framework in this
repository. Sentinel pairs each test step's locator with a semantic `intent`; when a
locator breaks it diagnoses the failure (drift / regression / environment / test-data),
heals pure locator drift through tiered matching (cache → fuzzy → optional LLM), escalates
to a human when unsure, and records everything in a SQLite state DB under `.sentinel/`.

## Lifecycle coverage map

The skill covers the full lifecycle; each stage has a runbook:

| Stage                                  | Where                                                         |
| -------------------------------------- | ------------------------------------------------------------- |
| Integrate a new project (zero → green) | `references/project-integration.md`                           |
| Migrate an existing Playwright suite   | `references/workflows.md` → Migration runbook                 |
| Write tests and intents                | `references/intent-authoring.md`                              |
| Run, triage, inspect state             | This file + `references/workflows.md` (status digest, triage) |
| Review heals / answer escalations      | `references/workflows.md` (protocols below apply)             |
| Promote heals into specs               | `references/workflows.md` → Promotion runbook                 |
| Enable LLM tiers / CI / chaos          | `references/workflows.md`                                     |

## Working directory rule

Every `sentinel` command discovers `sentinel.config.ts` by walking **up** from the current
directory, and all state resolves relative to that config file. Always run commands from
the directory that owns the suite:

- In this repository: `examples/tests/` (the demo suite). The demo app must be running
  first: `pnpm demo:serve` from the repo root (serves http://127.0.0.1:4173).
- In an end-user project: the project root containing `sentinel.config.ts`.

When results look empty or wrong, first verify which config was picked up:
`npx sentinel doctor` prints the config path and DB location.

## Command quick reference

| Task                        | Command                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Health check (always first) | `npx sentinel doctor`                                              |
| Run suite with summary      | `npx sentinel run [--grep <p>] [--heal auto\|suggest\|off]`        |
| Markdown summary of a run   | `npx sentinel summary [--run <id>\|--run-prefix <p>]`              |
| HTML report                 | `npx sentinel report` → `.sentinel/report/index.html`              |
| List pending questions      | `npx sentinel escalations`                                         |
| Answer a question           | `npx sentinel escalations --choose <id> <A\|B\|C\|REDESIGN>`       |
| Preview spec write-back     | `npx sentinel promote --dry-run`                                   |
| Apply write-back            | `npx sentinel promote [--branch <name>] [--include-unverified]`    |
| Adopt a vanilla suite       | `npx sentinel migrate <dir> [--dry-run]`                           |
| Move state to/from CI       | `npx sentinel db export --json <f>` / `npx sentinel db import <f>` |
| Full acceptance test        | `pnpm chaos` (repo root; proves healing + golden rule end to end)  |

## Inspecting state: the query script

The CLI does not list heals, flake stats, or LLM spend (those live in the HTML report).
Use the bundled read-only script for machine-readable views — run it from the suite
directory:

```bash
node <skill-dir>/scripts/sentinel-query.mjs <view> [--json] [--limit n]
```

Views: `runs` (recent runs + heal/escalation counts), `heals` (audit rows with old→new
locator, tier, confidence, screenshot paths; filters `--mode UNVERIFIED`, `--unpromoted`,
`--run <prefix>`, `--test <substr>`), `escalations` (pending questions with candidates),
`flaky` (pass+fail on same SHA), `spend` (LLM cost by provider×model×purpose), `steps`
(non-passed step rows; `--all` for everything). It exports via `sentinel db export`
internally — never writes to the DB.

For a status digest, combine: `doctor` → `runs --limit 5` → `escalations` →
`heals --mode UNVERIFIED --limit 10`.

## Triaging a failed run

Read the first line of the failure: `[sentinel] <CLASSIFICATION>: <reason>`. Act by
classification:

| Classification                        | Meaning                                          | Action                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRODUCT_REGRESSION`                  | Element genuinely gone (by design, never healed) | Treat as a potential real bug FIRST. Inspect the failure screenshot in `.sentinel/artifacts/`, report findings to the user. Only suggest `REDESIGN` if evidence shows an intentional change. |
| `LOCATOR_DRIFT` + `healing exhausted` | Healing not confident enough                     | A pending escalation exists — surface its candidates to the user (see workflow below).                                                                                                       |
| `ENVIRONMENT`                         | Network/5xx/crash, already retried               | Check the app under test is up (demo: `pnpm demo:serve`). Recurring → check `flaky` view.                                                                                                    |
| `TEST_DATA`                           | Unexpected auth wall / seed data                 | Fix credentials/fixtures; healing is intentionally not attempted.                                                                                                                            |
| `UNKNOWN`                             | No fingerprint history                           | Fix the locator manually and get one green run to create the baseline.                                                                                                                       |

Test statuses: `passed` (trust), `passed_unverified` (an applied heal at confidence
0.60–0.90 needs human review — inspect before/after screenshots from the `heals` view or
report), `failed` (triage as above).

## Integrating a new project

For "set up sentinel in my project" requests, follow the phased runbook in
`references/project-integration.md`: install (npm registry, or local `file:` links from a
built clone while packages are unpublished) → `sentinel init` → config decisions
(testIdAttribute, mode, preSteps, redaction) → adopt tests (migrate or author) → the
**mandatory baseline green run** (healing needs history) → CI → optional LLM. Each phase
ends with a checkpoint; report checkpoint results as the integration progresses.

## Writing tests and intents

Write intents **directly into spec files** — the user reviews via git diff. Follow
`references/intent-authoring.md` for the quality rules (function + location, never
restate the selector, disambiguate repeats, no test data), per-element patterns, and the
procedures for filling `intent: 'TODO'` stubs and authoring new tests. Non-negotiables:

- One sentence a stranger could locate the element from — the intent is the healing
  anchor and the escalation text humans read.
- After writing or changing intents, run the affected tests green once (baseline
  fingerprints) and summarize what was written.
- Rewording an EXISTING intent orphans that step's healing history — flag it before
  doing it, never as a drive-by edit.

## Escalations — confirmation required

Answering an escalation permanently changes which element a test targets (the choice
becomes the cached primary locator and feeds future LLM heals). Therefore:

1. List with `npx sentinel escalations` or the query script.
2. Present each question to the user: the intent, the candidates (label, confidence,
   element summary), and the screenshot path.
3. Recommend a candidate with reasoning if the evidence is clear.
4. Apply only after the user picks: `npx sentinel escalations --choose <id> <label>`.
   Never choose a candidate or `REDESIGN` autonomously.

## Promotion — dry-run first, always

`sentinel promote` edits spec files. Sequence: `--dry-run` → show the user the diff →
apply only on approval (prefer `--branch sentinel/promote-heals` for a reviewable PR).
Only use `--include-unverified` when the user has explicitly reviewed those heals.
Promote refusals (`conflict`, `ambiguous`) are safety features — report them, do not work
around them.

## Guardrails

- **Never bypass the golden rule.** Do not raise thresholds, lower `driftFloor`, disable
  guards, or reword assertions to make a `PRODUCT_REGRESSION` pass. Report it.
- **Do not delete `.sentinel/`** — it is the healing baseline and audit history. If state
  must move or be rebuilt, `db export` first.
- **Do not edit spec files to apply heals manually** when `promote` can do it reviewably.
- **Do not answer escalations or run non-dry-run `promote` without explicit user
  approval** (see above).
- **Do not put secrets in config** — the LLM key stays in env (`SENTINEL_LLM_API_KEY` or
  the var named by `llm.apiKeyEnv`). `.env` is gitignored; keep it that way.
- When running the demo suite here, phase-pinned env vars matter: the chaos harness sets
  `SENTINEL_LLM_PROVIDER=none` for deterministic phases — do not "fix" that.

## Common troubleshooting

Run `npx sentinel doctor` first; fix the first ✘. Frequent cases: missing baseline
("cannot heal without history" → one green run), LLM disabled warning (API key env var
missing), circuit breaker opened (endpoint down → run continued deterministic-only),
empty/malformed LLM replies (thinking models → raise `llm.maxOutputTokens` to 2048),
heal caps exceeded (big redesign → investigate, don't just raise caps). The full
symptom→fix catalog is in `docs/USER-MANUAL.md` Part 5.

## Additional resources

### Reference files

- **`references/workflows.md`** — detailed step-by-step procedures: full triage decision
  tree, reviewing unverified heals, escalation handling protocol, promotion and migration
  runbooks, LLM enablement, chaos harness phases, CI operations, and the DB schema for
  `--json` queries.
- **`references/project-integration.md`** — phased zero-to-self-healing onboarding
  runbook for new projects, with per-phase checkpoints and a final acceptance checklist.
- **`references/intent-authoring.md`** — how to write tests and intent strings: quality
  rules, per-element patterns, context-sourcing order, TODO-stub and new-test procedures,
  anti-patterns.

### Scripts

- **`scripts/sentinel-query.mjs`** — read-only DB views (documented above).

### Repository documentation (authoritative, keep in sync)

- **`docs/USER-MANUAL.md`** — complete product documentation: capabilities and limits,
  configuration/CLI/env reference, troubleshooting catalog, FAQ.
- **`docs/ARCHITECTURE.md`** — pipeline diagram, data model, package layout.
- **`docs/DECISIONS.md`** — 37 recorded design decisions; read before proposing changes
  to core behavior.
