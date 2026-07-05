import type { LLMMessage, LLMProvider } from '@sentinel/providers';

/**
 * Remove reasoning-model thought blocks before JSON extraction. Gemma 4 (and
 * other reasoning models) prepend <thought>...</thought> to the answer; the
 * block often contains braces/JSON fragments, so it must be stripped before
 * locating the real JSON object. Unterminated blocks (output truncated inside
 * the thought) are dropped to end-of-text.
 */
export function stripReasoningBlocks(text: string): string {
  let out = text.replace(/<(thought|think|thinking)>[\s\S]*?<\/\1>/gi, ' ');
  out = out.replace(/<(thought|think|thinking)>[\s\S]*$/i, ' ');
  return out.trim();
}

/** Strip fences/thoughts and parse the outermost JSON object. Throws with a
 * repair-worthy message. */
export function extractJsonObject(text: string): unknown {
  let raw = stripReasoningBlocks(text);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) raw = fenced[1]!.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found in reply');
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error(`invalid JSON: ${(err as Error).message}`);
  }
}

export interface JsonCompletionOptions<T> {
  provider: LLMProvider;
  messages: LLMMessage[];
  purpose: string;
  maxRepairAttempts: number;
  maxOutputTokens: number;
  /** Schema restated in repair prompts. */
  repairSchemaHint: string;
  /** Parse + validate the raw reply text; throw to trigger a repair attempt. */
  validate: (text: string) => T;
}

/**
 * Shared LLM structured-output loop (spec §2): call, validate, repair-prompt on
 * malformed output up to maxRepairAttempts, then give up (null → callers treat
 * as low confidence). Provider-level failures (timeout, circuit open) also
 * return null — the pipeline degrades, never hangs. Accounting happens in the
 * resilience hooks, not here.
 */
export async function completeJsonWithRepair<T>(opts: JsonCompletionOptions<T>): Promise<T | null> {
  const conversation: LLMMessage[] = [...opts.messages];
  for (let attempt = 0; attempt <= opts.maxRepairAttempts; attempt++) {
    let replyText: string;
    try {
      const reply = await opts.provider.complete({
        messages: conversation,
        jsonMode: true,
        maxTokens: opts.maxOutputTokens,
        temperature: 0,
        purpose: opts.purpose,
      });
      replyText = reply.text;
    } catch {
      return null;
    }
    try {
      return opts.validate(replyText);
    } catch (err) {
      conversation.push({ role: 'assistant', content: replyText.slice(0, 2_000) });
      conversation.push({
        role: 'user',
        content: `Your previous reply was invalid (${(err as Error).message}). Reply again with ONLY the JSON object ${opts.repairSchemaHint} and nothing else.`,
      });
    }
  }
  return null;
}
