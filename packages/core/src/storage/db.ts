import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

export const TABLES = [
  'runs',
  'test_results',
  'steps',
  'locator_cache',
  'heals',
  'escalations',
  'flake_stats',
  'llm_calls',
] as const;

export type TableName = (typeof TABLES)[number];

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  git_sha TEXT,
  heal_mode TEXT NOT NULL DEFAULT 'auto',
  status TEXT,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS test_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  title TEXT NOT NULL,
  file TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error TEXT,
  flaky_tagged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_test_results_run ON test_results(run_id);
CREATE INDEX IF NOT EXISTS idx_test_results_test ON test_results(test_id);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  action TEXT NOT NULL,
  intent TEXT NOT NULL,
  group_path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  tier INTEGER,
  confidence REAL,
  classification TEXT,
  duration_ms INTEGER,
  url TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
CREATE INDEX IF NOT EXISTS idx_steps_test_step ON steps(test_id, step_id);

CREATE TABLE IF NOT EXISTS locator_cache (
  test_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  primary_json TEXT NOT NULL,
  alternates_json TEXT NOT NULL,
  fingerprint_json TEXT NOT NULL,
  intent TEXT NOT NULL,
  last_verified_at INTEGER NOT NULL,
  PRIMARY KEY (test_id, step_id)
);

CREATE TABLE IF NOT EXISTS heals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT '',
  old_locator TEXT NOT NULL,
  new_locator TEXT NOT NULL,
  tier INTEGER NOT NULL,
  confidence REAL NOT NULL,
  mode TEXT NOT NULL,
  reasoning TEXT,
  screenshot_before TEXT,
  screenshot_after TEXT,
  git_sha TEXT,
  promoted INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_heals_run ON heals(run_id);
CREATE INDEX IF NOT EXISTS idx_heals_test_step ON heals(test_id, step_id);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  question_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  answered_by TEXT,
  channel TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);

CREATE TABLE IF NOT EXISTS flake_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id TEXT NOT NULL,
  git_sha TEXT,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flake_test_sha ON flake_stats(test_id, git_sha);

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id);
`;

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  // WAL: safe concurrent access from parallel Playwright workers.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(DDL);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
  return db;
}
