/**
 * A minimal OpenAI-compatible chat client (NVIDIA Nemotron on build.nvidia.com by default).
 *
 * Every call asks for JSON that matches a schema and is validated with zod, so
 * a reply that is an essay, code or anything else simply fails to parse. The
 * model, system prompt, token cap and temperature are fixed by the caller on
 * the server; nothing here comes from a request body.
 */
import { z } from 'zod';
import { config } from '../config.ts';

export interface ChatRequest<T> {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Schema name, sent to the API for structured output. */
  name: string;
  maxTokens: number;
  temperature?: number;
  /** Let a reasoning model think first (Nemotron 3). Off by default: these jobs are short and structured. */
  thinking?: boolean;
}

export interface ChatResult<T> {
  ok: boolean;
  value?: T;
  /** Why it failed, for the server log only. Never sent to a client. */
  error?: string;
  usage: { in: number; out: number };
  ms: number;
  raw?: string;
}

export interface LLM {
  json<T>(req: ChatRequest<T>): Promise<ChatResult<T>>;
}

/** Reasoning models may put their thinking inline; only the answer after it counts. */
export function answerText(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
}

/** Take the JSON object out of a reply that may be fenced or have words around it. */
export function extractJson(text: string): unknown {
  const t = answerText(text);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1]! : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new SyntaxError('no JSON object in reply');
  return JSON.parse(body.slice(start, end + 1));
}

/** Any OpenAI-compatible chat API: NVIDIA's build.nvidia.com by default, or Nebius, Gemini... */
export class OpenAICompatible implements LLM {
  private structured = true;
  private tokens = config.llm.burst;
  private refilled = Date.now();
  private tail: Promise<unknown> = Promise.resolve();

  /** Token bucket: bursts wait their turn, under the provider's limit. False if the wait would be too long. */
  private pace(): Promise<boolean> {
    const run = this.tail.then(async () => {
      const perMs = config.llm.rpm / 60_000;
      this.tokens = Math.min(config.llm.burst, this.tokens + (Date.now() - this.refilled) * perMs);
      this.refilled = Date.now();
      if (this.tokens < 1) {
        const wait = (1 - this.tokens) / perMs;
        if (wait > config.llm.maxWaitMs) return false;
        await new Promise((r) => setTimeout(r, wait));
        this.tokens = 1;
        this.refilled = Date.now();
      }
      this.tokens -= 1;
      return true;
    });
    this.tail = run;
    return run;
  }
  constructor(
    private readonly baseUrl = config.llm.baseUrl,
    private readonly apiKey = config.llm.apiKey,
    private readonly timeoutMs = config.llm.timeoutMs,
  ) {}

  async json<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
    const started = Date.now();
    const usage = { in: 0, out: 0 };
    if (!this.apiKey) return { ok: false, error: 'LLM_API_KEY is not set', usage, ms: 0 };
    if (!req.model) return { ok: false, error: 'no model id configured', usage, ms: 0 };

    if (!(await this.pace())) return { ok: false, error: 'busy: own rate limit', usage, ms: Date.now() - started };
    const schema = z.toJSONSchema(req.schema);
    const send = (structured: boolean) => fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.1,
        messages: [
          { role: 'system', content: structured ? req.system : `${req.system}\n\nReply with one JSON object matching this schema and nothing else:\n${JSON.stringify(schema)}` },
          { role: 'user', content: req.user },
        ],
        ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: req.name, schema, strict: true } } } : {}),
        ...(config.llm.thinkingControl ? { chat_template_kwargs: { enable_thinking: Boolean(req.thinking) } } : {}),
      }),
    });
    let res: Response | undefined;
    let lastError = '';
    // Free tiers rate-limit and blip. Two quick retries on 429, 5xx and network
    // errors; anything still failing is returned as a failure (and callers fail closed).
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        const wait = Number(res?.headers.get('retry-after')) * 1000 || 800 * 3 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
      }
      try {
        res = await send(this.structured);
        // Some OpenAI-compatible providers reject json_schema; fall back to the schema in the prompt (zod still validates).
        if (res.status === 400 && this.structured) {
          const peek = await res.clone().text();
          if (/response_format|json_schema|guided/i.test(peek)) { this.structured = false; res = await send(false); }
        }
        if (res.status !== 429 && res.status < 500) break;
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        res = undefined;
        lastError = `network: ${(e as Error).name}`;
      }
    }
    if (!res) return { ok: false, error: lastError, usage, ms: Date.now() - started };

    const body = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    usage.in = body.usage?.prompt_tokens ?? 0;
    usage.out = body.usage?.completion_tokens ?? 0;
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${body.error?.message ?? ''}`.slice(0, 300), usage, ms };

    const choice = body.choices?.[0];
    const raw = choice?.message?.content ?? '';
    if (choice?.finish_reason === 'length') return { ok: false, error: 'cut off (max_tokens)', usage, ms, raw };
    try {
      const parsed = req.schema.safeParse(extractJson(raw));
      if (!parsed.success) return { ok: false, error: `schema: ${parsed.error.message.slice(0, 200)}`, usage, ms, raw };
      return { ok: true, value: parsed.data, usage, ms };
    } catch (e) {
      return { ok: false, error: `parse: ${(e as Error).message}`, usage, ms, raw };
    }
  }
}
