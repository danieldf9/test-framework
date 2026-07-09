import type { ChildProcess } from 'node:child_process';
import type { LoadedConfig, SentinelStore } from '@sentinel/core';
import { finalizeRun, startRun } from '@sentinel/ops';
import type { StudioEvents } from './events.js';

export interface RunStatus {
  runId: string;
  running: boolean;
  startedAt: number;
  /** Tail of captured stdout/stderr lines (live log). */
  output: string[];
  /** Present once the run has finished. */
  status?: string;
}

const MAX_OUTPUT_LINES = 500;
const OUTPUT_TAIL = 150;

/**
 * Owns at most one in-flight `sentinel run` child for the Studio server. The
 * live view is driven by polling the state DB (steps/heals land there in real
 * time); this controller adds a captured-output tail and one-run-at-a-time
 * guarding on top of the shared @sentinel/ops orchestration.
 */
export class RunController {
  private active: {
    runId: string;
    child: ChildProcess;
    startedAt: number;
    output: string[];
  } | null = null;
  private last: RunStatus | null = null;

  constructor(
    private readonly store: SentinelStore,
    private readonly loaded: LoadedConfig,
    private readonly events?: StudioEvents,
  ) {}

  isActive(): boolean {
    return this.active !== null;
  }

  /** Start a run. Throws if one is already in progress. */
  start(opts: { grep?: string; project?: string; heal?: string }): { runId: string } {
    if (this.active) throw new Error('a run is already in progress');
    const output: string[] = [];
    const { runId, child } = startRun(this.store, this.loaded, {
      grep: opts.grep,
      project: opts.project,
      heal: opts.heal,
      stdio: 'pipe',
      cwd: this.loaded.rootDir,
    });
    this.active = { runId, child, startedAt: Date.now(), output };
    this.events?.emit('run-started', { runId });

    const absorb = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line.length === 0) continue;
        output.push(line);
        if (output.length > MAX_OUTPUT_LINES) output.shift();
      }
      // One poke per chunk (not per line): subscribers refetch the tail anyway.
      this.events?.emit('run-output', { runId });
    };
    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);

    const finish = (code: number | null) => {
      let status = 'failed';
      try {
        status = finalizeRun(this.store, runId, code).status;
      } catch {
        // Store may be closed during shutdown — leave the run un-finalized.
      }
      this.last = {
        runId,
        running: false,
        startedAt: this.active?.startedAt ?? Date.now(),
        output,
        status,
      };
      this.active = null;
      this.events?.emit('run-finished', { runId, status });
    };
    let settled = false;
    const once = (code: number | null) => {
      if (settled) return;
      settled = true;
      finish(code);
    };
    child.on('close', (code) => once(code));
    child.on('error', () => once(null));

    return { runId };
  }

  /** Current active run, or the most recently finished one, or null. */
  status(): RunStatus | null {
    if (this.active) {
      return {
        runId: this.active.runId,
        running: true,
        startedAt: this.active.startedAt,
        output: this.active.output.slice(-OUTPUT_TAIL),
      };
    }
    return this.last ? { ...this.last, output: this.last.output.slice(-OUTPUT_TAIL) } : null;
  }
}
