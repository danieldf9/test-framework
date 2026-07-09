import { makeStepId } from '@sentinel/core';
import { describe, expect, it } from 'vitest';
import { compileFlow, isGeneratedSpec, locatorCode } from '../src/compile.js';
import { importSpecSource } from '../src/importSpec.js';
import { parseFlow, specPathForFlow, slugForTitle, type Flow } from '../src/schema.js';

const flow: Flow = {
  version: 1,
  title: 'shopper adds a product',
  steps: [
    { action: 'goto', url: '/products' },
    {
      action: 'click',
      stepKey: 'k-add-1',
      intent: 'Add to cart button on the first product card',
      locator: { kind: 'testid', value: 'add-to-cart-1' },
    },
    {
      action: 'fill',
      stepKey: 'k-email',
      intent: 'Email input in the checkout form',
      locator: { kind: 'label', value: 'Email', exact: true },
      value: "o'brien@example.com",
      group: 'fill contact details',
    },
    {
      action: 'expectText',
      stepKey: 'k-count',
      intent: 'Cart counter badge',
      locator: { kind: 'css', value: '#cart-count' },
      text: '1',
      group: 'fill contact details',
    },
    {
      action: 'select',
      stepKey: 'k-ship',
      intent: 'Shipping method dropdown',
      locator: { kind: 'label', value: 'Shipping', exact: true },
      value: 'express',
    },
    {
      action: 'check',
      stepKey: 'k-terms',
      intent: 'Accept terms checkbox',
      locator: { kind: 'role', value: 'checkbox', name: 'I agree', exact: true },
    },
    {
      action: 'uncheck',
      stepKey: 'k-news',
      intent: 'Newsletter opt-in checkbox',
      locator: { kind: 'testid', value: 'newsletter' },
    },
    {
      action: 'press',
      stepKey: 'k-search',
      intent: 'Coupon code input',
      locator: { kind: 'placeholder', value: 'Coupon' },
      key: 'Enter',
    },
    {
      action: 'expectVisible',
      stepKey: 'k-confirm',
      intent: 'Order confirmation message',
      locator: { kind: 'role', value: 'status', name: 'Order confirmed', exact: true },
    },
  ],
};

describe('schema', () => {
  it('accepts a valid flow and rejects duplicate stepKeys', () => {
    expect(() => parseFlow(flow)).not.toThrow();
    const dup = structuredClone(flow) as Flow;
    (dup.steps[2] as { stepKey: string }).stepKey = 'k-add-1';
    expect(() => parseFlow(dup)).toThrow(/duplicate stepKey/);
  });

  it('rejects unknown actions and empty intents', () => {
    expect(() => parseFlow({ version: 1, title: 't', steps: [{ action: 'hover' }] })).toThrow();
    expect(() =>
      parseFlow({
        version: 1,
        title: 't',
        steps: [
          { action: 'click', stepKey: 'k1', intent: '', locator: { kind: 'css', value: '#x' } },
        ],
      }),
    ).toThrow(/intent/);
  });

  it('requires a non-empty key on press but allows an empty select value', () => {
    const base = { stepKey: 'k1', intent: 'x', locator: { kind: 'css', value: '#x' } };
    expect(() =>
      parseFlow({ version: 1, title: 't', steps: [{ action: 'press', ...base, key: '' }] }),
    ).toThrow(/key/);
    // '' is a legal <option> value (placeholder options) — must not be rejected.
    expect(() =>
      parseFlow({ version: 1, title: 't', steps: [{ action: 'select', ...base, value: '' }] }),
    ).not.toThrow();
  });

  it('maps flow file paths to generated spec paths', () => {
    expect(specPathForFlow('specs/checkout.flow.json')).toBe('specs/checkout.flow.spec.ts');
    expect(() => specPathForFlow('specs/checkout.json')).toThrow(/not a flow file/);
    expect(slugForTitle('Shopper adds a product!')).toBe('shopper-adds-a-product');
  });
});

describe('compileFlow', () => {
  it('emits a generated sentinel spec with stepKeys, groups, and escaped strings', () => {
    const code = compileFlow(flow, 'shopper-adds-a-product.flow.json');
    expect(isGeneratedSpec(code)).toBe(true);
    expect(code).toContain(`import { test } from '@sentinel/core';`);
    expect(code).toContain(`test('shopper adds a product', async ({ page, s }) => {`);
    expect(code).toContain(`await s.goto('/products');`);
    expect(code).toContain(`stepKey: 'k-add-1',`);
    expect(code).toContain(`locator: page.getByTestId('add-to-cart-1'),`);
    // s.step group wraps the two consecutive grouped steps
    expect(code).toContain(`await s.step('fill contact details', async () => {`);
    // embedded quote is escaped, not broken
    expect(code).toContain(`value: 'o\\'brien@example.com',`);
    expect(code).toContain(
      `locator: page.getByRole('status', { name: 'Order confirmed', exact: true }),`,
    );
    // Phase 3 verbs emit their per-verb extras
    expect(code).toContain(`await s.select({`);
    expect(code).toContain(`value: 'express',`);
    expect(code).toContain(`await s.check({`);
    expect(code).toContain(`await s.uncheck({`);
    expect(code).toContain(`await s.press({`);
    expect(code).toContain(`key: 'Enter',`);
  });

  it('locatorCode covers every descriptor kind', () => {
    expect(locatorCode({ kind: 'testid', value: 'x' })).toBe(`page.getByTestId('x')`);
    expect(locatorCode({ kind: 'placeholder', value: 'Search', exact: false })).toBe(
      `page.getByPlaceholder('Search', { exact: false })`,
    );
    expect(locatorCode({ kind: 'text', value: 'Hi' })).toBe(`page.getByText('Hi')`);
    expect(locatorCode({ kind: 'css', value: '#a > b' })).toBe(`page.locator('#a > b')`);
  });
});

describe('importSpecSource', () => {
  it('round-trips a compiled flow, preserving stepKeys with no rekeys', () => {
    const code = compileFlow(flow, 'x.flow.json');
    // Generated specs are refused (edit the flow instead) — strip the marker to
    // simulate a hand-written spec that happens to carry stepKeys.
    const asHandwritten = code
      .split('\n')
      .filter((l) => !l.startsWith('//'))
      .join('\n');
    const result = importSpecSource(asHandwritten, 'x.spec.ts');
    if (!result.importable) throw new Error(result.reason);
    expect(result.flows).toHaveLength(1);
    const imported = result.flows[0]!;
    expect(imported.flow).toEqual(flow); // exact roundtrip incl. groups + keys
    expect(imported.rekeys).toHaveLength(0); // keys existed — nothing to migrate
  });

  it('imports a keyless hand-authored spec, minting keys and planning rekeys', () => {
    const src = `import { test } from '@sentinel/core';

test('cart', async ({ page, s }) => {
  await s.goto('/products');
  await s.click({ locator: page.locator('#add-1'), intent: 'Add to cart' });
  await s.click({ locator: page.locator('#add-1'), intent: 'Add to cart' });
  await s.expectText({ locator: page.getByTestId('count'), intent: 'Cart badge', text: '2' });
});
`;
    const result = importSpecSource(src, 'cart.spec.ts');
    if (!result.importable) throw new Error(result.reason);
    const { flow: f, rekeys } = result.flows[0]!;
    expect(f.steps).toHaveLength(4);
    expect(rekeys).toHaveLength(3);
    // Old ids mirror the fixture's derived ids, occurrence-counted per (action, intent).
    expect(rekeys[0]!.oldStepId).toBe(makeStepId('click', 'Add to cart', 0));
    expect(rekeys[1]!.oldStepId).toBe(makeStepId('click', 'Add to cart', 1));
    expect(rekeys[2]!.oldStepId).toBe(makeStepId('expectText', 'Cart badge', 0));
    // Minted keys are unique and D38-valid.
    const keys = rekeys.map((r) => r.newStepId);
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
  });

  it('refuses generated specs, non-sentinel files, and unsupported shapes', () => {
    expect(importSpecSource(compileFlow(flow)).importable).toBe(false);
    expect(importSpecSource(`import { test } from '@playwright/test';`).importable).toBe(false);

    const withHelper = `import { test } from '@sentinel/core';
const helper = () => {};
test('t', async ({ page, s }) => { await s.goto('/'); });
`;
    const r1 = importSpecSource(withHelper);
    expect(r1.importable).toBe(false);
    if (!r1.importable) expect(r1.reason).toMatch(/only import \+ test/);

    const withOptions = `import { test } from '@sentinel/core';
test('t', async ({ page, s }) => {
  await s.click({ locator: page.locator('#x').first(), intent: 'x' });
});
`;
    expect(importSpecSource(withOptions).importable).toBe(false);

    const withVariable = `import { test } from '@sentinel/core';
test('t', async ({ page, s }) => {
  const loc = page.locator('#x');
  await s.click({ locator: loc, intent: 'x' });
});
`;
    expect(importSpecSource(withVariable).importable).toBe(false);
  });

  it('imports the real example spec shape (shop.spec.ts with s.step groups)', () => {
    const src = `import { test } from '@sentinel/core';

test('checkout flow completes with confirmation', async ({ page, s }) => {
  await s.goto('/products');
  await s.click({
    locator: page.locator('#add-to-cart-1'),
    intent: 'Add to cart button on the first product card (Aurora Desk Lamp)',
  });
  await s.step('fill contact details and place the order', async () => {
    await s.fill({
      locator: page.getByLabel('Email', { exact: true }),
      intent: 'Email input field in the checkout contact form',
      value: 'test@example.com',
    });
    await s.click({
      locator: page.locator('.btn-order'),
      intent: 'Place order submit button at the bottom of the checkout form',
    });
  });
  await s.expectVisible({
    locator: page.getByText('Order confirmed'),
    intent: 'Order confirmation success message shown after purchase completes',
  });
});
`;
    const result = importSpecSource(src, 'shop.spec.ts');
    if (!result.importable) throw new Error(result.reason);
    const { flow: f, rekeys } = result.flows[0]!;
    expect(f.steps).toHaveLength(5);
    expect(f.steps[2]!.group).toBe('fill contact details and place the order');
    expect(f.steps[3]!.group).toBe('fill contact details and place the order');
    expect(f.steps[4]!.group).toBeUndefined();
    expect(rekeys).toHaveLength(4); // all keyed verbs; goto has no key
  });
});
