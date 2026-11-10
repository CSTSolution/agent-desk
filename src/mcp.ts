/**
 * Agent Desk as an MCP server: any agent (Claude, ChatGPT, a LangChain bot...)
 * can quote, buy and collect AI jobs with an agent key. The key belongs to a
 * mandate: a buyer's saved PayPal wallet plus a per-job and a total limit.
 *
 * Agents go through exactly the same pre-check, planner, price list, PayPal
 * hold and inspection as people do. Stateless Streamable HTTP at /mcp.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { SERVICES } from './catalog.ts';
import { DeskError, type Desk, type Mandate } from './desk.ts';

const cents = (c: number) => `$${(c / 100).toFixed(2)}`;
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (e: unknown) => {
  if (e instanceof DeskError) return { content: [{ type: 'text' as const, text: `Refused (${e.status}): ${e.message}` }], isError: true };
  console.error('mcp tool error', e);
  return { content: [{ type: 'text' as const, text: 'Agent Desk hit an internal error. Try again shortly.' }], isError: true };
};

export function buildServer(desk: Desk, m: Mandate, ip: string | null = null) {
  const server = new McpServer({ name: 'agent-desk', version: '0.2.0' }, {
    instructions: `Agent Desk sells verified AI work: voice-overs, transcription, translation, grammar checks and background removal. Flow: quote_job, then buy_job, then job_status. Paying places a PayPal hold on your user's saved wallet; only the steps that pass inspection are captured, the rest is released. You may spend at most ${cents(m.per_job_cents)} per job and ${cents(m.total_cents)} in total.`,
  });

  server.registerTool('list_services', {
    title: 'List services and prices',
    description: 'What Agent Desk sells, what each service costs and how its output is checked before you pay.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => text(JSON.stringify({
    services: Object.values(SERVICES).map((s) => ({ id: s.id, title: s.title, summary: s.summary, price: `${cents(s.cents)} per ${s.per} ${s.unit}${s.per > 1 ? 's' : ''} (minimum ${cents(s.minCents)})`, check: s.check })),
    limits: { perJob: cents(m.per_job_cents), remaining: cents(desk.mandateRemaining(m)) },
  }, null, 2)));

  server.registerTool('quote_job', {
    title: 'Get a quote',
    description: 'Describe the job in plain words and pass the text it should work on. Returns a priced plan and a quote_id. Nothing is charged.',
    inputSchema: {
      request: z.string().min(1).max(600).describe('What you need, e.g. "Read this aloud in a British voice and translate it to Vietnamese".'),
      text: z.string().max(3000).optional().describe('The text the job works on (a script to voice, a note to translate...).'),
    },
  }, async ({ request, text: body }) => {
    try {
      const files = body ? [(await desk.addText(m.access, body)).id] : [];
      const q = await desk.quote(m.access, ip ?? `agent:${m.id}`, request, files);
      const left = desk.mandateRemaining(m);
      const within = q.totalCents <= m.per_job_cents && q.totalCents <= left;
      return text(JSON.stringify({
        quote_id: q.id, summary: q.summary, total: cents(q.totalCents),
        steps: q.steps.map((s) => ({ step: s.index + 1, service: s.title + (s.params.target ? ` (${s.params.source}→${s.params.target})` : ''), price: cents(s.cents), check: s.check })),
        within_limits: within,
        next: within
          ? 'Call buy_job with this quote_id to place the PayPal hold and start the work.'
          : `Over your limits (up to ${cents(m.per_job_cents)} a job, ${cents(left)} left in total): ask your user to raise them, or split the job.`,
      }, null, 2));
    } catch (e) { return failure(e); }
  });

  server.registerTool('buy_job', {
    title: 'Buy a quoted job',
    description: "Places a PayPal hold for the quote on your user's saved wallet (no popup) and starts the work. You are charged only for steps that pass inspection.",
    inputSchema: { quote_id: z.string().min(1).max(64) },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ quote_id }) => {
    try {
      const b = await desk.buyWithMandate(m, quote_id, ip);
      return text(JSON.stringify({ job_id: b.id, held: cents(b.heldCents), paypal_authorization: b.holdId, remaining_budget: cents(b.remainingCents), next: 'Call job_status with this job_id (wait=true waits up to 90 s).' }, null, 2));
    } catch (e) { return failure(e); }
  });

  server.registerTool('job_status', {
    title: 'Job status and results',
    description: 'Progress, the inspection evidence for each step, what PayPal captured and released, and the delivered outputs.',
    inputSchema: {
      job_id: z.string().min(1).max(64),
      wait: z.boolean().optional().describe('Wait up to 90 seconds for the job to finish (default true).'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ job_id, wait = true }) => {
    try {
      const deadline = Date.now() + 90_000;
      let j = desk.job(m.access, job_id);
      if (j.mandateId !== m.id) throw new DeskError(404, 'No such job.');
      while (wait && ['held', 'running', 'authorizing'].includes(j.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        j = desk.job(m.access, job_id);
      }
      const done = !['held', 'running', 'authorizing'].includes(j.status);
      const content: ({ type: 'text'; text: string } | { type: 'audio' | 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: JSON.stringify({
        job_id: j.id, status: j.status, summary: j.summary,
        held: cents(j.heldCents), captured: done ? cents(j.capturedCents) : null, released: done ? cents(j.releasedCents) : null,
        paypal: j.paypal && Object.fromEntries(Object.entries(j.paypal).filter(([, v]) => v != null)), steps: j.steps.map((s) => ({ step: s.idx + 1, service: s.title, status: s.status, price: cents(s.cents), evidence: s.verdict?.evidence ?? [] })),
      }, null, 2) }];
      if (done) {
        for (const s of j.steps.filter((s) => s.status === 'passed')) {
          const out = await desk.output(m.access, j.id, s.idx);
          if (out.kind === 'text') content.push({ type: 'text', text: `Step ${s.idx + 1} output:\n${new TextDecoder().decode(out.data)}` });
          else content.push({ type: out.kind === 'audio' ? 'audio' : 'image', data: Buffer.from(out.data).toString('base64'), mimeType: out.type });
        }
      }
      return { content };
    } catch (e) { return failure(e); }
  });

  return server;
}

/** POST /mcp: authenticate the agent key, then answer the MCP request statelessly. */
export async function handleMcp(desk: Desk, req: Request, ip: string | null = null): Promise<Response> {
  const key = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const m = desk.mandateByKey(key);
  if (!m) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Agent Desk needs a valid agent key (Authorization: Bearer adk_...). Make one at the Agent Desk page under "Let your agents buy".' }, id: null }), { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' } });
  }
  const server = buildServer(desk, m, ip);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
