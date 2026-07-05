import { describe, expect, it } from 'vitest';
import { exportDatabase, importDatabase } from '../src/storage/exportImport.js';
import { SentinelStore } from '../src/storage/store.js';
import { makeFp } from './helpers.js';

function mem(): SentinelStore {
  return new SentinelStore(':memory:');
}

describe('SentinelStore locator cache', () => {
  it('round-trips cache entries', () => {
    const s = mem();
    s.upsertCacheEntry({
      testId: 't1',
      stepId: 's1',
      primary: { kind: 'testid', value: 'add-to-cart-1' },
      alternates: [{ kind: 'role', value: 'button', name: 'Add to cart', exact: true }],
      fingerprint: makeFp({ name: 'Add to cart' }),
      intent: 'add to cart button',
      lastVerifiedAt: 123,
    });
    const e = s.getCacheEntry('t1', 's1')!;
    expect(e.primary).toEqual({ kind: 'testid', value: 'add-to-cart-1' });
    expect(e.alternates).toHaveLength(1);
    expect(e.fingerprint.name).toBe('Add to cart');

    s.upsertCacheEntry({ ...e, intent: 'updated', lastVerifiedAt: 456 });
    expect(s.getCacheEntry('t1', 's1')!.intent).toBe('updated');
    s.close();
  });
});

describe('SentinelStore heal caps', () => {
  it('counts heals per run and per test', () => {
    const s = mem();
    s.ensureRun('r1', null, 'auto');
    const heal = (testId: string) =>
      s.recordHeal({
        runId: 'r1',
        testId,
        stepId: 'x',
        intent: 'i',
        oldLocator: 'a',
        newLocator: 'b',
        tier: 0,
        confidence: 0.95,
        mode: 'AUTO',
        reasoning: '',
        screenshotBefore: null,
        screenshotAfter: null,
        gitSha: null,
      });
    heal('t1');
    heal('t1');
    heal('t2');
    expect(s.healCountForRun('r1')).toBe(3);
    expect(s.healCountForTest('r1', 't1')).toBe(2);
    s.close();
  });
});

describe('SentinelStore flake detection', () => {
  it('flags pass+fail on the same git SHA as flaky', () => {
    const s = mem();
    s.recordFlakeStat('t1', 'sha-a', 'r1', 'passed');
    s.recordFlakeStat('t1', 'sha-a', 'r2', 'failed');
    s.recordFlakeStat('t2', 'sha-a', 'r1', 'failed');
    s.recordFlakeStat('t2', 'sha-b', 'r2', 'passed');
    expect(s.isKnownFlaky('t1', 'sha-a')).toBe(true);
    expect(s.isKnownFlaky('t2', 'sha-a')).toBe(false); // fail-only ≠ flaky
    expect(s.isKnownFlaky('t1', null)).toBe(false); // no SHA, no signal
    s.close();
  });
});

describe('SentinelStore escalations', () => {
  it('records, lists, and answers escalations', () => {
    const s = mem();
    const q = {
      test: 't1',
      step: 's1',
      intent: 'add to cart',
      question: 'which candidate?',
      candidates: [],
      context: { url: '', classification: 'LOCATOR_DRIFT' as const, screenshot: null, error: '' },
    };
    const id = s.recordEscalation({ runId: 'r1', testId: 't1', stepId: 's1', question: q });
    expect(s.pendingEscalations()).toHaveLength(1);
    s.answerEscalation(id, 'A', 'daniel', 'cli');
    expect(s.pendingEscalations()).toHaveLength(0);
    expect(s.answeredEscalationsForStep('t1', 's1')[0]!.answer).toBe('A');
    s.close();
  });
});

describe('export / import (CI portability)', () => {
  it('round-trips and merges idempotently', () => {
    const a = mem();
    a.ensureRun('r1', 'sha', 'auto');
    a.upsertCacheEntry({
      testId: 't1',
      stepId: 's1',
      primary: { kind: 'css', value: '#x' },
      alternates: [],
      fingerprint: makeFp({}),
      intent: 'i',
      lastVerifiedAt: 100,
    });
    a.recordFlakeStat('t1', 'sha', 'r1', 'passed');
    const dump = exportDatabase(a.db);

    const b = mem();
    const first = importDatabase(b.db, dump);
    expect(first.imported).toBeGreaterThan(0);
    expect(b.getCacheEntry('t1', 's1')).not.toBeNull();

    const again = importDatabase(b.db, dump);
    const flakeRows = b.db.prepare('SELECT COUNT(*) n FROM flake_stats').get() as { n: number };
    expect(flakeRows.n).toBe(1); // idempotent — no duplicated history
    expect(again.imported).toBeLessThanOrEqual(first.imported);

    // newest cache entry wins on merge
    a.upsertCacheEntry({
      testId: 't1',
      stepId: 's1',
      primary: { kind: 'css', value: '#newer' },
      alternates: [],
      fingerprint: makeFp({}),
      intent: 'i',
      lastVerifiedAt: 200,
    });
    importDatabase(b.db, exportDatabase(a.db));
    expect(b.getCacheEntry('t1', 's1')!.primary).toEqual({ kind: 'css', value: '#newer' });
    a.close();
    b.close();
  });
});
