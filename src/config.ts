/** Every setting in one place. Secrets come from the environment (.env), never from the repo. */

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const config = {
  port: num('PORT', 8787),
  dataDir: process.env.DATA_DIR || 'data',
  fixlarkApi: process.env.FIXLARK_API || 'https://fixlark.com/api/v1',

  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    // Model ids are set in .env after listing them from the provider (GET /v1/models).
    planner: process.env.LLM_PLANNER_MODEL || '',
    judge: process.env.LLM_JUDGE_MODEL || process.env.LLM_PLANNER_MODEL || '',
    router: process.env.LLM_ROUTER_MODEL || process.env.LLM_PLANNER_MODEL || '',
    timeoutMs: num('LLM_TIMEOUT_MS', 60_000),
    /** Calls per minute we allow ourselves, under the provider's limit; bursts wait instead of failing. */
    rpm: num('LLM_RPM', 30),
    burst: num('LLM_BURST', 5),
    maxWaitMs: num('LLM_MAX_WAIT_MS', 25_000),
    /** Send chat_template_kwargs.enable_thinking (NVIDIA NIM / vLLM). Set LLM_THINKING_CONTROL=0 for providers that reject it. */
    thinkingControl: process.env.LLM_THINKING_CONTROL !== '0',
  },

  paypal: {
    base: process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    secret: process.env.PAYPAL_CLIENT_SECRET || '',
    currency: process.env.PAYPAL_CURRENCY || 'USD',
    /** This build is for the PayPal sandbox. Live PayPal needs an explicit opt-in. */
    allowLive: process.env.ALLOW_LIVE_PAYPAL === '1',
  },

  /** Uploads and job outputs are deleted after this many hours (database rows stay for the ledger). */
  retentionHours: num('RETENTION_HOURS', 24),
  uploadsPerMinute: num('UPLOADS_PER_MINUTE', 10),
  uploadsPerDay: num('UPLOADS_PER_DAY', 100),
  uploadMbPerDay: num('UPLOAD_MB_PER_DAY', 500),
  uploadsAtOnce: num('UPLOADS_AT_ONCE', 3),
  checkoutsPerMinute: num('CHECKOUTS_PER_MINUTE', 6),
  checkoutsPerDay: num('CHECKOUTS_PER_DAY', 120),
  mandatesPerMinute: num('MANDATES_PER_MINUTE', 3),
  mandatesPerDay: num('MANDATES_PER_DAY', 20),
  badAuthPerMinute: num('BAD_AUTH_PER_MINUTE', 10),
  badAuthPerDay: num('BAD_AUTH_PER_DAY', 100),
  jobsAtOncePerCode: num('JOBS_AT_ONCE_PER_CODE', 3),
  jobsAtOnce: num('JOBS_AT_ONCE', 6),

  guard: {
    disabled: process.env.AI_DISABLED === '1',
    /** Global daily LLM budget in US cents across all users; the kill switch trips when it is spent. */
    dailyBudgetCents: num('AI_DAILY_BUDGET_CENTS', 300),
    /** Rough token prices (cents per million) used only for the budget meter. */
    centsPerMTokIn: num('LLM_CENTS_PER_MTOK_IN', 30),
    centsPerMTokOut: num('LLM_CENTS_PER_MTOK_OUT', 120),
    quotesPerMinute: num('QUOTES_PER_MINUTE', 4),
    quotesPerDay: num('QUOTES_PER_DAY', 60),
  },

  limits: {
    requestChars: 600,
    textChars: 3000,
    audioBytes: 25 * 1024 * 1024,
    imageBytes: 10 * 1024 * 1024,
    inputs: 3,
    steps: 5,
  },

  /**
   * Who may register: "code:cents:maxAccounts,...". The code only lets someone
   * create an account; cents is that account's spending limit, and maxAccounts
   * bounds what a leaked code can do.
   */
  invites: Object.fromEntries(
    (process.env.INVITE_CODES || '')
      .split(',')
      .map((p) => p.trim().split(':'))
      .filter(([c, v, m]) => c && Number(v) > 0 && Number(m) > 0)
      .map(([c, v, m]) => [c!, { cents: Number(v), maxAccounts: Number(m) }]),
  ) as Record<string, { cents: number; maxAccounts: number }>,

  /** PayPal sandbox test buyers shown to signed-in users: 'email|password,email|password'. Sandbox only. */
  sandboxBuyers: (process.env.SANDBOX_BUYERS || '').split(',').map((p) => p.trim().split('|')).filter(([e, w]) => e && w).map(([email, password]) => ({ email: email!, password: password! })),

  registrationsPerMinute: num('REGISTRATIONS_PER_MINUTE', 3),
  registrationsPerDay: num('REGISTRATIONS_PER_DAY', 20),
  loginsPerMinutePerUser: num('LOGINS_PER_MINUTE_PER_USER', 5),

  /**
   * Spending limits by id: accounts are added here from the database. ACCESS_CODES
   * ("code:cents,...") are operator codes for the API only; the page uses accounts.
   */
  accessCodes: Object.fromEntries(
    (process.env.ACCESS_CODES || '')
      .split(',')
      .map((p) => p.trim().split(':'))
      .filter(([c, v]) => c && Number(v) > 0)
      .map(([c, v]) => [c!, Number(v)]),
  ) as Record<string, number>,
};
