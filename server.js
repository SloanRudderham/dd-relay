require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { io } = require('socket.io-client');

const app = express();
// In production, restrict to your Lovable domain:
// app.use(cors({ origin: ['https://YOUR-LOVABLE-DOMAIN'] }));
app.use(cors());
app.use(express.json());

const SERVER = process.env.TL_SERVER || 'wss://api.tradelocker.com';
const TYPE   = process.env.TL_ENV || 'LIVE';
const KEY    = process.env.TL_BRAND_KEY;
const PORT   = Number(process.env.PORT || 8080);
if (!KEY) { console.error('Missing TL_BRAND_KEY'); process.exit(1); }

// ---- state ----
// id -> { hwm, equity, maxDD, currency, updatedAt, balance? }
const state = new Map();
const subscribers = new Set();         // { res, filter:Set<string>, id, ping }
const num = (x)=>{ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };

// Try to read "balance" from common keys in the stream payload
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

// ---- TL BrandSocket ----
function updateAccount(m){
  const id = m.accountId;
  const eq = num(m.equity);
  const cur = m.currency || 'USD';
  const now = Date.now();

  if (!state.has(id)) {
    state.set(id, {
      hwm: eq,
      equity: eq,
      maxDD: 0,
      currency: cur,
      updatedAt: now,
      balance: NaN,               // NEW: keep last seen balance
    });
  }
  const s = state.get(id);

  // capture balance if present in this message
  const bal = parseBalance(m);
  if (Number.isFinite(bal)) s.balance = bal;

  // lift HWM on new highs (classic drawdown baseline)
  if (eq > s.hwm) s.hwm = eq;

  s.equity = eq;
  s.currency = cur;
  s.updatedAt = now;

  // classic DD (never negative)
  const dd = s.hwm > 0 ? (s.hwm - s.equity)/s.hwm : 0;
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

// ---- helpers ----
function parseAccountsParam(q){
  if (Array.isArray(q)) q = q.join(',');
  const raw = String(q || '').split(',').map(s=>s.trim()).filter(Boolean);
  return new Set(raw);
}
function buildPayload(id){
  const s = state.get(id);
  if (!s) return null;

  // classic drawdown (from HWM)
  const dd = s.hwm > 0 ? (s.hwm - s.equity)/s.hwm : 0;

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
    dd,                                            // fraction 0..1
    ddPct: Number((dd*100).toFixed(2)),            // classic drawdown %
    maxDDPct: Number((s.maxDD*100).toFixed(2)),
    balance: Number.isFinite(s.balance) ? Number(s.balance.toFixed(2)) : null,
    instPct: instPct !== null ? Number(instPct.toFixed(2)) : null, // simple signed % vs balance
    currency: s.currency,
    updatedAt: s.updatedAt
  };
}
function pushToSubscribers(accountId){
  const payload = buildPayload(accountId);
  if (!payload) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const sub of subscribers){
    if (sub.filter.size && !sub.filter.has(accountId)) continue;
    sub.res.write(line);
  }
}

// ---- routes ----
// SSE stream (push)
app.get('/dd/stream', (req, res) => {
  const filter = parseAccountsParam(req.query.accounts || req.query['accounts[]']);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = { res, filter, id: Math.random().toString(36).slice(2), ping: null };
  sub.ping = setInterval(() => res.write(': ping\n\n'), 25000);   // heartbeat
  subscribers.add(sub);

  // initial snapshot
  const ids = filter.size ? Array.from(filter) : Array.from(state.keys());
  for (const id of ids){
    const p = buildPayload(id);
    if (p) res.write(`data: ${JSON.stringify({ ...p, initial:true })}\n\n`);
  }

  req.on('close', () => { clearInterval(sub.ping); subscribers.delete(sub); });
});

// Snapshot (polling)
app.get('/dd/state', (req,res) => {
  const filter = parseAccountsParam(req.query.accounts || req.query['accounts[]']);
  const out = [];
  for (const [id] of state.entries()){
    if (filter.size && !filter.has(id)) continue;
    const p = buildPayload(id); if (p) out.push(p);
  }
  out.sort((a,b)=> b.equity - a.equity);
  res.json({ env: TYPE, count: out.length, accounts: out });
});

// Optional: seed balances at runtime if your stream doesn't include them
app.post('/dd/balanceSeed', (req, res) => {
  const payload = req.body; // { "L#526977": 480, "L#527161": 400 } OR {seeds:[{accountId,hwm}]}
  let updates = [];
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [accountId, bal] of Object.entries(payload)) {
      if (!Number.isFinite(Number(bal))) continue;
      const s = state.get(accountId) || { hwm:Number(bal), equity:Number(bal), maxDD:0, currency:'USD', updatedAt:Date.now(), balance:Number(bal) };
      s.balance = Number(bal);
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
