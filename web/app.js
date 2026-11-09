// Agent Desk page. All text goes in with textContent; nothing from the server is parsed as HTML.
const $ = (id) => document.getElementById(id);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k) n.append(k);
  return n;
};

const state = { token: '', attachments: [], quote: null, jobId: null, timer: null, paypal: null, sdk: null };
try { state.token = sessionStorage.getItem('desk-session') || ''; } catch { /* private mode */ }
const authHeaders = () => (state.token ? { authorization: `Bearer ${state.token}` } : {});

async function api(path, { method = 'GET', json, form } = {}) {
  const headers = authHeaders();
  let body;
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(path, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status, data });
  return data;
}

function say(node, text, err = false) { node.textContent = text; node.classList.toggle('err', err); }
function setBalance(cents, wallet) {
  $('balance').textContent = money(cents);
  if (wallet) $('walletName').textContent = wallet === 'demo' ? 'demo wallet' : wallet;
}

// ------------------------------------------------------------------ PayPal

/** Load PayPal's JS SDK once, in authorize mode (approval = a hold, not a charge). */
function loadPayPal() {
  if (state.sdk) return state.sdk;
  const p = state.paypal;
  state.sdk = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(p.clientId)}&currency=${encodeURIComponent(p.currency)}&intent=authorize&components=buttons&disable-funding=card,credit,paylater,venmo`;
    const nonce = document.querySelector('meta[name="csp-nonce"]')?.content;
    if (nonce) { s.nonce = nonce; s.setAttribute('data-csp-nonce', nonce); }
    s.onload = () => resolve(window.paypal);
    s.onerror = () => reject(new Error('PayPal could not load.'));
    document.head.append(s);
  });
  return state.sdk;
}

fetch('/api/config').then((r) => r.json()).then((c) => { state.paypal = c.paypal; if (state.paypal) loadPayPal().catch(() => {}); }).catch(() => {});

function startedJob(job) {
  state.jobId = job.id;
  say($('quoteMsg'), `${money(job.heldCents)} held. Running…`);
  $('job').hidden = false;
  $('job').scrollIntoView({ behavior: 'smooth', block: 'start' });
  poll();
}

async function renderPayPal(quote) {
  $('holdBtn').hidden = true;
  $('paypalBox').hidden = false;
  $('paypalButtons').replaceChildren();
  let job = null;
  try {
    const pp = await loadPayPal();
    await pp.Buttons({
      style: { layout: 'vertical', label: 'pay', height: 45 },
      createOrder: async () => {
        job = await api('/api/jobs', { method: 'POST', json: { quoteId: quote.id } });
        return job.orderId;
      },
      onApprove: async (data) => {
        say($('quoteMsg'), 'Approved. Placing the PayPal hold…');
        await api(`/api/jobs/${job.id}/approve`, { method: 'POST', json: { orderId: data.orderID } });
        $('paypalBox').hidden = true;
        startedJob(job);
      },
      onCancel: async () => {
        if (job) await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {});
        say($('quoteMsg'), 'Payment cancelled. Nothing was held.');
      },
      onError: (err) => say($('quoteMsg'), (err && err.message) || 'PayPal could not complete the payment.', true),
    }).render('#paypalButtons');
  } catch (e) { say($('quoteMsg'), e.message, true); }
}

// ------------------------------------------------------------------ sign in

function setToken(token) {
  state.token = token;
  try { if (token) sessionStorage.setItem('desk-session', token); else sessionStorage.removeItem('desk-session'); } catch { /* ignore */ }
}

const SIGNED_IN = ['compose', 'agentsCard', 'testLogins'];

/** Show the app once there is a working session; otherwise the sign-in forms. */
async function enter() {
  try {
    const s = await api('/api/session', { method: 'POST' });
    $('authCard').hidden = true; $('wallet').hidden = false;
    for (const id of SIGNED_IN) $(id).hidden = false;
    $('whoami').textContent = s.username || '';
    setBalance(s.balanceCents, s.wallet);
    loadLedger();
    loadMandates();
    loadTestLogins();
    finishMandateReturn();
  } catch {
    setToken('');
    $('authCard').hidden = false; $('wallet').hidden = true;
  }
}

async function loadTestLogins() {
  const { logins } = await api('/api/test-logins');
  $('testLogins').hidden = logins.length === 0;
  $('testLoginRows').replaceChildren(...logins.map((l) => el('tr', {}, el('td', { text: l.email }), el('td', { text: l.password }))));
}

async function authForm(btn, path, body) {
  btn.disabled = true;
  say($('authMsg'), '');
  try {
    const { token } = await api(path, { method: 'POST', json: body });
    setToken(token);
    await enter();
  } catch (e) { say($('authMsg'), e.message, true); }
  btn.disabled = false;
}

$('signinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  authForm($('signinBtn'), '/api/auth/login', { username: $('siUser').value, password: $('siPass').value });
  $('siPass').value = '';
});
$('registerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  authForm($('registerBtn'), '/api/auth/register', { invite: $('reInvite').value, username: $('reUser').value, password: $('rePass').value });
  $('rePass').value = '';
});
$('showPassword').addEventListener('click', () => { $('passwordCard').hidden = !$('passwordCard').hidden; say($('passwordMsg'), ''); if (!$('passwordCard').hidden) $('passwordCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('passwordBtn').disabled = true;
  try {
    await api('/api/auth/password', { method: 'POST', json: { current: $('pwCurrent').value, next: $('pwNext').value } });
    say($('passwordMsg'), 'Password changed. Your other sessions have been signed out.');
  } catch (err) { say($('passwordMsg'), err.message, true); }
  $('pwCurrent').value = ''; $('pwNext').value = '';
  $('passwordBtn').disabled = false;
});
$('signOut').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  setToken('');
  location.reload();
});
if (state.token) enter(); else $('authCard').hidden = false;

// ------------------------------------------------------------------ compose

const EXAMPLES = [
  'Read this aloud in a British voice',
  'Transcribe this recording and translate it to Vietnamese',
  'Remove the background from this photo',
  'Translate this Chinese note to English and read it out',
];
for (const ex of EXAMPLES) {
  const b = el('button', { type: 'button', text: ex });
  b.addEventListener('click', () => { $('request').value = ex; $('request').focus(); });
  $('examples').append(b);
}

$('addText').addEventListener('click', () => { $('textBox').hidden = !$('textBox').hidden; if (!$('textBox').hidden) $('text').focus(); });

function renderAttachments() {
  const list = $('attachments');
  list.replaceChildren(...state.attachments.map((a, i) => {
    const size = a.kind === 'text' ? `${a.chars} chars` : a.kind === 'audio' ? `${a.minutes.toFixed(1)} min` : 'image';
    const rm = el('button', { type: 'button', 'aria-label': `Remove ${a.name}`, text: '✕' });
    rm.addEventListener('click', () => { state.attachments.splice(i, 1); renderAttachments(); });
    return el('li', {}, el('span', { text: `${i + 1}. ${a.kind}: ${a.name} (${size})` }), rm);
  }));
}

$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f) return;
  say($('composeMsg'), `Uploading ${f.name}…`);
  const form = new FormData(); form.set('file', f, f.name);
  try {
    state.attachments.push(await api('/api/files', { method: 'POST', form }));
    renderAttachments(); say($('composeMsg'), '');
  } catch (e) { say($('composeMsg'), e.message, true); }
  $('file').value = '';
});

$('requestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('quoteBtn'); btn.disabled = true;
  try {
    const text = $('text').value.trim();
    if (text && !$('textBox').hidden) {
      state.attachments.push(await api('/api/files', { method: 'POST', json: { text } }));
      $('text').value = ''; $('textBox').hidden = true; renderAttachments();
    }
    say($('composeMsg'), 'Checking the request and planning…');
    const q = await api('/api/quote', { method: 'POST', json: { request: $('request').value, files: state.attachments.map((a) => a.id) } });
    state.quote = q;
    renderQuote(q);
    say($('composeMsg'), '');
  } catch (err) {
    say($('composeMsg'), err.message, true);
  } finally { btn.disabled = false; }
});

// ------------------------------------------------------------------ quote

function renderQuote(q) {
  $('quote').hidden = false;
  $('quoteSummary').textContent = q.summary;
  $('quoteSteps').replaceChildren(...q.steps.map((s) => el('tr', {},
    el('td', { text: String(s.index + 1) }),
    el('td', { text: s.title + (s.params.target ? ` (${s.params.source}→${s.params.target})` : '') }),
    el('td', { class: 'muted', text: s.check }),
    el('td', { class: 'num', text: money(s.cents) }),
  )));
  $('quoteTotal').textContent = money(q.totalCents);
  $('holdBtn').textContent = `Hold ${money(q.totalCents)} and run`;
  $('holdBtn').disabled = false;
  $('holdBtn').hidden = false;
  $('paypalBox').hidden = true;
  if (state.paypal) renderPayPal(q);
  say($('quoteMsg'), `Balance after the hold: ${money(q.balanceCents - q.totalCents)}. Nothing is captured until a step passes inspection.`);
  $('quote').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('holdBtn').addEventListener('click', async () => {
  if (!state.quote) return;
  $('holdBtn').disabled = true;
  try {
    startedJob(await api('/api/jobs', { method: 'POST', json: { quoteId: state.quote.id } }));
  } catch (e) { say($('quoteMsg'), e.message, true); $('holdBtn').disabled = false; }
});

// ------------------------------------------------------------------ job

const shown = new Set();
async function showOutput(slot, jobId, s) {
  const key = `${jobId}/${s.idx}`;
  if (shown.has(key)) return;
  shown.add(key);
  const res = await fetch(`/api/jobs/${jobId}/steps/${s.idx}/output`, { headers: authHeaders() });
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (s.output_kind === 'audio') slot.append(el('audio', { controls: '', src: url }));
  else if (s.output_kind === 'image') slot.append(el('img', { src: url, alt: 'Result image' }));
  else slot.append(el('pre', { text: await blob.text() }));
  slot.append(el('a', { href: url, download: `step-${s.idx + 1}.${s.output_kind === 'audio' ? 'wav' : s.output_kind === 'image' ? 'png' : 'txt'}`, text: 'Download' }));
}

const slots = new Map();
function renderJob(j) {
  const list = $('jobSteps');
  if (list.dataset.job !== j.id) { list.replaceChildren(); slots.clear(); list.dataset.job = j.id; }
  for (const s of j.steps) {
    let li = slots.get(s.idx);
    if (!li) {
      li = el('li', {},
        el('div', { class: 'head' }, el('strong', { text: `${s.idx + 1}. ${s.title}` }), el('span', { class: 'pill' })),
        el('ul', { class: 'evidence' }),
        el('div', { class: 'out' }));
      slots.set(s.idx, li); list.append(li);
    }
    const pill = li.querySelector('.pill');
    const charge = s.status === 'passed' ? ` · captured ${money(s.cents)}` : (s.status === 'failed' || s.status === 'skipped') ? ` · ${money(s.cents)} released` : ` · ${money(s.cents)} held`;
    pill.textContent = s.status + charge;
    pill.className = `pill st-${s.status}`;
    li.querySelector('.evidence').replaceChildren(...(s.verdict?.evidence ?? []).map((t) => el('li', { text: t })));
  }
  const done = !['held', 'running', 'authorizing', 'awaiting payment'].includes(j.status);
  // Outputs are delivered once PayPal has settled the job.
  if (done) for (const s of j.steps) if (s.status === 'passed') showOutput(slots.get(s.idx).querySelector('.out'), j.id, s);
  $('held').textContent = money(j.heldCents);
  $('captured').textContent = done ? money(j.capturedCents) : '…';
  $('released').textContent = done ? money(j.releasedCents) : '…';
  $('jobStatus').textContent = j.status;
  $('paypalRefs').textContent = j.paypal
    ? `PayPal order ${j.paypal.orderId} · authorization ${j.paypal.authorizationId || '…'}${j.paypal.captureId ? ` · capture ${j.paypal.captureId}` : done ? ' · voided' : ''}`
    : '';
  setBalance(j.balanceCents);
  return done;
}

async function poll() {
  clearTimeout(state.timer);
  try {
    const j = await api(`/api/jobs/${state.jobId}`);
    if (renderJob(j)) { loadLedger(); return; }
  } catch (e) { say($('quoteMsg'), e.message, true); }
  state.timer = setTimeout(poll, 1500);
}

// ------------------------------------------------------------------ ledger

let gridApi = null;
let gridLoading = null;

function loadGridScript() {
  gridLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/ag-grid.js';
    s.onload = () => resolve(window.agGrid);
    s.onerror = () => reject(new Error('The ledger grid could not load.'));
    document.head.append(s);
  });
  return gridLoading;
}


/** One pinned row: what was held, captured and released in total. */
function ledgerTotals(entries) {
  const sum = (t) => entries.filter((r) => r.type === t).reduce((a, r) => a + r.cents, 0);
  return [{ buyer: 'Totals', type: 'captured', cents: sum('capture'), memo: `Held ${money(sum('hold'))}, released ${money(sum('release'))}` }];
}

async function renderLedger(entries) {
  const agGrid = await loadGridScript();
  if (gridApi) {
    gridApi.setGridOption('rowData', entries);
    gridApi.setGridOption('pinnedBottomRowData', ledgerTotals(entries));
    return;
  }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  gridApi = agGrid.createGrid($('ledgerGrid'), {
    theme: agGrid.themeQuartz.withPart(dark ? agGrid.colorSchemeDark : agGrid.colorSchemeLight),
    rowData: entries,
    pinnedBottomRowData: ledgerTotals(entries),
    defaultColDef: { sortable: true, filter: true, resizable: true },
    columnDefs: [
      { field: 'at', headerName: 'Time', sort: 'desc', width: 130, valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleTimeString() : '') },
      { field: 'buyer', headerName: 'Buyer', width: 130 },
      { field: 'type', headerName: 'Entry', width: 120 },
      { field: 'cents', headerName: 'Amount', width: 110, type: 'rightAligned', filter: 'agNumberColumnFilter', valueFormatter: (p) => (p.value == null ? '' : money(p.value)) },
      { field: 'ref', headerName: 'PayPal ID', width: 200 },
      { field: 'job_status', headerName: 'Job', width: 140 },
      { field: 'memo', headerName: 'Note', flex: 1, minWidth: 220 },
    ],
  });
}

$('exportCsv').addEventListener('click', () => gridApi?.exportDataAsCsv({ fileName: 'agent-desk-ledger.csv' }));

async function loadLedger() {
  try {
    const l = await api('/api/ledger');
    setBalance(l.balanceCents, l.wallet);
    $('ledgerCard').hidden = l.entries.length === 0;
    if (l.entries.length) await renderLedger(l.entries);
  } catch { /* signed out, or the grid could not load */ }
}

// ------------------------------------------------------------------ agents

async function loadMandates() {
  $('agentsCard').hidden = false;
  try {
    const { mandates } = await api('/api/mandates');
    $('mandates').replaceChildren(...mandates.map((m) => {
      const revoke = el('button', { type: 'button', text: 'Revoke' });
      revoke.addEventListener('click', async () => { await api(`/api/mandates/${m.id}/revoke`, { method: 'POST' }).catch(() => {}); loadMandates(); });
      const who = m.payer ? ` · PayPal ${m.payer}` : '';
      const key = m.keyHint ? ` · key …${m.keyHint}` : '';
      return el('li', {}, el('span', { text: `${m.label}: ${money(m.remainingCents)} left of ${money(m.totalCents)}, up to ${money(m.perJobCents)} a job${who}${key} (${m.status})` }), revoke);
    }));
  } catch { /* signed out */ }
}

$('mandateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('mandateBtn').disabled = true;
  try {
    const m = await api('/api/mandates', { method: 'POST', json: {
      label: $('mLabel').value, perJobCents: Math.round(Number($('mPerJob').value) * 100), totalCents: Math.round(Number($('mTotal').value) * 100),
    } });
    if (m.approveUrl) {
      say($('mandateMsg'), 'Opening PayPal to save your wallet for this agent…');
      window.location.assign(m.approveUrl);
      return;
    }
    await showKey(m.id);
  } catch (err) { say($('mandateMsg'), err.message, true); }
  $('mandateBtn').disabled = false;
});

async function showKey(id) {
  const { key } = await api(`/api/mandates/${encodeURIComponent(id)}/key`, { method: 'POST' });
  const url = `${location.origin}/mcp`;
  $('agentKey').textContent = key;
  $('mcpUrl').textContent = url;
  $('mcpCmd').textContent = `claude mcp add --transport http agent-desk ${url} --header "Authorization: Bearer ${key}"`;
  $('keyBox').hidden = false;
  say($('mandateMsg'), 'PayPal saved. Your agent can now buy within its limits.');
  loadMandates();
}

/** Back from PayPal: ?mandate=<id> means the wallet was saved; show the key once. */
async function finishMandateReturn() {
  const id = new URLSearchParams(location.search).get('mandate');
  if (!id) return;
  history.replaceState(null, '', location.pathname);
  if (id === 'cancelled') return say($('mandateMsg'), 'Saving PayPal was cancelled. Nothing was saved.');
  if (id === 'failed') return say($('mandateMsg'), 'PayPal did not save the wallet. Try again.', true);
  $('agentsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try { await showKey(id); } catch (err) { say($('mandateMsg'), err.message, true); }
}
