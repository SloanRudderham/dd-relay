const { io } = require('socket.io-client');

const SERVER = process.env.TL_SERVER || 'wss://api.tradelocker.com';
const NAMESPACE = '/brand-socket';
const HANDSHAKE_PATH = '/brand-api/socket.io';
const TYPE = process.env.TL_ENV || 'LIVE';
const KEY  = process.env.TL_BRAND_KEY;

const WATCH = new Set((process.env.WATCH || '').split(',').map(s=>s.trim()).filter(Boolean)); // e.g. L#526977,L#527161
const INSTRUMENTS = (process.env.INSTRUMENTS || 'EURUSD').split(',').map(s=>s.trim());
const SHOW_ZERO = process.env.SHOW_ZERO === '1'; // set SHOW_ZERO=1 to show zero-equity accounts

if (!KEY) { console.error('Missing TL_BRAND_KEY'); process.exit(1); }

const socket = io(SERVER + NAMESPACE, {
  path: HANDSHAKE_PATH,
  transports: ['websocket'],
  query: { type: TYPE },               // LIVE | DEMO
  extraHeaders: { 'brand-api-key': KEY },
});

const last = new Map();     // accountId -> last AccountStatus
const snapshot = new Map(); // accountId -> latest AccountStatus (for periodic summary)

function num(x){ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; }

socket.on('connect', () => {
  console.log('Connected:', socket.id);
  // Subscribe to quotes you care about
  for (const inst of INSTRUMENTS) {
    socket.emit('subscriptions', { action:'SUBSCRIBE', instrument: inst });
  }
});

// STREAM: AccountStatus, Position, OpenOrder, ClosePosition, Property(SyncEnd)
socket.on('stream', (m) => {
  if (!m || !m.type) return;

  if (m.type === 'AccountStatus') {
    const id = m.accountId;
    const eq = num(m.equity);
    if (!SHOW_ZERO && eq === 0) return;
    if (WATCH.size && !WATCH.has(id)) return;

    const prev = last.get(id) || {};
    const changed = [];
    for (const k of ['equity','marginAvailable','marginUsed']) {
      if (String(prev[k]) !== String(m[k])) changed.push(`${k}: ${prev[k] ?? '-'} → ${m[k]}`);
    }
    if (changed.length) {
      console.log(`[${id}] ${changed.join(' | ')}`);
      last.set(id, m);
    }
    snapshot.set(id, m);
    return;
  }

  if (m.type === 'Position') {
    if (WATCH.size && !WATCH.has(m.accountId)) return;
    const side = m.side || (num(m.qty) >= 0 ? 'BUY':'SELL');
    console.log(`pos  [${m.accountId}] ${m.symbol} ${side} qty=${m.qty} upnl=${m.unrealizedPnL} openPx=${m.openPrice}`);
    return;
  }

  if (m.type === 'OpenOrder' || m.type === 'ClosePosition') {
    if (WATCH.size && !WATCH.has(m.accountId)) return;
    console.log(`${m.type === 'OpenOrder' ? 'order':'close'} [${m.accountId}] ${m.symbol} ${m.side} ${m.qty} @${m.price || ''}`);
    return;
  }

  if (m.type === 'Property' && m.name === 'SyncEnd') {
    console.log('--- Initial sync complete (SyncEnd) ---');
    return;
  }

  console.log('stream:', m);
});

// QUOTES
socket.on('subscriptions', (q) => {
  if (!q) return;
  // Expect { type:"Quote", instrument, bid, ask, timestamp, routeId }
  if (q.type === 'Quote') {
    console.log(`quote ${q.instrument} bid=${q.bid} ask=${q.ask} t=${q.timestamp}`);
  } else {
    console.log('subscriptions:', q);
  }
});

socket.on('connection', (m) => console.log('connection:', m));
socket.on('error', (e) => console.error('error:', e));
socket.on('disconnect', (r) => console.log('disconnected:', r));

// Periodic summary table (every 10s)
setInterval(() => {
  const rows = [];
  for (const [id, s] of snapshot.entries()) {
    const eq = num(s.equity);
    if (!SHOW_ZERO && eq === 0) continue;
    if (WATCH.size && !WATCH.has(id)) continue;
    rows.push({
      accountId: id,
      equity: +eq.toFixed(2),
      marginAvail: +num(s.marginAvailable).toFixed(2),
      marginUsed: +num(s.marginUsed).toFixed(2),
      currency: s.currency,
    });
  }
  rows.sort((a,b)=>b.equity - a.equity);
  if (rows.length) {
    console.log('\n== Account Summary ==');
    console.table(rows.slice(0, 20)); // top 20 by equity
  }
}, 10_000);
