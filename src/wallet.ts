/**
 * How a job is paid for: hold the quote, then capture what passed and release the rest.
 *
 * - DemoWallet keeps the money in the ledger only (tests, local runs without PayPal).
 * - PayPalWallet holds with a real PayPal sandbox authorization (Orders v2,
 *   intent AUTHORIZE), captures part of it with final_capture, or voids it.
 *
 * Both enforce the same spending cap per access code from the ledger, before
 * any money moves, and both write every movement to the ledger.
 */
import { newId, now, type Store } from './store.ts';
import { config } from './config.ts';
import type { PayPal } from './paypal/client.ts';

/** Where the money for a hold comes from. */
export interface HoldSource {
  /** A PayPal order the buyer has just approved in the popup. */
  orderId?: string;
  /** A saved PayPal wallet (Vault payment token) an agent may charge without a popup. */
  vaultId?: string;
}

export interface Wallet {
  readonly name: string;
  hold(access: string, jobId: string, cents: number, memo: string, source?: HoldSource): Promise<{ holdId: string }>;
  /** Capture `cents` (may be 0) of the hold and release the remainder, in one settlement. */
  settle(access: string, jobId: string, holdId: string, heldCents: number, cents: number): Promise<{ capturedCents: number; releasedCents: number; captureId?: string }>;
  /** What this access code may still spend (its cap minus captures and open holds). */
  balance(access: string): number;
}

export class InsufficientFunds extends Error {}
export class HoldRefused extends Error {}

abstract class LedgerWallet implements Wallet {
  abstract readonly name: string;
  constructor(protected store: Store) {}

  protected entry(access: string, jobId: string, type: 'hold' | 'capture' | 'release' | 'refund', cents: number, ref: string, memo: string) {
    this.store.db.prepare('INSERT INTO ledger (id, at, access, job_id, type, cents, ref, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('led'), now(), access, jobId, type, cents, ref, memo);
  }

  balance(access: string): number {
    const cap = config.accessCodes[access] ?? 0; // accounts and operator codes
    const row = this.store.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN type = 'capture' THEN cents END), 0) - COALESCE(SUM(CASE WHEN type = 'refund' THEN cents END), 0) AS spent,
        COALESCE(SUM(CASE WHEN type = 'hold' THEN cents END), 0) - COALESCE(SUM(CASE WHEN type IN ('capture','release') THEN cents END), 0) AS open
      FROM ledger WHERE access = ?`).get(access) as { spent: number; open: number };
    return cap - row.spent - row.open;
  }

  protected checkCap(access: string, cents: number) {
    if (cents > this.balance(access)) throw new InsufficientFunds('not enough spending limit left for this quote');
  }

  abstract hold(access: string, jobId: string, cents: number, memo: string, source?: HoldSource): Promise<{ holdId: string }>;
  abstract settle(access: string, jobId: string, holdId: string, heldCents: number, cents: number): Promise<{ capturedCents: number; releasedCents: number; captureId?: string }>;
}

export class DemoWallet extends LedgerWallet {
  readonly name = 'demo';

  async hold(access: string, jobId: string, cents: number, memo: string) {
    this.checkCap(access, cents);
    const holdId = newId('hold');
    this.entry(access, jobId, 'hold', cents, holdId, memo);
    return { holdId };
  }

  async settle(access: string, jobId: string, holdId: string, heldCents: number, cents: number) {
    const capturedCents = Math.max(0, Math.min(cents, heldCents));
    const releasedCents = heldCents - capturedCents;
    if (capturedCents) this.entry(access, jobId, 'capture', capturedCents, holdId, 'steps that passed');
    if (releasedCents) this.entry(access, jobId, 'release', releasedCents, holdId, 'steps that failed or were skipped');
    return { capturedCents, releasedCents };
  }
}

export class PayPalWallet extends LedgerWallet {
  readonly name = 'paypal-sandbox';
  constructor(store: Store, private paypal: PayPal) { super(store); }

  /** For the browser flow: the order the buyer approves. Approving charges nothing. */
  async startOrder(access: string, jobId: string, cents: number, memo: string): Promise<string> {
    this.checkCap(access, cents);
    const order = await this.paypal.createAuthorizeOrder({ cents, jobRef: jobId, description: memo });
    return order.id;
  }

  async hold(access: string, jobId: string, cents: number, memo: string, source: HoldSource = {}) {
    this.checkCap(access, cents);
    let auth: { authorizationId: string; cents: number; customId?: string };
    if (source.orderId) {
      // The buyer approved this order in the popup; check it is the one we made for this job, then hold.
      auth = await this.paypal.authorizeOrder(source.orderId);
    } else if (source.vaultId) {
      // Agent purchase: the saved wallet is charged with no popup, still only as a hold.
      const order = await this.paypal.createAuthorizeOrder({ cents, jobRef: jobId, description: memo, vaultId: source.vaultId });
      const a = order.purchase_units?.[0]?.payments?.authorizations?.[0];
      auth = a ? { authorizationId: a.id, cents, customId: jobId } : await this.paypal.authorizeOrder(order.id);
    } else {
      throw new HoldRefused('a PayPal hold needs an approved order or a saved PayPal wallet');
    }
    if (auth.customId && auth.customId !== jobId) throw new HoldRefused('that PayPal order belongs to a different job');
    if (auth.cents !== cents) {
      await this.paypal.voidAuthorization(auth.authorizationId).catch(() => {});
      throw new HoldRefused('the PayPal amount does not match the quote');
    }
    this.entry(access, jobId, 'hold', cents, auth.authorizationId, memo);
    return { holdId: auth.authorizationId };
  }

  async settle(access: string, jobId: string, holdId: string, heldCents: number, cents: number) {
    const capturedCents = Math.max(0, Math.min(cents, heldCents));
    const releasedCents = heldCents - capturedCents;
    let captureId: string | undefined;
    if (capturedCents > 0) {
      // final_capture closes the authorization, so the uncaptured rest is released to the buyer.
      const cap = await this.paypal.captureAuthorization(holdId, capturedCents, `Agent Desk: charged ${capturedCents}¢ for the steps that passed inspection.`);
      captureId = cap.id;
      this.entry(access, jobId, 'capture', capturedCents, cap.id, 'steps that passed');
    } else {
      await this.paypal.voidAuthorization(holdId);
    }
    if (releasedCents) this.entry(access, jobId, 'release', releasedCents, holdId, capturedCents ? 'rest of the hold, closed by final capture' : 'hold voided');
    return { capturedCents, releasedCents, captureId };
  }
}
