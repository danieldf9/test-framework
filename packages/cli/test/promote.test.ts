import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SentinelStore } from '@sentinel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPromotions, buildLocatorPattern, planPromotions } from '../src/promote.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function seed(
  store: SentinelStore,
  testId: string,
  stepId: string,
  oldLoc: string,
  newPrimary: Parameters<SentinelStore['upsertCacheEntry']>[0]['primary'],
) {
  store.ensureRun('r1', 'sha', 'auto');
  store.recordHeal({
    runId: 'r1',
    testId,
    stepId,
    intent: `intent for ${stepId}`,
    oldLocator: oldLoc,
    newLocator: 'stale-will-be-overridden-by-cache',
    tier: 1,
    confidence: 0.92,
    mode: 'AUTO',
    reasoning: 'r',
    screenshotBefore: null,
    screenshotAfter: null,
    gitSha: 'sha',
  });
  store.upsertCacheEntry({
    testId,
    stepId,
    primary: newPrimary,
    alternates: [],
    fingerprint: {
      tag: 'button',
      role: 'button',
      name: 'x',
      text: 'x',
      id: null,
      testId: null,
      classes: [],
      attributes: {},
      nearbyText: '',
      labelText: '',
      cssPath: 'body > button:nth-of-type(1)',
    },
    intent: `intent for ${stepId}`,
    lastVerifiedAt: Date.now(),
  });
}

describe('buildLocatorPattern', () => {
  it('tolerates quote and whitespace differences', () => {
    const p = buildLocatorPattern(`getByLabel('Email', { exact: true })`);
    expect(`page.getByLabel("Email", {exact: true}).fill('x')`).toMatch(p);
    expect(`page.getByLabel('Email', { exact: true })`).toMatch(p);
    expect(`page.getByLabel('Name', { exact: true })`).not.toMatch(p);
  });
});

describe('planPromotions + applyPromotions (spec §4/§8 promote)', () => {
  it('writes the cache primary back into the spec and marks heals promoted', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-promote-'));
    mkdirSync(path.join(dir, 'specs'));
    const spec = path.join(dir, 'specs', 'shop.spec.ts');
    writeFileSync(
      spec,
      `await s.click({ locator: page.locator('.btn-order'), intent: 'Place order button' });\n`,
    );
    const store = new SentinelStore(':memory:');
    seed(store, 'specs/shop.spec.ts::checkout', 's1', `locator('.btn-order')`, {
      kind: 'role',
      value: 'button',
      name: 'Submit order',
      exact: true,
    });

    const plans = planPromotions(store, dir);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.status).toBe('ready');
    expect(plans[0]!.occurrences).toBe(1);

    // dry preview leaves the file alone
    applyPromotions(store, plans, { write: false });
    expect(readFileSync(spec, 'utf8')).toContain(`.btn-order`);

    const result = applyPromotions(store, plans, { write: true });
    expect(result.applied).toBe(1);
    const content = readFileSync(spec, 'utf8');
    expect(content).toContain(`page.getByRole('button', { name: 'Submit order', exact: true })`);
    expect(content).not.toContain('.btn-order');
    // expected values are untouched; only the locator expression moved
    expect(content).toContain(`intent: 'Place order button'`);

    expect(planPromotions(store, dir)).toHaveLength(0); // promoted flag set → idempotent
    store.close();
  });

  it('skips promotions that would create an ambiguous locator (distinct olds → same new)', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-promote-'));
    mkdirSync(path.join(dir, 'specs'));
    writeFileSync(
      path.join(dir, 'specs', 'shop.spec.ts'),
      `page.locator('#add-1'); page.getByTestId('add-2');\n`,
    );
    const store = new SentinelStore(':memory:');
    const samePrimary = { kind: 'role', value: 'button', name: 'Add to bag', exact: true } as const;
    seed(store, 'specs/shop.spec.ts::t1', 's1', `locator('#add-1')`, samePrimary);
    seed(store, 'specs/shop.spec.ts::t2', 's2', `getByTestId('add-2')`, samePrimary);

    const plans = planPromotions(store, dir);
    expect(plans).toHaveLength(2);
    expect(plans.every((p) => p.status === 'conflict')).toBe(true);
    expect(plans[0]!.note).toMatch(/ambiguous/);
    expect(applyPromotions(store, plans, { write: true }).applied).toBe(0);
    store.close();
  });

  it('reports locators that no longer exist in the source', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-promote-'));
    mkdirSync(path.join(dir, 'specs'));
    writeFileSync(path.join(dir, 'specs', 'shop.spec.ts'), `page.locator('#renamed');\n`);
    const store = new SentinelStore(':memory:');
    seed(store, 'specs/shop.spec.ts::t1', 's1', `locator('#gone')`, {
      kind: 'css',
      value: '#new',
    });
    const plans = planPromotions(store, dir);
    expect(plans[0]!.status).toBe('not-found');
    store.close();
  });

  it('UNVERIFIED heals need explicit opt-in', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-promote-'));
    const store = new SentinelStore(':memory:');
    store.ensureRun('r1', null, 'auto');
    store.recordHeal({
      runId: 'r1',
      testId: 'specs/x.spec.ts::t',
      stepId: 's1',
      intent: 'i',
      oldLocator: `locator('#a')`,
      newLocator: `locator('#b')`,
      tier: 2,
      confidence: 0.7,
      mode: 'UNVERIFIED',
      reasoning: '',
      screenshotBefore: null,
      screenshotAfter: null,
      gitSha: null,
    });
    expect(planPromotions(store, dir)).toHaveLength(0);
    const withFlag = planPromotions(store, dir, { includeUnverified: true });
    expect(withFlag).toHaveLength(1); // (missing-file status, but planned)
    store.close();
  });
});
