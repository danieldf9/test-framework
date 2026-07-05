/** Image input for vision-capable providers. */
export interface LLMImage {
  /** e.g. 'image/jpeg', 'image/png' */
  mediaType: string;
  base64: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Only meaningful on user messages; ignored by non-vision providers. */
  images?: LLMImage[];
}

export interface LLMRequest {
  messages: LLMMessage[];
  /** Ask the provider for structured JSON output (best-effort; callers must
   * still validate — Sentinel Zod-validates every response). */
  jsonMode?: boolean;
  maxTokens?: number;
  /** Defaults to 0 for reproducibility. */
  temperature?: number;
  /** Audit label written to llm_calls (e.g. 'heal-tier2', 'classify', 'doctor-ping'). */
  purpose: string;
}

export interface LLMResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * The single-method provider abstraction (spec §2). Adapters translate this
 * to Anthropic Messages / OpenAI Chat Completions / Gemini generateContent /
 * any OpenAI-compatible backend.
 */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly supportsVision: boolean;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

/** One audited provider call (one row in llm_calls, including failed attempts). */
export interface LLMCallRecord {
  provider: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  error: string | null;
}

export class LLMProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}

/** Thrown immediately (no network) while the circuit breaker is open. */
export class CircuitOpenError extends Error {
  constructor(provider: string, failures: number) {
    super(
      `LLM circuit breaker open for ${provider} after ${failures} consecutive failures — healing degraded to deterministic-only for this run`,
    );
    this.name = 'CircuitOpenError';
  }
}
