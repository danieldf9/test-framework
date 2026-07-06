import {
  CircuitOpenError,
  type LLMCallRecord,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from './types.js';

export interface ResilienceOptions {
  /** Attempts = maxRetries + 1. */
  maxRetries: number;
  /** Deterministic exponential backoff: backoffBaseMs * 2^attempt (no jitter —
   * heal decisions must be replayable from the audit log). */
  backoffBaseMs: number;
  /** Consecutive failures before the circuit opens for the rest of the run. */
  circuitBreakerThreshold: number;
  /** Cost accounting: USD per million tokens (0 for local/unknown backends). */
  inputCostPerMTok: number;
  outputCostPerMTok: number;
}

export interface ResilienceHooks {
  /** Called once per attempt (success or failure) — one llm_calls row each. */
  onCall?: (record: LLMCallRecord) => void;
  /** Called once when the circuit transitions to open. */
  onCircuitOpen?: () => void;
}

export interface ResilientProvider extends LLMProvider {
  readonly circuitOpen: boolean;
}

/**
 * Wraps a provider with retries, deterministic backoff, cost accounting, and a
 * circuit breaker (spec §2): after N consecutive failures the circuit opens and
 * every subsequent call fails instantly — the pipeline degrades to
 * deterministic-only healing and NEVER hangs on a dead endpoint.
 * (Per-request timeouts live inside the adapters via AbortSignal.)
 */
export function withResilience(
  inner: LLMProvider,
  opts: ResilienceOptions,
  hooks: ResilienceHooks = {},
): ResilientProvider {
  let consecutiveFailures = 0;
  let open = false;

  const record = (
    request: LLMRequest,
    partial: Pick<LLMCallRecord, 'inputTokens' | 'outputTokens' | 'latencyMs' | 'ok' | 'error'>,
  ) => {
    const costUsd =
      (partial.inputTokens / 1_000_000) * opts.inputCostPerMTok +
      (partial.outputTokens / 1_000_000) * opts.outputCostPerMTok;
    hooks.onCall?.({
      provider: inner.name,
      model: inner.model,
      purpose: request.purpose,
      costUsd,
      ...partial,
    });
  };

  return {
    name: inner.name,
    model: inner.model,
    supportsVision: inner.supportsVision,
    get circuitOpen() {
      return open;
    },
    async complete(request: LLMRequest): Promise<LLMResponse> {
      const failFast = (): never => {
        const err = new CircuitOpenError(inner.name, consecutiveFailures);
        record(request, {
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          ok: false,
          error: err.message,
        });
        throw err;
      };
      if (open) failFast();
      let lastError: Error = new Error('no attempts made');
      for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, opts.backoffBaseMs * 2 ** (attempt - 1)));
        }
        // A concurrent request (e.g. Promise.all of several heals) may have
        // tripped the breaker while this one awaited — stop retrying too.
        if (open) failFast();
        const started = Date.now();
        try {
          const response = await inner.complete(request);
          // The circuit stays open for the rest of the run: a straggler success
          // from a request that was in flight when it tripped must not zero the
          // failure count reported by subsequent CircuitOpenErrors.
          if (!open) consecutiveFailures = 0;
          record(request, {
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            latencyMs: response.latencyMs,
            ok: true,
            error: null,
          });
          return response;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          consecutiveFailures++;
          record(request, {
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - started,
            ok: false,
            error: lastError.message.slice(0, 500),
          });
          if (consecutiveFailures >= opts.circuitBreakerThreshold) {
            if (!open) {
              open = true;
              hooks.onCircuitOpen?.();
            }
            break;
          }
        }
      }
      throw lastError;
    },
  };
}
