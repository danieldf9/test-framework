import { SentinelStore } from '@sentinel/core';
import { describe, expect, it } from 'vitest';
import { buildRunSummary } from '../src/summary.js';

function seedShardedRuns(): SentinelStore {
  const store = new SentinelStore(':memory:');
  for (const shard of [1, 2]) {
    const runId = `gh-777-shard-${shard}`;
    store.ensureRun(runId, 'sha-x', 'auto');
    store.recordTestResult({
      runId,
      testId: `t-${shard}`,
      title: `test ${shard}`,
      file: 'shop.spec.ts',
      status: shard === 1 ? 'passed' : 'passed_unverified',
      durationMs: 100,
      error: null,
      flakyTagged: false,
    });
    store.recordHeal({
      runId,
      testId: `t-${shard}`,
      stepId: `s-${shard}`,
      intent: `intent ${shard}`,
      oldLocator: `locator('#old-${shard}')`,
      newLocator: `getByRole('button', { name: 'new ${shard}' })`,
      tier: shard === 1 ? 0 : 2,
      confidence: shard === 1 ? 0.95 : 0.8,
      mode: shard === 1 ? 'AUTO' : 'UNVERIFIED',
      reasoning: 'r',
      screenshotBefore: null,
      screenshotAfter: null,
      gitSha: 'sha-x',
    });
  }
  store.recordEscalation({
    runId: 'gh-777-shard-2',
    testId: 't-2',
    stepId: 's-esc',
    question: {
      test: 't-2',
      step: 's-esc',
      intent: 'the missing button',
      question: 'Which candidate matches?',
      candidates: [
        {
          label: 'A',
          descriptor: { kind: 'css', value: '#a' },
          confidence: 0.55,
          fingerprint: {
            tag: 'button',
            role: 'button',
            name: 'Maybe me',
            text: 'Maybe me',
            id: null,
            testId: null,
            classes: [],
            attributes: {},
            nearbyText: '',
            labelText: '',
            cssPath: 'body > button:nth-of-type(1)',
          },
        },
      ],
      context: { url: '', classification: 'LOCATOR_DRIFT', screenshot: null, error: '' },
    },
  });
  // an unrelated run that must NOT be aggregated
  store.ensureRun('other-run', null, 'auto');
  store.recordTestResult({
    runId: 'other-run',
    testId: 't-x',
    title: 'other',
    file: 'x.spec.ts',
    status: 'failed',
    durationMs: 1,
    error: 'boom',
    flakyTagged: false,
  });
  return store;
}

describe('buildRunSummary (spec §9 CI comment)', () => {
  it('aggregates sharded runs by prefix and renders GH markdown', () => {
    const store = seedShardedRuns();
    const s = buildRunSummary(store, { runPrefix: 'gh-777-' });

    expect(s.runIds).toEqual(['gh-777-shard-1', 'gh-777-shard-2']);
    expect(s.tests).toBe(2); // the unrelated failed run is excluded
    expect(s.failed).toBe(0);
    expect(s.heals).toBe(2);
    expect(s.autoHeals).toBe(1);
    expect(s.unverifiedHeals).toBe(1);
    expect(s.pendingEscalations).toBe(1);
    expect(s.status).toBe('passed_unverified');

    expect(s.markdown).toContain('passed with 1 unverified heal');
    expect(s.markdown).toContain('| 2 | 2 | 0 | 2 | 1 | 1 | 0 | 1 |');
    expect(s.markdown).toContain("locator('#old-2')");
    expect(s.markdown).toContain('question(s) need a human');
    expect(s.markdown).toContain('/sentinel choose');
    expect(s.markdown).toContain('(A)');
    store.close();
  });

  it('reports failures and empty stores sanely', () => {
    const store = seedShardedRuns();
    expect(buildRunSummary(store, { runId: 'other-run' }).status).toBe('failed');
    expect(buildRunSummary(store, { runPrefix: 'nope-' }).status).toBe('no-runs');
    store.close();
  });

  it('surfaces the healing-unavailable flag', () => {
    const store = new SentinelStore(':memory:');
    store.ensureRun('r1', null, 'auto');
    store.setRunMetaFlag('r1', 'healingUnavailable', true);
    store.recordTestResult({
      runId: 'r1',
      testId: 't',
      title: 't',
      file: 'f',
      status: 'passed',
      durationMs: 1,
      error: null,
      flakyTagged: false,
    });
    const s = buildRunSummary(store, { runId: 'r1' });
    expect(s.healingUnavailable).toBe(true);
    expect(s.markdown).toContain('LLM healing was unavailable');
    store.close();
  });
});
