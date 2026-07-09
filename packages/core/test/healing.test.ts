import { describe, expect, it } from 'vitest';
import { makeTier1Resolver, runHealingPipeline, type TierResolver } from '../src/healing.js';
import type { CacheEntry } from '../src/storage/store.js';
import { makeFp } from './helpers.js';

const policy = {
  tier1Threshold: 0.85,
  tier0VerifyThreshold: 0.6,
  autoApplyThreshold: 0.9,
  applyFloor: 0.6,
  ambiguityMargin: 0.03,
};

function cache(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    testId: 't',
    stepId: 's',
    primary: { kind: 'testid', value: 'x' },
    alternates: [],
    fingerprint: makeFp({ name: 'Place order', text: 'Place order' }),
    intent: 'submit button',
    lastVerifiedAt: Date.now(),
    ...overrides,
  };
}

function fakeResolver(
  tier: 0 | 1 | 2 | 3,
  result: { score: number; secondBest?: number; text?: string } | null,
  calls: number[],
): TierResolver {
  return {
    tier,
    name: `fake-${tier}`,
    async resolve() {
      calls.push(tier);
      if (!result) return null;
      return {
        fingerprint: makeFp({ name: 'Place order', text: result.text ?? 'Place order' }),
        score: result.score,
        secondBest: result.secondBest ?? 0,
        reasoning: 'fake',
      };
    },
  };
}

const noGuard = { isAssertion: false, minTextSimilarity: 0.8 };

describe('runHealingPipeline — tier ordering', () => {
  it('stops at the first tier that succeeds', async () => {
    const calls: number[] = [];
    const outcome = await runHealingPipeline(
      [fakeResolver(0, { score: 0.95 }, calls), fakeResolver(1, { score: 0.99 }, calls)],
      { cache: cache(), collected: [], policy, guard: noGuard },
    );
    expect(outcome.healed).toBe(true);
    expect(outcome.match!.tier).toBe(0);
    expect(calls).toEqual([0]); // tier 1 never ran
  });

  it('falls through tiers in order when earlier tiers find nothing', async () => {
    const calls: number[] = [];
    const outcome = await runHealingPipeline(
      [fakeResolver(0, null, calls), fakeResolver(1, { score: 0.92 }, calls)],
      { cache: cache(), collected: [], policy, guard: noGuard },
    );
    expect(outcome.healed).toBe(true);
    expect(outcome.match!.tier).toBe(1);
    expect(calls).toEqual([0, 1]);
  });
});

describe('runHealingPipeline — confidence policy (spec §6)', () => {
  it('confidence >= 0.90 heals (AUTO band)', async () => {
    const outcome = await runHealingPipeline([fakeResolver(0, { score: 0.93 }, [])], {
      cache: cache(),
      collected: [],
      policy,
      guard: noGuard,
    });
    expect(outcome.healed).toBe(true);
    expect(outcome.match!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('0.60 <= confidence < 0.90 heals (UNVERIFIED band)', async () => {
    const outcome = await runHealingPipeline([fakeResolver(0, { score: 0.72 }, [])], {
      cache: cache(),
      collected: [],
      policy,
      guard: noGuard,
    });
    expect(outcome.healed).toBe(true);
    expect(outcome.match!.confidence).toBeLessThan(0.9);
    expect(outcome.match!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('confidence < 0.60 never heals — do not guess', async () => {
    const outcome = await runHealingPipeline([fakeResolver(0, { score: 0.55 }, [])], {
      cache: cache(),
      collected: [],
      policy,
      guard: noGuard,
    });
    expect(outcome.healed).toBe(false);
    expect(outcome.rejected.length).toBeGreaterThan(0);
  });

  it('near-tie candidates are ambiguous → confidence capped below the floor', async () => {
    const outcome = await runHealingPipeline(
      [fakeResolver(0, { score: 0.92, secondBest: 0.91 }, [])],
      { cache: cache(), collected: [], policy, guard: noGuard },
    );
    expect(outcome.healed).toBe(false);
    expect(outcome.reason).toContain('below apply floor');
  });
});

describe('runHealingPipeline — assertion guard (golden rule)', () => {
  it('refuses a heal that would change what the assertion checks', async () => {
    const c = cache({ fingerprint: makeFp({ text: 'Order confirmed', role: null, tag: 'div' }) });
    const outcome = await runHealingPipeline(
      [fakeResolver(1, { score: 0.95, text: 'Payment failed' }, [])],
      { cache: c, collected: [], policy, guard: { isAssertion: true, minTextSimilarity: 0.8 } },
    );
    expect(outcome.healed).toBe(false);
    expect(outcome.reason).toContain('assertion guard');
  });

  it('allows a heal when the asserted content is preserved', async () => {
    const c = cache({ fingerprint: makeFp({ text: 'Order confirmed', role: null, tag: 'div' }) });
    const outcome = await runHealingPipeline(
      [fakeResolver(1, { score: 0.95, text: 'Order confirmed' }, [])],
      { cache: c, collected: [], policy, guard: { isAssertion: true, minTextSimilarity: 0.8 } },
    );
    expect(outcome.healed).toBe(true);
  });
});

describe('makeTier1Resolver', () => {
  it('accepts only above the configured similarity threshold', async () => {
    const stored = makeFp({
      name: 'Place order',
      text: 'Place order',
      classes: ['btn', 'btn-order'],
      attributes: { type: 'submit' },
      nearbyText: 'Email We will email your receipt. Place order',
    });
    const goodCandidate = makeFp({
      name: 'Place your order',
      text: 'Place your order',
      classes: ['btn', 'order-btn'],
      attributes: { type: 'submit' },
      nearbyText: 'Email address We will email your receipt. Place your order',
      cssPath: 'body > form:nth-of-type(1) > div:nth-of-type(1) > button:nth-of-type(1)',
    });
    const unrelated = makeFp({ name: 'Sign out', text: 'Sign out', tag: 'a', role: 'link' });

    const resolver = makeTier1Resolver();
    const hit = await resolver.resolve({
      cache: cache({ fingerprint: stored }),
      collected: [unrelated, goodCandidate],
      policy,
      guard: noGuard,
    });
    expect(hit).not.toBeNull();
    expect(hit!.score).toBeGreaterThanOrEqual(0.85);
    expect(hit!.fingerprint.text).toBe('Place your order');

    const miss = await resolver.resolve({
      cache: cache({ fingerprint: stored }),
      collected: [unrelated],
      policy,
      guard: noGuard,
    });
    expect(miss).toBeNull();
  });
});

describe('runHealingPipeline — guard-note propagation (D43)', () => {
  it('carries [capped: …] markers into the refusal reason for the escalation UI', async () => {
    const capped: TierResolver = {
      tier: 2,
      name: 'fake-capped',
      async resolve() {
        return {
          fingerprint: makeFp({ name: 'Place order', text: 'Place order' }),
          score: 0.55,
          secondBest: 0,
          reasoning:
            'LLM: looks right. [capped: model confidence 0.95 contradicts DOM similarity 0.12]',
        };
      },
    };
    const outcome = await runHealingPipeline([capped], {
      cache: cache(),
      collected: [],
      policy,
      guard: noGuard,
    });
    expect(outcome.healed).toBe(false);
    expect(outcome.reason).toContain('below apply floor');
    expect(outcome.reason).toContain(
      '[capped: model confidence 0.95 contradicts DOM similarity 0.12]',
    );
  });
});
