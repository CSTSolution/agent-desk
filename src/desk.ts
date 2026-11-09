/**
 * Agent Desk's core, shared by the web API (people) and the MCP server (agents):
 * attachments, quotes, paying, running jobs, and agent mandates.
 *
 * Every quote goes through the gate (caps, rate limits, daily model budget) and
 * the pre-check before the planner sees it, whoever is asking.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import crypto from 'node:crypto';
import type { LLM } from './llm/client.ts';
import type { Fixlark } from './fixlark/client.ts';
import type { Wallet } from './wallet.ts';
import { InsufficientFunds, HoldRefused, PayPalWallet } from './wallet.ts';
import { PayPalError, type PayPal } from './paypal/client.ts';
import { newId, now, type Store } from './store.ts';
import { planRequest, type InputDesc, type Quote } from './planner.ts';
import { precheck, precheckAll, MATERIAL_SYSTEM, Limiter, type Budget } from './guard/guard.ts';
import { wavInfo } from './judge/judge.ts';
import { runJob, type StoredInput } from './runner.ts';
import { config } from './config.ts';

/** The one job the pre-check lets through. */
export const DESK_TASK = `Agent Desk sells AI jobs done on the buyer's own attachments: transcribing English audio, text-to-speech voice-overs, removing image backgrounds, translating text (Chinese, English, Vietnamese, Japanese, Korean), and grammar checks. A request asks for one or more of these. Requests to transcribe, voice or read aloud, translate, proofread, or cut out or remove a background are on_task, even very short ones such as "to Vietnamese", "read it in a British voice" or "đọc to giúp tôi".`;

const BLOCKED = 'Agent Desk only takes requests to transcribe, voice, translate, grammar-check or cut out the backgrounds of your attachments.';
const AUDIO = /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|webm|mp4|mov)$/i;
const IMAGE = /\.(png|jpe?g|webp)$/i;

export class DeskError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

export interface DeskDeps {
  store: Store;
  llm: LLM;
  fixlark: Fixlark;
  wallet: Wallet;
  budget: Budget;
  /** Needed for agent mandates with real PayPal (Vault). */
  paypal?: PayPal;
}

export interface Mandate {
  id: string;
  access: string;
  status: 'pending' | 'active' | 'revoked';
  label: string;
  vault_id: string | null;
  payer_email: string | null;
  per_job_cents: number;
  total_cents: number;
  key_hint: string | null;
}

type QuoteRow = { id: string; access: string; plan: string; inputs: string; total_cents: number; used: number };
type FileRow = { id: string; kind: string; name: string; bytes: number; chars: number | null; minutes: number | null };

const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');
/** Access codes never go in the logs. */
const tag = (code: string) => hashKey(code).slice(0, 8);
const log = (...a: unknown[]) => console.log(now(), ...a);

export function createDesk(deps: DeskDeps) {
  const { db } = deps.store;
  const perCode = new Limiter(config.guard.quotesPerMinute, config.guard.quotesPerDay);
  const perIp = new Limiter(config.guard.quotesPerMinute * 2, config.guard.quotesPerDay * 2);
  const uploads = new Limiter(config.uploadsPerMinute, config.uploadsPerDay);
  const checkouts = new Limiter(config.checkoutsPerMinute, config.checkoutsPerDay);
  const newMandates = new Limiter(config.mandatesPerMinute, config.mandatesPerDay);

  const fail = (status: number, message: string, extra?: Record<string, unknown>): never => { throw new DeskError(status, message, extra); };

  /** Turn wallet and PayPal failures into answers a buyer (or agent) can act on. */
  function holdError(e: unknown): never {
    if (e instanceof InsufficientFunds) fail(402, 'Not enough spending limit left for that quote.');
    if (e instanceof HoldRefused) fail(409, e.message);
    if (e instanceof PayPalError) { log('paypal', e.message, e.debugId); fail(502, 'PayPal did not accept the payment. Try again.'); }
    throw e;
  }

  // -------------------------------------------------------------- attachments

  async function saveFile(access: string, row: Omit<FileRow, 'id'>, data: string | Uint8Array): Promise<FileRow> {
    if (!uploads.check(access)) fail(429, 'Too many attachments; wait a minute.');
    const id = newId('file');
    const path = join(deps.store.dir, 'files', id);
    await writeFile(path, data);
    db.prepare('INSERT INTO files (id, access, kind, name, path, bytes, chars, minutes, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, access, row.kind, row.name, path, row.bytes, row.chars, row.minutes, now());
    return { id, ...row };
  }

  function addText(access: string, raw: string) {
    const text = String(raw ?? '').trim();
    if (!text) fail(400, 'The text is empty.');
    if (text.length > config.limits.textChars) fail(413, `Text attachments are limited to ${config.limits.textChars} characters.`);
    return saveFile(access, { kind: 'text', name: 'text', bytes: Buffer.byteLength(text), chars: text.length, minutes: null }, text);
  }

  function addUpload(access: string, rawName: string, bytes: Uint8Array) {
    const name = rawName.replace(/[^\w.-]/g, '_').slice(-80) || 'upload';
    const kind = AUDIO.test(name) ? 'audio' : IMAGE.test(name) ? 'image' : null;
    if (!kind) fail(415, 'Attach audio (WAV, MP3, M4A...) or an image (PNG, JPEG, WebP).');
    const cap = kind === 'audio' ? config.limits.audioBytes : config.limits.imageBytes;
    if (bytes.length > cap) fail(413, `That file is over ${cap / 1048576} MB.`);
    const today = (db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM files WHERE access = ? AND created >= ?').get(access, now().slice(0, 10)) as { b: number }).b;
    if (today + bytes.length > config.uploadMbPerDay * 1048576) fail(429, 'This account has reached its upload limit for today.');
    // WAV length is exact; anything else is estimated at 128 kbit/s for the quote.
    const minutes = kind === 'audio' ? (wavInfo(bytes)?.seconds ?? (bytes.length * 8) / 128_000) / 60 : null;
    return saveFile(access, { kind: kind!, name, bytes: bytes.length, chars: null, minutes }, bytes);
  }

  // -------------------------------------------------------------- quotes

  async function quote(access: string, ip: string, rawRequest: string, fileIds: string[]) {
    const request = String(rawRequest ?? '').trim();
    if (!request) fail(400, 'Say what you need done.');
    if (request.length > config.limits.requestChars) fail(413, `Keep the request under ${config.limits.requestChars} characters.`);
    if (fileIds.length > config.limits.inputs) fail(413, `Attach at most ${config.limits.inputs} items.`);
    const files = fileIds.map((id) => db.prepare('SELECT * FROM files WHERE id = ? AND access = ? AND path IS NOT NULL').get(id, access) as FileRow | undefined);
    if (files.some((f) => !f)) fail(400, 'An attachment is missing; upload it again.');

    if (!perCode.check(access) || !perIp.check(ip)) fail(429, 'Too many quotes; wait a minute.');
    if (!deps.budget.open()) fail(503, 'Agent Desk has used its model budget for today. Try again tomorrow.');

    const gate = await precheck(deps.llm, config.llm.router, DESK_TASK, request);
    if (gate.result) deps.budget.record(gate.result.usage);
    log('quote precheck', tag(access), gate.verdict, gate.reason);
    if (gate.verdict === 'error') fail(503, 'The request filter is unavailable right now; try again shortly.');
    if (gate.verdict !== 'on_task') fail(422, BLOCKED, { blocked: gate.verdict });

    // Attached text reaches the inspector model, so it is read in full first (ai-endpoint-guard layer 3).
    for (const f of files.filter((x) => x!.kind === 'text')) {
      const row = db.prepare('SELECT path FROM files WHERE id = ?').get(f!.id) as { path: string };
      const v = await precheckAll(deps.llm, config.llm.router, DESK_TASK, await readFile(row.path, 'utf8'), { system: MATERIAL_SYSTEM });
      const r = (v as { result?: { usage: { in: number; out: number } } }).result;
      if (r) deps.budget.record(r.usage);
      log('attachment precheck', tag(access), v.verdict, v.reason);
      if (v.verdict === 'error') fail(503, 'The content filter is unavailable right now; try again shortly.');
      if (v.verdict !== 'on_task') fail(422, 'That attachment cannot be processed: it looks like instructions aimed at an AI, or content this service does not handle.', { blocked: v.verdict });
    }

    const inputs: InputDesc[] = files.map((f) => ({ kind: f!.kind as InputDesc['kind'], name: f!.name, bytes: f!.bytes, chars: f!.chars ?? undefined, minutes: f!.minutes ?? undefined }));
    const outcome = await planRequest(deps.llm, request, inputs, (u) => deps.budget.record(u));
    log('quote plan', tag(access), outcome.ok ? `${outcome.quote.steps.length} steps ${outcome.quote.totalCents}c` : outcome.code);
    if (!outcome.ok) fail(422, outcome.reason, { code: outcome.code });
    const planned = (outcome as { ok: true; quote: Quote }).quote;

    const id = newId('quote');
    db.prepare('INSERT INTO quotes (id, access, request, inputs, plan, total_cents, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, access, request, JSON.stringify(fileIds), JSON.stringify(planned), planned.totalCents, now());
    return { id, ...planned, balanceCents: deps.wallet.balance(access) };
  }

  // -------------------------------------------------------------- jobs

  const loadInputs = (q: QuoteRow) => (JSON.parse(q.inputs) as string[]).map((id) => db.prepare('SELECT kind, name, path FROM files WHERE id = ?').get(id) as unknown as StoredInput);

  function openQuote(access: string, quoteId: string): QuoteRow {
    const q = db.prepare('SELECT * FROM quotes WHERE id = ? AND access = ?').get(String(quoteId ?? ''), access) as QuoteRow | undefined;
    if (!q) fail(404, 'That quote does not exist.');
    if (q!.used) fail(409, 'That quote was already used.');
    return q!;
  }

  function createJob(access: string, q: QuoteRow, status: string, mandateId: string | null = null) {
    const planned = JSON.parse(q.plan) as Quote;
    const jobId = newId('job');
    db.prepare('UPDATE quotes SET used = 1 WHERE id = ?').run(q.id);
    db.prepare('INSERT INTO jobs (id, access, quote_id, status, held_cents, wallet, mandate_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, access, q.id, status, q.total_cents, deps.wallet.name, mandateId, now());
    const addStep = db.prepare("INSERT INTO steps (job_id, idx, service, title, status, cents) VALUES (?, ?, ?, ?, 'waiting', ?)");
    for (const s of planned.steps) addStep.run(jobId, s.index, s.service, s.title, s.cents);
    return { jobId, planned };
  }

  const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const ACTIVE = "status IN ('held', 'running', 'authorizing')";

  /**
   * Money promised but not yet in the ledger: the hold is written only after
   * PayPal answers. Counting it here closes the gap in which several purchases
   * started together would each see the full limit. Checks and job creation run
   * without an await between them, so they cannot interleave.
   */
  const pendingCents = (where: string, id: string) => count(
    `SELECT COALESCE(SUM(held_cents), 0) AS n FROM jobs WHERE ${where} = ? AND hold_id IS NULL AND (status IN ('held', 'authorizing') OR (status = 'awaiting payment' AND created > ?))`,
    id, new Date(Date.now() - 15 * 60_000).toISOString(),
  );
  const available = (access: string) => deps.wallet.balance(access) - pendingCents('access', access);

  function gateNewJob(access: string, q: QuoteRow) {
    if (count(`SELECT COUNT(*) AS n FROM jobs WHERE ${ACTIVE} AND access = ?`, access) >= config.jobsAtOncePerCode) fail(429, 'Too many jobs running for this account; wait for one to finish.');
    if (count(`SELECT COUNT(*) AS n FROM jobs WHERE ${ACTIVE}`) >= config.jobsAtOnce) fail(429, 'Agent Desk is busy; try again in a minute.');
    if (q.total_cents > available(access)) holdError(new InsufficientFunds());
  }

  function abandon(jobId: string, quoteId: string) {
    db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(jobId);
    db.prepare('UPDATE quotes SET used = 0 WHERE id = ?').run(quoteId);
  }

  /** The hold is in place: run the job in the background. */
  function start(access: string, jobId: string, q: QuoteRow, holdId: string, ip: string | null) {
    db.prepare("UPDATE jobs SET status = 'held', hold_id = ? WHERE id = ?").run(holdId, jobId);
    runJob({ ...deps, fixlark: deps.fixlark.forClient(ip), onUsage: (u) => deps.budget.record(u) }, { id: jobId, access, holdId, heldCents: q.total_cents }, JSON.parse(q.plan) as Quote, loadInputs(q))
      .catch(async (e) => {
        log('job crashed', jobId, e);
        await releaseHold(access, jobId, holdId, q.total_cents);
      });
  }

  /** A job that cannot finish: give the buyer's money back and nothing is delivered. */
  async function releaseHold(access: string, jobId: string, holdId: string, heldCents: number) {
    try {
      const s = await deps.wallet.settle(access, jobId, holdId, heldCents, 0);
      db.prepare("UPDATE jobs SET status = 'not delivered', captured_cents = 0, released_cents = ?, finished = ? WHERE id = ?").run(s.releasedCents, now(), jobId);
    } catch (e) {
      // Left open at PayPal; an uncaptured authorization lapses on its own and nothing was charged.
      log('release failed', jobId, e);
      db.prepare("UPDATE jobs SET status = 'error' WHERE id = ?").run(jobId);
    }
    db.prepare("UPDATE steps SET status = 'failed', verdict = ? WHERE job_id = ? AND status NOT IN ('failed', 'skipped')")
      .run(JSON.stringify({ pass: false, evidence: ['The job could not finish. Not charged.'] }), jobId);
  }

  /** After a restart: jobs that were mid-flight can't resume, so their holds are released. */
  async function recover() {
    const stuck = db.prepare(`SELECT id, access, hold_id, held_cents, quote_id FROM jobs WHERE ${ACTIVE}`).all() as { id: string; access: string; hold_id: string | null; held_cents: number; quote_id: string }[];
    for (const j of stuck) {
      if (j.hold_id) await releaseHold(j.access, j.id, j.hold_id, j.held_cents);
      else abandon(j.id, j.quote_id);
      log('recovered job after restart', j.id);
    }
    return stuck.length;
  }

  /**
   * A person pays in the browser. With PayPal this returns the order to approve
   * in the PayPal popup (approving charges nothing); /approve then places the hold.
   */
  async function checkout(access: string, quoteId: string, ip: string | null = null) {
    const q = openQuote(access, quoteId);
    if (!checkouts.check(access)) fail(429, 'Too many payment attempts; wait a minute.');
    gateNewJob(access, q);
    if (deps.wallet instanceof PayPalWallet) {
      const { jobId, planned } = createJob(access, q, 'awaiting payment');
      try {
        const orderId = await deps.wallet.startOrder(access, jobId, q.total_cents, planned.summary);
        db.prepare('UPDATE jobs SET order_id = ? WHERE id = ?').run(orderId, jobId);
        return { id: jobId, heldCents: q.total_cents, orderId, needsApproval: true };
      } catch (e) { abandon(jobId, q.id); holdError(e); }
    }
    const { jobId, planned } = createJob(access, q, 'held');
    try {
      const { holdId } = await deps.wallet.hold(access, jobId, q.total_cents, planned.summary);
      start(access, jobId, q, holdId, ip);
      return { id: jobId, heldCents: q.total_cents };
    } catch (e) { abandon(jobId, q.id); return holdError(e); }
  }

  async function approve(access: string, jobId: string, orderId: string, ip: string | null = null) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND access = ?').get(jobId, access) as { id: string; quote_id: string; status: string; order_id: string | null } | undefined;
    if (!job) fail(404, 'No such job.');
    if (job!.status !== 'awaiting payment' || !job!.order_id || job!.order_id !== String(orderId ?? '')) fail(409, 'That payment does not belong to this job.');
    if (count(`SELECT COUNT(*) AS n FROM jobs WHERE ${ACTIVE}`) >= config.jobsAtOnce) fail(429, 'Agent Desk is busy; try again in a minute.');
    db.prepare("UPDATE jobs SET status = 'authorizing' WHERE id = ? AND status = 'awaiting payment'").run(job!.id);
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(job!.quote_id) as QuoteRow;
    try {
      const { holdId } = await deps.wallet.hold(access, job!.id, q.total_cents, (JSON.parse(q.plan) as Quote).summary, { orderId: job!.order_id! });
      start(access, job!.id, q, holdId, ip);
      return { id: job!.id, holdId };
    } catch (e) {
      db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(job!.id);
      return holdError(e);
    }
  }

  function cancel(access: string, jobId: string) {
    const job = db.prepare("SELECT id, quote_id FROM jobs WHERE id = ? AND access = ? AND status = 'awaiting payment'").get(jobId, access) as { id: string; quote_id: string } | undefined;
    if (!job) fail(404, 'Nothing to cancel.');
    abandon(job!.id, job!.quote_id);
    return { ok: true };
  }

  function job(access: string, jobId: string) {
    const j = db.prepare('SELECT j.*, q.request, q.plan FROM jobs j JOIN quotes q ON q.id = j.quote_id WHERE j.id = ? AND j.access = ?').get(jobId, access) as Record<string, unknown> | undefined;
    if (!j) fail(404, 'No such job.');
    const steps = (db.prepare('SELECT idx, service, title, status, cents, verdict, output_kind FROM steps WHERE job_id = ? ORDER BY idx').all(String(j!.id)) as Record<string, unknown>[])
      .map((s) => ({ ...s, verdict: s.verdict ? JSON.parse(String(s.verdict)) : null })) as { idx: number; service: string; title: string; status: string; cents: number; verdict: { pass: boolean; evidence: string[] } | null; output_kind: string | null }[];
    const planned = JSON.parse(String(j!.plan)) as Quote;
    return {
      id: String(j!.id), status: String(j!.status), request: String(j!.request), summary: planned.summary,
      heldCents: Number(j!.held_cents), capturedCents: Number(j!.captured_cents), releasedCents: Number(j!.released_cents),
      wallet: String(j!.wallet), mandateId: (j!.mandate_id as string | null) ?? null, steps, balanceCents: deps.wallet.balance(access),
      paypal: j!.hold_id && deps.wallet instanceof PayPalWallet ? { orderId: (j!.order_id as string | null) ?? null, authorizationId: j!.hold_id as string, captureId: (j!.capture_id as string | null) ?? null } : null,
    };
  }

  async function output(access: string, jobId: string, n: number) {
    const row = db.prepare('SELECT s.output_path, s.output_kind, s.status, j.status AS job_status FROM steps s JOIN jobs j ON j.id = s.job_id WHERE s.job_id = ? AND s.idx = ? AND j.access = ?')
      .get(jobId, n, access) as { output_path: string | null; output_kind: string | null; status: string; job_status: string } | undefined;
    // Delivered only once PayPal has captured the payment: no output without settlement.
    if (!row?.output_path || row.status !== 'passed' || !['delivered', 'partly delivered'].includes(row.job_status)) fail(404, 'No delivered output for that step (outputs are deleted after a day).');
    const type = row!.output_kind === 'audio' ? 'audio/wav' : row!.output_kind === 'image' ? 'image/png' : 'text/plain; charset=utf-8';
    return { data: new Uint8Array(await readFile(row!.output_path!)), type, kind: row!.output_kind! };
  }

  function ledger(access: string) {
    const entries = db.prepare(`SELECT l.at, l.job_id, l.type, l.cents, l.ref, l.memo, j.status AS job_status, COALESCE(m.label, 'You') AS buyer
      FROM ledger l LEFT JOIN jobs j ON j.id = l.job_id LEFT JOIN mandates m ON m.id = j.mandate_id
      WHERE l.access = ? ORDER BY l.at DESC LIMIT 500`).all(access);
    return { entries, balanceCents: deps.wallet.balance(access), wallet: deps.wallet.name };
  }

  // -------------------------------------------------------------- agent mandates

  /**
   * A buyer lets an agent spend for them: a per-job limit, a total limit, and
   * (with PayPal) a saved PayPal wallet approved once through Vault.
   */
  async function createMandate(access: string, origin: string, input: { label?: string; perJobCents: number; totalCents: number }) {
    const perJob = Math.round(Number(input.perJobCents)); const total = Math.round(Number(input.totalCents));
    if (!(perJob >= 5 && perJob <= 2000)) fail(400, 'Set a per-job limit between $0.05 and $20.');
    if (!(total >= perJob && total <= 10_000)) fail(400, 'Set a total limit between the per-job limit and $100.');
    if (total > config.accessCodes[access]!) fail(400, 'The total limit is more than this account may spend.');
    if (!newMandates.check(access)) fail(429, 'Too many new agents; wait a minute.');
    const id = newId('mandate');
    const label = String(input.label ?? '').replace(/[^\w .,'-]/g, '').trim().slice(0, 40) || 'My agent';
    db.prepare("INSERT INTO mandates (id, access, status, label, per_job_cents, total_cents, created) VALUES (?, ?, 'pending', ?, ?, ?, ?)")
      .run(id, access, label, perJob, total, now());
    if (!(deps.wallet instanceof PayPalWallet) || !deps.paypal) {
      // Demo wallet: nothing to save at PayPal; the mandate is active at once.
      db.prepare("UPDATE mandates SET status = 'active', activated = ? WHERE id = ?").run(now(), id);
      return { id, approveUrl: null };
    }
    try {
      const st = await deps.paypal.createSetupToken(`${origin}/api/mandates/${id}/return`, `${origin}/?mandate=cancelled`, id);
      db.prepare('UPDATE mandates SET setup_token = ? WHERE id = ?').run(st.id, id);
      return { id, approveUrl: st.approveUrl };
    } catch (e) { return holdError(e); }
  }

  /** PayPal sent the buyer back: turn the approved setup token into a saved wallet. */
  async function completeMandate(id: string) {
    const m = db.prepare("SELECT id, setup_token, status FROM mandates WHERE id = ?").get(id) as { id: string; setup_token: string | null; status: string } | undefined;
    if (!m || !m.setup_token) fail(404, 'No such agent mandate.');
    if (m!.status === 'active') return { id };
    try {
      const token = await deps.paypal!.createPaymentToken(m!.setup_token!);
      db.prepare("UPDATE mandates SET status = 'active', vault_id = ?, payer_email = ?, activated = ? WHERE id = ?").run(token.vaultId, token.email ?? null, now(), id);
      return { id };
    } catch (e) { return holdError(e); }
  }

  /** The agent key is shown once, right after activation; only its hash is kept. */
  function revealKey(access: string, id: string) {
    const m = db.prepare('SELECT * FROM mandates WHERE id = ? AND access = ?').get(id, access) as (Mandate & { key_hash: string | null }) | undefined;
    if (!m) fail(404, 'No such agent mandate.');
    if (m!.status !== 'active') fail(409, 'Finish saving PayPal first.');
    if (m!.key_hash) fail(409, 'The key for this mandate was already shown. Revoke it and make a new one if it is lost.');
    const key = `adk_${crypto.randomBytes(24).toString('base64url')}`;
    db.prepare('UPDATE mandates SET key_hash = ?, key_hint = ? WHERE id = ?').run(hashKey(key), key.slice(-4), id);
    return { key };
  }

  function mandateByKey(key: string): Mandate | null {
    if (!/^adk_[\w-]{20,}$/.test(key)) return null;
    const m = db.prepare("SELECT * FROM mandates WHERE key_hash = ? AND status = 'active'").get(hashKey(key)) as Mandate | undefined;
    return m && config.accessCodes[m.access] ? m : null;
  }

  /** Total limit minus what the agent's jobs captured and still hold. */
  function mandateRemaining(m: Mandate): number {
    const row = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN l.type = 'capture' THEN l.cents END), 0) - COALESCE(SUM(CASE WHEN l.type = 'refund' THEN l.cents END), 0) AS spent,
        COALESCE(SUM(CASE WHEN l.type = 'hold' THEN l.cents END), 0) - COALESCE(SUM(CASE WHEN l.type IN ('capture','release') THEN l.cents END), 0) AS open
      FROM ledger l JOIN jobs j ON j.id = l.job_id WHERE j.mandate_id = ?`).get(m.id) as { spent: number; open: number };
    return Math.max(0, m.total_cents - row.spent - row.open - pendingCents('mandate_id', m.id));
  }

  function mandates(access: string) {
    const rows = db.prepare('SELECT * FROM mandates WHERE access = ? AND status != \'revoked\' ORDER BY created DESC').all(access) as unknown as (Mandate & { key_hash: string | null })[];
    return rows.map((m) => ({ id: m.id, label: m.label, status: m.status, perJobCents: m.per_job_cents, totalCents: m.total_cents, remainingCents: mandateRemaining(m), payer: m.payer_email, keyShown: Boolean(m.key_hash), keyHint: m.key_hint }));
  }

  function revokeMandate(access: string, id: string) {
    const r = db.prepare("UPDATE mandates SET status = 'revoked' WHERE id = ? AND access = ?").run(id, access);
    if (!r.changes) fail(404, 'No such agent mandate.');
    return { ok: true };
  }

  /** An agent buys a quote with its mandate: limits first, then a PayPal hold on the saved wallet, no popup. */
  async function buyWithMandate(m: Mandate, quoteId: string, ip: string | null = null) {
    const q = openQuote(m.access, quoteId);
    if (!checkouts.check(m.access)) fail(429, 'Too many payment attempts; wait a minute.');
    gateNewJob(m.access, q);
    if (q.total_cents > m.per_job_cents) fail(402, `That quote is ${q.total_cents}¢; this agent may spend at most ${m.per_job_cents}¢ per job.`);
    const remaining = mandateRemaining(m);
    if (q.total_cents > remaining) fail(402, `That quote is ${q.total_cents}¢; this agent has ${remaining}¢ left of its ${m.total_cents}¢ budget.`);
    const { jobId, planned } = createJob(m.access, q, 'authorizing', m.id);
    try {
      const { holdId } = await deps.wallet.hold(m.access, jobId, q.total_cents, `${planned.summary} (agent: ${m.label})`, m.vault_id ? { vaultId: m.vault_id } : {});
      start(m.access, jobId, q, holdId, ip);
      return { id: jobId, heldCents: q.total_cents, holdId, remainingCents: remaining - q.total_cents };
    } catch (e) { abandon(jobId, q.id); return holdError(e); }
  }

  return { addText, addUpload, quote, checkout, approve, cancel, job, output, ledger, createMandate, completeMandate, revealKey, mandateByKey, mandateRemaining, mandates, revokeMandate, buyWithMandate, recover };
}

export type Desk = ReturnType<typeof createDesk>;
