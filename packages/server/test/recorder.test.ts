import type { ElementFingerprint } from '@sentinel/core';
import { describe, expect, it } from 'vitest';
import {
  appendDraft,
  buildCaptureScript,
  draftFromEvent,
  heuristicIntent,
  type DraftStep,
} from '../src/recorder.js';

function fp(overrides: Partial<ElementFingerprint>): ElementFingerprint {
  return {
    tag: 'button',
    role: 'button',
    name: '',
    text: '',
    id: null,
    testId: null,
    classes: [],
    attributes: {},
    nearbyText: '',
    labelText: '',
    cssPath: 'body > button:nth-of-type(1)',
    ...overrides,
  };
}

describe('heuristicIntent', () => {
  it('labels clicks by accessible name + role noun', () => {
    expect(heuristicIntent(fp({ name: 'Add to cart' }), 'click')).toBe('Add to cart button');
    expect(heuristicIntent(fp({ tag: 'a', role: 'link', name: 'Checkout' }), 'click')).toBe(
      'Checkout link',
    );
  });

  it('does not duplicate the noun and prefers labels for fills', () => {
    expect(heuristicIntent(fp({ name: 'Submit button' }), 'click')).toBe('Submit button');
    expect(
      heuristicIntent(
        fp({ tag: 'input', role: 'textbox', name: 'Email', labelText: 'Email' }),
        'fill',
      ),
    ).toBe('Email input field');
  });
});

describe('draftFromEvent + appendDraft', () => {
  it('converts a click with ranked locator and keeps the fingerprint for seeding', () => {
    const d = draftFromEvent({
      type: 'click',
      fingerprint: fp({ name: 'Add to cart', testId: 'add-1' }),
    })!;
    expect(d.action).toBe('click');
    expect(d.locator).toEqual({ kind: 'testid', value: 'add-1' }); // testid ranks first
    expect(d.fingerprint).toBeTruthy();
  });

  it('masks password fills and coalesces consecutive fills on the same element', () => {
    const steps: DraftStep[] = [];
    const emailFp = fp({
      tag: 'input',
      role: 'textbox',
      labelText: 'Email',
      cssPath: 'body > input:nth-of-type(1)',
    });
    appendDraft(steps, draftFromEvent({ type: 'fill', fingerprint: emailFp, value: 'a@b.c' })!);
    appendDraft(steps, draftFromEvent({ type: 'fill', fingerprint: emailFp, value: 'x@y.z' })!);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.value).toBe('x@y.z'); // last committed value wins

    const pw = draftFromEvent({
      type: 'fill',
      fingerprint: fp({ tag: 'input', role: 'textbox', cssPath: 'body > input:nth-of-type(2)' }),
      value: '',
      masked: true,
    })!;
    appendDraft(steps, pw);
    expect(steps).toHaveLength(2);
    expect(steps[1]!.masked).toBe(true);
    expect(steps[1]!.value).toBe('');
  });
});

describe('buildCaptureScript', () => {
  it('inlines the dom agent and the configured test id attribute', () => {
    const script = buildCaptureScript('data-qa');
    expect(script).toContain('function sentinelDomAgent');
    expect(script).toContain('"data-qa"');
    expect(script).toContain('__sentinelRecorderEmit');
    // idempotent installation guard
    expect(script).toContain('__sentinelRecorderInstalled');
  });
});
