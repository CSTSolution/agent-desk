/**
 * A small client for the Fixlark tools API, the AI services Agent Desk sells.
 *
 * Grammar and translation answer inline. Transcription, text to speech and
 * background removal are jobs: submit, poll until done, then download the
 * result once (Fixlark deletes results a few minutes after download).
 */

export type JobTool = 'transcribe' | 'tts' | 'background';
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobView {
  id: string;
  tool: string;
  state: JobState;
  position: number;
  etaSeconds: number;
  result: null | {
    kind: 'text' | 'audio' | 'image';
    bytes: number;
    seconds?: number;
    width?: number;
    height?: number;
    contentType?: string;
    filename?: string;
  };
  error: null | { message?: string; code?: string };
}

export interface TranslateResult {
  text: string;
  grade: 'good' | 'fair' | 'rough' | null;
  gradeNote: string | null;
  pair: { from: string; to: string; label: string };
}

export interface GrammarMatch {
  kind: 'spelling' | 'grammar' | 'style';
  message: string;
  offset: number;
  length: number;
  replacements?: string[];
}

export class FixlarkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Fixlark {
  constructor(
    readonly base = process.env.FIXLARK_API || 'https://fixlark.com/api/v1',
    /** The buyer this work is for. Sent only on the private network, so Fixlark's per-visitor limits count each buyer. */
    readonly clientIp: string | null = null,
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  /** The same client, acting for one buyer. Only used when FIXLARK_API is the internal address. */
  forClient(ip: string | null): Fixlark {
    return ip && process.env.FIXLARK_FORWARD_CLIENT_IP === '1' ? new Fixlark(this.base, ip) : this;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.clientIp ? { ...extra, 'x-client-ip': this.clientIp, 'x-forwarded-for': this.clientIp } : extra;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: this.headers(init.headers as Record<string, string> | undefined) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new FixlarkError(String(body.error ?? `HTTP ${res.status}`), res.status, body.code as string | undefined);
    }
    return body as T;
  }

  private postJson<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  capabilities(): Promise<{ tools: Record<string, { state: string; reason: string | null }> }> {
    return this.call('/capabilities');
  }

  translate(text: string, source: string, target: string): Promise<TranslateResult> {
    return this.postJson('/translate', { text, source, target });
  }

  /** Text over Fixlark's 2,000-character limit, translated in sentence-aligned chunks. */
  async translateLong(text: string, source: string, target: string, chunk = 1800): Promise<TranslateResult> {
    const parts = splitText(text, chunk);
    const out: TranslateResult[] = [];
    for (const p of parts) out.push(await this.translate(p, source, target));
    const joiner = target === 'zh' || target === 'ja' ? '' : ' ';
    return { ...out[0]!, text: out.map((r) => r.text.trim()).join(joiner) };
  }

  grammar(text: string, language = 'en-US'): Promise<{ matches: GrammarMatch[]; counts: Record<string, number> }> {
    return this.postJson('/grammar/check', { text, language });
  }

  submitTts(text: string, voice = 'af_heart', speed = 1): Promise<JobView> {
    return this.postJson('/jobs/tts', { text, voice, speed });
  }

  /** Transcription and background removal take a file in a form field called "file". */
  submitFile(tool: 'transcribe' | 'background', file: Blob, filename: string, fields: Record<string, string> = {}): Promise<JobView> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', file, filename);
    return this.call(`/jobs/${tool}`, { method: 'POST', body: form });
  }

  job(id: string): Promise<JobView> {
    return this.call(`/jobs/${id}`);
  }

  /** Poll until the job settles. Uses Fixlark's own ETA to pace the polls. */
  async waitFor(id: string, { timeoutMs = 15 * 60_000, onUpdate }: { timeoutMs?: number; onUpdate?: (v: JobView) => void } = {}): Promise<JobView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await this.job(id);
      onUpdate?.(view);
      if (view.state === 'done' || view.state === 'failed' || view.state === 'cancelled') return view;
      if (Date.now() > deadline) throw new FixlarkError(`job ${id} did not finish in time`, 504, 'timeout');
      await sleep(Math.min(Math.max(view.etaSeconds * 250, 1000), 5000));
    }
  }

  async result(id: string): Promise<{ data: Uint8Array; contentType: string }> {
    const res = await fetch(`${this.base}/jobs/${id}/result`, { headers: this.headers() });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new FixlarkError(String(body.error ?? `HTTP ${res.status}`), res.status, body.code as string | undefined);
    }
    return { data: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  }
}

/** Split at sentence ends (then at spaces) so every part is at most `max` characters. */
export function splitText(text: string, max: number): string[] {
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]*\s*|\n+/g) ?? [text];
  const parts: string[] = [];
  let cur = '';
  for (let s of sentences) {
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max) > max / 2 ? s.lastIndexOf(' ', max) : max;
      if (cur) { parts.push(cur); cur = ''; }
      parts.push(s.slice(0, cut)); s = s.slice(cut);
    }
    if ((cur + s).length > max) { parts.push(cur); cur = ''; }
    cur += s;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}
