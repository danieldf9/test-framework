import type { ElementFingerprint } from '@sentinel/core';
import { describe, expect, it } from 'vitest';
import {
  appendDraft,
  buildCaptureScript,
  draftFromEvent,
  heuristicIntent,
  RecorderController,
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

  it('converts select changes and coalesces re-selection on the same dropdown', () => {
    const shipFp = fp({
      tag: 'select',
      role: 'combobox',
      labelText: 'Shipping',
      cssPath: 'body > select:nth-of-type(1)',
    });
    const steps: DraftStep[] = [];
    appendDraft(steps, draftFromEvent({ type: 'select', fingerprint: shipFp, value: 'std' })!);
    appendDraft(steps, draftFromEvent({ type: 'select', fingerprint: shipFp, value: 'express' })!);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.action).toBe('select');
    expect(steps[0]!.value).toBe('express'); // last selection wins
    expect(steps[0]!.intent).toBe('Shipping dropdown');
  });

  it('keeps only the final state when a checkbox is toggled repeatedly', () => {
    const termsFp = fp({
      tag: 'input',
      role: 'checkbox',
      labelText: 'I agree',
      name: 'I agree',
      cssPath: 'body > input:nth-of-type(3)',
    });
    const steps: DraftStep[] = [];
    appendDraft(steps, draftFromEvent({ type: 'check', fingerprint: termsFp })!);
    appendDraft(steps, draftFromEvent({ type: 'uncheck', fingerprint: termsFp })!);
    appendDraft(steps, draftFromEvent({ type: 'check', fingerprint: termsFp })!);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.action).toBe('check');
    expect(steps[0]!.intent).toBe('I agree checkbox');
  });

  it('does not coalesce a select with a fill on the same element path', () => {
    const path = 'body > input:nth-of-type(1)';
    const steps: DraftStep[] = [];
    appendDraft(
      steps,
      draftFromEvent({
        type: 'fill',
        fingerprint: fp({ tag: 'input', cssPath: path }),
        value: 'a',
      })!,
    );
    appendDraft(
      steps,
      draftFromEvent({
        type: 'select',
        fingerprint: fp({ tag: 'select', cssPath: path }),
        value: 'b',
      })!,
    );
    expect(steps).toHaveLength(2);
  });

  it('converts an Enter press with the key retained', () => {
    const d = draftFromEvent({
      type: 'press',
      fingerprint: fp({ tag: 'input', role: 'searchbox', labelText: 'Search' }),
      key: 'Enter',
    })!;
    expect(d.action).toBe('press');
    expect(d.key).toBe('Enter');
    expect(d.intent).toBe('Search search field');
  });

  it('maps asserts to expectText for short text, expectVisible otherwise, and coalesces', () => {
    const confirmFp = fp({
      tag: 'div',
      role: null,
      text: 'Order confirmed',
      cssPath: 'body > div:nth-of-type(2)',
    });
    const short = draftFromEvent({ type: 'assert', fingerprint: confirmFp })!;
    expect(short.action).toBe('expectText');
    expect(short.text).toBe('Order confirmed');

    const long = draftFromEvent({
      type: 'assert',
      fingerprint: fp({ tag: 'p', role: null, text: 'x'.repeat(80) }),
    })!;
    expect(long.action).toBe('expectVisible');
    expect(long.text).toBeUndefined();

    const steps: DraftStep[] = [];
    appendDraft(steps, draftFromEvent({ type: 'assert', fingerprint: confirmFp })!);
    appendDraft(steps, draftFromEvent({ type: 'assert', fingerprint: confirmFp })!);
    expect(steps).toHaveLength(1); // double assert-click on the same element
  });
});

describe('draft editing (assert mode)', () => {
  function seeded(steps: DraftStep[]): RecorderController {
    const c = new RecorderController(null as never, null as never);
    (c as unknown as { steps: DraftStep[] }).steps = steps;
    return c;
  }

  it('retypes assertions both ways and edits expected text', () => {
    const steps: DraftStep[] = [
      { action: 'expectText', intent: 'Confirmation', text: 'Order confirmed' },
    ];
    const c = seeded(steps);
    c.updateDraft(0, { action: 'expectVisible' });
    expect(steps[0]).not.toHaveProperty('text'); // visible-asserts carry no text
    c.updateDraft(0, { action: 'expectText' });
    expect(steps[0]!.text).toBe(''); // retyping back starts blank
    c.updateDraft(0, { text: 'Order confirmed' });
    expect(steps[0]!.text).toBe('Order confirmed');
  });

  it('refuses to retype interaction steps and validates indices; delete works on any step', () => {
    const steps: DraftStep[] = [
      { action: 'click', intent: 'Add to cart button' },
      { action: 'expectVisible', intent: 'Confirmation' },
    ];
    const c = seeded(steps);
    expect(() => c.updateDraft(0, { action: 'expectText' })).toThrow(/assertion/);
    expect(() => c.updateDraft(5, {})).toThrow(/no draft step/);
    c.removeDraft(0);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.action).toBe('expectVisible');
    expect(() => c.removeDraft(3)).toThrow(/no draft step/);
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
