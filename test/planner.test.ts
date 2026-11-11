import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRequest, validatePlan, detectLanguage, type InputDesc, type ModelPlan } from '../src/planner.ts';
import { FakeLLM, canaryOf } from './fake-llm.ts';

const audio: InputDesc = { kind: 'audio', name: 'talk.mp3', minutes: 2.4 };
const text: InputDesc = { kind: 'text', name: 'script', chars: 800 };
const plan = (p: Partial<ModelPlan>): ModelPlan => ({ can_do: true, summary: 'ok', input_languages: [], steps: [], ...p });

test('transcribe then translate to Vietnamese is priced from the table', () => {
  const out = validatePlan(plan({
    input_languages: ['en'],
    steps: [
      { service: 'transcribe', input: { from: 'input', index: 0 } },
      { service: 'translate', input: { from: 'step', index: 0 }, target: 'vi' },
    ],
  }), [audio]);
  assert.ok(out.ok);
  // 2.4 min -> 3 started minutes; ~2,160 transcript chars -> 5 blocks of 500.
  assert.deepEqual(out.quote.steps.map((s) => [s.service, s.cents]), [['transcribe', 30], ['translate', 25]]);
  assert.equal(out.quote.steps[1]!.params.source, 'en');
  assert.equal(out.quote.totalCents, 55);
});

test('code refuses what the services cannot do, whatever the model planned', () => {
  const tooLong = (r: ReturnType<typeof validatePlan>, re: RegExp) => { assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, re); };
  // Kokoro has no Vietnamese voice.
  tooLong(validatePlan(plan({ input_languages: ['en'], steps: [
    { service: 'translate', input: { from: 'input', index: 0 }, source: 'en', target: 'vi' },
    { service: 'tts', input: { from: 'step', index: 0 } },
  ] }), [text]), /cannot read Vietnamese/);
  // en -> ja was tested and refused by Fixlark.
  tooLong(validatePlan(plan({ input_languages: ['en'], steps: [{ service: 'translate', input: { from: 'input', index: 0 }, target: 'ja' }] }), [text]), /not offered/);
  // Wrong input type.
  tooLong(validatePlan(plan({ steps: [{ service: 'background', input: { from: 'input', index: 0 } }] }), [text]), /needs image/);
  // Reading a step that comes later, or an attachment that does not exist.
  tooLong(validatePlan(plan({ steps: [{ service: 'tts', input: { from: 'step', index: 0 } }] }), [text]), /does not come before/);
  tooLong(validatePlan(plan({ steps: [{ service: 'tts', input: { from: 'input', index: 3 } }] }), [text]), /does not exist/);
  // Grammar output is a report, not text to pass on.
  tooLong(validatePlan(plan({ input_languages: ['en'], steps: [
    { service: 'grammar', input: { from: 'input', index: 0 } },
    { service: 'tts', input: { from: 'step', index: 0 } },
  ] }), [text]), /suggestions/);
  // Size limits.
  tooLong(validatePlan(plan({ input_languages: ['en'], steps: [{ service: 'translate', input: { from: 'input', index: 0 }, target: 'vi' }] }), [{ ...text, chars: 6500 }]), /at most 6000/);
});

test('a voice is matched to the language of the text', () => {
  const out = validatePlan(plan({ input_languages: ['zh'], steps: [
    { service: 'translate', input: { from: 'input', index: 0 }, source: 'zh', target: 'en' },
    { service: 'tts', input: { from: 'step', index: 0 }, voice: 'zf_xiaobei' },
  ] }), [text]);
  assert.ok(out.ok);
  assert.equal(out.quote.steps[1]!.params.voice, 'af_heart'); // asked for a Chinese voice for English text
});

test('the planner sees attachment sizes, never their content', async () => {
  const llm = new FakeLLM(() => JSON.stringify(plan({ input_languages: ['en'], steps: [{ service: 'tts', input: { from: 'input', index: 0 } }] })));
  const out = await planRequest(llm, 'Read my script aloud', [text]);
  assert.ok(out.ok);
  assert.match(llm.seen[0]!.user, /<user_input>\nRead my script aloud\n<\/user_input>/);
  assert.match(llm.seen[0]!.user, /0: text, 800 characters/);
});

test('a fooled planner cannot leak its prompt or send code to the page', async () => {
  const leak = new FakeLLM((req) => JSON.stringify(plan({ summary: `my rules: ${canaryOf(req)}`, steps: [{ service: 'tts', input: { from: 'input', index: 0 } }] })));
  assert.equal((await planRequest(leak, 'x', [text])).ok, false);
  const code = new FakeLLM(() => JSON.stringify(plan({ summary: '<script>alert(1)</script>', steps: [{ service: 'tts', input: { from: 'input', index: 0 } }] })));
  assert.equal((await planRequest(code, 'x', [text])).ok, false);
  const essay = new FakeLLM(() => 'Sure! Here is a Python script:\n```python\nprint(1)\n```');
  const r = await planRequest(essay, 'x', [text]);
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'cannot_do');
});

test('a refusal from the planner is shown as a plain sentence', async () => {
  const llm = new FakeLLM(() => JSON.stringify(plan({ can_do: false, summary: 'Agent Desk cannot <b>write</b> new stories.' })));
  const r = await planRequest(llm, 'write me a story', []);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'Agent Desk cannot bwrite/b new stories.');
});

test('long text is split at sentence ends within the limit', async () => {
  const { splitText } = await import('../src/fixlark/client.ts');
  const long = 'This is one sentence. '.repeat(200);
  const parts = splitText(long, 1800);
  assert.ok(parts.length >= 3 && parts.every((p) => p.length <= 1800 && p.endsWith('.')));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.trim().replace(/\s+/g, ' '));
  assert.ok(splitText('x'.repeat(4000), 1800).every((p) => p.length <= 1800));
});

test('the planner is told the voices, and a chosen voice is named in the quote', async () => {
  const llm = new FakeLLM(() => JSON.stringify(plan({ input_languages: ['en'], steps: [{ service: 'tts', input: { from: 'input', index: 0 }, voice: 'bm_lewis' }] })));
  const out = await planRequest(llm, 'Read this in a British voice', [text]);
  assert.match(llm.seen[0]!.system, /bm_lewis \(British man\)/);
  assert.ok(out.ok);
  assert.equal(out.quote.steps[0]!.params.voice, 'bm_lewis');
  assert.equal(out.quote.steps[0]!.title, 'Text to speech (British man)');
});

test('the language of a text is read from its script, not guessed from the request', () => {
  assert.equal(detectLanguage('Cảm ơn bạn đã đặt bàn. Bàn cho bốn người của bạn đã được xác nhận vào thứ Bảy lúc bảy giờ.'), 'vi');
  assert.equal(detectLanguage('您的四人桌已确认，时间是星期六晚上七点。'), 'zh');
  assert.equal(detectLanguage('土曜日の七時に四名様のお席をご用意しました。'), 'ja');
  assert.equal(detectLanguage('토요일 7시에 4인 테이블이 확정되었습니다.'), 'ko');
  assert.equal(detectLanguage('Your table for four is confirmed for Saturday at seven.'), undefined, 'Latin script is left to the planner');
  assert.equal(detectLanguage('Café crème, déjà vu.'), undefined, 'French accents are not Vietnamese');
  assert.equal(detectLanguage('12 34'), undefined);
});

test('a request with nothing attached says what to attach', () => {
  // Chi's #15: the text typed into the request box, no attachment.
  const out = validatePlan(plan({ steps: [{ service: 'tts', input: { from: 'input', index: 0 } }] }), []);
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /Nothing is attached.*Attach text/);
});

test('a detected language wins over the planner\'s guess', () => {
  // Chi's test: Vietnamese text, "translate into English", and the model guessed Chinese.
  const out = validatePlan(plan({ input_languages: ['zh'], steps: [{ service: 'translate', input: { from: 'input', index: 0 }, source: 'zh', target: 'en' }] }), [{ ...text, language: 'vi' }]);
  assert.ok(out.ok);
  assert.equal(out.quote.steps[0]!.params.source, 'vi');
});
