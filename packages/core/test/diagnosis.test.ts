import { describe, expect, it } from 'vitest';
import { classifyFailure, type DiagnosisInput } from '../src/diagnosis.js';
import { makeFp } from './helpers.js';

const thresholds = { driftFloor: 0.5 };

function input(overrides: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    errorMessage: 'Timeout 2500ms exceeded waiting for locator',
    action: 'click',
    isAssertion: false,
    intent: 'Add to cart button on the first product card',
    storedFingerprint: makeFp({ name: 'Add to cart', text: 'Add to cart' }),
    candidates: [],
    pageUrl: 'http://127.0.0.1:4173/products',
    navStatus: 200,
    knownFlaky: false,
    ...overrides,
  };
}

describe('classifyFailure heuristics (spec §5)', () => {
  it('network error signatures → ENVIRONMENT', () => {
    const d = classifyFailure(
      input({ errorMessage: 'page.goto: net::ERR_CONNECTION_REFUSED at http://x' }),
      thresholds,
    );
    expect(d.classification).toBe('ENVIRONMENT');
  });

  it('HTTP 5xx on last navigation → ENVIRONMENT', () => {
    const d = classifyFailure(input({ navStatus: 503 }), thresholds);
    expect(d.classification).toBe('ENVIRONMENT');
  });

  it('statistically flaky on same git SHA → ENVIRONMENT, never healed', () => {
    const d = classifyFailure(input({ knownFlaky: true }), thresholds);
    expect(d.classification).toBe('ENVIRONMENT');
    expect(d.knownFlaky).toBe(true);
  });

  it('unexpected auth wall → TEST_DATA', () => {
    const d = classifyFailure(
      input({ pageUrl: 'https://app.example.com/login?next=%2Fproducts' }),
      thresholds,
    );
    expect(d.classification).toBe('TEST_DATA');
  });

  it('no fingerprint history → UNKNOWN (cannot heal without an anchor)', () => {
    const d = classifyFailure(input({ storedFingerprint: null }), thresholds);
    expect(d.classification).toBe('UNKNOWN');
  });

  it('similar element still in DOM → LOCATOR_DRIFT', () => {
    const drifted = makeFp({
      name: 'Add to cart',
      text: 'Add to cart',
      classes: ['button-cta'],
    });
    const d = classifyFailure(input({ candidates: [drifted] }), thresholds);
    expect(d.classification).toBe('LOCATOR_DRIFT');
    expect(d.bestSimilarity).toBeGreaterThanOrEqual(0.5);
  });

  it('nothing similar in DOM → PRODUCT_REGRESSION (do not heal)', () => {
    const unrelated = makeFp({ name: 'Sign out', text: 'Sign out', tag: 'a', role: 'link' });
    const d = classifyFailure(
      input({
        isAssertion: true,
        storedFingerprint: makeFp({ text: 'Order confirmed', tag: 'div', role: null }),
        candidates: [unrelated],
      }),
      thresholds,
    );
    expect(d.classification).toBe('PRODUCT_REGRESSION');
  });
});
