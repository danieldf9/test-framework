/**
 * @sentinel/ops — shared operations used by both the CLI and the Studio server.
 * The CLI (`packages/cli`) and the server (`packages/server`) call these same
 * functions so their behavior never forks.
 */
export {
  buildLocatorPattern,
  planPromotions,
  applyPromotions,
  type PromotionPlan,
  type ApplyResult,
} from './promote.js';
export { quoteForShell } from './shell.js';
export {
  gitShaOrNull,
  startRun,
  waitForExit,
  summarizeRun,
  finalizeRun,
  type RunSummary,
  type StartRunOptions,
  type StartedRun,
} from './run.js';
export { previewPromotions, type PromotePreview } from './gitPr.js';
