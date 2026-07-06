import type { SentinelStore } from '@sentinel/core';

export interface SummaryOptions {
  /** Exact run id, or… */
  runId?: string;
  /** …prefix matching all shard runs of one CI invocation (e.g. `gh-123-`). */
  runPrefix?: string;
}

export interface SummaryData {
  runIds: string[];
  tests: number;
  passed: number;
  failed: number;
  heals: number;
  autoHeals: number;
  unverifiedHeals: number;
  humanHeals: number;
  pendingEscalations: number;
  llmCalls: number;
  llmCostUsd: number;
  healingUnavailable: boolean;
  status: 'passed' | 'passed_unverified' | 'failed' | 'no-runs';
  markdown: string;
}

/**
 * Aggregated run summary as GitHub-flavored markdown (spec §9: the CI comment
 * shows pass/fail/healed/unverified/escalated counts). With `runPrefix`, the
 * shard runs of one workflow invocation are summarized as a single suite.
 */
export function buildRunSummary(store: SentinelStore, opts: SummaryOptions = {}): SummaryData {
  const db = store.db;
  let runIds: string[];
  if (opts.runId) {
    runIds = [opts.runId];
  } else if (opts.runPrefix) {
    runIds = (
      db
        .prepare('SELECT id FROM runs WHERE id LIKE ? ORDER BY started_at')
        .all(`${opts.runPrefix}%`) as Array<{ id: string }>
    ).map((r) => r.id);
  } else {
    const latest = db.prepare('SELECT id FROM runs ORDER BY started_at DESC LIMIT 1').get() as
      { id: string } | undefined;
    runIds = latest ? [latest.id] : [];
  }

  if (runIds.length === 0) {
    return {
      runIds,
      tests: 0,
      passed: 0,
      failed: 0,
      heals: 0,
      autoHeals: 0,
      unverifiedHeals: 0,
      humanHeals: 0,
      pendingEscalations: 0,
      llmCalls: 0,
      llmCostUsd: 0,
      healingUnavailable: false,
      status: 'no-runs',
      markdown: '## 🛡️ Sentinel\n\nNo runs recorded.\n',
    };
  }

  const ph = runIds.map(() => '?').join(',');
  const one = <T>(sql: string): T => db.prepare(sql).get(...runIds) as T;

  const tests = one<{ n: number }>(`SELECT COUNT(*) n FROM test_results WHERE run_id IN (${ph})`).n;
  const passed = one<{ n: number }>(
    `SELECT COUNT(*) n FROM test_results WHERE run_id IN (${ph}) AND status LIKE 'passed%'`,
  ).n;
  const failed = tests - passed;
  const healRows = db
    .prepare(`SELECT * FROM heals WHERE run_id IN (${ph}) ORDER BY ts`)
    .all(...runIds) as Array<Record<string, unknown>>;
  const count = (mode: string) => healRows.filter((h) => h.mode === mode).length;
  const escalations = db
    .prepare(`SELECT * FROM escalations WHERE run_id IN (${ph}) AND status = 'pending'`)
    .all(...runIds) as Array<Record<string, unknown>>;
  const llm = one<{ n: number; c: number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) c FROM llm_calls WHERE run_id IN (${ph})`,
  );
  const healingUnavailable = (
    db.prepare(`SELECT meta_json FROM runs WHERE id IN (${ph})`).all(...runIds) as Array<{
      meta_json: string | null;
    }>
  ).some((r) => {
    try {
      return JSON.parse(r.meta_json ?? '{}').healingUnavailable === true;
    } catch {
      return false;
    }
  });

  const unverified = count('UNVERIFIED');
  const status: SummaryData['status'] =
    failed > 0 ? 'failed' : unverified > 0 ? 'passed_unverified' : 'passed';

  const lines: string[] = ['## 🛡️ Sentinel run summary', ''];
  if (status === 'failed') {
    lines.push(`**Status: ❌ failed** — ${failed} of ${tests} test(s) failed.`);
  } else if (status === 'passed_unverified') {
    lines.push(
      `**Status: ⚠️ passed with ${unverified} unverified heal(s)** — review required before trusting green.`,
    );
  } else {
    lines.push(`**Status: ✅ passed** — ${passed}/${tests} tests.`);
  }
  if (healingUnavailable) {
    lines.push(
      '',
      '> ⛔ **LLM healing was unavailable** (circuit breaker opened) — this run fell back to deterministic-only healing.',
    );
  }
  lines.push(
    '',
    '| Tests | Passed | Failed | Heals | Auto | Unverified | Human | Escalations |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    `| ${tests} | ${passed} | ${failed} | ${healRows.length} | ${count('AUTO')} | ${unverified} | ${count('HUMAN')} | ${escalations.length} |`,
  );

  if (healRows.length > 0) {
    lines.push(
      '',
      '<details><summary><strong>Heals</strong> (locator drift repaired — spec files untouched)</summary>',
      '',
    );
    for (const h of healRows.slice(0, 15)) {
      lines.push(
        `- \`tier ${h.tier}\` **${h.mode}** (${Number(h.confidence).toFixed(2)}) — ${h.intent}`,
        `  \`${h.old_locator}\` → \`${h.new_locator}\``,
      );
    }
    if (healRows.length > 15)
      lines.push(`- …and ${healRows.length - 15} more (see the HTML report artifact)`);
    lines.push('', '</details>');
  }

  if (escalations.length > 0) {
    lines.push('', `### 🙋 ${escalations.length} question(s) need a human`, '');
    for (const e of escalations) {
      let question: {
        intent?: string;
        question?: string;
        candidates?: Array<{
          label: string;
          confidence: number;
          fingerprint?: { tag?: string; name?: string; text?: string };
        }>;
      } = {};
      try {
        question = JSON.parse(e.question_json as string);
      } catch {
        /* keep empty */
      }
      lines.push(`**#${e.id}** — ${question.intent ?? ''}`, '');
      lines.push(`> ${question.question ?? ''}`, '');
      for (const c of question.candidates ?? []) {
        lines.push(
          `> - **(${c.label})** conf ${Number(c.confidence).toFixed(2)} — \`<${c.fingerprint?.tag}>\` “${c.fingerprint?.name || c.fingerprint?.text || ''}”`,
        );
      }
      lines.push('');
    }
    lines.push(
      `Reply \`/sentinel choose <id> <label>\` to pick a candidate (e.g. \`/sentinel choose ${escalations[0]!.id} A\`), or \`/sentinel choose <id> REDESIGN\` if the change is intentional and the test needs updating.`,
    );
  }

  if (llm.n > 0) {
    lines.push('', `_LLM usage: ${llm.n} call(s), $${llm.c.toFixed(4)}._`);
  }

  return {
    runIds,
    tests,
    passed,
    failed,
    heals: healRows.length,
    autoHeals: count('AUTO'),
    unverifiedHeals: unverified,
    humanHeals: count('HUMAN'),
    pendingEscalations: escalations.length,
    llmCalls: llm.n,
    llmCostUsd: llm.c,
    healingUnavailable,
    status,
    markdown: lines.join('\n') + '\n',
  };
}
