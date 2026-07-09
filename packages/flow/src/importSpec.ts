import { makeStepId } from '@sentinel/core';
import ts from 'typescript';
import { isGeneratedSpec } from './compile.js';
import { mintStepKey, parseFlow, type Flow, type FlowStep, type LocatorSpec } from './schema.js';

export interface StepRekey {
  /** The id the fixture derived for this step before import (D38 fallback path). */
  oldStepId: string;
  /** The stable stepKey the step carries from now on. */
  newStepId: string;
}

export interface ImportedFlow {
  title: string;
  flow: Flow;
  /** History migration plan for store.rekeyStep (empty for already-keyed steps). */
  rekeys: StepRekey[];
}

export type ImportResult =
  { importable: true; flows: ImportedFlow[] } | { importable: false; reason: string };

class NotImportable extends Error {}

const KEYED_VERBS = new Set([
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'expectVisible',
  'expectText',
]);

/**
 * Lift a hand-authored sentinel spec into flow documents (D39). Deliberately
 * all-or-nothing per file: every test must consist solely of linear `await s.*`
 * calls (optionally inside one level of `await s.step(...)` groups) with literal
 * intents/values and simple `page.getBy*()`/`page.locator()` locators. Anything
 * else — helpers, loops, options, locator variables — makes the file
 * non-importable, because a partial import would double-run or drop steps.
 *
 * Each imported step is assigned a minted stepKey (existing stepKeys are
 * preserved verbatim), and a rekey plan maps the fixture's old derived step ids
 * to the new keys so healing history migrates instead of cold-starting.
 */
export function importSpecSource(source: string, fileName = 'spec.ts'): ImportResult {
  if (isGeneratedSpec(source)) {
    return { importable: false, reason: 'already generated from a flow — edit the flow instead' };
  }
  if (!source.includes('@sentinel/core')) {
    return { importable: false, reason: 'not a sentinel spec (no @sentinel/core import)' };
  }
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  try {
    const flows: ImportedFlow[] = [];
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) continue;
      const testCall = asTestCall(stmt, sf);
      flows.push(importTest(testCall, sf));
    }
    if (flows.length === 0) {
      return { importable: false, reason: 'no test() calls found' };
    }
    return { importable: true, flows };
  } catch (err) {
    if (err instanceof NotImportable) return { importable: false, reason: err.message };
    throw err;
  }
}

function fail(node: ts.Node, sf: ts.SourceFile, why: string): never {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  throw new NotImportable(`line ${line + 1}: ${why}`);
}

function asTestCall(stmt: ts.Statement, sf: ts.SourceFile): ts.CallExpression {
  if (
    ts.isExpressionStatement(stmt) &&
    ts.isCallExpression(stmt.expression) &&
    stmt.expression.expression.getText(sf) === 'test' &&
    stmt.expression.arguments.length === 2
  ) {
    return stmt.expression;
  }
  return fail(stmt, sf, `only import + test(...) statements are importable`);
}

function importTest(call: ts.CallExpression, sf: ts.SourceFile): ImportedFlow {
  const [titleArg, fnArg] = call.arguments;
  if (!titleArg || !ts.isStringLiteralLike(titleArg)) {
    fail(call, sf, 'test title must be a string literal');
  }
  const title = titleArg.text;
  if (!fnArg || !(ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg)) || !fnArg.body) {
    fail(call, sf, 'test body must be an inline function');
  }
  if (!ts.isBlock(fnArg.body)) fail(fnArg, sf, 'test body must be a block');

  const steps: FlowStep[] = [];
  const rekeys: StepRekey[] = [];
  // Mirrors the fixture's per-test occurrence counter (ids.ts resolveStepId
  // fallback): keyed by `${action}|${intent}`, counted in execution order.
  const occurrences = new Map<string, number>();

  const derive = (action: string, intent: string): string => {
    const key = `${action}|${intent}`;
    const n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    return makeStepId(action, intent, n);
  };

  const addStep = (stmt: ts.Statement, group: string | undefined): void => {
    const sCall = asAwaitedSCall(stmt, sf);
    const method = sCall.method;
    if (method === 'goto') {
      if (sCall.call.arguments.length !== 1 || !ts.isStringLiteralLike(sCall.call.arguments[0]!)) {
        fail(stmt, sf, 's.goto must take a single string literal');
      }
      const url = (sCall.call.arguments[0] as ts.StringLiteralLike).text;
      derive('goto', url); // keeps later occurrence indices aligned with the fixture
      steps.push({ action: 'goto', url, group });
      return;
    }
    if (!KEYED_VERBS.has(method)) {
      fail(stmt, sf, `unsupported s.${method}(...)`);
    }
    const props = objectProps(sCall.call, sf);
    const intent = requireString(props, 'intent', stmt, sf);
    const locator = parseLocator(props.get('locator'), stmt, sf);
    const existingKey = optionalString(props, 'stepKey', stmt, sf);
    const oldStepId = existingKey ?? derive(method, intent);
    const stepKey = existingKey ?? mintStepKey();
    if (!existingKey) rekeys.push({ oldStepId, newStepId: stepKey });

    const known = new Set(['intent', 'locator', 'stepKey', 'value', 'text', 'key']);
    for (const name of props.keys()) {
      if (!known.has(name)) fail(stmt, sf, `unsupported property '${name}' on s.${method}`);
    }
    const rejectExtras = (): void => {
      if (props.has('value') || props.has('text') || props.has('key')) {
        fail(stmt, sf, `s.${method} takes no value/text/key`);
      }
    };

    if (method === 'click') {
      rejectExtras();
      steps.push({ action: 'click', stepKey, intent, locator, group });
    } else if (method === 'fill') {
      const value = requireString(props, 'value', stmt, sf);
      steps.push({ action: 'fill', stepKey, intent, locator, value, group });
    } else if (method === 'select') {
      const value = requireString(props, 'value', stmt, sf);
      steps.push({ action: 'select', stepKey, intent, locator, value, group });
    } else if (method === 'check' || method === 'uncheck') {
      rejectExtras();
      steps.push({ action: method, stepKey, intent, locator, group });
    } else if (method === 'press') {
      const key = requireString(props, 'key', stmt, sf);
      steps.push({ action: 'press', stepKey, intent, locator, key, group });
    } else if (method === 'expectVisible') {
      rejectExtras();
      steps.push({ action: 'expectVisible', stepKey, intent, locator, group });
    } else {
      const text = requireString(props, 'text', stmt, sf);
      steps.push({ action: 'expectText', stepKey, intent, locator, text, group });
    }
  };

  for (const stmt of fnArg.body.statements) {
    const stepGroup = asStepGroup(stmt, sf);
    if (stepGroup) {
      for (const inner of stepGroup.body.statements) addStep(inner, stepGroup.name);
    } else {
      addStep(stmt, undefined);
    }
  }

  const flow = parseFlow({ version: 1, title, steps });
  return { title, flow, rekeys };
}

interface SCall {
  method: string;
  call: ts.CallExpression;
}

function asAwaitedSCall(stmt: ts.Statement, sf: ts.SourceFile): SCall {
  if (
    ts.isExpressionStatement(stmt) &&
    ts.isAwaitExpression(stmt.expression) &&
    ts.isCallExpression(stmt.expression.expression)
  ) {
    const call = stmt.expression.expression;
    if (
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.expression.getText(sf) === 's'
    ) {
      return { method: call.expression.name.text, call };
    }
  }
  return fail(stmt, sf, 'every statement must be an awaited s.*(...) call');
}

/** `await s.step('name', async () => { ... })` → its name + body block. */
function asStepGroup(
  stmt: ts.Statement,
  sf: ts.SourceFile,
): { name: string; body: ts.Block } | null {
  if (
    !ts.isExpressionStatement(stmt) ||
    !ts.isAwaitExpression(stmt.expression) ||
    !ts.isCallExpression(stmt.expression.expression)
  ) {
    return null;
  }
  const call = stmt.expression.expression;
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.expression.getText(sf) !== 's' ||
    call.expression.name.text !== 'step' ||
    call.arguments.length !== 2
  ) {
    return null;
  }
  const [nameArg, fnArg] = call.arguments;
  if (!ts.isStringLiteralLike(nameArg!)) fail(stmt, sf, 's.step name must be a string literal');
  if (
    !fnArg ||
    !(ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg)) ||
    !fnArg.body ||
    !ts.isBlock(fnArg.body)
  ) {
    return fail(stmt, sf, 's.step body must be an inline function block');
  }
  return { name: (nameArg as ts.StringLiteralLike).text, body: fnArg.body };
}

function objectProps(call: ts.CallExpression, sf: ts.SourceFile): Map<string, ts.Expression> {
  const arg = call.arguments[0];
  if (call.arguments.length !== 1 || !arg || !ts.isObjectLiteralExpression(arg)) {
    fail(call, sf, 's.* verbs take a single object argument');
  }
  const props = new Map<string, ts.Expression>();
  for (const p of arg.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
      fail(p, sf, 'only simple property assignments are importable');
    }
    props.set(p.name.text, p.initializer);
  }
  return props;
}

function requireString(
  props: Map<string, ts.Expression>,
  name: string,
  ctx: ts.Node,
  sf: ts.SourceFile,
): string {
  const v = props.get(name);
  if (!v || !ts.isStringLiteralLike(v)) fail(ctx, sf, `'${name}' must be a string literal`);
  return (v as ts.StringLiteralLike).text;
}

function optionalString(
  props: Map<string, ts.Expression>,
  name: string,
  ctx: ts.Node,
  sf: ts.SourceFile,
): string | undefined {
  const v = props.get(name);
  if (v === undefined) return undefined;
  if (!ts.isStringLiteralLike(v)) fail(ctx, sf, `'${name}' must be a string literal`);
  return (v as ts.StringLiteralLike).text;
}

const GET_BY_KIND: Record<string, LocatorSpec['kind']> = {
  getByTestId: 'testid',
  getByRole: 'role',
  getByLabel: 'label',
  getByPlaceholder: 'placeholder',
  getByText: 'text',
  locator: 'css',
};

function parseLocator(
  expr: ts.Expression | undefined,
  ctx: ts.Node,
  sf: ts.SourceFile,
): LocatorSpec {
  if (
    !expr ||
    !ts.isCallExpression(expr) ||
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.expression.expression.getText(sf) !== 'page'
  ) {
    return fail(ctx, sf, 'locator must be a direct page.getBy*(...) / page.locator(...) call');
  }
  const method = expr.expression.name.text;
  const kind = GET_BY_KIND[method];
  if (!kind) return fail(ctx, sf, `unsupported locator page.${method}(...)`);
  const [valueArg, optsArg] = expr.arguments;
  if (!valueArg || !ts.isStringLiteralLike(valueArg)) {
    return fail(ctx, sf, `page.${method} value must be a string literal`);
  }
  const spec: LocatorSpec = { kind, value: (valueArg as ts.StringLiteralLike).text };

  if (optsArg !== undefined) {
    if (kind === 'testid' || kind === 'css') {
      return fail(ctx, sf, `page.${method} takes no options`);
    }
    if (!ts.isObjectLiteralExpression(optsArg))
      return fail(ctx, sf, 'locator options must be a literal');
    for (const p of optsArg.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
        return fail(ctx, sf, 'locator options must be simple assignments');
      }
      if (p.name.text === 'name' && kind === 'role' && ts.isStringLiteralLike(p.initializer)) {
        spec.name = (p.initializer as ts.StringLiteralLike).text;
      } else if (p.name.text === 'exact' && isBooleanLiteral(p.initializer)) {
        spec.exact = p.initializer.kind === ts.SyntaxKind.TrueKeyword;
      } else {
        return fail(ctx, sf, `unsupported locator option '${p.name.text}'`);
      }
    }
  }
  if (expr.arguments.length > 2) return fail(ctx, sf, 'too many locator arguments');
  return spec;
}

function isBooleanLiteral(e: ts.Expression): boolean {
  return e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;
}
