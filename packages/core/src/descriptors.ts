import type { Locator, Page } from '@playwright/test';
import type { CandidateDescriptor, ElementFingerprint } from './types.js';

const FILLABLE_TAGS = new Set(['input', 'select', 'textarea']);

/**
 * Ranked fallback strategies derived from a live element's fingerprint, in the
 * order mandated by the spec: data-testid → role+name → label → placeholder →
 * text → structural CSS. The positional CSS path is always last: it is the most
 * brittle but always present.
 */
export function descriptorsFromFingerprint(fp: ElementFingerprint): CandidateDescriptor[] {
  const out: CandidateDescriptor[] = [];
  if (fp.testId) out.push({ kind: 'testid', value: fp.testId });
  if (fp.role && fp.name) out.push({ kind: 'role', value: fp.role, name: fp.name, exact: true });
  if (fp.labelText && FILLABLE_TAGS.has(fp.tag)) {
    out.push({ kind: 'label', value: fp.labelText, exact: true });
  }
  if (fp.attributes.placeholder) {
    out.push({ kind: 'placeholder', value: fp.attributes.placeholder, exact: true });
  }
  if (fp.text && fp.text.length <= 60 && !FILLABLE_TAGS.has(fp.tag)) {
    out.push({ kind: 'text', value: fp.text, exact: true });
  }
  if (fp.classes.length > 0) {
    out.push({ kind: 'css', value: `${fp.tag}.${fp.classes.map(cssEscapeClass).join('.')}` });
  }
  if (fp.id) out.push({ kind: 'css', value: `#${cssEscapeClass(fp.id)}` });
  out.push({ kind: 'css', value: fp.cssPath });
  return out;
}

function cssEscapeClass(s: string): string {
  return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

export function buildLocator(page: Page, d: CandidateDescriptor): Locator {
  switch (d.kind) {
    case 'testid':
      return page.getByTestId(d.value);
    case 'role':
      return page.getByRole(d.value as Parameters<Page['getByRole']>[0], {
        name: d.name,
        exact: d.exact ?? true,
      });
    case 'label':
      return page.getByLabel(d.value, { exact: d.exact ?? true });
    case 'placeholder':
      return page.getByPlaceholder(d.value, { exact: d.exact ?? true });
    case 'text':
      return page.getByText(d.value, { exact: d.exact ?? true });
    case 'css':
      return page.locator(d.value);
  }
}

export function describeDescriptor(d: CandidateDescriptor): string {
  switch (d.kind) {
    case 'testid':
      return `getByTestId('${d.value}')`;
    case 'role':
      return `getByRole('${d.value}', { name: '${d.name ?? ''}', exact: ${d.exact ?? true} })`;
    case 'label':
      return `getByLabel('${d.value}', { exact: ${d.exact ?? true} })`;
    case 'placeholder':
      return `getByPlaceholder('${d.value}', { exact: ${d.exact ?? true} })`;
    case 'text':
      return `getByText('${d.value}', { exact: ${d.exact ?? true} })`;
    case 'css':
      return `locator('${d.value}')`;
  }
}

/** Code string for `sentinel promote` (written back into specs as page.<...>). */
export function descriptorToCode(d: CandidateDescriptor): string {
  return `page.${describeDescriptor(d)}`;
}
