import type { Diagnosis, ElementFingerprint } from './types.js';
import { fingerprintSimilarity } from './similarity.js';

export interface DiagnosisInput {
  errorMessage: string;
  action: string;
  isAssertion: boolean;
  intent: string;
  /** Fingerprint from the last passing run (null on a never-passed step). */
  storedFingerprint: ElementFingerprint | null;
  /** Visible elements collected from the live DOM at failure time. */
  candidates: ElementFingerprint[];
  pageUrl: string;
  /** HTTP status of the last main-frame navigation, if known. */
  navStatus: number | null;
  knownFlaky: boolean;
}

export interface DiagnosisThresholds {
  driftFloor: number;
}

const ENV_ERROR_PATTERNS = [
  /net::ERR_/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i,
  /Target (page|context|browser).*(closed|crashed)/i,
  /Navigation failed because page crashed/i,
  /page\.goto: (Timeout|net::)/i,
  /browser has disconnected/i,
];

const AUTH_URL_PATTERN = /\/(login|log-in|signin|sign-in|auth|session\/new)([/?#]|$)/i;

/**
 * Failure classifier (spec §5). Cheap deterministic heuristics, evaluated in
 * order of confidence. Runs BEFORE any healing; healing is only ever attempted
 * for LOCATOR_DRIFT. LLM-assisted classification for ambiguous cases arrives in
 * Phase 3 — every rule here stays deterministic.
 */
export function classifyFailure(input: DiagnosisInput, thresholds: DiagnosisThresholds): Diagnosis {
  const base = {
    bestSimilarity: null as number | null,
    candidateCount: input.candidates.length,
    knownFlaky: input.knownFlaky,
  };

  // 1. Infrastructure/environment signatures in the error itself.
  if (ENV_ERROR_PATTERNS.some((p) => p.test(input.errorMessage))) {
    return {
      ...base,
      classification: 'ENVIRONMENT',
      reason: 'Error matches a network/infrastructure failure signature.',
    };
  }

  // 2. Server-side failure on the last navigation.
  if (input.navStatus !== null && input.navStatus >= 500) {
    return {
      ...base,
      classification: 'ENVIRONMENT',
      reason: `Last navigation returned HTTP ${input.navStatus}.`,
    };
  }

  // 3. Statistical flake: same code (git SHA), both passing and failing history.
  if (input.knownFlaky) {
    return {
      ...base,
      classification: 'ENVIRONMENT',
      reason:
        'Test has both passed and failed on this git SHA — statistically flaky, not healable.',
    };
  }

  // 4. Auth expiry heuristic: we were dumped on a login page the test did not ask for.
  if (AUTH_URL_PATTERN.test(input.pageUrl) && !/login|sign.?in|auth/i.test(input.intent)) {
    return {
      ...base,
      classification: 'TEST_DATA',
      reason: `Page URL (${input.pageUrl}) looks like an auth wall while the step intent does not mention signing in — session/auth state likely expired.`,
    };
  }

  // 5. No history — nothing to compare against. Never heal without an anchor.
  if (!input.storedFingerprint) {
    return {
      ...base,
      classification: 'UNKNOWN',
      reason:
        'Step has never passed, so there is no fingerprint history to heal from. Fix the locator or run once against a good build to establish the cache.',
    };
  }

  // 6. Fingerprint search: does anything in the live DOM still look like the element?
  let best = 0;
  for (const candidate of input.candidates) {
    const { score } = fingerprintSimilarity(input.storedFingerprint, candidate);
    if (score > best) best = score;
  }

  if (best >= thresholds.driftFloor) {
    return {
      ...base,
      bestSimilarity: best,
      classification: 'LOCATOR_DRIFT',
      reason: `Element-like candidate present in DOM (best similarity ${best.toFixed(2)}) — selector broke, element likely survived.`,
    };
  }

  return {
    ...base,
    bestSimilarity: best,
    classification: 'PRODUCT_REGRESSION',
    reason: input.isAssertion
      ? `Nothing in the live DOM resembles the asserted element (best similarity ${best.toFixed(2)}) — the expected content/behavior is genuinely absent.`
      : `Nothing in the live DOM resembles the target element (best similarity ${best.toFixed(2)}) — the element is genuinely gone, not just renamed.`,
  };
}
