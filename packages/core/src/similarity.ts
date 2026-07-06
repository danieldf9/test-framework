import type { ElementFingerprint } from './types.js';

export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function tokenize(s: string | null | undefined): string[] {
  return normalizeText(s)
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

// Row buffers reused across calls: a heavy Tier 1 heal runs levenshtein
// thousands of times in a burst, and per-call array allocation is pure GC
// pressure. Safe to share at module scope because the function is synchronous
// and non-reentrant.
let levPrev = new Uint32Array(64);
let levCurr = new Uint32Array(64);

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const width = b.length + 1;
  if (levPrev.length < width) {
    levPrev = new Uint32Array(width * 2);
    levCurr = new Uint32Array(width * 2);
  }
  let prev = levPrev;
  let curr = levCurr;
  for (let j = 0; j < width; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length]!;
}

/** 1 = identical, 0 = nothing in common. Character-level. */
export function stringSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na.length === 0 && nb.length === 0) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  const max = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / max;
}

/** Blend of Jaccard and overlap coefficient on token sets. Tolerates added words
 * ("Place order" vs "Place your order") without being fooled by disjoint labels. */
export function tokenSimilarity(a: string | string[], b: string | string[]): number {
  const ta = new Set(Array.isArray(a) ? a.flatMap((x) => tokenize(x)) : tokenize(a));
  const tb = new Set(Array.isArray(b) ? b.flatMap((x) => tokenize(x)) : tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const overlap = inter / Math.min(ta.size, tb.size);
  return 0.5 * jaccard + 0.5 * overlap;
}

/** Similarity for text-bearing fields: best of token-level and char-level views. */
export function textFieldSimilarity(a: string, b: string): number {
  return Math.max(tokenSimilarity(a, b), stringSimilarity(a, b));
}

/**
 * Soft comparison for identity attributes (id, data-testid).
 * Absence is weaker evidence of mismatch than a different value:
 * chaos/refactors frequently *remove* test ids without the element changing.
 */
function attrSoftSimilarity(stored: string | null, candidate: string | null): number | null {
  const s = normalizeText(stored);
  const c = normalizeText(candidate);
  if (!s && !c) return null; // not comparable, skip
  if (s && !c) return 0.3; // attribute was removed — soft penalty
  if (!s && c) return 0.5; // attribute appeared — neutral-ish
  if (s === c) return 1;
  return Math.max(tokenSimilarity(s, c), stringSimilarity(s, c)) * 0.9;
}

const TAG_FAMILY = new Set(['button', 'a', 'input']);

export interface SimilarityBreakdown {
  score: number;
  parts: Record<string, number | null>;
}

const WEIGHTS = {
  role: 0.15,
  name: 0.35,
  text: 0.15,
  attrs: 0.1,
  nearby: 0.15,
  tag: 0.1,
} as const;

/**
 * Weighted fingerprint similarity in [0, 1]. Fields absent on both sides are
 * skipped and their weight redistributed, so a label-less icon button is not
 * penalized for having no accessible name history.
 */
export function fingerprintSimilarity(
  stored: ElementFingerprint,
  candidate: ElementFingerprint,
): SimilarityBreakdown {
  const parts: Record<string, number | null> = {
    role: null,
    name: null,
    text: null,
    attrs: null,
    nearby: null,
    tag: null,
  };

  if (stored.role || candidate.role) {
    parts.role = stored.role === candidate.role ? 1 : 0;
  }

  const storedName = normalizeText(stored.name || stored.labelText);
  const candName = normalizeText(candidate.name || candidate.labelText);
  if (storedName || candName) parts.name = textFieldSimilarity(storedName, candName);

  if (normalizeText(stored.text) || normalizeText(candidate.text)) {
    parts.text = textFieldSimilarity(stored.text, candidate.text);
  }

  const attrParts: number[] = [];
  const testIdSim = attrSoftSimilarity(stored.testId, candidate.testId);
  if (testIdSim !== null) attrParts.push(testIdSim);
  const idSim = attrSoftSimilarity(stored.id, candidate.id);
  if (idSim !== null) attrParts.push(idSim);
  if (stored.classes.length > 0 || candidate.classes.length > 0) {
    attrParts.push(tokenSimilarity(stored.classes, candidate.classes));
  }
  const attrKeys = new Set([
    ...Object.keys(stored.attributes),
    ...Object.keys(candidate.attributes),
  ]);
  if (attrKeys.size > 0) {
    let matched = 0;
    for (const k of attrKeys) {
      if (normalizeText(stored.attributes[k]) === normalizeText(candidate.attributes[k])) matched++;
    }
    attrParts.push(matched / attrKeys.size);
  }
  if (attrParts.length > 0) {
    parts.attrs = attrParts.reduce((a, b) => a + b, 0) / attrParts.length;
  }

  if (normalizeText(stored.nearbyText) || normalizeText(candidate.nearbyText)) {
    parts.nearby = tokenSimilarity(stored.nearbyText, candidate.nearbyText);
  }

  if (stored.tag === candidate.tag) parts.tag = 1;
  else if (TAG_FAMILY.has(stored.tag) && TAG_FAMILY.has(candidate.tag)) parts.tag = 0.5;
  else parts.tag = 0;

  let weightSum = 0;
  let score = 0;
  for (const [key, w] of Object.entries(WEIGHTS)) {
    const v = parts[key];
    if (v === null || v === undefined) continue;
    weightSum += w;
    score += w * v;
  }
  return { score: weightSum > 0 ? score / weightSum : 0, parts };
}

/** Semantic-content similarity used by the assertion guard: does the candidate
 * carry the same text the assertion depends on? */
export function assertionTextSimilarity(
  stored: ElementFingerprint,
  candidate: ElementFingerprint,
): number {
  const storedTxt = normalizeText(stored.text || stored.name);
  const candTxt = normalizeText(candidate.text || candidate.name);
  if (!storedTxt) return 1; // assertion did not depend on text (e.g. visibility of an icon)
  return textFieldSimilarity(storedTxt, candTxt);
}
