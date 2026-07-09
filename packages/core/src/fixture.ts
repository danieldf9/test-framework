import { execSync } from 'node:child_process';
import path from 'node:path';
import { test as base, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createProvider, type ResilientProvider } from '@sentinel/providers';
import { ArtifactRecorder, testArtifactDirName, type CaptureFrame } from './capture.js';
import { loadConfig, type LoadedConfig } from './config.js';
import {
  buildLocator,
  describeDescriptor,
  descriptorEquals,
  descriptorsFromFingerprint,
} from './descriptors.js';
import { classifyFailure } from './diagnosis.js';
import { refineDiagnosis } from './diagnosisLlm.js';
import { sentinelDomAgent, type DomAgentOptions } from './domAgent.js';
import { makeTestId, resolveStepId } from './ids.js';
import {
  FatalHealError,
  makeTier0Resolver,
  makeTier1Resolver,
  runHealingPipeline,
  type TierResolver,
} from './healing.js';
import { fingerprintSimilarity } from './similarity.js';
import { SentinelStore, type CacheEntry } from './storage/store.js';
import { makeTier2Resolver } from './tier2.js';
import { makeTier3Resolver } from './tier3.js';
import {
  ASSERTION_ACTIONS,
  type ActionKind,
  type CandidateDescriptor,
  type Diagnosis,
  type ElementFingerprint,
  type EscalationQuestion,
} from './types.js';

export interface SentinelWorkerContext {
  loaded: LoadedConfig;
  store: SentinelStore;
  runId: string;
  gitSha: string | null;
  /** Resilience-wrapped provider, or null when running deterministic-only. */
  llmProvider: ResilientProvider | null;
  llmDisabledReason: string | null;
}

function detectGitSha(cwd: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

interface StepArgs {
  locator: Locator;
  intent: string;
  /** Stable identity for flow-authored steps (Phase 2 — D38). When present it is
   * the step's cache/heal key, so editing the intent or reordering steps preserves
   * healing history. Omitted for hand-authored specs (identity derives from intent). */
  stepKey?: string;
}

export class SentinelActions {
  private readonly occurrences = new Map<string, number>();
  private readonly usedStepKeys = new Set<string>();
  private readonly groupStack: string[] = [];
  private readonly recorder: ArtifactRecorder;
  private lastNavStatus: number | null = null;
  private unverifiedHeals = 0;
  private readonly testId: string;

  constructor(
    readonly page: Page,
    private readonly testInfo: TestInfo,
    private readonly ctx: SentinelWorkerContext,
  ) {
    this.testId = makeTestId(
      path.relative(this.ctx.loaded.rootDir, testInfo.file),
      testInfo.titlePath.filter(Boolean),
    );
    const cfg = ctx.loaded.config;
    this.recorder = new ArtifactRecorder({
      enabled: cfg.capture.enabled,
      ringBufferSize: cfg.capture.ringBufferSize,
      screenshots: cfg.capture.screenshots,
      domSnapshots: cfg.capture.domSnapshots,
      maskInputsInScreenshots: cfg.capture.maskInputsInScreenshots,
      testIdAttribute: cfg.testIdAttribute,
      redactSelectors: cfg.redaction.selectors,
      maskPatterns: cfg.redaction.maskPatterns,
    });
  }

  private get cfg() {
    return this.ctx.loaded.config;
  }

  private artifactDir(): string {
    return path.join(
      this.ctx.loaded.artifactsDir,
      this.ctx.runId,
      testArtifactDirName(this.testId),
    );
  }

  private nextStepId(action: ActionKind, intent: string, stepKey?: string): string {
    return resolveStepId(action, intent, stepKey, this.occurrences, this.usedStepKeys, this.testId);
  }

  private pageUrl(): string {
    try {
      return this.page.url();
    } catch {
      return '';
    }
  }

  /** Group steps for richer diagnosis context; mirrors test.step in reports. */
  async step<T>(intentDescription: string, fn: () => Promise<T>): Promise<T> {
    this.groupStack.push(intentDescription);
    try {
      return await base.step(intentDescription, fn);
    } finally {
      this.groupStack.pop();
    }
  }

  async goto(url: string): Promise<void> {
    const stepId = this.nextStepId('goto', url);
    const started = Date.now();
    const retries = this.cfg.diagnosis.retriesOnEnvironment;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.page.goto(url);
        this.lastNavStatus = response?.status() ?? null;
        if (this.lastNavStatus !== null && this.lastNavStatus >= 500) {
          throw new Error(`[sentinel] navigation to ${url} returned HTTP ${this.lastNavStatus}`);
        }
        this.recordStepRow(stepId, 'goto', url, 'passed', null, null, null, started);
        await this.runPreSteps();
        return;
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
    }
    this.recordStepRow(stepId, 'goto', url, 'failed', null, null, 'ENVIRONMENT', started);
    this.flushArtifacts();
    throw new Error(
      `[sentinel] ENVIRONMENT: navigation to ${url} failed after ${retries + 1} attempts: ${String(
        (lastError as Error)?.message ?? lastError,
      )}`,
      { cause: lastError },
    );
  }

  /** Consent/cookie banners are never auto-accepted silently (spec §10):
   * only pre-steps declared in config are executed, and each one is logged. */
  private async runPreSteps(): Promise<void> {
    for (const pre of this.cfg.preSteps) {
      const stepId = this.nextStepId('preStep', pre.name);
      const started = Date.now();
      const locator = this.page.locator(pre.selector);
      try {
        await locator.waitFor({ state: 'visible', timeout: pre.timeoutMs });
      } catch {
        if (pre.optional) continue;
        this.recordStepRow(stepId, 'preStep', pre.name, 'failed', null, null, null, started);
        throw new Error(
          `[sentinel] required pre-step "${pre.name}" (${pre.selector}) not found on ${this.pageUrl()}`,
        );
      }
      // The click itself can fail even when the element is visible (obscured,
      // intercepted, detached mid-click). An optional pre-step must never take
      // the whole test down for that — log, record, continue.
      try {
        await locator.click({ timeout: this.cfg.actionTimeoutMs });
        this.recordStepRow(stepId, 'preStep', pre.name, 'passed', null, null, null, started);
      } catch (err) {
        this.recordStepRow(stepId, 'preStep', pre.name, 'failed', null, null, null, started);
        const detail = String((err as Error).message ?? err).split('\n')[0];
        if (pre.optional) {
          console.warn(
            `[sentinel] optional pre-step "${pre.name}" could not be clicked: ${detail}`,
          );
          continue;
        }
        throw new Error(`[sentinel] required pre-step "${pre.name}" failed to click: ${detail}`, {
          cause: err,
        });
      }
    }
  }

  async click(args: StepArgs): Promise<void> {
    await this.runStep('click', args, (loc) => loc.click({ timeout: this.cfg.actionTimeoutMs }));
  }

  async fill(args: StepArgs & { value: string }): Promise<void> {
    // args.value is deliberately excluded from every log, fingerprint and artifact.
    await this.runStep('fill', args, (loc) =>
      loc.fill(args.value, { timeout: this.cfg.actionTimeoutMs }),
    );
  }

  async select(args: StepArgs & { value: string }): Promise<void> {
    await this.runStep('select', args, async (loc) => {
      await loc.selectOption(args.value, { timeout: this.cfg.actionTimeoutMs });
    });
  }

  async check(args: StepArgs): Promise<void> {
    await this.runStep('check', args, (loc) => loc.check({ timeout: this.cfg.actionTimeoutMs }));
  }

  async uncheck(args: StepArgs): Promise<void> {
    await this.runStep('uncheck', args, (loc) =>
      loc.uncheck({ timeout: this.cfg.actionTimeoutMs }),
    );
  }

  async press(args: StepArgs & { key: string }): Promise<void> {
    await this.runStep('press', args, (loc) =>
      loc.press(args.key, { timeout: this.cfg.actionTimeoutMs }),
    );
  }

  async expectVisible(args: StepArgs): Promise<void> {
    await this.runStep('expectVisible', args, (loc) =>
      loc.waitFor({ state: 'visible', timeout: this.cfg.actionTimeoutMs }),
    );
  }

  async expectText(args: StepArgs & { text: string }): Promise<void> {
    await this.runStep('expectText', args, async (loc) => {
      await expect(loc).toHaveText(args.text, { timeout: this.cfg.actionTimeoutMs });
    });
  }

  // ---------------------------------------------------------------------------

  private async runStep(
    action: ActionKind,
    args: StepArgs,
    exec: (loc: Locator) => Promise<void>,
  ): Promise<void> {
    const stepId = this.nextStepId(action, args.intent, args.stepKey);
    const started = Date.now();
    await this.recorder.record(this.page, { stepId, action, label: 'before' });

    let preFingerprint: ElementFingerprint | null = null;
    try {
      preFingerprint = await this.captureFingerprint(args.locator);
      await exec(args.locator);
    } catch (err) {
      await this.handleFailure({ action, args, stepId, started, exec, error: err as Error });
      return;
    }

    // Success: refresh the cache so this step keeps its Tier-0 fallback ladder current.
    const fingerprint =
      preFingerprint ??
      (ASSERTION_ACTIONS.has(action) ? await this.captureFingerprint(args.locator) : null);
    if (fingerprint) this.updateCache(stepId, args.intent, fingerprint, null);
    this.recordStepRow(stepId, action, args.intent, 'passed', null, null, null, started);
  }

  private async captureFingerprint(locator: Locator): Promise<ElementFingerprint | null> {
    try {
      const handle = await locator.elementHandle({ timeout: this.cfg.actionTimeoutMs });
      if (!handle) return null;
      const agentOpts: DomAgentOptions = {
        cmd: 'fingerprint',
        testIdAttribute: this.cfg.testIdAttribute,
      };
      const fp = (await handle.evaluate(sentinelDomAgent, agentOpts)) as ElementFingerprint;
      await handle.dispose();
      return fp;
    } catch {
      return null;
    }
  }

  private updateCache(
    stepId: string,
    intent: string,
    fingerprint: ElementFingerprint,
    forcedPrimary: CandidateDescriptor | null,
  ): void {
    const fresh = descriptorsFromFingerprint(fingerprint);
    const existing = this.ctx.store.getCacheEntry(this.testId, stepId);
    const all: CandidateDescriptor[] = [];
    const push = (d: CandidateDescriptor) => {
      if (!all.some((x) => descriptorEquals(x, d))) all.push(d);
    };
    if (forcedPrimary) push(forcedPrimary);
    for (const d of fresh) push(d);
    if (existing) {
      push(existing.primary);
      for (const d of existing.alternates) push(d);
    }
    const entry: CacheEntry = {
      testId: this.testId,
      stepId,
      primary: all[0]!,
      alternates: all.slice(1, 9),
      fingerprint,
      intent,
      lastVerifiedAt: Date.now(),
    };
    this.ctx.store.upsertCacheEntry(entry);
  }

  private async collectCandidates(): Promise<ElementFingerprint[]> {
    try {
      const body = await this.page.evaluateHandle(() => document.body);
      const agentOpts: DomAgentOptions = {
        cmd: 'collect',
        testIdAttribute: this.cfg.testIdAttribute,
        maxElements: this.cfg.healing.maxCollectElements,
      };
      const collected = (await body.evaluate(sentinelDomAgent, agentOpts)) as ElementFingerprint[];
      await body.dispose();
      return collected;
    } catch {
      return [];
    }
  }

  private async handleFailure(p: {
    action: ActionKind;
    args: StepArgs;
    stepId: string;
    started: number;
    exec: (loc: Locator) => Promise<void>;
    error: Error;
  }): Promise<void> {
    const { action, args, stepId, started, exec, error } = p;
    const isAssertion = ASSERTION_ACTIONS.has(action);
    const failureFrame = await this.recorder.captureFrame(this.page, {
      stepId,
      action,
      label: 'failure',
    });

    const cache = this.ctx.store.getCacheEntry(this.testId, stepId);
    const candidates = await this.collectCandidates();
    const diagnosisInput = {
      errorMessage: String(error.message ?? error),
      action,
      isAssertion,
      intent: args.intent,
      storedFingerprint: cache?.fingerprint ?? null,
      candidates,
      pageUrl: this.pageUrl(),
      navStatus: this.lastNavStatus,
      knownFlaky: this.cfg.diagnosis.flakeDetection
        ? this.ctx.store.isKnownFlaky(this.testId, this.ctx.gitSha)
        : false,
    };
    let diagnosis = classifyFailure(diagnosisInput, {
      driftFloor: this.cfg.diagnosis.driftFloor,
    });

    // Spec §5: cheap heuristics first; LLM classification only when they are
    // ambiguous (drift-vs-regression contradictions). Any LLM problem keeps
    // the deterministic result.
    if (this.ctx.llmProvider && !this.ctx.llmProvider.circuitOpen) {
      diagnosis = await refineDiagnosis(
        {
          provider: this.ctx.llmProvider,
          store: this.ctx.store,
          runId: this.ctx.runId,
          llm: {
            maxRepairAttempts: this.cfg.llm.maxRepairAttempts,
            maxOutputTokens: this.cfg.llm.maxOutputTokens,
            maxSpendUsdPerRun: this.cfg.llm.maxSpendUsdPerRun,
          },
        },
        diagnosisInput,
        diagnosis,
        {
          driftFloor: this.cfg.diagnosis.driftFloor,
          assertionTextGuard: this.cfg.diagnosis.assertionTextGuard,
        },
      );
    }

    if (diagnosis.classification === 'ENVIRONMENT') {
      await this.retryEnvironment(p, diagnosis);
      return;
    }

    if (diagnosis.classification !== 'LOCATOR_DRIFT') {
      // PRODUCT_REGRESSION / TEST_DATA / UNKNOWN: never heal. Fail loudly,
      // with an escalation record for regressions (spec §6).
      if (diagnosis.classification === 'PRODUCT_REGRESSION') {
        this.escalate(p, diagnosis, candidates, cache, failureFrame, false);
      }
      this.failStep(p, diagnosis, null);
    }

    if (this.cfg.healing.mode === 'off') {
      this.failStep(p, diagnosis, 'healing disabled (mode=off)');
    }
    if (!cache) {
      this.failStep(p, diagnosis, 'no locator cache for this step — cannot heal without history');
    }

    // Hard caps (spec §10): exceeding them fails loudly, never silently.
    const healsThisTest = this.ctx.store.healCountForTest(this.ctx.runId, this.testId);
    if (healsThisTest >= this.cfg.healing.maxHealsPerTest) {
      this.failStep(
        p,
        diagnosis,
        `max heals per test (${this.cfg.healing.maxHealsPerTest}) exceeded`,
      );
    }
    const healsThisRun = this.ctx.store.healCountForRun(this.ctx.runId);
    if (healsThisRun >= this.cfg.healing.maxHealsPerRun) {
      this.failStep(
        p,
        diagnosis,
        `max heals per run (${this.cfg.healing.maxHealsPerRun}) exceeded`,
      );
    }

    const resolvers: TierResolver[] = [
      makeTier0Resolver(this.page, { testIdAttribute: this.cfg.testIdAttribute }),
      makeTier1Resolver(),
    ];
    // Tiers 2-3 (LLM DOM / vision) join the pipeline when a provider is
    // configured and its circuit breaker is closed — otherwise the run stays
    // deterministic-only and never waits on a dead endpoint.
    const provider = this.ctx.llmProvider;
    const llmDeps = {
      maxRepairAttempts: this.cfg.llm.maxRepairAttempts,
      domCharBudget: this.cfg.llm.domCharBudget,
      maxSpendUsdPerRun: this.cfg.llm.maxSpendUsdPerRun,
      maxOutputTokens: this.cfg.llm.maxOutputTokens,
    };
    const screenshotForVision = failureFrame.screenshot
      ? { base64: failureFrame.screenshot.toString('base64'), mediaType: 'image/jpeg' }
      : null;
    if (provider && !provider.circuitOpen) {
      resolvers.push(
        makeTier2Resolver({
          provider,
          store: this.ctx.store,
          runId: this.ctx.runId,
          testId: this.testId,
          stepId,
          action,
          llm: llmDeps,
        }),
      );
      if (provider.supportsVision && screenshotForVision) {
        resolvers.push(
          makeTier3Resolver({
            provider,
            store: this.ctx.store,
            runId: this.ctx.runId,
            action,
            llm: llmDeps,
          }),
        );
      }
    }
    let outcome;
    try {
      outcome = await runHealingPipeline(resolvers, {
        cache: cache!,
        collected: candidates,
        policy: this.cfg.healing,
        guard: { isAssertion, minTextSimilarity: this.cfg.diagnosis.assertionTextGuard },
        screenshot: screenshotForVision,
        priorResults: [],
      });
    } catch (err) {
      if (err instanceof FatalHealError) {
        this.failStep(p, diagnosis, err.message);
      }
      throw err;
    }

    if (!outcome.healed || !outcome.match) {
      this.escalate(p, diagnosis, candidates, cache, failureFrame, true, outcome.reason);
      this.failStep(p, diagnosis, `healing exhausted: ${outcome.reason}`);
      return;
    }

    const match = outcome.match;
    const healMode =
      match.confidence >= this.cfg.healing.autoApplyThreshold ? 'AUTO' : 'UNVERIFIED';

    if (this.cfg.healing.mode === 'suggest') {
      const before = this.recorder.writeFrame(failureFrame, this.artifactDir());
      this.ctx.store.recordHeal({
        runId: this.ctx.runId,
        testId: this.testId,
        stepId,
        intent: args.intent,
        oldLocator: String(args.locator),
        newLocator: describeDescriptor(match.newDescriptors[0]!),
        tier: match.tier,
        confidence: match.confidence,
        mode: 'SUGGESTED',
        reasoning: match.reasoning,
        screenshotBefore: before.screenshot,
        screenshotAfter: null,
        gitSha: this.ctx.gitSha,
      });
      this.failStep(
        p,
        diagnosis,
        `heal available but not applied (mode=suggest): ${describeDescriptor(match.newDescriptors[0]!)} at confidence ${match.confidence.toFixed(2)} — rerun with --heal=auto or review via sentinel report`,
      );
    }

    // Apply the heal for this run.
    const healedLocator = buildLocator(this.page, match.actionDescriptor);
    try {
      await exec(healedLocator);
    } catch (healErr) {
      this.failStep(
        p,
        diagnosis,
        `heal candidate found (${match.reasoning}) but the action still failed: ${String(
          (healErr as Error).message,
        )}`,
      );
      return;
    }

    const afterFrame = await this.recorder.captureFrame(this.page, {
      stepId,
      action,
      label: 'healed',
    });
    const dir = this.artifactDir();
    const before = this.recorder.writeFrame(failureFrame, dir);
    const after = this.recorder.writeFrame(afterFrame, dir);

    this.ctx.store.recordHeal({
      runId: this.ctx.runId,
      testId: this.testId,
      stepId,
      intent: args.intent,
      oldLocator: String(args.locator),
      newLocator: describeDescriptor(match.newDescriptors[0]!),
      tier: match.tier,
      confidence: match.confidence,
      mode: healMode,
      reasoning: match.reasoning,
      screenshotBefore: before.screenshot,
      screenshotAfter: after.screenshot,
      gitSha: this.ctx.gitSha,
    });
    this.updateCache(stepId, args.intent, match.fingerprint, match.newDescriptors[0] ?? null);

    if (healMode === 'UNVERIFIED') {
      this.unverifiedHeals++;
      this.testInfo.annotations.push({
        type: 'sentinel-heal-unverified',
        description: `${action} "${args.intent}" healed at tier ${match.tier} with confidence ${match.confidence.toFixed(2)} — needs review (${describeDescriptor(match.newDescriptors[0]!)})`,
      });
    } else {
      this.testInfo.annotations.push({
        type: 'sentinel-heal-auto',
        description: `${action} "${args.intent}" auto-healed at tier ${match.tier} (confidence ${match.confidence.toFixed(2)})`,
      });
    }

    this.recordStepRow(
      stepId,
      action,
      args.intent,
      healMode === 'AUTO' ? 'healed_auto' : 'healed_unverified',
      match.tier,
      match.confidence,
      diagnosis.classification,
      started,
    );
  }

  private async retryEnvironment(
    p: {
      action: ActionKind;
      args: StepArgs;
      stepId: string;
      started: number;
      exec: (loc: Locator) => Promise<void>;
      error: Error;
    },
    diagnosis: Diagnosis,
  ): Promise<void> {
    const retries = this.cfg.diagnosis.retriesOnEnvironment;
    for (let attempt = 1; attempt <= retries; attempt++) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      try {
        await p.exec(p.args.locator);
        this.recordStepRow(
          p.stepId,
          p.action,
          p.args.intent,
          'passed',
          null,
          null,
          'ENVIRONMENT',
          p.started,
        );
        this.testInfo.annotations.push({
          type: 'sentinel-environment-retry',
          description: `${p.action} "${p.args.intent}" passed after ${attempt} retry(ies): ${diagnosis.reason}`,
        });
        return;
      } catch {
        // keep retrying with backoff
      }
    }
    this.failStep(p, diagnosis, `still failing after ${retries} environment retries`);
  }

  private escalate(
    p: { action: ActionKind; args: StepArgs; stepId: string; error: Error },
    diagnosis: Diagnosis,
    candidates: ElementFingerprint[],
    cache: CacheEntry | null,
    failureFrame: CaptureFrame,
    healingAttempted: boolean,
    healReason?: string,
  ): void {
    const written = this.recorder.writeFrame(failureFrame, this.artifactDir());
    const labels = ['A', 'B', 'C', 'D'];
    const scored = cache
      ? candidates
          .map((fp) => ({
            fp,
            score: fingerprintScore(cache.fingerprint, fp),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
      : [];
    const question: EscalationQuestion = {
      test: this.testId,
      step: p.stepId,
      intent: p.args.intent,
      question:
        diagnosis.classification === 'PRODUCT_REGRESSION'
          ? `The element for "${p.args.intent}" appears to be genuinely gone (${diagnosis.reason}). Is this a product regression, or an intentional redesign requiring a test update?`
          : `The locator for "${p.args.intent}" broke and ${
              healingAttempted
                ? `healing was not confident enough (${healReason ?? ''})`
                : 'healing was not attempted'
            }. Which candidate matches the original intent, or is this an intentional redesign?`,
      candidates: scored.map((s, i) => ({
        label: labels[i]!,
        descriptor: descriptorsFromFingerprint(s.fp)[0]!,
        confidence: Number(s.score.toFixed(2)),
        fingerprint: s.fp,
      })),
      context: {
        url: this.pageUrl(),
        classification: diagnosis.classification,
        screenshot: written.screenshot,
        error: String(p.error.message ?? p.error).split('\n')[0] ?? '',
        oldLocator: String(p.args.locator),
      },
    };
    this.ctx.store.recordEscalation({
      runId: this.ctx.runId,
      testId: this.testId,
      stepId: p.stepId,
      question,
    });
    this.testInfo.annotations.push({
      type: 'sentinel-escalation',
      description: question.question,
    });
  }

  /** Records the failed step, flushes artifacts, and throws the enriched error. */
  private failStep(
    p: { action: ActionKind; args: StepArgs; stepId: string; started: number; error: Error },
    diagnosis: Diagnosis,
    healNote: string | null,
  ): never {
    const status = diagnosis.classification === 'PRODUCT_REGRESSION' ? 'escalated' : 'failed';
    this.recordStepRow(
      p.stepId,
      p.action,
      p.args.intent,
      status,
      null,
      null,
      diagnosis.classification,
      p.started,
    );
    this.flushArtifacts();
    const lines = [
      `[sentinel] ${diagnosis.classification}: ${diagnosis.reason}`,
      `  step: ${p.action} (${p.stepId})`,
      `  intent: ${p.args.intent}`,
      `  group: ${this.groupStack.join(' > ') || '(none)'}`,
      healNote ? `  healing: ${healNote}` : null,
      `  original error: ${String(p.error.message ?? p.error).split('\n')[0]}`,
    ].filter(Boolean);
    throw new Error(lines.join('\n'), { cause: p.error });
  }

  private recordStepRow(
    stepId: string,
    action: ActionKind,
    intent: string,
    status: 'passed' | 'healed_auto' | 'healed_unverified' | 'failed' | 'escalated',
    tier: number | null,
    confidence: number | null,
    classification: string | null,
    started: number,
  ): void {
    this.ctx.store.recordStep({
      runId: this.ctx.runId,
      testId: this.testId,
      stepId,
      action,
      intent,
      groupPath: this.groupStack.join(' > '),
      status,
      tier,
      confidence,
      classification,
      durationMs: Date.now() - started,
      url: this.pageUrl(),
    });
  }

  private flushArtifacts(): void {
    try {
      this.recorder.flush(this.artifactDir());
    } catch {
      // artifact IO must never mask the real failure
    }
  }

  /** Called from fixture teardown. */
  _afterTest(): void {
    const status = this.testInfo.status ?? 'unknown';
    const normalized = status === 'passed' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed';
    if (normalized !== 'skipped') {
      this.ctx.store.recordFlakeStat(this.testId, this.ctx.gitSha, this.ctx.runId, normalized);
    }
    this.ctx.store.recordTestResult({
      runId: this.ctx.runId,
      testId: this.testId,
      title: this.testInfo.title,
      file: path.relative(this.ctx.loaded.rootDir, this.testInfo.file),
      status:
        this.unverifiedHeals > 0 && normalized === 'passed' ? 'passed_unverified' : normalized,
      durationMs: this.testInfo.duration,
      error: this.testInfo.error ? String(this.testInfo.error.message ?? '') : null,
      flakyTagged: this.cfg.diagnosis.flakeDetection
        ? this.ctx.store.isKnownFlaky(this.testId, this.ctx.gitSha)
        : false,
    });
    if (normalized === 'failed') this.flushArtifacts();
  }
}

function fingerprintScore(a: ElementFingerprint, b: ElementFingerprint): number {
  return fingerprintSimilarity(a, b).score;
}

export interface SentinelFixtures {
  s: SentinelActions;
}

export interface SentinelWorkerFixtures {
  sentinelWorker: SentinelWorkerContext;
}

export const test = base.extend<SentinelFixtures, SentinelWorkerFixtures>({
  sentinelWorker: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern
    async ({}, use, workerInfo) => {
      const loaded = await loadConfig(process.cwd());
      const store = new SentinelStore(loaded.dbPath);
      const runId =
        process.env.SENTINEL_RUN_ID ??
        `run-${new Date().toISOString().replace(/[:.]/g, '-')}-local`;
      const gitSha = detectGitSha(loaded.rootDir);
      store.ensureRun(runId, gitSha, loaded.config.healing.mode);

      const llmCfg = loaded.config.llm;
      const llmSetup = createProvider(
        {
          provider: llmCfg.provider,
          model: llmCfg.model,
          baseUrl: llmCfg.baseUrl,
          apiKey: process.env[llmCfg.apiKeyEnv],
          timeoutMs: llmCfg.timeoutMs,
          maxRetries: llmCfg.maxRetries,
          backoffBaseMs: llmCfg.backoffBaseMs,
          circuitBreakerThreshold: llmCfg.circuitBreakerThreshold,
          supportsVision: llmCfg.supportsVision,
          inputCostPerMTok: llmCfg.inputCostPerMTok,
          outputCostPerMTok: llmCfg.outputCostPerMTok,
        },
        {
          // Central accounting (spec §2): every attempt is one llm_calls row.
          onCall: (r) => store.recordLlmCall({ runId, ...r }),
          onCircuitOpen: () => {
            store.setRunMetaFlag(runId, 'healingUnavailable', true);
            console.warn(
              '[sentinel] LLM circuit breaker opened — falling back to deterministic-only healing for the rest of this run',
            );
          },
        },
      );
      if (llmSetup.disabledReason) {
        console.warn(`[sentinel] LLM healing disabled: ${llmSetup.disabledReason}`);
      }

      const ctx: SentinelWorkerContext = {
        loaded,
        store,
        runId,
        gitSha,
        llmProvider: llmSetup.provider,
        llmDisabledReason: llmSetup.disabledReason,
      };
      await use(ctx);
      store.close();
      void workerInfo;
    },
    { scope: 'worker' },
  ],
  s: async ({ page, sentinelWorker }, use, testInfo) => {
    const actions = new SentinelActions(page, testInfo, sentinelWorker);
    await use(actions);
    actions._afterTest();
  },
});

export { expect };
