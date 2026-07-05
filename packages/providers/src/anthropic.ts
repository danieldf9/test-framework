import {
  LLMProviderError,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from './types.js';

export interface AnthropicOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  supportsVision: boolean;
  fetchImpl?: typeof fetch;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

function toAnthropicPayload(messages: LLMMessage[], vision: boolean) {
  // Messages API takes system prompts as a top-level field, not a message role.
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const blocks: AnthropicBlock[] = [{ type: 'text', text: m.content }];
      if (m.role === 'user' && vision && m.images) {
        for (const img of m.images) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
          });
        }
      }
      return { role: m.role, content: blocks };
    });
  return { system: system || undefined, messages: rest };
}

/** Anthropic Messages API adapter (spec §2 adapter #1). JSON output is enforced
 * by prompting + downstream Zod validation (the API has no json_object mode). */
export function createAnthropicProvider(opts: AnthropicOptions): LLMProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  return {
    name: 'anthropic',
    model: opts.model,
    supportsVision: opts.supportsVision,
    async complete(request: LLMRequest): Promise<LLMResponse> {
      const started = Date.now();
      const { system, messages } = toAnthropicPayload(request.messages, opts.supportsVision);
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: request.maxTokens ?? 1024,
            temperature: request.temperature ?? 0,
            ...(system ? { system } : {}),
            messages,
          }),
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
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
      };
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      if (!text) throw new LLMProviderError('malformed response: no text content blocks');
      return {
        text,
        model: data.model ?? opts.model,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        latencyMs: Date.now() - started,
      };
    },
  };
}
