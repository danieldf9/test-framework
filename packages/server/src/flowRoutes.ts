import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { makeTestId, type SentinelStore } from '@sentinel/core';
import {
  compileFlow,
  FLOW_FILE_SUFFIX,
  FLOW_SPEC_SUFFIX,
  importSpecSource,
  isGeneratedSpec,
  parseFlow,
  slugForTitle,
  specPathForFlow,
  type Flow,
} from '@sentinel/flow';
import type { FastifyInstance } from 'fastify';

export interface FlowRouteDeps {
  store: SentinelStore;
  rootDir: string;
  /** Returns a human-readable reason when writes must be refused (run active). */
  writeBlocked: () => string | null;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.sentinel', 'test-results']);
const SPEC_PATTERN = /\.(spec|test)\.ts$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Resolve an API-supplied relative path, refusing escapes from rootDir. */
export function resolveInRoot(rootDir: string, rel: string): string {
  const abs = path.resolve(rootDir, rel);
  if (
    path.relative(rootDir, abs).startsWith('..') ||
    path.isAbsolute(path.relative(rootDir, abs))
  ) {
    throw new Error(`path escapes the project root: ${rel}`);
  }
  return abs;
}

/** The fixture's test identity for a spec file + test title (see fixture.ts:
 * makeTestId(relativeFile, titlePath) where titlePath = [file basename, title]). */
export function testIdFor(rootDir: string, absSpecPath: string, title: string): string {
  return makeTestId(path.relative(rootDir, absSpecPath), [path.basename(absSpecPath), title]);
}

/** Where new flows go: alongside existing flows, else alongside existing specs,
 * else a specs/ dir under the root. */
export function pickFlowDir(rootDir: string): string {
  const files = walk(rootDir);
  const flow = files.find((f) => f.endsWith(FLOW_FILE_SUFFIX));
  if (flow) return path.dirname(flow);
  const spec = files.find((f) => SPEC_PATTERN.test(f));
  if (spec) return path.dirname(spec);
  return path.join(rootDir, 'specs');
}

export function writeFlowFiles(absFlowPath: string, flow: Flow): void {
  mkdirSync(path.dirname(absFlowPath), { recursive: true });
  writeFileSync(absFlowPath, JSON.stringify(flow, null, 2) + '\n');
  writeFileSync(specPathForFlow(absFlowPath), compileFlow(flow, path.basename(absFlowPath)));
}

/** Next non-colliding `<slug>[-n].flow.json` path inside a directory. */
export function nextFlowPath(dir: string, title: string): string {
  const base = slugForTitle(title);
  let abs = path.join(dir, `${base}${FLOW_FILE_SUFFIX}`);
  for (let n = 2; existsSync(abs); n++) abs = path.join(dir, `${base}-${n}${FLOW_FILE_SUFFIX}`);
  return abs;
}

export function registerFlowRoutes(app: FastifyInstance, deps: FlowRouteDeps): void {
  const { store, rootDir } = deps;

  app.get('/api/flows', async () => {
    return walk(rootDir)
      .filter((f) => f.endsWith(FLOW_FILE_SUFFIX))
      .map((abs) => {
        const rel = toPosix(path.relative(rootDir, abs));
        try {
          const flow = parseFlow(JSON.parse(readFileSync(abs, 'utf8')));
          return { path: rel, title: flow.title, steps: flow.steps.length, invalid: false };
        } catch {
          return { path: rel, title: '(invalid flow file)', steps: 0, invalid: true };
        }
      });
  });

  app.get<{ Querystring: { path?: string } }>('/api/flows/one', async (req, reply) => {
    const rel = req.query.path ?? '';
    if (!rel.endsWith(FLOW_FILE_SUFFIX)) {
      reply.code(400);
      return { error: `path must end with ${FLOW_FILE_SUFFIX}` };
    }
    try {
      const abs = resolveInRoot(rootDir, rel);
      const flow = parseFlow(JSON.parse(readFileSync(abs, 'utf8')));
      return { path: rel, flow, specPath: toPosix(path.relative(rootDir, specPathForFlow(abs))) };
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  // Create a new (empty or seeded) flow.
  app.post<{ Body: { title?: string; flow?: unknown } }>('/api/flows', async (req, reply) => {
    const blocked = deps.writeBlocked();
    if (blocked) {
      reply.code(409);
      return { error: blocked };
    }
    const title = (req.body?.title ?? '').trim();
    if (!title) {
      reply.code(400);
      return { error: 'a title is required' };
    }
    let flow: Flow;
    try {
      flow = req.body?.flow
        ? parseFlow(req.body.flow)
        : parseFlow({ version: 1, title, steps: [] });
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
    const abs = nextFlowPath(pickFlowDir(rootDir), title);
    writeFlowFiles(abs, flow);
    return { path: toPosix(path.relative(rootDir, abs)), title: flow.title };
  });

  // Save an existing flow (recompiles the generated spec; rekeys on title rename).
  app.put<{ Body: { path?: string; flow?: unknown } }>('/api/flows', async (req, reply) => {
    const blocked = deps.writeBlocked();
    if (blocked) {
      reply.code(409);
      return { error: blocked };
    }
    const rel = req.body?.path ?? '';
    if (!rel.endsWith(FLOW_FILE_SUFFIX)) {
      reply.code(400);
      return { error: `path must end with ${FLOW_FILE_SUFFIX}` };
    }
    let flow: Flow;
    try {
      flow = parseFlow(req.body?.flow);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
    try {
      const abs = resolveInRoot(rootDir, rel);
      const specAbs = specPathForFlow(abs);
      // Renaming the test title moves its identity (title is part of makeTestId) —
      // migrate the history along with it.
      let rekeyedRows = 0;
      if (existsSync(abs)) {
        try {
          const before = parseFlow(JSON.parse(readFileSync(abs, 'utf8')));
          if (before.title !== flow.title) {
            rekeyedRows = store.rekeyTest(
              testIdFor(rootDir, specAbs, before.title),
              testIdFor(rootDir, specAbs, flow.title),
            );
          }
        } catch {
          // unreadable previous flow — save proceeds, nothing to rekey
        }
      }
      writeFlowFiles(abs, flow);
      return { path: rel, title: flow.title, rekeyedRows };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // Hand-authored specs that could be lifted into flows (dry probe, read-only).
  app.get('/api/flows/importable', async () => {
    return walk(rootDir)
      .filter((f) => SPEC_PATTERN.test(f) && !f.endsWith(FLOW_SPEC_SUFFIX))
      .map((abs) => {
        const rel = toPosix(path.relative(rootDir, abs));
        const source = readFileSync(abs, 'utf8');
        if (isGeneratedSpec(source)) return null;
        const result = importSpecSource(source, path.basename(abs));
        return result.importable
          ? { path: rel, importable: true as const, tests: result.flows.length }
          : { path: rel, importable: false as const, reason: result.reason };
      })
      .filter((x) => x !== null);
  });

  // Import a spec: write flows + generated specs, migrate history, retire the original.
  app.post<{ Body: { specPath?: string } }>('/api/flows/import', async (req, reply) => {
    const blocked = deps.writeBlocked();
    if (blocked) {
      reply.code(409);
      return { error: blocked };
    }
    const rel = req.body?.specPath ?? '';
    try {
      const abs = resolveInRoot(rootDir, rel);
      const source = readFileSync(abs, 'utf8');
      const result = importSpecSource(source, path.basename(abs));
      if (!result.importable) {
        reply.code(422);
        return { error: result.reason };
      }
      const dir = path.dirname(abs);
      const created: Array<{ path: string; title: string }> = [];
      let movedRows = 0;
      for (const imported of result.flows) {
        const flowAbs = nextFlowPath(dir, imported.title);
        writeFlowFiles(flowAbs, imported.flow);
        const newSpecAbs = specPathForFlow(flowAbs);
        const oldTestId = testIdFor(rootDir, abs, imported.title);
        const newTestId = testIdFor(rootDir, newSpecAbs, imported.title);
        movedRows += store.rekeyTest(oldTestId, newTestId);
        for (const rk of imported.rekeys) {
          movedRows += store.rekeyStep(newTestId, rk.oldStepId, rk.newStepId);
        }
        created.push({ path: toPosix(path.relative(rootDir, flowAbs)), title: imported.title });
      }
      // Retire the original so Playwright stops running it (reversible rename).
      const retired = `${abs}.imported`;
      renameSync(abs, retired);
      return {
        flows: created,
        movedRows,
        retired: toPosix(path.relative(rootDir, retired)),
      };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });
}
