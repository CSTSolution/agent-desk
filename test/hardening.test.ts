import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { openStore } from '../src/store.ts';
import { DemoWallet } from '../src/wallet.ts';
import { Budget } from '../src/guard/guard.ts';
import { sweep } from '../src/retention.ts';
import { config } from '../src/config.ts';
import type { Fixlark } from '../src/fixlark/client.ts';
import { FakeLLM } from './fake-llm.ts';

config.accessCodes.hard = 500;
const setup = () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'desk-hard-')));
  const app = createApp({ store, llm: new FakeLLM(() => '{}'), fixlark: { forClient() { return this; } } as unknown as Fixlark, wallet: new DemoWallet(store), budget: new Budget() });
  const http = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { 'x-access-code': 'hard', 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return { store, app, http };
};

test('oversized request bodies are refused before they are read', async () => {
  const { http } = setup();
  const big = JSON.stringify({ request: 'x'.repeat(70 * 1024) });
  assert.equal((await http('/api/quote', { method: 'POST', body: big })).status, 413);
  assert.equal((await http('/mcp', { method: 'POST', body: big, headers: { authorization: 'Bearer adk_x' } })).status, 413);
});

test('every spending route needs an access code', async () => {
  const { app } = setup();
  for (const [method, path] of [['POST', '/api/files'], ['POST', '/api/quote'], ['POST', '/api/jobs'], ['GET', '/api/ledger'], ['POST', '/api/mandates']] as const) {
    assert.equal((await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })).status, 401, path);
  }
});

test('attachments are rate-limited per access code', async () => {
  const { http } = setup();
  const codes: number[] = [];
  for (let i = 0; i < config.uploadsPerMinute + 1; i++) codes.push((await http('/api/files', { method: 'POST', body: JSON.stringify({ text: `note ${i}` }) })).status);
  assert.equal(codes.at(-1), 429);
});

test('files older than the retention window are deleted', async () => {
  const { store, http } = setup();
  const f = await (await http('/api/files', { method: 'POST', body: JSON.stringify({ text: 'a private note' }) })).json() as { id: string };
  const path = (store.db.prepare('SELECT path FROM files WHERE id = ?').get(f.id) as { path: string }).path;
  assert.ok(existsSync(path));
  assert.deepEqual(await sweep(store, 24, Date.now()), { files: 0, jobs: 0 });
  assert.equal((await sweep(store, 24, Date.now() + 25 * 3_600_000)).files, 1);
  assert.equal(existsSync(path), false);
  // A deleted attachment can no longer be quoted.
  const q = await http('/api/quote', { method: 'POST', body: JSON.stringify({ request: 'Read this aloud', files: [f.id] }) });
  assert.equal(q.status, 400);
});

test('the ledger grid is served from our own origin under the strict CSP', async () => {
  const { createSite } = await import('../src/site.ts');
  const { app } = setup();
  const res = await createSite(app as never).request('/vendor/ag-grid.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /javascript/);
  assert.match(res.headers.get('content-security-policy')!, /script-src 'self' 'nonce-/);
  assert.match((await res.text()).slice(0, 2000), /AG Grid|ag-grid|agGrid/i);
});

test('page assets carry a content hash, so a deploy beats the CDN cache', async () => {
  const { createSite } = await import('../src/site.ts');
  const { app } = setup();
  const html = await (await createSite(app as never).request('/')).text();
  assert.match(html, /src="\/app\.js\?v=[0-9a-f]{12}"/);
  assert.match(html, /href="\/style\.css\?v=[0-9a-f]{12}"/);
});
