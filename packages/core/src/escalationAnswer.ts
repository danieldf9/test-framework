import { describeDescriptor, descriptorsFromFingerprint } from './descriptors.js';
import type { SentinelStore } from './storage/store.js';
import type { CandidateDescriptor } from './types.js';

export interface AnswerResult {
  escalationId: number;
  testId: string;
  stepId: string;
  redesign: boolean;
  /** Human-readable descriptor now cached as primary (null for redesign answers). */
  appliedDescriptor: string | null;
}

/**
 * Record a human's answer to an escalation and apply it (spec §6):
 * - a candidate choice becomes the step's cached primary locator (next run
 *   replays at Tier 0) and is written to the heals audit as mode HUMAN;
 * - 'REDESIGN' records that the change is intentional — nothing is cached,
 *   the test itself needs a human edit;
 * - every answer is stored and feeds future Tier 2 prompts as few-shot context.
 */
export function applyEscalationAnswer(
  store: SentinelStore,
  escalationId: number,
  choice: string,
  answeredBy: string,
  channel: string,
): AnswerResult {
  const esc = store.getEscalationById(escalationId);
  if (!esc) throw new Error(`escalation #${escalationId} not found`);
  if (esc.status !== 'pending') {
    throw new Error(`escalation #${escalationId} is already ${esc.status}`);
  }

  const normalized = choice.trim().toUpperCase();
  if (normalized === 'REDESIGN' || normalized === 'R') {
    store.answerEscalation(
      escalationId,
      'REDESIGN — intentional change, test update required',
      answeredBy,
      channel,
    );
    return {
      escalationId,
      testId: esc.testId,
      stepId: esc.stepId,
      redesign: true,
      appliedDescriptor: null,
    };
  }

  const candidate = esc.question.candidates.find((c) => c.label.toUpperCase() === normalized);
  if (!candidate) {
    const available = esc.question.candidates.map((c) => c.label).join(', ');
    throw new Error(
      `escalation #${escalationId} has no candidate '${choice}' (available: ${available || 'none'}, or REDESIGN)`,
    );
  }

  const existing = store.getCacheEntry(esc.testId, esc.stepId);
  const all: CandidateDescriptor[] = [];
  const push = (d: CandidateDescriptor) => {
    if (!all.some((x) => JSON.stringify(x) === JSON.stringify(d))) all.push(d);
  };
  push(candidate.descriptor);
  for (const d of descriptorsFromFingerprint(candidate.fingerprint)) push(d);
  if (existing) {
    push(existing.primary);
    for (const d of existing.alternates) push(d);
  }
  store.upsertCacheEntry({
    testId: esc.testId,
    stepId: esc.stepId,
    primary: all[0]!,
    alternates: all.slice(1, 9),
    fingerprint: candidate.fingerprint,
    intent: esc.question.intent,
    lastVerifiedAt: Date.now(),
  });

  const applied = describeDescriptor(candidate.descriptor);
  store.recordHeal({
    runId: esc.runId,
    testId: esc.testId,
    stepId: esc.stepId,
    intent: esc.question.intent,
    oldLocator: esc.question.context.oldLocator ?? '(unknown — see escalation question)',
    newLocator: applied,
    tier: 0,
    confidence: 1,
    mode: 'HUMAN',
    reasoning: `Human answered escalation #${escalationId} with candidate ${candidate.label} (machine confidence was ${candidate.confidence}). ${esc.question.question.slice(0, 200)}`,
    screenshotBefore: esc.question.context.screenshot,
    screenshotAfter: null,
    gitSha: null,
  });
  store.answerEscalation(escalationId, `${candidate.label}: ${applied}`, answeredBy, channel);

  return {
    escalationId,
    testId: esc.testId,
    stepId: esc.stepId,
    redesign: false,
    appliedDescriptor: applied,
  };
}
