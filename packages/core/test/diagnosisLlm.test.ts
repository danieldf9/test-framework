import type { LLMProvider, LLMRequest } from '@sentinel/providers';
import { describe, expect, it } from 'vitest';
import type { DiagnosisInput } from '../src/diagnosis.js';
import { detectAmbiguity, refineDiagnosis } from '../src/diagnosisLlm.js';
import { SentinelStore } from '../src/storage/store.js';
import type { Diagnosis } from '../src/types.js';
import { makeFp } from './helpers.js';

const thresholds = { driftFloor: 0.5, assertionTextGuard: 0.8 };

function input(overrides: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    errorMessage: 'Timeout 2500ms exceeded',
    action: 'expectVisible',
    isAssertion: true,
    intent: 'Order confirmation success message shown after purchase completes',
    storedFingerprint: makeFp({
      tag: 'div',
      role: null,
      text: 'Order confirmed',
      id: 'order-confirmation',
      classes: ['confirmation'],
    }),
    candidates: [
      makeFp({
        tag: 'div',
        role: null,
        text: 'Order could not be confirmed',
        name: 'Order could not be confirmed',
        id: 'order-confirmation',
        classes: ['confirmation'],
      }),
    ],
    pageUrl: 'http://127.0.0.1:4173/checkout',
    navStatus: 200,
    knownFlaky: false,
    ...overrides,
  };
}

function drift(): Diagnosis {
  return {
    classification: 'LOCATOR_DRIFT',
    reason: 'heuristic',
    bestSimilarity: 0.8,
    candidateCount: 1,
    knownFlaky: false,
  };
}

function mockProvider(replies: string[]): LLMProvider & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    name: 'mock',
    model: 'mock-1',
    supportsVision: false,
    requests,
    async complete(req) {
      requests.push(req);
      const text = replies[Math.min(requests.length - 1, replies.length - 1)]!;
      return { text, model: 'mock-1', inputTokens: 10, outputTokens: 5, latencyMs: 1 };
    },
  };
}

function deps(provider: LLMProvider) {
  const store = new SentinelStore(':memory:');
  store.ensureRun('r1', null, 'auto');
  return {
    provider,
    store,
    runId: 'r1',
    llm: { maxRepairAttempts: 2, maxOutputTokens: 1024, maxSpendUsdPerRun: 2 },
  };
}

describe('detectAmbiguity (spec §5: LLM only when heuristics are ambiguous)', () => {
  it('assertion with drift-level structure but changed content → ambiguous', () => {
    const verdict = detectAmbiguity(input(), drift(), thresholds);
    expect(verdict.ambiguous).toBe(true);
    expect(verdict.why).toContain('contradictory signals');
  });

  it('similarity near the decision floor → ambiguous', () => {
    const verdict = detectAmbiguity(
      input({
        isAssertion: false,
        action: 'click',
        storedFingerprint: makeFp({ name: 'Add to cart', text: 'Add to cart' }),
        candidates: [makeFp({ name: 'Add item now', text: 'Add item now', classes: ['other'] })],
      }),
      drift(),
      thresholds,
    );
    expect(verdict.ambiguous).toBe(true);
    expect(verdict.why).toContain('decision floor');
  });

  it('clear drift (identical element, renamed id) is NOT ambiguous — no LLM call', () => {
    const verdict = detectAmbiguity(
      input({
        isAssertion: false,
        action: 'click',
        storedFingerprint: makeFp({ name: 'Add to cart', text: 'Add to cart', id: 'old' }),
        candidates: [makeFp({ name: 'Add to cart', text: 'Add to cart', id: 'new' })],
      }),
      drift(),
      thresholds,
    );
    expect(verdict.ambiguous).toBe(false);
  });

  it('never consulted for ENVIRONMENT/TEST_DATA/UNKNOWN classes', () => {
    const env: Diagnosis = { ...drift(), classification: 'ENVIRONMENT' };
    expect(detectAmbiguity(input(), env, thresholds).ambiguous).toBe(false);
  });
});

describe('refineDiagnosis', () => {
  it('reclassifies drift → regression on a confident LLM verdict', async () => {
    const provider = mockProvider([
      '{"classification":"PRODUCT_REGRESSION","confidence":0.9,"reasoning":"text negated"}',
    ]);
    const refined = await refineDiagnosis(deps(provider), input(), drift(), thresholds);
    expect(refined.classification).toBe('PRODUCT_REGRESSION');
    expect(refined.refinedByLlm).toBe(true);
    expect(refined.reason).toContain('LLM reclassified');
    expect(provider.requests[0]!.messages[1]!.content).toContain('UNTRUSTED PAGE DATA');
  });

  it('keeps the deterministic result when the LLM is unsure', async () => {
    const provider = mockProvider([
      '{"classification":"PRODUCT_REGRESSION","confidence":0.4,"reasoning":"maybe"}',
    ]);
    const refined = await refineDiagnosis(deps(provider), input(), drift(), thresholds);
    expect(refined.classification).toBe('LOCATOR_DRIFT');
    expect(refined.reason).toContain('unsure');
  });

  it('keeps the deterministic result when the provider fails', async () => {
    const dead: LLMProvider = {
      name: 'dead',
      model: 'x',
      supportsVision: false,
      async complete() {
        throw new Error('ECONNREFUSED');
      },
    };
    const refined = await refineDiagnosis(deps(dead), input(), drift(), thresholds);
    expect(refined.classification).toBe('LOCATOR_DRIFT');
    expect(refined.reason).toContain('unavailable');
  });

  it('does not call the LLM at all for unambiguous diagnoses', async () => {
    const provider = mockProvider([
      '{"classification":"PRODUCT_REGRESSION","confidence":1,"reasoning":"x"}',
    ]);
    const clear = input({
      isAssertion: false,
      action: 'click',
      storedFingerprint: makeFp({ name: 'Add to cart', text: 'Add to cart', id: 'old' }),
      candidates: [makeFp({ name: 'Add to cart', text: 'Add to cart', id: 'new' })],
    });
    await refineDiagnosis(deps(provider), clear, drift(), thresholds);
    expect(provider.requests).toHaveLength(0);
  });

  it('skips refinement (with a visible note) when the spend cap is reached', async () => {
    const provider = mockProvider([
      '{"classification":"PRODUCT_REGRESSION","confidence":1,"reasoning":"x"}',
    ]);
    const d = deps(provider);
    d.store.recordLlmCall({
      runId: 'r1',
      provider: 'mock',
      model: 'mock-1',
      purpose: 'heal-tier2',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 5,
      latencyMs: 1,
      ok: true,
      error: null,
    });
    const refined = await refineDiagnosis(d, input(), drift(), thresholds);
    expect(refined.classification).toBe('LOCATOR_DRIFT');
    expect(refined.reason).toContain('spend cap');
    expect(provider.requests).toHaveLength(0);
  });
});
