import {
  LLMProviderError,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from './types.js';

export interface OpenAICompatibleOptions {
  /** e.g. https://api.openai.com/v1, http://localhost:11434/v1 (Ollama),
   * https://openrouter.ai/api/v1, LM Studio, Z.ai/GLM, Kimi, ... */
  baseUrl: string;
  model: string;
  /** Optional — local backends (Ollama, LM Studio) need no key. */
  apiKey?: string;
  timeoutMs: number;
  supportsVision: boolean;
  /** Display name for audit rows; defaults to 'openai-compatible'. */
  name?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

function toOpenAIMessages(messages: LLMMessage[], vision: boolean): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'user' && vision && m.images && m.images.length > 0) {
      const parts: OpenAIContentPart[] = [{ type: 'text', text: m.content }];
      for (const img of m.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        });
      }
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Generic OpenAI-compatible Chat Completions adapter (spec §2 adapter #4).
 * Works against any backend exposing POST {baseUrl}/chat/completions.
 */
export function createOpenAICompatibleProvider(opts: OpenAICompatibleOptions): LLMProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  return {
    name: opts.name ?? 'openai-compatible',
    model: opts.model,
    supportsVision: opts.supportsVision,
    async complete(request: LLMRequest): Promise<LLMResponse> {
      const started = Date.now();
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: toOpenAIMessages(request.messages, opts.supportsVision),
        temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens ?? 1024,
      };
      if (request.jsonMode) {
        // Best-effort: many compatible backends honor this, some ignore it.
        // Sentinel always Zod-validates + repair-retries regardless.
        body.response_format = { type: 'json_object' };
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new LLMProviderError(
          /abort|timeout/i.test(msg)
            ? `request timed out after ${opts.timeoutMs}ms`
            : `network error: ${msg}`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LLMProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new LLMProviderError('malformed response: choices[0].message.content missing');
      }
      return {
        text,
        model: data.model ?? opts.model,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
      };
    },
  };
}
