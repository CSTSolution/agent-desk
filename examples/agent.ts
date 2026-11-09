/**
 * A small buying agent: a real MCP client that buys from Agent Desk.
 * Needs an agent key from the page's "Let your agents buy" section.
 *
 *   AGENT_DESK_KEY=adk_... npx tsx examples/agent.ts ["request"] ["text"]
 *
 * AGENT_DESK_URL defaults to the hosted demo. It quotes first, buys only if the
 * quote is within its limits, then reads what was captured and what was released.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.AGENT_DESK_URL || 'https://desk.fixlark.com/mcp';
const key = process.env.AGENT_DESK_KEY;
if (!key) { console.error('Set AGENT_DESK_KEY to an agent key.'); process.exit(1); }
const [request = 'Read this aloud in a British voice and translate it into Vietnamese.', text = 'Thank you for booking with us. Your table for four is confirmed for Saturday at seven.'] = process.argv.slice(2);

const client = new Client({ name: 'example-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));

const call = async (name: string, args: Record<string, unknown>) => {
  console.log(`\n> ${name}(${JSON.stringify(args).slice(0, 110)})`);
  const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string; mimeType?: string; data?: string }[]; isError?: boolean };
  for (const c of r.content) console.log(c.type === 'text' ? c.text : `[${c.mimeType}, ${Math.round((c.data?.length ?? 0) * 0.75 / 1024)} KB delivered]`);
  return r;
};

const quote = await call('quote_job', { request, text });
if (quote.isError) process.exit(0);
const q = JSON.parse(quote.content[0]!.text!);
if (!q.within_limits) { console.log('\nOver my limits, so I am not buying this.'); process.exit(0); }
const buy = await call('buy_job', { quote_id: q.quote_id });
if (buy.isError) process.exit(0);
await call('job_status', { job_id: JSON.parse(buy.content[0]!.text!).job_id, wait: true });
await client.close();
