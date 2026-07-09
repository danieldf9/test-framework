import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { LoadedConfig, SentinelStore as SentinelStoreType } from '@sentinel/core';
import { SentinelStore } from '@sentinel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

/** previewPromotions/promoteAndOpenPr only read loaded.rootDir; a partial is enough. */
const loadedFor = (rootDir: string): LoadedConfig => ({ rootDir }) as unknown as LoadedConfig;

function seedPromotableHeal(store: SentinelStoreType, rootDir: string): void {
  mkdirSync(path.join(rootDir, 'specs'), { recursive: true });
  writeFileSync(
    path.join(rootDir, 'specs', 'shop.spec.ts'),
    `await s.click({ locator: page.locator('.btn-order'), intent: 'Place order button' });\n`,
  );
  store.ensureRun('r1', 'sha', 'auto');
  store.recordHeal({
    runId: 'r1',
    testId: 'specs/shop.spec.ts::checkout',
    stepId: 's1',
    intent: 'Place order button',
    oldLocator: `locator('.btn-order')`,
    newLocator: 'stale',
    tier: 1,
    confidence: 0.9,
    mode: 'AUTO',
    reasoning: 'r',
    screenshotBefore: null,
    screenshotAfter: null,
    gitSha: 'sha',
  });
  store.upsertCacheEntry({
    testId: 'specs/shop.spec.ts::checkout',
    stepId: 's1',
    primary: { kind: 'role', value: 'button', name: 'Submit order', exact: true },
    alternates: [],
    fingerprint: {
      tag: 'button',
      role: 'button',
      name: 'Submit order',
      text: 'Submit order',
      id: null,
      testId: null,
      classes: [],
      attributes: {},
      nearbyText: '',
      labelText: '',
      cssPath: 'body > button:nth-of-type(1)',
    },
    intent: 'Place order button',
    lastVerifiedAt: Date.now(),
  });
}

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function seededStore(artifactsDir: string): SentinelStore {
  const store = new SentinelStore(':memory:');
  store.ensureRun('run-1', 'sha-1', 'auto');
  store.recordTestResult({
    runId: 'run-1',
    testId: 'shop.spec.ts::checkout',
    title: 'checkout flow',
    file: 'shop.spec.ts',
    status: 'passed_unverified',
    durationMs: 1200,
    error: null,
    flakyTagged: false,
  });
  store.recordHeal({
    runId: 'run-1',
    testId: 'shop.spec.ts::checkout',
    stepId: 's1',
    intent: 'Place order button',
    oldLocator: "locator('.btn-order')",
    newLocator: "getByRole('button', { name: 'Submit order' })",
    tier: 1,
    confidence: 0.91,
    mode: 'UNVERIFIED',
    reasoning: 'fuzzy DOM match',
    // A path INSIDE artifactsDir must map to a servable /artifacts URL.
    screenshotBefore: path.join(artifactsDir, 'run-1', 'checkout', 'before.jpg'),
    screenshotAfter: null,
    gitSha: 'sha-1',
  });
  store.finishRun('run-1', 'passed_unverified', { tests: 1 });
  return store;
}

describe('Studio read API', () => {
  it('serves summary, runs, run detail (with screenshot URL mapping), flake, and cost', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-server-'));
    const store = seededStore(dir);
    const app = await buildApp({ store, artifactsDir: dir, webDir: null });

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true });

    const runs = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(runs.statusCode).toBe(200);
    const runList = runs.json();
    expect(runList).toHaveLength(1);
    expect(runList[0].id).toBe('run-1');
    expect(runList[0].tests).toBe(1);

    const detail = await app.inject({ method: 'GET', url: '/api/runs/run-1' });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.overview.id).toBe('run-1');
    expect(body.detail.heals).toHaveLength(1);
    // absolute filesystem path rewritten to a servable, containment-checked URL
    expect(body.detail.heals[0].screenshotBefore).toBe('/artifacts/run-1/checkout/before.jpg');
    expect(body.detail.heals[0].screenshotAfter).toBeNull();

    const missing = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist' });
    expect(missing.statusCode).toBe(404);

    const flake = await app.inject({ method: 'GET', url: '/api/flake' });
    expect(flake.statusCode).toBe(200);

    const cost = await app.inject({ method: 'GET', url: '/api/llm-costs' });
    expect(cost.json()).toHaveProperty('totalCostUsd');

    await app.close();
    store.close();
  });

  it('lists and answers escalations (write path), then 409s on re-answer', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-server-'));
    const store = new SentinelStore(':memory:');
    store.ensureRun('run-1', 'sha-1', 'auto');
    const fp = {
      tag: 'button',
      role: 'button',
      name: 'Add to bag',
      text: 'Add to bag',
      id: null,
      testId: null,
      classes: [],
      attributes: {},
      nearbyText: '',
      labelText: '',
      cssPath: 'body > button:nth-of-type(1)',
    };
    const escId = store.recordEscalation({
      runId: 'run-1',
      testId: 'shop.spec.ts::cart',
      stepId: 's1',
      question: {
        test: 'shop.spec.ts::cart',
        step: 's1',
        intent: 'Add to cart button',
        question: 'Which candidate matches?',
        candidates: [
          {
            label: 'A',
            descriptor: { kind: 'role', value: 'button', name: 'Add to bag', exact: true },
            confidence: 0.7,
            fingerprint: fp,
          },
        ],
        context: { url: '/products', classification: 'LOCATOR_DRIFT', screenshot: null },
      },
    });

    const app = await buildApp({ store, artifactsDir: dir, webDir: null, actor: 'tester' });

    const pending = await app.inject({ method: 'GET', url: '/api/escalations' });
    expect(pending.json()).toHaveLength(1);
    expect(pending.json()[0].id).toBe(escId);

    const answer = await app.inject({
      method: 'POST',
      url: `/api/escalations/${escId}/answer`,
      payload: { choice: 'A' },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().appliedDescriptor).toContain('Add to bag');
    // The answer wrote a HUMAN heal → one step is now ready to promote (3c glue).
    expect(answer.json().promotableCount).toBe(1);

    // The chosen candidate is now the cached primary → next run heals at Tier 0.
    expect(store.getCacheEntry('shop.spec.ts::cart', 's1')?.primary).toBeTruthy();
    // No longer pending.
    expect((await app.inject({ method: 'GET', url: '/api/escalations' })).json()).toHaveLength(0);

    // Re-answering the same escalation conflicts.
    const again = await app.inject({
      method: 'POST',
      url: `/api/escalations/${escId}/answer`,
      payload: { choice: 'A' },
    });
    expect(again.statusCode).toBe(409);

    // Unknown escalation → 404.
    const missing = await app.inject({
      method: 'POST',
      url: '/api/escalations/9999/answer',
      payload: { choice: 'A' },
    });
    expect(missing.statusCode).toBe(404);

    await app.close();
    store.close();
  });

  it('pushes SSE events on /api/events when an escalation is answered (D42)', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-server-'));
    const store = new SentinelStore(':memory:');
    store.ensureRun('run-1', 'sha-1', 'auto');
    const fp = {
      tag: 'button',
      role: 'button',
      name: 'Add to bag',
      text: 'Add to bag',
      id: null,
      testId: null,
      classes: [],
      attributes: {},
      nearbyText: '',
      labelText: '',
      cssPath: 'body > button:nth-of-type(1)',
    };
    const escId = store.recordEscalation({
      runId: 'run-1',
      testId: 'shop.spec.ts::cart',
      stepId: 's1',
      question: {
        test: 'shop.spec.ts::cart',
        step: 's1',
        intent: 'Add to cart button',
        question: 'Which candidate matches?',
        candidates: [
          {
            label: 'A',
            descriptor: { kind: 'role', value: 'button', name: 'Add to bag', exact: true },
            confidence: 0.7,
            fingerprint: fp,
          },
        ],
        context: { url: '/products', classification: 'LOCATOR_DRIFT', screenshot: null },
      },
    });

    const app = await buildApp({ store, artifactsDir: dir, webDir: null, actor: 'tester' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    // A real socket subscriber: the SSE reply is hijacked, so inject() can't see it.
    let received = '';
    const req = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      res.on('data', (chunk: Buffer) => (received += String(chunk)));
    });
    const until = async (predicate: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${received}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await until(() => received.includes(': connected'), 'the SSE handshake');

    const answer = await app.inject({
      method: 'POST',
      url: `/api/escalations/${escId}/answer`,
      payload: { choice: 'A' },
    });
    expect(answer.statusCode).toBe(200);

    await until(() => received.includes('event: escalation-answered'), 'the answered event');
    expect(received).toContain('"promotableCount":1');

    req.destroy();
    await app.close();
    store.close();
  });

  it('gates run triggering when the server has no full config (read-only mode)', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-server-'));
    const store = new SentinelStore(':memory:');
    const app = await buildApp({ store, artifactsDir: dir, webDir: null });

    expect((await app.inject({ method: 'GET', url: '/api/runs/active' })).json()).toEqual({
      running: false,
    });
    const post = await app.inject({ method: 'POST', url: '/api/runs', payload: {} });
    expect(post.statusCode).toBe(503);

    await app.close();
    store.close();
  });

  it('previews promotions and applies them to a git branch (no token → local commit)', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-server-'));
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    const store = new SentinelStore(':memory:');
    seedPromotableHeal(store, dir);
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });

    const app = await buildApp({
      store,
      artifactsDir: dir,
      webDir: null,
      loaded: loadedFor(dir),
    });

    // Preview is read-only: shows the ready plan + diff, touches nothing.
    const preview = await app.inject({ method: 'GET', url: '/api/promote/preview' });
    expect(preview.statusCode).toBe(200);
    const pv = preview.json();
    expect(pv.plans).toHaveLength(1);
    expect(pv.plans[0].status).toBe('ready');
    expect(pv.diff.join('\n')).toContain('Submit order');
    expect(readFileSync(path.join(dir, 'specs', 'shop.spec.ts'), 'utf8')).toContain('.btn-order');

    // Apply commits to a branch; no token → no PR.
    const apply = await app.inject({
      method: 'POST',
      url: '/api/promote/apply',
      payload: { push: false, branch: 'sentinel/test-apply' },
    });
    expect(apply.statusCode).toBe(200);
    const res = apply.json();
    expect(res.applied).toBe(1);
    expect(res.committed).toBe(true);
    expect(res.prUrl).toBeNull();
    expect(res.branch).toBe('sentinel/test-apply');
    expect(readFileSync(path.join(dir, 'specs', 'shop.spec.ts'), 'utf8')).toContain(
      "getByRole('button', { name: 'Submit order', exact: true })",
    );

    await app.close();
    store.close();
  });

  it('gates promotion when the server has no full config', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-server-'));
    const store = new SentinelStore(':memory:');
    const app = await buildApp({ store, artifactsDir: dir, webDir: null });
    expect((await app.inject({ method: 'GET', url: '/api/promote/preview' })).statusCode).toBe(503);
    await app.close();
    store.close();
  });

  it('reports no-runs on an empty store', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-server-'));
    const store = new SentinelStore(':memory:');
    const app = await buildApp({ store, artifactsDir: dir, webDir: null });

    const summary = await app.inject({ method: 'GET', url: '/api/summary' });
    expect(summary.json().status).toBe('no-runs');
    const runs = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(runs.json()).toEqual([]);

    await app.close();
    store.close();
  });
});
