# Sentinel

Self-healing end-to-end test automation on top of Playwright. Tests pair a normal
deterministic locator with a semantic **intent** string; when the locator breaks, Sentinel
diagnoses _why_ before doing anything, heals pure locator drift through a tiered pipeline,
refuses to guess when confidence is low, and never turns a genuine product regression into
a green build.

```ts
import { test } from '@sentinel/core';

test('checkout flow', async ({ page, s }) => {
  await s.goto('/products');
  await s.click({
    locator: page.getByRole('button', { name: 'Add to cart' }),
    intent: 'Primary add-to-cart button on the first listed product',
  });
  await s.fill({
    locator: page.getByLabel('Email'),
    intent: 'Email input field in the checkout contact section',
    value: 'test@example.com',
  });
  await s.expectVisible({
    locator: page.getByText('Order confirmed'),
    intent: 'Order confirmation success message shown after purchase completes',
  });
});
```

## How it behaves when a locator breaks

1. **Diagnose first, never heal blindly** — deterministic heuristics classify the failure:
   `LOCATOR_DRIFT` (element survived, selector broke), `PRODUCT_REGRESSION` (behavior
   genuinely gone → fail loudly + escalate, never healed), `ENVIRONMENT` (retry with
   backoff; statistically flaky tests are tagged, never healed), `TEST_DATA` (auth/seed
   problems → actionable failure).
2. **Heal in tiers, stop at first success** — Tier 0: cached fallback descriptors
   (testid → role+name → label → placeholder → text → structural CSS), fingerprint-verified.
   Tier 1: fuzzy fingerprint match against the live DOM (≥ 0.85). Tiers 2–3 (LLM DOM /
   vision) plug into the same pipeline from Phase 2 on.
3. **Confidence-tiered autonomy** — ≥ 0.90 auto-apply (logged `AUTO`); 0.60–0.90 applied
   but the run is only "passed with N unverified heals"; below 0.60 (or any ambiguity)
   Sentinel escalates a structured question instead of guessing.
4. **Everything is audited** — heals, escalations, steps, runs, flake stats and locator
   cache live in one portable SQLite file (`.sentinel/sentinel.db`), exportable to JSON for
   CI. Spec files are never silently edited; `sentinel promote` (Phase 6) writes reviewed
   heals back as a diff.

## Quickstart

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm build                      # builds @sentinel/core and @sentinel/cli
npx playwright install chromium
```

Try the demo suite (offline demo shop included):

```bash
pnpm demo:serve                 # terminal 1 — demo shop on http://127.0.0.1:4173
cd examples/tests
npx playwright test             # terminal 2 — first run populates the locator cache
```

Break the site and watch it heal — the full acceptance test:

```bash
pnpm chaos
```

This runs the suite against the baseline app, switches the server to a chaos profile
(ids/classes renamed, testids removed, labels reworded, buttons moved), re-runs and asserts
**≥ 90% of drift failures heal at Tiers 0–2**, then injects a genuine regression (success
message removed) and asserts it is **not** healed but escalated and failed.

## Using Sentinel in your own project

```bash
sentinel init                   # scaffolds sentinel.config.ts + .sentinel/
```

Author tests with `import { test } from '@sentinel/core'` and route interactions through
the `s` fixture (`s.goto`, `s.click`, `s.fill`, `s.expectVisible`, `s.expectText`,
`s.step`). Run via:

```bash
sentinel run [--grep <p>] [--project <name>] [--heal auto|suggest|off]
sentinel report [--out dir]              # static HTML: results, heals with
                                         # before/after screenshots, flake
                                         # dashboard, LLM cost summary
sentinel escalations                     # list pending human questions
sentinel escalations --answer            # answer interactively (arrow keys)
sentinel escalations --choose 3 A        # scriptable answer
sentinel db export --json cache.json     # move state to/from CI
sentinel db import cache.json
sentinel doctor                          # config / DB / provider connectivity
```

When Sentinel refuses to guess (low confidence, ambiguity, or a suspected regression), it
records a structured question with labeled candidates. Answering caches your choice as the
step's primary locator (next run heals at Tier 0), writes a `HUMAN` audit row, and feeds
future LLM heals of that element as few-shot context. Answer `REDESIGN` to record that the
change was intentional — Sentinel never edits your spec files.

### Configuration (`sentinel.config.ts`)

```ts
import { defineConfig } from '@sentinel/core';

export default defineConfig({
  testIdAttribute: 'data-testid',
  actionTimeoutMs: 5_000, // first-attempt timeout before healing engages
  healing: {
    mode: 'auto', // auto | suggest | off
    tier1Threshold: 0.85, // fuzzy-match acceptance
    autoApplyThreshold: 0.9, // AUTO band
    applyFloor: 0.6, // below this: escalate, never guess
    maxHealsPerTest: 3,
    maxHealsPerRun: 20,
  },
  redaction: {
    selectors: ['.customer-pii'], // extra elements to redact from snapshots
  },
  preSteps: [
    // consent flows are explicit and logged — never auto-accepted silently
    { name: 'accept cookies', selector: '[data-testid=consent-accept]' },
  ],
});
```

### Enabling LLM healing (Tier 2)

Everything runs offline; no LLM key is required for Tiers 0–1. With `llm.provider: 'none'`
(default) the pipeline is deterministic-only. To enable Tier 2, configure a provider —
in config or purely via env vars (zero code changes to switch backends):

```bash
# any OpenAI-compatible backend: OpenAI, OpenRouter, Z.ai/GLM, Kimi, Ollama, LM Studio…
export SENTINEL_LLM_PROVIDER=openai-compatible
export SENTINEL_LLM_BASE_URL=http://localhost:11434/v1   # e.g. Ollama (keyless)
export SENTINEL_LLM_MODEL=llama3.1
export SENTINEL_LLM_API_KEY=sk-...                        # cloud backends only
```

```ts
// or in sentinel.config.ts
llm: {
  provider: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'anthropic/claude-sonnet-4.5',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  maxSpendUsdPerRun: 2,            // hard cap — exceeding fails loudly
  inputCostPerMTok: 3,             // for cost accounting in llm_calls
  outputCostPerMTok: 15,
},
```

Guarantees regardless of backend: every call is Zod-validated (malformed replies get
repair prompts, then count as low confidence → escalation); prompts treat all page content
as untrusted data (injection defense) and the model can only pick an element index — never
navigation, new actions, or assertion changes; timeouts + deterministic backoff + a
circuit breaker mean a dead endpoint degrades the run to deterministic-only healing
(marked `healingUnavailable`) instead of hanging it; per-call tokens/cost/latency land in
the `llm_calls` table. No key present → Tiers 0–1 only, with a clear warning.

All four spec adapters ship: `anthropic` (native Messages API), `gemini` (native
generateContent), `openai` (Chat Completions), and `openai-compatible` (any backend).
Vision-capable providers additionally enable **Tier 3**: the sanitized failure screenshot
(inputs blurred at capture) plus the same candidate list, with the vision answer
cross-checked against the DOM answer — agreement boosts confidence, disagreement lowers
it. Providers with `supportsVision: false` degrade gracefully to DOM-only healing.

## Repository layout

```
packages/core       @sentinel/core — fixture, diagnosis, healing tiers 0-2, SQLite store
packages/providers  @sentinel/providers — LLMProvider abstraction, adapters, circuit breaker
packages/cli        @sentinel/cli — sentinel command
examples/demo-app   offline demo shop with chaos mutation profiles
examples/mock-llm   deterministic OpenAI-compatible mock (offline Tier 2 acceptance test)
examples/tests      example suite + chaos-harness integration test
docs/               ARCHITECTURE.md (pipeline diagram), DECISIONS.md
```

## Development

```bash
pnpm build          # tsc for all packages
pnpm test           # vitest unit tests (pipeline ordering, confidence policy,
                    # classifier, sanitizer, storage, zod validation)
pnpm lint           # eslint + prettier config
pnpm chaos          # full integration acceptance test
```

Project status: **Phases 1–4 complete** (fixture + SQLite + Tiers 0–1; all four provider
adapters; Tiers 2–3 with vision cross-check; LLM-arbitrated diagnosis; escalation
answering; static HTML report. Chaos harness green across 9 phases; Tier 2 verified live
on Gemma 4 31B and the native Gemini adapter + vision verified live on gemini-2.5-flash).
Remaining: GitHub Actions integration (Phase 5), migrate/promote commands (Phase 6). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the phase plan and
[docs/DECISIONS.md](docs/DECISIONS.md) for design rationale.
