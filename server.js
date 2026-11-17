// figurdiscover web server: serves the site and a small live-quotes API (/api/quotes).
// No extra packages needed (Node 18+ has fetch built in).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.woff2': 'font/woff2' };
const BLOCK = /^(server\.js|package(-lock)?\.json|supabase|\.git|node_modules|\.env)/i;

/* ---------- live quotes: Yahoo Finance first, Stooq as backup ---------- */
const ASSETS = {
  gold:   { y: 'GC=F',     s: 'xauusd' },
  silver: { y: 'SI=F',     s: 'xagusd' },
  brent:  { y: 'BZ=F',     s: 'cb.f' },
  ngas:   { y: 'NG=F',     s: 'ng.f' },
  spx:    { y: '^GSPC',    s: '^spx' },
  ndx:    { y: '^NDX',     s: '^ndx' },
  dji:    { y: '^DJI',     s: '^dji' },
  dxy:    { y: 'DX-Y.NYB', s: 'dx.f' },
  btc:    { y: 'BTC-USD',  s: 'btcusd' },
  eth:    { y: 'ETH-USD',  s: 'ethusd' }
};
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'application/json,text/csv,*/*' };
let cache = { t: 0, data: null }, pending = null;

async function getText(url, ms = 8000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { headers: UA, signal: c.signal }); if (!r.ok) throw new Error(r.status); return await r.text(); }
  finally { clearTimeout(t); }
}
async function yahoo(sym) {
  for (const host of ['query1', 'query2']) {
    try {
      const j = JSON.parse(await getText(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`));
      const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (m && Number.isFinite(m.regularMarketPrice)) {
        const prev = Number.isFinite(m.previousClose) ? m.previousClose : m.chartPreviousClose;
        return { p: m.regularMarketPrice, prev: Number.isFinite(prev) ? prev : null, t: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(), src: 'Yahoo Finance' };
      }
    } catch (e) { /* try next host */ }
  }
  return null;
}
async function stooq(keys) {
  const out = {};
  try {
    const syms = keys.map(k => ASSETS[k].s).join(',');
    const csv = await getText(`https://stooq.com/q/l/?s=${encodeURIComponent(syms)}&f=sd2t2ohlc&h&e=csv`);
    const rows = csv.trim().split(/\r?\n/).slice(1).map(l => l.split(','));
    rows.forEach(r => {
      const k = keys.find(k => ASSETS[k].s.toLowerCase() === String(r[0] || '').toLowerCase());
      const close = parseFloat(r[6]), open = parseFloat(r[3]);
      if (k && Number.isFinite(close) && close > 0) out[k] = { p: close, prev: null, open: Number.isFinite(open) ? open : null, t: Date.parse(`${r[1]}T${r[2] || '00:00:00'}Z`) || Date.now(), src: 'Stooq' };
    });
  } catch (e) { /* ignore */ }
  return out;
}
async function loadQuotes() {
  const keys = Object.keys(ASSETS), data = {};
  const ys = await Promise.all(keys.map(k => yahoo(ASSETS[k].y)));
  keys.forEach((k, i) => { if (ys[i]) data[k] = ys[i]; });
  const miss = keys.filter(k => !data[k]);
  if (miss.length) Object.assign(data, await stooq(miss));
  Object.values(data).forEach(q => { const base = q.prev || q.open; q.chg = base ? (q.p / base - 1) * 100 : null; });
  return data;
}
async function quotes() {
  if (cache.data && Date.now() - cache.t < 60000) return cache.data;
  if (!pending) pending = loadQuotes().then(d => { if (Object.keys(d).length) cache = { t: Date.now(), data: d }; return Object.keys(d).length ? d : (cache.data || {}); }).finally(() => { pending = null; });
  return pending;
}


/* ---------- intraday series (15-minute bars, last 5 days) to measure how prices reacted to each news release ---------- */
const SERIES = { gold: 'GC=F', silver: 'SI=F', oil: 'BZ=F', btc: 'BTC-USD', dow: 'YM=F', spx: 'ES=F', usd: 'DX-Y.NYB' };
let sCache = { t: 0, data: null }, sPending = null;
async function ySeries(sym) {
  for (const host of ['query1', 'query2']) {
    try {
      const j = JSON.parse(await getText(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=15m&range=5d`, 10000));
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      const ts = r && r.timestamp, cl = r && r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
      if (ts && cl) { const out = []; ts.forEach((t, i) => { if (Number.isFinite(cl[i])) out.push([t * 1000, +cl[i].toFixed(5)]); }); if (out.length) return out; }
    } catch (e) { /* next host */ }
  }
  return null;
}
async function series() {
  if (sCache.data && Date.now() - sCache.t < 180000) return sCache.data;
  if (!sPending) sPending = (async () => {
    const keys = Object.keys(SERIES), arr = await Promise.all(keys.map(k => ySeries(SERIES[k]))), d = {};
    keys.forEach((k, i) => { if (arr[i]) d[k] = arr[i]; });
    if (Object.keys(d).length) sCache = { t: Date.now(), data: d };
    return Object.keys(d).length ? d : (sCache.data || {});
  })().finally(() => { sPending = null; });
  return sPending;
}

/* ---------- static files with gzip ---------- */
const gzCache = new Map();
function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { file = path.join(ROOT, 'index.html'); st = fs.statSync(file); }
    const ext = path.extname(file).toLowerCase(), type = TYPES[ext] || 'application/octet-stream';
    const head = { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text|javascript|json|svg|xml/.test(type);
    if (gz) {
      const key = file + ':' + st.mtimeMs; let buf = gzCache.get(key);
      if (!buf) { buf = zlib.gzipSync(fs.readFileSync(file), { level: 9 }); gzCache.set(key, buf); }
      res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': buf.length });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }
    res.writeHead(200, { ...head, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/quotes') {
    try {
      const d = await quotes();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ at: Date.now(), quotes: d }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end('{"quotes":{}}');
    }
  }
  if (url.pathname === '/api/series') {
    try {
      const d = await series();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ at: Date.now(), series: d }));
    } catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end('{"series":{}}'); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!rel || BLOCK.test(rel)) rel = 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  sendFile(req, res, file);
}).listen(PORT, '0.0.0.0', () => console.log('figurdiscover listening on ' + PORT));
