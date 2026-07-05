import { describe, expect, it } from 'vitest';
import { describeDescriptor, descriptorsFromFingerprint } from '../src/descriptors.js';
import { makeStepId, makeTestId } from '../src/ids.js';
import { makeFp } from './helpers.js';

describe('descriptorsFromFingerprint — fallback ladder (spec §4 Tier 0)', () => {
  it('ranks testid → role+name → placeholder → text → css → positional path', () => {
    const fp = makeFp({
      testId: 'place-order',
      role: 'button',
      name: 'Place order',
      text: 'Place order',
      classes: ['btn', 'btn-order'],
      attributes: { placeholder: '' },
    });
    const kinds = descriptorsFromFingerprint(fp).map((d) => d.kind);
    expect(kinds[0]).toBe('testid');
    expect(kinds[1]).toBe('role');
    expect(kinds).toContain('text');
    expect(kinds[kinds.length - 1]).toBe('css'); // positional path is always last
  });

  it('derives label candidates only for form controls', () => {
    const input = makeFp({
      tag: 'input',
      role: 'textbox',
      labelText: 'Email',
      name: 'Email',
      text: '',
      attributes: { placeholder: 'you@example.com' },
    });
    const ds = descriptorsFromFingerprint(input);
    expect(ds.some((d) => d.kind === 'label' && d.value === 'Email')).toBe(true);
    expect(ds.some((d) => d.kind === 'placeholder')).toBe(true);
    expect(ds.some((d) => d.kind === 'text')).toBe(false); // never text-match an input

    const button = makeFp({ labelText: 'stray', text: 'Click me', name: 'Click me' });
    expect(descriptorsFromFingerprint(button).some((d) => d.kind === 'label')).toBe(false);
  });
});

describe('describeDescriptor', () => {
  it('renders human-auditable locator strings', () => {
    expect(describeDescriptor({ kind: 'testid', value: 'x' })).toBe(`getByTestId('x')`);
    expect(describeDescriptor({ kind: 'css', value: '#a' })).toBe(`locator('#a')`);
  });
});

describe('stable ids', () => {
  it('testId and stepId are deterministic and collision-resistant', () => {
    expect(makeTestId('specs\\shop.spec.ts', ['shop', 'checkout'])).toBe(
      'specs/shop.spec.ts::shop > checkout',
    );
    const a = makeStepId('click', 'Add to cart button', 0);
    expect(a).toBe(makeStepId('click', 'Add to cart button', 0));
    expect(a).not.toBe(makeStepId('click', 'Add to cart button', 1));
    expect(a).not.toBe(makeStepId('fill', 'Add to cart button', 0));
    expect(a).toMatch(/^s_[0-9a-f]{12}$/);
  });
});
