require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { io } = require('socket.io-client');

const app = express();
// Lock CORS to your Lovable domain in production if you want:
// app.use(cors({ origin: ['https://YOUR-LOVABLE-DOMAIN'] }));
app.use(cors());
app.use(express.json());

const SERVER = process.env.TL_SERVER || 'wss://api.tradelocker.com';
const TYPE   = process.env.TL_ENV || 'LIVE';
const KEY    = process.env.TL_BRAND_KEY;
const PORT   = Number(process.env.PORT || 8080);

// Intervals (defaults = 1s)
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 1000);  // SSE keepalive comment
const REFRESH_MS   = Number(process.env.REFRESH_MS   || 1000);  // periodic "latest data" push

// Selection tokens (for large account lists)
const SELECT_TTL_MS = Number(process.env.SELECT_TTL_MS || 10 * 60 * 1000); // 10 minutes
const READ_TOKEN    = process.env.READ_TOKEN || ""; // optional read protection

if (!KEY) { console.error('Missing TL_BRAND_KEY'); process.exit(1); }

// ---------------- state ----------------
// id -> { hwm, equity, maxDD, currency, updatedAt, balance? }
const state = new Map();
const subscribers = new Set(); // { res, filter:Set<string>, id, ping, refresh }
const selections = new Map();  // token -> { set:Set<string>, expiresAt:number }

function makeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of selections) if (v.expiresAt <= now) selections.delete(t);
}, 60_000);

function checkToken(req, res){
  if (!READ_TOKEN) return true;
  const provided = String(req.query.token || req.headers['x-read-token'] || '');
  if (provided === READ_TOKEN) return true;
  res.status(401).json({ ok:false, error:'unauthorized' });
  return false;
}

const num = (x)=>{ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };

// try to read "balance" if the stream ever includes it
function parseBalance(m){
  for (const k of ['balance','accountBalance','cash','cashBalance','Balance']) {
    const v = m?.[k];
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return NaN;
}

// --------------- TL BrandSocket ---------------
function updateAccount(m){
  const id  = m.accountId;
  const eq  = num(m.equity);
  const cur = m.currency || 'USD';
  const now = Date.now();

  if (!state.has(id)) {
    state.set(id, {
      hwm: eq,
      equity: eq,
      maxDD: 0,
      currency: cur,
      updatedAt: now,
      balance: NaN
    });
  }
  const s = state.get(id);

  const bal = parseBalance(m);
  if (Number.isFinite(bal)) s.balance = bal;

  if (eq > s.hwm) s.hwm = eq; // raise HWM on new highs

  s.equity = eq;
  s.currency = cur;
  s.updatedAt = now;

  const dd = s.hwm > 0 ? (s.hwm - s.equity) / s.hwm : 0; // 0..1
  if (dd > s.maxDD) s.maxDD = dd;

  pushToSubscribers(id);
}

const socket = io(SERVER + '/brand-socket', {
  path: '/brand-api/socket.io',
  transports: ['websocket'],
  query: { type: TYPE },
  extraHeaders: { 'brand-api-key': KEY }
});
socket.on('connect', () => console.log('[BrandSocket] connected', socket.id));
socket.on('disconnect', (r) => console.log('[BrandSocket] disconnected', r));
socket.on('error', (e) => console.error('[BrandSocket] error', e));
socket.on('stream', (m) => { if (m?.type === 'AccountStatus') updateAccount(m); });

// ---------------- helpers ----------------
function parseAccountsParam(q){
  if (Array.isArray(q)) q = q.join(',');
  const raw = String(q || '').split(',').map(s=>s.trim()).filter(Boolean);
  return new Set(raw);
}
function getSelectionFromToken(selToken){
  if (!selToken) return null;
  const rec = selections.get(String(selToken));
  if (!rec) return null;
  rec.expiresAt = Date.now() + SELECT_TTL_MS; // refresh TTL on use
  return rec.set; // Set<string>
}
function buildPayload(id){
  const s = state.get(id);
  if (!s) return null;

  const dd = s.hwm > 0 ? (s.hwm - s.equity) / s.hwm : 0; // classic DD (>=0)

  // simple signed % vs BALANCE (negative when equity < balance)
  let instPct = null;
  if (Number.isFinite(s.balance) && s.balance > 0) {
    instPct = ((s.equity - s.balance) / s.balance) * 100;
  }

  return {
    type: 'account',
    accountId: id,
    equity: Number(s.equity.toFixed(2)),
    hwm: Number(s.hwm.toFixed(2)),
    dd,                                           // fraction 0..1
    ddPct: Number((dd * 100).toFixed(2)),         // classic drawdown %
    maxDDPct: Number((s.maxDD * 100).toFixed(2)),
    balance: Number.isFinite(s.balance) ? Number(s.balance.toFixed(2)) : null,
    instPct: instPct !== null ? Number(instPct.toFixed(2)) : null, // signed % vs balance
    currency: s.currency,
    updatedAt: s.updatedAt
  };
}
function writePayload(res, payload){
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function pushToSubscribers(accountId){
  const payload = buildPayload(accountId);
  if (!payload) return;
  for (const sub of subscribers){
    if (sub.filter.size && !sub.filter.has(accountId)) continue;
    writePayload(sub.res, payload);
  }
}

// ---------------- routes ----------------

// Register a selection of accounts -> returns a short token
// POST body: { accounts:["L#526977","L#527161", ...] }
app.post('/dd/select', (req, res) => {
  if (!checkToken(req, res)) return;
  const arr = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
  const set = new Set(arr.map(String).map(s=>s.trim()).filter(Boolean));
  if (set.size === 0) return res.status(400).json({ ok:false, error:'no accounts' });
  const token = makeToken();
  selections.set(token, { set, expiresAt: Date.now() + SELECT_TTL_MS });
  res.json({ ok:true, token, count: set.size, ttlMs: SELECT_TTL_MS });
});

// SSE stream (push)
app.get('/dd/stream', (req, res) => {
  if (!checkToken(req, res)) return;

  const selSet  = getSelectionFromToken(req.query.sel);
  const paramSet= parseAccountsParam(req.query.accounts || req.query['accounts[]']);
  const filter  = selSet ? selSet : paramSet; // prefer selection token if provided

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'   // help prevent proxy buffering
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = { res, filter, id: Math.random().toString(36).slice(2), ping: null, refresh: null };

  // 1) Heartbeat every HEARTBEAT_MS (tiny SSE comment)
  sub.ping = setInterval(() => res.write(':\n\n'), HEARTBEAT_MS);

  // 2) Periodic "latest data" push every REFRESH_MS (send current snapshot)
  const sendSnapshot = () => {
    const ids = filter.size ? Array.from(filter) : Array.from(state.keys());
    for (const id of ids){
      const p = buildPayload(id);
      if (p) writePayload(res, p);
    }
  };
  if (REFRESH_MS > 0) sub.refresh = setInterval(sendSnapshot, REFRESH_MS);

  subscribers.add(sub);

  // initial snapshot immediately
  sendSnapshot();

  req.on('close', () => {
    if (sub.ping) clearInterval(sub.ping);
    if (sub.refresh) clearInterval(sub.refresh);
    subscribers.delete(sub);
  });
});

// Snapshot (polling)
app.get('/dd/state', (req,res) => {
  if (!checkToken(req, res)) return;

  const selSet  = getSelectionFromToken(req.query.sel);
  const filter  = selSet ? selSet : parseAccountsParam(req.query.accounts || req.query['accounts[]']);

  const out = [];
  for (const [id] of state.entries()){
    if (filter.size && !filter.has(id)) continue;
    const p = buildPayload(id); if (p) out.push(p);
  }
  out.sort((a,b)=> b.equity - a.equity);
  res.json({ env: TYPE, count: out.length, accounts: out });
});

// Seed balances at runtime if your stream doesn't include them
// POST body examples:
// {"L#526977": 480, "L#527161": 400}
app.post('/dd/balanceSeed', (req, res) => {
  if (!checkToken(req, res)) return;

  const payload = req.body;
  let updates = [];
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [accountId, bal] of Object.entries(payload)) {
      const n = Number(bal);
      if (!Number.isFinite(n)) continue;
      const now = Date.now();
      const s = state.get(accountId) || { hwm:n, equity:n, maxDD:0, currency:'USD', updatedAt:now, balance:n };
      s.balance = n;
      s.updatedAt = now;
      state.set(accountId, s);
      updates.push({ accountId, balance: s.balance });
      pushToSubscribers(accountId);
    }
  }
  if (!updates.length) return res.status(400).json({ ok:false, error:'no valid balances' });
  res.json({ ok:true, updates });
});

app.get('/health', (_req,res)=> res.json({ ok:true, env: TYPE, knownAccounts: state.size }));

app.listen(PORT, ()=> console.log(`DD relay listening on :${PORT}`));
