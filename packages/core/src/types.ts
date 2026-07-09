/** Kinds of interactions the sentinel fixture supports. */
export type ActionKind =
  | 'goto'
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'press'
  | 'expectVisible'
  | 'expectText'
  | 'preStep';

/** Actions whose success asserts product behavior. Heals of these are guarded:
 * the healed element must carry the same semantic text content, otherwise the
 * failure is a product regression, not locator drift. */
export const ASSERTION_ACTIONS: ReadonlySet<ActionKind> = new Set(['expectVisible', 'expectText']);

/**
 * Last-known identity of a DOM element, captured on every successful step.
 * This is the semantic anchor used by Tiers 0-1 (and the LLM tiers later)
 * to re-find an element after its locator broke.
 */
export interface ElementFingerprint {
  tag: string;
  /** Explicit role attribute or implicit ARIA role (approximate mapping). */
  role: string | null;
  /** Approximate accessible name (aria-label > labelledby > label > alt > text > title). */
  name: string;
  /** Element's own visible text, whitespace-normalized, capped. */
  text: string;
  id: string | null;
  testId: string | null;
  classes: string[];
  /** Whitelisted attributes only (type, name, href, placeholder, ...). Never values. */
  attributes: Record<string, string>;
  /** Text of the surrounding container — disambiguates repeated widgets (e.g. per-card buttons). */
  nearbyText: string;
  /** Associated <label> text for form controls, if any. */
  labelText: string;
  /** Exact positional CSS path from <body> at capture time. */
  cssPath: string;
}

/** A serializable locator strategy. Rebuilt into a Playwright locator via buildLocator(). */
export interface CandidateDescriptor {
  kind: 'testid' | 'role' | 'label' | 'placeholder' | 'text' | 'css';
  value: string;
  /** Accessible name, for kind === 'role'. */
  name?: string;
  exact?: boolean;
}

export type FailureClass =
  'LOCATOR_DRIFT' | 'PRODUCT_REGRESSION' | 'ENVIRONMENT' | 'TEST_DATA' | 'UNKNOWN';

export interface Diagnosis {
  classification: FailureClass;
  reason: string;
  /** Best fingerprint similarity found in the live DOM, if candidates were collected. */
  bestSimilarity: number | null;
  candidateCount: number;
  /** True when history shows this test both passing and failing on the same git SHA. */
  knownFlaky: boolean;
  /** Set when the LLM classifier was consulted for an ambiguous case (spec §5). */
  refinedByLlm?: boolean;
}

export interface HealMatch {
  /** Fingerprint of the element the healer settled on (from the live DOM). */
  fingerprint: ElementFingerprint;
  /** Descriptor to act through for this run (always resolvable: positional CSS path). */
  actionDescriptor: CandidateDescriptor;
  /** Ranked descriptors derived from the matched element, for the cache. */
  newDescriptors: CandidateDescriptor[];
  confidence: number;
  tier: 0 | 1 | 2 | 3;
  reasoning: string;
}

export interface HealOutcome {
  healed: boolean;
  match: HealMatch | null;
  /** Why healing was not possible / was refused (empty when healed). */
  reason: string;
  /** Best-but-rejected candidates, used for escalation questions. */
  rejected: Array<{ fingerprint: ElementFingerprint; score: number }>;
}

export type StepStatus = 'passed' | 'healed_auto' | 'healed_unverified' | 'failed' | 'escalated';

export type HealMode = 'auto' | 'suggest' | 'off';

export interface StepMeta {
  runId: string;
  testId: string;
  stepId: string;
  action: ActionKind;
  intent: string;
  /** s.step() group path, joined with ' > '. */
  groupPath: string;
}

/** Structured question emitted when Sentinel refuses to guess. */
export interface EscalationQuestion {
  test: string;
  step: string;
  intent: string;
  question: string;
  candidates: Array<{
    label: string;
    descriptor: CandidateDescriptor;
    confidence: number;
    fingerprint: ElementFingerprint;
  }>;
  context: {
    url: string;
    classification: FailureClass;
    screenshot: string | null;
    error: string;
    /** The locator that broke, so an applied answer can audit old → new. */
    oldLocator?: string;
  };
}
