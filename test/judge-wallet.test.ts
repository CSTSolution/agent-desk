import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { alphaCoverage, judge, wavInfo } from '../src/judge/judge.ts';
import { openStore } from '../src/store.ts';
import { DemoWallet, InsufficientFunds } from '../src/wallet.ts';
import { config } from '../src/config.ts';
import type { PlannedStep } from '../src/planner.ts';
import type { Fixlark } from '../src/fixlark/client.ts';
import { FakeLLM, canaryOf } from './fake-llm.ts';

function wav(seconds: number, amplitude: number): Uint8Array {
  const rate = 8000; const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude * 32767), 44 + i * 2);
  return new Uint8Array(b);
}

function png(keptShare: number): Uint8Array {
  const p = new PNG({ width: 10, height: 10 });
  for (let i = 0; i < 100; i++) p.data[i * 4 + 3] = i < keptShare * 100 ? 255 : 0;
  return new Uint8Array(PNG.sync.write(p));
}

const step = (service: PlannedStep['service'], extra: Partial<PlannedStep> = {}): PlannedStep => ({
  index: 0, service, title: service, input: { from: 'input', index: 0 }, params: {}, produces: 'text', quantity: 1, cents: 10, check: '', ...extra,
});
const noFixlark = {} as never;

test('WAV duration and loudness are read from the file', () => {
  const info = wavInfo(wav(2, 0.5))!;
  assert.ok(Math.abs(info.seconds - 2) < 0.01);
  assert.ok(info.rms > 0.3);
  assert.equal(wavInfo(new Uint8Array(10)), null);
});

test('a cut-out that lost the subject, or kept everything, is not paid for', async () => {
  assert.ok(Math.abs(alphaCoverage(png(0.4))! - 0.4) < 0.01);
  const deps = { llm: new FakeLLM(() => ''), fixlark: noFixlark };
  for (const [share, pass] of [[0.4, true], [0.02, false], [1, false]] as const) {
    const v = await judge(step('background'), { kind: 'image', bytes: png(0.5) }, { kind: 'image', bytes: png(share) }, deps);
    assert.equal(v.pass, pass, `kept ${share}`);
  }
});

test('silent or impossibly fast speech fails before any transcription', async () => {
  const deps = { llm: new FakeLLM(() => ''), fixlark: noFixlark };
  const text = { kind: 'text' as const, text: 'Hello there, this is a short test sentence.' };
  assert.equal((await judge(step('tts', { language: 'en' }), text, { kind: 'audio', bytes: wav(3, 0) }, deps)).pass, false);
  assert.equal((await judge(step('tts', { language: 'en' }), text, { kind: 'audio', bytes: wav(0.2, 0.5) }, deps)).pass, false);
  // Non-English speech can't be transcribed back here, so code checks decide.
  assert.equal((await judge(step('tts', { language: 'fr' }), text, { kind: 'audio', bytes: wav(3, 0.5) }, deps)).pass, true);
});

test('a transcript the inspector scores below 3 is not paid for, and a leaked prompt counts as no score', async () => {
  const audio = { kind: 'audio' as const, bytes: wav(1, 0.5) };
  const out = { kind: 'text' as const, text: 'the the the the the' };
  const low = new FakeLLM(() => JSON.stringify({ score: 2, reason: 'Repeated words, not speech.' }));
  const v = await judge(step('transcribe'), audio, out, { llm: low, fixlark: noFixlark });
  assert.equal(v.pass, false);
  assert.match(v.evidence.join(' '), /2\/5/);
  assert.match(low.seen[0]!.user, /<user_input>\nthe the the/);
  const leak = new FakeLLM((req) => JSON.stringify({ score: 5, reason: canaryOf(req) }));
  assert.equal((await judge(step('transcribe'), audio, out, { llm: leak, fixlark: noFixlark })).pass, false);
});

test('the demo wallet holds, captures what passed and releases the rest', async () => {
  config.accessCodes.tester = 100;
  const store = openStore(mkdtempSync(join(tmpdir(), 'desk-')));
  const w = new DemoWallet(store);
  assert.equal(w.balance('tester'), 100);
  const { holdId } = await w.hold('tester', 'job_1', 60, 'test');
  assert.equal(w.balance('tester'), 40);
  await assert.rejects(w.hold('tester', 'job_2', 50, 'too much'), InsufficientFunds);
  const s = await w.settle('tester', 'job_1', holdId, 60, 25);
  assert.deepEqual(s, { capturedCents: 25, releasedCents: 35 });
  assert.equal(w.balance('tester'), 75);
  // Capture can never exceed the hold.
  const h2 = await w.hold('tester', 'job_3', 10, 'x');
  assert.deepEqual(await w.settle('tester', 'job_3', h2.holdId, 10, 999), { capturedCents: 10, releasedCents: 0 });
});

test('the translation inspector reasons first, checks number roles, and a failure is not paid for', async () => {
  const llm = new FakeLLM(() => JSON.stringify({ score: 2, reason: 'A party of four became table number 4.' }));
  const fixlark = { translateLong: async () => ({ text: 'Table 4 is confirmed.' }) } as unknown as Fixlark;
  const v = await judge(step('translate', { params: { source: 'en', target: 'vi' } }), { kind: 'text', text: 'Your table for four is confirmed.' }, { kind: 'text', text: 'Bàn 4 đã được xác nhận.' }, { llm, fixlark });
  assert.equal(v.pass, false);
  assert.equal(llm.seen[0]!.thinking, true);
  assert.equal(llm.seen[0]!.maxTokens, 6000);
  assert.match(llm.seen[0]!.system, /must not become a label or an identifier/);
  assert.match(v.evidence.join(' '), /2\/5 \(pass mark 4\)/);
  // No answer from the inspector also means no charge.
  const silent = new FakeLLM(() => 'no json here');
  assert.equal((await judge(step('translate', { params: { source: 'en', target: 'vi' } }), { kind: 'text', text: 'Hello.' }, { kind: 'text', text: 'Xin chào.' }, { llm: silent, fixlark })).pass, false);
});
