import type Database from 'better-sqlite3';
import { openDatabase } from './db.js';
import type {
  CandidateDescriptor,
  ElementFingerprint,
  EscalationQuestion,
  StepStatus,
} from '../types.js';

export interface CacheEntry {
  testId: string;
  stepId: string;
  primary: CandidateDescriptor;
  alternates: CandidateDescriptor[];
  fingerprint: ElementFingerprint;
  intent: string;
  lastVerifiedAt: number;
}

export interface HealRecord {
  runId: string;
  testId: string;
  stepId: string;
  intent: string;
  oldLocator: string;
  newLocator: string;
  tier: number;
  confidence: number;
  mode: 'AUTO' | 'UNVERIFIED' | 'SUGGESTED' | 'HUMAN';
  reasoning: string;
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  gitSha: string | null;
}

export interface StepRecord {
  runId: string;
  testId: string;
  stepId: string;
  action: string;
  intent: string;
  groupPath: string;
  status: StepStatus;
  tier: number | null;
  confidence: number | null;
  classification: string | null;
  durationMs: number;
  url: string;
}

/** Typed facade over the SQLite database. One instance per worker process. */
export class SentinelStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  // ---- runs ----------------------------------------------------------------

  ensureRun(id: string, gitSha: string | null, healMode: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO runs (id, started_at, git_sha, heal_mode) VALUES (?, ?, ?, ?)',
      )
      .run(id, Date.now(), gitSha, healMode);
  }

  finishRun(id: string, status: string, meta: Record<string, unknown>): void {
    // Merge, don't overwrite — flags like healingUnavailable may already be set.
    const merged = { ...this.getRunMeta(id), ...meta };
    this.db
      .prepare('UPDATE runs SET finished_at = ?, status = ?, meta_json = ? WHERE id = ?')
      .run(Date.now(), status, JSON.stringify(merged), id);
  }

  getRunMeta(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT meta_json FROM runs WHERE id = ?').get(id) as
      { meta_json: string | null } | undefined;
    if (!row?.meta_json) return {};
    try {
      return JSON.parse(row.meta_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Merge one flag into runs.meta_json (e.g. healingUnavailable after the
   * LLM circuit breaker opens — spec §2). */
  setRunMetaFlag(id: string, key: string, value: unknown): void {
    const meta = this.getRunMeta(id);
    meta[key] = value;
    this.db.prepare('UPDATE runs SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), id);
  }

  // ---- test results / steps -------------------------------------------------

  recordTestResult(r: {
    runId: string;
    testId: string;
    title: string;
    file: string;
    status: string;
    durationMs: number;
    error: string | null;
    flakyTagged: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO test_results (run_id, test_id, title, file, status, duration_ms, error, flaky_tagged)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.runId,
        r.testId,
        r.title,
        r.file,
        r.status,
        r.durationMs,
        r.error,
        r.flakyTagged ? 1 : 0,
      );
  }

  recordStep(s: StepRecord): void {
    this.db
      .prepare(
        `INSERT INTO steps (run_id, test_id, step_id, action, intent, group_path, status, tier, confidence, classification, duration_ms, url, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.runId,
        s.testId,
        s.stepId,
        s.action,
        s.intent,
        s.groupPath,
        s.status,
        s.tier,
        s.confidence,
        s.classification,
        s.durationMs,
        s.url,
        Date.now(),
      );
  }

  // ---- locator cache ---------------------------------------------------------

  getCacheEntry(testId: string, stepId: string): CacheEntry | null {
    const row = this.db
      .prepare('SELECT * FROM locator_cache WHERE test_id = ? AND step_id = ?')
      .get(testId, stepId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      testId,
      stepId,
      primary: JSON.parse(row.primary_json as string),
      alternates: JSON.parse(row.alternates_json as string),
      fingerprint: JSON.parse(row.fingerprint_json as string),
      intent: row.intent as string,
      lastVerifiedAt: row.last_verified_at as number,
    };
  }

  upsertCacheEntry(e: CacheEntry): void {
    this.db
      .prepare(
        `INSERT INTO locator_cache (test_id, step_id, primary_json, alternates_json, fingerprint_json, intent, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (test_id, step_id) DO UPDATE SET
           primary_json = excluded.primary_json,
           alternates_json = excluded.alternates_json,
           fingerprint_json = excluded.fingerprint_json,
           intent = excluded.intent,
           last_verified_at = excluded.last_verified_at`,
      )
      .run(
        e.testId,
        e.stepId,
        JSON.stringify(e.primary),
        JSON.stringify(e.alternates),
        JSON.stringify(e.fingerprint),
        e.intent,
        e.lastVerifiedAt,
      );
  }

  // ---- heals -------------------------------------------------------------------

  recordHeal(h: HealRecord): void {
    this.db
      .prepare(
        `INSERT INTO heals (run_id, test_id, step_id, intent, old_locator, new_locator, tier, confidence, mode, reasoning, screenshot_before, screenshot_after, git_sha, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        h.runId,
        h.testId,
        h.stepId,
        h.intent,
        h.oldLocator,
        h.newLocator,
        h.tier,
        h.confidence,
        h.mode,
        h.reasoning,
        h.screenshotBefore,
        h.screenshotAfter,
        h.gitSha,
        Date.now(),
      );
  }

  healCountForRun(runId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM heals WHERE run_id = ?').get(runId) as {
      n: number;
    };
    return row.n;
  }

  /** Distinct steps with reviewed-but-unpromoted heals — the Studio "ready to
   * promote" badge. Cheap DB count only; the file-reading planPromotions stays
   * the authority on what is actually promotable. */
  countUnpromotedHeals(opts: { includeUnverified?: boolean } = {}): number {
    const modes = opts.includeUnverified ? ['AUTO', 'HUMAN', 'UNVERIFIED'] : ['AUTO', 'HUMAN'];
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT DISTINCT test_id, step_id FROM heals
           WHERE mode IN (${modes.map(() => '?').join(',')}) AND promoted = 0
         )`,
      )
      .get(...modes) as { n: number };
    return row.n;
  }

  healCountForTest(runId: string, testId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM heals WHERE run_id = ? AND test_id = ?')
      .get(runId, testId) as { n: number };
    return row.n;
  }

  // ---- escalations ----------------------------------------------------------------

  recordEscalation(e: {
    runId: string;
    testId: string;
    stepId: string;
    question: EscalationQuestion;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO escalations (run_id, test_id, step_id, question_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(e.runId, e.testId, e.stepId, JSON.stringify(e.question), Date.now());
    return Number(info.lastInsertRowid);
  }

  pendingEscalations(): Array<{
    id: number;
    runId: string;
    testId: string;
    stepId: string;
    question: EscalationQuestion;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM escalations WHERE status = 'pending' ORDER BY created_at")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      testId: r.test_id as string,
      stepId: r.step_id as string,
      question: JSON.parse(r.question_json as string),
    }));
  }

  getEscalationById(id: number): {
    id: number;
    runId: string;
    testId: string;
    stepId: string;
    status: string;
    question: EscalationQuestion;
  } | null {
    const row = this.db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      runId: row.run_id as string,
      testId: row.test_id as string,
      stepId: row.step_id as string,
      status: row.status as string,
      question: JSON.parse(row.question_json as string),
    };
  }

  answerEscalation(id: number, answer: string, answeredBy: string, channel: string): void {
    this.db
      .prepare(
        `UPDATE escalations SET status = 'answered', answer = ?, answered_by = ?, channel = ?, answered_at = ? WHERE id = ?`,
      )
      .run(answer, answeredBy, channel, Date.now(), id);
  }

  /** Answered escalations for a step — few-shot context for future heals (§6). */
  answeredEscalationsForStep(
    testId: string,
    stepId: string,
  ): Array<{
    question: EscalationQuestion;
    answer: string;
  }> {
    const rows = this.db
      .prepare(
        "SELECT question_json, answer FROM escalations WHERE test_id = ? AND step_id = ? AND status = 'answered' ORDER BY answered_at DESC LIMIT 5",
      )
      .all(testId, stepId) as Array<{ question_json: string; answer: string }>;
    return rows.map((r) => ({ question: JSON.parse(r.question_json), answer: r.answer }));
  }

  // ---- step re-keying (Phase 2 stepKey migration — D38) ----------------------

  /**
   * Re-point a step's history from one step id to another, atomically. Used when a
   * hand-authored spec is imported into a flow and its steps are assigned stable
   * stepKeys: the locator cache, heals, escalations and step rows follow the logical
   * step to its new key instead of resetting to a cold start. Returns the number of
   * rows moved across all tables.
   */
  rekeyStep(testId: string, oldStepId: string, newStepId: string): number {
    if (oldStepId === newStepId) return 0;
    const move = this.db.transaction((): number => {
      let moved = 0;
      // locator_cache PK is (test_id, step_id): REPLACE so an existing new-key row
      // yields to the migrated history rather than raising a constraint error.
      moved += this.db
        .prepare(
          'UPDATE OR REPLACE locator_cache SET step_id = ? WHERE test_id = ? AND step_id = ?',
        )
        .run(newStepId, testId, oldStepId).changes;
      for (const table of ['heals', 'escalations', 'steps']) {
        moved += this.db
          .prepare(`UPDATE ${table} SET step_id = ? WHERE test_id = ? AND step_id = ?`)
          .run(newStepId, testId, oldStepId).changes;
      }
      return moved;
    });
    return move();
  }

  /**
   * Re-point an entire test's history to a new test id, atomically. Used when the
   * flow importer moves a test into a generated spec file: the file path is part
   * of makeTestId, so without this every table would orphan on import (D39).
   * Returns the number of rows moved.
   */
  rekeyTest(oldTestId: string, newTestId: string): number {
    if (oldTestId === newTestId) return 0;
    const move = this.db.transaction((): number => {
      let moved = 0;
      moved += this.db
        .prepare('UPDATE OR REPLACE locator_cache SET test_id = ? WHERE test_id = ?')
        .run(newTestId, oldTestId).changes;
      for (const table of ['heals', 'escalations', 'steps', 'test_results', 'flake_stats']) {
        moved += this.db
          .prepare(`UPDATE ${table} SET test_id = ? WHERE test_id = ?`)
          .run(newTestId, oldTestId).changes;
      }
      return moved;
    });
    return move();
  }

  // ---- flake stats -------------------------------------------------------------------

  recordFlakeStat(testId: string, gitSha: string | null, runId: string, status: string): void {
    this.db
      .prepare(
        'INSERT INTO flake_stats (test_id, git_sha, run_id, status, ts) VALUES (?, ?, ?, ?, ?)',
      )
      .run(testId, gitSha, runId, status, Date.now());
  }

  /** A test that both passed and failed on the same git SHA is statistically flaky:
   * the code did not change, the outcome did. */
  isKnownFlaky(testId: string, gitSha: string | null): boolean {
    if (!gitSha) return false;
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passes,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS fails
         FROM flake_stats WHERE test_id = ? AND git_sha = ?`,
      )
      .get(testId, gitSha) as { passes: number | null; fails: number | null };
    return (row.passes ?? 0) > 0 && (row.fails ?? 0) > 0;
  }

  // ---- llm accounting (consumed from Phase 2 on) --------------------------------------

  recordLlmCall(c: {
    runId: string;
    provider: string;
    model: string;
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    ok: boolean;
    error: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (run_id, provider, model, purpose, input_tokens, output_tokens, cost_usd, latency_ms, ok, error, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.runId,
        c.provider,
        c.model,
        c.purpose,
        c.inputTokens,
        c.outputTokens,
        c.costUsd,
        c.latencyMs,
        c.ok ? 1 : 0,
        c.error,
        Date.now(),
      );
  }

  llmSpendForRun(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM llm_calls WHERE run_id = ?')
      .get(runId) as { spend: number };
    return row.spend;
  }
}
