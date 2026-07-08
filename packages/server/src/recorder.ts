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
import { nextFlowPath, pickFlowDir, testIdFor, toPosix, writeFlowFiles } from './flowRoutes.js';

/** Raw event pushed from the page via exposeBinding. */
export interface RecorderEvent {
  type: 'click' | 'fill';
  fingerprint: ElementFingerprint;
  value?: string;
  masked?: boolean;
}

/** A captured step, pre-flow: fingerprint retained for Tier-0 cache seeding. */
export interface DraftStep {
  action: 'goto' | 'click' | 'fill';
  intent: string;
  url?: string;
  locator?: ReturnType<typeof descriptorsFromFingerprint>[number];
  value?: string;
  masked?: boolean;
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

/** Fingerprint → readable intent draft ("Add to cart button", "Email input field"). */
export function heuristicIntent(fp: ElementFingerprint, action: 'click' | 'fill'): string {
  const label =
    (action === 'fill' ? fp.labelText || fp.attributes?.placeholder || fp.name : fp.name) ||
    fp.text ||
    fp.labelText ||
    fp.attributes?.placeholder ||
    fp.testId ||
    fp.tag;
  const noun = ROLE_NOUNS[fp.role ?? ''] ?? (action === 'fill' ? 'input field' : 'element');
  const trimmed = label.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (trimmed.toLowerCase().endsWith(noun)) return trimmed;
  return `${trimmed} ${noun}`;
}

/** Convert a raw page event into a draft step (exported for unit tests). */
export function draftFromEvent(ev: RecorderEvent): DraftStep | null {
  const descriptors = descriptorsFromFingerprint(ev.fingerprint);
  if (descriptors.length === 0) return null;
  if (ev.type === 'click') {
    return {
      action: 'click',
      intent: heuristicIntent(ev.fingerprint, 'click'),
      locator: descriptors[0],
      fingerprint: ev.fingerprint,
    };
  }
  return {
    action: 'fill',
    intent: heuristicIntent(ev.fingerprint, 'fill'),
    locator: descriptors[0],
    value: ev.masked ? '' : (ev.value ?? ''),
    masked: ev.masked ?? false,
    fingerprint: ev.fingerprint,
  };
}

/** Consecutive fills on the same element collapse to the final committed value. */
export function appendDraft(steps: DraftStep[], next: DraftStep): void {
  const last = steps[steps.length - 1];
  if (
    last &&
    next.action === 'fill' &&
    last.action === 'fill' &&
    last.fingerprint?.cssPath === next.fingerprint?.cssPath
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
  const CLICKY_INPUTS = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'];
  document.addEventListener('pointerdown', (e) => {
    const raw = e.target instanceof Element ? e.target : null;
    if (!raw) return;
    const el = raw.closest(INTERACTIVE) || raw;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return; // selection handled separately (not in MVP verbs)
    if (tag === 'textarea') return; // focusing to type — the change event records the fill
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (!CLICKY_INPUTS.includes(type)) return;
    }
    const fp = fpOf(el);
    if (fp) window.__sentinelRecorderEmit({ type: 'click', fingerprint: fp });
  }, { capture: true });
  document.addEventListener('change', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (CLICKY_INPUTS.includes(type)) return; // toggles are recorded as clicks
    const fp = fpOf(el);
    if (!fp) return;
    const masked = type === 'password';
    window.__sentinelRecorderEmit({
      type: 'fill',
      fingerprint: fp,
      value: masked ? '' : (el.value ?? ''),
      masked,
    });
  }, { capture: true });
})();`;
}

export interface RecorderStatus {
  active: boolean;
  url: string | null;
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

  constructor(
    private readonly store: SentinelStore,
    private readonly loaded: LoadedConfig,
  ) {}

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
    this.browser = await chromium.launch({ headless: opts.headless ?? false });
    const context = await this.browser.newContext();
    await context.exposeBinding('__sentinelRecorderEmit', (_source, ev: RecorderEvent) => {
      const draft = draftFromEvent(ev);
      if (draft) appendDraft(this.steps, draft);
    });
    await context.addInitScript(buildCaptureScript(this.loaded.config.testIdAttribute));
    this.page = await context.newPage();
    this.active = true;
    // The user closing the browser window ends the session but keeps the draft.
    this.browser.on('disconnected', () => {
      this.active = false;
      this.browser = null;
      this.page = null;
    });
    await this.page.goto(opts.url);
  }

  status(): RecorderStatus {
    return {
      active: this.active,
      url: this.startUrl,
      steps: this.steps.map(({ fingerprint: _fp, ...rest }) => rest),
    };
  }

  async stop(): Promise<void> {
    const browser = this.browser;
    this.active = false;
    this.browser = null;
    this.page = null;
    if (browser) await browser.close().catch(() => {});
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
      const stepKey = mintStepKey();
      if (draft.action === 'click') {
        const step: FlowStep = {
          action: 'click',
          stepKey,
          intent: draft.intent,
          locator: draft.locator!,
        };
        flowSteps.push(step);
        keyed.push({ step, draft });
      } else if (draft.action === 'fill') {
        const step: FlowStep = {
          action: 'fill',
          stepKey,
          intent: draft.intent,
          locator: draft.locator!,
          value: draft.value ?? '',
          ...(draft.masked ? { masked: true } : {}),
        };
        flowSteps.push(step);
        keyed.push({ step, draft });
      }
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
