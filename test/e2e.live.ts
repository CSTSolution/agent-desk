/**
 * End to end through the real API, runner, judge and live Fixlark services,
 * with a scripted model in place of Nemotron (so it runs without an LLM key).
 *   node --import tsx test/e2e.live.ts           scripted model
 *   node --env-file=.env --import tsx test/e2e.live.ts --real "request" "attached text"
 *                                                    real Nemotron (planner, pre-check, inspector)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { openStore } from '../src/store.ts';
import { Fixlark } from '../src/fixlark/client.ts';
import { DemoWallet } from '../src/wallet.ts';
import { Budget } from '../src/guard/guard.ts';
import { config } from '../src/config.ts';
import { FakeLLM } from './fake-llm.ts';
import { OpenAICompatible } from '../src/llm/client.ts';

const real = process.argv.includes('--real');
const [request = 'Voice this in a British voice and translate it to Vietnamese', text = 'Your order has shipped. It should arrive on Friday.'] = process.argv.slice(2).filter((a) => a !== '--real');
config.accessCodes.e2e = 500;
if (!real) config.llm.router = config.llm.planner = config.llm.judge = 'scripted';
const store = openStore(mkdtempSync(join(tmpdir(), 'desk-e2e-')));
const llm = real ? new OpenAICompatible() : new FakeLLM((req) => {
  if (req.name === 'verdict') return JSON.stringify({ verdict: 'on_task', reason: 'scripted' });
  if (req.name === 'plan') return JSON.stringify({
    can_do: true, summary: 'An English voice-over of your text, then a Vietnamese translation of it.', input_languages: ['en'],
    steps: [
      { service: 'tts', input: { from: 'input', index: 0 }, voice: 'bm_lewis' },
      { service: 'translate', input: { from: 'input', index: 0 }, source: 'en', target: 'vi' },
    ],
  });
  return JSON.stringify({ score: 4, reason: 'Scripted inspector: meaning kept.' });
});
const app = createApp({ store, llm, fixlark: new Fixlark(config.fixlarkApi), wallet: new DemoWallet(store), budget: new Budget() });

const call = async (path: string, init: RequestInit = {}) => {
  const res = await app.request(path, { ...init, headers: { 'x-access-code': 'e2e', 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(body)}`);
  return body;
};

const file = await call('/api/files', { method: 'POST', body: JSON.stringify({ text }) });
const quote = await call('/api/quote', { method: 'POST', body: JSON.stringify({ request, files: [file.id] }) });
console.log('quote:', quote.summary, `$${Number(quote.totalCents) / 100}`, (quote.steps as { title: string; cents: number }[]).map((s) => `${s.title} ${s.cents}c`).join(' + '));
const job = await call('/api/jobs', { method: 'POST', body: JSON.stringify({ quoteId: quote.id }) });

for (;;) {
  const j = await call(`/api/jobs/${job.id}`);
  if (!['held', 'running'].includes(String(j.status))) {
    for (const s of j.steps as { idx: number; title: string; status: string; verdict: { evidence: string[] } }[]) {
      console.log(`step ${s.idx + 1} ${s.title}: ${s.status}`);
      for (const e of s.verdict?.evidence ?? []) console.log('   ', e);
    }
    console.log(`held ${j.heldCents}c, captured ${j.capturedCents}c, released ${j.releasedCents}c -> ${j.status}; balance ${j.balanceCents}c`);
    break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}
const ledger = await call('/api/ledger');
console.log('ledger:', (ledger.entries as { type: string; cents: number }[]).map((e) => `${e.type} ${e.cents}c`).join(', '));
