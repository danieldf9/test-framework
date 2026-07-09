import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import {
  descriptorsFromFingerprint,
  sentinelDomAgent,
  type ElementFingerprint,
  type LoadedConfig,
  type SentinelStore,
} from '@sentinel/core';
import { mintStepKey, parseFlow, type Flow, type FlowStep } from '@sentinel/flow';
import { createProvider } from '@sentinel/providers';
import type { StudioEvents } from './events.js';
import { nextFlowPath, pickFlowDir, testIdFor, toPosix, writeFlowFiles } from './flowRoutes.js';

/** Raw event pushed from the page via exposeBinding. */
export interface RecorderEvent {
  type: 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'assert';
  fingerprint: ElementFingerprint;
  value?: string;
  masked?: boolean;
  key?: string;
}

export type RecorderMode = 'record' | 'assert';

export type DraftAction =
  | 'goto'
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'press'
  | 'expectVisible'
  | 'expectText';

/** A captured step, pre-flow: fingerprint retained for Tier-0 cache seeding. */
export interface DraftStep {
  action: DraftAction;
  intent: string;
  url?: string;
  locator?: ReturnType<typeof descriptorsFromFingerprint>[number];
  value?: string;
  masked?: boolean;
  key?: string;
  text?: string;
  fingerprint?: ElementFingerprint;
}

const ROLE_NOUNS: Record<string, string> = {
  button: 'button',
  link: 'link',
  checkbox: 'checkbox',
  radio: 'radio button',
  combobox: 'dropdown',
  textbox: 'input field',
  searchbox: 'search field',
  spinbutton: 'number input',
  slider: 'slider',
  heading: 'heading',
};

/** Actions whose label reads best from the form label ("Email input field"). */
const LABELED_ACTIONS = new Set<Exclude<DraftAction, 'goto'>>(['fill', 'select', 'press']);

const FALLBACK_NOUN: Record<Exclude<DraftAction, 'goto'>, string> = {
  click: 'element',
  fill: 'input field',
  select: 'dropdown',
  check: 'checkbox',
  uncheck: 'checkbox',
  press: 'input field',
  expectVisible: 'element',
  expectText: 'element',
};

/** Fingerprint → readable intent draft ("Add to cart button", "Email input field"). */
export function heuristicIntent(
  fp: ElementFingerprint,
  action: Exclude<DraftAction, 'goto'>,
): string {
  const label =
    (LABELED_ACTIONS.has(action)
      ? fp.labelText || fp.attributes?.placeholder || fp.name
      : fp.name) ||
    fp.text ||
    fp.labelText ||
    fp.attributes?.placeholder ||
    fp.testId ||
    fp.tag;
  const noun = ROLE_NOUNS[fp.role ?? ''] ?? FALLBACK_NOUN[action];
  const trimmed = label.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (trimmed.toLowerCase().endsWith(noun)) return trimmed;
  return `${trimmed} ${noun}`;
}

/** Convert a raw page event into a draft step (exported for unit tests). */
export function draftFromEvent(ev: RecorderEvent): DraftStep | null {
  const descriptors = descriptorsFromFingerprint(ev.fingerprint);
  if (descriptors.length === 0) return null;
  const base = {
    intent: heuristicIntent(ev.fingerprint, ev.type === 'assert' ? 'expectVisible' : ev.type),
    locator: descriptors[0],
    fingerprint: ev.fingerprint,
  };
  switch (ev.type) {
    case 'click':
    case 'check':
    case 'uncheck':
      return { action: ev.type, ...base };
    case 'select':
      return { action: 'select', ...base, value: ev.value ?? '' };
    case 'press':
      return { action: 'press', ...base, key: ev.key || 'Enter' };
    case 'fill':
      return {
        action: 'fill',
        ...base,
        value: ev.masked ? '' : (ev.value ?? ''),
        masked: ev.masked ?? false,
      };
    case 'assert': {
      // Short visible text asserts the content; anything else asserts presence.
      const text = (ev.fingerprint.text ?? '').trim();
      if (text && text.length <= 60) return { action: 'expectText', ...base, text };
      return { action: 'expectVisible', ...base };
    }
  }
}

const TOGGLES = new Set<DraftAction>(['check', 'uncheck']);
const EXPECTS = new Set<DraftAction>(['expectVisible', 'expectText']);

/** Consecutive fills/selects on the same element collapse to the final committed
 * value; toggling the same checkbox repeatedly keeps only the final state;
 * assert-clicking the same element twice records one expectation. */
export function appendDraft(steps: DraftStep[], next: DraftStep): void {
  const last = steps[steps.length - 1];
  const sameElement = last && last.fingerprint?.cssPath === next.fingerprint?.cssPath;
  if (
    sameElement &&
    ((next.action === 'fill' && last.action === 'fill') ||
      (next.action === 'select' && last.action === 'select') ||
      (TOGGLES.has(next.action) && TOGGLES.has(last.action)) ||
      (EXPECTS.has(next.action) && EXPECTS.has(last.action)))
  ) {
    steps[steps.length - 1] = next;
    return;
  }
  steps.push(next);
}

/** The in-page capture layer: capture-phase listeners fingerprinting via the
 * same sentinelDomAgent the healing pipeline uses (serialized into the page). */
export function buildCaptureScript(testIdAttribute: string): string {
  return `(() => {
  if (window.__sentinelRecorderInstalled) return;
  window.__sentinelRecorderInstalled = true;
  const agent = ${sentinelDomAgent.toString()};
  const fpOf = (el) => {
    try {
      return agent(el, { cmd: 'fingerprint', testIdAttribute: ${JSON.stringify(testIdAttribute)} });
    } catch {
      return null;
    }
  };
  const INTERACTIVE = 'button, a[href], input, select, textarea, [role], [onclick], [tabindex], [${testIdAttribute}]';
  const CLICKY_INPUTS = ['button', 'submit', 'reset', 'image'];
  const emitFill = (el, type) => {
    const fp = fpOf(el);
    if (!fp) return;
    const masked = type === 'password';
    window.__sentinelRecorderEmit({
      type: 'fill',
      fingerprint: fp,
      value: masked ? '' : (el.value ?? ''),
      masked,
    });
  };
  // Enter commits the value AND fires change afterwards; the keydown handler
  // already emitted the fill, so that trailing change must not double-record.
  let suppressChangeFor = null;
  // Assert mode: pushed by the server on toggle, pulled once per navigation.
  let mode = 'record';
  window.__sentinelRecorderSetMode = (m) => { mode = m; };
  if (window.__sentinelRecorderMode) {
    window.__sentinelRecorderMode().then((m) => { mode = m; }).catch(() => {});
  }
  document.addEventListener('pointerdown', (e) => {
    const raw = e.target instanceof Element ? e.target : null;
    if (!raw) return;
    if (mode === 'assert') {
      // The click must observe, not act: block it and record an expectation on
      // the exact element under the pointer (assert targets are often plain text).
      e.preventDefault();
      e.stopImmediatePropagation();
      const fp = fpOf(raw);
      if (fp) window.__sentinelRecorderEmit({ type: 'assert', fingerprint: fp });
      return;
    }
    const el = raw.closest(INTERACTIVE) || raw;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return; // recorded from its change event
    if (tag === 'textarea') return; // focusing to type — the change event records the fill
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (!CLICKY_INPUTS.includes(type)) return; // checkbox/radio/text record via change
    }
    const fp = fpOf(el);
    if (fp) window.__sentinelRecorderEmit({ type: 'click', fingerprint: fp });
  }, { capture: true });
  // pointerdown's preventDefault does not stop the subsequent click from
  // activating links/buttons — both must be intercepted while asserting.
  document.addEventListener('click', (e) => {
    if (mode !== 'assert') return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });
  document.addEventListener('change', (e) => {
    if (mode === 'assert') return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      const fp = fpOf(el);
      if (fp) window.__sentinelRecorderEmit({ type: 'select', fingerprint: fp, value: el.value ?? '' });
      return;
    }
    if (tag !== 'input' && tag !== 'textarea') return;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (CLICKY_INPUTS.includes(type)) return; // recorded as clicks on pointerdown
    if (type === 'checkbox' || type === 'radio') {
      const fp = fpOf(el);
      // An unselected radio never fires change, so radios are always 'check'.
      const kind = type === 'radio' || el.checked ? 'check' : 'uncheck';
      if (fp) window.__sentinelRecorderEmit({ type: kind, fingerprint: fp });
      return;
    }
    if (suppressChangeFor === el) {
      suppressChangeFor = null;
      return;
    }
    emitFill(el, type);
  }, { capture: true });
  document.addEventListener('keydown', (e) => {
    if (mode === 'assert') return;
    if (e.key !== 'Enter') return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el || el.tagName.toLowerCase() !== 'input') return; // textarea Enter = newline
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (CLICKY_INPUTS.includes(type) || type === 'checkbox' || type === 'radio') return;
    // Flush the typed value first so the draft order is fill → press.
    emitFill(el, type);
    const fp = fpOf(el);
    if (fp) window.__sentinelRecorderEmit({ type: 'press', fingerprint: fp, key: 'Enter' });
    suppressChangeFor = el;
  }, { capture: true });
})();`;
}

export interface RecorderStatus {
  active: boolean;
  url: string | null;
  mode: RecorderMode;
  steps: Array<Omit<DraftStep, 'fingerprint'>>;
}

export interface SaveResult {
  path: string;
  title: string;
  seededSteps: number;
  intentSource: 'llm' | 'heuristic';
}

/**
 * Owns at most one recording session. The browser opens headed on the user's
 * machine (local-first); every interaction is fingerprinted in-page and becomes
 * a draft step. Saving mints stepKeys, writes the flow + generated spec, and
 * seeds the Tier-0 locator cache from the recorded fingerprints — recorded
 * tests are born healable.
 */
export class RecorderController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private startUrl: string | null = null;
  private steps: DraftStep[] = [];
  private active = false;
  private mode: RecorderMode = 'record';

  constructor(
    private readonly store: SentinelStore,
    private readonly loaded: LoadedConfig,
    private readonly events?: StudioEvents,
  ) {}

  /** Any observable session change → one poke; subscribers refetch the status. */
  private changed(): void {
    this.events?.emit('recorder-changed', {});
  }

  isActive(): boolean {
    return this.active;
  }

  /** The live page of the active session — exposed for headless e2e testing. */
  get currentPage(): Page | null {
    return this.page;
  }

  async start(opts: { url: string; headless?: boolean }): Promise<void> {
    if (this.active) throw new Error('a recording session is already active');
    if (!/^https?:\/\//.test(opts.url)) {
      throw new Error('url must be absolute (e.g. http://127.0.0.1:4173/products)');
    }
    const { chromium } = await import('@playwright/test');
    this.steps = [];
    this.startUrl = opts.url;
    this.mode = 'record';
    this.browser = await chromium.launch({ headless: opts.headless ?? false });
    const context = await this.browser.newContext();
    await context.exposeBinding('__sentinelRecorderEmit', (_source, ev: RecorderEvent) => {
      const draft = draftFromEvent(ev);
      if (draft) {
        appendDraft(this.steps, draft);
        this.changed();
      }
    });
    // Pulled by the capture script on every navigation so the mode survives page loads.
    await context.exposeBinding('__sentinelRecorderMode', () => this.mode);
    await context.addInitScript(buildCaptureScript(this.loaded.config.testIdAttribute));
    this.page = await context.newPage();
    this.active = true;
    // The user closing the browser window ends the session but keeps the draft.
    this.browser.on('disconnected', () => {
      this.active = false;
      this.browser = null;
      this.page = null;
      this.changed();
    });
    await this.page.goto(opts.url);
    this.changed();
  }

  status(): RecorderStatus {
    return {
      active: this.active,
      url: this.startUrl,
      mode: this.mode,
      steps: this.steps.map(({ fingerprint: _fp, ...rest }) => rest),
    };
  }

  /** Toggle record/assert; pushed into the live page immediately (best-effort —
   * a page mid-navigation picks it up from the binding when it reinstalls).
   * String-form evaluate: the server compiles without DOM types (like the
   * capture script, page-side code stays out of this package's type space). */
  async setMode(mode: RecorderMode): Promise<void> {
    this.mode = mode;
    if (this.page) {
      await this.page
        .evaluate(
          `window.__sentinelRecorderSetMode && window.__sentinelRecorderSetMode(${JSON.stringify(mode)})`,
        )
        .catch(() => {});
    }
    this.changed();
  }

  /** Retype an assertion draft (expectVisible ⇄ expectText) or edit its text. */
  updateDraft(
    index: number,
    patch: { action?: 'expectVisible' | 'expectText'; text?: string },
  ): void {
    const step = this.steps[index];
    if (!step) throw new Error(`no draft step at index ${index}`);
    if (step.action !== 'expectVisible' && step.action !== 'expectText') {
      throw new Error('only assertion steps can be edited before saving');
    }
    if (patch.action) step.action = patch.action;
    if (patch.text !== undefined) step.text = patch.text;
    if (step.action === 'expectVisible') delete step.text;
    else if (step.text === undefined) step.text = '';
    this.changed();
  }

  /** Drop a captured draft step (misclicks, noise). */
  removeDraft(index: number): void {
    if (!this.steps[index]) throw new Error(`no draft step at index ${index}`);
    this.steps.splice(index, 1);
    this.changed();
  }

  async stop(): Promise<void> {
    const browser = this.browser;
    this.active = false;
    this.browser = null;
    this.page = null;
    if (browser) await browser.close().catch(() => {});
    this.changed();
  }

  /** Build the flow (goto + captured steps), refine intents, write files, seed cache. */
  async save(title: string): Promise<SaveResult> {
    if (!this.startUrl) throw new Error('nothing recorded yet');
    if (this.steps.length === 0) throw new Error('no interactions were recorded');
    await this.stop();

    let intentSource: SaveResult['intentSource'] = 'heuristic';
    try {
      const refined = await this.refineIntentsWithLlm(this.steps);
      if (refined) {
        for (const [i, intent] of refined.entries()) {
          const step = this.steps[i];
          if (step && intent) step.intent = intent.slice(0, 500);
        }
        intentSource = 'llm';
      }
    } catch {
      // Heuristic intents are already in place — LLM refinement is best-effort.
    }

    const keyed: Array<{ step: FlowStep; draft: DraftStep }> = [];
    const flowSteps: FlowStep[] = [{ action: 'goto', url: this.startUrl }];
    for (const draft of this.steps) {
      if (draft.action === 'goto') continue; // never captured — the start URL is the goto
      const base = { stepKey: mintStepKey(), intent: draft.intent, locator: draft.locator! };
      let step: FlowStep;
      switch (draft.action) {
        case 'click':
        case 'check':
        case 'uncheck':
          step = { action: draft.action, ...base };
          break;
        case 'select':
          step = { action: 'select', ...base, value: draft.value ?? '' };
          break;
        case 'press':
          step = { action: 'press', ...base, key: draft.key || 'Enter' };
          break;
        case 'fill':
          step = {
            action: 'fill',
            ...base,
            value: draft.value ?? '',
            ...(draft.masked ? { masked: true } : {}),
          };
          break;
        case 'expectVisible':
          step = { action: 'expectVisible', ...base };
          break;
        case 'expectText':
          step = { action: 'expectText', ...base, text: draft.text ?? '' };
          break;
      }
      flowSteps.push(step);
      keyed.push({ step, draft });
    }
    const flow: Flow = parseFlow({ version: 1, title, steps: flowSteps });

    const rootDir = this.loaded.rootDir;
    const abs = nextFlowPath(pickFlowDir(rootDir), title);
    writeFlowFiles(abs, flow);

    // Seed the Tier-0 cache: the recorded fingerprint + ranked descriptors make
    // the new test healable from its very first run.
    const specAbs = abs.replace(/\.flow\.json$/, '.flow.spec.ts');
    const testId = testIdFor(rootDir, specAbs, title);
    let seeded = 0;
    for (const { step, draft } of keyed) {
      if (!draft.fingerprint || step.action === 'goto') continue;
      const descriptors = descriptorsFromFingerprint(draft.fingerprint);
      if (descriptors.length === 0) continue;
      this.store.upsertCacheEntry({
        testId,
        stepId: step.stepKey,
        primary: descriptors[0]!,
        alternates: descriptors.slice(1, 9),
        fingerprint: draft.fingerprint,
        intent: step.intent,
        lastVerifiedAt: Date.now(),
      });
      seeded++;
    }
    this.steps = [];
    this.startUrl = null;
    this.changed();
    return { path: toPosix(path.relative(rootDir, abs)), title, seededSteps: seeded, intentSource };
  }

  /** One batched call: fingerprints in, intent strings out. Returns null when no
   * LLM is configured; throws on any provider problem (caller falls back). */
  private async refineIntentsWithLlm(steps: DraftStep[]): Promise<string[] | null> {
    const llm = this.loaded.config.llm;
    if (llm.provider === 'none') return null;
    const setup = createProvider(
      {
        provider: llm.provider,
        model: llm.model,
        baseUrl: llm.baseUrl,
        apiKey: process.env[llm.apiKeyEnv],
        timeoutMs: Math.min(llm.timeoutMs, 30_000),
        maxRetries: 0,
        backoffBaseMs: llm.backoffBaseMs,
        circuitBreakerThreshold: llm.circuitBreakerThreshold,
        supportsVision: llm.supportsVision,
        inputCostPerMTok: llm.inputCostPerMTok,
        outputCostPerMTok: llm.outputCostPerMTok,
      },
      {
        onCall: (r) => {
          this.store.ensureRun('studio-recorder', null, 'n/a');
          this.store.recordLlmCall({ runId: 'studio-recorder', ...r });
        },
      },
    );
    if (!setup.provider) return null;
    const summaries = steps.map((d, i) => ({
      index: i,
      action: d.action,
      tag: d.fingerprint?.tag,
      role: d.fingerprint?.role,
      name: d.fingerprint?.name,
      text: d.fingerprint?.text,
      label: d.fingerprint?.labelText,
      placeholder: d.fingerprint?.attributes?.placeholder,
      nearbyText: d.fingerprint?.nearbyText?.slice(0, 120),
    }));
    const res = await setup.provider.complete({
      messages: [
        {
          role: 'system',
          content:
            'You write short semantic intent descriptions for UI test steps. For each element, describe WHAT it is and WHERE it sits (e.g. "Add to cart button on the first product card"). Reply with ONLY a JSON array of strings, one per input element, same order. No markdown.',
        },
        { role: 'user', content: JSON.stringify(summaries) },
      ],
      maxTokens: 2048,
      purpose: 'recorder-intents',
    });
    const text = res.text ?? '';
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) throw new Error('no JSON array in reply');
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) throw new Error('reply is not an array');
    return arr.map((x) => (typeof x === 'string' ? x : ''));
  }
}
