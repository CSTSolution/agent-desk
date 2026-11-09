import type { ChatRequest, ChatResult, LLM } from '../src/llm/client.ts';
import { extractJson } from '../src/llm/client.ts';

/**
 * A model stand-in for tests: `reply` returns the raw text the "model" would
 * write. Records every request, so tests can check what the model was shown.
 */
export class FakeLLM implements LLM {
  seen: ChatRequest<unknown>[] = [];
  constructor(private reply: (req: ChatRequest<unknown>) => string) {}
  async json<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
    this.seen.push(req as ChatRequest<unknown>);
    const raw = this.reply(req as ChatRequest<unknown>);
    const usage = { in: 100, out: 50 };
    try {
      const parsed = req.schema.safeParse(extractJson(raw));
      return parsed.success ? { ok: true, value: parsed.data, usage, ms: 1 } : { ok: false, error: 'schema', usage, ms: 1, raw };
    } catch {
      return { ok: false, error: 'parse', usage, ms: 1, raw };
    }
  }
}

/** The canary the scoped system prompt carries, so a "fooled model" can leak it. */
export const canaryOf = (req: ChatRequest<unknown>) => /desk-canary-[0-9a-f]+/.exec(req.system)?.[0] ?? '';
