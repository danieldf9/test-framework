# Sentinel — User Manual & Product Documentation

**Audience:** QA engineers new to Sentinel, including juniors/freshers who know basic
Playwright. This is the complete product documentation: what Sentinel is, what it can and
cannot do, how it works, how to use it day to day, and how to fix things when they go
wrong.

**How to read this manual:**

- New to Sentinel? Read **Part 1** and **Part 2** top to bottom (about 30 minutes), then
  keep **Part 3** open during your first week.
- Already onboarded? Jump straight to **Part 4 (Reference)** and **Part 5
  (Troubleshooting)**.

---

## Table of contents

**Part 1 — Understanding Sentinel**

1. [What is Sentinel?](#1-what-is-sentinel)
2. [The core idea: locator + intent](#2-the-core-idea-locator--intent)
3. [What Sentinel CAN do](#3-what-sentinel-can-do)
4. [What Sentinel CANNOT do](#4-what-sentinel-cannot-do--read-this)
5. [How it works under the hood](#5-how-it-works-under-the-hood)
6. [Glossary](#6-glossary)

**Part 2 — Getting started, step by step**

7. [Prerequisites](#7-prerequisites)
8. [First contact: the demo walkthrough](#8-first-contact-the-demo-walkthrough)
9. [Watch it heal: the chaos test](#9-watch-it-heal-the-chaos-test)
10. [Setting up Sentinel in your own project](#10-setting-up-sentinel-in-your-own-project)
11. [Writing your first Sentinel test](#11-writing-your-first-sentinel-test)
12. [Writing good intents (the most important skill)](#12-writing-good-intents-the-most-important-skill)
13. [Migrating an existing Playwright suite](#13-migrating-an-existing-playwright-suite)

**Part 3 — Daily workflow**

14. [Running tests and reading results](#14-running-tests-and-reading-results)
15. [The three test outcomes and what to do about each](#15-the-three-test-outcomes-and-what-to-do-about-each)
16. [Answering escalations](#16-answering-escalations)
17. [The HTML report](#17-the-html-report)
18. [Promoting heals back into your spec files](#18-promoting-heals-back-into-your-spec-files)
19. [A junior QA's weekly checklist](#19-a-junior-qas-weekly-checklist)

**Part 4 — Reference**

20. [`s.*` API reference](#20-s-api-reference)
21. [Configuration reference (sentinel.config.ts)](#21-configuration-reference-sentinelconfigts)
22. [Environment variables](#22-environment-variables)
23. [CLI reference](#23-cli-reference)
24. [Enabling LLM healing (Tiers 2–3)](#24-enabling-llm-healing-tiers-23)
25. [CI integration (GitHub Actions)](#25-ci-integration-github-actions)
26. [Where your data lives](#26-where-your-data-lives)

**Part 5 — Troubleshooting**

27. [First-aid checklist](#27-first-aid-checklist)
28. [Common errors and what they mean](#28-common-errors-and-what-they-mean)
29. [FAQ](#29-faq)

---

# Part 1 — Understanding Sentinel

## 1. What is Sentinel?

Sentinel is a **self-healing test framework built on top of Playwright**. You write
Playwright tests almost exactly as you do today, but every interaction carries a short
English description of _what the element is for_. When the UI changes and a selector
breaks, Sentinel:

1. **Diagnoses why** the step failed before doing anything else — was it selector drift, a
   real product bug, a flaky environment, or bad test data?
2. **Heals** pure selector drift by re-finding the element that matches your description,
   using a tiered pipeline (cached fallbacks → fuzzy matching → optional AI assistance).
3. **Refuses to guess** when it isn't confident. Instead it asks you a structured question
   ("which of these candidates is the right element?") that you answer in seconds.
4. **Never hides a real bug.** If the element is genuinely gone (e.g. a success message
   that no longer appears), the test **fails loudly** and is never healed. This is the
   golden rule of the whole product.

Think of it this way: **your selector is a cache; your intent is the truth.** Selectors go
stale when developers refactor. Sentinel uses your intent description (plus a remembered
"fingerprint" of the element) to refresh the stale cache automatically — and to know when
the element really disappeared versus just moved.

### What problem does this solve?

In most teams, a big chunk of QA time goes to _test maintenance_: a developer renames
`btn-primary` to `button-cta`, twenty tests go red, and someone spends an afternoon
updating selectors for elements that never actually changed from the user's point of view.
Sentinel automates exactly that afternoon — and _only_ that afternoon. Real regressions
still fail, as they must.

## 2. The core idea: locator + intent

A vanilla Playwright step:

```ts
await page.getByRole('button', { name: 'Add to cart' }).click();
```

The same step in Sentinel:

```ts
await s.click({
  locator: page.getByRole('button', { name: 'Add to cart' }),
  intent: 'Primary add-to-cart button on the first listed product',
});
```

Two parts, two jobs:

| Part      | What it is                                 | What it's for                                                                  |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `locator` | A normal, deterministic Playwright locator | The **fast path**. Used first on every run. Keeps your tests fast and precise. |
| `intent`  | A one-sentence semantic description        | The **healing anchor**. Only consulted when the locator breaks.                |

On every **successful** step, Sentinel silently captures a _fingerprint_ of the element
(its tag, role, accessible name, text, ids, classes, nearby text, position) and stores it
in a local SQLite database. That fingerprint is what makes healing possible later — it's
the "photo on file" that lets Sentinel recognize the same element after a refactor.

## 3. What Sentinel CAN do

- **Heal broken selectors automatically** when the element still exists but its
  id/class/testid/label/text/position changed. Proven by the built-in chaos harness:
  ≥ 90 % of injected drift failures heal at Tiers 0–2.
- **Distinguish drift from regressions.** A missing "Order confirmed" message is failed
  and escalated, never healed. This is enforced by multiple independent guards.
- **Retry environment noise** (navigation failures, HTTP 5xx, crashed pages) with backoff,
  and **statistically detect flaky tests** (pass + fail on the same git commit) — flaky
  tests are tagged, never healed.
- **Ask a human when unsure**, with labeled candidates and a screenshot, answerable from
  the CLI (`sentinel escalations --answer`) or from a PR comment in CI
  (`/sentinel choose 3 A`). Your answer is remembered: the next run heals instantly.
- **Audit everything.** Every step, heal, escalation, LLM call (tokens + cost + latency),
  and flake statistic lands in one portable SQLite file, with before/after screenshots.
- **Generate a self-contained HTML report** — results, heals with before/after
  screenshots, a flake dashboard, and LLM cost breakdown.
- **Adopt an existing suite mechanically** (`sentinel migrate`) and **write reviewed heals
  back into your spec files as a normal git diff** (`sentinel promote`).
- **Run fully offline.** Tiers 0–1 (cached descriptors + fuzzy matching) need no network
  and no API key. LLM tiers are strictly optional.
- **Work with any LLM backend** if you do enable AI healing: Anthropic, OpenAI, Gemini
  native adapters, plus any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio,
  vLLM…), switchable purely via environment variables.
- **Persist its memory across CI runs** (locator cache export/import + `actions/cache`),
  with sharded runs aggregated into a single PR comment.

## 4. What Sentinel CANNOT do — read this!

Being honest about limits is what keeps trust in green builds. Sentinel deliberately does
**not**:

- **Heal anything you didn't route through `s.*`.** Raw `page.click(...)`,
  `page.locator(...).click()`, or `expect(page.locator(...))` calls are invisible to
  Sentinel — they behave exactly like vanilla Playwright and fail like vanilla Playwright.
  Only `s.click`, `s.fill`, `s.expectVisible`, and `s.expectText` are healable.
- **Heal a step it has never seen succeed.** Healing needs the stored fingerprint from a
  previous successful run. A brand-new test that fails on its very first run fails with
  "cannot heal without history" — fix the locator by hand once, and from then on it's
  protected. **The first green run is the baseline; there is no healing without a
  baseline.**
- **Heal product regressions — ever, by design.** If nothing on the page resembles the
  remembered element, or a healed assertion target lost the text your assertion depends
  on, Sentinel fails the test and escalates. It will not "find something similar" to keep
  the build green. If you _want_ a red build to become green, the answer is to update the
  test, not to expect Sentinel to paper over the change.
- **Heal navigation, waits, or complex gestures.** `s.goto` gets environment retries but
  no healing (there is nothing to heal about a URL). Drag-and-drop, hover chains, keyboard
  shortcuts, file uploads, iframes, new tabs/popups, and multi-step widget interactions
  are not wrapped — use plain Playwright for those parts and expect no self-healing there.
- **Invent or repair test data.** Expired accounts, missing seed rows, and unexpected
  login walls are classified as `TEST_DATA` and fail with an actionable message. Fixing
  data/auth is your job.
- **Fix flaky infrastructure.** Sentinel retries environment errors and _tags_ flaky
  tests so you can see them in the report — it never "heals" flakiness, because flakiness
  isn't locator drift.
- **Edit your spec files behind your back.** No command modifies test code except
  `sentinel promote`, which you run explicitly and review as a git diff. Healing at
  runtime only touches Sentinel's own database.
- **Write tests for you.** Sentinel is not a test generator. You still design test cases,
  write assertions, and (most importantly) write good intent descriptions.
- **Guarantee healing without history _and_ without an LLM.** With no LLM configured,
  healing is deterministic-only (Tiers 0–1). That covers most drift, but unusually deep
  redesigns may need Tier 2 (LLM) or a quick human answer to an escalation.
- **Accept cookie/consent banners silently.** Consent is only clicked when you explicitly
  declare it in config (`preSteps`), and every pre-step is logged.

## 5. How it works under the hood

You don't need this section to _use_ Sentinel, but you do need it to _trust_ it — and to
explain a heal in a bug triage meeting.

### 5.1 The happy path (nothing broken)

```
s.click({ locator, intent })
  → capture screenshot + sanitized DOM into a small ring buffer (cheap, in memory)
  → try YOUR locator with a 5s timeout (actionTimeoutMs)
  → success → capture the element's fingerprint → refresh the locator cache → PASSED
```

Overhead on passing steps is one in-page fingerprint capture — no LLM calls, no healing,
no network.

### 5.2 When a step fails: diagnose FIRST

Sentinel never heals blindly. A failed step is first **classified** with cheap
deterministic heuristics (an LLM is consulted only when signals genuinely contradict each
other, and any LLM problem falls back to the deterministic verdict):

| Classification       | Meaning                                                        | Sentinel's response                                       |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| `LOCATOR_DRIFT`      | The element still exists; the selector broke                   | Enter the healing pipeline                                |
| `PRODUCT_REGRESSION` | Nothing similar exists in the DOM — behavior is genuinely gone | **Never healed.** Fail loudly + record an escalation      |
| `ENVIRONMENT`        | `net::ERR…`, HTTP 5xx, crashes, or a known-flaky test          | Retry with backoff (never healed); flaky tests get tagged |
| `TEST_DATA`          | Unexpected auth wall / seed-data problem                       | Fail with an actionable message (never healed)            |
| `UNKNOWN`            | No fingerprint history to compare against                      | Fail — cannot heal without an anchor                      |

### 5.3 The healing tiers (drift only)

Only `LOCATOR_DRIFT` enters the pipeline, and only after hard caps are checked
(`maxHealsPerTest`, default 3; `maxHealsPerRun`, default 20 — exceeding them fails
loudly, never silently). Tiers run in order and stop at the first success:

| Tier | Name                 | How it works                                                                                                                                                                       | Needs LLM?   |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 0    | Cached descriptors   | Try the stored fallback ladder for this step: testid → role+name → label → placeholder → text → structural CSS. Each hit is verified against the stored fingerprint.               | No           |
| 1    | Fuzzy fingerprinting | Compare the stored fingerprint against every candidate element in the live DOM (weighted similarity over role, name, text, attributes, nearby text, tag). Accept at ≥ 0.85.        | No           |
| 2    | LLM DOM resolution   | Send the intent + fingerprint + a pruned, size-budgeted candidate list to the configured LLM. The model may ONLY answer with a candidate index (Zod-validated).                    | Yes          |
| 3    | LLM vision           | Send the sanitized failure screenshot + the same candidates to a vision-capable model. Its answer is cross-checked against Tier 2: agreement +0.15 confidence, disagreement −0.25. | Yes (vision) |

### 5.4 Guards, then confidence

Every candidate — deterministic or LLM-picked — passes through the same guards:

- **Ambiguity guard:** if the runner-up candidate scores within 0.03 of the winner, the
  situation is ambiguous and confidence is capped below the apply floor → escalate. (This
  is what stops Sentinel from clicking the _wrong_ "Add to cart" button among ten
  identical ones.)
- **Assertion guard (golden rule):** if the step is an assertion (`expectVisible` /
  `expectText`) and the healed target no longer carries ≥ 0.8 of the original text
  content, the failure is reclassified as `PRODUCT_REGRESSION`.

Then the confidence policy decides:

| Confidence  | Action                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| ≥ 0.90      | **Auto-apply.** Action re-runs on the healed locator; audit row mode `AUTO`; test can be fully green.             |
| 0.60 – 0.90 | **Apply, but flag.** Test result becomes `passed_unverified` — the run is _not_ fully trusted until reviewed.     |
| < 0.60      | **Escalate.** Step fails; a structured question with up to 3 labeled candidates (A/B/C) + screenshot is recorded. |

### 5.5 Memory and learning

- Applied heals update the locator cache: the healed descriptor becomes the new primary,
  the old ones become alternates. The same drift next run heals at **Tier 0** (instant).
- Your escalation answers do the same, plus they're fed to future LLM heals of that step
  as few-shot examples. Sentinel gets faster and more accurate the longer you use it.

### 5.6 Safety rails around the LLM (if enabled)

- The model can only pick an element index — never navigate, invent actions, or change
  assertions. Malformed JSON gets up to 2 repair prompts, then counts as low confidence.
- All page content is wrapped in UNTRUSTED-data markers with an injection-defense system
  prompt — a malicious page cannot instruct the model.
- A per-run spend cap (`maxSpendUsdPerRun`, default $2) fails loudly when exceeded.
- Timeouts + deterministic backoff + a circuit breaker: after 3 consecutive provider
  failures the circuit opens for the rest of the run, the run is flagged
  `healingUnavailable`, and healing continues deterministic-only. A dead endpoint can
  slow one step, never hang a run.
- Screenshots are sanitized _before_ capture (input values blurred), and DOM snapshots are
  sanitized _in the page_ (input values stripped, password/card/token-pattern fields
  masked, your configured `redaction.selectors` blanked, scripts dropped). Typed values —
  including `s.fill` values — never reach disk or any model.

## 6. Glossary

| Term                | Meaning                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Intent**          | Your one-sentence description of what an element is for. The healing anchor. Written by you, read by machines _and_ humans.                 |
| **Fingerprint**     | The stored semantic snapshot of an element (tag, role, name, text, ids, classes, nearby text, CSS path), captured on every successful step. |
| **Locator cache**   | Per-step storage of the primary descriptor + ranked alternate descriptors + fingerprint. Lives in SQLite.                                   |
| **Descriptor**      | One concrete way to find an element (a testid, a role+name pair, a label, a CSS path…). The cache holds a ladder of them.                   |
| **Heal**            | A successful re-resolution of a broken locator, applied at runtime and fully audited.                                                       |
| **Tier**            | Which mechanism found the heal: 0 cache, 1 fuzzy match, 2 LLM DOM, 3 LLM vision.                                                            |
| **AUTO heal**       | Confidence ≥ 0.90; applied and trusted.                                                                                                     |
| **UNVERIFIED heal** | Confidence 0.60–0.90; applied but the test is marked `passed_unverified` until a human reviews it.                                          |
| **Escalation**      | A structured question Sentinel asks when it refuses to guess. Answered via CLI or CI comment.                                               |
| **REDESIGN**        | Your escalation answer meaning "this change was intentional; the _test_ needs updating" — recorded, never healed.                           |
| **Promotion**       | Writing reviewed heals back into spec files as a git diff (`sentinel promote`).                                                             |
| **Golden rule**     | A genuine product regression must never be turned into a green build.                                                                       |
| **Chaos harness**   | The built-in acceptance test (`pnpm chaos`) that mutates the demo app and proves healing + the golden rule end to end.                      |
| **Circuit breaker** | The mechanism that stops calling a failing LLM endpoint after 3 consecutive errors for the rest of the run.                                 |

---

# Part 2 — Getting started, step by step

## 7. Prerequisites

- **Node.js 20+** (`node --version`)
- **pnpm 9** (`npm i -g pnpm` if you don't have it)
- **Git** (used for commit-SHA tagging and flake detection; optional but recommended)
- Basic Playwright knowledge: what a `Locator` is, `getByRole`, `getByLabel`, `getByText`.
  If those are new, do the [Playwright getting-started](https://playwright.dev/docs/intro)
  first — Sentinel builds on it, it doesn't replace it.

## 8. First contact: the demo walkthrough

The repository ships a complete offline demo: a small shop app, an intent-annotated test
suite, and a chaos switch that breaks the app on demand. Fifteen minutes here teaches you
more than an hour of reading.

**Step 1 — Install and build:**

```bash
git clone <repo-url> && cd test-framework
pnpm install
pnpm build
npx playwright install chromium
```

**Step 2 — Start the demo shop** (leave this terminal running):

```bash
pnpm demo:serve
# → demo shop on http://127.0.0.1:4173
```

**Step 3 — Run the example suite** (second terminal):

```bash
cd examples/tests
npx playwright test
```

Everything passes. Open [examples/tests/specs/shop.spec.ts](../examples/tests/specs/shop.spec.ts)
and look at the shape of the steps — locator + intent, every time. This first green run
also did something important invisibly: it **populated the locator cache** with a
fingerprint for every step. That cache is the baseline healing works from.

**Step 4 — Look at what was recorded:**

```bash
npx sentinel report
# → .sentinel/report/index.html — open it in a browser
```

## 9. Watch it heal: the chaos test

From the repo root:

```bash
pnpm chaos
```

This is Sentinel's own acceptance test and the best demonstration of the product. It:

1. Runs the suite against the untouched demo app (baseline; populates the cache).
2. Switches the server to a **chaos profile**: ids and classes renamed, testids removed,
   labels reworded, buttons moved in the DOM.
3. Re-runs the suite and asserts **≥ 90 % of the drift failures heal** (Tiers 0–2).
4. Injects a **genuine regression** (the "Order confirmed" message is removed) and asserts
   the test **fails and escalates — it is never healed.**

Watch the output: you'll see heals with tier and confidence, and then the regression
failing loudly. That contrast — _heals drift, refuses regressions_ — is the entire product
in one command.

## 10. Setting up Sentinel in your own project

**Step 1 — Install the packages** (in your test project):

```bash
pnpm add -D @sentinel/core @sentinel/cli @playwright/test
```

**Step 2 — Scaffold:**

```bash
npx sentinel init
```

This creates:

- `sentinel.config.ts` — minimal config (defaults are sensible; see
  [section 21](#21-configuration-reference-sentinelconfigts))
- `.sentinel/` — the state directory. **Add `.sentinel/` to `.gitignore`** (the CLI
  reminds you). CI state moves via `sentinel db export/import`, not via git.
- `.github/workflows/sentinel.yml` — a ready CI workflow (auto-detects npm/pnpm/yarn)

**Step 3 — Verify your setup:**

```bash
npx sentinel doctor
```

`doctor` checks the config parses, the database is healthy, Playwright is installed, and
(if configured) the LLM endpoint responds. Green ticks = ready.

**Step 4 — Decide on the healing mode** for your team (in `sentinel.config.ts`):

| Mode      | Behavior                                                                                                | When to use                                       |
| --------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `auto`    | Heals are applied at runtime (subject to confidence bands)                                              | Default; CI and day-to-day                        |
| `suggest` | Heals are computed and recorded but **not applied** — the step still fails, with the suggestion printed | Building trust in week 1; strict release branches |
| `off`     | No healing; pure Playwright behavior + Sentinel's diagnosis in failure messages                         | Debugging; measuring baseline flakiness           |

You can override per run: `npx sentinel run --heal suggest` or `SENTINEL_HEAL=off`.

## 11. Writing your first Sentinel test

```ts
// specs/login.spec.ts
import { test, expect } from '@sentinel/core';

test('user can log in', async ({ page, s }) => {
  // s.goto = page.goto + environment retries + logged pre-steps (consent banners)
  await s.goto('https://staging.example.com/login');

  await s.fill({
    locator: page.getByLabel('Email'),
    intent: 'Email input on the login form',
    value: 'qa-user@example.com',
  });

  await s.fill({
    locator: page.getByLabel('Password'),
    intent: 'Password input on the login form',
    value: process.env.QA_PASSWORD!, // values are never logged or stored
  });

  await s.click({
    locator: page.getByRole('button', { name: 'Sign in' }),
    intent: 'Submit button on the login form',
  });

  await s.expectVisible({
    locator: page.getByRole('heading', { name: 'Dashboard' }),
    intent: 'Dashboard page heading shown after successful login',
  });
});
```

Key points:

- Import `test` from `@sentinel/core`, **not** from `@playwright/test`. You get the normal
  `page` fixture plus the `s` fixture. (`expect` is re-exported for convenience.)
- Write the `locator` exactly as you would in Playwright — prefer user-facing locators
  (`getByRole`, `getByLabel`, `getByTestId`) over CSS.
- Group related steps with `s.step('add first product to the cart', async () => { … })` —
  groups show up in failure messages and reports, and give diagnosis extra context.
- **Run the test once while it's green.** That first successful run creates the baseline
  fingerprints. A test that has never passed cannot be healed.

## 12. Writing good intents (the most important skill)

The intent is what Sentinel — and, at Tier 2, an LLM — uses to pick the right element
among look-alikes. Quality here directly determines healing quality. Rules of thumb:

**Say what the element is FOR and WHERE it is, not what it looks like.**

| ❌ Bad              | ✅ Good                                                               | Why                                                                       |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `'button'`          | `'Primary add-to-cart button on the first listed product'`            | Distinguishes it from nine other add-to-cart buttons                      |
| `'the blue button'` | `'Submit button on the checkout payment form'`                        | Color changes in redesigns; purpose doesn't                               |
| `'email'`           | `'Email input field in the checkout contact section'`                 | There may be an email field in the footer newsletter too                  |
| `'#msg span'`       | `'Order confirmation success message shown after purchase completes'` | Never restate the selector — the intent must survive the selector's death |
| `'click this'`      | `'Link to the returns policy in the page footer'`                     | An LLM (or teammate) reading only the intent should find the element      |

**The litmus test:** hand your intent to a colleague who has the page open but has never
seen your test. If they can point at the element unambiguously, it's a good intent.

Also:

- One intent = one element. Don't describe two things.
- Include disambiguating context ("first listed product", "in the modal", "in the page
  footer") whenever the page has repeats.
- Don't include test data ("fill with john@…") — data goes in `value`, not in the intent.
- Intents are stable identifiers: rewording an intent creates a _new_ step identity, and
  the old cache/history stops matching. Word them carefully once; don't churn them.

## 13. Migrating an existing Playwright suite

You don't hand-convert anything. The codemod does the mechanical part:

```bash
npx sentinel migrate e2e/ --dry-run    # see what would change, change nothing
npx sentinel migrate e2e/              # apply
```

What it does:

- Wraps `page.goto`, option-less `click`/`fill` (including `page.click(sel)` /
  `page.fill(sel, v)` shorthands), `toBeVisible()`, and `toHaveText(...)` in the
  equivalent `s.*` calls, with `intent: 'TODO'` stubs.
- Splits imports and adds `s` to your test fixtures automatically. Formatting is
  preserved (position-based splices, not a reprint). Running it twice is safe
  (idempotent).
- **Deliberately skips** what it can't express safely — aliased page fixtures
  (`{ page: p }`), option-bearing calls (`click({ force: true })`), `.not` assertions —
  and reports the count. Those stay vanilla Playwright and simply don't get healing.

Then the human part, which is the real work:

1. Search for `intent: 'TODO'`.
2. Replace every stub with a real description per [section 12](#12-writing-good-intents-the-most-important-skill).
   The suite runs fine with TODOs, but a TODO intent gives healing nothing to anchor on —
   don't leave them long-term.
3. Run the suite green once to populate the cache.

---

# Part 3 — Daily workflow

## 14. Running tests and reading results

Two equivalent ways to run:

```bash
npx playwright test                 # plain Playwright runner; Sentinel hooks in via the fixture
npx sentinel run                    # same, plus a unified run id and a summary box
npx sentinel run --grep checkout    # filter, like playwright --grep
npx sentinel run --heal suggest     # per-run mode override
```

`sentinel run` ends with:

```
── Sentinel run summary ─────────────────────────────
run:         run-2026-07-06T10-15-30-123Z-local
status:      passed_unverified
tests:       11/12 passed
heals:       3 (2 auto, 1 unverified)
escalations: 1
⚠ passed with 1 unverified heal(s) — review required before trusting green
─────────────────────────────────────────────────────
```

During the run, watch for these Playwright annotations on tests:

- `sentinel-heal-auto` — healed at high confidence, informational.
- `sentinel-heal-unverified` — healed at medium confidence, **needs your review**.
- `sentinel-escalation` — Sentinel has a question for you.
- `sentinel-environment-retry` — passed after environment retries (watch for repeats).

## 15. The three test outcomes and what to do about each

| Outcome             | Meaning                                                          | Your action                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `passed`            | Green, possibly with AUTO heals (≥ 0.90 confidence)              | Nothing required. Optionally skim AUTO heals in the report; consider `sentinel promote` when they pile up.                                                               |
| `passed_unverified` | Green **only if** the applied medium-confidence heal was correct | **Review before trusting.** Open the report, compare before/after screenshots for the heal. Right → fine (promote later). Wrong → answer the follow-up, fix the locator. |
| `failed`            | Failed with a diagnosis, or escalated                            | Read the classification in the error (see below), then act accordingly.                                                                                                  |

Every Sentinel failure message tells you the diagnosis up front:

```
[sentinel] PRODUCT_REGRESSION: nothing in the live DOM resembles the stored element (best similarity 0.31)
  step: expectVisible (s_3e811f579bdf)
  intent: Order confirmation success message shown after purchase completes
  group: complete checkout
  original error: Timed out 5000ms waiting for ...
```

- `PRODUCT_REGRESSION` → treat as a real bug first. Verify manually; file it. If it turns
  out to be an intentional redesign, answer the escalation with `REDESIGN` and update the
  test.
- `ENVIRONMENT` → infra/network noise; re-run. Recurring on the same test? Raise it —
  the flake dashboard in the report has the history.
- `TEST_DATA` → fix credentials/seed data; nothing to heal.
- `UNKNOWN` (no history) → fix the locator by hand; the next green run creates the
  baseline.
- `LOCATOR_DRIFT` with `healing exhausted` → answer the escalation (next section).

## 16. Answering escalations

When Sentinel refuses to guess, answering takes under a minute:

```bash
npx sentinel escalations            # list pending questions
npx sentinel escalations --answer   # interactive: arrow keys, per question
npx sentinel escalations --choose 3 A          # scriptable: escalation #3, candidate A
npx sentinel escalations --choose 3 REDESIGN   # "intentional change — test needs updating"
npx sentinel escalations --all      # also show recently answered ones
```

Each question shows the intent, up to three candidates labeled **A/B/C** with similarity
scores and element summaries, and the path to a failure screenshot. Your options:

- **Pick a candidate (A/B/C):** it becomes the cached primary locator for that step, a
  `HUMAN` audit row is written, and future LLM heals of this step get your answer as
  few-shot context. **The next run heals at Tier 0 automatically** — you don't need to
  edit the spec (promote it later at your leisure).
- **`REDESIGN`:** records that the change was intentional. Sentinel never edits your spec
  — updating the test is now on you.
- **`SKIP`** (interactive only): leaves the question pending.

In CI, the same questions appear in the PR summary comment; a maintainer answers by
commenting `/sentinel choose <id> <label>` and the answer flows into the shared cache.

## 17. The HTML report

```bash
npx sentinel report                  # → .sentinel/report/index.html
npx sentinel report --runs 50        # include more history (default 20 runs)
```

The report is a single self-contained HTML file (safe to attach to a ticket or store as a
CI artifact). It contains:

- **Runs** — status, pass counts, heal counts per run.
- **Heals** — every heal with old → new locator, tier, confidence, mode
  (AUTO/UNVERIFIED/SUGGESTED/HUMAN), the model's reasoning where applicable, and
  **before/after screenshots** side by side. This is your review queue for
  `passed_unverified`.
- **Flake dashboard** — tests that both passed and failed on the same git commit.
- **LLM costs** — tokens, latency, and USD by provider × purpose (empty when running
  deterministic-only).

## 18. Promoting heals back into your spec files

Heals live in the database; your specs still contain the old locators. Periodically write
the reviewed ones back:

```bash
npx sentinel promote --dry-run                      # preview the diff, change nothing
npx sentinel promote                                # apply to working tree; review with git diff
npx sentinel promote --branch sentinel/promote-heals  # branch + commit, ready for a PR
npx sentinel promote --include-unverified           # also UNVERIFIED heals (review the report FIRST)
```

Safety properties worth knowing:

- By default only `AUTO` and `HUMAN`-answered heals are promoted; each heal is promoted
  once.
- Promote **refuses** contradictory promotions (the same old locator healing to different
  targets in different places) and ambiguous ones (different elements healing to the same
  target) — it prints why and leaves the file untouched.
- It's a normal git diff at the end. Nothing lands without code review.

**Cadence recommendation:** run `promote --dry-run` weekly; open a promotion PR when it's
non-trivial. Keeping specs close to reality keeps Tier 0 fast and diffs small.

## 19. A junior QA's weekly checklist

**Daily:**

- [ ] Check the run status. `passed` → done. `passed_unverified` → review the heal
      screenshots in the report _today_.
- [ ] Answer pending escalations (`sentinel escalations --answer`) — they block nothing,
      but every answered question makes the next run heal instantly.
- [ ] Treat every `PRODUCT_REGRESSION` as a potential real bug first. Never assume
      "probably a redesign" without checking the page.

**Weekly:**

- [ ] `sentinel report` — skim new heals; check the flake dashboard for repeat offenders
      and raise them.
- [ ] `sentinel promote --dry-run` — open a promotion PR if there's a meaningful diff.
- [ ] Search the suite for `intent: 'TODO'` (after migrations) and burn a few down.

**When writing new tests:**

- [ ] Route every interaction/assertion you want protected through `s.*`.
- [ ] Apply the intent litmus test (would a stranger find the element from the sentence?).
- [ ] Get the test green once before relying on healing.

---

# Part 4 — Reference

## 20. `s.*` API reference

All step methods take a `locator` (a normal Playwright `Locator`) and an `intent`
(string). Every action uses the configured `actionTimeoutMs` (default 5 000 ms) for the
first attempt before diagnosis/healing engages.

```ts
import { test, expect } from '@sentinel/core';
test('…', async ({ page, s }) => { … });
```

| Method                                    | What it does                                                                                                    | Healable?                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `s.goto(url)`                             | `page.goto` + fails on HTTP ≥ 500 + environment retries with backoff + runs configured `preSteps` after arrival | Retries only (nothing to heal) |
| `s.click({ locator, intent })`            | Click                                                                                                           | ✅                             |
| `s.fill({ locator, intent, value })`      | Fill an input. **`value` is excluded from all logs, fingerprints, artifacts, and LLM prompts.**                 | ✅                             |
| `s.expectVisible({ locator, intent })`    | Wait for the element to be visible (assertion — extra golden-rule guard applies)                                | ✅                             |
| `s.expectText({ locator, intent, text })` | Assert exact text via `expect(locator).toHaveText(text)` (assertion — golden-rule guard applies)                | ✅                             |
| `s.step(description, fn)`                 | Group steps (mirrors `test.step`); group path appears in failure messages, reports, and diagnosis context       | n/a                            |

Anything not in this table (hover, drag, keyboard, uploads, iframes, popups…) — use plain
Playwright `page` APIs; those steps run normally but are not diagnosed or healed.

## 21. Configuration reference (sentinel.config.ts)

Sentinel looks for `sentinel.config.{ts,mts,js,mjs}` walking **up** from the working
directory; all state paths resolve relative to the config file's directory. Everything has
a default — an empty config is valid.

```ts
import { defineConfig } from '@sentinel/core';
export default defineConfig({/* … */});
```

| Key                               | Default                                    | Meaning                                                                                                                                          |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stateDir`                        | `.sentinel`                                | Directory for the DB and artifacts (relative to the config file)                                                                                 |
| `dbFile`                          | `sentinel.db`                              | SQLite filename inside `stateDir`                                                                                                                |
| `testIdAttribute`                 | `data-testid`                              | Your project's test-id attribute — must match Playwright's `testIdAttribute`                                                                     |
| `actionTimeoutMs`                 | `5000`                                     | First-attempt timeout per step. Deliberately shorter than Playwright's 30 s so drift is detected quickly                                         |
| `capture.enabled`                 | `true`                                     | Ring-buffer artifact capture on/off                                                                                                              |
| `capture.ringBufferSize`          | `5`                                        | Frames kept in memory per test (1–50)                                                                                                            |
| `capture.screenshots`             | `true`                                     | Capture screenshots                                                                                                                              |
| `capture.domSnapshots`            | `true`                                     | Capture sanitized DOM snapshots                                                                                                                  |
| `capture.maskInputsInScreenshots` | `true`                                     | Blur inputs/textareas/selects (and redaction selectors) _before_ capture — Tier 3 sends screenshots to the LLM                                   |
| `healing.mode`                    | `'auto'`                                   | `auto` \| `suggest` \| `off` (see [section 10](#10-setting-up-sentinel-in-your-own-project))                                                     |
| `healing.tier1Threshold`          | `0.85`                                     | Fuzzy-match acceptance threshold                                                                                                                 |
| `healing.tier0VerifyThreshold`    | `0.6`                                      | Fingerprint-verification floor for cached alternates                                                                                             |
| `healing.autoApplyThreshold`      | `0.9`                                      | AUTO band boundary                                                                                                                               |
| `healing.applyFloor`              | `0.6`                                      | Below this: escalate, never guess                                                                                                                |
| `healing.ambiguityMargin`         | `0.03`                                     | Runner-up within this margin of the winner ⇒ ambiguous ⇒ escalate                                                                                |
| `healing.maxHealsPerTest`         | `3`                                        | Hard cap; exceeding fails loudly                                                                                                                 |
| `healing.maxHealsPerRun`          | `20`                                       | Hard cap; exceeding fails loudly                                                                                                                 |
| `healing.maxCollectElements`      | `300`                                      | Max candidate elements collected from the live DOM                                                                                               |
| `diagnosis.flakeDetection`        | `true`                                     | Statistical flake tagging (pass+fail on same git SHA). Disable if the app deploys independently of the test repo's SHA                           |
| `diagnosis.driftFloor`            | `0.5`                                      | Best-similarity below this ⇒ element considered genuinely absent ⇒ `PRODUCT_REGRESSION`                                                          |
| `diagnosis.assertionTextGuard`    | `0.8` (cannot go below 0.5)                | Healed assertion targets must retain this much of the original text — golden rule                                                                |
| `diagnosis.retriesOnEnvironment`  | `2`                                        | Environment-failure retries (0–5)                                                                                                                |
| `redaction.selectors`             | `[]`                                       | Extra CSS selectors whose content is redacted from snapshots/screenshots                                                                         |
| `redaction.maskPatterns`          | password/token/secret/card/cvv/ssn/api-key | Regexes matched against input name/id/autocomplete/placeholder to mask fields                                                                    |
| `preSteps`                        | `[]`                                       | Explicit, logged post-navigation clicks (consent banners). Fields: `name`, `selector`, `optional` (default `true`), `timeoutMs` (default `1500`) |
| `llm.*`                           | provider `'none'`                          | See [section 24](#24-enabling-llm-healing-tiers-23)                                                                                              |

## 22. Environment variables

Real environment variables always win over the `.env` file; the nearest `.env` walking up
from the working directory is auto-loaded (only for keys not already set).

| Variable                       | Effect                                                                      |
| ------------------------------ | --------------------------------------------------------------------------- |
| `SENTINEL_HEAL`                | Override healing mode: `auto` \| `suggest` \| `off`                         |
| `SENTINEL_LLM_PROVIDER`        | `none` \| `anthropic` \| `openai` \| `gemini` \| `openai-compatible`        |
| `SENTINEL_LLM_MODEL`           | Model name                                                                  |
| `SENTINEL_LLM_BASE_URL`        | Endpoint base URL (openai-compatible backends)                              |
| `SENTINEL_LLM_API_KEY`         | API key (default env var name; configurable via `llm.apiKeyEnv`)            |
| `SENTINEL_LLM_TIMEOUT_MS`      | Per-request timeout override                                                |
| `SENTINEL_LLM_SUPPORTS_VISION` | `1`/`true`/`yes` to force-enable Tier 3 for backends that don't self-report |
| `SENTINEL_RUN_ID`              | Explicit run id (CI sets `gh-<run>-shard-<n>` for aggregation)              |
| `SENTINEL_DB`                  | Override the database path                                                  |

## 23. CLI reference

| Command                     | Purpose / notable flags                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sentinel init`             | Scaffold `sentinel.config.ts`, `.sentinel/`, and a GitHub Actions workflow. Never overwrites existing files.                                                                                  |
| `sentinel run [args…]`      | Run the suite with a unified run id + summary. `--grep <p>`, `--project <name>`, `--heal auto\|suggest\|off`; unknown args pass through to `playwright test`. Exit code mirrors Playwright's. |
| `sentinel report`           | Static HTML report. `--out <dir>` (default `.sentinel/report`), `--runs <n>` (default 20).                                                                                                    |
| `sentinel summary`          | Markdown run summary for CI comments. `--run <id>`, `--run-prefix <prefix>` (aggregate shards), `--out <file>`, `--json <file>`.                                                              |
| `sentinel escalations`      | List pending questions. `--answer` interactive; `--choose <id> <label\|REDESIGN>` scriptable; `--all` include answered.                                                                       |
| `sentinel migrate <dir>`    | Codemod vanilla specs to `s.*` with TODO intents. `--dry-run` to preview. Idempotent.                                                                                                         |
| `sentinel promote`          | Write reviewed heals into specs as a diff. `--dry-run`, `--include-unverified`, `--branch <name>`, `--root <dir>`.                                                                            |
| `sentinel db export`        | Export state to portable JSON. `--json <file>` (default `.sentinel/sentinel-export.json`).                                                                                                    |
| `sentinel db import <file>` | Merge a JSON export into the local DB (idempotent — safe to import shard exports repeatedly).                                                                                                 |
| `sentinel doctor`           | Validate config, DB integrity, Playwright availability, and LLM connectivity (live ping). Exit 0 = healthy.                                                                                   |

## 24. Enabling LLM healing (Tiers 2–3)

Optional. Without it you keep Tiers 0–1 (which the chaos harness alone passes ≥ 90 % drift
healing with). With it, deep redesigns heal too, and ambiguous drift-vs-regression
diagnoses get a second opinion.

**Via environment only (no code changes):**

```bash
# Any OpenAI-compatible backend: OpenAI, OpenRouter, Ollama, LM Studio, vLLM…
export SENTINEL_LLM_PROVIDER=openai-compatible
export SENTINEL_LLM_BASE_URL=http://localhost:11434/v1    # e.g. Ollama, keyless
export SENTINEL_LLM_MODEL=llama3.1
export SENTINEL_LLM_API_KEY=sk-...                        # cloud backends only
```

**Or in config:**

```ts
llm: {
  provider: 'anthropic',            // 'anthropic' | 'openai' | 'gemini' | 'openai-compatible'
  model: 'claude-sonnet-4-5',
  apiKeyEnv: 'ANTHROPIC_API_KEY',   // name of the env var holding the key
  maxSpendUsdPerRun: 2,             // hard cap — exceeding fails loudly
  inputCostPerMTok: 3,              // enables cost accounting in the report
  outputCostPerMTok: 15,
  timeoutMs: 30_000,
  maxOutputTokens: 1024,            // raise for "thinking" models (see troubleshooting)
},
```

Then verify: `npx sentinel doctor` (it does a live ping and reports vision capability).

Defaults worth knowing: `timeoutMs` 30 000, `maxRetries` 2, `backoffBaseMs` 500
(deterministic, no jitter — heal decisions stay replayable), `circuitBreakerThreshold` 3,
`maxRepairAttempts` 2, `domCharBudget` 24 000, `maxOutputTokens` 1 024,
`maxSpendUsdPerRun` $2.

**Tier 3 (vision)** activates automatically when the provider supports images: the
sanitized failure screenshot + the same candidate list, cross-checked against the Tier 2
answer. Non-vision providers degrade gracefully to DOM-only healing.

The safety rails ([section 5.6](#56-safety-rails-around-the-llm-if-enabled)) apply to
every backend identically.

## 25. CI integration (GitHub Actions)

`sentinel init` scaffolds a single-job workflow for your project. The full-featured
reusable workflow lives at
[.github/workflows/sentinel.yml](../.github/workflows/sentinel.yml):

- **Cache persistence:** the locator cache is exported to JSON, stored via
  `actions/cache`, imported by every shard, and the merged result saved back — heals and
  escalation answers survive across CI runs and shards.
- **Sharding:** each shard runs with `SENTINEL_RUN_ID=gh-<run>-shard-<n>`; a merge job
  imports all shard exports (idempotent) and `sentinel summary --run-prefix gh-<run>`
  aggregates them.
- **One PR comment**, updated in place (never a comment flood), plus the step summary and
  the HTML report + heal screenshots as artifacts.
- **Escalations in CI:** pending questions appear in the comment (or a
  `sentinel-needs-human` issue on push builds) with an `action_required` check run —
  neither fake-green nor noisy-red. A maintainer replies `/sentinel choose <id> <label>`;
  a companion workflow ([sentinel-escalation-answer.yml](../.github/workflows/sentinel-escalation-answer.yml))
  applies it to the cache. Next run heals at Tier 0.
- **Only secret needed:** the LLM API key — and without it, healing simply runs
  deterministic Tiers 0–1.

## 26. Where your data lives

```
.sentinel/
├── sentinel.db            # SQLite (WAL mode): runs, test_results, steps, locator_cache,
│                          # heals, escalations, flake_stats, llm_calls
├── artifacts/<runId>/<test>/
│   ├── …-failure.jpg      # screenshot at failure (inputs blurred)
│   ├── …-failure.html.gz  # sanitized DOM snapshot
│   ├── …-healed.jpg       # screenshot after successful heal
│   └── …-healed.html.gz
└── report/index.html      # generated by `sentinel report`
```

- Keep `.sentinel/` **out of git**. Move state between machines/CI with
  `sentinel db export` / `db import`.
- Privacy: `s.fill` values are never persisted anywhere; DOM snapshots are sanitized
  in-page before capture; screenshots blur inputs before capture; secret-pattern fields
  (password/card/token/…) are masked; your `redaction.selectors` are blanked.

---

# Part 5 — Troubleshooting

## 27. First-aid checklist

Before anything else:

```bash
npx sentinel doctor
```

It validates, in order: config file parses → database integrity → LLM provider reachable
(if configured) → Playwright installed. Fix the first ✘ it prints, re-run, repeat. Most
"Sentinel is broken" reports are one of these four.

Second reflex: **read the first line of the failure message.** Every Sentinel failure
starts with `[sentinel] <CLASSIFICATION>: <reason>` — the classification tells you which
section below applies.

## 28. Common errors and what they mean

Grouped by the exact text you'll see.

### Setup & configuration

**`Invalid sentinel config at …` (with a list of fields)**
Your `sentinel.config.ts` has a value outside the schema (e.g. a negative timeout, or
`assertionTextGuard` below 0.5 — that floor is deliberate and cannot be lowered). Fix the
listed fields.

**`✘ playwright: not found (npx playwright --version failed)`** (from doctor)
Install Playwright in the project: `pnpm add -D @playwright/test` and
`npx playwright install chromium`.

**Tests can't find the `s` fixture / `Property 's' does not exist`**
You imported `test` from `@playwright/test`. Import it from `@sentinel/core`.

**Config seems ignored**
Sentinel walks _up_ from the current working directory to find
`sentinel.config.{ts,mts,js,mjs}`. If you run tests from a subfolder with its own config,
that one wins. `sentinel doctor` prints which config file was loaded — trust it.

### First runs & healing prerequisites

**`no locator cache for this step — cannot heal without history`** or
**`UNKNOWN: … no fingerprint history`**
The step has never succeeded, so there is no baseline fingerprint. Fix the locator
manually, get the test green once, and it's protected from then on. Also happens when the
`.sentinel` folder was deleted or you're on a fresh machine without importing state —
`sentinel db import` restores history.

**Step identity gotcha: healing stopped working after I reworded an intent**
The step id is derived from the action + intent text. Rewording the intent creates a new
step with no history. This is by design (the intent _is_ the identity) — after meaningful
rewording, expect one manual-fix cycle, or answer the escalation once.

### Healing behavior

**`healing disabled (mode=off)`**
Self-inflicted: mode is `off` via config, `SENTINEL_HEAL=off`, or `--heal off`.

**`heal available but not applied (mode=suggest): <descriptor> at confidence <c> — rerun with --heal=auto or review via sentinel report`**
Working as designed: suggest mode computes and records heals but keeps the step red. Apply
by rerunning with `--heal auto`, or review the suggestion in the report first.

**`max heals per test (3) exceeded` / `max heals per run (20) exceeded`**
A safety cap, not a bug. This much drift in one run usually means a big redesign or a
deploy of the wrong build. Investigate what changed; if the redesign is real and
intentional, fix locators in bulk (or temporarily raise the caps in config — consciously).

**`healing exhausted: <reason>`**
All tiers ran and nothing met the bar. There's now a pending escalation with candidates —
`sentinel escalations --answer`. Recurring on the same element usually means the intent is
too vague to disambiguate; improve it ([section 12](#12-writing-good-intents-the-most-important-skill)).

**`heal candidate found (…) but the action still failed: …`**
Sentinel found the right element but the action itself failed (overlaid modal, disabled
button, detached node). This is not drift — debug it like a normal Playwright failure;
check the failure screenshot in the artifacts.

**A heal picked the WRONG element**
Rare but possible in the 0.60–0.90 band — which is exactly why those runs are
`passed_unverified`, not `passed`. Answer the escalation/review with the correct candidate
(that overrides the cache), or fix the locator in the spec. If it happened at ≥ 0.90 on
look-alike elements, add disambiguating context to the intent and consider raising
`healing.ambiguityMargin`.

### Diagnosis outcomes

**`PRODUCT_REGRESSION: …`**
Sentinel believes the element is genuinely gone (best DOM similarity below the drift
floor, or a healed assertion lost the asserted text). It failed the test **on purpose**.
Verify by hand: real bug → file it; intentional redesign → answer `REDESIGN` and update
the test. Do not try to make Sentinel heal these — that's the golden rule working.

**`ENVIRONMENT: navigation to <url> failed after N attempts: …`** or
**`still failing after N environment retries`**
Network/server-side: DNS, connection refused, HTTP 5xx, page crashes. Sentinel already
retried with backoff. Check the app/environment is actually up (the demo needs
`pnpm demo:serve` running). Persistent on one test → look at the flake dashboard.

**`TEST_DATA: …` (unexpected auth wall)**
The page bounced to a login/authorization wall the test didn't expect. Fix credentials,
session setup, or seed data.

**Test tagged flaky that isn't** (or chaos-style setups)
Flake detection compares pass/fail on the _same git SHA of the test repo_. If your app
deploys independently of the test repo (the app changes while the SHA doesn't), disable
`diagnosis.flakeDetection` — otherwise legitimate app changes read as flakiness.

### LLM issues (Tiers 2–3)

**`[sentinel] LLM healing disabled: <reason>`** (warning at run start)
Config asks for a provider but something's missing — usually the API key env var (default
`SENTINEL_LLM_API_KEY`; your config may name a different one via `apiKeyEnv`) or a missing
`model`/`baseUrl`. The run continues deterministic-only. `sentinel doctor` pinpoints it.

**`[sentinel] LLM circuit breaker opened — falling back to deterministic-only healing for the rest of this run`**
Three consecutive provider failures (timeouts, 5xx, auth errors). The run finishes safely
on Tiers 0–1 and is flagged `healingUnavailable`. Fix the endpoint/key/quota; `doctor`
does a live ping.

**LLM replies come back empty / always "malformed"** (repair prompts, low confidence)
Classic with reasoning/"thinking" models (e.g. Gemma, Gemini thinking variants): they
spend output tokens on internal reasoning before the JSON, and a small budget truncates to
nothing. Raise `llm.maxOutputTokens` (try 2048).

**Spend cap exceeded**
`llm.maxSpendUsdPerRun` (default $2) is a hard stop that fails loudly rather than silently
burning budget. Raise it deliberately, or set real `inputCostPerMTok`/`outputCostPerMTok`
(0 = local/unknown backend, which disables cost-based stopping).

**Tier 3 never runs despite a vision model**
The adapter may not self-report vision for openai-compatible backends. Set
`SENTINEL_LLM_SUPPORTS_VISION=1` (or `llm.supportsVision: true`). `doctor` prints
`vision: true/false`.

### Data & environment

**Where are my screenshots?**
`.sentinel/artifacts/<runId>/<test-dir>/` — `-failure.jpg` at the break, `-healed.jpg`
after a successful heal. The report embeds them side by side.

**`.env` values behave oddly**
Sentinel's `.env` loader fills **only missing** variables — anything already set in the
real environment wins. Also: quoted values stop at the matching quote, and inline
comments after unquoted values are stripped. When in doubt, `echo $SENTINEL_LLM_PROVIDER`
before blaming the file.

**Two suites/projects clobbering each other's state**
Each project should have its own config dir (state resolves relative to the config file).
For deliberate isolation (parallel experiments), point `SENTINEL_DB` at separate files.

**Database growing / suspected corruption**
`sentinel doctor` runs `PRAGMA integrity_check`. The DB is WAL-mode SQLite; if it's ever
truly broken, worst case: delete `.sentinel/` and re-baseline with one green run (you lose
history and pending escalations, so export first if possible).

## 29. FAQ

**Q: Does Sentinel slow my tests down?**
On passing steps, the overhead is a lightweight in-page fingerprint capture per step. Real
cost appears only when a step fails: diagnosis + healing take a few seconds (deterministic)
up to ~20–30 s if LLM tiers engage. A healed step is still enormously cheaper than a
red build plus a human afternoon.

**Q: Can I trust a green build with heals in it?**
`passed` with AUTO heals: yes — those met the 0.90 bar and every one is audited with
before/after screenshots. `passed_unverified`: not until a human reviews the heal — that's
exactly what the status means, and why it's a distinct status.

**Q: Do I need an AI/LLM API key?**
No. Tiers 0–1 are fully offline and pass the chaos gate on their own. The LLM adds deep
redesign coverage and diagnostic second opinions — nice, optional.

**Q: What happens on a total page redesign?**
Lots of drift heals, some escalations, and possibly the heal caps triggering. That's
appropriate: a redesign _should_ involve a human deciding what the tests mean now. Answer
the escalations (or `REDESIGN` them) and promote.

**Q: Should heals be promoted immediately?**
No rush — the cache heals at Tier 0 on every subsequent run regardless. Promote
periodically so the specs stay readable and reviewable.

**Q: Playwright already retries and auto-waits. Why Sentinel?**
Retries mask flakiness; they don't fix a renamed testid — the retry fails identically.
Sentinel is orthogonal: it repairs _selector drift_ and _classifies_ everything else
instead of blindly retrying it.

**Q: Can developers keep using plain Playwright in the same repo?**
Yes. `s.*` and raw `page.*` coexist in the same test. Only `s.*` steps get diagnosis and
healing.

**Q: How do I explain a heal in a bug triage?**
Open the report: old locator → new locator, tier, confidence, reasoning, and before/after
screenshots. Every heal also records the git SHA it happened on.

---

_Further reading: [ARCHITECTURE.md](ARCHITECTURE.md) (pipeline diagram and data model),
[DECISIONS.md](DECISIONS.md) (all 37 recorded design decisions and their rationale),
[README.md](../README.md) (quickstart)._
