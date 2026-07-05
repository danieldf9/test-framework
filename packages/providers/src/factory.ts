import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';
import { withResilience, type ResilienceHooks, type ResilientProvider } from './resilience.js';
import type { LLMProvider } from './types.js';

export type ProviderKind = 'none' | 'anthropic' | 'openai' | 'gemini' | 'openai-compatible';

export interface ProviderFactoryOptions {
  provider: ProviderKind;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  circuitBreakerThreshold: number;
  supportsVision?: boolean;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface ProviderSetup {
  provider: ResilientProvider | null;
  /** Human-readable reason when provider is null despite being configured. */
  disabledReason: string | null;
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Builds the configured provider wrapped in resilience, or explains why
 * healing runs deterministic-only. Selection is pure config + env — switching
 * providers never requires code changes (spec §2).
 */
export function createProvider(
  opts: ProviderFactoryOptions,
  hooks: ResilienceHooks = {},
): ProviderSetup {
  if (opts.provider === 'none') return { provider: null, disabledReason: null };

  if (!opts.model) {
    return { provider: null, disabledReason: 'llm.model is not set — running deterministic-only' };
  }

  let inner: LLMProvider;
  if (opts.provider === 'anthropic' || opts.provider === 'gemini') {
    // Native cloud APIs — a key is mandatory (spec §9 graceful degradation).
    if (!opts.apiKey) {
      return {
        provider: null,
        disabledReason: `no API key present for ${opts.provider} — deterministic-only mode (Tiers 0-1)`,
      };
    }
    const common = {
      model: opts.model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs,
      supportsVision: opts.supportsVision ?? true,
      fetchImpl: opts.fetchImpl,
    };
    inner =
      opts.provider === 'anthropic'
        ? createAnthropicProvider(common)
        : createGeminiProvider(common);
  } else {
    // 'openai' is Chat Completions — a preset of the generic adapter.
    const baseUrl =
      opts.baseUrl ?? (opts.provider === 'openai' ? 'https://api.openai.com/v1' : undefined);
    if (!baseUrl) {
      return {
        provider: null,
        disabledReason: 'llm.baseUrl is not set for openai-compatible — running deterministic-only',
      };
    }
    // Cloud endpoints without a key would only burn retries on 401s; local
    // backends (Ollama, LM Studio) need no key.
    if (!opts.apiKey && !isLocalUrl(baseUrl)) {
      return {
        provider: null,
        disabledReason: `no API key present for ${baseUrl} — deterministic-only mode (Tiers 0-1)`,
      };
    }
    inner = createOpenAICompatibleProvider({
      baseUrl,
      model: opts.model,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      supportsVision: opts.supportsVision ?? (opts.provider === 'openai' ? true : false),
      name: opts.provider,
      fetchImpl: opts.fetchImpl,
    });
  }
  return {
    provider: withResilience(
      inner,
      {
        maxRetries: opts.maxRetries,
        backoffBaseMs: opts.backoffBaseMs,
        circuitBreakerThreshold: opts.circuitBreakerThreshold,
        inputCostPerMTok: opts.inputCostPerMTok,
        outputCostPerMTok: opts.outputCostPerMTok,
      },
      hooks,
    ),
    disabledReason: null,
  };
}
