export { buildRunSummary, type SummaryData, type SummaryOptions } from './summary.js';

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha1, type SentinelStore } from '@sentinel/core';

export interface ReportOptions {
  outDir: string;
  /** Most-recent runs to include (default 20). */
  limitRuns?: number;
}

export interface ReportResult {
  indexPath: string;
  runsIncluded: number;
}

interface Row {
  [key: string]: unknown;
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ts(ms: unknown): string {
  return typeof ms === 'number' && ms > 0
    ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
    : '—';
}

const CSS = `
  :root { color-scheme: light; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #f5f6f8; color: #1c2430; }
  header { background: #1d2733; color: #fff; padding: 18px 32px; }
  header h1 { margin: 0; font-size: 20px; }
  header .sub { color: #9fb0c3; font-size: 13px; margin-top: 4px; }
  main { max-width: 1080px; margin: 24px auto; padding: 0 16px 64px; }
  h2 { font-size: 16px; margin: 28px 0 10px; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eef1f4; vertical-align: top; }
  th { background: #f0f3f7; font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  code { background: #eef1f4; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  details { background: #fff; border-radius: 8px; margin: 10px 0; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  summary { cursor: pointer; padding: 12px 16px; font-weight: 600; font-size: 14px; }
  details > div { padding: 4px 16px 16px; }
  .badge { display: inline-block; border-radius: 10px; padding: 1px 9px; font-size: 12px; font-weight: 600; margin-right: 4px; }
  .b-green { background: #dcfce7; color: #166534; }
  .b-amber { background: #fef3c7; color: #92400e; }
  .b-red { background: #fee2e2; color: #991b1b; }
  .b-blue { background: #dbeafe; color: #1e40af; }
  .b-gray { background: #e5e7eb; color: #374151; }
  .heal { border: 1px solid #e5e9ee; border-radius: 8px; padding: 12px 14px; margin: 10px 0; }
  .heal .loc { font-size: 12px; margin: 6px 0; }
  .heal .reason { color: #4a5568; font-size: 12px; margin-top: 6px; }
  .shots { display: flex; gap: 12px; margin-top: 10px; flex-wrap: wrap; }
  .shots figure { margin: 0; }
  .shots img { max-width: 380px; border: 1px solid #d7dde4; border-radius: 6px; display: block; }
  .shots figcaption { font-size: 11px; color: #718096; margin-top: 3px; }
  .arrow { color: #a0aec0; padding: 0 6px; }
`;

function modeBadge(mode: string): string {
  const cls =
    mode === 'AUTO'
      ? 'b-green'
      : mode === 'UNVERIFIED'
        ? 'b-amber'
        : mode === 'HUMAN'
          ? 'b-blue'
          : 'b-gray';
  return `<span class="badge ${cls}">${esc(mode)}</span>`;
}

function statusBadge(status: string): string {
  const cls = /^passed$/.test(status)
    ? 'b-green'
    : /passed_unverified/.test(status)
      ? 'b-amber'
      : /failed/.test(status)
        ? 'b-red'
        : 'b-gray';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

/**
 * Generate a fully static, self-contained HTML report (spec §8): run results,
 * heals with before/after screenshots and locator diffs, flake dashboard, and
 * the LLM cost summary. Screenshots are copied into the report directory so
 * the whole folder is a portable CI artifact.
 */
export function generateReport(store: SentinelStore, opts: ReportOptions): ReportResult {
  const outDir = path.resolve(opts.outDir);
  const assetsDir = path.join(outDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });

  const copyShot = (p: unknown): string | null => {
    if (typeof p !== 'string' || p.length === 0) return null;
    if (!existsSync(p)) return null;
    const name = `${sha1(p).slice(0, 12)}${path.extname(p) || '.jpg'}`;
    const dest = path.join(assetsDir, name);
    if (!existsSync(dest)) {
      try {
        copyFileSync(p, dest);
      } catch {
        return null;
      }
    }
    return `assets/${name}`;
  };

  const q = (sql: string, ...args: unknown[]): Row[] => store.db.prepare(sql).all(...args) as Row[];

  const runs = q('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?', opts.limitRuns ?? 20);

  // ---- Runs overview ---------------------------------------------------------
  const runRows = runs
    .map((r) => {
      const id = r.id as string;
      const tests = q('SELECT COUNT(*) n FROM test_results WHERE run_id = ?', id)[0]!.n as number;
      const passed = q(
        "SELECT COUNT(*) n FROM test_results WHERE run_id = ? AND status LIKE 'passed%'",
        id,
      )[0]!.n as number;
      const heals = q(
        "SELECT COALESCE(mode,'') mode, COUNT(*) n FROM heals WHERE run_id = ? GROUP BY mode",
        id,
      );
      const healSummary = heals.map((h) => `${h.n}× ${String(h.mode)}`).join(', ') || '—';
      const esc2 = q('SELECT COUNT(*) n FROM escalations WHERE run_id = ?', id)[0]!.n as number;
      const cost = q(
        'SELECT COALESCE(SUM(cost_usd),0) c, COUNT(*) n FROM llm_calls WHERE run_id = ?',
        id,
      )[0]!;
      const meta = (() => {
        try {
          return JSON.parse((r.meta_json as string) ?? '{}');
        } catch {
          return {};
        }
      })();
      return `<tr>
        <td><code>${esc(id)}</code>${meta.healingUnavailable ? ' <span class="badge b-red">LLM circuit open</span>' : ''}</td>
        <td>${statusBadge(String(r.status ?? 'in-progress'))}</td>
        <td>${ts(r.started_at)}</td>
        <td>${passed}/${tests}</td>
        <td>${esc(healSummary)}</td>
        <td>${esc2}</td>
        <td>${(cost.n as number) > 0 ? `${cost.n} calls / $${(cost.c as number).toFixed(4)}` : '—'}</td>
      </tr>`;
    })
    .join('\n');

  // ---- Per-run detail ---------------------------------------------------------
  const runDetails = runs
    .map((r) => {
      const id = r.id as string;
      const tests = q('SELECT * FROM test_results WHERE run_id = ?', id);
      const testRows = tests
        .map(
          (t) =>
            `<tr><td>${esc(t.title)}</td><td>${statusBadge(String(t.status))}</td><td>${esc(t.duration_ms)}ms</td><td>${t.flaky_tagged ? '<span class="badge b-amber">@flaky</span>' : ''}</td></tr>`,
        )
        .join('\n');

      const heals = q('SELECT * FROM heals WHERE run_id = ? ORDER BY ts', id);
      const healCards = heals
        .map((h) => {
          const before = copyShot(h.screenshot_before);
          const after = copyShot(h.screenshot_after);
          const shots =
            before || after
              ? `<div class="shots">
                  ${before ? `<figure><img src="${before}" alt="before"><figcaption>before (at failure)</figcaption></figure>` : ''}
                  ${after ? `<figure><img src="${after}" alt="after"><figcaption>after (healed)</figcaption></figure>` : ''}
                </div>`
              : '';
          return `<div class="heal">
            ${modeBadge(String(h.mode))}<span class="badge b-gray">tier ${esc(h.tier)}</span><span class="badge b-gray">conf ${Number(h.confidence).toFixed(2)}</span>
            <strong>${esc(h.intent)}</strong>
            <div class="loc"><code>${esc(h.old_locator)}</code><span class="arrow">→</span><code>${esc(h.new_locator)}</code></div>
            <div class="reason">${esc(h.reasoning)}</div>
            ${shots}
          </div>`;
        })
        .join('\n');

      const escalations = q('SELECT * FROM escalations WHERE run_id = ?', id);
      const escRows = escalations
        .map((e) => {
          const question = (() => {
            try {
              return JSON.parse(e.question_json as string);
            } catch {
              return { question: '(unparseable)' };
            }
          })();
          return `<tr><td>#${esc(e.id)}</td><td>${esc(question.intent ?? '')}</td><td>${esc(question.question ?? '')}</td><td>${e.status === 'pending' ? '<span class="badge b-amber">pending</span>' : `<span class="badge b-blue">answered</span> ${esc(e.answer)} <em>by ${esc(e.answered_by)}</em>`}</td></tr>`;
        })
        .join('\n');

      return `<details>
        <summary><code>${esc(id)}</code> — ${statusBadge(String(r.status ?? 'in-progress'))} ${heals.length} heal(s), ${escalations.length} escalation(s)</summary>
        <div>
          <h2>Tests</h2>
          <table><tr><th>Test</th><th>Status</th><th>Duration</th><th></th></tr>${testRows || '<tr><td colspan="4">none recorded</td></tr>'}</table>
          ${heals.length ? `<h2>Heals</h2>${healCards}` : ''}
          ${escalations.length ? `<h2>Escalations</h2><table><tr><th>#</th><th>Intent</th><th>Question</th><th>Status</th></tr>${escRows}</table>` : ''}
        </div>
      </details>`;
    })
    .join('\n');

  // ---- Flake dashboard ----------------------------------------------------------
  const flakeRows = q(
    `SELECT test_id,
            COUNT(*) total,
            SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) passes,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) fails,
            COUNT(DISTINCT git_sha) shas
     FROM flake_stats GROUP BY test_id ORDER BY fails DESC`,
  )
    .map((f) => {
      const flaky = q(
        `SELECT COUNT(*) n FROM (
           SELECT git_sha FROM flake_stats
           WHERE test_id = ? AND git_sha IS NOT NULL
           GROUP BY git_sha
           HAVING SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) > 0
              AND SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) > 0
         )`,
        f.test_id,
      )[0]!.n as number;
      return `<tr><td>${esc(f.test_id)}</td><td>${esc(f.total)}</td><td>${esc(f.passes)}</td><td>${esc(f.fails)}</td><td>${flaky > 0 ? `<span class="badge b-amber">@flaky (${flaky} SHA${flaky > 1 ? 's' : ''} flip)</span>` : '—'}</td></tr>`;
    })
    .join('\n');

  // ---- LLM cost summary ------------------------------------------------------------
  const llmRows = q(
    `SELECT provider, model, purpose,
            COUNT(*) calls,
            SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) failures,
            SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
            SUM(cost_usd) cost, AVG(latency_ms) avg_latency
     FROM llm_calls GROUP BY provider, model, purpose ORDER BY cost DESC`,
  )
    .map(
      (l) =>
        `<tr><td>${esc(l.provider)}/${esc(l.model)}</td><td>${esc(l.purpose)}</td><td>${esc(l.calls)}${(l.failures as number) > 0 ? ` <span class="badge b-red">${l.failures} failed</span>` : ''}</td><td>${esc(l.input_tokens)} / ${esc(l.output_tokens)}</td><td>$${Number(l.cost).toFixed(4)}</td><td>${Math.round(l.avg_latency as number)}ms</td></tr>`,
    )
    .join('\n');
  const totalCost = q('SELECT COALESCE(SUM(cost_usd),0) c FROM llm_calls')[0]!.c as number;

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sentinel Report</title><style>${CSS}</style></head>
<body>
  <header>
    <h1>Sentinel Report</h1>
    <div class="sub">generated ${new Date().toISOString()} — ${runs.length} run(s)</div>
  </header>
  <main>
    <h2>Runs</h2>
    <table>
      <tr><th>Run</th><th>Status</th><th>Started</th><th>Tests</th><th>Heals</th><th>Escalations</th><th>LLM</th></tr>
      ${runRows || '<tr><td colspan="7">no runs recorded</td></tr>'}
    </table>

    <h2>Run details</h2>
    ${runDetails || '<p>none</p>'}

    <h2>Flake dashboard</h2>
    <table>
      <tr><th>Test</th><th>Runs</th><th>Passes</th><th>Fails</th><th>Verdict</th></tr>
      ${flakeRows || '<tr><td colspan="5">no history</td></tr>'}
    </table>

    <h2>LLM usage &amp; cost <span class="badge b-gray">total $${totalCost.toFixed(4)}</span></h2>
    <table>
      <tr><th>Provider</th><th>Purpose</th><th>Calls</th><th>Tokens in/out</th><th>Cost</th><th>Avg latency</th></tr>
      ${llmRows || '<tr><td colspan="6">no LLM calls recorded</td></tr>'}
    </table>
  </main>
</body>
</html>`;

  const indexPath = path.join(outDir, 'index.html');
  writeFileSync(indexPath, html);
  return { indexPath, runsIncluded: runs.length };
}
