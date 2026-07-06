# Integrating Sentinel into a New Project (Zero → Self-Healing)

End-to-end runbook for onboarding a project that has never used Sentinel. Follow the
phases in order; each ends with a verifiable checkpoint. For an existing Playwright
suite, this runbook plus the migration runbook in `workflows.md` is the complete path.

## Phase 0 — Prerequisites

- Node.js 20+ (`node --version`), a package manager (npm/pnpm/yarn), git.
- Playwright in the target project (`@playwright/test` + browsers via
  `npx playwright install chromium`).

## Phase 1 — Install the packages

**Primary path (npm registry):**

```bash
pnpm add -D @sentinel/core @sentinel/cli        # or npm i -D / yarn add -D
```

**Fallback path (packages not yet published — local link from a clone):**

```bash
git clone <sentinel-repo-url> ../test-framework
cd ../test-framework && pnpm install && pnpm build && cd -
```

Then in the target project's `package.json`:

```json
"devDependencies": {
  "@sentinel/core": "file:../test-framework/packages/core",
  "@sentinel/cli": "file:../test-framework/packages/cli"
}
```

and reinstall. Notes for the local path: `@sentinel/core` depends on `better-sqlite3`
(native module) — the target project's Node major version must match the one used to
build; rerun `pnpm build` in the clone after pulling updates.

**Checkpoint:** `npx sentinel --version` prints a version and
`import { test } from '@sentinel/core'` resolves in a spec file.

## Phase 2 — Scaffold

```bash
npx sentinel init
```

Creates `sentinel.config.ts`, `.sentinel/` (verify it lands in `.gitignore` — the CLI
reminds but does not edit), and `.github/workflows/sentinel.yml` matched to the detected
package manager. Never overwrites existing files.

**Checkpoint:** `npx sentinel doctor` — config ✔, database ✔, playwright ✔ (LLM line
reads `provider: none` at this stage, which is correct).

## Phase 3 — Configuration decisions

Walk the user through these (defaults are sensible; only deviate with a reason):

| Decision                   | Guidance                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testIdAttribute`          | Must match the app's convention AND Playwright's `testIdAttribute` (check `playwright.config.ts`). Default `data-testid`.                                                                                        |
| `healing.mode`             | `auto` (default) for normal operation. Offer `suggest` for a trust-building first week: heals are computed and recorded but not applied — the team reviews suggestions in the report before switching to `auto`. |
| `preSteps`                 | Any consent/cookie banner the suite must click through — Sentinel never auto-accepts silently. `{ name, selector, optional, timeoutMs }`.                                                                        |
| `redaction.selectors`      | CSS selectors of PII regions that must never reach snapshots/screenshots (the password/card/token patterns are masked by default).                                                                               |
| `diagnosis.flakeDetection` | Disable ONLY if the app under test deploys independently of the test repo's git SHA — otherwise app changes read as flakiness.                                                                                   |
| `actionTimeoutMs`          | Default 5000. Raise only for genuinely slow apps; longer timeouts delay drift detection.                                                                                                                         |

## Phase 4 — Adopt tests

Two routes, both ending at the same place:

- **Existing suite:** run the migration runbook (`workflows.md` → Migration runbook):
  `sentinel migrate <dir> --dry-run` → apply → fill every `intent: 'TODO'` per
  `intent-authoring.md`. Report what the codemod skipped (those steps stay vanilla and
  unprotected).
- **New tests:** author per `intent-authoring.md` → "Procedure: authoring a brand-new
  Sentinel test".

**Checkpoint:** `grep -rn "intent: 'TODO'"` returns nothing (or the remaining stubs are
explicitly listed for the user).

## Phase 5 — Baseline run (mandatory)

Healing requires history: a step that has never succeeded cannot be healed.

```bash
npx sentinel run
```

Get the suite green (fix any locators that fail — this is normal pre-Sentinel debt
surfacing). Then confirm the baseline exists:

```bash
node <skill-dir>/scripts/sentinel-query.mjs steps --all --limit 10   # steps recorded
npx sentinel report                                                  # report generates
```

**Checkpoint:** run summary shows `passed`; steps appear in the query view; the report
opens. From this moment the suite is protected.

## Phase 6 — CI

1. Commit the scaffolded `.github/workflows/sentinel.yml` (locator-cache persistence via
   `actions/cache`, report artifact, PR summary comment are pre-wired).
2. Optional: add the LLM API key as the workflow secret — the only secret it takes.
   Without it, CI heals at Tiers 0–1.
3. Explain the escalation loop to the team: pending questions surface in the PR comment;
   maintainers answer with `/sentinel choose <id> <label>`; the answer persists into the
   shared cache.

**Checkpoint:** first CI run completes; summary comment appears on a test PR.

## Phase 7 — Optional: enable LLM healing (Tiers 2–3)

Follow `workflows.md` → "Enabling and verifying LLM healing". Verify with
`npx sentinel doctor` (live ping + vision flag). Skippable indefinitely — deterministic
healing carries most drift.

## Phase 8 — Team conventions (propose these)

- `passed_unverified` runs are reviewed same-day (heal screenshots in the report or
  `heals --mode UNVERIFIED` view).
- Escalations have an owner; answers within a day keep the cache warm.
- Weekly: `sentinel promote --dry-run` → promotion PR when non-trivial; skim the flake
  dashboard.
- New tests must pass the intent litmus test in code review (see
  `intent-authoring.md` anti-patterns).

## Final acceptance checklist

- [ ] `sentinel doctor` fully green
- [ ] Baseline run green; cache populated (steps visible in query view)
- [ ] No `intent: 'TODO'` remaining (or explicitly accepted)
- [ ] `.sentinel/` gitignored; config committed
- [ ] CI workflow runs and comments on PRs
- [ ] Team knows the three outcomes (`passed` / `passed_unverified` / `failed`) and who
      answers escalations
- [ ] (Optional) LLM ping green + spend caps understood
