/**
 * Agent Desk HTTP API for people (access code) and agents (MCP at /mcp, agent key).
 * The logic lives in desk.ts; this file maps HTTP to it.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SERVICES } from './catalog.ts';
import { PayPalWallet } from './wallet.ts';
import { createDesk, DeskError, DESK_TASK, type DeskDeps } from './desk.ts';
import { handleMcp } from './mcp.ts';
import { Limiter } from './guard/guard.ts';
import { createAuth, AuthError } from './auth.ts';
import { now } from './store.ts';
import { config } from './config.ts';

export { DESK_TASK };
export type AppDeps = DeskDeps;

export function createApp(deps: AppDeps) {
  const desk = createDesk(deps);
  const app = new Hono();
  const badAuth = new Limiter(config.badAuthPerMinute, config.badAuthPerDay);
  const registrations = new Limiter(config.registrationsPerMinute, config.registrationsPerDay);
  const loginsPerUser = new Limiter(config.loginsPerMinutePerUser, 200);
  const auth = createAuth(deps.store);
  let uploading = 0;
  const log = (...a: unknown[]) => console.log(now(), ...a);

  /** Caddy overwrites X-Client-IP with the real visitor; nothing else is trusted. */
  const ip = (c: Context) => c.req.header('x-client-ip') || 'local';
  const bearer = (c: Context) => (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const access = (c: Context) => {
    const session = auth.accountFor(bearer(c));
    if (session) return session.id;
    // Operator codes, for the API only. An account id is never a credential.
    const code = c.req.header('x-access-code') ?? '';
    return config.accessCodes[code] && !code.startsWith('acct_') ? code : null;
  };
  /** The page's own origin, for PayPal return links. PUBLIC_URL wins when set. */
  const origin = (c: Context) => (process.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/+$/, '');

  /** Run a route that needs an access code; DeskErrors become their status and message. */
  const withCode = (fn: (c: Context, code: string) => Promise<unknown> | unknown, status = 200) => async (c: Context) => {
    if (badAuth.over(ip(c))) return c.json({ error: 'Too many failed attempts; try again later.' }, 429);
    const code = access(c);
    if (!code) { badAuth.check(ip(c)); return c.json({ error: 'Please sign in.' }, 401); }
    try {
      return c.json(await fn(c, code) as object, status as 200);
    } catch (e) {
      if (e instanceof DeskError) return c.json({ error: e.message, ...e.extra }, e.status as 400);
      throw e;
    }
  };
  const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // Refuse oversized bodies before reading them: uploads up to the audio cap, everything else 64 KB.
  const tooBig = (c: Context) => c.json({ error: 'That request is too large.' }, 413);
  app.use('/api/files', bodyLimit({ maxSize: config.limits.audioBytes + 1024 * 1024, onError: tooBig }));
  app.use('/api/*', async (c, next) => (c.req.path === '/api/files' ? next() : bodyLimit({ maxSize: 64 * 1024, onError: tooBig })(c, next)));
  app.use('/mcp', bodyLimit({ maxSize: 64 * 1024, onError: tooBig }));

  app.get('/api/health', (c) => c.json({ ok: true, wallet: deps.wallet.name, modelBudgetOpen: deps.budget.open() }));

  /** What the page needs to show the right checkout. The PayPal client id is public by design. */
  app.get('/api/config', (c) => c.json({
    wallet: deps.wallet.name,
    paypal: deps.wallet instanceof PayPalWallet ? { clientId: config.paypal.clientId, currency: config.paypal.currency } : null,
  }));

  app.get('/api/catalog', (c) => c.json({
    services: Object.values(SERVICES).map(({ id, title, summary, unit, cents, per, minCents, check }) => ({ id, title, summary, unit, cents, per, minCents, check })),
  }));

  app.post('/api/session', withCode((c, code) => ({ ok: true, username: auth.accountFor(bearer(c))?.username ?? null, balanceCents: deps.wallet.balance(code), wallet: deps.wallet.name })));

  // ---------------------------------------------------------------- accounts

  const authRoute = (fn: (c: Context) => Promise<unknown>) => async (c: Context) => {
    if (badAuth.over(ip(c))) return c.json({ error: 'Too many failed attempts; try again later.' }, 429);
    try {
      return c.json(await fn(c) as object);
    } catch (e) {
      if (e instanceof AuthError) {
        if (e.status === 401 || e.status === 403) badAuth.check(ip(c));
        return c.json({ error: e.message }, e.status as 400);
      }
      throw e;
    }
  };

  app.post('/api/auth/register', authRoute(async (c) => {
    if (registrations.over(ip(c))) throw new AuthError(429, 'Too many new accounts from here; try again later.');
    const out = await auth.register(await body(c));
    registrations.check(ip(c));
    log('account registered');
    return out;
  }));

  app.post('/api/auth/login', authRoute(async (c) => {
    const b = await body(c);
    const who = String(b.username ?? '').trim().toLowerCase().slice(0, 64);
    // Per username too, so a botnet can't try one account's password from many addresses.
    if (!loginsPerUser.check(who)) throw new AuthError(429, 'Too many attempts for this account; wait a minute.');
    return auth.login(b);
  }));

  /** Forgot password, with the recovery code shown at registration. Guessing is throttled like logins. */
  app.post('/api/auth/reset', authRoute(async (c) => {
    const b = await body(c);
    const who = String(b.username ?? '').trim().toLowerCase().slice(0, 64);
    if (!loginsPerUser.check(who)) throw new AuthError(429, 'Too many attempts for this account; wait a minute.');
    const out = await auth.resetPassword(b);
    log('password reset with a recovery code');
    return out;
  }));

  app.post('/api/auth/logout', withCode((c) => auth.logout(bearer(c))));

  app.post('/api/auth/password', authRoute(async (c) => {
    const me = auth.accountFor(bearer(c));
    if (!me) throw new AuthError(401, 'Sign in first.');
    return auth.changePassword(me.id, bearer(c), await body(c));
  }));

  /** Sandbox test buyers, for signed-in users only. These are PayPal test accounts, not real ones. */
  app.get('/api/test-logins', withCode(() => ({ logins: config.sandboxBuyers })));

  /** An attachment: a file upload, or {text} as JSON. */
  app.post('/api/files', withCode(async (c, code) => {
    if ((c.req.header('content-type') ?? '').includes('application/json')) return desk.addText(code, String((await body(c)).text ?? ''));
    // Uploads are held in memory while they arrive, in a container with a hard memory limit.
    if (uploading >= config.uploadsAtOnce) throw new DeskError(429, 'Too many uploads at once; try again in a moment.');
    uploading++;
    try {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof File)) throw new DeskError(400, 'Send the file in a form field called "file".');
      return await desk.addUpload(code, file.name, new Uint8Array(await file.arrayBuffer()));
    } finally { uploading--; }
  }));

  app.post('/api/quote', withCode(async (c, code) => {
    const b = await body(c);
    const files = Array.isArray(b.files) ? b.files.map(String).slice(0, config.limits.inputs + 1) : [];
    return desk.quote(code, ip(c), String(b.request ?? ''), files);
  }));

  /** Pay for a quote. With PayPal: returns the order the buyer approves in the popup. */
  app.post('/api/jobs', withCode(async (c, code) => desk.checkout(code, String((await body(c)).quoteId ?? ''), ip(c)), 201));
  /** The buyer approved the PayPal order: authorize it (the hold) and start the work. */
  app.post('/api/jobs/:id/approve', withCode(async (c, code) => desk.approve(code, c.req.param('id')!, String((await body(c)).orderId ?? ''), ip(c)), 202));
  /** The buyer closed the PayPal popup: nothing was held; the quote can be used again. */
  app.post('/api/jobs/:id/cancel', withCode((c, code) => desk.cancel(code, c.req.param('id')!)));
  app.get('/api/jobs/:id', withCode((c, code) => desk.job(code, c.req.param('id')!)));

  app.get('/api/jobs/:id/steps/:n/output', async (c) => {
    if (badAuth.over(ip(c))) return c.json({ error: 'Too many wrong codes; try again later.' }, 429);
    const code = access(c);
    if (!code) { badAuth.check(ip(c)); return c.json({ error: 'Please sign in.' }, 401); }
    try {
      const out = await desk.output(code, c.req.param('id'), Number(c.req.param('n')));
      return new Response(out.data, { headers: { 'content-type': out.type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } });
    } catch (e) {
      if (e instanceof DeskError) return c.json({ error: e.message }, e.status as 404);
      throw e;
    }
  });

  app.get('/api/ledger', withCode((_c, code) => desk.ledger(code)));

  // ---------------------------------------------------------------- agent mandates

  app.get('/api/mandates', withCode((_c, code) => ({ mandates: desk.mandates(code) })));
  /** Start a mandate. With PayPal, the buyer then approves saving PayPal at approveUrl. */
  app.post('/api/mandates', withCode(async (c, code) => {
    const b = await body(c);
    return desk.createMandate(code, origin(c), { label: String(b.label ?? ''), perJobCents: Number(b.perJobCents), totalCents: Number(b.totalCents) });
  }, 201));
  /** PayPal's return link after the buyer approved saving PayPal (no access code: the browser was redirected). */
  app.get('/api/mandates/:id/return', async (c) => {
    try {
      await desk.completeMandate(c.req.param('id'));
      return c.redirect(`/?mandate=${encodeURIComponent(c.req.param('id'))}`, 302);
    } catch (e) {
      log('mandate return failed', c.req.param('id'), e);
      return c.redirect('/?mandate=failed', 302);
    }
  });
  app.post('/api/mandates/:id/key', withCode((c, code) => desk.revealKey(code, c.req.param('id')!)));
  app.post('/api/mandates/:id/revoke', withCode((c, code) => desk.revokeMandate(code, c.req.param('id')!)));

  // ---------------------------------------------------------------- agents

  app.all('/mcp', async (c) => {
    if (badAuth.over(ip(c))) return c.json({ error: 'Too many wrong keys; try again later.' }, 429);
    const res = await handleMcp(desk, c.req.raw, ip(c));
    if (res.status === 401) badAuth.check(ip(c));
    return res;
  });

  app.onError((err, c) => {
    log('error', c.req.path, err);
    return c.json({ error: 'Something went wrong on our side.' }, 500);
  });

  return Object.assign(app, { recover: desk.recover });
}
