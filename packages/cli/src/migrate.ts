import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface MigrateResult {
  output: string;
  changed: boolean;
  /** Interactions wrapped with `intent: 'TODO'`. */
  wrapped: number;
  /** Interactions Sentinel's fixture cannot express yet (left untouched). */
  skipped: number;
  alreadyMigrated: boolean;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const TODO = `intent: 'TODO'`;

/**
 * Codemod (spec §3): mechanically wraps vanilla Playwright interactions in the
 * sentinel fixture with stub intents. Conservative by design — only the
 * interactions `s.*` can express are wrapped (zero-option click, single-value
 * fill, goto, toBeVisible, toHaveText); everything else is left byte-identical
 * and counted as skipped. Edits are position-based text splices, so formatting
 * of untouched code is preserved exactly.
 */
export function migrateSource(source: string, fileName = 'spec.ts'): MigrateResult {
  if (source.includes('@sentinel/core')) {
    return { output: source, changed: false, wrapped: 0, skipped: 0, alreadyMigrated: true };
  }
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Edit[] = [];
  let wrapped = 0;
  let skipped = 0;
  const functionsNeedingS = new Set<ts.SignatureDeclaration>();

  // ---- imports: test/expect now come from @sentinel/core ----------------------
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === '@playwright/test' &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      const names = stmt.importClause.namedBindings.elements.map((e) => e.getText(sf));
      const core = names.filter((n) => n === 'test' || n === 'expect');
      const rest = names.filter((n) => n !== 'test' && n !== 'expect');
      if (core.length === 0) continue;
      if (rest.length === 0) {
        edits.push({
          start: stmt.moduleSpecifier.getStart(sf),
          end: stmt.moduleSpecifier.getEnd(),
          text: `'@sentinel/core'`,
        });
      } else {
        edits.push({
          start: stmt.getStart(sf),
          end: stmt.getEnd(),
          text: `import { ${core.join(', ')} } from '@sentinel/core';\nimport { ${rest.join(', ')} } from '@playwright/test';`,
        });
      }
    }
  }

  const enclosingFunction = (node: ts.Node): ts.SignatureDeclaration | undefined => {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
      if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur))
        return cur;
      cur = cur.parent;
    }
    return undefined;
  };

  const replaceCall = (awaitExpr: ts.AwaitExpression, text: string) => {
    edits.push({
      start: awaitExpr.expression.getStart(sf),
      end: awaitExpr.expression.getEnd(),
      text,
    });
    wrapped++;
    const fn = enclosingFunction(awaitExpr);
    if (fn) functionsNeedingS.add(fn);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const callee = call.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const target = callee.expression;
        const targetText = target.getText(sf);
        const args = call.arguments;
        const arg = (i: number) => args[i]!.getText(sf);

        if (method === 'goto' && targetText === 'page' && args.length === 1) {
          replaceCall(node, `s.goto(${arg(0)})`);
        } else if (method === 'click') {
          if (targetText === 'page' && args.length === 1 && ts.isStringLiteralLike(args[0]!)) {
            replaceCall(node, `s.click({ locator: page.locator(${arg(0)}), ${TODO} })`);
          } else if (targetText !== 'page' && args.length === 0) {
            replaceCall(node, `s.click({ locator: ${targetText}, ${TODO} })`);
          } else {
            skipped++; // options / unusual shapes — s.click cannot express them yet
          }
        } else if (method === 'fill') {
          if (targetText === 'page' && args.length === 2 && ts.isStringLiteralLike(args[0]!)) {
            replaceCall(
              node,
              `s.fill({ locator: page.locator(${arg(0)}), ${TODO}, value: ${arg(1)} })`,
            );
          } else if (targetText !== 'page' && args.length === 1) {
            replaceCall(node, `s.fill({ locator: ${targetText}, ${TODO}, value: ${arg(0)} })`);
          } else {
            skipped++;
          }
        } else if (
          (method === 'toBeVisible' || method === 'toHaveText') &&
          ts.isCallExpression(target) &&
          target.expression.getText(sf) === 'expect' &&
          target.arguments.length === 1
        ) {
          const locator = target.arguments[0]!.getText(sf);
          if (method === 'toBeVisible' && args.length === 0) {
            replaceCall(node, `s.expectVisible({ locator: ${locator}, ${TODO} })`);
          } else if (method === 'toHaveText' && args.length === 1) {
            replaceCall(node, `s.expectText({ locator: ${locator}, ${TODO}, text: ${arg(0)} })`);
          } else {
            skipped++; // e.g. toHaveText with options — assertions are never weakened
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // ---- add `s` to the destructured fixtures of every touched callback ----------
  for (const fn of functionsNeedingS) {
    const first = fn.parameters[0];
    if (!first || !ts.isObjectBindingPattern(first.name)) {
      // zero-param callbacks cannot have used `page` — nothing was wrapped there
      continue;
    }
    const pattern = first.name;
    const hasS = pattern.elements.some(
      (e) => ts.isBindingElement(e) && ts.isIdentifier(e.name) && e.name.text === 's',
    );
    if (hasS) continue;
    if (pattern.elements.length === 0) {
      edits.push({ start: pattern.getStart(sf), end: pattern.getEnd(), text: '{ s }' });
    } else {
      const last = pattern.elements[pattern.elements.length - 1]!;
      edits.push({ start: last.getEnd(), end: last.getEnd(), text: ', s' });
    }
  }

  if (edits.length === 0) {
    return { output: source, changed: false, wrapped, skipped, alreadyMigrated: false };
  }

  // Apply from the end so earlier offsets stay valid; drop overlaps defensively.
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  let lastStart = Infinity;
  for (const e of edits) {
    if (e.end > lastStart) continue;
    output = output.slice(0, e.start) + e.text + output.slice(e.end);
    lastStart = e.start;
  }
  return { output, changed: true, wrapped, skipped, alreadyMigrated: false };
}

export interface MigrateDirResult {
  files: Array<{ file: string; wrapped: number; skipped: number; status: string }>;
  totalWrapped: number;
  totalSkipped: number;
  changedFiles: number;
}

const SPEC_PATTERN = /\.(spec|test)\.(ts|mts|tsx|js|mjs)$/;

export function migrateDirectory(dir: string, opts: { write: boolean }): MigrateDirResult {
  const files: MigrateDirResult['files'] = [];
  let totalWrapped = 0;
  let totalSkipped = 0;
  let changedFiles = 0;

  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!SPEC_PATTERN.test(entry)) continue;
      const source = readFileSync(full, 'utf8');
      const result = migrateSource(source, entry);
      const status = result.alreadyMigrated
        ? 'already migrated'
        : result.changed
          ? opts.write
            ? 'migrated'
            : 'would migrate'
          : 'no interactions found';
      files.push({ file: full, wrapped: result.wrapped, skipped: result.skipped, status });
      totalWrapped += result.wrapped;
      totalSkipped += result.skipped;
      if (result.changed) {
        changedFiles++;
        if (opts.write) writeFileSync(full, result.output);
      }
    }
  };
  walk(dir);
  return { files, totalWrapped, totalSkipped, changedFiles };
}
