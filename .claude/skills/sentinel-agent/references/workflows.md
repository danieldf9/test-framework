# Sentinel Agent — Detailed Workflows

Step-by-step procedures for operating Sentinel. `SKILL.md` holds the quick reference;
this file holds the operating runbooks. Sibling references: `project-integration.md`
(new-project onboarding) and `intent-authoring.md` (writing tests and intents).
`docs/USER-MANUAL.md` is the end-user documentation — prefer linking users there over
restating it.

## Contents

- [Status digest](#status-digest)
- [Triage decision tree](#triage-decision-tree)
- [Reviewing unverified heals](#reviewing-unverified-heals)
- [Escalation handling protocol](#escalation-handling-protocol)
- [Promotion runbook](#promotion-runbook)
- [Migration runbook](#migration-runbook)
- [Enabling and verifying LLM healing](#enabling-and-verifying-llm-healing)
- [Chaos harness](#chaos-harness)
- [CI operations](#ci-operations)
- [DB schema for --json queries](#db-schema-for---json-queries)

## Status digest

To answer "what's the state of the tests / sentinel status", run from the suite
directory (this repo: `examples/tests/`):

```bash
npx sentinel doctor                                          # config, DB, LLM, playwright
node <skill-dir>/scripts/sentinel-query.mjs runs --limit 5   # recent runs
node <skill-dir>/scripts/sentinel-query.mjs escalations      # pending questions
node <skill-dir>/scripts/sentinel-query.mjs heals --mode UNVERIFIED --unpromoted --limit 10
node <skill-dir>/scripts/sentinel-query.mjs flaky
```

Report to the user: last run status, pending escalation count (these need human answers),
unverified heal count (these need review), flaky tests (these need attention), and any
doctor failures. A run status of `(running/aborted)` means the run row was never
finalized — normal for suites launched via bare `npx playwright test` (only
`sentinel run` finalizes the row) and for chaos-harness internal phases.

## Triage decision tree

Given a failing test, extract from the failure message: classification, step id, intent,
group, heal note, original error. Then:

1. **`PRODUCT_REGRESSION`**
   - Open the failure screenshot: path appears in the escalation (`escalations` view) or
     under `.sentinel/artifacts/<runId>/<test-dir>/*-failure.jpg`.
   - Check whether the asserted behavior is really absent (not just moved): the
     escalation's candidate list shows the closest surviving elements and their
     similarity scores. Candidates all < 0.5 similarity strongly indicate genuine
     removal.
   - Report findings as a potential product bug with evidence. Only if the user confirms
     the change was intentional, proceed to the escalation protocol with `REDESIGN`.

2. **`LOCATOR_DRIFT` + healed (`healed_auto` / `healed_unverified` step status)**
   - Nothing failed. For `healed_unverified`, follow
     [Reviewing unverified heals](#reviewing-unverified-heals).

3. **`LOCATOR_DRIFT` + `healing exhausted: <reason>`**
   - A pending escalation exists. Follow the
     [Escalation handling protocol](#escalation-handling-protocol).
   - If the reason mentions ambiguity and this recurs for the same element, the intent is
     probably too vague to disambiguate siblings — propose a more specific intent to the
     user (include location context: "on the first product card", "in the modal").

4. **`ENVIRONMENT`**
   - Verify the app under test is reachable (demo app: `pnpm demo:serve`, then
     `curl http://127.0.0.1:4173`). Check for 5xx in the error text.
   - Re-run the single test: `npx sentinel run --grep "<title>"`.
   - Recurring on one test → `flaky` view; report repeat offenders rather than rerunning
     forever.

5. **`TEST_DATA`**
   - The page bounced to an unexpected auth wall. Check credentials/env vars/seed
     fixtures the test depends on. Healing is intentionally not attempted.

6. **`UNKNOWN` (no fingerprint history)**
   - The step never succeeded. Fix the locator in the spec manually, run green once
     (creates the baseline), and only then rely on healing.
   - On fresh clones/machines: history may exist elsewhere — `sentinel db import` an
     export if the team has one.

7. **`max heals per test/run exceeded`**
   - Deliberate cap (defaults 3/20). Widespread drift usually means a big redesign or
     wrong build deployed. Diff what changed in the app first. Raising caps in
     `sentinel.config.ts` is a user decision — present the tradeoff.

## Reviewing unverified heals

`passed_unverified` means: a heal at confidence 0.60–0.90 was applied; the run is green
only if that heal picked the right element.

1. List them: `sentinel-query.mjs heals --mode UNVERIFIED --unpromoted`.
2. For each heal, examine:
   - `intent` vs `newLocator` — does the new locator plausibly express the intent?
   - `screenshotBefore` / `screenshotAfter` — read both images. The after-shot should
     show the expected post-action state (e.g. cart count incremented, form filled).
   - `reasoning` — the tier's own explanation.
3. Verdict per heal:
   - **Correct** → tell the user; the heal needs no action (it is already cached; it can
     be promoted later).
   - **Wrong** → the cached primary is now wrong. Fix by either answering the follow-up
     escalation (if one exists) with the right candidate, or correcting the locator in
     the spec and running green once (refreshes the cache). Flag it to the user — a wrong
     heal at this band is also a signal to tighten the intent.
4. To make review disappear next time for the same drift: promote reviewed heals
   ([Promotion runbook](#promotion-runbook)) so specs match reality again.

## Escalation handling protocol

Escalation answers permanently rewire a step (cached primary + few-shot context for
future LLM heals). The protocol:

1. Gather: `sentinel-query.mjs escalations` (or `npx sentinel escalations`).
2. For each pending question, present to the user:
   - the test and intent,
   - the question text,
   - each candidate: label, confidence, element summary (`<tag> "name"`), CSS path,
   - the screenshot path (open/read it when visual context helps).
3. Analyze and recommend: compare candidates against the intent semantics. State the
   recommendation and the evidence ("Candidate A is a `<button>` named 'Submit order' at
   conf 0.87; the intent says 'Place order submit button' — A matches").
4. Wait for the user's explicit choice. Then apply:
   `npx sentinel escalations --choose <id> <label>`.
5. Confirm the outcome line ("… is now the cached primary … Next run heals at Tier 0")
   back to the user.

`REDESIGN` records that the change was intentional and heals nothing — the spec then
needs a manual update, which is a normal code change (propose it as a diff for review).

In CI, the same answers can be given by maintainers commenting
`/sentinel choose <id> <label>` on the PR — do not post such comments autonomously.

## Promotion runbook

Purpose: write reviewed heals from the DB back into spec files so specs match reality.

```bash
npx sentinel promote --dry-run          # ALWAYS first — prints the planned diff
```

1. Show the dry-run output to the user. Statuses:
   - `ready` — will be applied.
   - `conflict` — same old locator heals to different targets in different places;
     refused. Resolve by deciding per occurrence manually.
   - `ambiguous` — different elements heal to the same target (e.g. two "Add to cart"
     buttons converging); refused to keep specs unambiguous. Fix intents/locators
     manually.
2. On approval, prefer a branch: `npx sentinel promote --branch sentinel/promote-heals`
   (creates branch + commit, ready for a PR). Plain `promote` writes to the working tree
   for `git diff` review.
3. `--include-unverified` only after the unverified-heal review above; say so explicitly
   when proposing it.
4. Heals are marked `promoted` and never promoted twice. `--root <dir>` overrides where
   spec files are searched (defaults to the config directory).

## Migration runbook

Purpose: adopt an existing vanilla Playwright suite.

1. `npx sentinel migrate <dir> --dry-run` — show the user the per-file plan (wrapped vs
   skipped counts).
2. `npx sentinel migrate <dir>` — applies. The codemod wraps `page.goto`, option-less
   `click`/`fill` (including `page.click(sel)` shorthands), `toBeVisible()`,
   `toHaveText(...)`; splits imports; adds `s` to fixtures; preserves formatting;
   idempotent. It intentionally skips aliased page fixtures, option-bearing calls, and
   `.not` assertions — list the skips for the user; those stay vanilla.
3. Replace `intent: 'TODO'` stubs following `intent-authoring.md` (quality rules,
   per-element patterns, and the TODO-stub procedure). Write them directly into the spec
   files and summarize per file for git-diff review.
4. Run the suite green once (populates the baseline cache), then `sentinel report` to
   confirm steps recorded.

## Enabling and verifying LLM healing

Tiers 0–1 need nothing. For Tiers 2–3:

1. Set env (or `llm:` in `sentinel.config.ts`):
   `SENTINEL_LLM_PROVIDER` (`anthropic` | `openai` | `gemini` | `openai-compatible`),
   `SENTINEL_LLM_MODEL`, `SENTINEL_LLM_BASE_URL` (compatible backends),
   `SENTINEL_LLM_API_KEY` (or the var named by `llm.apiKeyEnv`).
2. Verify: `npx sentinel doctor` — does a live ping, reports latency and
   `vision: true/false`.
3. Vision (Tier 3) needs `supportsVision` — for openai-compatible backends that don't
   self-report, set `SENTINEL_LLM_SUPPORTS_VISION=1`.
4. Cost accounting: set `llm.inputCostPerMTok`/`outputCostPerMTok`; spend appears in the
   `spend` query view and the report. `llm.maxSpendUsdPerRun` (default $2) is a hard
   stop.
5. Known model quirk: reasoning/"thinking" models return empty text when
   `llm.maxOutputTokens` is too small → raise to 2048.
6. Real env vars beat `.env` (fill-only-missing loader). When a setting "doesn't apply",
   check the shell env first.

## Chaos harness

`pnpm chaos` (repo root) is the acceptance test: 12 phases covering baseline, drift
healing (Tiers 0–1), mock-LLM Tier 2, regression golden-rule, ambiguous-classification
arbitration, dead-endpoint circuit breaker, escalation answer replay, vision, report
smoke, CI simulation (shard export/import/merge), migrate-run, and promote. Offline and
deterministic (phases pin `SENTINEL_LLM_PROVIDER=none` or use `examples/mock-llm`).

Use it to validate any change to core healing behavior. A phase failure prints which
acceptance criterion broke — fix the cause, never weaken the gate.

## CI operations

- Shards run with `SENTINEL_RUN_ID=gh-<run>-shard-<n>`; aggregate with
  `npx sentinel summary --run-prefix gh-<run>`.
- The locator cache travels as a JSON export via `actions/cache`
  (`sentinel db export` / `db import`; import is idempotent by run id).
- Pending escalations surface in the PR summary comment (or a `sentinel-needs-human`
  issue on push builds) with an `action_required` check run. Maintainers answer via
  `/sentinel choose <id> <label>` comments; the companion workflow
  (`.github/workflows/sentinel-escalation-answer.yml`) applies them.
- The only CI secret is the LLM API key; without it runs degrade to Tiers 0–1.
- Contract changes to the workflows must keep `scripts/validate-workflows.mjs`
  (`pnpm validate:workflows`) green.

## DB schema for --json queries

`sentinel-query.mjs --json` returns normalized objects; for raw work, `sentinel db
export` produces `{ schemaVersion, exportedAt, tables }` with these tables (columns
abridged to the useful ones):

| Table           | Key columns                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs`          | `id`, `started_at`/`finished_at` (ms epoch), `git_sha`, `heal_mode`, `status`, `meta_json` (`healingUnavailable` flag lands here)                                                                                   |
| `test_results`  | `run_id`, `test_id`, `title`, `file`, `status` (`passed`/`passed_unverified`/`failed`), `duration_ms`, `flaky_tagged`                                                                                               |
| `steps`         | `run_id`, `test_id`, `step_id`, `action`, `intent`, `group_path`, `status` (`passed`/`healed_auto`/`healed_unverified`/`failed`/`escalated`), `tier`, `confidence`, `classification`, `url`, `ts`                   |
| `locator_cache` | `test_id`+`step_id` (PK), `primary_json`, `alternates_json`, `fingerprint_json`, `intent`, `last_verified_at`                                                                                                       |
| `heals`         | `run_id`, `test_id`, `step_id`, `intent`, `old_locator`, `new_locator`, `tier`, `confidence`, `mode` (`AUTO`/`UNVERIFIED`/`SUGGESTED`/`HUMAN`), `reasoning`, `screenshot_before/after`, `git_sha`, `promoted`, `ts` |
| `escalations`   | `run_id`, `test_id`, `step_id`, `question_json` (intent, question, candidates[], context), `status` (`pending`/`answered`), `answer`, `answered_by`, `channel`, `created_at`, `answered_at`                         |
| `flake_stats`   | `test_id`, `git_sha`, `run_id`, `status` — flaky = both `passed` and `failed` rows for one (`test_id`,`git_sha`)                                                                                                    |
| `llm_calls`     | `run_id`, `provider`, `model`, `purpose`, `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `ok`, `error`                                                                                                  |

Treat the DB as **read-only** from this skill: all writes go through the fixture at
runtime or the `sentinel` CLI (`escalations --choose`, `promote`, `db import`).
