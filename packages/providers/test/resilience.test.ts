import { describe, expect, it, vi } from 'vitest';
import { withResilience } from '../src/resilience.js';
import { CircuitOpenError, type LLMCallRecord, type LLMProvider } from '../src/types.js';

function flaky(failuresBeforeSuccess: number): LLMProvider {
  let calls = 0;
  return {
    name: 'fake',
    model: 'fake-1',
    supportsVision: false,
    async complete() {
      calls++;
      if (calls <= failuresBeforeSuccess) throw new Error(`boom ${calls}`);
      return {
        text: 'ok',
        model: 'fake-1',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        latencyMs: 5,
      };
    },
  };
}

const baseOpts = {
  maxRetries: 2,
  backoffBaseMs: 1,
  circuitBreakerThreshold: 3,
  inputCostPerMTok: 2,
  outputCostPerMTok: 8,
};

const req = { messages: [{ role: 'user' as const, content: 'x' }], purpose: 'test' };

describe('withResilience', () => {
  it('retries with backoff and succeeds; every attempt is audited', async () => {
    const records: LLMCallRecord[] = [];
    const p = withResilience(flaky(2), baseOpts, { onCall: (r) => records.push(r) });
    const res = await p.complete(req);
    expect(res.text).toBe('ok');
    expect(records.map((r) => r.ok)).toEqual([false, false, true]);
    // cost accounting: 1M input @ $2/MTok + 0.5M output @ $8/MTok = $6
    expect(records[2]!.costUsd).toBeCloseTo(6);
    expect(records[2]!.purpose).toBe('test');
  });

  it('opens the circuit after N consecutive failures and fails fast afterwards', async () => {
    const onCircuitOpen = vi.fn();
    const records: LLMCallRecord[] = [];
    const p = withResilience(flaky(999), baseOpts, {
      onCall: (r) => records.push(r),
      onCircuitOpen,
    });

    await expect(p.complete(req)).rejects.toThrow('boom');
    expect(p.circuitOpen).toBe(true);
    expect(onCircuitOpen).toHaveBeenCalledTimes(1);

    // Subsequent calls never touch the network: instant CircuitOpenError.
    const started = Date.now();
    await expect(p.complete(req)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(Date.now() - started).toBeLessThan(50);
    expect(records.some((r) => /circuit breaker open/i.test(r.error ?? ''))).toBe(true);
  });

  it('a success resets the consecutive-failure counter', async () => {
    let fail = true;
    const inner: LLMProvider = {
      name: 'fake',
      model: 'fake-1',
      supportsVision: false,
      async complete() {
        if (fail) throw new Error('boom');
        return { text: 'ok', model: 'fake-1', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
      },
    };
    const p = withResilience(inner, { ...baseOpts, circuitBreakerThreshold: 4, maxRetries: 1 });
    // 2 failures (attempt+retry), then success, then 2 more failures — circuit
    // must stay closed because the success reset the streak (2+2 < 4 only with reset).
    await expect(p.complete(req)).rejects.toThrow();
    fail = false;
    await p.complete(req);
    fail = true;
    await expect(p.complete(req)).rejects.toThrow();
    expect(p.circuitOpen).toBe(false);
  });
});
