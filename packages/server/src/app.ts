import path from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  applyEscalationAnswer,
  type EscalationQuestion,
  type LoadedConfig,
  type SentinelStore,
} from '@sentinel/core';
import {
  buildRunSummary,
  queryFlakeStats,
  queryLlmCosts,
  queryRunDetail,
  queryRunSteps,
  queryRunsOverview,
} from '@sentinel/report';
import { previewPromotions, promoteAndOpenPr } from '@sentinel/ops';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerFlowRoutes } from './flowRoutes.js';
import { RecorderController } from './recorder.js';
import { registerRecorderRoutes } from './recorderRoutes.js';
import { RunController } from './runController.js';

export interface AppDeps {
  store: SentinelStore;
  /** Absolute dir holding heal before/after screenshots (loaded.artifactsDir). */
  artifactsDir: string;
  /** Built @sentinel/web dist to serve as the SPA, or null to run API-only. */
  webDir: string | null;
  /** Identity recorded when this server answers escalations (channel 'web'). */
  actor?: string;
  /** Full loaded config — enables run triggering (POST /api/runs). Omit for read-only. */
  loaded?: LoadedConfig;
}

/** Recent runs to scan when resolving a single run's overview (local, single-user). */
const RUN_LOOKUP_LIMIT = 200;

/**
 * Build the Studio Fastify app. The store is injected so the app is testable
 * with an in-memory DB. Read endpoints reuse the shared query functions in
 * @sentinel/report so the dashboard and the static HTML report never diverge.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Run-triggering is available only when the full config is provided.
  const runner = deps.loaded ? new RunController(deps.store, deps.loaded) : null;

  // Heal screenshots are written under artifactsDir; serve that tree read-only.
  await app.register(fastifyStatic, {
    root: deps.artifactsDir,
    prefix: '/artifacts/',
    decorateReply: false,
  });

  // Map a stored absolute screenshot path to a servable URL, but only if it is
  // genuinely inside artifactsDir (containment guard against path traversal).
  const shotUrl = (abs: string | null): string | null => {
    if (!abs) return null;
    const rel = path.relative(deps.artifactsDir, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return `/artifacts/${rel.split(path.sep).join('/')}`;
  };

  // Rewrite the escalation's stored screenshot path into a servable URL.
  const mapQuestion = (q: EscalationQuestion | null): EscalationQuestion | null =>
    q ? { ...q, context: { ...q.context, screenshot: shotUrl(q.context?.screenshot ?? null) } } : q;

  app.get('/api/health', async () => ({ ok: true }));

  // Structured run summary (drop the GitHub-comment markdown field).
  app.get('/api/summary', async () => {
    const { markdown: _markdown, ...counts } = buildRunSummary(deps.store);
    return counts;
  });

  app.get<{ Querystring: { limit?: string } }>('/api/runs', async (req) => {
    const raw = Number(req.query.limit ?? 20);
    const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 20, 1), RUN_LOOKUP_LIMIT);
    return queryRunsOverview(deps.store, limit);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const overview =
      queryRunsOverview(deps.store, RUN_LOOKUP_LIMIT).find((o) => o.id === req.params.id) ?? null;
    if (!overview) {
      reply.code(404);
      return { error: 'run not found' };
    }
    const detail = queryRunDetail(deps.store, req.params.id);
    // Rewrite filesystem screenshot paths into servable /artifacts URLs.
    const heals = detail.heals.map((h) => ({
      ...h,
      screenshotBefore: shotUrl(h.screenshotBefore),
      screenshotAfter: shotUrl(h.screenshotAfter),
    }));
    const escalations = detail.escalations.map((e) => ({
      ...e,
      question: mapQuestion(e.question),
    }));
    const steps = queryRunSteps(deps.store, req.params.id);
    const running = runner?.status()?.runId === req.params.id && runner.isActive();
    return { overview, running, detail: { ...detail, heals, escalations, steps } };
  });

  app.get('/api/flake', async () => queryFlakeStats(deps.store));
  app.get('/api/llm-costs', async () => queryLlmCosts(deps.store));

  // ---- Escalations (the first write path: answering closes the loop) --------
  app.get('/api/escalations', async () =>
    deps.store.pendingEscalations().map((e) => ({ ...e, question: mapQuestion(e.question) })),
  );

  app.post<{ Params: { id: string }; Body: { choice?: string } }>(
    '/api/escalations/:id/answer',
    async (req, reply) => {
      const id = Number(req.params.id);
      const choice = (req.body?.choice ?? '').trim();
      if (!Number.isInteger(id) || !choice) {
        reply.code(400);
        return { error: 'body must include a non-empty "choice" (candidate label or REDESIGN)' };
      }
      try {
        return applyEscalationAnswer(deps.store, id, choice, deps.actor ?? 'studio', 'web');
      } catch (err) {
        const msg = (err as Error).message;
        const code = /not found/.test(msg) ? 404 : /is already/.test(msg) ? 409 : 400;
        reply.code(code);
        return { error: msg };
      }
    },
  );

  // ---- Run triggering (live execution) --------------------------------------
  app.get('/api/runs/active', async () => runner?.status() ?? { running: false });

  app.post<{ Body: { grep?: string; project?: string; heal?: string } }>(
    '/api/runs',
    async (req, reply) => {
      if (!runner) {
        reply.code(503);
        return { error: 'run triggering unavailable (server started without full config)' };
      }
      try {
        return runner.start(req.body ?? {});
      } catch (err) {
        reply.code(409);
        return { error: (err as Error).message };
      }
    },
  );

  // ---- Promotion → PR -------------------------------------------------------
  const rootDir = deps.loaded?.rootDir;
  const runBusy = (): string | null =>
    runner?.isActive() ? 'a run is in progress — promote after it finishes' : null;

  app.get<{ Querystring: { includeUnverified?: string } }>(
    '/api/promote/preview',
    async (req, reply) => {
      if (!rootDir) {
        reply.code(503);
        return { error: 'promotion unavailable (server started without full config)' };
      }
      const busy = runBusy();
      if (busy) {
        reply.code(409);
        return { error: busy };
      }
      return previewPromotions(deps.store, rootDir, {
        includeUnverified: req.query.includeUnverified === 'true',
      });
    },
  );

  app.post<{ Body: { includeUnverified?: boolean; branch?: string; push?: boolean } }>(
    '/api/promote/apply',
    async (req, reply) => {
      if (!rootDir) {
        reply.code(503);
        return { error: 'promotion unavailable (server started without full config)' };
      }
      const busy = runBusy();
      if (busy) {
        reply.code(409);
        return { error: busy };
      }
      const token = process.env.GITHUB_TOKEN || process.env.SENTINEL_GITHUB_TOKEN || undefined;
      return promoteAndOpenPr(deps.store, rootDir, {
        includeUnverified: req.body?.includeUnverified,
        branch: req.body?.branch,
        push: req.body?.push,
        githubToken: token,
      });
    },
  );

  // ---- Flows (block-editor backend — D39) -----------------------------------
  if (deps.loaded) {
    registerFlowRoutes(app, {
      store: deps.store,
      rootDir: deps.loaded.rootDir,
      writeBlocked: () => runBusy(),
    });
    // ---- Smart Recorder (D39): one session, headed browser, cache seeding ----
    const recorder = new RecorderController(deps.store, deps.loaded);
    registerRecorderRoutes(app, { recorder, writeBlocked: () => runBusy() });
    app.addHook('onClose', async () => {
      await recorder.stop().catch(() => {});
    });
  }

  // SPA: serve the built web assets and fall back to index.html for client routes.
  if (deps.webDir) {
    await app.register(fastifyStatic, {
      root: deps.webDir,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/api') &&
        !req.url.startsWith('/artifacts')
      ) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}
