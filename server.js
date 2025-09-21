// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { io } = require('socket.io-client');

const app = express();
// In prod you can lock CORS to your Lovable domain:
// app.use(cors({ origin: ['https://YOUR-LOVABLE-DOMAIN'] }));
app.use(cors());
app.use(express.json());

// ---------- Config ----------
const SERVER = process.env.TL_SERVER || 'wss://api.tradelocker.com';
const TYPE   = process.env.TL_ENV    || 'LIVE'; // LIVE or DEMO
const KEY    = process.env.TL_BRAND_KEY;
const PORT   = Number(process.env.PORT || 8080);

const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 1000);  // SSE keep-alive comment
const REFRESH_MS   = Number(process.env.REFRESH_MS   || 5000);  // periodic snapshot push
const STALE_MS     = Number(process.env.STALE_MS     || 120000); // watchdog: disconnected & stale

const SELECT_TTL_MS = Number(process.env.SELECT_TTL_MS || 10 * 60 * 1000);
const READ_TOKEN    = process.env.READ_TOKEN || ''; // optional read protection

if (!KEY) { console.error('Missing TL_BRAND_KEY'); process.exit(1); }

if (TYPE === 'LIVE' && /api-dev/.test(SERVER)) {
  console.warn('[Config] TL_ENV=LIVE but TL_SERVER looks like DEV:', SERVER);
}
if (TYPE !== 'LIVE' && /api\.tradelocker\.com/.test(SERVER)) {
  console.warn('[Config] TL_ENV!=LIVE but TL_SERVER is LIVE:', SERVER);
}

// ---------- State ----------
// Account snapshot: id -> { hwm, equity, maxDD, currency, updatedAt, balance? }
const state = new Map();
// SSE subscribers for drawdown stream
const subscribers = new Set(); // { res, filter:Set<string>, id, ping, refresh }
// Selection tokens: token -> { set:Set<string>, expiresAt:number }
const selections = new Map();
// Raw TL event subscribers
const eventSubs = new Set();   // { res, filter:Set<string>, ping }

// Positions caches
const openPos   = new Map(); // accountId -> Map(positionId -> pos)
const closedPos = new Map(); // accountId -> Array<pos>

const num = (x)=>{ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };

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

// ---------- TradeLocker BrandSocket ----------
let lastBrandEventAt = 0;
let lastConnectError = '';

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

function updateAccount(m){
  const id  = m.accountId;
  const eq  = num(m.equity);
  const cur = m.currency || 'USD';
  const now = Date.now();

  if (!state.has(id)) {
    state.set(id, {
      hwm: eq, equity: eq, maxDD: 0,
      currency: cur, updatedAt: now,
      balance: NaN
    });
  }
  const s = state.get(id);

  const bal = parseBalance(m);
  if (Number.isFinite(bal)) s.balance = bal;

  if (eq > s.hwm) s.hwm = eq;      // raise HWM on new highs
  s.equity = eq;
  s.currency = cur;
  s.updatedAt = now;

  const dd = s.hwm > 0 ? (s.hwm - s.equity) / s.hwm : 0; // 0..1
  if (dd > s.maxDD) s.maxDD = dd;

  pushToSubscribers(id);
}

// ---- Positions helpers ----
function getMap(map, key){
  let v = map.get(key); if (!v) { v = new Map(); map.set(key, v); }
  return v;
}
function getArr(map, key){
  let v = map.get(key); if (!v) { v = []; map.set(key, v); }
  return v;
}
function normalizePos(m){
  const accountId  = m.accountId || m.account?.id || m.accId || m.accountID;
  const positionId = m.positionId || m.id || m.position?.id || m.posId;
  const symbol     = m.symbol || m.instrument || m.symbolName;
  const volumeRaw  = m.volume ?? m.qty ?? m.quantity ?? 0;
  const volume     = Number(volumeRaw);
  const side       = m.side || m.direction || (volume < 0 ? 'SELL' : 'BUY');
  const openPrice  = Number(m.openPrice ?? m.entryPrice ?? m.priceOpen ?? m.avgPrice ?? 0);
  const closePrice = Number(m.closePrice ?? m.exitPrice ?? m.priceClose ?? 0);
  const uPnL       = Number(m.unrealizedPnL ?? m.upnl ?? 0);
  const rPnL       = Number(m.realizedPnL   ?? m.rpnl ?? m.pnl ?? 0);
  const openTime   = Number(m.openTime ?? m.timeOpen ?? m.createdAt ?? m.time ?? Date.now());
  const closeTime  = Number(m.closeTime ?? m.timeClose ?? m.closedTime ?? 0);
  const statusRaw  = (m.status || m.state || '').toString().toUpperCase();
  const status     = closeTime || /CLOSE|CLOSED|EXIT|FILLED/.test(statusRaw) ? 'CLOSED' : 'OPEN';
  return { accountId, positionId, symbol, volume, side, openPrice, openTime, closePrice, closeTime, uPnL, rPnL, status, serverTime: Date.now() };
}
function pushPositionsUpdate(accountId){
  const lineFor = (sub)=>{
    if (sub.filter.size && !sub.filter.has(accountId)) return null;
    const snap = buildPositionsSnapshot(sub.filter);
    return `event: positions\ndata: ${JSON.stringify(snap)}\n\n`;
  };
  for (const sub of posSubs){
    const line = lineFor(sub);
    if (line) sub.res.write(line);
  }
}
function processPositionEvent(m){
  const p = normalizePos(m);
  if (!p.accountId || !p.positionId) return;

  if (p.status === 'CLOSED') {
    const openMap = getMap(openPos, p.accountId);
    openMap.delete(p.positionId);
    const arr = getArr(closedPos, p.accountId);
    arr.unshift(p);
    if (arr.length > 200) arr.length = 200; // cap memory per account
    pushPositionsUpdate(p.accountId);
  } else {
    const openMap = getMap(openPos, p.accountId);
    const prev = openMap.get(p.positionId) || {};
    openMap.set(p.positionId, { ...prev, ...p });
    pushPositionsUpdate(p.accountId);
  }
}

// ---- Socket init ----
const socket = io(SERVER + '/brand-socket', {
  path: '/brand-api/socket.io',
  transports: ['websocket', 'polling'], // allow polling in handshake to avoid 400s
  query: { type: TYPE },
  extraHeaders: { 'brand-api-key': KEY },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  randomizationFactor: 0.5,
  timeout: 20000,
  forceNew: true,
});

socket.on('connect', () => {
  console.log('[BrandSocket] connected', socket.id);
  lastConnectError = '';
});
socket.on('disconnect', (reason) => console.warn('[BrandSocket] disconnected', reason));
socket.on('connect_error', (err) => {
  lastConnectError = (err && (err.message || String(err))) || 'connect_error';
  console.error('[BrandSocket] connect_error', lastConnectError, {
    description: err?.description, context: err?.context, data: err?.data
  });
});
socket.on('reconnect_attempt', (n) => console.log('[BrandSocket] reconnect_attempt', n));
socket.on('reconnect', (n) => console.log('[BrandSocket] reconnected', n));
socket.on('error', (e) => console.error('[BrandSocket] error', e));

socket.on('stream', (m) => {
  lastBrandEventAt = Date.now();
  if (m?.type === 'AccountStatus') updateAccount(m);
  else {
    // pass-through for debugging/consumption
    broadcastEvent(m);
    // best-effort: route position-like messages
    const t = (m?.type || '').toString().toUpperCase();
    if (t.includes('POSITION') || t.includes('DEAL') || t.includes('FILL') || t.includes('ORDER')) {
      processPositionEvent(m);
    }
  }
});

// Watchdog: only restart if DISCONNECTED and stale (won't flap when markets are quiet)
setInterval(() => {
  if (!STALE_MS) return;
  if (!socket.connected) {
    const age = Date.now() - (lastBrandEventAt || 0);
    if (age > STALE_MS) {
      console.warn('[Watchdog] Disconnected & stale for', age, 'ms. Exiting for Render to restart.');
      process.exit(1);
    }
  }
}, 30000);

// ---------- Helpers ----------
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

  const dd = s.hwm > 0 ? (s.hwm - s.equity) / s.hwm : 0;

  let instPct = null; // signed % vs balance
  if (Number.isFinite(s.balance) && s.balance > 0) {
    instPct = ((s.equity - s.balance) / s.balance) * 100;
  }

  return {
    type: 'account',
    accountId: id,
    equity: Number(s.equity.toFixed(2)),
    hwm: Number(s.hwm.toFixed(2)),
    dd,
    ddPct: Number((dd * 100).toFixed(2)),
    maxDDPct: Number((s.maxDD * 100).toFixed(2)),
    balance: Number.isFinite(s.balance) ? Number(s.balance.toFixed(2)) : null,
    instPct: instPct !== null ? Number(instPct.toFixed(2)) : null,
    currency: s.currency,
    updatedAt: s.updatedAt,
    serverTime: Date.now(),
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
function broadcastEvent(m){
  const acct = m.accountId || m.account?.id || m.accId || '';
  const line = `data: ${JSON.stringify(m)}\n\n`;
  for (const sub of eventSubs){
    if (sub.filter?.size && acct && !sub.filter.has(acct)) continue;
    sub.res.write(line);
  }
}

function buildPositionsSnapshot(filter){
  const out = { serverTime: Date.now(), open: [], closed: [] };
  const want = (id)=> !filter.size || filter.has(id);

  for (const [acc, map] of openPos.entries()){
    if (!want(acc)) continue;
    for (const p of map.values()) out.open.push(p);
  }
  for (const [acc, arr] of closedPos.entries()){
    if (!want(acc)) continue;
    out.closed.push(...arr);
  }
  return out;
}

// ---------- Routes ----------

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

// SSE: drawdown stream (supports &batch=1)
app.get('/dd/stream', (req, res) => {
  if (!checkToken(req, res)) return;

  const selSet   = getSelectionFromToken(req.query.sel);
  const paramSet = parseAccountsParam(req.query.accounts || req.query['accounts[]']);
  const filter   = selSet ? selSet : paramSet; // prefer selection token if provided
  const batchMode= req.query.batch === '1';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = { res, filter, id: Math.random().toString(36).slice(2), ping: null, refresh: null };

  // 1) Heartbeat
  sub.ping = setInterval(() => res.write(':\n\n'), HEARTBEAT_MS);

  // 2) Periodic snapshot
  const sendSnapshot = () => {
    const ids = filter.size ? Array.from(filter) : Array.from(state.keys());
    if (batchMode) {
      const arr = [];
      for (const id of ids) { const p = buildPayload(id); if (p) arr.push(p); }
      res.write(`event: batch\ndata: ${JSON.stringify({ serverTime: Date.now(), accounts: arr })}\n\n`);
    } else {
      for (const id of ids){
        const p = buildPayload(id);
        if (p) writePayload(res, p);
      }
    }
  };
  if (REFRESH_MS > 0) sub.refresh = setInterval(sendSnapshot, REFRESH_MS);

  subscribers.add(sub);
  sendSnapshot(); // initial

  req.on('close', () => {
    if (sub.ping)    clearInterval(sub.ping);
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

// Coverage (which selected IDs are missing in the current in-memory state)
app.get('/dd/coverage', (req, res) => {
  if (!checkToken(req, res)) return;
  const selSet = getSelectionFromToken(req.query.sel);
  if (!selSet) return res.status(400).json({ ok:false, error:'bad or expired selection token' });

  const expected = selSet.size;
  let present = 0;
  const missing = [];
  for (const id of selSet) {
    if (state.has(id)) present++;
    else missing.push(id);
  }
  res.json({
    ok: true,
    env: TYPE,
    connected: socket.connected,
    selectionCount: expected,
    present,
    missingCount: missing.length,
    missing,
    knownAccounts: state.size,
    lastBrandEventAt,
    lastConnectError,
    now: Date.now(),
  });
});

// Seed balances at runtime if the stream doesn't include them
// POST body examples: {"L#526977": 480, "L#527161": 400}
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

// Raw TL events (pass-through)
app.get('/events/stream', (req, res) => {
  if (!checkToken(req, res)) return;
  const selSet   = getSelectionFromToken(req.query.sel);
  const paramSet = parseAccountsParam(req.query.accounts || req.query['accounts[]']);
  const filter   = selSet ? selSet : paramSet;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = { res, filter, ping: setInterval(() => res.write(':\n\n'), HEARTBEAT_MS) };
  eventSubs.add(sub);
  req.on('close', () => { clearInterval(sub.ping); eventSubs.delete(sub); });
});

// Positions: live SSE + snapshot
const posSubs = new Set(); // { res, filter:Set<string>, ping }

app.get('/positions/stream', (req, res) => {
  if (!checkToken(req, res)) return;
  const selSet   = getSelectionFromToken(req.query.sel);
  const paramSet = parseAccountsParam(req.query.accounts || req.query['accounts[]']);
  const filter   = selSet ? selSet : paramSet;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = { res, filter, ping: setInterval(()=>res.write(':\n\n'), HEARTBEAT_MS) };
  posSubs.add(sub);

  // initial snapshot
  const snap = buildPositionsSnapshot(filter);
  res.write(`event: positions\ndata: ${JSON.stringify(snap)}\n\n`);

  req.on('close', () => { clearInterval(sub.ping); posSubs.delete(sub); });
});

app.get('/positions/state', (req, res) => {
  if (!checkToken(req, res)) return;
  const selSet   = getSelectionFromToken(req.query.sel);
  const filter   = selSet ? selSet : parseAccountsParam(req.query.accounts || req.query['accounts[]']);
  res.json(buildPositionsSnapshot(filter));
});

// Health + TL link status
app.get('/health', (_req,res)=> res.json({ ok:true, env: TYPE, knownAccounts: state.size }));
app.get('/brand/status', (_req,res)=> res.json({
  env: TYPE,
  server: SERVER,
  connected: socket.connected,
  knownAccounts: state.size,
  lastBrandEventAt,
  lastConnectError,
  now: Date.now(),
}));

// Hardening
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });

// Start
app.listen(PORT, ()=> console.log(`DD relay listening on :${PORT}`));
