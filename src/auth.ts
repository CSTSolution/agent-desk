/**
 * Invite-only accounts. An invite code only lets someone register; after that
 * they log in with their own username and password, and every limit (spending,
 * quotes, uploads, running jobs) is per account.
 *
 * Passwords are hashed with scrypt. Session tokens are random, sent in a header
 * (so no cookies and no CSRF), and stored only as hashes.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { newId, now, type Store } from './store.ts';
import { config } from './config.ts';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const SESSION_MS = 30 * 24 * 3_600_000;

export class AuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** scrypt uses 16 MB per call in a container with a hard memory limit, so only a few run at once. */
let hashing = 0;
const hashSlots: (() => void)[] = [];
async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (hashing >= 3) await new Promise<void>((r) => hashSlots.push(r));
  hashing++;
  try { return await fn(); } finally { hashing--; hashSlots.shift()?.(); }
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await withHashSlot(() => scrypt(password, salt, 32));
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  const key = await withHashSlot(() => scrypt(password, Buffer.from(salt!, 'hex'), 32));
  return crypto.timingSafeEqual(key, Buffer.from(hash!, 'hex'));
}

/** Compared with this when a username doesn't exist, so timing doesn't reveal which usernames do. */
const DUMMY = hashPassword(crypto.randomBytes(16).toString('hex'));

const cleanUsername = (raw: unknown) => {
  const u = String(raw ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._@+-]{3,40}$/.test(u)) throw new AuthError(400, 'Choose a username of 3 to 40 letters, numbers or . _ @ + -');
  return u;
};
const checkNewPassword = (raw: unknown) => {
  const p = String(raw ?? '');
  if (p.length < 10 || p.length > 128) throw new AuthError(400, 'Use a password of 10 to 128 characters.');
  return p;
};

export function createAuth(store: Store) {
  const { db } = store;
  const account = (id: string) => db.prepare('SELECT id, username, cap_cents FROM accounts WHERE id = ?').get(id) as { id: string; username: string; cap_cents: number } | undefined;

  // The spending ledger is keyed by an id with a limit; an account's id is one of those.
  const allowSpending = () => {
    for (const a of db.prepare('SELECT id, cap_cents FROM accounts').all() as { id: string; cap_cents: number }[]) config.accessCodes[a.id] = a.cap_cents;
  };
  allowSpending();

  function startSession(accountId: string) {
    const token = `ast_${crypto.randomBytes(32).toString('base64url')}`;
    db.prepare('INSERT INTO sessions (token_hash, account_id, created, expires) VALUES (?, ?, ?, ?)')
      .run(sha(token), accountId, now(), new Date(Date.now() + SESSION_MS).toISOString());
    return token;
  }

  return {
    /** Register with an invite code. The code sets the account's spending limit and caps how many accounts it can make. */
    async register(input: { invite?: unknown; username?: unknown; password?: unknown }) {
      const inviteCode = String(input.invite ?? '').trim();
      const invite = config.invites[inviteCode];
      if (!invite) throw new AuthError(403, 'That invite code is not valid.');
      const username = cleanUsername(input.username);
      const password = checkNewPassword(input.password);
      const hash = await hashPassword(password);
      // No await from here on, so two registrations can't both take the last place.
      const used = (db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE invite_hash = ?').get(sha(inviteCode)) as { n: number }).n;
      if (used >= invite.maxAccounts) throw new AuthError(403, 'That invite code has been fully used.');
      if (db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username)) throw new AuthError(409, 'That username is taken.');
      const id = newId('acct');
      db.prepare('INSERT INTO accounts (id, username, pass_hash, invite_hash, cap_cents, created) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, username, hash, sha(inviteCode), invite.cents, now());
      config.accessCodes[id] = invite.cents;
      return { token: startSession(id), username };
    },

    async login(input: { username?: unknown; password?: unknown }) {
      const username = String(input.username ?? '').trim().toLowerCase().slice(0, 64);
      const password = String(input.password ?? '').slice(0, 128);
      const row = db.prepare('SELECT id, username, pass_hash FROM accounts WHERE username = ?').get(username) as { id: string; username: string; pass_hash: string } | undefined;
      const ok = await checkPassword(password, row?.pass_hash ?? await DUMMY);
      if (!row || !ok) throw new AuthError(401, 'Wrong username or password.');
      return { token: startSession(row.id), username: row.username };
    },

    /** The account behind a session token, or null. */
    accountFor(token: string) {
      if (!/^ast_[\w-]{20,}$/.test(token)) return null;
      const row = db.prepare('SELECT account_id FROM sessions WHERE token_hash = ? AND expires > ?').get(sha(token), now()) as { account_id: string } | undefined;
      return row ? account(row.account_id) ?? null : null;
    },

    /** Needs the current password; signs out this account's other sessions. */
    async changePassword(accountId: string, keepToken: string, input: { current?: unknown; next?: unknown }) {
      const row = db.prepare('SELECT pass_hash FROM accounts WHERE id = ?').get(accountId) as { pass_hash: string };
      if (!await checkPassword(String(input.current ?? '').slice(0, 128), row.pass_hash)) throw new AuthError(401, 'That is not your current password.');
      const hash = await hashPassword(checkNewPassword(input.next));
      db.prepare('UPDATE accounts SET pass_hash = ? WHERE id = ?').run(hash, accountId);
      db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?').run(accountId, sha(keepToken));
      return { ok: true };
    },

    logout(token: string) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
      return { ok: true };
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
