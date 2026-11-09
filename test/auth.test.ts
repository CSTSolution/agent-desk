/** Invite-only accounts: register, log in, per-account limits, password change. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { openStore } from '../src/store.ts';
import { DemoWallet } from '../src/wallet.ts';
import { Budget } from '../src/guard/guard.ts';
import { config } from '../src/config.ts';
import type { Fixlark } from '../src/fixlark/client.ts';
import { FakeLLM } from './fake-llm.ts';

config.invites.inv = { cents: 300, maxAccounts: 3 };
config.invites.one = { cents: 100, maxAccounts: 1 };
config.sandboxBuyers = [{ email: 'buyer@personal.example.com', password: 'sandbox-pass' }];
let nextIp = 0;

const setup = () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'desk-auth-')));
  const llm = new FakeLLM((req) => req.name === 'plan'
    ? JSON.stringify({ can_do: true, summary: 'A grammar check.', input_languages: ['en'], steps: [{ service: 'grammar', input: { from: 'input', index: 0 } }] })
    : JSON.stringify({ verdict: 'on_task', reason: 'x' }));
  const fixlark = { forClient() { return this; }, grammar: async () => ({ matches: [], counts: {} }) } as unknown as Fixlark;
  const app = createApp({ store, llm, fixlark, wallet: new DemoWallet(store), budget: new Budget() });
  const ip = `ip${nextIp++}`;
  const call = (path: string, body?: unknown, token?: string, from = ip) => app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-client-ip': from, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const register = async (username: string, invite = 'inv', password = 'a-long-password') => call('/api/auth/register', { invite, username, password });
  const token = async (username: string, invite = 'inv') => (await (await register(username, invite)).json() as { token: string }).token;
  return { app, store, call, register, token };
};

test('you can only register with a valid invite code', async () => {
  const { register } = setup();
  assert.equal((await register('alice', 'wrong-code')).status, 403);
  assert.equal((await register('alice', '')).status, 403);
  const ok = await register('alice');
  assert.equal(ok.status, 200);
  assert.match((await ok.json() as { token: string }).token, /^ast_/);
});

test('an invite code can only make so many accounts', async () => {
  const { register } = setup();
  assert.equal((await register('first', 'one')).status, 200);
  assert.equal((await register('second', 'one')).status, 403);
});

test('usernames are unique and passwords must be long enough', async () => {
  const { register } = setup();
  assert.equal((await register('Alice')).status, 200);
  assert.equal((await register('alice')).status, 409, 'case does not make a new name');
  assert.equal((await register('bob', 'inv', 'short')).status, 400);
  assert.equal((await register('b')).status, 400);
  assert.equal((await register('bad name<script>')).status, 400);
});

test('log in, wrong password, unknown user', async () => {
  const { call, register } = setup();
  await register('alice');
  assert.equal((await call('/api/auth/login', { username: 'alice', password: 'a-long-password' })).status, 200);
  const wrong = await call('/api/auth/login', { username: 'alice', password: 'nope-nope-nope' });
  const unknown = await call('/api/auth/login', { username: 'nobody', password: 'nope-nope-nope' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json(), 'the answer does not reveal which usernames exist');
});

test('passwords and tokens are stored only as hashes', async () => {
  const { store, token } = setup();
  const t = await token('alice');
  const dump = JSON.stringify([store.db.prepare('SELECT * FROM accounts').all(), store.db.prepare('SELECT * FROM sessions').all()]);
  assert.ok(!dump.includes('a-long-password'));
  assert.ok(!dump.includes(t));
  assert.ok(!dump.includes('inv"'), 'the invite code is hashed too');
});

test('each account has its own limit and sees only its own data', async () => {
  const { call, token } = setup();
  const a = await token('alice'); const b = await token('bob');
  assert.equal((await (await call('/api/session', {}, a)).json() as { balanceCents: number }).balanceCents, 300);
  const f = await (await call('/api/files', { text: 'Thier offer.' }, a)).json() as { id: string };
  const q = await (await call('/api/quote', { request: 'Proofread this', files: [f.id] }, a)).json() as { id: string };
  assert.equal((await call('/api/quote', { request: 'Proofread this', files: [f.id] }, b)).status, 400, "another account's file");
  assert.equal((await call('/api/jobs', { quoteId: q.id }, b)).status, 404, "another account's quote");
  const job = await (await call('/api/jobs', { quoteId: q.id }, a)).json() as { id: string };
  assert.equal((await call(`/api/jobs/${job.id}`, undefined, b)).status, 404, "another account's job");
  await new Promise((r) => setTimeout(r, 40));
  const la = await (await call('/api/ledger', undefined, a)).json() as { entries: unknown[]; balanceCents: number };
  const lb = await (await call('/api/ledger', undefined, b)).json() as { entries: unknown[]; balanceCents: number };
  assert.ok(la.entries.length > 0);
  assert.equal(lb.entries.length, 0);
  assert.equal(lb.balanceCents, 300, "one account's spending leaves another's limit alone");
  assert.ok(la.balanceCents < 300);
});

test('an account id is not a credential', async () => {
  const { app, store, token } = setup();
  await token('alice');
  const { id } = store.db.prepare('SELECT id FROM accounts').get() as { id: string };
  const res = await app.request('/api/ledger', { headers: { 'x-access-code': id, 'x-client-ip': 'x' } });
  assert.equal(res.status, 401);
});

test('changing a password needs the current one and signs out other sessions', async () => {
  const { call, register } = setup();
  const first = (await (await register('alice')).json() as { token: string }).token;
  const second = (await (await call('/api/auth/login', { username: 'alice', password: 'a-long-password' })).json() as { token: string }).token;
  assert.equal((await call('/api/auth/password', { current: 'wrong-password', next: 'a-brand-new-password' }, first)).status, 401);
  assert.equal((await call('/api/auth/password', { current: 'a-long-password', next: 'short' }, first)).status, 400);
  assert.equal((await call('/api/auth/password', { current: 'a-long-password', next: 'a-brand-new-password' }, first)).status, 200);
  assert.equal((await call('/api/session', {}, first)).status, 200, 'this session stays');
  assert.equal((await call('/api/session', {}, second)).status, 401, 'the other is signed out');
  assert.equal((await call('/api/auth/login', { username: 'alice', password: 'a-long-password' })).status, 401);
  assert.equal((await call('/api/auth/login', { username: 'alice', password: 'a-brand-new-password' })).status, 200);
});

test('signing out ends the session', async () => {
  const { call, token } = setup();
  const t = await token('alice');
  assert.equal((await call('/api/auth/logout', {}, t)).status, 200);
  assert.equal((await call('/api/session', {}, t)).status, 401);
});

test('password guessing is throttled per visitor and per username', async () => {
  const { call, register } = setup();
  await register('alice');
  const codes: number[] = [];
  for (let i = 0; i < config.loginsPerMinutePerUser + 1; i++) codes.push((await call('/api/auth/login', { username: 'alice', password: `guess-number-${i}` }, undefined, `bot${i}`)).status);
  assert.equal(codes[0], 401);
  assert.equal(codes.at(-1), 429, 'many addresses, one username');
});

test('sandbox logins are shown only to signed-in users', async () => {
  const { call, token } = setup();
  assert.equal((await call('/api/test-logins')).status, 401);
  const res = await call('/api/test-logins', undefined, await token('alice'));
  assert.deepEqual((await res.json() as { logins: unknown }).logins, config.sandboxBuyers);
});

test('registrations are limited per address', async () => {
  const { register } = setup();
  config.invites.many = { cents: 100, maxAccounts: 100 };
  const codes: number[] = [];
  for (let i = 0; i < config.registrationsPerMinute + 1; i++) codes.push((await register(`user${i}`, 'many')).status);
  assert.equal(codes.at(-1), 429);
});
