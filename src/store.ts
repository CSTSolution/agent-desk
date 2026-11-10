/** SQLite store (node:sqlite, no native build): uploads, quotes, jobs, steps and the money ledger. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.ts';

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const now = () => new Date().toISOString();

export function openStore(dir = config.dataDir) {
  mkdirSync(join(dir, 'files'), { recursive: true });
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  const db = new DatabaseSync(join(dir, 'desk.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files  (id TEXT PRIMARY KEY, access TEXT, kind TEXT, name TEXT, path TEXT, bytes INTEGER, chars INTEGER, minutes REAL, created TEXT);
    CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, access TEXT, request TEXT, inputs TEXT, plan TEXT, total_cents INTEGER, created TEXT, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS jobs   (id TEXT PRIMARY KEY, access TEXT, quote_id TEXT, status TEXT, hold_id TEXT, held_cents INTEGER, captured_cents INTEGER DEFAULT 0, released_cents INTEGER DEFAULT 0, wallet TEXT, created TEXT, finished TEXT);
    CREATE TABLE IF NOT EXISTS steps  (job_id TEXT, idx INTEGER, service TEXT, title TEXT, status TEXT, cents INTEGER, verdict TEXT, output_path TEXT, output_kind TEXT, started TEXT, finished TEXT, PRIMARY KEY (job_id, idx));
    CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, at TEXT, access TEXT, job_id TEXT, type TEXT, cents INTEGER, ref TEXT, memo TEXT);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT UNIQUE, pass_hash TEXT, invite_hash TEXT, cap_cents INTEGER, created TEXT);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT, created TEXT, expires TEXT);
    CREATE TABLE IF NOT EXISTS mandates (id TEXT PRIMARY KEY, access TEXT, status TEXT, label TEXT, setup_token TEXT, vault_id TEXT, payer_email TEXT,
      per_job_cents INTEGER, total_cents INTEGER, key_hash TEXT UNIQUE, key_hint TEXT, created TEXT, activated TEXT);
  `);
  // Columns added after the first schema; ALTER is a no-op error when they exist.
  for (const col of ['order_id TEXT', 'capture_id TEXT', 'mandate_id TEXT']) {
    try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  try { db.exec('ALTER TABLE accounts ADD COLUMN recovery_hash TEXT'); } catch { /* already there */ }
  return { db, dir };
}

export type Store = ReturnType<typeof openStore>;
