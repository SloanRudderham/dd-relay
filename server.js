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

// --- Hotfix guardrails (minimal, safe defaults) ---
const MAX_STREAMS_PER_IP = Number(process.env.MAX_STREAMS_PER_IP || 5);

// Caps for batch snapshots when filter is empty or abusive clients request too much
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS || 1000);

// Default batch cap (~2MB). If exceeded, we will degrade by dropping heavy fields (positions/pnls)
// based on include flags instead of crashing the process.
const MAX_BATCH_BYTES = Number(process.env.MAX_BATCH_BYTES || 2_000_000);

// Prevent "zombie positions" accumulating forever if CLOSEPOSITION is missed
const POSITION_TTL_MS = Number(process.env.POSITION_TTL_MS || 10 * 60 * 1000);
const PRUNE_POSITIONS_MS = Number(process.env.PRUNE_POSITIONS_MS || 60 * 1000);

if (!KEY) { console.error('Missing TL_BRAND_KEY'); process.exit(1); }

if (TYPE === 'LIVE' && /api-dev/.test(SERVER)) {
  console.warn('[Config] TL_ENV=LIVE but TL_SERVER looks DEV:', SERVER);
}
if (TYPE !== 'LIVE' && /api\.tradelocker\.com/.test(SERVER)) {
  console.warn('[Config] TL_ENV!=LIVE but TL_SERVER is LIVE:', SERVER);
}

// ---------- State ----------
/**
 * accountId -> {
 *   hwm, equity, maxDD, currency, updatedAt,
 *   balance?, balanceWithoutCredit?, credit?,
 *   marginAvailable?, marginUsed?, blockedBalance?,
 *   positionPnLs?
 * }
 */
const state = new Map();

/** accountId -> Map<positionId, positionData> */
const positions = new Map();

/** token -> { set:Set<string>, expiresAt:number } */
const selections = new Map();

/** SSE subscribers (drawdown & raw events) */
const ddSubs  = new Set(); // { res, filter:Set<string>, ping, refresh, includePositions, includeRawPnls, id }
const evtSubs = new Set(); // { res, filter:Set<string>, ping }

let lastBrandEventAt = 0;
let lastConnectError = '';

// --- Stream limiting (per IP) ---
const streamsByIp = new Map();
function getIp(req) {
  return String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim();
}
function incIp(ip) { streamsByIp.set(ip, (streamsByIp.get(ip) || 0) + 1); }
function decIp(ip) {
  const n = (streamsByIp.get(ip) || 1) - 1;
  if (n <= 0) streamsByIp.delete(ip);
  else streamsByIp.set(ip, n);
}

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

// --- Backpressure-safe write (prevents buffering death spirals) ---
async function safeWrite(res, chunk) {
  try {
    const ok = res.write(chunk);
    if (!ok) await new Promise(resolve => res.once('drain', resolve));
    return true;
  } catch {
    return false;
  }
}

// prune selection tokens
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of selections) if (v.expiresAt <= now) selections.delete(t);
}, 60_000);

// prune stale positions (prevents openPositions growing without bound)
setInterval(() => {
  const now = Date.now();
  for (const [accountId, posMap] of positions) {
    for (const [positionId, pos] of posMap) {
      const updatedAt = Number(pos?.updatedAt || 0);
      if (updatedAt && (now - updatedAt > POSITION_TTL_MS)) {
        posMap.delete(positionId);
      }
    }
    if (posMap.size === 0) positions.delete(accountId);
  }
}, PRUNE_POSITIONS_MS);

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
  // Prefer balanceWithoutCredit when present (matches Brand API semantics)
  for (const k of ['balanceWithoutCredit','balance_without_credit','balanceWithoutCreditAmount','BalanceWithoutCredit']) {
    const v = m?.[k];
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return { value: n, kind: 'withoutCredit' };
    }
  }

  // Fallback to regular balance
  for (const k of ['balance','accountBalance','cash','cashBalance','Balance']) {
    const v = m?.[k];
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return { value: n, kind: 'withCreditOrUnknown' };
    }
  }

  return { value: NaN, kind: 'unknown' };
}

function updateAccount(m){
  const id  = m.accountId || m.account?.id || m.accId || String(m?.accountID || '');
  if (!id) return;

  const eq  = num(m.equity ?? m.Equity);
  const cur = m.currency || m.Currency || 'USD';
  const now = Date.now();

  if (!state.has(id)) {
    state.set(id, {
      hwm: eq,
      equity: eq,
      maxDD: 0,
      currency: cur,
      updatedAt: now,
      balance: NaN,
      balanceWithoutCredit: NaN,
      credit: NaN,
      marginAvailable: NaN,
      marginUsed: NaN,
      blockedBalance: NaN,
      positionPnLs: undefined,
    });
  }
  const s = state.get(id);

  // Balance + balanceWithoutCredit
  const balRec = parseBalance(m);
  if (Number.isFinite(balRec.value)) {
    if (balRec.kind === 'withoutCredit') {
      s.balanceWithoutCredit = balRec.value;
      // Keep s.balance as-is unless a separate balance field is also provided
      const balWith = first(m, ['balance','accountBalance','cash','cashBalance','Balance']);
      const balWithNum = Number(balWith);
      if (Number.isFinite(balWithNum)) s.balance = balWithNum;
    } else {
      s.balance = balRec.value;
    }
  }

  // Credit
  {
    const credit = first(m, ['credit','Credit']);
    const n = Number(credit);
    if (Number.isFinite(n)) s.credit = n;
  }

  // Margin + blocked
  {
    const marginAvailable = first(m, ['marginAvailable','margin_available','freeMargin','MarginAvailable']);
    const marginUsed      = first(m, ['marginUsed','margin_used','usedMargin','MarginUsed']);
    const blockedBalance  = first(m, ['blockedBalance','blocked_balance','BlockedBalance']);

    const ma = Number(marginAvailable);
    const mu = Number(marginUsed);
    const bb = Number(blockedBalance);

    if (Number.isFinite(ma)) s.marginAvailable = ma;
    if (Number.isFinite(mu)) s.marginUsed = mu;
    if (Number.isFinite(bb)) s.blockedBalance = bb;
  }

  // HWM/DD logic unchanged
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
    if (accountPositions.size === 0) positions.delete(accountId);
  }
}

function buildDDPayload(id, opts = {}) {
  const s = state.get(id);
  if (!s) return null;

  const includePositions = opts.includePositions !== undefined ? !!opts.includePositions : false;
  const includeRawPnls   = opts.includeRawPnls   !== undefined ? !!opts.includeRawPnls   : false;

  const dd = s.hwm > 0 ? (s.hwm - s.equity) / s.hwm : 0;

  // Use balanceWithoutCredit (preferred) for instantaneous PnL% if available; otherwise fall back to balance
  const baseBal = (Number.isFinite(s.balanceWithoutCredit) && s.balanceWithoutCredit > 0)
    ? s.balanceWithoutCredit
    : (Number.isFinite(s.balance) && s.balance > 0 ? s.balance : NaN);

  let instPct = null; // signed % vs base balance
  if (Number.isFinite(baseBal) && baseBal > 0) {
    instPct = ((s.equity - baseBal) / baseBal) * 100;
  }

  let openPositions;
  if (includePositions) {
    const accountPositions = positions.get(id);
    openPositions = accountPositions ? Array.from(accountPositions.values()) : [];

    // Merge P&L from AccountStatus into positions
    if (s.positionPnLs && Array.isArray(s.positionPnLs)) {
      const pnlMap = new Map();
      s.positionPnLs.forEach(p => pnlMap.set(p.positionId, num(p.pnl)));

      openPositions.forEach(pos => {
        if (pnlMap.has(pos.positionId)) pos.pnl = pnlMap.get(pos.positionId);
      });
    }
  }

  return {
    type: 'account',
    accountId: id,

    equity: Number(s.equity.toFixed(2)),
    hwm: Number(s.hwm.toFixed(2)),

    dd,
    ddPct: Number((dd * 100).toFixed(2)),
    maxDDPct: Number((s.maxDD * 100).toFixed(2)),

    // AccountStatus fields (now forwarded)
    balance: Number.isFinite(s.balance) ? Number(s.balance.toFixed(2)) : null,
    balanceWithoutCredit: Number.isFinite(s.balanceWithoutCredit) ? Number(s.balanceWithoutCredit.toFixed(2)) : null,
    credit: Number.isFinite(s.credit) ? Number(s.credit.toFixed(2)) : null,
    marginAvailable: Number.isFinite(s.marginAvailable) ? Number(s.marginAvailable.toFixed(2)) : null,
    marginUsed: Number.isFinite(s.marginUsed) ? Number(s.marginUsed.toFixed(2)) : null,
    blockedBalance: Number.isFinite(s.blockedBalance) ? Number(s.blockedBalance.toFixed(2)) : null,

    // Derived
    instPct: instPct !== null ? Number(instPct.toFixed(2)) : null,

    currency: s.currency,
    updatedAt: s.updatedAt,
    serverTime: Date.now(),

    ...(includePositions ? { openPositions } : {}),
    ...(includeRawPnls ? { positionPnLs: s.positionPnLs } : {}),
  };
}

// Per-account delta push (only used by non-batch consumers; keep it working)
function pushDD(_s, accountId){
  const payload = buildDDPayload(accountId, { includePositions: true, includeRawPnls: true });
  if (!payload) return;

  for (const sub of Array.from(ddSubs)){
    if (sub.filter.size && !sub.filter.has(accountId)) continue;

    safeWrite(sub.res, `data: ${JSON.stringify(payload)}\n\n`).then(ok => {
      if (!ok) {
        try { if (sub.ping) clearInterval(sub.ping); if (sub.refresh) clearInterval(sub.refresh); } catch {}
        ddSubs.delete(sub);
        try { sub.res.end(); } catch {}
      }
    });
  }
}

function broadcastEvent(m){
  const acct = m.accountId || m.account?.id || m.accId || '';
  const line = `data: ${JSON.stringify(m)}\n\n`;

  for (const sub of Array.from(evtSubs)){
    if (sub.filter?.size && acct && !sub.filter.has(acct)) continue;

    safeWrite(sub.res, line).then(ok => {
      if (!ok) {
        try { if (sub.ping) clearInterval(sub.ping); } catch {}
        evtSubs.delete(sub);
        try { sub.res.end(); } catch {}
      }
    });
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

  // --- Per-IP stream limiting ---
  const ip = getIp(req);
  if ((streamsByIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) {
    return res.status(429).send('Too many streams from this IP');
  }
  incIp(ip);

  const selSet   = getSelectionFromToken(req.query.sel);
  const paramSet = parseAccountsParam(req.query.accounts || req.query['accounts[]']);
  const filter   = selSet ? selSet : paramSet;

  const batchMode = req.query.batch === '1';

  // Minimal contract-compatible optimization:
  // - default is LIGHT (no positions/pnls) so all your existing non-exposure pages stop pulling huge payloads
  // - Exposure pages opt-in via includePositions=1&includeRawPnls=1
  const includePositions = req.query.includePositions === '1';
  const includeRawPnls   = req.query.includeRawPnls === '1';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  safeWrite(res, `event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = {
    res,
    filter,
    includePositions,
    includeRawPnls,
    id: Math.random().toString(36).slice(2),
    ping: null,
    refresh: null
  };

  sub.ping = setInterval(() => {
    safeWrite(res, `: ping\n\n`).then(ok => {
      if (!ok) {
        try { req.destroy(); } catch {}
      }
    });
  }, HEARTBEAT_MS);

  // snapshot builder with graceful degradation when payload explodes
  const buildAccountsSnapshot = () => {
    const idsAll = filter.size ? Array.from(filter) : Array.from(state.keys());
    const ids = idsAll.slice(0, MAX_ACCOUNTS);

    const accounts = [];
    let bytes = 0;
    let truncated = false;

    for (const id of ids) {
      // Start with requested fields
      let p = buildDDPayload(id, { includePositions, includeRawPnls });
      if (!p) continue;

      let s = JSON.stringify(p);
      let nextBytes = bytes + Buffer.byteLength(s, 'utf8');

      // If we are over cap and we included heavy fields, degrade for this account only:
      if (nextBytes > MAX_BATCH_BYTES && (includePositions || includeRawPnls)) {
        // drop raw pnls first (often large)
        p = buildDDPayload(id, { includePositions, includeRawPnls: false });
        s = JSON.stringify(p);
        nextBytes = bytes + Buffer.byteLength(s, 'utf8');
      }
      if (nextBytes > MAX_BATCH_BYTES && includePositions) {
        // then drop positions too
        p = buildDDPayload(id, { includePositions: false, includeRawPnls: false });
        s = JSON.stringify(p);
        nextBytes = bytes + Buffer.byteLength(s, 'utf8');
      }

      // If still too big, stop adding accounts to avoid runaway (keep contract: full snapshot of what we can)
      if (nextBytes > MAX_BATCH_BYTES) {
        truncated = true;
        break;
      }

      bytes = nextBytes;
      accounts.push(p);
    }

    if (accounts.length < ids.length) truncated = true;

    return { accounts, truncated, bytes, requestedAccounts: ids.length };
  };

  const sendSnapshot = async () => {
    if (batchMode) {
      const snap = buildAccountsSnapshot();
      const payload = {
        serverTime: Date.now(),
        env: TYPE,
        truncated: snap.truncated,
        bytes: snap.bytes,
        requestedAccounts: snap.requestedAccounts,
        accounts: snap.accounts,
      };
      await safeWrite(res, `event: batch\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      // legacy non-batch behavior: send per-account messages
      const idsAll = filter.size ? Array.from(filter) : Array.from(state.keys());
      const ids = idsAll.slice(0, MAX_ACCOUNTS);

      for (const id of ids) {
        const p = buildDDPayload(id, { includePositions, includeRawPnls });
        if (!p) continue;
        const ok = await safeWrite(res, `data: ${JSON.stringify(p)}\n\n`);
        if (!ok) break;
      }
    }
  };

  // Repeated snapshots: required by your UI
  if (REFRESH_MS > 0) {
    sub.refresh = setInterval(() => { sendSnapshot(); }, REFRESH_MS);
  }

  ddSubs.add(sub);
  sendSnapshot();

  const cleanup = () => {
    decIp(ip);
    if (sub.ping) clearInterval(sub.ping);
    if (sub.refresh) clearInterval(sub.refresh);
    ddSubs.delete(sub);
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
});

// Drawdown snapshot (JSON) — unchanged output (light default would break callers; keep full)
app.get('/dd/state', (req, res) => {
  if (!checkToken(req, res)) return;

  const selSet  = getSelectionFromToken(req.query.sel);
  const filter  = selSet ? selSet : parseAccountsParam(req.query.accounts || req.query['accounts[]']);

  const out = [];
  for (const [id] of state.entries()){
    if (filter.size && !filter.has(id)) continue;
    const p = buildDDPayload(id, { includePositions:true, includeRawPnls:true });
    if (p) out.push(p);
  }
  out.sort((a,b)=> b.equity - a.equity);
  res.json({ env: TYPE, count: out.length, accounts: out });
});

// Coverage for a selection token
app.get('/dd/coverage', (req, res) => {
  if (!checkToken(req, res)) return;

  const selSet = getSelectionFromToken(req.query.sel);
  if (!selSet) return res.status(400).json({ ok:false, error:'bad or expired selection token' });

  const filter = selSet; // FIX: filter was undefined in original code

  const expected = selSet.size;
  let present = 0;
  const missing = [];
  for (const id of selSet) {
    if (state.has(id)) present++;
    else missing.push(id);
  }

  // Count total positions (filtered)
  let totalPositions = 0;
  for (const [accountId, posMap] of positions) {
    if (filter.size && !filter.has(accountId)) continue;
    totalPositions += posMap.size;
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
      const s = state.get(accountId) || {
        hwm:nVal,
        equity:nVal,
        maxDD:0,
        currency:'USD',
        updatedAt: now,
        balance:nVal,
        balanceWithoutCredit: NaN,
        credit: NaN,
        marginAvailable: NaN,
        marginUsed: NaN,
        blockedBalance: NaN,
      };
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

  // --- Per-IP stream limiting ---
  const ip = getIp(req);
  if ((streamsByIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) {
    return res.status(429).send('Too many streams from this IP');
  }
  incIp(ip);

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

  safeWrite(res, `event: hello\ndata: ${JSON.stringify({ ok:true, env: TYPE })}\n\n`);

  const sub = {
    res,
    filter,
    ping: setInterval(() => {
      safeWrite(res, `: ping\n\n`).then(ok => {
        if (!ok) {
          try { req.destroy(); } catch {}
        }
      });
    }, HEARTBEAT_MS)
  };

  evtSubs.add(sub);

  const cleanup = () => {
    decIp(ip);
    clearInterval(sub.ping);
    evtSubs.delete(sub);
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
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
