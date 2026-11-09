/**
 * Buyers' files and job outputs are deleted a day after they were made.
 * The database keeps the quote, the verdicts and the ledger (no file content).
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store.ts';
import { config } from './config.ts';

export async function sweep(store: Store, hours = config.retentionHours, nowMs = Date.now()): Promise<{ files: number; jobs: number }> {
  const cutoff = new Date(nowMs - hours * 3_600_000).toISOString();
  const files = store.db.prepare('SELECT id, path FROM files WHERE created < ? AND path IS NOT NULL').all(cutoff) as { id: string; path: string }[];
  for (const f of files) {
    await rm(f.path, { force: true });
    store.db.prepare('UPDATE files SET path = NULL WHERE id = ?').run(f.id);
  }
  const jobs = store.db.prepare('SELECT DISTINCT j.id FROM jobs j JOIN steps s ON s.job_id = j.id WHERE j.created < ? AND s.output_path IS NOT NULL').all(cutoff) as { id: string }[];
  for (const j of jobs) {
    await rm(join(store.dir, 'jobs', j.id), { recursive: true, force: true });
    store.db.prepare('UPDATE steps SET output_path = NULL WHERE job_id = ?').run(j.id);
  }
  return { files: files.length, jobs: jobs.length };
}

/** Sweep now and then every hour. */
export function startSweeper(store: Store) {
  const run = () => sweep(store).then((r) => { if (r.files || r.jobs) console.log(new Date().toISOString(), 'retention sweep', r); }).catch((e) => console.error('retention sweep failed', e));
  void run();
  return setInterval(run, 3_600_000).unref();
}
