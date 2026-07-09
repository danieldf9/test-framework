import type { Page } from '@playwright/test';
import { buildLocator, describeDescriptor, descriptorsFromFingerprint } from './descriptors.js';
import { sentinelDomAgent, type DomAgentOptions } from './domAgent.js';
import { assertionTextSimilarity, fingerprintSimilarity } from './similarity.js';
import type { CacheEntry } from './storage/store.js';
import type { ElementFingerprint, HealOutcome } from './types.js';

export interface HealPolicy {
  tier1Threshold: number;
  tier0VerifyThreshold: number;
  autoApplyThreshold: number;
  applyFloor: number;
  ambiguityMargin: number;
}

export interface AssertionGuard {
  isAssertion: boolean;
  minTextSimilarity: number;
}

export interface HealContext {
  cache: CacheEntry;
  /** Visible elements collected from the live DOM at failure time. */
  collected: ElementFingerprint[];
  policy: HealPolicy;
  guard: AssertionGuard;
  /** Sanitized failure screenshot for vision tiers (masked at capture). */
  screenshot?: { base64: string; mediaType: string } | null;
  /** Answers produced by earlier tiers (accepted or rejected) — lets Tier 3
   * cross-check the vision answer against the DOM answer (spec §4). */
  priorResults?: Array<{ tier: number; fingerprint: ElementFingerprint; score: number }>;
}

/** A candidate match produced by one tier. */
export interface TierResult {
  fingerprint: ElementFingerprint;
  score: number;
  /** Best score among OTHER elements considered by this tier (ambiguity signal). */
  secondBest: number;
  reasoning: string;
}

export interface TierResolver {
  tier: 0 | 1 | 2 | 3;
  name: string;
  resolve(ctx: HealContext): Promise<TierResult | null>;
}

/** Errors that must abort the run loudly instead of degrading to "no heal"
 * (e.g. the LLM spend cap — spec §10 hard caps fail loudly). */
export class FatalHealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalHealError';
  }
}

/**
 * Tier 0 — deterministic fallbacks. Replays cached descriptors (primary first,
 * then ranked alternates from previous heals/captures). Every hit is verified
 * against the stored fingerprint before being trusted; multiple matches are
 * disambiguated by fingerprint similarity (nearby text separates sibling widgets).
 */
export function makeTier0Resolver(
  page: Page,
  agentOpts: Pick<DomAgentOptions, 'testIdAttribute'>,
): TierResolver {
  return {
    tier: 0,
    name: 'cached-descriptors',
    async resolve(ctx) {
      const descriptors = [ctx.cache.primary, ...ctx.cache.alternates];
      for (const descriptor of descriptors) {
        let handles;
        try {
          handles = await buildLocator(page, descriptor).elementHandles();
        } catch {
          continue; // descriptor no longer parseable against this page
        }
        let best: { fp: ElementFingerprint; score: number } | null = null;
        let secondBest = 0;
        for (const handle of handles.slice(0, 5)) {
          try {
            if (!(await handle.isVisible())) continue;
            const fingerprintOpts: DomAgentOptions = {
              cmd: 'fingerprint',
              testIdAttribute: agentOpts.testIdAttribute,
            };
            const fp = (await handle.evaluate(
              sentinelDomAgent,
              fingerprintOpts,
            )) as ElementFingerprint;
            const { score } = fingerprintSimilarity(ctx.cache.fingerprint, fp);
            if (!best || score > best.score) {
              if (best) secondBest = Math.max(secondBest, best.score);
              best = { fp, score };
            } else {
              secondBest = Math.max(secondBest, score);
            }
          } catch {
            // element detached mid-inspection — skip it
          }
        }
        await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
        if (best && best.score >= ctx.policy.tier0VerifyThreshold) {
          return {
            fingerprint: best.fp,
            score: best.score,
            secondBest,
            reasoning: `Cached fallback ${describeDescriptor(descriptor)} matched an element whose fingerprint scores ${best.score.toFixed(2)} against the last-known fingerprint.`,
          };
        }
      }
      return null;
    },
  };
}

/**
 * Tier 1 — heuristic re-resolution: fuzzy fingerprint match of the failed
 * element's last-known identity against every candidate in the live DOM.
 * Accepts only above the configured similarity threshold (spec default 0.85).
 */
export function makeTier1Resolver(): TierResolver {
  return {
    tier: 1,
    name: 'fingerprint-fuzzy-match',
    async resolve(ctx) {
      const scored = ctx.collected
        .map((fp) => ({ fp, score: fingerprintSimilarity(ctx.cache.fingerprint, fp).score }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best || best.score < ctx.policy.tier1Threshold) return null;
      const runnerUp = scored.find((s) => s.fp.cssPath !== best.fp.cssPath);
      return {
        fingerprint: best.fp,
        score: best.score,
        secondBest: runnerUp?.score ?? 0,
        reasoning: `Fuzzy DOM search: best candidate <${best.fp.tag}> "${best.fp.name || best.fp.text}" scored ${best.score.toFixed(2)} (runner-up ${(runnerUp?.score ?? 0).toFixed(2)}).`,
      };
    },
  };
}

/**
 * The tiered pipeline (spec §4): run resolvers in order, stop at the first
 * result that survives the ambiguity and assertion guards and clears the apply
 * floor. Tiers 2-3 (LLM DOM / vision) plug into the same resolver interface.
 */
export async function runHealingPipeline(
  resolvers: TierResolver[],
  ctx: HealContext,
): Promise<HealOutcome> {
  const refusals: string[] = [];
  const rejected: HealOutcome['rejected'] = [];

  for (const resolver of resolvers) {
    let result: TierResult | null;
    try {
      result = await resolver.resolve(ctx);
    } catch (err) {
      if (err instanceof FatalHealError) throw err;
      refusals.push(
        `tier ${resolver.tier} (${resolver.name}): error — ${String((err as Error).message).slice(0, 200)}`,
      );
      continue;
    }
    if (!result) {
      refusals.push(`tier ${resolver.tier} (${resolver.name}): no acceptable match`);
      continue;
    }
    (ctx.priorResults ??= []).push({
      tier: resolver.tier,
      fingerprint: result.fingerprint,
      score: result.score,
    });

    let confidence = result.score;
    let reasoning = result.reasoning;

    // Ambiguity guard: two near-identical candidates means we would be guessing.
    if (result.secondBest > 0 && result.score - result.secondBest < ctx.policy.ambiguityMargin) {
      confidence = Math.min(confidence, ctx.policy.applyFloor - 0.05);
      reasoning += ` Ambiguous: runner-up within ${ctx.policy.ambiguityMargin} — confidence capped.`;
    }

    // Golden rule (spec §5): a heal must never convert a failing assertion into
    // a passing one. Assertion targets must still carry the asserted content.
    if (ctx.guard.isAssertion) {
      const textSim = assertionTextSimilarity(ctx.cache.fingerprint, result.fingerprint);
      if (textSim < ctx.guard.minTextSimilarity) {
        refusals.push(
          `tier ${resolver.tier}: match refused by assertion guard (text similarity ${textSim.toFixed(2)} < ${ctx.guard.minTextSimilarity}) — healing this would rewrite what the test asserts`,
        );
        rejected.push({ fingerprint: result.fingerprint, score: result.score });
        continue;
      }
    }

    if (confidence >= ctx.policy.applyFloor) {
      return {
        healed: true,
        match: {
          fingerprint: result.fingerprint,
          actionDescriptor: { kind: 'css', value: result.fingerprint.cssPath },
          newDescriptors: descriptorsFromFingerprint(result.fingerprint),
          confidence,
          tier: resolver.tier,
          reasoning,
        },
        reason: '',
        rejected,
      };
    }

    // Keep any guard marker (e.g. "[capped: …]") in the refusal: it flows into
    // the escalation question, where the UI explains WHY confidence was lowered.
    const guardNote = reasoning.match(/\[[^\]]*\]/g)?.join(' ');
    refusals.push(
      `tier ${resolver.tier}: confidence ${confidence.toFixed(2)} below apply floor ${ctx.policy.applyFloor}${guardNote ? ` ${guardNote}` : ''}`,
    );
    rejected.push({ fingerprint: result.fingerprint, score: result.score });
  }

  // Surface the best near-misses so the escalation question has candidates.
  const nearMisses = ctx.collected
    .map((fp) => ({
      fingerprint: fp,
      score: fingerprintSimilarity(ctx.cache.fingerprint, fp).score,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  for (const miss of nearMisses) {
    if (!rejected.some((r) => r.fingerprint.cssPath === miss.fingerprint.cssPath)) {
      rejected.push(miss);
    }
  }

  return {
    healed: false,
    match: null,
    reason: refusals.join('; ') || 'no tier produced a candidate',
    rejected: rejected.slice(0, 4),
  };
}
