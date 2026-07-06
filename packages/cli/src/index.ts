#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  applyEscalationAnswer,
  exportDatabase,
  importDatabase,
  loadConfig,
  SentinelStore,
  type DbExport,
} from '@sentinel/core';
import { createProvider } from '@sentinel/providers';
import { buildRunSummary, generateReport } from '@sentinel/report';
import { migrateDirectory } from './migrate.js';
import { applyPromotions, planPromotions } from './promote.js';
import { selectOption } from './prompt.js';

const program = new Command();
program.name('sentinel').description('Self-healing Playwright test runner').version('0.1.0');

const CONFIG_TEMPLATE = `import { defineConfig } from '@sentinel/core';

export default defineConfig({
  testIdAttribute: 'data-testid',
  healing: {
    mode: 'auto',
  },
  // Consent banners are never auto-accepted silently. Declare them explicitly:
  // preSteps: [{ name: 'accept cookies', selector: '[data-testid=consent-accept]' }],
});
`;

const WORKFLOW_TEMPLATE = `# Sentinel CI (scaffolded by \`sentinel init\`)
#
# - Restores the locator cache (portable JSON export) from actions/cache
# - Runs the suite with healing; degrades to deterministic-only Tiers 0-1
#   when no LLM secret is configured
# - Uploads the HTML report (with heal screenshots) as an artifact
# - Posts/updates a single PR summary comment incl. pending escalations
# - Saves the updated locator cache
#
# Answer escalations from a PR comment: /sentinel choose <id> <label>
# (requires the sentinel-escalation-answer.yml companion workflow).
name: sentinel

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  sentinel:
    runs-on: ubuntu-latest
    env:
      SENTINEL_LLM_API_KEY: \${{ secrets.SENTINEL_LLM_API_KEY }}
      SENTINEL_RUN_ID: gh-\${{ github.run_id }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx playwright install --with-deps chromium

      - name: Restore locator cache
        uses: actions/cache/restore@v4
        with:
          path: .sentinel-ci/cache.json
          key: sentinel-\${{ github.ref_name }}-\${{ github.run_id }}
          restore-keys: |
            sentinel-\${{ github.ref_name }}-
            sentinel-
      - name: Import locator cache
        run: test -f .sentinel-ci/cache.json && npx sentinel db import .sentinel-ci/cache.json || echo "no cache yet"

      - name: Run suite with healing
        run: npx sentinel run

      - name: Report + summary
        if: always()
        run: |
          npx sentinel report --out sentinel-report
          npx sentinel summary --run "$SENTINEL_RUN_ID" --out sentinel-report/summary.md >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: sentinel-report
          path: sentinel-report

      - name: PR summary comment
        if: always() && github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const marker = '<!-- sentinel-summary -->';
            const body = marker + '\\n' + fs.readFileSync('sentinel-report/summary.md', 'utf8');
            const { data: comments } = await github.rest.issues.listComments({
              ...context.repo, issue_number: context.issue.number, per_page: 100 });
            const existing = comments.find(c => c.body && c.body.includes(marker));
            if (existing) {
              await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
            } else {
              await github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });
            }

      - name: Export locator cache
        if: always()
        run: mkdir -p .sentinel-ci && npx sentinel db export --json .sentinel-ci/cache.json
      - name: Save locator cache
        if: always()
        uses: actions/cache/save@v4
        with:
          path: .sentinel-ci/cache.json
          key: sentinel-\${{ github.ref_name }}-\${{ github.run_id }}
`;

program
  .command('init')
  .description(
    'Scaffold sentinel.config.ts, the .sentinel state directory, and a GH Actions workflow',
  )
  .action(() => {
    const cwd = process.cwd();
    const configPath = path.join(cwd, 'sentinel.config.ts');
    if (existsSync(configPath)) {
      console.log('sentinel.config.ts already exists — leaving it untouched.');
    } else {
      writeFileSync(configPath, CONFIG_TEMPLATE);
      console.log('Created sentinel.config.ts');
    }
    mkdirSync(path.join(cwd, '.sentinel'), { recursive: true });
    console.log('Created .sentinel/ (add it to .gitignore; use `sentinel db export` for CI).');
    const workflowPath = path.join(cwd, '.github', 'workflows', 'sentinel.yml');
    if (existsSync(workflowPath)) {
      console.log('.github/workflows/sentinel.yml already exists — leaving it untouched.');
    } else {
      mkdirSync(path.dirname(workflowPath), { recursive: true });
      writeFileSync(workflowPath, WORKFLOW_TEMPLATE);
      console.log(
        'Created .github/workflows/sentinel.yml (locator-cache persistence, report artifact, PR summary comment).',
      );
    }
  });

program
  .command('run')
  .description('Run the Playwright suite under Sentinel with a unified run id')
  .option('--grep <pattern>', 'only run tests matching this pattern')
  .option('--project <name>', 'Playwright project to run')
  .option('--heal <mode>', 'healing mode: auto | suggest | off')
  .allowUnknownOption(true)
  .argument('[playwrightArgs...]', 'extra arguments passed through to `playwright test`')
  .action(
    async (playwrightArgs: string[], opts: { grep?: string; project?: string; heal?: string }) => {
      const loaded = await loadConfig(process.cwd());
      const store = new SentinelStore(loaded.dbPath);
      // CI sets SENTINEL_RUN_ID (e.g. gh-<run_id>-shard-<n>) so shard runs can
      // be aggregated later with `sentinel summary --run-prefix`.
      const runId =
        process.env.SENTINEL_RUN_ID ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const gitSha = gitShaOrNull();
      const healMode = opts.heal ?? loaded.config.healing.mode;
      store.ensureRun(runId, gitSha, healMode);

      const args = ['playwright', 'test'];
      if (opts.grep) args.push('--grep', opts.grep);
      if (opts.project) args.push('--project', opts.project);
      args.push(...playwrightArgs);

      const result = spawnSync('npx', args, {
        stdio: 'inherit',
        shell: true,
        env: {
          ...process.env,
          SENTINEL_RUN_ID: runId,
          ...(opts.heal ? { SENTINEL_HEAL: opts.heal } : {}),
        },
      });

      const summary = summarizeRun(store, runId);
      const status =
        result.status !== 0
          ? 'failed'
          : summary.unverifiedHeals > 0
            ? 'passed_unverified'
            : 'passed';
      store.finishRun(runId, status, summary);
      printSummary(runId, status, summary);
      store.close();
      process.exit(result.status ?? 1);
    },
  );

const db = program.command('db').description('Export/import the Sentinel state database');

db.command('export')
  .description('Export the state DB to portable JSON (for CI artifacts)')
  .option('--json <file>', 'output file', '.sentinel/sentinel-export.json')
  .action(async (opts: { json: string }) => {
    const loaded = await loadConfig(process.cwd());
    const store = new SentinelStore(loaded.dbPath);
    const data = exportDatabase(store.db);
    mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    writeFileSync(opts.json, JSON.stringify(data, null, 2));
    const rows = Object.values(data.tables).reduce((a, t) => a + t.length, 0);
    console.log(`Exported ${rows} rows to ${opts.json}`);
    store.close();
  });

db.command('import')
  .description('Merge a JSON export into the local state DB (idempotent)')
  .argument('<file>', 'JSON export file')
  .action(async (file: string) => {
    const loaded = await loadConfig(process.cwd());
    const store = new SentinelStore(loaded.dbPath);
    const data = JSON.parse(readFileSync(file, 'utf8')) as DbExport;
    const { imported } = importDatabase(store.db, data);
    console.log(`Imported/merged ${imported} rows from ${file}`);
    store.close();
  });

program
  .command('summary')
  .description('Print a markdown run summary (pass/heal/escalation counts) for CI comments')
  .option('--run <id>', 'summarize a specific run id')
  .option(
    '--run-prefix <prefix>',
    'aggregate all runs whose id starts with this prefix (CI shards)',
  )
  .option('--out <file>', 'also write the markdown to a file')
  .option('--json <file>', 'also write machine-readable counts to a JSON file')
  .action(async (opts: { run?: string; runPrefix?: string; out?: string; json?: string }) => {
    const loaded = await loadConfig(process.cwd());
    const store = new SentinelStore(loaded.dbPath);
    const summary = buildRunSummary(store, { runId: opts.run, runPrefix: opts.runPrefix });
    store.close();
    process.stdout.write(summary.markdown);
    if (opts.out) {
      mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      writeFileSync(opts.out, summary.markdown);
    }
    if (opts.json) {
      mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
      const { markdown: _markdown, ...counts } = summary;
      writeFileSync(opts.json, JSON.stringify(counts, null, 2));
    }
  });

program
  .command('report')
  .description('Generate the static HTML report (results, heals, flake dashboard, LLM costs)')
  .option('--out <dir>', 'output directory', path.join('.sentinel', 'report'))
  .option('--runs <n>', 'number of most-recent runs to include', '20')
  .action(async (opts: { out: string; runs: string }) => {
    const loaded = await loadConfig(process.cwd());
    const store = new SentinelStore(loaded.dbPath);
    const result = generateReport(store, { outDir: opts.out, limitRuns: Number(opts.runs) });
    store.close();
    console.log(`Report written: ${result.indexPath} (${result.runsIncluded} run(s))`);
  });

program
  .command('escalations')
  .description('List or answer pending human-escalation questions (spec §6)')
  .option('--answer', 'interactively answer each pending escalation')
  .option('--choose <idAndLabel...>', 'non-interactive: answer escalation, e.g. --choose 3 A')
  .option('--all', 'include already-answered escalations in the listing')
  .action(async (opts: { answer?: boolean; choose?: string[]; all?: boolean }) => {
    const loaded = await loadConfig(process.cwd());
    const store = new SentinelStore(loaded.dbPath);
    try {
      if (opts.choose) {
        const [idRaw, label] = opts.choose;
        if (!idRaw || !label) {
          console.error('Usage: sentinel escalations --choose <id> <label|REDESIGN>');
          process.exitCode = 1;
          return;
        }
        const result = applyEscalationAnswer(
          store,
          Number(idRaw),
          label,
          process.env.USER ?? process.env.USERNAME ?? 'unknown',
          'cli',
        );
        console.log(
          result.redesign
            ? `Escalation #${result.escalationId} marked REDESIGN — update the test spec for step ${result.stepId}.`
            : `Escalation #${result.escalationId} answered: ${result.appliedDescriptor} is now the cached primary for ${result.testId} :: ${result.stepId}. Next run heals at Tier 0.`,
        );
        return;
      }

      const pending = store.pendingEscalations();
      if (!opts.answer) {
        if (pending.length === 0) {
          console.log('No pending escalations.');
        }
        for (const e of pending) {
          console.log(`\n#${e.id} — ${e.question.test}`);
          console.log(`  intent: ${e.question.intent}`);
          console.log(`  ${e.question.question}`);
          for (const c of e.question.candidates) {
            console.log(
              `    (${c.label}) conf ${c.confidence.toFixed(2)} — <${c.fingerprint.tag}> "${c.fingerprint.name || c.fingerprint.text}"`,
            );
          }
          if (e.question.context.screenshot) {
            console.log(`  screenshot: ${e.question.context.screenshot}`);
          }
        }
        if (opts.all) {
          const answered = store.db
            .prepare(
              "SELECT id, test_id, answer, answered_by FROM escalations WHERE status = 'answered' ORDER BY answered_at DESC LIMIT 20",
            )
            .all() as Array<Record<string, unknown>>;
          for (const a of answered) {
            console.log(`\n#${a.id} (answered by ${a.answered_by}) — ${a.test_id}: ${a.answer}`);
          }
        }
        if (pending.length > 0) {
          console.log(
            `\n${pending.length} pending. Run \`sentinel escalations --answer\` to resolve them.`,
          );
        }
        return;
      }

      if (pending.length === 0) {
        console.log('No pending escalations.');
        return;
      }
      for (const e of pending) {
        console.log(`\n#${e.id} — ${e.question.test}`);
        console.log(`intent: ${e.question.intent}`);
        console.log(e.question.question);
        if (e.question.context.screenshot) {
          console.log(`screenshot: ${e.question.context.screenshot}`);
        }
        const options = [
          ...e.question.candidates.map((c) => ({
            key: c.label,
            label: `conf ${c.confidence.toFixed(2)} — <${c.fingerprint.tag}> "${c.fingerprint.name || c.fingerprint.text}" (${c.fingerprint.cssPath.slice(0, 60)})`,
          })),
          { key: 'REDESIGN', label: 'Intentional redesign — the test itself needs updating' },
          { key: 'SKIP', label: 'Skip for now' },
        ];
        const choice = await selectOption('Which candidate matches the original intent?', options);
        if (choice === 'SKIP') continue;
        const result = applyEscalationAnswer(
          store,
          e.id,
          choice,
          process.env.USER ?? process.env.USERNAME ?? 'unknown',
          'cli',
        );
        console.log(
          result.redesign
            ? `→ recorded as REDESIGN; update the spec for step ${result.stepId}.`
            : `→ applied: ${result.appliedDescriptor} cached as primary (Tier 0 on next run).`,
        );
      }
    } finally {
      store.close();
    }
  });

program
  .command('migrate')
  .description('Wrap vanilla Playwright specs with the sentinel fixture (stub intents marked TODO)')
  .argument('<dir>', 'directory to scan for *.spec.ts / *.test.ts files')
  .option('--dry-run', 'report what would change without writing files')
  .action((dir: string, opts: { dryRun?: boolean }) => {
    const result = migrateDirectory(path.resolve(dir), { write: !opts.dryRun });
    for (const f of result.files) {
      console.log(
        `${f.status.padEnd(22)} ${f.file}  (${f.wrapped} wrapped${f.skipped ? `, ${f.skipped} skipped` : ''})`,
      );
    }
    console.log(
      `\n${result.changedFiles} file(s) ${opts.dryRun ? 'would be ' : ''}changed, ${result.totalWrapped} interaction(s) wrapped, ${result.totalSkipped} left untouched (shapes s.* cannot express).`,
    );
    if (result.totalWrapped > 0 && !opts.dryRun) {
      console.log(
        `Next: search for ${'`'}intent: 'TODO'${'`'} and replace each stub with a real semantic description — the intent is the healing anchor.`,
      );
    }
  });

program
  .command('promote')
  .description(
    'Write reviewed heals from the cache back into spec files as a reviewable diff/branch',
  )
  .option('--dry-run', 'show the planned changes without touching any file')
  .option('--include-unverified', 'also promote UNVERIFIED heals (review the report first)')
  .option('--branch <name>', 'create a git branch and commit the promotion for PR review')
  .option('--root <dir>', 'project root containing the spec files (defaults to the config dir)')
  .action(
    async (opts: {
      dryRun?: boolean;
      includeUnverified?: boolean;
      branch?: string;
      root?: string;
    }) => {
      const loaded = await loadConfig(process.cwd());
      const store = new SentinelStore(loaded.dbPath);
      const rootDir = opts.root ? path.resolve(opts.root) : loaded.rootDir;
      const plans = planPromotions(store, rootDir, {
        includeUnverified: opts.includeUnverified,
      });
      const ready = plans.filter((p) => p.status === 'ready');
      for (const p of plans) {
        if (p.status === 'ready') {
          console.log(`ready     ${p.file}: ${p.oldCode} → ${p.newCode} (${p.occurrences}×)`);
        } else {
          console.log(
            `${p.status.padEnd(9)} ${p.file}: ${p.oldCode} → ${p.newCode}\n          ↳ ${p.note}`,
          );
        }
      }
      if (ready.length === 0) {
        console.log(
          '\nNothing to promote. (Heals are promoted once; UNVERIFIED needs --include-unverified.)',
        );
        store.close();
        return;
      }
      if (opts.dryRun) {
        const preview = applyPromotions(store, plans, { write: false });
        console.log(`\n--dry-run: ${preview.applied} replacement group(s) would be applied:\n`);
        for (const line of preview.diff) console.log(line);
        store.close();
        return;
      }
      if (opts.branch) {
        const branch = spawnSync('git', ['checkout', '-b', opts.branch], {
          cwd: rootDir,
          encoding: 'utf8',
        });
        if (branch.status !== 0) {
          console.error(`git checkout -b ${opts.branch} failed: ${branch.stderr.trim()}`);
          store.close();
          process.exit(1);
        }
      }
      const result = applyPromotions(store, plans, { write: true });
      console.log(
        `\nPromoted ${result.applied} locator group(s) into ${result.filesChanged.length} file(s):`,
      );
      for (const line of result.diff) console.log(line);
      if (opts.branch) {
        spawnSync('git', ['add', ...result.filesChanged], { cwd: rootDir, encoding: 'utf8' });
        const commit = spawnSync(
          'git',
          [
            'commit',
            '-m',
            `chore(sentinel): promote ${result.applied} healed locator(s) into specs`,
          ],
          { cwd: rootDir, encoding: 'utf8' },
        );
        console.log(
          commit.status === 0
            ? `Committed on branch '${opts.branch}' — push it and open a PR for review.`
            : `Files written on branch '${opts.branch}' but commit failed: ${commit.stderr.trim()}`,
        );
      } else {
        console.log('Review with `git diff`, then commit. The heals are now marked promoted.');
      }
      store.close();
    },
  );

program
  .command('doctor')
  .description('Validate config, database integrity, and tooling')
  .action(async () => {
    let ok = true;
    try {
      const loaded = await loadConfig(process.cwd());
      console.log(`✔ config: ${loaded.configPath ?? '(built-in defaults)'}`);
      console.log(`  heal mode: ${loaded.config.healing.mode}, db: ${loaded.dbPath}`);
      try {
        const store = new SentinelStore(loaded.dbPath);
        const integrity = store.db.pragma('integrity_check', { simple: true });
        console.log(`✔ database: integrity_check = ${integrity}`);
        store.close();
      } catch (err) {
        ok = false;
        console.error(`✘ database: ${String((err as Error).message)}`);
      }
      const llm = loaded.config.llm;
      if (llm.provider === 'none') {
        console.log('ℹ LLM provider: none — Tiers 2-3 disabled, deterministic healing only.');
      } else {
        const setup = createProvider({
          provider: llm.provider,
          model: llm.model,
          baseUrl: llm.baseUrl,
          apiKey: process.env[llm.apiKeyEnv],
          timeoutMs: Math.min(llm.timeoutMs, 10_000),
          maxRetries: 0,
          backoffBaseMs: llm.backoffBaseMs,
          circuitBreakerThreshold: llm.circuitBreakerThreshold,
          supportsVision: llm.supportsVision,
          inputCostPerMTok: llm.inputCostPerMTok,
          outputCostPerMTok: llm.outputCostPerMTok,
        });
        if (!setup.provider) {
          console.log(`ℹ LLM provider: ${llm.provider} disabled — ${setup.disabledReason}`);
        } else {
          try {
            const pong = await setup.provider.complete({
              messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
              // Reasoning/thinking models consume output budget before emitting
              // text — a tiny cap would read as a malformed (empty) reply.
              maxTokens: 256,
              purpose: 'doctor-ping',
            });
            console.log(
              `✔ LLM provider: ${setup.provider.name}/${setup.provider.model} reachable (${pong.latencyMs}ms, vision: ${setup.provider.supportsVision})`,
            );
          } catch (err) {
            ok = false;
            console.error(
              `✘ LLM provider: ${setup.provider.name} unreachable — ${String((err as Error).message)}`,
            );
          }
        }
      }
    } catch (err) {
      ok = false;
      console.error(`✘ config: ${String((err as Error).message)}`);
    }
    const pw = spawnSync('npx', ['playwright', '--version'], { shell: true, encoding: 'utf8' });
    if (pw.status === 0) console.log(`✔ playwright: ${pw.stdout.trim()}`);
    else {
      ok = false;
      console.error('✘ playwright: not found (npx playwright --version failed)');
    }
    process.exit(ok ? 0 : 1);
  });

function gitShaOrNull(): string | null {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { shell: true, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

interface RunSummary {
  tests: number;
  passed: number;
  failed: number;
  heals: number;
  autoHeals: number;
  unverifiedHeals: number;
  escalations: number;
  [key: string]: number;
}

function summarizeRun(store: SentinelStore, runId: string): RunSummary {
  const q = <T>(sql: string): T => store.db.prepare(sql).get(runId) as T;
  const tests = q<{ n: number }>('SELECT COUNT(*) n FROM test_results WHERE run_id = ?').n;
  const passed = q<{ n: number }>(
    "SELECT COUNT(*) n FROM test_results WHERE run_id = ? AND status LIKE 'passed%'",
  ).n;
  const heals = q<{ n: number }>('SELECT COUNT(*) n FROM heals WHERE run_id = ?').n;
  const autoHeals = q<{ n: number }>(
    "SELECT COUNT(*) n FROM heals WHERE run_id = ? AND mode = 'AUTO'",
  ).n;
  const unverifiedHeals = q<{ n: number }>(
    "SELECT COUNT(*) n FROM heals WHERE run_id = ? AND mode = 'UNVERIFIED'",
  ).n;
  const escalations = q<{ n: number }>('SELECT COUNT(*) n FROM escalations WHERE run_id = ?').n;
  return {
    tests,
    passed,
    failed: tests - passed,
    heals,
    autoHeals,
    unverifiedHeals,
    escalations,
  };
}

function printSummary(runId: string, status: string, s: RunSummary): void {
  console.log('\n── Sentinel run summary ─────────────────────────────');
  console.log(`run:         ${runId}`);
  console.log(`status:      ${status}`);
  console.log(`tests:       ${s.passed}/${s.tests} passed`);
  console.log(`heals:       ${s.heals} (${s.autoHeals} auto, ${s.unverifiedHeals} unverified)`);
  console.log(`escalations: ${s.escalations}`);
  if (s.unverifiedHeals > 0) {
    console.log(
      `⚠ passed with ${s.unverifiedHeals} unverified heal(s) — review required before trusting green`,
    );
  }
  console.log('─────────────────────────────────────────────────────');
}

program.parseAsync(process.argv);
