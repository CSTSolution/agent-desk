/**
 * PayPal REST client (sandbox): Orders v2 with intent AUTHORIZE, then partial
 * capture or void of the authorization, plus Vault v3 for saved PayPal wallets.
 *
 * Plain fetch so judges can read exactly which endpoints are called.
 */

export interface PayPalConfig {
  base: string;
  clientId: string;
  secret: string;
  currency: string;
}

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly debugId?: string, readonly issue?: string) {
    super(message);
  }
}

type Link = { rel: string; href: string };

export class PayPal {
  private token: { value: string; expires: number } | null = null;
  constructor(readonly cfg: PayPalConfig) {}

  get configured() { return Boolean(this.cfg.clientId && this.cfg.secret); }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.cfg.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) throw new PayPalError(`PayPal auth failed (${res.status})`, res.status);
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  /** One REST call. `requestId` makes retries safe (PayPal-Request-Id idempotency). */
  async call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const res = await fetch(`${this.cfg.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
        ...(requestId ? { 'paypal-request-id': requestId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as T & { message?: string; debug_id?: string; details?: { issue?: string; description?: string }[] };
    if (!res.ok) {
      const d = data.details?.[0];
      throw new PayPalError(`PayPal ${method} ${path.split('/').slice(0, 4).join('/')} failed (${res.status}): ${d?.issue ?? data.message ?? ''}`, res.status, data.debug_id, d?.issue);
    }
    return data;
  }

  // ------------------------------------------------------------- Orders v2

  /** An order the buyer approves in the PayPal popup. Nothing is charged by approving. */
  createAuthorizeOrder(o: { cents: number; jobRef: string; description: string; vaultId?: string; returnUrl?: string; cancelUrl?: string }) {
    const value = `${Math.floor(o.cents / 100)}.${String(o.cents % 100).padStart(2, '0')}`;
    return this.call<{ id: string; status: string; links?: Link[]; purchase_units?: { payments?: { authorizations?: { id: string; status: string }[] } }[] }>(
      'POST', '/v2/checkout/orders', {
        intent: 'AUTHORIZE',
        purchase_units: [{
          reference_id: o.jobRef,
          custom_id: o.jobRef,
          description: o.description.slice(0, 127),
          soft_descriptor: 'AGENTDESK',
          amount: { currency_code: this.cfg.currency, value },
        }],
        payment_source: o.vaultId
          ? { paypal: { vault_id: o.vaultId, stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT', usage_pattern: 'UNSCHEDULED_POSTPAID' } } }
          : { paypal: { experience_context: { brand_name: 'Agent Desk', user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING', ...(o.returnUrl ? { return_url: o.returnUrl, cancel_url: o.cancelUrl } : {}) } } },
      }, `order-${o.jobRef}`);
  }

  getOrder(id: string) {
    return this.call<{ id: string; status: string; purchase_units: { custom_id?: string; amount: { value: string; currency_code: string } }[] }>('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
  }

  /** After approval: place the hold. Returns the authorization the job settles against. */
  async authorizeOrder(orderId: string) {
    const r = await this.call<{ status: string; purchase_units: { custom_id?: string; payments?: { authorizations?: { id: string; status: string; amount: { value: string }; expiration_time?: string }[] } }[] }>(
      'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, `authorize-${orderId}`);
    const auth = r.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalError('PayPal returned no authorization', 502);
    return { authorizationId: auth.id, status: auth.status, cents: Math.round(Number(auth.amount.value) * 100), customId: r.purchase_units[0]?.custom_id, expires: auth.expiration_time };
  }

  /** Capture part (or all) of a hold and close it: the uncaptured rest goes back to the buyer. */
  captureAuthorization(authorizationId: string, cents: number, note: string) {
    const value = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    return this.call<{ id: string; status: string }>('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
      amount: { currency_code: this.cfg.currency, value },
      final_capture: true,
      note_to_payer: note.slice(0, 255),
    }, `capture-${authorizationId}`);
  }

  /** Nothing passed: release the whole hold. */
  voidAuthorization(authorizationId: string) {
    return this.call<Record<string, never>>('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, undefined, `void-${authorizationId}`);
  }

  refundCapture(captureId: string, cents: number, note: string) {
    const value = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    return this.call<{ id: string; status: string }>('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      amount: { currency_code: this.cfg.currency, value }, note_to_payer: note.slice(0, 255),
    }, `refund-${captureId}-${cents}`);
  }

  // ------------------------------------------------------------- Vault v3

  /** Step 1 of saving PayPal for an agent: the buyer approves at the returned link. */
  async createSetupToken(returnUrl: string, cancelUrl: string, ref: string) {
    const r = await this.call<{ id: string; status: string; links?: Link[] }>('POST', '/v3/vault/setup-tokens', {
      payment_source: {
        paypal: {
          description: 'Agent Desk: let your AI agents buy AI work within your spending limits',
          usage_pattern: 'UNSCHEDULED_POSTPAID',
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          permit_multiple_payment_tokens: false,
          experience_context: { brand_name: 'Agent Desk', return_url: returnUrl, cancel_url: cancelUrl, shipping_preference: 'NO_SHIPPING' },
        },
      },
    }, `setup-${ref}`);
    return { id: r.id, approveUrl: r.links?.find((l) => l.rel === 'approve')?.href ?? '' };
  }

  /** Step 2: turn the approved setup token into a payment token the agent can charge. */
  async createPaymentToken(setupTokenId: string) {
    const r = await this.call<{ id: string; customer?: { id: string }; payment_source?: { paypal?: { email_address?: string } } }>('POST', '/v3/vault/payment-tokens', {
      payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } },
    }, `ptoken-${setupTokenId}`);
    return { vaultId: r.id, customerId: r.customer?.id, email: r.payment_source?.paypal?.email_address };
  }
}
