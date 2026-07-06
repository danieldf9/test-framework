import { defineConfig } from '@sentinel/core';

export default defineConfig({
  // Fail fast into diagnosis/healing — the demo app renders instantly.
  actionTimeoutMs: 2_500,
  healing: {
    // The chaos profile deliberately breaks four locators inside the checkout
    // test; the framework default (3 per test) is tuned for real-world drift.
    maxHealsPerTest: 5,
  },
  diagnosis: {
    // The chaos harness deliberately mutates the APP while the test repo's git
    // SHA stays fixed — exactly the pattern statistical flake detection exists
    // to catch. Disable it here so intentional mutations aren't quarantined.
    flakeDetection: false,
  },
  llm: {
    // Provider/model/baseUrl come from .env (SENTINEL_LLM_*); the key is read
    // from GEMINI_API_KEY so it is never duplicated across files.
    apiKeyEnv: 'GEMINI_API_KEY',
    // Gemma 4 is a reasoning model: it spends output tokens on <thought>
    // blocks before the JSON answer, so give it room.
    maxOutputTokens: 2048,
  },
  // Consent banners are handled by an explicit, logged pre-step (spec §10) —
  // never auto-accepted silently.
  preSteps: [
    {
      name: 'accept cookie banner',
      selector: '[data-testid=consent-accept]',
      action: 'click',
      optional: true,
      timeoutMs: 1_000,
    },
  ],
});
