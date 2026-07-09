/**
 * API response shapes. These mirror the JSON returned by @sentinel/server, which
 * in turn comes from @sentinel/report's query functions. Kept as local types so
 * the browser bundle stays decoupled from the Node packages; if the server
 * contract changes, update these to match.
 */

export type RunStatus = 'passed' | 'passed_unverified' | 'failed' | 'no-runs' | string;

export interface SummaryData {
  runIds: string[];
  tests: number;
  passed: number;
  failed: number;
  heals: number;
  autoHeals: number;
  unverifiedHeals: number;
  humanHeals: number;
  pendingEscalations: number;
  llmCalls: number;
  llmCostUsd: number;
  healingUnavailable: boolean;
  status: RunStatus;
}

export interface HealModeCount {
  mode: string;
  count: number;
}

export interface RunOverview {
  id: string;
  status: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  gitSha: string | null;
  tests: number;
  passed: number;
  heals: HealModeCount[];
  escalations: number;
  llmCalls: number;
  llmCostUsd: number;
  healingUnavailable: boolean;
}

export interface TestResultRow {
  id: number;
  testId: string;
  title: string;
  file: string;
  status: string;
  durationMs: number;
  error: string | null;
  flakyTagged: boolean;
}

export interface HealRow {
  id: number;
  testId: string;
  stepId: string;
  intent: string;
  oldLocator: string;
  newLocator: string;
  tier: number;
  confidence: number;
  mode: string;
  reasoning: string;
  /** Servable /artifacts URL (or null) — the server rewrites the stored path. */
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  promoted: boolean;
  ts: number;
}

export interface Fingerprint {
  tag: string;
  name: string;
  text: string;
  cssPath: string;
}

export interface EscalationCandidate {
  label: string;
  confidence: number;
  fingerprint: Fingerprint;
}

export interface EscalationQuestion {
  test: string;
  step: string;
  intent: string;
  question: string;
  candidates: EscalationCandidate[];
  context: {
    url?: string;
    classification?: string;
    screenshot?: string | null;
    error?: string;
    oldLocator?: string;
  };
}

export interface EscalationRow {
  id: number;
  testId: string;
  stepId: string;
  status: string;
  answer: string | null;
  answeredBy: string | null;
  question: EscalationQuestion | null;
}

export interface PendingEscalation {
  id: number;
  runId: string;
  testId: string;
  stepId: string;
  question: EscalationQuestion;
}

export interface AnswerResult {
  escalationId: number;
  testId: string;
  stepId: string;
  redesign: boolean;
  appliedDescriptor: string | null;
  /** Steps with reviewed-but-unpromoted heals after this answer (one-click PR glue). */
  promotableCount?: number;
}

export interface StepRow {
  id: number;
  testId: string;
  stepId: string;
  action: string;
  intent: string;
  groupPath: string;
  status: string;
  tier: number | null;
  confidence: number | null;
  classification: string | null;
  durationMs: number;
  url: string;
  ts: number;
}

export interface RunDetail {
  tests: TestResultRow[];
  heals: HealRow[];
  escalations: EscalationRow[];
  steps: StepRow[];
}

export interface RunDetailResponse {
  overview: RunOverview;
  running: boolean;
  detail: RunDetail;
}

export interface ActiveRun {
  runId?: string;
  running: boolean;
  startedAt?: number;
  output?: string[];
  status?: string;
}

export interface FlakeStat {
  testId: string;
  total: number;
  passes: number;
  fails: number;
  shas: number;
  flakyShaFlips: number;
}

export interface LlmCostRow {
  provider: string;
  model: string;
  purpose: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

export interface LlmCosts {
  rows: LlmCostRow[];
  totalCostUsd: number;
}

// ---- Flows (block editor) — mirror @sentinel/flow's schema ------------------

export type LocatorKind = 'testid' | 'role' | 'label' | 'placeholder' | 'text' | 'css';

export interface LocatorSpec {
  kind: LocatorKind;
  value: string;
  name?: string;
  exact?: boolean;
}

export interface FlowStepBase {
  group?: string;
}

export type FlowStep =
  | (FlowStepBase & { action: 'goto'; url: string })
  | (FlowStepBase & { action: 'click'; stepKey: string; intent: string; locator: LocatorSpec })
  | (FlowStepBase & {
      action: 'fill';
      stepKey: string;
      intent: string;
      locator: LocatorSpec;
      value: string;
      masked?: boolean;
    })
  | (FlowStepBase & {
      action: 'select';
      stepKey: string;
      intent: string;
      locator: LocatorSpec;
      value: string;
    })
  | (FlowStepBase & { action: 'check'; stepKey: string; intent: string; locator: LocatorSpec })
  | (FlowStepBase & { action: 'uncheck'; stepKey: string; intent: string; locator: LocatorSpec })
  | (FlowStepBase & {
      action: 'press';
      stepKey: string;
      intent: string;
      locator: LocatorSpec;
      key: string;
    })
  | (FlowStepBase & {
      action: 'expectVisible';
      stepKey: string;
      intent: string;
      locator: LocatorSpec;
    })
  | (FlowStepBase & {
      action: 'expectText';
      stepKey: string;
      intent: string;
      locator: LocatorSpec;
      text: string;
    });

export interface Flow {
  version: 1;
  title: string;
  steps: FlowStep[];
}

export interface FlowListItem {
  path: string;
  title: string;
  steps: number;
  invalid: boolean;
}

export interface FlowOne {
  path: string;
  flow: Flow;
  specPath: string;
}

export type ImportableSpec =
  | { path: string; importable: true; tests: number }
  | { path: string; importable: false; reason: string };

export interface ImportResultBody {
  flows: Array<{ path: string; title: string }>;
  movedRows: number;
  retired: string;
}

// ---- Recorder ----------------------------------------------------------------

export interface RecorderStep {
  action:
    | 'goto'
    | 'click'
    | 'fill'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'press'
    | 'expectVisible'
    | 'expectText';
  intent: string;
  locator?: LocatorSpec;
  value?: string;
  masked?: boolean;
  key?: string;
  text?: string;
}

export interface RecorderStatus {
  active: boolean;
  url: string | null;
  mode: 'record' | 'assert';
  steps: RecorderStep[];
}

export interface RecorderSaveResult {
  path: string;
  title: string;
  seededSteps: number;
  intentSource: 'llm' | 'heuristic';
}

export type PromotionStatus = 'ready' | 'conflict' | 'not-found' | 'missing-file';

export interface PromotionPlan {
  file: string;
  oldCode: string;
  newCode: string;
  occurrences: number;
  status: PromotionStatus;
  note: string;
  testIds: string[];
}

export interface PromotePreview {
  plans: PromotionPlan[];
  diff: string[];
}

export interface PromoteResult {
  applied: number;
  filesChanged: string[];
  diff: string[];
  branch: string | null;
  base: string | null;
  committed: boolean;
  pushed: boolean;
  prUrl: string | null;
  note: string;
  plans: PromotionPlan[];
}
