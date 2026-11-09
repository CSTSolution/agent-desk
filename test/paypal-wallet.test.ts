import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import { PayPalWallet, HoldRefused, InsufficientFunds } from '../src/wallet.ts';
import { PayPal } from '../src/paypal/client.ts';
import { config } from '../src/config.ts';

/** Stands in for api-m.sandbox.paypal.com; records every call. */
function fakePayPal(order: { customId: string; cents: number }) {
  const calls: { method: string; path: string; body: any; requestId?: string }[] = [];
  const pp = new PayPal({ base: 'https://sandbox.test', clientId: 'id', secret: 'secret', currency: 'USD' });
  const value = (c: number) => (c / 100).toFixed(2);
  (pp as any).accessToken = async () => 'token';
  pp.call = (async (method: string, path: string, body?: any, requestId?: string) => {
    calls.push({ method, path, body, requestId });
    if (path === '/v2/checkout/orders') {
      if (body.payment_source?.paypal?.vault_id) {
        return { id: 'ORDER-V', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH-V', status: 'CREATED' }] } }] };
      }
      return { id: 'ORDER-1', status: 'CREATED' };
    }
    if (path.endsWith('/authorize')) {
      return { status: 'COMPLETED', purchase_units: [{ custom_id: order.customId, payments: { authorizations: [{ id: 'AUTH-1', status: 'CREATED', amount: { value: value(order.cents) } }] } }] };
    }
    if (path.endsWith('/capture')) return { id: 'CAP-1', status: 'COMPLETED' };
    if (path.endsWith('/void')) return {};
    throw new Error(`unexpected ${method} ${path}`);
  }) as PayPal['call'];
  return { pp, calls };
}

const setup = (order: { customId: string; cents: number }) => {
  config.accessCodes.judge = 500;
  const store = openStore(mkdtempSync(join(tmpdir(), 'desk-pp-')));
  const { pp, calls } = fakePayPal(order);
  return { wallet: new PayPalWallet(store, pp), calls, store };
};

test('approved order -> authorization hold -> partial capture closes it', async () => {
  const { wallet, calls } = setup({ customId: 'job_1', cents: 40 });
  const orderId = await wallet.startOrder('judge', 'job_1', 40, 'voice-over + translation');
  assert.equal(orderId, 'ORDER-1');
  assert.equal(calls[0]!.body.intent, 'AUTHORIZE');
  assert.equal(calls[0]!.body.purchase_units[0].amount.value, '0.40');
  assert.equal(calls[0]!.body.purchase_units[0].custom_id, 'job_1');

  const { holdId } = await wallet.hold('judge', 'job_1', 40, 'x', { orderId });
  assert.equal(holdId, 'AUTH-1');
  assert.equal(wallet.balance('judge'), 460);

  const s = await wallet.settle('judge', 'job_1', holdId, 40, 25);
  assert.deepEqual(s, { capturedCents: 25, releasedCents: 15, captureId: 'CAP-1' });
  const cap = calls.find((c) => c.path.endsWith('/capture'))!;
  assert.equal(cap.path, '/v2/payments/authorizations/AUTH-1/capture');
  assert.deepEqual(cap.body.amount, { currency_code: 'USD', value: '0.25' });
  assert.equal(cap.body.final_capture, true);
  assert.ok(cap.requestId, 'captures are idempotent');
  assert.equal(wallet.balance('judge'), 475);
});

test('nothing passed -> the authorization is voided, nothing captured', async () => {
  const { wallet, calls } = setup({ customId: 'job_2', cents: 30 });
  const { holdId } = await wallet.hold('judge', 'job_2', 30, 'x', { orderId: 'ORDER-1' });
  const s = await wallet.settle('judge', 'job_2', holdId, 30, 0);
  assert.deepEqual(s, { capturedCents: 0, releasedCents: 30, captureId: undefined });
  assert.ok(calls.some((c) => c.path === '/v2/payments/authorizations/AUTH-1/void'));
  assert.ok(!calls.some((c) => c.path.endsWith('/capture')));
  assert.equal(wallet.balance('judge'), 500);
});

test('an order made for another job, or for another amount, is refused', async () => {
  const other = setup({ customId: 'job_other', cents: 30 });
  await assert.rejects(other.wallet.hold('judge', 'job_3', 30, 'x', { orderId: 'ORDER-1' }), HoldRefused);
  const tampered = setup({ customId: 'job_4', cents: 1 });
  await assert.rejects(tampered.wallet.hold('judge', 'job_4', 30, 'x', { orderId: 'ORDER-1' }), HoldRefused);
  assert.ok(tampered.calls.some((c) => c.path.endsWith('/void')), 'a mismatched hold is released at once');
});

test('the spending cap is checked before PayPal is called', async () => {
  const { wallet, calls } = setup({ customId: 'job_5', cents: 900 });
  await assert.rejects(wallet.startOrder('judge', 'job_5', 900, 'x'), InsufficientFunds);
  assert.equal(calls.length, 0);
});

test('an agent with a saved PayPal wallet gets a hold with no popup', async () => {
  const { wallet, calls } = setup({ customId: 'job_6', cents: 20 });
  const { holdId } = await wallet.hold('judge', 'job_6', 20, 'agent job', { vaultId: 'VAULT-1' });
  assert.equal(holdId, 'AUTH-V');
  const src = calls[0]!.body.payment_source.paypal;
  assert.equal(src.vault_id, 'VAULT-1');
  assert.equal(src.stored_credential.payment_initiator, 'MERCHANT');
});
