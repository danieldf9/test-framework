import { describe, expect, it } from 'vitest';
import { migrateSource } from '../src/migrate.js';

const VANILLA = `import { test, expect } from '@playwright/test';

test('checkout', async ({ page }) => {
  await page.goto('/products');
  await page.locator('#add-to-cart-1').click();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByLabel('Email', { exact: true }).fill('a@b.com');
  await page.fill('#zip', '90210');
  await page.click('#coupon');
  await expect(page.getByText('Order confirmed')).toBeVisible();
  await expect(page.locator('.cart-badge')).toHaveText('2');
});
`;

describe('migrateSource (spec §3 codemod)', () => {
  it('wraps the mechanical subset with intent TODO stubs', () => {
    const r = migrateSource(VANILLA);
    expect(r.changed).toBe(true);
    expect(r.skipped).toBe(0);
    expect(r.wrapped).toBe(8);

    expect(r.output).toContain(`import { test, expect } from '@sentinel/core';`);
    expect(r.output).toContain('async ({ page, s })');
    expect(r.output).toContain(`await s.goto('/products')`);
    expect(r.output).toContain(
      `await s.click({ locator: page.locator('#add-to-cart-1'), intent: 'TODO' })`,
    );
    expect(r.output).toContain(
      `await s.click({ locator: page.getByRole('button', { name: 'Add to cart' }), intent: 'TODO' })`,
    );
    expect(r.output).toContain(
      `await s.fill({ locator: page.getByLabel('Email', { exact: true }), intent: 'TODO', value: 'a@b.com' })`,
    );
    // page.fill / page.click selector shorthands become explicit locators
    expect(r.output).toContain(
      `await s.fill({ locator: page.locator('#zip'), intent: 'TODO', value: '90210' })`,
    );
    expect(r.output).toContain(
      `await s.click({ locator: page.locator('#coupon'), intent: 'TODO' })`,
    );
    expect(r.output).toContain(
      `await s.expectVisible({ locator: page.getByText('Order confirmed'), intent: 'TODO' })`,
    );
    expect(r.output).toContain(
      `await s.expectText({ locator: page.locator('.cart-badge'), intent: 'TODO', text: '2' })`,
    );
  });

  it('is conservative: unsupported shapes stay byte-identical and are counted', () => {
    const src = `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await page.locator('#a').click({ force: true });
  await expect(page.locator('#b')).not.toBeVisible();
  await page.locator('#c').dblclick();
});
`;
    const r = migrateSource(src);
    expect(r.wrapped).toBe(0);
    expect(r.output).toContain(`.click({ force: true })`);
    expect(r.output).toContain('.not.toBeVisible()');
    expect(r.output).toContain('.dblclick()');
    expect(r.skipped).toBe(1); // click-with-options; .not / dblclick simply don't match
  });

  it('splits mixed imports and keeps other Playwright exports working', () => {
    const src = `import { test, expect, devices } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
});
`;
    const r = migrateSource(src);
    expect(r.output).toContain(`import { test, expect } from '@sentinel/core';`);
    expect(r.output).toContain(`import { devices } from '@playwright/test';`);
  });

  it('adds s to hooks and preserves existing fixtures', () => {
    const src = `import { test } from '@playwright/test';
test.beforeEach(async ({ page, context }) => {
  await page.goto('/login');
});
`;
    const r = migrateSource(src);
    expect(r.output).toContain('async ({ page, context, s })');
    expect(r.output).toContain(`await s.goto('/login')`);
  });

  it('is idempotent — already-migrated files are untouched', () => {
    const once = migrateSource(VANILLA).output;
    const twice = migrateSource(once);
    expect(twice.alreadyMigrated).toBe(true);
    expect(twice.output).toBe(once);
  });
});
