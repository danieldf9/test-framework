import type { EscalationQuestion, SentinelStore } from '@sentinel/core';

/**
 * Pure query functions over the Sentinel state DB. These are the single source
 * of the run/flake/LLM-cost aggregations: the static HTML report
 * (`generateReport`) and the Studio server (`@sentinel/server`) both consume
 * them, so the two views never drift from divergent SQL.
 */

interface Row {
  [key: string]: unknown;
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface HealModeCount {
  mode: string;
  count: number;
}

export interface RunOverview {
  id: string;
  status: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  gitSha: string | null;
  tests: number;
  passed: number;
  heals: HealModeCount[];
  escalations: number;
  llmCalls: number;
  llmCostUsd: number;
  healingUnavailable: boolean;
}

export interface TestResultRow {
  id: number;
  testId: string;
  title: string;
  file: string;
  status: string;
  durationMs: number;
  error: string | null;
  flakyTagged: boolean;
}

export interface HealRow {
  id: number;
  testId: string;
  stepId: string;
  intent: string;
  oldLocator: string;
  newLocator: string;
  tier: number;
  confidence: number;
  mode: string;
  reasoning: string;
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  promoted: boolean;
  ts: number;
}

export interface EscalationRow {
  id: number;
  testId: string;
  stepId: string;
  status: string;
  answer: string | null;
  answeredBy: string | null;
  question: EscalationQuestion | null;
}

export interface RunDetail {
  tests: TestResultRow[];
  heals: HealRow[];
  escalations: EscalationRow[];
}

export interface FlakeStat {
  testId: string;
  total: number;
  passes: number;
  fails: number;
  shas: number;
  /** Number of distinct SHAs that both passed and failed (true flake flips). */
  flakyShaFlips: number;
}

export interface LlmCostRow {
  provider: string;
  model: string;
  purpose: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

export interface LlmCosts {
  rows: LlmCostRow[];
  totalCostUsd: number;
}

const all = (store: SentinelStore, sql: string, ...args: unknown[]): Row[] =>
  store.db.prepare(sql).all(...args) as Row[];

/** Most-recent runs with their per-run counts (heals grouped by mode, cost, etc.). */
export function queryRunsOverview(store: SentinelStore, limit = 20): RunOverview[] {
  const runs = all(store, 'SELECT * FROM runs ORDER BY started_at DESC LIMIT ?', limit);
  return runs.map((r): RunOverview => {
    const id = r.id as string;
    const tests = all(store, 'SELECT COUNT(*) n FROM test_results WHERE run_id = ?', id)[0]!
      .n as number;
    const passed = all(
      store,
      "SELECT COUNT(*) n FROM test_results WHERE run_id = ? AND status LIKE 'passed%'",
      id,
    )[0]!.n as number;
    const heals = all(
      store,
      "SELECT COALESCE(mode,'') mode, COUNT(*) n FROM heals WHERE run_id = ? GROUP BY mode",
      id,
    ).map((h) => ({ mode: String(h.mode), count: h.n as number }));
    const escalations = all(store, 'SELECT COUNT(*) n FROM escalations WHERE run_id = ?', id)[0]!
      .n as number;
    const cost = all(
      store,
      'SELECT COALESCE(SUM(cost_usd),0) c, COUNT(*) n FROM llm_calls WHERE run_id = ?',
      id,
    )[0]!;
    const meta = safeJson<{ healingUnavailable?: boolean }>(r.meta_json, {});
    return {
      id,
      status: (r.status as string | null) ?? null,
      startedAt: (r.started_at as number | null) ?? null,
      finishedAt: (r.finished_at as number | null) ?? null,
      gitSha: (r.git_sha as string | null) ?? null,
      tests,
      passed,
      heals,
      escalations,
      llmCalls: cost.n as number,
      llmCostUsd: cost.c as number,
      healingUnavailable: meta.healingUnavailable === true,
    };
  });
}

/** Tests, heals (ordered by ts) and escalations for a single run. */
export function queryRunDetail(store: SentinelStore, runId: string): RunDetail {
  const tests = all(store, 'SELECT * FROM test_results WHERE run_id = ?', runId).map(
    (t): TestResultRow => ({
      id: t.id as number,
      testId: t.test_id as string,
      title: t.title as string,
      file: t.file as string,
      status: t.status as string,
      durationMs: t.duration_ms as number,
      error: (t.error as string | null) ?? null,
      flakyTagged: Boolean(t.flaky_tagged),
    }),
  );
  const heals = all(store, 'SELECT * FROM heals WHERE run_id = ? ORDER BY ts', runId).map(
    (h): HealRow => ({
      id: h.id as number,
      testId: h.test_id as string,
      stepId: h.step_id as string,
      intent: (h.intent as string) ?? '',
      oldLocator: h.old_locator as string,
      newLocator: h.new_locator as string,
      tier: h.tier as number,
      confidence: h.confidence as number,
      mode: h.mode as string,
      reasoning: (h.reasoning as string) ?? '',
      screenshotBefore: (h.screenshot_before as string | null) ?? null,
      screenshotAfter: (h.screenshot_after as string | null) ?? null,
      promoted: Boolean(h.promoted),
      ts: h.ts as number,
    }),
  );
  const escalations = all(store, 'SELECT * FROM escalations WHERE run_id = ?', runId).map(
    (e): EscalationRow => ({
      id: e.id as number,
      testId: e.test_id as string,
      stepId: e.step_id as string,
      status: e.status as string,
      answer: (e.answer as string | null) ?? null,
      answeredBy: (e.answered_by as string | null) ?? null,
      question: safeJson<EscalationQuestion | null>(e.question_json, null),
    }),
  );
  return { tests, heals, escalations };
}

/** Per-test flake aggregation across all recorded runs. */
export function queryFlakeStats(store: SentinelStore): FlakeStat[] {
  const rows = all(
    store,
    `SELECT test_id,
            COUNT(*) total,
            SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) passes,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) fails,
            COUNT(DISTINCT git_sha) shas
     FROM flake_stats GROUP BY test_id ORDER BY fails DESC`,
  );
  return rows.map((f): FlakeStat => {
    const flakyShaFlips = all(
      store,
      `SELECT COUNT(*) n FROM (
         SELECT git_sha FROM flake_stats
         WHERE test_id = ? AND git_sha IS NOT NULL
         GROUP BY git_sha
         HAVING SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) > 0
            AND SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) > 0
       )`,
      f.test_id,
    )[0]!.n as number;
    return {
      testId: f.test_id as string,
      total: f.total as number,
      passes: f.passes as number,
      fails: f.fails as number,
      shas: f.shas as number,
      flakyShaFlips,
    };
  });
}

/** LLM spend grouped by provider/model/purpose, plus the grand total. */
export function queryLlmCosts(store: SentinelStore): LlmCosts {
  const rows = all(
    store,
    `SELECT provider, model, purpose,
            COUNT(*) calls,
            SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) failures,
            SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
            SUM(cost_usd) cost, AVG(latency_ms) avg_latency
     FROM llm_calls GROUP BY provider, model, purpose ORDER BY cost DESC`,
  ).map(
    (l): LlmCostRow => ({
      provider: l.provider as string,
      model: l.model as string,
      purpose: l.purpose as string,
      calls: l.calls as number,
      failures: l.failures as number,
      inputTokens: l.input_tokens as number,
      outputTokens: l.output_tokens as number,
      costUsd: l.cost as number,
      avgLatencyMs: l.avg_latency as number,
    }),
  );
  const totalCostUsd = all(store, 'SELECT COALESCE(SUM(cost_usd),0) c FROM llm_calls')[0]!
    .c as number;
  return { rows, totalCostUsd };
}
