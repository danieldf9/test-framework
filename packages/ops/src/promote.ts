import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describeDescriptor, type SentinelStore } from '@sentinel/core';

export interface PromotionPlan {
  /** Repo-relative spec file (from the testId). */
  file: string;
  absFile: string;
  oldCode: string;
  newCode: string;
  healIds: number[];
  testIds: string[];
  occurrences: number;
  status: 'ready' | 'conflict' | 'not-found' | 'missing-file';
  note: string;
}

/**
 * Whitespace/quote-tolerant matcher for a recorded locator code string.
 * `getByLabel('Email', { exact: true })` must match the authored
 * `getByLabel("Email", {exact: true})`.
 */
export function buildLocatorPattern(code: string): RegExp {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = escaped.replace(/\s+/g, '\\s*').replace(/['"]/g, `['"]`);
  return new RegExp(flexible, 'g');
}

/**
 * Plan which reviewed heals get written back into spec files (spec §4/§8):
 * per (testId, stepId) the LATEST heal supplies the broken original locator;
 * the replacement comes from the locator cache primary — the cache is the
 * source of truth, the heal row is its audit trail.
 *
 * Safety guards (D36):
 * - same file + same old locator healing to DIFFERENT targets → conflict, skip
 * - same file + DIFFERENT old locators healing to the SAME target → the
 *   promoted locator would be ambiguous on the page (e.g. three product cards
 *   all resolving to `getByRole('button', { name: 'Add to bag' })`) → skip
 * - assertions keep their expected values — only the locator expression moves.
 */
export function planPromotions(
  store: SentinelStore,
  rootDir: string,
  opts: { includeUnverified?: boolean } = {},
): PromotionPlan[] {
  const modes = opts.includeUnverified ? ['AUTO', 'HUMAN', 'UNVERIFIED'] : ['AUTO', 'HUMAN'];
  const rows = store.db
    .prepare(
      `SELECT h.* FROM heals h
       JOIN (
         SELECT test_id, step_id, MAX(ts) AS mts FROM heals
         WHERE mode IN (${modes.map(() => '?').join(',')}) AND promoted = 0
         GROUP BY test_id, step_id
       ) latest
       ON h.test_id = latest.test_id AND h.step_id = latest.step_id AND h.ts = latest.mts
       WHERE h.mode IN (${modes.map(() => '?').join(',')}) AND h.promoted = 0`,
    )
    .all(...modes, ...modes) as Array<Record<string, unknown>>;

  // One plan per (file, oldCode → newCode); collect contributing heals.
  const plans = new Map<string, PromotionPlan>();
  for (const h of rows) {
    const testId = h.test_id as string;
    const file = testId.split('::')[0]!;
    const cache = store.getCacheEntry(testId, h.step_id as string);
    const newCode = cache ? describeDescriptor(cache.primary) : (h.new_locator as string);
    const oldCode = h.old_locator as string;
    if (!oldCode || oldCode === newCode) continue;
    const key = `${file} ${oldCode} ${newCode}`;
    const plan = plans.get(key) ?? {
      file,
      absFile: path.resolve(rootDir, file),
      oldCode,
      newCode,
      healIds: [],
      testIds: [],
      occurrences: 0,
      status: 'ready' as const,
      note: '',
    };
    plan.healIds.push(h.id as number);
    if (!plan.testIds.includes(testId)) plan.testIds.push(testId);
    plans.set(key, plan);
  }
  const list = [...plans.values()];

  // Guard: contradictory or ambiguity-creating promotions are skipped.
  for (const plan of list) {
    const sameOld = list.filter((p) => p.file === plan.file && p.oldCode === plan.oldCode);
    if (new Set(sameOld.map((p) => p.newCode)).size > 1) {
      plan.status = 'conflict';
      plan.note = 'the same original locator healed to different targets — review manually';
      continue;
    }
    const sameNew = list.filter((p) => p.file === plan.file && p.newCode === plan.newCode);
    if (new Set(sameNew.map((p) => p.oldCode)).size > 1) {
      plan.status = 'conflict';
      plan.note =
        'multiple distinct locators healed to the same target — promoting would make it ambiguous on the page (add a test id instead)';
    }
  }

  for (const plan of list) {
    if (plan.status !== 'ready') continue;
    if (!existsSync(plan.absFile)) {
      plan.status = 'missing-file';
      plan.note = `spec file not found under ${rootDir}`;
      continue;
    }
    const content = readFileSync(plan.absFile, 'utf8');
    const matches = content.match(buildLocatorPattern(plan.oldCode));
    plan.occurrences = matches?.length ?? 0;
    if (plan.occurrences === 0) {
      plan.status = 'not-found';
      plan.note = 'original locator not found in the spec source (already promoted or refactored?)';
    }
  }
  return list;
}

export interface ApplyResult {
  applied: number;
  filesChanged: string[];
  diff: string[];
}

/** Apply ready plans to the working tree and mark their heals promoted. */
export function applyPromotions(
  store: SentinelStore,
  plans: PromotionPlan[],
  opts: { write: boolean },
): ApplyResult {
  const diff: string[] = [];
  const filesChanged = new Set<string>();
  let applied = 0;
  const byFile = new Map<string, PromotionPlan[]>();
  for (const plan of plans) {
    if (plan.status !== 'ready') continue;
    byFile.set(plan.absFile, [...(byFile.get(plan.absFile) ?? []), plan]);
  }

  for (const [absFile, filePlans] of byFile) {
    let content = readFileSync(absFile, 'utf8');
    for (const plan of filePlans) {
      const pattern = buildLocatorPattern(plan.oldCode);
      const before = content;
      content = content.replace(pattern, plan.newCode);
      if (content !== before) {
        diff.push(
          `${plan.file}: ${plan.occurrences} occurrence(s)`,
          `  - ${plan.oldCode}`,
          `  + ${plan.newCode}`,
        );
        applied++;
        filesChanged.add(absFile);
        if (opts.write) {
          const mark = store.db.prepare('UPDATE heals SET promoted = 1 WHERE id = ?');
          for (const id of plan.healIds) mark.run(id);
        }
      }
    }
    if (opts.write && filesChanged.has(absFile)) writeFileSync(absFile, content);
  }
  return { applied, filesChanged: [...filesChanged], diff };
}
