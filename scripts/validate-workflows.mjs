/**
 * Structural validation of the GitHub Actions workflows (they cannot execute
 * locally, but their shape and the contracts the spec demands can be checked
 * deterministically). Run by `pnpm validate:workflows` and in CI.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function check(cond, label) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`);
  if (!cond) failures.push(label);
}

function load(rel) {
  const text = readFileSync(path.join(root, rel), 'utf8');
  return { text, doc: parse(text) };
}

console.log('sentinel.yml (reusable workflow):');
{
  const { text, doc } = load('.github/workflows/sentinel.yml');
  // NOTE: YAML parses the bare key `on:` as boolean true.
  const on = doc.on ?? doc[true];
  check(!!on?.workflow_call, 'is reusable (workflow_call)');
  check(!!on?.workflow_call?.inputs?.['working-directory'], 'has working-directory input');
  check(
    on?.workflow_call?.secrets?.SENTINEL_LLM_API_KEY?.required === false,
    'LLM key secret is OPTIONAL (graceful no-key degradation)',
  );
  check(
    String(doc.jobs?.test?.strategy?.matrix?.shard ?? '').includes('shard-list'),
    'sharded via matrix from shard-list input',
  );
  check(text.includes('actions/cache/restore@'), 'restores locator cache from actions/cache');
  check(text.includes('actions/cache/save@'), 'saves updated locator cache');
  check(
    text.includes('sentinel db import') && text.includes('sentinel db export --json'),
    'cache moves via portable JSON export/import',
  );
  check(text.includes('sentinel run -- --shard='), 'shards passed through to Playwright');
  check(
    text.includes('upload-artifact@') && text.includes('sentinel-report'),
    'uploads the HTML report artifact',
  );
  check(text.includes('.sentinel/artifacts'), 'uploads heal screenshots');
  check(
    text.includes('--run-prefix "gh-${{ github.run_id }}-"'),
    'summary aggregates shard runs by prefix',
  );
  check(text.includes('<!-- sentinel-summary -->'), 'single PR comment upserted via marker');
  check(text.includes('sentinel-needs-human'), 'push builds open a labeled needs-human issue');
  check(
    text.includes("conclusion: 'action_required'"),
    'needs-human check run uses action_required',
  );
  check(doc.jobs?.report?.if === 'always()', 'report/merge job runs even when shards fail');
}

console.log('sentinel-escalation-answer.yml:');
{
  const { text, doc } = load('.github/workflows/sentinel-escalation-answer.yml');
  const on = doc.on ?? doc[true];
  check(
    Array.isArray(on?.issue_comment?.types) && on.issue_comment.types.includes('created'),
    'triggers on new issue/PR comments',
  );
  const guard = String(doc.jobs?.answer?.if ?? '');
  check(guard.includes('/sentinel choose'), 'filters for the /sentinel choose command');
  check(guard.includes('author_association'), 'only maintainer comments are honored');
  check(
    text.includes('COMMENT_BODY: ${{ github.event.comment.body }}'),
    'comment body passed via env (no shell injection)',
  );
  check(text.includes('sentinel escalations --choose'), 'records the answer through the CLI');
  check(
    text.includes('actions/cache/restore@') && text.includes('actions/cache/save@'),
    'answer lands in the persisted locator cache',
  );
  check(text.includes('createForIssueComment'), 'acknowledges the command with a reaction/reply');
}

console.log('ci.yml (this repo):');
{
  const { text, doc } = load('.github/workflows/ci.yml');
  check(!!doc.jobs?.quality, 'quality job (lint, tests, chaos) present');
  check(text.includes('pnpm chaos'), 'chaos-harness acceptance test runs in CI');
  check(
    doc.jobs?.e2e?.uses === './.github/workflows/sentinel.yml',
    'e2e job calls the reusable workflow',
  );
  check(String(doc.jobs?.e2e?.with?.['shard-list']) === '[1,2]', 'demo suite runs sharded');
  check(!!doc.jobs?.e2e?.permissions, 'caller grants comment/check permissions');
}

console.log('sentinel init template:');
{
  const text = readFileSync(path.join(root, 'packages/cli/src/index.ts'), 'utf8');
  const tpl = (text.match(/const WORKFLOW_TEMPLATE = `([\s\S]*?)`;/)?.[1] ?? '')
    .replaceAll('\\${', '${')
    .replaceAll('\\`', '`')
    .replaceAll('\\\\n', '\\n');
  check(tpl.length > 0, 'template found in the CLI source');
  let parses = true;
  try {
    parse(tpl);
  } catch {
    parses = false;
  }
  check(parses, 'template is valid YAML');
  check(
    tpl.includes('actions/cache/restore@') && tpl.includes('actions/cache/save@'),
    'user template persists the cache',
  );
  check(
    tpl.includes('npx sentinel run') && tpl.includes('npx sentinel report'),
    'user template runs + reports',
  );
  check(
    tpl.includes('<!-- sentinel-summary -->'),
    'user template upserts a single summary comment',
  );
}

console.log('='.repeat(50));
if (failures.length > 0) {
  console.error(`WORKFLOW VALIDATION: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('WORKFLOW VALIDATION: all checks passed');
