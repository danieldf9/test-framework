import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import type { LoadedConfig, SentinelStore } from '@sentinel/core';
import { quoteForShell } from './shell.js';

export interface RunSummary {
  tests: number;
  passed: number;
  failed: number;
  heals: number;
  autoHeals: number;
  unverifiedHeals: number;
  escalations: number;
  [key: string]: number;
}

export interface StartRunOptions {
  grep?: string;
  project?: string;
  /** healing mode override: auto | suggest | off (else config default). */
  heal?: string;
  /** Extra args passed through to `playwright test`. */
  playwrightArgs?: string[];
  /** Child stdio. CLI uses 'inherit' (stream to terminal); the server uses
   * 'pipe' to capture output for the live view. Defaults to 'inherit'. */
  stdio?: StdioOptions;
  /** Explicit run id. Falls back to SENTINEL_RUN_ID, then a timestamp id. */
  runId?: string;
}

export interface StartedRun {
  runId: string;
  child: ChildProcess;
}

export function gitShaOrNull(): string | null {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { shell: true, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Launch the Playwright suite under Sentinel with a unified run id, non-blocking.
 * `ensureRun` is recorded before spawn so the run row exists the moment a caller
 * (CLI or Studio server) starts polling. The caller awaits {@link waitForExit}
 * then calls {@link finalizeRun}.
 */
export function startRun(
  store: SentinelStore,
  loaded: LoadedConfig,
  opts: StartRunOptions = {},
): StartedRun {
  // CI sets SENTINEL_RUN_ID (e.g. gh-<run_id>-shard-<n>) so shard runs can
  // be aggregated later with `sentinel summary --run-prefix`.
  const runId =
    opts.runId ??
    process.env.SENTINEL_RUN_ID ??
    `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const gitSha = gitShaOrNull();
  const healMode = opts.heal ?? loaded.config.healing.mode;
  store.ensureRun(runId, gitSha, healMode);

  const args = ['playwright', 'test'];
  if (opts.grep) args.push('--grep', opts.grep);
  if (opts.project) args.push('--project', opts.project);
  if (opts.playwrightArgs) args.push(...opts.playwrightArgs);

  const child = spawn(
    'npx',
    args.map((a) => quoteForShell(a)),
    {
      stdio: opts.stdio ?? 'inherit',
      shell: true,
      env: {
        ...process.env,
        SENTINEL_RUN_ID: runId,
        ...(opts.heal ? { SENTINEL_HEAL: opts.heal } : {}),
      },
    },
  );
  return { runId, child };
}

/** Resolve with the child's exit code (null if it failed to launch). */
export function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(null));
  });
}

export function summarizeRun(store: SentinelStore, runId: string): RunSummary {
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

/** Compute the summary, derive the run status, and persist it via finishRun. */
export function finalizeRun(
  store: SentinelStore,
  runId: string,
  exitCode: number | null,
): { status: string; summary: RunSummary } {
  const summary = summarizeRun(store, runId);
  const status =
    exitCode !== 0 ? 'failed' : summary.unverifiedHeals > 0 ? 'passed_unverified' : 'passed';
  store.finishRun(runId, status, summary);
  return { status, summary };
}
