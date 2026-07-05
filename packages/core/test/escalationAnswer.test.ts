import { describe, expect, it } from 'vitest';
import { applyEscalationAnswer } from '../src/escalationAnswer.js';
import { SentinelStore } from '../src/storage/store.js';
import type { EscalationQuestion } from '../src/types.js';
import { makeFp } from './helpers.js';

function seed(store: SentinelStore): number {
  store.ensureRun('r1', null, 'auto');
  const fp = makeFp({
    name: 'Add to bag',
    text: 'Add to bag',
    role: 'button',
    nearbyText: 'Aurora Desk Lamp $49 Add to bag',
  });
  const question: EscalationQuestion = {
    test: 't1',
    step: 's1',
    intent: 'Add to cart button on the first product card',
    question: 'Which candidate matches?',
    candidates: [
      {
        label: 'A',
        descriptor: { kind: 'role', value: 'button', name: 'Add to bag', exact: true },
        confidence: 0.74,
        fingerprint: fp,
      },
      {
        label: 'B',
        descriptor: { kind: 'css', value: 'body > main > button' },
        confidence: 0.61,
        fingerprint: makeFp({ name: 'Add to bag', nearbyText: 'Nimbus Chair' }),
      },
    ],
    context: {
      url: 'http://x/products',
      classification: 'LOCATOR_DRIFT',
      screenshot: null,
      error: 'Timeout',
      oldLocator: "locator('#add-to-cart-1')",
    },
  };
  return store.recordEscalation({ runId: 'r1', testId: 't1', stepId: 's1', question });
}

describe('applyEscalationAnswer (spec §6: answer recorded and applied)', () => {
  it('caches the chosen candidate as primary and audits a HUMAN heal', () => {
    const store = new SentinelStore(':memory:');
    const id = seed(store);
    const result = applyEscalationAnswer(store, id, 'a', 'daniel', 'cli');

    expect(result.redesign).toBe(false);
    expect(result.appliedDescriptor).toContain('Add to bag');

    const cache = store.getCacheEntry('t1', 's1')!;
    expect(cache.primary).toEqual({
      kind: 'role',
      value: 'button',
      name: 'Add to bag',
      exact: true,
    });
    expect(cache.fingerprint.name).toBe('Add to bag');
    expect(cache.intent).toBe('Add to cart button on the first product card');

    const heal = store.db.prepare("SELECT * FROM heals WHERE mode = 'HUMAN'").get() as Record<
      string,
      unknown
    >;
    expect(heal.old_locator).toBe("locator('#add-to-cart-1')");
    expect(heal.confidence).toBe(1);

    expect(store.pendingEscalations()).toHaveLength(0);
    const answered = store.answeredEscalationsForStep('t1', 's1');
    expect(answered[0]!.answer).toContain('A: ');
  });

  it('REDESIGN records the decision without touching the cache', () => {
    const store = new SentinelStore(':memory:');
    const id = seed(store);
    const result = applyEscalationAnswer(store, id, 'REDESIGN', 'daniel', 'cli');
    expect(result.redesign).toBe(true);
    expect(store.getCacheEntry('t1', 's1')).toBeNull();
    expect(store.db.prepare('SELECT COUNT(*) n FROM heals').get()).toEqual({ n: 0 });
    expect(store.pendingEscalations()).toHaveLength(0);
  });

  it('rejects unknown labels and double answers', () => {
    const store = new SentinelStore(':memory:');
    const id = seed(store);
    expect(() => applyEscalationAnswer(store, id, 'Z', 'daniel', 'cli')).toThrow(
      /no candidate 'Z'/,
    );
    applyEscalationAnswer(store, id, 'B', 'daniel', 'cli');
    expect(() => applyEscalationAnswer(store, id, 'A', 'daniel', 'cli')).toThrow(
      /already answered/,
    );
    expect(() => applyEscalationAnswer(store, 999, 'A', 'daniel', 'cli')).toThrow(/not found/);
  });
});
