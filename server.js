// server.js — DD Relay (accounts + open positions)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { io } = require('socket.io-client');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Config ----------
const SERVER = process.env.TL_SERVER || 'wss://api.tradelocker.com';
const TYPE   = process.env.TL_ENV    || 'LIVE'; // LIVE or DEMO
const KEY    = process.env.TL_BRAND_KEY;
const PORT   = Number(process.env.PORT || 8080);

const HEARTBEAT_MS  = Number(process.env.HEARTBEAT_MS || 1000);   // SSE keep-alive
const REFRESH_MS    = Number(process.env.REFRESH_MS   || 5000);   // periodic push
const STALE_MS      = Number(process.env.STALE_MS     || 120000); // watchdog
const SELECT_TTL_MS = Number(process.env.SELECT_TTL_MS || 10 * 60 * 1000);
const READ_TOKEN    = process.env.READ_TOKEN || ''; // optional read protection

if (!KEY) { console.error('Missing TL_BRAND_KEY'); process.exit(1); }

if (TYPE === 'LIVE' && /api-dev/.test(SERVER)) {
  console.warn('[Config] TL_ENV=LIVE but TL_SERVER looks DEV:', SERVER);
}
if (TYPE !== 'LIVE' && /api\.tradelocker\.com/.test(SERVER)) {
  console.warn('[Config] TL_ENV!=LIVE but TL_SERVER is LIVE:', SERVER);
}

// ---------- State ----------
/** accountId -> { hwm, equity, maxDD, currency, updatedAt, balance?, positionPnLs? } */
const state = new Map();

/** accountId -> Map<positionId, positionData> */
const positions = new Map();

/** token -> { set:Set<string>, expiresAt:number } */
const selections = new Map();

/** SSE subscribers (drawdown & raw events) */
const ddSubs  = new Set(); // { res, filter:Set<string>, ping, refresh }
const evtSubs = new Set(); // { res, filter:Set<string>, ping }

let lastBrandEventAt = 0;
let lastConnectError = '';

// ---------- Utils ----------
const num = (x)=>{ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };

function first(obj, paths){
  for (const p of paths){
    const parts = p.split('.');
    let cur = obj;
    for (const k of parts){
      if (cur && Object.prototype.hasOwnProperty.call(cur, k)) cur = cur[k];
      else { cur = undefined; break; }
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

function makeToken(){ return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }

setInterval(() => {
  const now = Date.now();
  for (const [t, v] of selections) if (v.expiresAt <= now) selections.delete(t);
}, 60_000);

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
  return rec.set;
}
function checkToken(req, res){
  if (!READ_TOKEN) return true;
  const provided = String(req.query.token || req.headers['x-read-token'] || '');
  if (provided === READ_TOKEN) return true;
  res.status(401).json({ ok:false, error:'unauthorized' });
  return false;
}

// ---------- Account handling ----------
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
  const id  = m.accountId || m.account?.id || m.accId || String(m?.accountID || '');
  if (!id) return;

  const eq  = num(m.equity ?? m.Equity);
  const cur = m.currency || m.Currency || 'USD';
  const now = Date.now();

  if (!state.has(id)) {
    state.set(id, { hwm:eq, equity:eq, maxDD:0, currency:cur, updatedAt:now, balance: NaN });
  }
  const s = state.get(id);

  const bal = parseBalance(m);
  if (Number.isFinite(bal)) s.balance = bal;

  if (eq > s.hwm) s.hwm = eq;      // raise HWM
  s.equity = eq;
  s.currency = cur;
  s.updatedAt = now;

  const dd = s.hwm > 0 ? (s.hwm - s.equity) / s.hwm : 0; // 0..1
  if (dd > s.maxDD) s.maxDD = dd;

  // Store positionPnLs from AccountStatus
  if (m.positionPnLs && Array.isArray(m.positionPnLs)) {
    s.positionPnLs = m.positionPnLs;
  }

  pushDD(s, id);
}

// ---------- Position handling ----------
function updatePosition(m){
  const accountId = m.accountId;
  const positionId = m.positionId;
  
  if (!accountId || !positionId) return;

  // Ensure positions map exists for this account
  if (!positions.has(accountId)) {
    positions.set(accountId, new Map());
  }

  const accountPositions = positions.get(accountId);
  
  // Store or update position
  accountPositions.set(positionId, {
    positionId,
    accountId,
    lots: m.lots,
    lotSize: m.lotSize,
    units: m.units,
    instrument: m.instrument,
    openPrice: m.openPrice,
    openDateTime: m.openDateTime,
    openOrderId: m.openOrderId,
    stopLossOrderId: m.stopLossOrderId,
    stopLossLimit: m.stopLossLimit,
    maintMargin: m.maintMargin,
    takeProfitOrderId: m.takeProfitOrderId,
    takeProfitLimit: m.takeProfitLimit,
    side: m.side,
    fee: m.fee,
    swaps: m.swaps,
    updatedAt: Date.now(),
  });
}

function removePosition(accountId, positionId){
  if (!accountId || !positionId) return;
  const accountPositions = positions.get(accountId);
  if (accountPositions) {
    accountPositions.delete(positionId);
  }
}

function buildDDPayload(id){
  const s = state.get(id);
  if (!s) return null;

  const dd = s.hwm > 0 ? (s.hwm - s.equity) / s.hwm : 0;

  let instPct = null; // signed % vs balance
  if (Number.isFinite(s.balance) && s.balance > 0) {
    instPct = ((s.equity - s.balance) / s.balance) * 100;
  }

  // Get open positions for this account
  const accountPositions = positions.get(id);
  const openPositions = accountPositions ? Array.from(accountPositions.values()) : [];

  // Merge P&L from AccountStatus into positions
  if (s.positionPnLs && Array.isArray(s.positionPnLs)) {
    const pnlMap = new Map();
    s.positionPnLs.forEach(p => {
      pnlMap.set(p.positionId, num(p.pnl));
    });

    // Inject P&L into each position
    openPositions.forEach(pos => {
      if (pnlMap.has(pos.positionId)) {
        pos.pnl = pnlMap.get(pos.positionId);
      }
    });
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
    openPositions, // Include positions array
    positionPnLs: s.positionPnLs, // Include raw P&L data
  };
}

function pushDD(_s, accountId){
  const payload = buildDDPayload(accountId);
  if (!payload) return;
  for (const sub of ddSubs){
    if (sub.filter.size && !sub.filter.has(accountId)) continue;
    sub.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function broadcastEvent(m){
  const acct = m.accountId || m.account?.id || m.accId || '';
  const line = `data: ${JSON.stringify(m)}\n\n`;
  for (const sub of evtSubs){
    if (sub.filter?.size && acct && !sub.filter.has(acct)) continue;
    sub.res.write(line);
  }
}

// ---------- Brand Socket ----------
const socket = io(SERVER + '/brand-socket', {
  path: '/brand-api/socket.io',
  transports: ['websocket', 'polling'],
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
  const t = (m?.type || '').toString().toUpperCase();

  // Handle account updates
  if (t === 'ACCOUNTSTATUS' || t === 'ACCOUNT' || t === 'ACCOUNT_UPDATE') {
    updateAccount(m);
  }

  // Handle position updates
  if (t === 'POSITION') {
    updatePosition(m);
  }

  // Handle closed positions
  if (t === 'CLOSEPOSITION') {
    removePosition(m.accountId, m.positionId);
  }

  // pass-through for debugging/consumption
  broadcastEvent(m);
});

// Watchdog: only restart if DISCONNECTED and stale
setInterval(() => {
  if (!STALE_MS) return;
  if (!socket.connected) {
    const age = Date.now() - (lastBrandEventAt || 0);
    if (age > STALE_MS) {
      console.warn('[Watchdog] Disconnected & stale for', age, 'ms. Exiting for platform to restart.');
      process.exit(1);
    }
  }
}, 30000);

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

// Drawdown SSE (accounts + positions)
app.get('/dd/stream', (req, res) => {
  if (!checkToken(req, res)) return;

  const selSet   = getSelectionFromToken(req.query.sel);
  const paramSet = parseAccountsParam(req.query.accounts || req.query['accounts[]']);
  const filter   = selSet ? selSet : paramSet;
  const batchMode= req.query.batch === '1';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = { res, filter, id: Math.random().toString(36).slice(2), ping: null, refresh: null };
  sub.ping = setInterval(() => res.write(`: ping\n\n`), HEARTBEAT_MS);

  const sendSnapshot = () => {
    const ids = filter.size ? Array.from(filter) : Array.from(state.keys());
    if (batchMode) {
      const arr = [];
      for (const id of ids) { const p = buildDDPayload(id); if (p) arr.push(p); }
      res.write(`event: batch\ndata: ${JSON.stringify({ serverTime: Date.now(), accounts: arr })}\n\n`);
    } else {
      for (const id of ids){
        const p = buildDDPayload(id);
        if (p) res.write(`data: ${JSON.stringify(p)}\n\n`);
      }
    }
  };
  if (REFRESH_MS > 0) sub.refresh = setInterval(sendSnapshot, REFRESH_MS);

  ddSubs.add(sub);
  sendSnapshot();

  req.on('close', () => {
    if (sub.ping)    clearInterval(sub.ping);
    if (sub.refresh) clearInterval(sub.refresh);
    ddSubs.delete(sub);
  });
});

// Drawdown snapshot (JSON)
app.get('/dd/state', (req, res) => {
  if (!checkToken(req, res)) return;

  const selSet  = getSelectionFromToken(req.query.sel);
  const filter  = selSet ? selSet : parseAccountsParam(req.query.accounts || req.query['accounts[]']);

  const out = [];
  for (const [id] of state.entries()){
    if (filter.size && !filter.has(id)) continue;
    const p = buildDDPayload(id); if (p) out.push(p);
  }
  out.sort((a,b)=> b.equity - a.equity);
  res.json({ env: TYPE, count: out.length, accounts: out });
});

// Coverage for a selection token
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
  
  // Count total positions
  let totalPositions = 0;
  for (const [accountId] of positions) {
    if (filter.size && !filter.has(accountId)) continue;
    totalPositions += positions.get(accountId).size;
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
    totalPositions,
    lastBrandEventAt,
    lastConnectError,
    now: Date.now(),
  });
});

// Seed balances manually if stream lacks them
// POST body: {"L#526977": 480, "L#527161": 400}
app.post('/dd/balanceSeed', (req, res) => {
  if (!checkToken(req, res)) return;

  const payload = req.body;
  let updates = [];
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [accountId, bal] of Object.entries(payload)) {
      const nVal = Number(bal);
      if (!Number.isFinite(nVal)) continue;
      const now = Date.now();
      const s = state.get(accountId) || { hwm:nVal, equity:nVal, maxDD:0, currency:'USD', updatedAt: now, balance:nVal };
      s.balance = nVal;
      s.updatedAt = now;
      state.set(accountId, s);
      updates.push({ accountId, balance: s.balance });
      pushDD(s, accountId);
    }
  }
  if (!updates.length) return res.status(400).json({ ok:false, error:'no valid balances' });
  res.json({ ok:true, updates });
});

// Raw events SSE (optional debugging)
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
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = { res, filter, ping: setInterval(() => res.write(`: ping\n\n`), HEARTBEAT_MS) };
  evtSubs.add(sub);
  req.on('close', () => { clearInterval(sub.ping); evtSubs.delete(sub); });
});

// Health & status
app.get('/health', (_req,res)=> {
  let totalPositions = 0;
  for (const posMap of positions.values()) totalPositions += posMap.size;
  res.json({ ok:true, env: TYPE, knownAccounts: state.size, totalPositions });
});

app.get('/brand/status', (_req,res)=> {
  let totalPositions = 0;
  for (const posMap of positions.values()) totalPositions += posMap.size;
  
  res.json({
    env: TYPE,
    server: SERVER,
    connected: socket.connected,
    knownAccounts: state.size,
    totalPositions,
    lastBrandEventAt,
    lastConnectError,
    now: Date.now(),
  });
});

// Hardening
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });

// Start
app.listen(PORT, ()=> console.log(`DD relay (accounts + positions) listening on :${PORT}`));
