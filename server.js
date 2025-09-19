require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { io } = require('socket.io-client');

const app = express();
app.use(cors());
app.use(express.json());

const SERVER = process.env.TL_SERVER || 'wss://api.tradelocker.com';
const TYPE   = process.env.TL_ENV || 'LIVE';
const KEY    = process.env.TL_BRAND_KEY;
const PORT   = Number(process.env.PORT || 8080);

if (!KEY) { console.error('Missing TL_BRAND_KEY'); process.exit(1); }

const state = new Map();
const num = (x)=>{ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };

function onAccountStatus(m){
  const id = m.accountId;
  const eq = num(m.equity);
  const cur = m.currency || 'USD';
  const now = Date.now();
  if (!state.has(id)) state.set(id, { hwm: eq, equity: eq, maxDD: 0, currency: cur, updatedAt: now });
  const s = state.get(id);
  if (eq > s.hwm) s.hwm = eq;
  s.equity = eq; s.currency = cur; s.updatedAt = now;
  const dd = s.hwm > 0 ? (s.hwm - s.equity)/s.hwm : 0;
  if (dd > s.maxDD) s.maxDD = dd;
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
socket.on('stream', (m) => { if (m?.type === 'AccountStatus') onAccountStatus(m); });

app.get('/dd/state', (req,res) => {
  const want = new Set(String(req.query.accounts||'').split(',').map(s=>s.trim()).filter(Boolean));
  const out = [];
  for (const [id,s] of state.entries()){
    if (want.size && !want.has(id)) continue;
    const dd = s.hwm>0 ? (s.hwm - s.equity)/s.hwm : 0;
    out.push({
      accountId: id,
      equity: Number(s.equity.toFixed(2)),
      hwm: Number(s.hwm.toFixed(2)),
      ddPct: Number((dd*100).toFixed(2)),
      maxDDPct: Number((s.maxDD*100).toFixed(2)),
      currency: s.currency,
      updatedAt: s.updatedAt
    });
  }
  out.sort((a,b)=> b.equity - a.equity);
  res.json({ env: TYPE, count: out.length, accounts: out });
});

app.get('/health', (_req,res)=> res.json({ ok:true, env: TYPE, knownAccounts: state.size }));

app.listen(PORT, ()=> console.log(`DD relay listening on :${PORT}`));
