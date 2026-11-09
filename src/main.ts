/** Starts Agent Desk: the API, the page, and the real services behind them. */
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createSite } from './site.ts';
import { openStore } from './store.ts';
import { OpenAICompatible } from './llm/client.ts';
import { Fixlark } from './fixlark/client.ts';
import { DemoWallet, PayPalWallet } from './wallet.ts';
import { PayPal } from './paypal/client.ts';
import { Budget } from './guard/guard.ts';
import { config } from './config.ts';
import { startSweeper } from './retention.ts';

if (!/sandbox\.paypal\.com/.test(config.paypal.base) && !config.paypal.allowLive) {
  console.error(`Refusing to start: PAYPAL_API_BASE (${config.paypal.base}) is not the PayPal sandbox. Set ALLOW_LIVE_PAYPAL=1 only if you mean it.`);
  process.exit(1);
}

const store = openStore();
startSweeper(store);
const paypal = new PayPal(config.paypal);
const api = createApp({
  store,
  llm: new OpenAICompatible(),
  fixlark: new Fixlark(config.fixlarkApi),
  wallet: paypal.configured ? new PayPalWallet(store, paypal) : new DemoWallet(store),
  budget: new Budget(),
  paypal: paypal.configured ? paypal : undefined,
});

void api.recover().then((n) => { if (n) console.log(`Released ${n} job(s) left unfinished by the last restart.`); }).catch((e) => console.error('recovery failed', e));
const site = createSite(api);

const missing = [!paypal.configured && 'PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET (using the demo wallet)', !config.llm.apiKey && 'LLM_API_KEY', !config.llm.planner && 'LLM_PLANNER_MODEL', !Object.keys(config.invites).length && 'INVITE_CODES'].filter(Boolean);
serve({ fetch: site.fetch, port: config.port }, () => {
  console.log(`Agent Desk on http://localhost:${config.port}`);
  if (missing.length) console.log(`Not set in .env: ${missing.join(', ')}`);
});
