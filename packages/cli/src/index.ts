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
import { generateReport } from '@sentinel/report';
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

program
  .command('init')
  .description('Scaffold sentinel.config.ts and the .sentinel state directory')
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
    console.log(
      'GitHub Actions workflow scaffolding ships in the CI phase — see docs/ARCHITECTURE.md.',
    );
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
      const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
