import type { SentinelStore } from '@sentinel/core';
import { applyPromotions, planPromotions, type PromotionPlan } from './promote.js';

export interface PromotePreview {
  plans: PromotionPlan[];
  /** Human-readable diff lines (from a write:false apply — no files touched). */
  diff: string[];
}

/**
 * Preview promotions without touching files or the DB: plan the reviewed heals,
 * then run a dry (`write:false`) apply to produce the diff. Safe to call from the
 * server for the "review before Open PR" screen.
 */
export function previewPromotions(
  store: SentinelStore,
  rootDir: string,
  opts: { includeUnverified?: boolean } = {},
): PromotePreview {
  const plans = planPromotions(store, rootDir, opts);
  const { diff } = applyPromotions(store, plans, { write: false });
  return { plans, diff };
}

// promoteAndOpenPr (applyPromotions write → git branch/commit/push → Octokit PR)
// is implemented in M6, reusing planPromotions/applyPromotions above.
