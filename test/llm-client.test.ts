import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { OpenAICompatible } from '../src/llm/client.ts';

const Schema = z.object({ verdict: z.string() });
const req = { model: 'm', name: 'v', schema: Schema, system: 's', user: 'u', maxTokens: 50 };
const reply = (status: number, content = '{"verdict":"on_task"}') =>
  new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } : { error: { message: 'busy' } }), { status, headers: { 'retry-after': '0' } });

function withFetch(responses: (() => Response)[], fn: () => Promise<void>) {
  const real = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); const next = responses.shift(); if (!next) throw new Error('no more'); return next(); }) as typeof fetch;
  return fn().finally(() => { globalThis.fetch = real; }).then(() => bodies);
}

test('a rate-limited call is retried and then succeeds', async () => {
  const bodies = await withFetch([() => reply(429), () => reply(200)], async () => {
    const r = await new OpenAICompatible('https://llm.test', 'key').json(req);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { verdict: 'on_task' });
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].chat_template_kwargs.enable_thinking, false, 'reasoning is off unless asked for');
});

test('it gives up after three tries and reports a failure', async () => {
  await withFetch([() => reply(503), () => reply(503), () => reply(503)], async () => {
    const r = await new OpenAICompatible('https://llm.test', 'key').json(req);
    assert.equal(r.ok, false);
    assert.match(r.error!, /503/);
  });
});

test('a provider that rejects json_schema gets the schema in the prompt instead', async () => {
  const bodies = await withFetch([() => new Response('{"error":{"message":"response_format json_schema not supported"}}', { status: 400 }), () => reply(200)], async () => {
    assert.equal((await new OpenAICompatible('https://llm.test', 'key').json(req)).ok, true);
  });
  assert.ok(bodies[0].response_format && !bodies[1].response_format);
  assert.match(bodies[1].messages[0].content, /matching this schema/);
});
