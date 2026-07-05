import { describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from '../src/anthropic.js';
import { createGeminiProvider } from '../src/gemini.js';
import { LLMProviderError } from '../src/types.js';

const REQ = {
  messages: [
    { role: 'system' as const, content: 'be terse' },
    {
      role: 'user' as const,
      content: 'pick one',
      images: [{ mediaType: 'image/jpeg', base64: 'QUJD' }],
    },
    { role: 'assistant' as const, content: 'previous reply' },
    { role: 'user' as const, content: 'repair please' },
  ],
  jsonMode: true,
  maxTokens: 512,
  purpose: 'unit-test',
};

describe('anthropic adapter (Messages API)', () => {
  const ok = () =>
    new Response(
      JSON.stringify({
        content: [
          { type: 'text', text: '{"a":' },
          { type: 'text', text: '1}' },
        ],
        usage: { input_tokens: 50, output_tokens: 9 },
        model: 'claude-sonnet-5',
      }),
      { status: 200 },
    );

  it('maps system to top-level, images to base64 blocks, joins text blocks', async () => {
    const fetchMock = vi.fn(async () => ok());
    const p = createAnthropicProvider({
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant',
      timeoutMs: 5000,
      supportsVision: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const res = await p.complete(REQ);

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('be terse');
    expect(body.max_tokens).toBe(512);
    expect(body.messages).toHaveLength(3); // system extracted
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'pick one' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    ]);
    expect(body.messages[1].role).toBe('assistant');

    expect(res.text).toBe('{"a":1}'); // text blocks joined
    expect(res.inputTokens).toBe(50);
    expect(res.outputTokens).toBe(9);
  });

  it('throws LLMProviderError with status on API errors', async () => {
    const fetchMock = vi.fn(async () => new Response('overloaded', { status: 529 }));
    const p = createAnthropicProvider({
      model: 'm',
      apiKey: 'k',
      timeoutMs: 5000,
      supportsVision: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(p.complete(REQ)).rejects.toMatchObject({
      name: 'LLMProviderError',
      status: 529,
    });
  });
});

describe('gemini adapter (generateContent)', () => {
  const ok = () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"b":' }, { text: '2}' }] } }],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 7 },
        modelVersion: 'gemini-2.5-flash',
      }),
      { status: 200 },
    );

  it('maps roles (assistant→model), system_instruction, inlineData and jsonMode', async () => {
    const fetchMock = vi.fn(async () => ok());
    const p = createGeminiProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'g-key',
      timeoutMs: 5000,
      supportsVision: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const res = await p.complete(REQ);

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.maxOutputTokens).toBe(512);
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts).toEqual([
      { text: 'pick one' },
      { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } },
    ]);
    expect(body.contents[1].role).toBe('model'); // assistant mapped

    expect(res.text).toBe('{"b":2}');
    expect(res.inputTokens).toBe(40);
    expect(res.outputTokens).toBe(7);
  });

  it('throws on empty candidates', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    );
    const p = createGeminiProvider({
      model: 'm',
      apiKey: 'k',
      timeoutMs: 5000,
      supportsVision: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(p.complete(REQ)).rejects.toBeInstanceOf(LLMProviderError);
  });
});
