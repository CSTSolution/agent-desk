/**
 * Serves the page and the API with a strict CSP. PayPal's JS SDK needs to
 * run its own inline script, so each page load gets a fresh nonce that the
 * CSP allows and the page hands to the SDK (data-csp-nonce). Nothing else
 * inline can run.
 */
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const PP = 'https://*.paypal.com https://*.paypalobjects.com';

export const csp = (nonce: string) =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}' ${PP}; style-src 'self' 'unsafe-inline' ${PP}; img-src 'self' blob: data: ${PP}; media-src 'self' blob:; connect-src 'self' ${PP}; frame-src ${PP}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

export function createSite(api: Hono, webRoot = './web') {
  const site = new Hono();
  site.use('*', async (c, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    c.set('nonce' as never, nonce as never);
    await next();
    c.header('content-security-policy', csp(nonce));
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
  });
  site.route('/', api);

  // AG Grid for the ledger, served from here so the CSP stays 'self'. Loaded only when a ledger is shown.
  let grid: Buffer | null = null;
  site.get('/vendor/ag-grid.js', async (c) => {
    grid ??= await readFile('node_modules/ag-grid-community/dist/ag-grid-community.min.js');
    return c.body(new Uint8Array(grid), 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=604800' });
  });
  site.get('/', async (c) => {
    const nonce = c.get('nonce' as never) as string;
    let html = (await readFile(`${webRoot}/index.html`, 'utf8')).replace('__CSP_NONCE__', nonce);
    // Cloudflare caches .js and .css for hours: stamp each with a hash of its content, so a deploy takes effect at once.
    for (const asset of ['app.js', 'style.css']) {
      const v = crypto.createHash('sha256').update(await readFile(`${webRoot}/${asset}`)).digest('hex').slice(0, 12);
      html = html.replace(`"/${asset}"`, `"/${asset}?v=${v}"`);
    }
    return c.html(html, 200, { 'cache-control': 'no-store' });
  });
  site.use('/*', serveStatic({ root: webRoot }));
  return site;
}
