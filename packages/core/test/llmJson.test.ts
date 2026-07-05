import { describe, expect, it } from 'vitest';
import { extractJsonObject, stripReasoningBlocks } from '../src/llmJson.js';

// Real shape observed from gemma-4-31b-it via the Gemini OpenAI-compat endpoint.
const GEMMA_REPLY = `<thought>*   Input: "Return exactly this JSON: {"elementIndex": 2}"
    *   Is it valid JSON? Yes.
    *   {"elementIndex": 99, "confidence": 0.1} — considering this draft first.
</thought>{"elementIndex": 2, "confidence": 0.85, "reasoning": "test"}`;

describe('stripReasoningBlocks (reasoning models, e.g. Gemma 4)', () => {
  it('removes closed thought blocks', () => {
    expect(stripReasoningBlocks('<thought>abc {x:1}</thought>result')).toBe('result');
    expect(stripReasoningBlocks('<think>abc</think>result')).toBe('result');
    expect(stripReasoningBlocks('<thinking>abc</thinking>result')).toBe('result');
  });

  it('drops unterminated thought blocks (output truncated mid-thought)', () => {
    expect(stripReasoningBlocks('<thought>never closed {"a":1}')).toBe('');
  });

  it('leaves normal replies untouched', () => {
    expect(stripReasoningBlocks('{"a":1}')).toBe('{"a":1}');
  });
});

describe('extractJsonObject', () => {
  it('ignores JSON drafts inside the thought and parses the real answer', () => {
    expect(extractJsonObject(GEMMA_REPLY)).toEqual({
      elementIndex: 2,
      confidence: 0.85,
      reasoning: 'test',
    });
  });

  it('handles fenced JSON', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('throws a repair-worthy error when no JSON is present', () => {
    expect(() => extractJsonObject('sure, element 3!')).toThrow(/no JSON/);
    expect(() => extractJsonObject('<thought>only thoughts, budget exhausted')).toThrow(/no JSON/);
  });
});
