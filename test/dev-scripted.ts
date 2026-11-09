/**
 * The real page and API with a scripted model instead of Nemotron, for UI work
 * without an LLM key. Never used in production.
 *   node --import tsx test/dev-scripted.ts   (then open http://localhost:8788, invite code "dev")
 */
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.ts';
import { createSite } from '../src/site.ts';
import { openStore } from '../src/store.ts';
import { Fixlark } from '../src/fixlark/client.ts';
import { DemoWallet, PayPalWallet } from '../src/wallet.ts';
import { PayPal } from '../src/paypal/client.ts';
import { Budget } from '../src/guard/guard.ts';
import { config } from '../src/config.ts';
import { FakeLLM } from './fake-llm.ts';

config.accessCodes.dev = 500;
config.invites.dev = { cents: 500, maxAccounts: 100 };
config.llm.router = config.llm.planner = config.llm.judge = 'scripted';
const store = openStore('data-dev');
const llm = new FakeLLM((req) => {
  if (req.name === 'verdict') return JSON.stringify({ verdict: /code|ignore|prompt/i.test(req.user) ? 'off_task' : 'on_task', reason: 'scripted' });
  if (req.name === 'plan') {
    const vi = /vietnam/i.test(req.user);
    return JSON.stringify({
      can_do: true, summary: vi ? 'A British voice-over of your text and a Vietnamese translation.' : 'A voice-over of your text.', input_languages: ['en'],
      steps: [{ service: 'tts', input: { from: 'input', index: 0 }, voice: 'bm_lewis' }, ...(vi ? [{ service: 'translate', input: { from: 'input', index: 0 }, source: 'en', target: 'vi' }] : [])],
    });
  }
  return JSON.stringify({ score: 4, reason: 'Scripted inspector.' });
});
// With PayPal sandbox keys in .env the payments are real sandbox payments; only the model is scripted.
const paypal = new PayPal(config.paypal);
const wallet = paypal.configured ? new PayPalWallet(store, paypal) : new DemoWallet(store);
const site = createSite(createApp({ store, llm, fixlark: new Fixlark(config.fixlarkApi), wallet, budget: new Budget(), paypal: paypal.configured ? paypal : undefined }));
serve({ fetch: site.fetch, port: 8788 }, () => console.log(`dev (scripted model, ${wallet.name} wallet) on http://localhost:8788`));
