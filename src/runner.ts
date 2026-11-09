/**
 * Runs a paid job: each step on Fixlark, each output through the judge, then
 * one settlement that captures the steps that passed and releases the rest.
 * A step whose input came from a failed step is skipped and costs nothing.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FixlarkError, type Fixlark } from './fixlark/client.ts';
import type { Quote, PlannedStep } from './planner.ts';
import { judge, type Data, type JudgeDeps, type Verdict } from './judge/judge.ts';
import type { Wallet } from './wallet.ts';
import { now, type Store } from './store.ts';

export interface StoredInput { kind: 'text' | 'audio' | 'image'; name: string; path: string }

const EXT: Record<Data['kind'], string> = { text: 'txt', audio: 'wav', image: 'png' };

async function load(inp: StoredInput): Promise<Data> {
  const bytes = new Uint8Array(await readFile(inp.path));
  return inp.kind === 'text' ? { kind: 'text', text: new TextDecoder().decode(bytes) } : { kind: inp.kind, bytes };
}

async function runService(fx: Fixlark, step: PlannedStep, input: Data, name: string): Promise<Data> {
  const finish = async (id: string): Promise<Uint8Array> => {
    const done = await fx.waitFor(id);
    if (done.state !== 'done') throw new Error(done.error?.message || `the ${step.service} job ${done.state}`);
    return (await fx.result(id)).data;
  };
  switch (step.service) {
    case 'tts': {
      const job = await fx.submitTts((input as { text: string }).text, step.params.voice);
      return { kind: 'audio', bytes: await finish(job.id) };
    }
    case 'transcribe': {
      const job = await fx.submitFile('transcribe', new Blob([(input as { bytes: Uint8Array }).bytes]), name.match(/\.\w+$/) ? name : `${name}.wav`);
      return { kind: 'text', text: new TextDecoder().decode(await finish(job.id)).trim() };
    }
    case 'background': {
      const job = await fx.submitFile('background', new Blob([(input as { bytes: Uint8Array }).bytes]), name.match(/\.\w+$/) ? name : `${name}.png`);
      return { kind: 'image', bytes: await finish(job.id) };
    }
    case 'translate': {
      const r = await fx.translateLong((input as { text: string }).text, step.params.source!, step.params.target!);
      return { kind: 'text', text: r.text };
    }
    case 'grammar': {
      const r = await fx.grammar((input as { text: string }).text);
      const lines = r.matches.map((m) => `- ${m.kind}: ${m.message}${m.replacements?.length ? ` (try "${m.replacements.slice(0, 3).join('", "')}")` : ''}`);
      return { kind: 'text', text: lines.length ? lines.join('\n') : 'No problems found.' };
    }
  }
}

export interface RunDeps extends JudgeDeps { store: Store; wallet: Wallet }

export async function runJob(deps: RunDeps, job: { id: string; access: string; holdId: string; heldCents: number }, quote: Quote, inputs: StoredInput[]): Promise<void> {
  const { db } = deps.store;
  const dir = join(deps.store.dir, 'jobs', job.id);
  await mkdir(dir, { recursive: true });
  const setStep = db.prepare('UPDATE steps SET status = ?, verdict = ?, output_path = ?, output_kind = ?, started = COALESCE(started, ?), finished = ? WHERE job_id = ? AND idx = ?');
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id);

  const outputs: (Data | null)[] = [];
  const passed: boolean[] = [];
  for (const step of quote.steps) {
    const upstreamFailed = step.input.from === 'step' && !passed[step.input.index];
    if (upstreamFailed) {
      outputs.push(null); passed.push(false);
      setStep.run('skipped', JSON.stringify({ pass: false, evidence: ['Skipped: the step it reads from did not pass.'] }), null, null, null, now(), job.id, step.index);
      continue;
    }
    setStep.run('running', null, null, null, now(), null, job.id, step.index);
    let verdict: Verdict; let out: Data | null = null; let path: string | null = null;
    try {
      const src = step.input.from === 'input' ? inputs[step.input.index]! : null;
      const input = src ? await load(src) : outputs[step.input.index]!;
      out = await runService(deps.fixlark, step, input, src?.name ?? `step-${step.input.index + 1}`);
      path = join(dir, `step-${step.index + 1}.${EXT[out.kind]}`);
      await writeFile(path, out.kind === 'text' ? out.text : out.bytes);
      setStep.run('checking', null, path, out.kind, null, null, job.id, step.index);
      verdict = await judge(step, input, out, deps);
    } catch (e) {
      verdict = {
        pass: false,
        evidence: [e instanceof FixlarkError && e.status === 429
          ? 'Not run: this visitor has reached the service limit (5 voice checks or transcriptions, 12 voice-overs per 30 minutes). Not charged. Try again later.'
          : `The service failed: ${String((e as Error).message).slice(0, 160)}. Not charged.`],
      };
    }
    outputs.push(verdict.pass ? out : null);
    passed.push(verdict.pass);
    setStep.run(verdict.pass ? 'passed' : 'failed', JSON.stringify(verdict), path, out?.kind ?? null, null, now(), job.id, step.index);
  }

  const due = quote.steps.reduce((sum, s, i) => sum + (passed[i] ? s.cents : 0), 0);
  const settled = await deps.wallet.settle(job.access, job.id, job.holdId, job.heldCents, due);
  const status = settled.capturedCents === job.heldCents ? 'delivered' : settled.capturedCents ? 'partly delivered' : 'not delivered';
  db.prepare('UPDATE jobs SET status = ?, captured_cents = ?, released_cents = ?, capture_id = ?, finished = ? WHERE id = ?')
    .run(status, settled.capturedCents, settled.releasedCents, settled.captureId ?? null, now(), job.id);
}
