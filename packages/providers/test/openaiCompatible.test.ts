import { describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleProvider } from '../src/openaiCompatible.js';
import { LLMProviderError } from '../src/types.js';

function okResponse(content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage, model: 'test-model-1' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeProvider(fetchImpl: typeof fetch, overrides = {}) {
  return createOpenAICompatibleProvider({
    baseUrl: 'http://localhost:9999/v1/',
    model: 'test-model',
    apiKey: 'sk-test',
    timeoutMs: 5_000,
    supportsVision: false,
    fetchImpl,
    ...overrides,
  });
}

describe('openai-compatible adapter', () => {
  it('maps messages, jsonMode and auth header onto Chat Completions', async () => {
    const fetchMock = vi.fn(async () => okResponse('{"x":1}'));
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    const res = await provider.complete({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
      jsonMode: true,
      maxTokens: 256,
      purpose: 'unit-test',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:9999/v1/chat/completions'); // trailing slash normalized
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
    expect(body.temperature).toBe(0); // deterministic by default
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');

    expect(res.text).toBe('{"x":1}');
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(20);
    expect(res.model).toBe('test-model-1');
  });

  it('sends images as data-URL content parts when vision is supported', async () => {
    const fetchMock = vi.fn(async () => okResponse('ok'));
    const provider = makeProvider(fetchMock as unknown as typeof fetch, { supportsVision: true });
    await provider.complete({
      messages: [
        {
          role: 'user',
          content: 'what is this?',
          images: [{ mediaType: 'image/jpeg', base64: 'QUJD' }],
        },
      ],
      purpose: 'unit-test',
    });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
    ]);
  });

  it('drops images (text only) when supportsVision is false', async () => {
    const fetchMock = vi.fn(async () => okResponse('ok'));
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    await provider.complete({
      messages: [
        { role: 'user', content: 'text', images: [{ mediaType: 'image/png', base64: 'x' }] },
      ],
      purpose: 'unit-test',
    });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages[0].content).toBe('text');
  });

  it('omits the auth header without an api key (local backends)', async () => {
    const fetchMock = vi.fn(async () => okResponse('ok'));
    const provider = makeProvider(fetchMock as unknown as typeof fetch, { apiKey: undefined });
    await provider.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'unit-test' });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('throws LLMProviderError with status on non-200', async () => {
    const fetchMock = vi.fn(async () => new Response('quota exceeded', { status: 429 }));
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'unit-test' }),
    ).rejects.toMatchObject({ name: 'LLMProviderError', status: 429 });
  });

  it('throws on structurally malformed success responses', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const provider = makeProvider(fetchMock as unknown as typeof fetch);
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'unit-test' }),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });
});
