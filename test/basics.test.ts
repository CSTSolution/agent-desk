import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceCents, toPayPalValue } from '../src/catalog.ts';
import { wordErrorRate, words } from '../src/judge/wer.ts';

test('prices round up to whole blocks and respect the minimum', () => {
  assert.equal(priceCents('tts', 1), 10); // minimum
  assert.equal(priceCents('tts', 1200), 15); // 3 blocks of 500
  assert.equal(priceCents('transcribe', 4.2), 50); // 5 started minutes
  assert.equal(priceCents('background', 1), 15);
  assert.throws(() => priceCents('grammar', -1));
});

test('PayPal amounts are exact strings', () => {
  assert.equal(toPayPalValue(5), '0.05');
  assert.equal(toPayPalValue(125), '1.25');
  assert.equal(toPayPalValue(1000), '10.00');
  assert.throws(() => toPayPalValue(1.5));
});

test('word error rate ignores case and punctuation', () => {
  assert.deepEqual(words("Hello, World! It's fine."), ['hello', 'world', 'its', 'fine']);
  assert.equal(wordErrorRate('Hello world', 'hello, world.'), 0);
  assert.equal(wordErrorRate('one two three four', 'one too three four'), 0.25);
  assert.equal(wordErrorRate('one two three four', 'one two three'), 0.25);
  assert.equal(wordErrorRate('', ''), 0);
  // whisper writes either form of a small number
  assert.equal(wordErrorRate('The kitchen opens at seven on Saturday.', 'The kitchen opens at 7 on Saturday.'), 0);
  assert.ok(wordErrorRate('Table for four', 'Table for five') > 0);
});

test('the buyer IP is forwarded to Fixlark only when switched on', async () => {
  const { Fixlark } = await import('../src/fixlark/client.ts');
  const fx = new Fixlark('http://tools-api.internal:1472/api/v1');
  assert.equal(fx.forClient('203.0.113.7'), fx, 'off by default');
  process.env.FIXLARK_FORWARD_CLIENT_IP = '1';
  try {
    assert.equal(fx.forClient('203.0.113.7').clientIp, '203.0.113.7');
    assert.equal(fx.forClient(null), fx);
  } finally { delete process.env.FIXLARK_FORWARD_CLIENT_IP; }
});
