const { io } = require('socket.io-client');

const SERVER = process.env.TL_SERVER || 'wss://api.tradelocker.com';
const NAMESPACE = '/brand-socket';
const PATH = '/brand-api/socket.io';
const TYPE = process.env.TL_ENV || 'LIVE';
const KEY  = process.env.TL_BRAND_KEY;

if (!KEY) { console.error('Missing TL_BRAND_KEY'); process.exit(1); }

const WATCH = new Set((process.env.WATCH || '').split(',').map(s=>s.trim()).filter(Boolean));
// Seed HWM like: HWM_SEED="L#526977:1000,L#527161:500"
const HWM_SEED = (process.env.HWM_SEED || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean)
  .reduce((acc, pair) => {
    const [id, v] = pair.split(':');
    const n = Number(v);
    if (id && Number.isFinite(n)) acc[id] = n;
    return acc;
  }, {});

// Drawdown bands (percent as whole numbers). Default 5,8,10
const BANDS = (process.env.DD_BANDS || '5,8,10')
  .split(',')
  .map(x => Number(x.trim()))
  .filter(x => Number.isFinite(x) && x > 0)
  .sort((a,b)=>a-b);

function fmtPct(x){ return (x*100).toFixed(2) + '%'; }
function num(x){ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; }
function color(s,c){
  const codes = {red:'\x1b[31m',yellow:'\x1b[33m',green:'\x1b[32m',reset:'\x1b[0m'};
  return (codes[c]||'') + s + codes.reset;
}
function bar(dd, bands){ // dd as fraction (0.0..1.0), bands in %
  const width = 30;
  const pct = Math.max(0, Math.min(1, dd));
  const filled = Math.round(pct * width);
  const str = '█'.repeat(filled) + '░'.repeat(width - filled);
  // pick color by thresholds
  const ddPct = dd*100;
  let col = 'green';
  if (ddPct >= bands[bands.length-1]) col = 'red';
  else if (ddPct >= bands[0]) col = 'yellow';
  return color(str, col);
}

// Track per-account stats
const state = new Map(); // id -> { hwm, equity, maxDD }

function updateAccount(id, equity){
  if (!state.has(id)) state.set(id, { hwm: HWM_SEED[id] || equity, equity, maxDD: 0 });
  const s = state.get(id);
  // Raise HWM if equity makes a new high
  if (equity > s.hwm) s.hwm = equity;
  s.equity = equity;
  const dd = s.hwm > 0 ? (s.hwm - equity) / s.hwm : 0;
  if (dd > s.maxDD) s.maxDD = dd;
}

function drawTable(){
  const rows = [];
  for (const [id, s] of state.entries()){
    if (WATCH.size && !WATCH.has(id)) continue;
    if (!Number.isFinite(s.hwm) || s.hwm <= 0) continue;
    const dd = s.hwm > 0 ? (s.hwm - s.equity)/s.hwm : 0;
    rows.push({
      accountId: id,
      equity: s.equity.toFixed(2),
      HWM: s.hwm.toFixed(2),
      DD: fmtPct(dd),
      MaxDD: fmtPct(s.maxDD),
      Meter: bar(dd, BANDS),
    });
  }
  rows.sort((a,b)=> parseFloat(b.equity) - parseFloat(a.equity));
  if (rows.length){
    console.clear();
    console.log(`== Drawdown Monitor (${TYPE})  Bands: ${BANDS.join('% / ')}% ==  (${new Date().toLocaleTimeString()})`);
    // Render a simple table
    for (const r of rows.slice(0, 50)){
      const ddVal = parseFloat(r.DD);
      let ddColor = 'green';
      if (ddVal >= BANDS[BANDS.length-1]) ddColor = 'red';
      else if (ddVal >= BANDS[0]) ddColor = 'yellow';
      console.log(
        r.accountId.padEnd(10),
        'Eq:', r.equity.padStart(10),
        'HWM:', r.HWM.padStart(10),
        'DD:', color(r.DD.padStart(7), ddColor),
        'Max:', r.MaxDD.padStart(7),
        r.Meter
      );
    }
  }
}

const socket = io(SERVER + NAMESPACE, {
  path: PATH,
  transports: ['websocket'],
  query: { type: TYPE },        // LIVE | DEMO
  extraHeaders: { 'brand-api-key': KEY },
});

// STREAM: AccountStatus, Position, OpenOrder, ClosePosition, Property(SyncEnd)
socket.on('stream', (m) => {
  if (!m || !m.type) return;
  if (m.type === 'AccountStatus'){
    const id = m.accountId;
    if (WATCH.size && !WATCH.has(id)) return;
    const eq = num(m.equity);
    updateAccount(id, eq);
    return;
  }
  // You can also watch positions/orders if you want:
  // if (m.type === 'Position' || m.type === 'OpenOrder' || m.type === 'ClosePosition') { ... }
});

socket.on('connect', () => {
  console.log('Connected to BrandSocket. Monitoring drawdown...');
});

socket.on('error', (e)=> console.error('socket error:', e));
socket.on('disconnect', (r)=> console.log('disconnected:', r));

// refresh the table every 2 seconds
setInterval(drawTable, 2000);
