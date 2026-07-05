import type Database from 'better-sqlite3';
import { SCHEMA_VERSION, TABLES, type TableName } from './db.js';

export interface DbExport {
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

export function exportDatabase(db: Database.Database): DbExport {
  const tables: DbExport['tables'] = {};
  for (const table of TABLES) {
    tables[table] = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  }
  return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), tables };
}

/**
 * Merge an export into the target DB. Strategy (see docs/DECISIONS.md):
 * - locator_cache: upsert by (test_id, step_id); the newest last_verified_at wins.
 * - runs: insert-or-ignore by id.
 * - history tables (steps, heals, test_results, flake_stats, escalations, llm_calls):
 *   rows are appended only when their run_id is not already present locally,
 *   so re-importing the same artifact is idempotent.
 */
export function importDatabase(db: Database.Database, data: DbExport): { imported: number } {
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Schema version mismatch: export is v${data.schemaVersion}, this build expects v${SCHEMA_VERSION}`,
    );
  }
  let imported = 0;
  const tx = db.transaction(() => {
    const cacheRows = data.tables.locator_cache ?? [];
    const upsertCache = db.prepare(
      `INSERT INTO locator_cache (test_id, step_id, primary_json, alternates_json, fingerprint_json, intent, last_verified_at)
       VALUES (@test_id, @step_id, @primary_json, @alternates_json, @fingerprint_json, @intent, @last_verified_at)
       ON CONFLICT (test_id, step_id) DO UPDATE SET
         primary_json = excluded.primary_json,
         alternates_json = excluded.alternates_json,
         fingerprint_json = excluded.fingerprint_json,
         intent = excluded.intent,
         last_verified_at = excluded.last_verified_at
       WHERE excluded.last_verified_at > locator_cache.last_verified_at`,
    );
    for (const row of cacheRows) {
      upsertCache.run(row);
      imported++;
    }

    const knownRuns = new Set(
      (db.prepare('SELECT id FROM runs').all() as Array<{ id: string }>).map((r) => r.id),
    );
    for (const row of data.tables.runs ?? []) {
      if (knownRuns.has(row.id as string)) continue;
      db.prepare(
        `INSERT OR IGNORE INTO runs (id, started_at, finished_at, git_sha, heal_mode, status, meta_json)
         VALUES (@id, @started_at, @finished_at, @git_sha, @heal_mode, @status, @meta_json)`,
      ).run(row);
      imported++;
    }

    const historyTables: TableName[] = [
      'test_results',
      'steps',
      'heals',
      'escalations',
      'flake_stats',
      'llm_calls',
    ];
    for (const table of historyTables) {
      const rows = data.tables[table] ?? [];
      if (rows.length === 0) continue;
      const localRuns = new Set(
        (db.prepare(`SELECT DISTINCT run_id FROM ${table}`).all() as Array<{ run_id: string }>).map(
          (r) => r.run_id,
        ),
      );
      for (const row of rows) {
        if (localRuns.has(row.run_id as string)) continue;
        const { id: _id, ...rest } = row;
        const cols = Object.keys(rest);
        db.prepare(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
        ).run(rest);
        imported++;
      }
    }
  });
  tx();
  return { imported };
}
