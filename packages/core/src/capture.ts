import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { sentinelDomAgent, type DomAgentOptions } from './domAgent.js';
import { sha1 } from './ids.js';

export interface CaptureFrame {
  stepId: string;
  action: string;
  label: 'before' | 'after' | 'failure' | 'healed';
  url: string;
  ts: number;
  screenshot: Buffer | null;
  /** Sanitized HTML (secrets stripped in-page before it ever leaves the browser). */
  domHtml: string | null;
}

export interface CaptureOptions {
  enabled: boolean;
  ringBufferSize: number;
  screenshots: boolean;
  domSnapshots: boolean;
  /** Blur typed values + redaction targets in screenshots before capture. */
  maskInputsInScreenshots: boolean;
  testIdAttribute: string;
  redactSelectors: string[];
  maskPatterns: string[];
}

/**
 * Ring-buffered auto-capture (spec §3): every action captures screenshot + DOM
 * snapshot + URL + timestamp; only the last N are kept so artifacts stay small.
 * Frames are flushed to disk only on failure or heal.
 */
export class ArtifactRecorder {
  private frames: CaptureFrame[] = [];

  constructor(private readonly opts: CaptureOptions) {}

  async captureFrame(
    page: Page,
    meta: { stepId: string; action: string; label: CaptureFrame['label'] },
  ): Promise<CaptureFrame> {
    let screenshot: Buffer | null = null;
    let domHtml: string | null = null;
    let url = '';
    try {
      url = page.url();
    } catch {
      /* page may be closed */
    }
    if (this.opts.screenshots) {
      // Screenshots may reach an LLM (Tier 3) and land in CI artifacts — blur
      // typed values and redaction targets IN THE PAGE before capturing, then
      // restore (spec §10: sanitize screenshots before sending anywhere).
      const masked = this.opts.maskInputsInScreenshots;
      const maskCss = [
        'input',
        'textarea',
        'select',
        '[data-sentinel-redacted]',
        ...this.opts.redactSelectors,
      ].join(', ');
      if (masked) {
        try {
          await page.evaluate((css) => {
            const style = document.createElement('style');
            style.id = '__sentinel-screenshot-mask';
            style.textContent = `${css} { filter: blur(8px) !important; }`;
            document.head.appendChild(style);
          }, maskCss);
        } catch {
          /* page may be navigating — capture unmasked artifacts are still local-only */
        }
      }
      try {
        screenshot = await page.screenshot({ type: 'jpeg', quality: 50, timeout: 4_000 });
      } catch {
        screenshot = null;
      }
      if (masked) {
        try {
          await page.evaluate(() =>
            document.getElementById('__sentinel-screenshot-mask')?.remove(),
          );
        } catch {
          /* best effort */
        }
      }
    }
    if (this.opts.domSnapshots) {
      try {
        const body = await page.evaluateHandle(() => document.body);
        const agentOpts: DomAgentOptions = {
          cmd: 'sanitize',
          testIdAttribute: this.opts.testIdAttribute,
          redactSelectors: this.opts.redactSelectors,
          maskPatterns: this.opts.maskPatterns,
        };
        domHtml = (await body.evaluate(sentinelDomAgent, agentOpts)) as string;
        await body.dispose();
      } catch {
        domHtml = null;
      }
    }
    return { ...meta, url, ts: Date.now(), screenshot, domHtml };
  }

  async record(
    page: Page,
    meta: { stepId: string; action: string; label: CaptureFrame['label'] },
  ): Promise<CaptureFrame | null> {
    if (!this.opts.enabled) return null;
    const frame = await this.captureFrame(page, meta);
    this.frames.push(frame);
    while (this.frames.length > this.opts.ringBufferSize) this.frames.shift();
    return frame;
  }

  /** Persist a single frame immediately (heal before/after evidence). */
  writeFrame(frame: CaptureFrame, dir: string): { screenshot: string | null; dom: string | null } {
    mkdirSync(dir, { recursive: true });
    const base = `${frame.ts}-${frame.stepId}-${frame.label}`;
    let screenshotPath: string | null = null;
    let domPath: string | null = null;
    if (frame.screenshot) {
      screenshotPath = path.join(dir, `${base}.jpg`);
      writeFileSync(screenshotPath, frame.screenshot);
    }
    if (frame.domHtml) {
      domPath = path.join(dir, `${base}.html.gz`);
      writeFileSync(domPath, gzipSync(frame.domHtml));
    }
    return { screenshot: screenshotPath, dom: domPath };
  }

  /** Flush the whole ring buffer (test failure post-mortem context). */
  flush(dir: string): string[] {
    const written: string[] = [];
    for (const frame of this.frames) {
      const res = this.writeFrame(frame, dir);
      if (res.screenshot) written.push(res.screenshot);
      if (res.dom) written.push(res.dom);
    }
    this.frames = [];
    return written;
  }
}

/** Stable, filesystem-safe directory name for a test. */
export function testArtifactDirName(testId: string): string {
  const slug = testId
    .split('::')
    .pop()!
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug}-${sha1(testId).slice(0, 8)}`;
}
