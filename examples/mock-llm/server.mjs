/**
 * Deterministic mock LLM server for the chaos-harness integration test.
 *
 * Implements POST /v1/chat/completions (OpenAI-compatible) so Sentinel's
 * generic adapter can be pointed at it via env vars alone. It parses the
 * Tier 2 prompt, scores candidates by token overlap with the trusted INTENT
 * line, and replies with the structured JSON Sentinel expects.
 *
 * This keeps the acceptance test offline and reproducible (spec §1: everything
 * runs offline except real LLM calls). It exercises the full Tier 2 path:
 * adapter wire format, JSON parsing, Zod validation, confidence policy,
 * accounting. It is NOT a general-purpose model.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT || 4174);

function tokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

function scoreCandidate(intentTokens, c) {
  const hay = tokens(
    [c.name, c.text, c.nearby, c.testId, c.id, c.classes, c.tag, c.role].join(' '),
  );
  let matched = 0;
  for (const t of intentTokens) if (hay.has(t)) matched++;
  return matched;
}

const NEGATION = /\b(not|no|failed|failure|error|cannot|can't|unable|denied|invalid|declined)\b/i;

/** OpenAI-compat content can be a string or a parts array (vision requests). */
function contentInfo(m) {
  if (typeof m.content === 'string') return { text: m.content, hasImage: false };
  if (Array.isArray(m.content)) {
    return {
      text: m.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n'),
      hasImage: m.content.some((p) => p.type === 'image_url'),
    };
  }
  return { text: '', hasImage: false };
}

/** Deterministic classifier for the diagnosis prompt: negated/error wording in
 * the best candidate means the behavior changed → PRODUCT_REGRESSION. */
function classify(messages) {
  const user = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && contentInfo(m).text.includes('CANDIDATES:'));
  const text = user ? contentInfo(user).text : '';
  const candidatesMatch = text.match(/^CANDIDATES: (\[.*\])$/m);
  let topText = '';
  try {
    const candidates = JSON.parse(candidatesMatch?.[1] ?? '[]');
    topText = String(candidates[0]?.text ?? candidates[0]?.name ?? '');
  } catch {
    /* fall through */
  }
  if (NEGATION.test(topText)) {
    return {
      classification: 'PRODUCT_REGRESSION',
      confidence: 0.9,
      reasoning: `mock: best candidate text "${topText.slice(0, 60)}" contains negated/error wording — the behavior changed, not just the selector`,
    };
  }
  return {
    classification: 'LOCATOR_DRIFT',
    confidence: 0.85,
    reasoning: 'mock: best candidate preserves the expected meaning — selector drift',
  };
}

function answer(messages, model) {
  const system = messages.find((m) => m.role === 'system');
  if (system && String(system.content).includes('test-failure classifier')) {
    return classify(messages);
  }
  const user = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && contentInfo(m).text.includes('CANDIDATES:'));
  if (!user) {
    return { elementIndex: -1, confidence: 0, reasoning: 'mock: no candidates block found' };
  }
  const { text, hasImage } = contentInfo(user);
  const intentMatch = text.match(/^INTENT \(trusted, written by the test author\): (.+)$/m);
  const candidatesMatch = text.match(/^CANDIDATES: (\[.*\])$/m);
  if (!intentMatch || !candidatesMatch) {
    return { elementIndex: -1, confidence: 0, reasoning: 'mock: prompt shape not recognized' };
  }
  const intentTokens = tokens(intentMatch[1]);
  let candidates;
  try {
    candidates = JSON.parse(candidatesMatch[1]);
  } catch {
    return { elementIndex: -1, confidence: 0, reasoning: 'mock: candidates JSON invalid' };
  }
  let best = null;
  for (const c of candidates) {
    const matched = scoreCandidate(intentTokens, c);
    if (!best || matched > best.matched) best = { i: c.i, matched };
  }
  if (!best || best.matched < 2) {
    return { elementIndex: -1, confidence: 0.3, reasoning: 'mock: nothing overlaps the intent' };
  }
  let confidence = Math.min(0.95, 0.55 + 0.06 * best.matched);
  let reasoning = `mock: candidate ${best.i} shares ${best.matched} token(s) with the intent`;
  if (hasImage) {
    reasoning += ' (screenshot received)';
  } else if (String(model || '').endsWith('-lowconf')) {
    // Chaos-harness control: this "model" is unsure from DOM text alone but
    // confident once it can see the page — forces the Tier 3 vision path.
    confidence = Math.min(confidence, 0.58);
    reasoning += ' (low confidence without visual context)';
  }
  return { elementIndex: best.i, confidence, reasoning };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      const result = answer(parsed.messages ?? [], parsed.model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-1',
          model: parsed.model ?? 'sentinel-mock-1',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) } }],
          usage: {
            prompt_tokens: Math.ceil(body.length / 4),
            completion_tokens: 30,
          },
        }),
      );
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message) }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] OpenAI-compatible mock listening on http://127.0.0.1:${PORT}/v1`);
});
