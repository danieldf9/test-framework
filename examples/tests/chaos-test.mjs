/**
 * Chaos-harness integration test (spec §11.2), extended for Phase 2.
 *
 * A. Fresh state → BASELINE run                → passes, cache populated.
 * B. chaos-drift (rename/reword/move)          → ≥90% heal at Tiers 0-1, suite green.
 * C. chaos-deep + MOCK LLM (offline, exact)    → Tier 2 resolves drift that is
 *    too severe for Tiers 0-1; llm_calls audited; suite green.
 * D. regression + LLM STILL ENABLED            → PRODUCT_REGRESSION is not
 *    healed, not sent to the LLM, escalated, fails loudly.
 * F. ambiguous-regression + MOCK LLM           → confirmation keeps id/class but
 *    its text now means failure: heuristics see contradictory signals, the LLM
 *    classifier is consulted and must call PRODUCT_REGRESSION — never healed.
 * E. fresh state → chaos-deep + DEAD LLM URL   → circuit breaker opens, run is
 *    marked healing-unavailable, deterministic-only fallback, NEVER hangs.
 * G. answer E's escalations via the CLI        → human choice is recorded,
 *    cached as primary (audited as mode HUMAN), and the next run heals that
 *    step deterministically at Tier 0.
 * H. fresh state → chaos-deep + VISION mock    → the mock is deliberately
 *    unsure from DOM text alone (Tier 2 below the floor) but confident with
 *    the screenshot: Tier 3 heals with a DOM cross-check agreement boost.
 * R. `sentinel report`                          → static HTML with heals,
 *    before/after screenshots, flake dashboard and LLM cost summary.
 */
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SentinelStore } from '@sentinel/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:4173';
const MOCK_LLM_ENV = {
  SENTINEL_LLM_PROVIDER: 'openai-compatible',
  SENTINEL_LLM_BASE_URL: 'http://127.0.0.1:4174/v1',
  SENTINEL_LLM_MODEL: 'sentinel-mock-1',
};
const DEAD_LLM_ENV = {
  SENTINEL_LLM_PROVIDER: 'openai-compatible',
  SENTINEL_LLM_BASE_URL: 'http://127.0.0.1:59993/v1',
  SENTINEL_LLM_MODEL: 'sentinel-mock-1',
  SENTINEL_LLM_TIMEOUT_MS: '800',
};
const VISION_MOCK_ENV = {
  ...MOCK_LLM_ENV,
  SENTINEL_LLM_MODEL: 'sentinel-mock-lowconf',
  SENTINEL_LLM_SUPPORTS_VISION: 'true',
};

const failures = [];
const children = [];

function check(cond, label) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`);
  if (!cond) failures.push(label);
}

async function waitFor(url, what) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url, { headers: { connection: 'close' } });
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} did not start within 10s`);
}

async function startServers() {
  children.push(
    spawn(process.execPath, [path.join(here, '..', 'demo-app', 'server.mjs')], {
      env: { ...process.env, CHAOS_PROFILE: 'baseline', DEMO_PORT: '4173' },
      stdio: ['ignore', 'inherit', 'inherit'],
    }),
  );
  children.push(
    spawn(process.execPath, [path.join(here, '..', 'mock-llm', 'server.mjs')], {
      env: { ...process.env, MOCK_LLM_PORT: '4174' },
      stdio: ['ignore', 'inherit', 'inherit'],
    }),
  );
  await waitFor(`${BASE}/__chaos`, 'demo app');
  await waitFor('http://127.0.0.1:4174/v1/chat/completions', 'mock LLM');
}

async function setProfile(profile) {
  // 'connection: close' + retry: Node's fetch pools keep-alive sockets that the
  // demo server may have idle-closed while a long suite run was in progress.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}/__chaos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return;
    } catch (err) {
      if (attempt >= 3) throw new Error(`failed to switch profile to ${profile}: ${err}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

function runSuite(runId, llmEnv = null) {
  console.log(
    `\n▶ playwright test (run: ${runId}, llm: ${llmEnv ? llmEnv.SENTINEL_LLM_BASE_URL : 'off'})`,
  );
  const env = { ...process.env, SENTINEL_RUN_ID: runId };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SENTINEL_LLM_')) delete env[key];
  }
  // Explicit provider=none (not just unset): a developer .env with a real
  // provider must not leak into the deterministic phases.
  Object.assign(env, llmEnv ?? { SENTINEL_LLM_PROVIDER: 'none' });
  const started = Date.now();
  const res = spawnSync('npx', ['playwright', 'test'], {
    cwd: here,
    shell: true,
    stdio: 'inherit',
    env,
  });
  return { exit: res.status ?? 1, durationMs: Date.now() - started };
}

function openStore() {
  return new SentinelStore(path.join(here, '.sentinel', 'sentinel.db'));
}

function rows(store, sql, ...args) {
  return store.db.prepare(sql).all(...args);
}

function printHeals(heals) {
  for (const h of heals) {
    console.log(
      `    tier ${h.tier} ${h.mode.padEnd(10)} conf ${h.confidence.toFixed(2)}  ${h.intent.slice(0, 55)}`,
    );
    console.log(`      ${h.old_locator} → ${h.new_locator}`);
  }
}

async function main() {
  const stamp = Date.now();
  rmSync(path.join(here, '.sentinel'), { recursive: true, force: true });
  await startServers();

  // ---- Phase A: baseline -----------------------------------------------------
  const baselineRun = `p2-baseline-${stamp}`;
  const a = runSuite(baselineRun);
  {
    const store = openStore();
    console.log('\nPhase A — baseline assertions:');
    check(a.exit === 0, 'baseline suite exits 0');
    const bad = rows(
      store,
      "SELECT * FROM steps WHERE run_id = ? AND status NOT IN ('passed')",
      baselineRun,
    );
    check(bad.length === 0, `all baseline steps passed (${bad.length} non-passed)`);
    check(rows(store, 'SELECT * FROM locator_cache').length >= 7, 'locator cache populated');
    store.close();
  }

  // ---- Phase B: chaos-drift → Tiers 0-1, no LLM -------------------------------
  await setProfile('chaos-drift');
  const driftRun = `p2-drift-${stamp}`;
  const b = runSuite(driftRun);
  {
    const store = openStore();
    console.log('\nPhase B — chaos-drift assertions (deterministic only):');
    check(b.exit === 0, 'chaos-drift suite exits 0');
    const healed = rows(
      store,
      "SELECT * FROM steps WHERE run_id = ? AND status LIKE 'healed%'",
      driftRun,
    );
    const failedDrift = rows(
      store,
      "SELECT * FROM steps WHERE run_id = ? AND status IN ('failed','escalated') AND classification = 'LOCATOR_DRIFT'",
      driftRun,
    );
    const total = healed.length + failedDrift.length;
    check(total >= 6, `chaos broke locators (${total} drift failures)`);
    check(total > 0 && healed.length / total >= 0.9, `≥90% healed (${healed.length}/${total})`);
    const heals = rows(store, 'SELECT * FROM heals WHERE run_id = ?', driftRun);
    check(
      heals.every((h) => h.tier <= 1),
      'all Phase B heals at Tiers 0-1',
    );
    check(
      rows(store, 'SELECT * FROM llm_calls WHERE run_id = ?', driftRun).length === 0,
      'no LLM calls without a provider configured',
    );
    store.close();
  }

  // ---- Phase C: chaos-deep → Tier 2 via mock LLM -------------------------------
  await setProfile('chaos-deep');
  const deepRun = `p2-deep-${stamp}`;
  const c = runSuite(deepRun, MOCK_LLM_ENV);
  {
    const store = openStore();
    console.log('\nPhase C — chaos-deep assertions (Tier 2, offline mock LLM):');
    check(c.exit === 0, 'chaos-deep suite exits 0 (LLM healed through deep drift)');
    const heals = rows(store, 'SELECT * FROM heals WHERE run_id = ?', deepRun);
    const tier2 = heals.filter((h) => h.tier === 2);
    check(
      tier2.length >= 3,
      `Tier 2 performed the deep heals (${tier2.length} of ${heals.length})`,
    );
    check(
      heals.every((h) => h.tier <= 2),
      'all heals within Tiers 0-2 (acceptance bound)',
    );
    const failedDrift = rows(
      store,
      "SELECT * FROM steps WHERE run_id = ? AND status IN ('failed','escalated') AND classification = 'LOCATOR_DRIFT'",
      deepRun,
    );
    const total = heals.length + failedDrift.length;
    check(total > 0 && heals.length / total >= 0.9, `≥90% healed (${heals.length}/${total})`);
    const calls = rows(store, 'SELECT * FROM llm_calls WHERE run_id = ?', deepRun);
    check(
      calls.length >= tier2.length && calls.every((x) => x.ok === 1),
      `LLM calls audited with token accounting (${calls.length} calls, tokens>0: ${calls.every((x) => x.input_tokens > 0)})`,
    );
    check(
      calls.every((x) => x.purpose === 'heal-tier2' && x.provider === 'openai-compatible'),
      'llm_calls carry provider/model/purpose',
    );
    check(
      rows(store, 'SELECT * FROM escalations WHERE run_id = ?', deepRun).length === 0,
      'no escalations — Tier 2 resolved the ambiguity',
    );
    check(
      heals.every((h) => h.reasoning && h.confidence > 0),
      'Tier 2 heals carry LLM reasoning + confidence in the audit',
    );
    console.log('\n  Heals performed:');
    printHeals(heals);
    store.close();
  }

  // ---- Phase D: genuine regression with the LLM ENABLED -------------------------
  await setProfile('regression');
  const regRun = `p2-regression-${stamp}`;
  const d = runSuite(regRun, MOCK_LLM_ENV);
  {
    const store = openStore();
    console.log('\nPhase D — regression assertions (LLM enabled but must not be consulted):');
    check(d.exit !== 0, 'regression fails loudly (non-zero exit)');
    const regSteps = rows(
      store,
      "SELECT * FROM steps WHERE run_id = ? AND classification = 'PRODUCT_REGRESSION'",
      regRun,
    );
    check(regSteps.length >= 1, `classified PRODUCT_REGRESSION (${regSteps.length})`);
    check(
      regSteps.every((s) => s.status === 'escalated'),
      'regression escalated, not healed',
    );
    check(
      rows(store, 'SELECT * FROM heals WHERE run_id = ?', regRun).length === 0,
      'regression NOT healed (0 heals)',
    );
    check(
      rows(store, 'SELECT * FROM llm_calls WHERE run_id = ?', regRun).length === 0,
      'diagnosis blocked the LLM entirely — 0 llm_calls for a regression',
    );
    check(
      rows(store, "SELECT * FROM escalations WHERE run_id = ? AND status = 'pending'", regRun)
        .length >= 1,
      'escalation recorded for human review',
    );
    store.close();
  }

  // ---- Phase F: ambiguous regression → LLM classifier must refuse to heal --------
  await setProfile('ambiguous-regression');
  const ambigRun = `p3-ambiguous-${stamp}`;
  const f = runSuite(ambigRun, MOCK_LLM_ENV);
  {
    const store = openStore();
    console.log('\nPhase F — ambiguous-regression assertions (LLM classifier, spec §5):');
    check(f.exit !== 0, 'ambiguous regression fails loudly (non-zero exit)');
    const regSteps = rows(
      store,
      "SELECT * FROM steps WHERE run_id = ? AND classification = 'PRODUCT_REGRESSION'",
      ambigRun,
    );
    check(
      regSteps.length >= 1 && regSteps.every((s) => s.status === 'escalated'),
      `contradictory signals classified PRODUCT_REGRESSION and escalated (${regSteps.length})`,
    );
    const diagCalls = rows(
      store,
      "SELECT * FROM llm_calls WHERE run_id = ? AND purpose = 'diagnosis'",
      ambigRun,
    );
    check(
      diagCalls.length >= 1 && diagCalls.every((x) => x.ok === 1),
      `LLM classifier consulted for the ambiguous case (${diagCalls.length} diagnosis call(s))`,
    );
    check(
      rows(store, 'SELECT * FROM heals WHERE run_id = ?', ambigRun).length === 0,
      'assertion NOT healed despite drift-level structural similarity (golden rule)',
    );
    const escalated = rows(
      store,
      "SELECT * FROM escalations WHERE run_id = ? AND question_json LIKE '%LLM reclassified%'",
      ambigRun,
    );
    check(escalated.length >= 1, 'escalation question carries the LLM reclassification reasoning');
    store.close();
  }

  // ---- Phase E: dead LLM endpoint → circuit breaker, no hang ---------------------
  console.log('\nPhase E — dead LLM endpoint (fresh state, chaos-deep):');
  rmSync(path.join(here, '.sentinel'), { recursive: true, force: true });
  await setProfile('baseline');
  const eBase = runSuite(`p2e-baseline-${stamp}`, DEAD_LLM_ENV);
  check(eBase.exit === 0, 'fresh baseline passes (no LLM needed, dead endpoint irrelevant)');
  await setProfile('chaos-deep');
  const deadRun = `p2e-dead-${stamp}`;
  const e = runSuite(deadRun, DEAD_LLM_ENV);
  {
    const store = openStore();
    check(e.exit !== 0, 'deep drift without a working LLM fails (escalated, not guessed)');
    check(
      e.durationMs < 90_000,
      `pipeline never hangs on the dead endpoint (finished in ${(e.durationMs / 1000).toFixed(1)}s)`,
    );
    const calls = rows(store, 'SELECT * FROM llm_calls WHERE run_id = ?', deadRun);
    check(
      calls.length >= 3 && calls.every((x) => x.ok === 0),
      `failed attempts audited (${calls.length} rows, all ok=0)`,
    );
    const meta = JSON.parse(
      rows(store, 'SELECT meta_json FROM runs WHERE id = ?', deadRun)[0]?.meta_json ?? '{}',
    );
    check(
      meta.healingUnavailable === true,
      "run marked 'healing unavailable' after circuit opened",
    );
    check(
      rows(store, 'SELECT * FROM heals WHERE run_id = ?', deadRun).length === 0,
      'no guessed heals in deterministic-only fallback',
    );
    check(
      rows(store, 'SELECT * FROM escalations WHERE run_id = ?', deadRun).length >= 2,
      'broken steps escalated to humans instead',
    );
    store.close();
  }

  // ---- Phase G: human answers the escalations → Tier 0 replay --------------------
  console.log('\nPhase G — CLI escalation answering (spec §6 local channel):');
  const cliPath = path.join(here, '..', '..', 'packages', 'cli', 'dist', 'index.js');
  let answeredStepIds = [];
  {
    const store = openStore();
    const pending = store.pendingEscalations();
    check(pending.length >= 2, `pending escalations to answer (${pending.length})`);
    answeredStepIds = [...new Set(pending.map((e) => e.stepId))];
    store.close();
    for (const e of pending) {
      const res = spawnSync(
        process.execPath,
        [cliPath, 'escalations', '--choose', String(e.id), 'A'],
        { cwd: here, encoding: 'utf8' },
      );
      check(
        res.status === 0 && /Tier 0/.test(res.stdout),
        `sentinel escalations --choose ${e.id} A applied (${(res.stdout || res.stderr).trim().split('\n')[0]?.slice(0, 70)})`,
      );
    }
  }
  {
    const store = openStore();
    check(store.pendingEscalations().length === 0, 'no escalations left pending');
    const humanHeals = rows(store, "SELECT * FROM heals WHERE mode = 'HUMAN'");
    check(humanHeals.length >= 2, `human answers audited as HUMAN heals (${humanHeals.length})`);
    const updated = rows(
      store,
      "SELECT * FROM locator_cache WHERE primary_json LIKE '%Add to bag%'",
    );
    check(updated.length >= 2, `answered candidate cached as primary (${updated.length} entries)`);
    store.close();
  }
  const rerunId = `p3-after-answer-${stamp}`;
  const g = runSuite(rerunId); // deterministic only — the human answer replaces the LLM
  {
    const store = openStore();
    const healedAnswered = rows(
      store,
      `SELECT * FROM steps WHERE run_id = ? AND step_id IN (${answeredStepIds.map(() => '?').join(',')}) AND status = 'healed_auto' AND tier = 0`,
      rerunId,
      ...answeredStepIds,
    );
    check(
      healedAnswered.length >= 2,
      `answered step now heals deterministically at Tier 0 (${healedAnswered.length} heals, no LLM)`,
    );
    check(
      g.exit !== 0,
      'unanswered deep-drift steps still fail loudly (only the human-approved step was fixed)',
    );
    store.close();
  }

  // ---- Phase H: Tier 3 vision with DOM cross-check --------------------------------
  console.log('\nPhase H — Tier 3 vision (fresh state, chaos-deep, vision mock):');
  rmSync(path.join(here, '.sentinel'), { recursive: true, force: true });
  await setProfile('baseline');
  const hBase = runSuite(`p4-vision-baseline-${stamp}`, VISION_MOCK_ENV);
  check(hBase.exit === 0, 'fresh baseline passes');
  await setProfile('chaos-deep');
  const visionRun = `p4-vision-deep-${stamp}`;
  const h = runSuite(visionRun, VISION_MOCK_ENV);
  {
    const store = openStore();
    check(h.exit === 0, 'chaos-deep suite exits 0 (vision healed what DOM-only could not)');
    const heals = rows(store, 'SELECT * FROM heals WHERE run_id = ?', visionRun);
    const tier3 = heals.filter((x) => x.tier === 3);
    check(tier3.length >= 3, `Tier 3 performed the heals (${tier3.length} of ${heals.length})`);
    check(
      tier3.every((x) => /screenshot received/.test(x.reasoning)),
      'the model actually received the screenshot (vision payload verified)',
    );
    check(
      tier3.every((x) => /vision agrees/.test(x.reasoning)),
      'cross-check: vision agreement with the DOM answer boosted confidence',
    );
    const t2calls = rows(
      store,
      "SELECT * FROM llm_calls WHERE run_id = ? AND purpose = 'heal-tier2'",
      visionRun,
    );
    const t3calls = rows(
      store,
      "SELECT * FROM llm_calls WHERE run_id = ? AND purpose = 'heal-tier3-vision'",
      visionRun,
    );
    check(
      t2calls.length >= 3 && t3calls.length >= 3,
      `both tiers audited separately (${t2calls.length} DOM calls, ${t3calls.length} vision calls)`,
    );
    store.close();
  }

  // ---- Phase R: static HTML report --------------------------------------------------
  console.log('\nPhase R — sentinel report:');
  {
    const reportDir = path.join(here, '.sentinel', 'report');
    const res = spawnSync(process.execPath, [cliPath, 'report', '--out', reportDir], {
      cwd: here,
      encoding: 'utf8',
    });
    check(
      res.status === 0,
      `sentinel report exits 0 (${(res.stdout || res.stderr).trim().slice(0, 60)})`,
    );
    const indexPath = path.join(reportDir, 'index.html');
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    check(existsSync(indexPath), 'index.html generated');
    const html = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
    check(html.includes('Sentinel Report'), 'report renders');
    check(
      html.includes('tier 3') && html.includes('Add to bag'),
      'heals with locator diffs included',
    );
    check(html.includes('heal-tier3-vision'), 'LLM cost summary includes vision purpose');
    check(html.includes('Flake dashboard'), 'flake dashboard present');
    const assets = existsSync(path.join(reportDir, 'assets'))
      ? readdirSync(path.join(reportDir, 'assets'))
      : [];
    check(assets.length >= 1, `before/after screenshots copied into the report (${assets.length})`);
  }

  console.log(`\n${'='.repeat(60)}`);
  if (failures.length === 0) {
    console.log('CHAOS HARNESS: ALL ASSERTIONS PASSED');
  } else {
    console.log(`CHAOS HARNESS: ${failures.length} ASSERTION(S) FAILED`);
    for (const f of failures) console.log(`  ✘ ${f}`);
  }
  console.log('='.repeat(60));
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill();
  });
