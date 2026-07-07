export { buildRunSummary, type SummaryData, type SummaryOptions } from './summary.js';
export * from './queries.js';

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha1, type SentinelStore } from '@sentinel/core';
import {
  queryFlakeStats,
  queryLlmCosts,
  queryRunDetail,
  queryRunsOverview,
} from './queries.js';

export interface ReportOptions {
  outDir: string;
  /** Most-recent runs to include (default 20). */
  limitRuns?: number;
}

export interface ReportResult {
  indexPath: string;
  runsIncluded: number;
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

  const overviews = queryRunsOverview(store, opts.limitRuns ?? 20);

  // ---- Runs overview ---------------------------------------------------------
  const runRows = overviews
    .map((o) => {
      const healSummary = o.heals.map((h) => `${h.count}× ${h.mode}`).join(', ') || '—';
      return `<tr>
        <td><code>${esc(o.id)}</code>${o.healingUnavailable ? ' <span class="badge b-red">LLM circuit open</span>' : ''}</td>
        <td>${statusBadge(String(o.status ?? 'in-progress'))}</td>
        <td>${ts(o.startedAt)}</td>
        <td>${o.passed}/${o.tests}</td>
        <td>${esc(healSummary)}</td>
        <td>${o.escalations}</td>
        <td>${o.llmCalls > 0 ? `${o.llmCalls} calls / $${o.llmCostUsd.toFixed(4)}` : '—'}</td>
      </tr>`;
    })
    .join('\n');

  // ---- Per-run detail ---------------------------------------------------------
  const runDetails = overviews
    .map((o) => {
      const detail = queryRunDetail(store, o.id);
      const testRows = detail.tests
        .map(
          (t) =>
            `<tr><td>${esc(t.title)}</td><td>${statusBadge(String(t.status))}</td><td>${esc(t.durationMs)}ms</td><td>${t.flakyTagged ? '<span class="badge b-amber">@flaky</span>' : ''}</td></tr>`,
        )
        .join('\n');

      const healCards = detail.heals
        .map((h) => {
          const before = copyShot(h.screenshotBefore);
          const after = copyShot(h.screenshotAfter);
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
            <div class="loc"><code>${esc(h.oldLocator)}</code><span class="arrow">→</span><code>${esc(h.newLocator)}</code></div>
            <div class="reason">${esc(h.reasoning)}</div>
            ${shots}
          </div>`;
        })
        .join('\n');

      const escRows = detail.escalations
        .map((e) => {
          const intent = e.question?.intent ?? '';
          const questionText = e.question?.question ?? '(unparseable)';
          return `<tr><td>#${esc(e.id)}</td><td>${esc(intent)}</td><td>${esc(questionText)}</td><td>${e.status === 'pending' ? '<span class="badge b-amber">pending</span>' : `<span class="badge b-blue">answered</span> ${esc(e.answer)} <em>by ${esc(e.answeredBy)}</em>`}</td></tr>`;
        })
        .join('\n');

      return `<details>
        <summary><code>${esc(o.id)}</code> — ${statusBadge(String(o.status ?? 'in-progress'))} ${detail.heals.length} heal(s), ${detail.escalations.length} escalation(s)</summary>
        <div>
          <h2>Tests</h2>
          <table><tr><th>Test</th><th>Status</th><th>Duration</th><th></th></tr>${testRows || '<tr><td colspan="4">none recorded</td></tr>'}</table>
          ${detail.heals.length ? `<h2>Heals</h2>${healCards}` : ''}
          ${detail.escalations.length ? `<h2>Escalations</h2><table><tr><th>#</th><th>Intent</th><th>Question</th><th>Status</th></tr>${escRows}</table>` : ''}
        </div>
      </details>`;
    })
    .join('\n');

  // ---- Flake dashboard ----------------------------------------------------------
  const flakeRows = queryFlakeStats(store)
    .map((f) => {
      const flaky = f.flakyShaFlips;
      return `<tr><td>${esc(f.testId)}</td><td>${esc(f.total)}</td><td>${esc(f.passes)}</td><td>${esc(f.fails)}</td><td>${flaky > 0 ? `<span class="badge b-amber">@flaky (${flaky} SHA${flaky > 1 ? 's' : ''} flip)</span>` : '—'}</td></tr>`;
    })
    .join('\n');

  // ---- LLM cost summary ------------------------------------------------------------
  const llm = queryLlmCosts(store);
  const llmRows = llm.rows
    .map(
      (l) =>
        `<tr><td>${esc(l.provider)}/${esc(l.model)}</td><td>${esc(l.purpose)}</td><td>${esc(l.calls)}${l.failures > 0 ? ` <span class="badge b-red">${l.failures} failed</span>` : ''}</td><td>${esc(l.inputTokens)} / ${esc(l.outputTokens)}</td><td>$${Number(l.costUsd).toFixed(4)}</td><td>${Math.round(l.avgLatencyMs)}ms</td></tr>`,
    )
    .join('\n');
  const totalCost = llm.totalCostUsd;

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sentinel Report</title><style>${CSS}</style></head>
<body>
  <header>
    <h1>Sentinel Report</h1>
    <div class="sub">generated ${new Date().toISOString()} — ${overviews.length} run(s)</div>
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
  return { indexPath, runsIncluded: overviews.length };
}
