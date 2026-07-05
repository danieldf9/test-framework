import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SentinelStore } from '@sentinel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { generateReport } from '../src/index.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function seeded(shotPath: string | null): SentinelStore {
  const store = new SentinelStore(':memory:');
  store.ensureRun('run-1', 'sha-1', 'auto');
  store.finishRun('run-1', 'passed_unverified', { tests: 2 });
  store.recordTestResult({
    runId: 'run-1',
    testId: 't-checkout',
    title: 'checkout flow',
    file: 'shop.spec.ts',
    status: 'passed_unverified',
    durationMs: 1234,
    error: null,
    flakyTagged: false,
  });
  store.recordHeal({
    runId: 'run-1',
    testId: 't-checkout',
    stepId: 's1',
    intent: 'Place order submit button',
    oldLocator: "locator('.btn-order')",
    newLocator: "getByRole('button', { name: 'Submit order' })",
    tier: 3,
    confidence: 0.87,
    mode: 'UNVERIFIED',
    reasoning: 'vision agrees with the DOM answer',
    screenshotBefore: shotPath,
    screenshotAfter: null,
    gitSha: 'sha-1',
  });
  store.recordLlmCall({
    runId: 'run-1',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    purpose: 'heal-tier3-vision',
    inputTokens: 900,
    outputTokens: 60,
    costUsd: 0.0123,
    latencyMs: 1500,
    ok: true,
    error: null,
  });
  // flaky signal: pass + fail on the same sha
  store.recordFlakeStat('t-flaky', 'sha-1', 'run-0', 'passed');
  store.recordFlakeStat('t-flaky', 'sha-1', 'run-1', 'failed');
  return store;
}

describe('generateReport (spec §8)', () => {
  it('renders results, heals with locator diff + screenshots, flake dashboard, cost summary', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-report-'));
    const shot = path.join(dir, 'before.jpg');
    writeFileSync(shot, Buffer.from('fake-jpeg'));

    const store = seeded(shot);
    const result = generateReport(store, { outDir: path.join(dir, 'report') });
    const html = readFileSync(result.indexPath, 'utf8');

    expect(result.runsIncluded).toBe(1);
    // results
    expect(html).toContain('checkout flow');
    expect(html).toContain('passed_unverified');
    // heal audit with locator diff
    expect(html).toContain("locator('.btn-order')");
    expect(html).toContain('Submit order');
    expect(html).toContain('tier 3');
    expect(html).toContain('vision agrees');
    // screenshot copied into the report dir (portable artifact)
    const imgMatch = html.match(/assets\/[a-f0-9]{12}\.jpg/);
    expect(imgMatch).not.toBeNull();
    expect(readFileSync(path.join(dir, 'report', imgMatch![0]!), 'utf8')).toBe('fake-jpeg');
    // flake dashboard
    expect(html).toContain('t-flaky');
    expect(html).toContain('@flaky');
    // llm cost summary
    expect(html).toContain('gemini/gemini-2.5-flash');
    expect(html).toContain('$0.0123');
    store.close();
  });

  it('renders an empty state without crashing', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-report-'));
    const store = new SentinelStore(':memory:');
    const result = generateReport(store, { outDir: path.join(dir, 'report') });
    const html = readFileSync(result.indexPath, 'utf8');
    expect(html).toContain('no runs recorded');
    expect(html).toContain('no LLM calls recorded');
    store.close();
  });
});
