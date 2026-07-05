import { describe, expect, it } from 'vitest';
import { createProvider } from '../src/factory.js';

const base = {
  timeoutMs: 1000,
  maxRetries: 2,
  backoffBaseMs: 1,
  circuitBreakerThreshold: 3,
  inputCostPerMTok: 0,
  outputCostPerMTok: 0,
};

describe('createProvider (config + env selection, zero code changes)', () => {
  it("provider 'none' → deterministic-only, no reason needed", () => {
    const r = createProvider({ ...base, provider: 'none' });
    expect(r.provider).toBeNull();
    expect(r.disabledReason).toBeNull();
  });

  it('cloud endpoint without an API key degrades gracefully with a reason', () => {
    const r = createProvider({
      ...base,
      provider: 'openai-compatible',
      model: 'gpt-x',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(r.provider).toBeNull();
    expect(r.disabledReason).toMatch(/no API key.*deterministic-only/i);
  });

  it('local backends (Ollama/LM Studio) work keyless', () => {
    const r = createProvider({
      ...base,
      provider: 'openai-compatible',
      model: 'llama3',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(r.provider).not.toBeNull();
    expect(r.provider!.supportsVision).toBe(false); // unknown backends default to no vision
  });

  it("'openai' is a preset: default baseUrl + vision on", () => {
    const r = createProvider({ ...base, provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k' });
    expect(r.provider).not.toBeNull();
    expect(r.provider!.name).toBe('openai');
    expect(r.provider!.supportsVision).toBe(true);
  });

  it('missing model disables with a reason instead of failing later', () => {
    const r = createProvider({
      ...base,
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
    });
    expect(r.provider).toBeNull();
    expect(r.disabledReason).toMatch(/model/i);
  });

  it('anthropic/gemini native adapters wire up with vision on by default', () => {
    const a = createProvider({
      ...base,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'k',
    });
    expect(a.provider).not.toBeNull();
    expect(a.provider!.name).toBe('anthropic');
    expect(a.provider!.supportsVision).toBe(true);

    const g = createProvider({
      ...base,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'k',
    });
    expect(g.provider).not.toBeNull();
    expect(g.provider!.name).toBe('gemini');
    expect(g.provider!.supportsVision).toBe(true);
  });

  it('native cloud adapters without a key degrade with a reason', () => {
    const r = createProvider({ ...base, provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(r.provider).toBeNull();
    expect(r.disabledReason).toMatch(/no API key.*deterministic-only/i);
  });
});
