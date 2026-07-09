import path from 'node:path';
import type { Flow, FlowStep, LocatorSpec } from './schema.js';

/** Marker line embedded in every generated spec; the importer refuses these. */
export const GENERATED_MARKER = '@sentinel-generated';

export function isGeneratedSpec(source: string): boolean {
  return source.includes(GENERATED_MARKER);
}

/** Single-quoted TS string literal with escaping (values may contain quotes). */
function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

/** `page.getByRole('button', { name: 'X', exact: true })` etc. — safe emitter
 * (describeDescriptor in core is for humans and does not escape). */
export function locatorCode(d: LocatorSpec): string {
  const opts = (extra?: string): string => {
    const parts: string[] = [];
    if (extra) parts.push(extra);
    if (d.exact !== undefined) parts.push(`exact: ${d.exact}`);
    return parts.length > 0 ? `, { ${parts.join(', ')} }` : '';
  };
  switch (d.kind) {
    case 'testid':
      return `page.getByTestId(${q(d.value)})`;
    case 'role':
      return `page.getByRole(${q(d.value)}${opts(d.name !== undefined ? `name: ${q(d.name)}` : undefined)})`;
    case 'label':
      return `page.getByLabel(${q(d.value)}${opts()})`;
    case 'placeholder':
      return `page.getByPlaceholder(${q(d.value)}${opts()})`;
    case 'text':
      return `page.getByText(${q(d.value)}${opts()})`;
    case 'css':
      return `page.locator(${q(d.value)})`;
  }
}

function stepCode(step: FlowStep, indent: string): string {
  if (step.action === 'goto') {
    return `${indent}await s.goto(${q(step.url)});`;
  }
  const props: string[] = [
    `stepKey: ${q(step.stepKey)}`,
    `locator: ${locatorCode(step.locator)}`,
    `intent: ${q(step.intent)}`,
  ];
  if (step.action === 'fill' || step.action === 'select') props.push(`value: ${q(step.value)}`);
  if (step.action === 'press') props.push(`key: ${q(step.key)}`);
  if (step.action === 'expectText') props.push(`text: ${q(step.text)}`);
  const body = props.map((p) => `${indent}  ${p},`).join('\n');
  return `${indent}await s.${step.action}({\n${body}\n${indent}});`;
}

/**
 * Compile a flow into a generated sentinel spec. Consecutive steps sharing a
 * `group` become one `await s.step('<group>', …)` block (mirroring how the
 * importer records `s.step` groups, so compile→import round-trips).
 */
export function compileFlow(flow: Flow, flowFileName?: string): string {
  const lines: string[] = [];
  const from = flowFileName ? ` from ${path.basename(flowFileName)}` : '';
  lines.push(`// ${GENERATED_MARKER}${from} — do not edit by hand.`);
  lines.push('// Edit the flow in Sentinel Studio; this file is regenerated on save.');
  lines.push(`import { test } from '@sentinel/core';`);
  lines.push('');
  lines.push(`test(${q(flow.title)}, async ({ page, s }) => {`);

  let i = 0;
  while (i < flow.steps.length) {
    const step = flow.steps[i]!;
    if (step.group) {
      const group = step.group;
      lines.push(`  await s.step(${q(group)}, async () => {`);
      while (i < flow.steps.length && flow.steps[i]!.group === group) {
        lines.push(stepCode(flow.steps[i]!, '    '));
        i++;
      }
      lines.push('  });');
    } else {
      lines.push(stepCode(step, '  '));
      i++;
    }
  }

  lines.push('});');
  lines.push('');
  return lines.join('\n');
}
