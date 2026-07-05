import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, SentinelConfigSchema } from '../src/config.js';

describe('SentinelConfigSchema (Zod validation)', () => {
  it('fills spec defaults from an empty config', () => {
    const c = SentinelConfigSchema.parse({});
    expect(c.healing.mode).toBe('auto');
    expect(c.healing.tier1Threshold).toBe(0.85);
    expect(c.healing.autoApplyThreshold).toBe(0.9);
    expect(c.healing.applyFloor).toBe(0.6);
    expect(c.healing.maxHealsPerTest).toBe(3);
    expect(c.healing.maxHealsPerRun).toBe(20);
    expect(c.testIdAttribute).toBe('data-testid');
    expect(c.llm.provider).toBe('none');
  });

  it('rejects invalid heal modes', () => {
    expect(() => SentinelConfigSchema.parse({ healing: { mode: 'yolo' } })).toThrow();
  });

  it('never allows the assertion guard below 0.5 (golden rule)', () => {
    expect(() => SentinelConfigSchema.parse({ diagnosis: { assertionTextGuard: 0.1 } })).toThrow();
  });
});

describe('loadConfig', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.SENTINEL_HEAL;
  });

  it('loads a config file and applies env overrides', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
    writeFileSync(
      path.join(dir, 'sentinel.config.mjs'),
      `export default { healing: { mode: 'suggest' } };`,
    );
    const loaded = await loadConfig(dir);
    expect(loaded.config.healing.mode).toBe('suggest');
    expect(loaded.dbPath).toBe(path.join(dir, '.sentinel', 'sentinel.db'));

    process.env.SENTINEL_HEAL = 'off';
    const overridden = await loadConfig(dir);
    expect(overridden.config.healing.mode).toBe('off');
  });

  it('loads .env (nearest, fill-only) — real env vars always win', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
    writeFileSync(
      path.join(dir, '.env'),
      [
        '# comment',
        'SENTINEL_LLM_PROVIDER=openai-compatible',
        'SENTINEL_LLM_MODEL="gemma-4-31b-it"',
        'SENTINEL_LLM_BASE_URL=http://localhost:11434/v1',
      ].join('\n'),
    );
    try {
      process.env.SENTINEL_LLM_PROVIDER = 'none'; // explicit env beats .env
      const loaded = await loadConfig(dir);
      expect(loaded.config.llm.provider).toBe('none');
      expect(loaded.config.llm.model).toBe('gemma-4-31b-it'); // quotes stripped
      expect(loaded.config.llm.baseUrl).toBe('http://localhost:11434/v1');
    } finally {
      delete process.env.SENTINEL_LLM_PROVIDER;
      delete process.env.SENTINEL_LLM_MODEL;
      delete process.env.SENTINEL_LLM_BASE_URL;
    }
  });
});
