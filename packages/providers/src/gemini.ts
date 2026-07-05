import {
  LLMProviderError,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from './types.js';

export interface GeminiOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  supportsVision: boolean;
  fetchImpl?: typeof fetch;
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function toGeminiPayload(messages: LLMMessage[], vision: boolean) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const parts: GeminiPart[] = [{ text: m.content }];
      if (m.role === 'user' && vision && m.images) {
        for (const img of m.images) {
          parts.push({ inlineData: { mimeType: img.mediaType, data: img.base64 } });
        }
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });
  return { system, contents };
}

/** Google Gemini generateContent adapter (spec §2 adapter #3). */
export function createGeminiProvider(opts: GeminiOptions): LLMProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  return {
    name: 'gemini',
    model: opts.model,
    supportsVision: opts.supportsVision,
    async complete(request: LLMRequest): Promise<LLMResponse> {
      const started = Date.now();
      const { system, contents } = toGeminiPayload(request.messages, opts.supportsVision);
      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: request.temperature ?? 0,
          maxOutputTokens: request.maxTokens ?? 1024,
          ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };

      let res: Response;
      try {
        res = await fetchImpl(
          `${baseUrl}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-goog-api-key': opts.apiKey,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(opts.timeoutMs),
          },
        );
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
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        modelVersion?: string;
      };
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) {
        throw new LLMProviderError('malformed response: no candidate text parts');
      }
      return {
        text,
        model: data.modelVersion ?? opts.model,
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs: Date.now() - started,
      };
    },
  };
}
