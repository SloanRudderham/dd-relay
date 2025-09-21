// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { io } = require('socket.io-client');

const app = express();

// ---------- CORS / JSON ----------
app.use(cors());                // in prod, lock to your Lovable domain
app.use(express.json());

// ---------- Config ----------
const SERVER = process.env.TL_SERVER || 'wss://api.tradelocker.com';
const TYPE   = process.env.TL_ENV    || 'LIVE'; // LIVE or DEMO
const KEY    = process.env.TL_BRAND_KEY;
const PORT   = Number(process.env.PORT || 8080);

const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 1000);   // SSE keep-alive comment
const REFRESH_MS   = Number(process.env.REFRESH_MS   || 5000);   // periodic push
const STALE_MS     = Number(process.env.STALE_MS     || 120000); // watchdog

const SELECT_TTL_MS = Number(process.env.SELECT_TTL_MS || 10 * 60 * 1000);
const READ_TOKEN    = process.env.READ_TOKEN || ''; // optional read protection

// Optional: JSON map of contract sizes, e.g. {"XAUUSD":100,"BTCUSD":1}
let CONTRACT_SIZE = {};
try { CONTRACT_SIZE = JSON.parse(process.env.CONTRACT_SIZE_JSON || '{}'); } catch (_) { CONTRACT_SIZE = {}; }

if (!KEY) { console.error('Missing TL_BRAND_KEY'); process.exit(1); }

if (TYPE === 'LIVE' && /api-dev/.test(SERVER)) {
  console.warn('[Config] TL_ENV=LIVE but TL_SERVER looks DEV:', SERVER);
}
if (TYPE !== 'LIVE' && /api\.tradelocker\.com/.test(SERVER)) {
  console.warn('[Config] TL_ENV!=LIVE but TL_SERVER is LIVE:', SERVER);
}

// ---------- State ----------
// Account snapshot: id -> { hwm, equity, maxDD, currency, updatedAt, balance? }
const state = new Map();

// Selections (multi-dashboard filtering)
const selections = new Map(); // token -> { set:Set<string>, expiresAt:number }

// SSE subscribers
const ddSubs  = new Set(); // drawdown stream
const evtSubs = new Set(); // raw event stream
const posSubs = new Set(); // positions stream
const qSubs   = new Set(); // quotes stream

// Positions caches
const openPos   = new Map(); // accountId -> Map(positionId -> pos)
const closedPos = new Map(); // accountId -> Array<pos> (recent)

// Quote cache: symbol -> { bid, ask, last, time }
const quotes = new Map();

let lastBrandEventAt = 0;
let lastConnectError = '';

// ---------- Utils ----------
const num = (x)=>{ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const n = (v)=>{ const x = Number(v); return Number.isFinite(x) ? x : NaN; };

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
  return rec.set; // Set<string>
}
function checkToken(req, res){
  if (!READ_TOKEN) return true;
  const provided = String(req.query.token || req.headers['x-read-token'] || '');
  if (provided === READ_TOKEN) return true;
  res.status(401).json({ ok:false, error:'unauthorized' });
  return false;
}

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

  if (eq > s.hwm) s.hwm = eq;      // raise HWM on new highs
  s.equity = eq;
  s.currency = cur;
  s.updatedAt = now;

  const dd = s.hwm > 0 ? (s.hwm - s.equity) / s.hwm : 0; // 0..1
  if (dd > s.maxDD) s.maxDD = dd;

  pushDD(s, id);
}

function getMap(map, key){
  let v = map.get(key); if (!v) { v = new Map(); map.set(key, v); }
  return v;
}
function getArr(map, key){
  let v = map.get(key); if (!v) { v = []; map.set(key, v); }
  return v;
}

function normalizePos(m){
  // accept many envelopes
  const src = m?.position || m?.data?.position || m?.payload?.position || m?.payload || m;

  const accountId  = String(
    first(m,   ['accountId','account.id','accId','accountID']) ??
    first(src, ['accountId','account.id','accId','accountID']) ?? ''
  );

  const positionId = String(
    first(m,   ['positionId','id','position.id','posId']) ??
    first(src, ['positionId','id','posId']) ?? ''
  );

  const symbol = String(
    first(src, ['symbol','instrument','symbolName','s']) ??
    first(m,   ['symbol','instrument','symbolName','s']) ?? ''
  );

  const vol =
    n(first(src, ['volume','lots','units','size','qty','quantity','Volume'])) ??
    n(first(m,   ['volume','lots','units','size','qty','quantity','Volume'])) ??
    NaN;

  const sideRaw =
    (first(src, ['side','direction']) ?? first(m, ['side','direction']) ?? (vol < 0 ? 'SELL' : 'BUY'))
      .toString().toUpperCase();
  const side = sideRaw === 'SHORT' ? 'SELL' : sideRaw === 'LONG' ? 'BUY' : sideRaw;

  const openPrice =
    n(first(src, ['openPrice','entryPrice','openRate','avgPrice','averagePrice','priceOpen','price'])) ??
    n(first(m,   ['openPrice','entryPrice','openRate','avgPrice','averagePrice','priceOpen'])) ??
    NaN;

  const closePrice = n(first(src, ['closePrice','exitPrice','priceClose'])) ?? NaN;

  const uPnL =
    n(first(src, ['unrealizedPnL','uPnL','upnl','floatingPnL','floating','profit','pnlUnrealized'])) ??
    n(first(m,   ['unrealizedPnL','uPnL','upnl','floatingPnL','floating','profit','pnlUnrealized'])) ??
    NaN;

  const rPnL =
    n(first(src, ['realizedPnL','rPnL','rpnl','pnl'])) ??
    n(first(m,   ['realizedPnL','rPnL','rpnl','pnl'])) ??
    NaN;

  const openTime =
    n(first(src, ['openTime','timeOpen','createdAt','time','tOpen'])) ?? NaN;

  const closeTime =
    n(first(src, ['closeTime','timeClose','closedTime','tClose'])) ?? NaN;

  const typeStr   = (m?.type || '').toString().toUpperCase();
  const statusRaw = (first(src, ['status','state']) || first(m, ['status','state']) || '').toString().toUpperCase();
  let status = 'OPEN';
  if (closeTime || /CLOSE|CLOSED|EXIT|FILLED/.test(statusRaw) || /CLOSE|FILLED/.test(typeStr)) {
    status = 'CLOSED';
  }
  // guard placeholders
  if (status === 'CLOSED' && (!Number.isFinite(vol) || vol === 0) && (!Number.isFinite(openPrice) || openPrice === 0)) {
    status = 'OPEN';
  }

  return {
    accountId,
    positionId,
    symbol,
    volume: Number.isFinite(vol) ? vol : 0,
    side,
    openPrice: Number.isFinite(openPrice) ? openPrice : 0,
    openTime: Number.isFinite(openTime) ? openTime : 0,
    closePrice: Number.isFinite(closePrice) ? closePrice : 0,
    closeTime: Number.isFinite(closeTime) ? closeTime : 0,
    // prefer broker uPnL if present; otherwise expose null and let UI compute if it wants
    uPnL: Number.isFinite(uPnL) ? uPnL : null,
    rPnL: Number.isFinite(rPnL) ? rPnL : null,
    status,
    serverTime: Date.now(),
  };
}

// Enrich positions with the freshest quote just before sending
function enrichPosWithQuote(p) {
  const q = quotes.get(p.symbol) || {};
  const mid = (Number.isFinite(q.bid) && Number.isFinite(q.ask))
    ? (q.bid + q.ask) / 2
    : (Number.isFinite(q.last) ? q.last : null);

  const mark = p.side === 'BUY'
    ? (Number.isFinite(q.ask) ? q.ask : mid)
    : p.side === 'SELL'
      ? (Number.isFinite(q.bid) ? q.bid : mid)
      : mid;

  return { ...p, mark: mark ?? null, quoteTime: q.time || null };
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
    if (arr.length > 200) arr.length = 200;
    pushPositionsUpdate(p.accountId);
  } else {
    const openMap = getMap(openPos, p.accountId);
    const prev = openMap.get(p.positionId) || {};
    // Store without mark; mark will be enriched from quotes on send
    openMap.set(p.positionId, { ...prev, ...p });
    pushPositionsUpdate(p.accountId);
  }
}

function touchQuote(symbol, patch){
  if (!symbol) return;
  const q = quotes.get(symbol) || {};
  const now = Date.now();
  const out = {
    bid: Number.isFinite(patch.bid) ? patch.bid : q.bid,
    ask: Number.isFinite(patch.ask) ? patch.ask : q.ask,
    last: Number.isFinite(patch.last) ? patch.last : (Number.isFinite(patch.mid) ? patch.mid : q.last),
    time: patch.time || now,
  };
  quotes.set(symbol, out);
  // notify subscribers
  const line = `event: quotes\ndata: ${JSON.stringify({ serverTime: now, symbol, quote: out })}\n\n`;
  for (const sub of qSubs) sub.res.write(line);
  // nudge positions depending on this symbol (broadcast fresh enriched snapshot)
  for (const [acc, map] of openPos.entries()){
    for (const pos of map.values()){
      if (pos.symbol === symbol) { pushPositionsUpdate(acc); break; }
    }
  }
}

function processQuoteLikeEvent(m){
  // Accept many shapes: {type:'Quote', symbol, bid, ask, last}, or nested payloads
  const src = m?.quote || m?.data?.quote || m?.payload?.quote || m?.payload || m;
  const symbol = String(first(src, ['symbol','instrument','symbolName','s']) || '');
  if (!symbol) return;

  const bid = n(first(src, ['bid','b'])) ?? NaN;
  const ask = n(first(src, ['ask','a'])) ?? NaN;
  const last = n(first(src, ['last','price','p','mark'])) ?? NaN;
  const time = Number(first(src, ['time','ts','timestamp'])) || Date.now();

  const patch = {
    bid: Number.isFinite(bid) ? bid : undefined,
    ask: Number.isFinite(ask) ? ask : undefined,
    last: Number.isFinite(last) ? last : undefined,
    time,
  };
  touchQuote(symbol, patch);
}

function buildPositionsSnapshot(filter){
  const out = { serverTime: Date.now(), open: [], closed: [] };
  const want = (id)=> !filter.size || filter.has(id);

  for (const [acc, map] of openPos.entries()){
    if (!want(acc)) continue;
    for (const p of map.values()) out.open.push(enrichPosWithQuote(p));
  }
  for (const [acc, arr] of closedPos.entries()){
    if (!want(acc)) continue;
    for (const p of arr) out.closed.push(enrichPosWithQuote(p));
  }
  return out;
}

function buildDDPayload(id){
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
  transports: ['websocket', 'polling'], // allow polling in handshake
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

  // Normalize type
  const t = (m?.type || '').toString().toUpperCase();

  // Accounts
  if (t === 'ACCOUNTSTATUS' || t === 'ACCOUNT' || t === 'ACCOUNT_UPDATE') {
    updateAccount(m);
    return;
  }

  // Quotes / Ticks
  if (
    t.includes('QUOTE') || t.includes('TICK') || t.includes('PRIC') || t.includes('MARKET') ||
    m?.quote || m?.data?.quote || m?.payload?.quote
  ) {
    processQuoteLikeEvent(m);
  }

  // Positions / Deals / Fills / Orders (some brands put PnL on order updates)
  if (t.includes('POSITION') || t.includes('DEAL') || t.includes('FILL') || t.includes('ORDER')) {
    processPositionEvent(m);
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

// ---------- Drawdown SSE ----------
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
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = { res, filter, id: Math.random().toString(36).slice(2), ping: null, refresh: null };
  sub.ping = setInterval(() => res.write(':\n\n'), HEARTBEAT_MS);

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

// Drawdown snapshot
app.get('/dd/state', (req,res) => {
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
// POST body: {"L#526977": 480, "L#527161": 400}
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
      pushDD(s, accountId);
    }
  }
  if (!updates.length) return res.status(400).json({ ok:false, error:'no valid balances' });
  res.json({ ok:true, updates });
});

// ---------- Raw Events SSE ----------
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
  evtSubs.add(sub);
  req.on('close', () => { clearInterval(sub.ping); evtSubs.delete(sub); });
});

// ---------- Positions SSE + Snapshot ----------
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

  // initial snapshot (now enriched with latest quotes)
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

// ---------- Quotes SSE + Snapshot ----------
app.get('/quotes/stream', (req, res) => {
  if (!checkToken(req, res)) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = { res, ping: setInterval(()=>res.write(':\n\n'), HEARTBEAT_MS) };
  qSubs.add(sub);

  // initial snapshot
  const all = {};
  for (const [s, q] of quotes.entries()) all[s] = q;
  res.write(`event: quotes\ndata: ${JSON.stringify({ serverTime: Date.now(), all })}\n\n`);

  req.on('close', () => { clearInterval(sub.ping); qSubs.delete(sub); });
});

app.get('/quotes/state', (req, res) => {
  if (!checkToken(req, res)) return;
  const out = {};
  for (const [s, q] of quotes.entries()) out[s] = q;
  res.json({ serverTime: Date.now(), count: Object.keys(out).length, quotes: out });
});

// ---------- Health ----------
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

// ---------- Hardening ----------
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });

// ---------- Start ----------
app.listen(PORT, ()=> console.log(`DD relay listening on :${PORT}`));
