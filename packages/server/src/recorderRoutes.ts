import type { FastifyInstance } from 'fastify';
import type { RecorderController } from './recorder.js';

export interface RecorderRouteDeps {
  recorder: RecorderController;
  /** Reason writes must be refused right now (an active suite run), or null. */
  writeBlocked: () => string | null;
}

export function registerRecorderRoutes(app: FastifyInstance, deps: RecorderRouteDeps): void {
  const { recorder } = deps;

  app.post<{ Body: { url?: string; headless?: boolean } }>(
    '/api/recorder/start',
    async (req, reply) => {
      const blocked = deps.writeBlocked();
      if (blocked) {
        reply.code(409);
        return { error: blocked };
      }
      try {
        await recorder.start({ url: req.body?.url ?? '', headless: req.body?.headless });
        return recorder.status();
      } catch (err) {
        reply.code(recorder.isActive() ? 409 : 400);
        return { error: (err as Error).message };
      }
    },
  );

  app.get('/api/recorder/status', async () => recorder.status());

  app.post<{ Body: { mode?: string } }>('/api/recorder/mode', async (req, reply) => {
    const mode = req.body?.mode;
    if (mode !== 'record' && mode !== 'assert') {
      reply.code(400);
      return { error: `mode must be 'record' or 'assert'` };
    }
    await recorder.setMode(mode);
    return recorder.status();
  });

  app.patch<{ Params: { index: string }; Body: { action?: string; text?: string } }>(
    '/api/recorder/steps/:index',
    async (req, reply) => {
      const action = req.body?.action;
      if (action !== undefined && action !== 'expectVisible' && action !== 'expectText') {
        reply.code(400);
        return { error: `action must be 'expectVisible' or 'expectText'` };
      }
      try {
        recorder.updateDraft(Number(req.params.index), { action, text: req.body?.text });
        return recorder.status();
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );

  app.delete<{ Params: { index: string } }>('/api/recorder/steps/:index', async (req, reply) => {
    try {
      recorder.removeDraft(Number(req.params.index));
      return recorder.status();
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post('/api/recorder/stop', async () => {
    await recorder.stop();
    return recorder.status();
  });

  app.post<{ Body: { title?: string } }>('/api/recorder/save', async (req, reply) => {
    const title = (req.body?.title ?? '').trim();
    if (!title) {
      reply.code(400);
      return { error: 'a title is required' };
    }
    try {
      return await recorder.save(title);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });
}
