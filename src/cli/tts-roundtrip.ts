/**
 * The text-to-speech check, end to end against the live Fixlark API:
 * read the text aloud (Kokoro), transcribe the audio back (whisper), and
 * compare. This is the evidence the QA judge stores before capturing payment.
 *
 *   npm run demo:tts -- "Text to read out"
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { Fixlark } from '../fixlark/client.ts';
import { priceCents, toPayPalValue } from '../catalog.ts';
import { wordErrorRate } from '../judge/wer.ts';

const MAX_WER = 0.15;
const text = process.argv.slice(2).join(' ').trim()
  || 'Agent Desk only charges for work that passed its checks. This sentence is the test.';

const fx = new Fixlark();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const progress = (label: string) => {
  let last = '';
  return (v: { state: string; position: number; etaSeconds: number }) => {
    const line = `${label}: ${v.state}${v.state === 'queued' ? ` (position ${v.position})` : ''}`;
    if (line !== last) log(line, v.state === 'done' ? '' : `~${v.etaSeconds}s`);
    last = line;
  };
};

log(`quote: tts ${text.length} chars = $${toPayPalValue(priceCents('tts', text.length))}`);

const tts = await fx.submitTts(text);
const spoken = await fx.waitFor(tts.id, { onUpdate: progress('tts') });
if (spoken.state !== 'done') throw new Error(`tts ${spoken.state}: ${spoken.error?.message}`);
const audio = await fx.result(tts.id);
await mkdir('out', { recursive: true });
await writeFile('out/speech.wav', audio.data);
log(`audio: ${audio.data.length} bytes, ${spoken.result?.seconds ?? '?'} s -> out/speech.wav`);

const tr = await fx.submitFile('transcribe', new Blob([audio.data], { type: 'audio/wav' }), 'speech.wav');
const heard = await fx.waitFor(tr.id, { onUpdate: progress('transcribe') });
if (heard.state !== 'done') throw new Error(`transcribe ${heard.state}: ${heard.error?.message}`);
const transcript = new TextDecoder().decode((await fx.result(tr.id)).data).trim();

const wer = wordErrorRate(text, transcript);
const pass = wer <= MAX_WER;
log(`heard: "${transcript}"`);
log(`word error rate ${(wer * 100).toFixed(1)}% (limit ${MAX_WER * 100}%) -> ${pass ? 'PASS: capture' : 'FAIL: void'}`);
process.exitCode = pass ? 0 : 1;
