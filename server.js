// figurdiscover web server: serves the site and a small live-quotes API (/api/quotes).
// No extra packages needed (Node 18+ has fetch built in).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.woff2': 'font/woff2' };
const BLOCK = /^(server\.js|package(-lock)?\.json|supabase|indicators|\.git|node_modules|\.env)/i;

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

/* =====================================================================================
   PRO: market reactions. For every major decision / news event, how did each of ~85 world
   markets and stocks react on its first trading session after the event?
   Reaction = close of first session that closed after the event ÷ previous close − 1.
   Strength (z) = reaction ÷ that asset's normal daily volatility.
   ===================================================================================== */
const MK_ASSETS = [
  // [symbol, group, Arabic, English, close-time UTC (h)]
  ['^GSPC','idx','إس آند بي 500','S&P 500',21],['^NDX','idx','ناسداك 100','Nasdaq 100',21],['^DJI','idx','داو جونز','Dow Jones',21],['^RUT','idx','راسل 2000','Russell 2000',21],
  ['^FTSE','idx','فوتسي 100 (لندن)','FTSE 100 (London)',16.5],['^GDAXI','idx','داكس (ألمانيا)','DAX (Germany)',16.5],['^FCHI','idx','كاك 40 (فرنسا)','CAC 40 (France)',16.5],['^STOXX50E','idx','يورو ستوكس 50','Euro Stoxx 50',16.5],
  ['^N225','idx','نيكاي 225 (اليابان)','Nikkei 225 (Japan)',6.5],['^HSI','idx','هانغ سنغ (هونغ كونغ)','Hang Seng (Hong Kong)',8],['000001.SS','idx','شنغهاي المركب','Shanghai Composite',7],['^KS11','idx','كوسبي (كوريا)','KOSPI (Korea)',6.5],
  ['^NSEI','idx','نيفتي 50 (الهند)','Nifty 50 (India)',10],['^AXJO','idx','إيه إس إكس 200 (أستراليا)','ASX 200 (Australia)',6],['^GSPTSE','idx','تي إس إكس (كندا)','TSX (Canada)',21],['^BVSP','idx','بوفيسبا (البرازيل)','Bovespa (Brazil)',20],
  ['^TASI.SR','gulf','تاسي (السوق السعودي)','TASI (Saudi market)',12],['KSA','gulf','صندوق السوق السعودي','Saudi market ETF',21],['QAT','gulf','صندوق السوق القطري','Qatar market ETF',21],['UAE','gulf','صندوق سوق الإمارات','UAE market ETF',21],
  ['2222.SR','gulf','أرامكو السعودية','Saudi Aramco',12],['1120.SR','gulf','مصرف الراجحي','Al Rajhi Bank',12],['2010.SR','gulf','سابك','SABIC',12],['7010.SR','gulf','إس تي سي','stc',12],['1180.SR','gulf','البنك الأهلي السعودي','Saudi National Bank',12],
  ['QNBK.QA','gulf','بنك قطر الوطني','QNB',10.25],['IQCD.QA','gulf','صناعات قطر','Industries Qatar',10.25],
  ['XLK','sec','قطاع التكنولوجيا الأمريكي','US Technology',21],['XLF','sec','قطاع البنوك الأمريكي','US Financials',21],['XLE','sec','قطاع الطاقة الأمريكي','US Energy',21],['XLV','sec','قطاع الصحة الأمريكي','US Health care',21],
  ['XLY','sec','السلع الكمالية الأمريكية','US Consumer discretionary',21],['XLP','sec','السلع الأساسية الأمريكية','US Consumer staples',21],['XLI','sec','القطاع الصناعي الأمريكي','US Industrials',21],['XLB','sec','قطاع المواد الأمريكي','US Materials',21],
  ['XLU','sec','قطاع المرافق الأمريكي','US Utilities',21],['XLRE','sec','قطاع العقارات الأمريكي','US Real estate',21],['XLC','sec','قطاع الاتصالات الأمريكي','US Communication',21],['SMH','sec','أشباه الموصلات','Semiconductors',21],
  ['AAPL','us','أبل','Apple',21],['MSFT','us','مايكروسوفت','Microsoft',21],['NVDA','us','إنفيديا','Nvidia',21],['AMZN','us','أمازون','Amazon',21],['GOOGL','us','ألفابت (غوغل)','Alphabet (Google)',21],
  ['META','us','ميتا','Meta',21],['TSLA','us','تسلا','Tesla',21],['AVGO','us','برودكوم','Broadcom',21],['BRK-B','us','بيركشاير هاثاواي','Berkshire Hathaway',21],['JPM','us','جي بي مورغان','JPMorgan',21],
  ['GS','us','غولدمان ساكس','Goldman Sachs',21],['XOM','us','إكسون موبيل','Exxon Mobil',21],['CVX','us','شيفرون','Chevron',21],['LLY','us','إيلاي ليلي','Eli Lilly',21],['UNH','us','يونايتد هيلث','UnitedHealth',21],
  ['V','us','فيزا','Visa',21],['WMT','us','وول مارت','Walmart',21],['COST','us','كوستكو','Costco',21],['BA','us','بوينغ','Boeing',21],['CAT','us','كاتربيلر','Caterpillar',21],
  ['ASML.AS','eu','إيه إس إم إل','ASML',16.5],['SAP.DE','eu','ساب','SAP',16.5],['NOVO-B.CO','eu','نوفو نورديسك','Novo Nordisk',16],['MC.PA','eu','إل في إم إتش','LVMH',16.5],['NESN.SW','eu','نستله','Nestlé',16.5],
  ['SHEL.L','eu','شل','Shell',16.5],['HSBA.L','eu','إتش إس بي سي','HSBC',16.5],['SIE.DE','eu','سيمنس','Siemens',16.5],['AZN.L','eu','أسترازينيكا','AstraZeneca',16.5],['TTE.PA','eu','توتال إنرجيز','TotalEnergies',16.5],
  ['2330.TW','asia','تي إس إم سي','TSMC',5.5],['005930.KS','asia','سامسونغ','Samsung',6.5],['7203.T','asia','تويوتا','Toyota',6.5],['6758.T','asia','سوني','Sony',6.5],['9984.T','asia','سوفت بنك','SoftBank',6.5],
  ['0700.HK','asia','تينسنت','Tencent',8],['9988.HK','asia','علي بابا','Alibaba',8],['RELIANCE.NS','asia','ريلاينس','Reliance',10],['BHP.AX','asia','بي إتش بي','BHP',6],
  ['GC=F','cmd','الذهب','Gold',21],['SI=F','cmd','الفضة','Silver',21],['BZ=F','cmd','خام برنت','Brent crude',21],['NG=F','cmd','الغاز الطبيعي','Natural gas',21],['HG=F','cmd','النحاس','Copper',21],
  ['DX-Y.NYB','fx','مؤشر الدولار','US dollar index',21],['EURUSD=X','fx','يورو / دولار','EUR/USD',23],['JPY=X','fx','دولار / ين','USD/JPY',23],['^TNX','fx','عائد السندات الأمريكية 10 سنوات','US 10-year yield',21],
  ['BTC-USD','crypto','بيتكوين','Bitcoin',24],['ETH-USD','crypto','إيثريوم','Ethereum',24]
];
// Event dates (official calendars). t = time in UTC.
const MK_EV = [];
/* exchange-local time -> UTC, handling daylight saving */
const DTF = new Map();
function tzOff(ms, tz) { let f = DTF.get(tz); if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); DTF.set(tz, f); }
  const p = {}; f.formatToParts(new Date(ms)).forEach(x => p[x.type] = x.value); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms; }
function zoned(date, hhmm, tz) { if (tz === 'UTC') return Date.parse(`${date}T${hhmm}:00Z`); const g = Date.parse(`${date}T${hhmm}:00Z`); let t = g - tzOff(g, tz); t = g - tzOff(t, tz); return t; }
function closeSpec(s) {
  if (/-USD$/.test(s)) return ['23:59', 'UTC'];
  if (/=F$|=X$|^DX-Y/.test(s)) return ['17:00', 'America/New_York'];
  if (/\.L$|^\^FTSE/.test(s)) return ['16:30', 'Europe/London'];
  if (/\.(DE|PA|AS)$|^\^(GDAXI|FCHI|STOXX50E)/.test(s)) return ['17:30', 'Europe/Berlin'];
  if (/\.CO$/.test(s)) return ['17:00', 'Europe/Copenhagen'];
  if (/\.SW$/.test(s)) return ['17:30', 'Europe/Zurich'];
  if (/\.T$|^\^N225/.test(s)) return ['15:30', 'Asia/Tokyo'];
  if (/\.KS$|^\^KS11/.test(s)) return ['15:30', 'Asia/Seoul'];
  if (/\.HK$|^\^HSI/.test(s)) return ['16:00', 'Asia/Hong_Kong'];
  if (/\.SS$/.test(s)) return ['15:00', 'Asia/Shanghai'];
  if (/\.TW$/.test(s)) return ['13:30', 'Asia/Taipei'];
  if (/\.NS$|^\^NSEI/.test(s)) return ['15:30', 'Asia/Kolkata'];
  if (/\.AX$|^\^AXJO/.test(s)) return ['16:00', 'Australia/Sydney'];
  if (/^\^BVSP/.test(s)) return ['17:00', 'America/Sao_Paulo'];
  if (/\.SR$/.test(s)) return ['15:00', 'Asia/Riyadh'];
  if (/\.QA$/.test(s)) return ['13:15', 'Asia/Qatar'];
  return ['16:00', 'America/New_York'];
}
const addEv = (type, list, hhmm, tz, ar, en) => list.split(' ').forEach(d => MK_EV.push({ type, t: zoned(d, hhmm, tz), ar, en }));
addEv('fed', '2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18 2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 2025-10-29 2025-12-10 2026-01-28 2026-03-18 2026-04-29 2026-06-17 2026-07-29 2026-09-16 2026-10-28 2026-12-09', '14:00', 'America/New_York', 'قرار الفائدة من الاحتياطي الفيدرالي', 'Federal Reserve rate decision');
addEv('ecb', '2024-01-25 2024-03-07 2024-04-11 2024-06-06 2024-07-18 2024-09-12 2024-10-17 2024-12-12 2025-01-30 2025-03-06 2025-04-17 2025-06-05 2025-07-24 2025-09-11 2025-10-30 2025-12-18 2026-02-05 2026-03-19 2026-04-30 2026-06-11 2026-07-23 2026-09-10 2026-10-29 2026-12-17', '14:15', 'Europe/Berlin', 'قرار الفائدة من البنك المركزي الأوروبي', 'ECB rate decision');
addEv('cpi', '2024-01-11 2024-02-13 2024-03-12 2024-04-10 2024-05-15 2024-06-12 2024-07-11 2024-08-14 2024-09-11 2024-10-10 2024-11-13 2024-12-11 2025-01-15 2025-02-12 2025-03-12 2025-04-10 2025-05-13 2025-06-11 2025-07-15 2025-08-12 2025-09-11 2025-10-24 2025-12-18', '08:30', 'America/New_York', 'التضخم الأمريكي (CPI)', 'US inflation (CPI)');
addEv('nfp', '2024-01-05 2024-02-02 2024-03-08 2024-04-05 2024-05-03 2024-06-07 2024-07-05 2024-08-02 2024-09-06 2024-10-04 2024-11-01 2024-12-06 2025-01-10 2025-02-07 2025-03-07 2025-04-04 2025-05-02 2025-06-06 2025-07-03 2025-08-01 2025-09-05 2025-11-20 2025-12-16', '08:30', 'America/New_York', 'الوظائف الأمريكية (NFP)', 'US jobs report (NFP)');
[['boj','2024-03-19T03:30','رفع بنك اليابان الفائدة لأول مرة منذ 17 عاماً','Bank of Japan ends negative rates'],['boj','2024-07-31T03:30','بنك اليابان يرفع الفائدة إلى 0.25%','Bank of Japan hikes to 0.25%'],['boj','2025-01-24T03:30','بنك اليابان يرفع الفائدة إلى 0.5%','Bank of Japan hikes to 0.5%'],
 ['shock','2024-08-05T00:00','الانهيار العالمي وتفكيك صفقات الين','Global sell-off and yen carry-trade unwind'],['shock','2024-11-06T06:00','نتيجة الانتخابات الأمريكية','US election result'],['shock','2025-01-27T00:00','صدمة ديب سيك على أسهم الذكاء الاصطناعي','DeepSeek shock to AI stocks'],
 ['shock','2025-04-02T20:15','الرسوم الجمركية الشاملة («يوم التحرير»)','Sweeping US tariffs ("Liberation Day")'],['shock','2025-04-09T17:20','تعليق الرسوم الجمركية 90 يوماً','90-day tariff pause'],['shock','2025-05-12T02:00','الهدنة التجارية الأمريكية الصينية في جنيف','US-China trade truce in Geneva'],
 ['shock','2025-06-13T00:30','الضربات الإسرائيلية على إيران','Israeli strikes on Iran'],['shock','2025-06-22T00:30','الضربات الأمريكية على المنشآت النووية الإيرانية','US strikes on Iranian nuclear sites']
].forEach(([type, ts, ar, en]) => MK_EV.push({ type, t: Date.parse(ts + ':00Z'), ar, en }));

const P1 = Math.floor(Date.parse('2023-12-01T00:00:00Z') / 1000);
let mkCache = { t: 0, data: null }, mkPending = null;
const MK_ST = { phase: 'idle', done: 0, total: 0, ok: 0, yahoo: 0, stooq: 0, last: '' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ydaily(sym) {
  if (MK_ST.yahoo === 0 && MK_ST.yfail >= 8) return null; // Yahoo is blocking this server: go straight to the backup source
  for (const host of ['query1', 'query2']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const j = JSON.parse(await getText(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=${P1}&period2=${Math.floor(Date.now() / 1000) + 86400}`, 8000));
        const r = j && j.chart && j.chart.result && j.chart.result[0]; if (!r || !r.timestamp) break;
        const off = (r.meta && r.meta.gmtoffset) || 0, cl = r.indicators.quote[0].close, out = [];
        r.timestamp.forEach((t, i) => { if (Number.isFinite(cl[i]) && cl[i] > 0) out.push([new Date((t + off) * 1000).toISOString().slice(0, 10), cl[i]]); });
        const res = out.filter((x, i) => i === 0 || x[0] !== out[i - 1][0]); if (res.length) { MK_ST.yahoo++; return res; } break;
      } catch (e) { MK_ST.last = 'yahoo ' + sym + ': ' + e.message; if (String(e.message) === '429' && attempt === 0 && MK_ST.yahoo > 0) { await sleep(1200); continue; } break; }
    }
  }
  MK_ST.yfail = (MK_ST.yfail || 0) + 1;
  return null;
}
/* backup source: Stooq daily history */
function stooqSym(s) {
  const M = { '^GSPC': '^spx', '^NDX': '^ndx', '^DJI': '^dji', '^N225': '^nkx', '^HSI': '^hsi', '^GDAXI': '^dax', '^FCHI': '^cac', '^FTSE': '^ukx', '000001.SS': '^shc', '^KS11': '^kospi', 'GC=F': 'gc.f', 'SI=F': 'si.f', 'BZ=F': 'cb.f', 'NG=F': 'ng.f', 'HG=F': 'hg.f', 'EURUSD=X': 'eurusd', 'JPY=X': 'usdjpy', 'DX-Y.NYB': 'dx.f', 'BTC-USD': 'btcusd', 'ETH-USD': 'ethusd', '^TNX': '10usy.b' };
  if (M[s]) return M[s];
  if (/^[A-Z]{1,5}(-[A-Z])?$/.test(s)) return s.toLowerCase() + '.us';
  const m = /^(.+)\.(L|DE|PA|HK|T)$/.exec(s); if (m) return { L: m[1].toLowerCase() + '.uk', DE: m[1].toLowerCase() + '.de', PA: m[1].toLowerCase() + '.fr', HK: String(+m[1]) + '.hk', T: m[1] + '.jp' }[m[2]];
  return null;
}
async function sdaily(sym) {
  const q = stooqSym(sym); if (!q) return null;
  try {
    const csv = await getText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(q)}&i=d&d1=20231201&d2=20301231`, 9000);
    const out = csv.trim().split(/\r?\n/).slice(1).map(l => l.split(',')).filter(r => /^\d{4}-\d\d-\d\d$/.test(r[0]) && +r[4] > 0).map(r => [r[0], +r[4]]);
    if (out.length > 40) { MK_ST.stooq++; return out; }
  } catch (e) { MK_ST.last = 'stooq ' + sym + ': ' + e.message; }
  return null;
}
async function daily(sym) { const d = (await ydaily(sym)) || (await sdaily(sym)); MK_ST.done++; if (d) MK_ST.ok++; return d; }
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); await sleep(150); } })); return out; }
async function liveWeekEvents() {
  try {
    const j = JSON.parse(await getText('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 10000)); const now = Date.now(), out = [];
    (Array.isArray(j) ? j : []).forEach(e => { const t = Date.parse(e.date); if (!t || e.impact !== 'High' || t > now - 20 * 6e4) return;
      const ti = String(e.title || ''), c = e.country;
      const type = c === 'USD' && /CPI|PCE|PPI/i.test(ti) ? 'cpi' : c === 'USD' && /Federal Funds|FOMC/i.test(ti) ? 'fed' : c === 'USD' && /Non-Farm|Employment Change/i.test(ti) ? 'nfp' : c === 'EUR' && /Refinancing|Deposit|Monetary Policy/i.test(ti) ? 'ecb' : c === 'JPY' && /Policy Rate|BOJ/i.test(ti) ? 'boj' : 'week';
      if (MK_EV.some(x => x.type === type && Math.abs(x.t - t) < 36e5 * 6)) return;
      out.push({ type, t, ar: `${ti} (${c})`, en: `${ti} (${c})`, live: true, f: e.forecast || '', pr: e.previous || '' }); });
    return out;
  } catch (e) { return []; }
}
function react(series, closes, t) {
  let lo = 1, hi = series.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (closes[m] > t) { i = m; hi = m - 1; } else lo = m + 1; }
  if (i < 1 || closes[i] - t > 6 * 864e5 || t - closes[i - 1] > 8 * 864e5) return null;
  return { d: series[i][0], v: (series[i][1] / series[i - 1][1] - 1) * 100 };
}
async function buildReactions() {
  const syms = MK_ASSETS.map(a => a[0]);
  Object.assign(MK_ST, { phase: 'building', done: 0, total: syms.length, ok: 0, yahoo: 0, yfail: 0, stooq: 0, started: Date.now() });
  const ser = await pool(syms, 6, daily), now = Date.now();
  const vol = {}, ok = {}, cls = {};
  syms.forEach((s, i) => { const d = ser[i]; if (!d || d.length < 40) return; ok[s] = d; const [hm, tz] = closeSpec(s); cls[s] = d.map(x => zoned(x[0], hm, tz)); const r = []; for (let k = 1; k < d.length; k++) r.push(d[k][1] / d[k - 1][1] - 1); const m = r.reduce((a, b) => a + b, 0) / r.length; vol[s] = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * 100; });
  const evs = MK_EV.filter(e => e.t < now - 20 * 6e4).concat(await liveWeekEvents()).sort((a, b) => b.t - a.t);
  const events = evs.map((e, n) => { const rows = {};
    MK_ASSETS.forEach(([s]) => { const d = ok[s]; if (!d) return; const r = react(d, cls[s], e.t); if (r) rows[s] = [+r.v.toFixed(2), +(r.v / vol[s]).toFixed(2), r.d]; });
    return { id: n + '-' + e.type + '-' + e.t, type: e.type, t: e.t, ar: e.ar, en: e.en, live: !!e.live, f: e.f || '', pr: e.pr || '', rows }; }).filter(e => Object.keys(e.rows).length >= 5);
  return { at: now, assets: MK_ASSETS.filter(a => ok[a[0]]).map(a => a.slice(0, 4)), vol: Object.fromEntries(Object.entries(vol).map(([k, v]) => [k, +v.toFixed(2)])), events };
}
const MK_FILE = path.join(require('os').tmpdir(), 'figurdiscover-reactions.json');
try { const c = JSON.parse(fs.readFileSync(MK_FILE, 'utf8')); if (c && c.data && c.data.events && c.data.events.length) mkCache = c; } catch (e) { /* no saved copy yet */ }
function startBuild() {
  if (mkPending) return mkPending;
  mkPending = buildReactions().then(d => {
    if (d.events.length) { mkCache = { t: Date.now(), data: d }; try { fs.writeFileSync(MK_FILE, JSON.stringify(mkCache)); } catch (e) {} }
    MK_ST.phase = d.events.length ? 'ready' : 'failed'; MK_ST.at = Date.now(); return d;
  }).catch(e => { MK_ST.phase = 'failed'; MK_ST.last = String(e && e.message); }).finally(() => { mkPending = null; });
  return mkPending;
}
/* returns cached data at once; never makes a visitor wait for the full download */
function reactions() {
  if ((!mkCache.data || Date.now() - mkCache.t > 3 * 36e5) && !(MK_ST.phase === 'failed' && Date.now() - (MK_ST.at || 0) < 120000)) startBuild();
  return mkCache.data || null;
}
setTimeout(startBuild, 4000);               // warm up right after the server starts
setInterval(startBuild, 3 * 36e5);          // refresh every 3 hours
/* ---------- PRO check: asks Supabase (with the visitor's own login token) whether they hold an active subscription ---------- */
/* ---------- Firebase login check (verifies the visitor's Firebase ID token with Google's public keys) ---------- */
const crypto = require('crypto');
const FBP = (() => { try { const h = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); const m = /FIGUR_FIREBASE=\{[^}]*projectId:"([^"]*)"/.exec(h); return process.env.FIREBASE_PROJECT_ID || (m && m[1]) || ''; } catch (e) { return process.env.FIREBASE_PROJECT_ID || ''; } })();
let gKeys = { t: 0, keys: {} };
async function googleKeys() {
  if (Date.now() - gKeys.t < 3 * 36e5 && Object.keys(gKeys.keys).length) return gKeys.keys;
  const j = JSON.parse(await getText('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', 8000));
  gKeys = { t: Date.now(), keys: j }; return j;
}
const b64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
async function verifyUser(req) {
  const fail = why => { req._authErr = why; return null; };
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ''); if (!m) return fail('no token'); if (!FBP) return fail('firebase projectId not found in index.html');
  const tok = m[1], parts = tok.split('.'); if (parts.length !== 3) return fail('malformed token');
  try {
    const head = JSON.parse(b64u(parts[0]).toString()), pay = JSON.parse(b64u(parts[1]).toString()), now = Date.now() / 1000;
    if (head.alg !== 'RS256') return fail('alg'); if (pay.aud !== FBP) return fail(`project mismatch: token ${pay.aud} vs server ${FBP}`);
    if (pay.iss !== 'https://securetoken.google.com/' + FBP) return fail('issuer'); if (!pay.sub) return fail('no uid');
    if (pay.exp < now) return fail('token expired (server clock ' + new Date().toISOString() + ')'); if (pay.iat > now + 300) return fail('token from the future: server clock is behind');
    let keys; try { keys = await googleKeys(); } catch (e) { return fail('cannot download Google keys: ' + e.message); } const pem = keys[head.kid]; if (!pem) { gKeys.t = 0; return fail('unknown key id'); }
    const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey(pem), b64u(parts[2]));
    return ok ? { uid: pay.sub, email: String(pay.email || '').toLowerCase(), verified: pay.email_verified === true, token: tok } : fail('bad signature');
  } catch (e) { return fail('error: ' + e.message); }
}
/* ---------- Manual payments: receipts uploaded by users, approved by the admin from the site (#admin) ----------
   Data is kept in DATA_DIR (Railway Volume mounted at /data recommended, otherwise it resets on each deploy). */
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(require('os').tmpdir(), 'fd-data'));
const RCPT_DIR = path.join(DATA_DIR, 'receipts');
try { fs.mkdirSync(RCPT_DIR, { recursive: true }); } catch (e) {}
const STORE_FILE = path.join(DATA_DIR, 'store.json');
let STORE = { receipts: [], subs: {}, scalp: {}, trials: {} };
try { const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); if (j && j.receipts && j.subs) STORE = Object.assign(STORE, j); } catch (e) {}
STORE.scalp = STORE.scalp || {}; STORE.trials = STORE.trials || {};
const TRIAL_HOURS = +process.env.TRIAL_HOURS || 3;
function saveStore() { try { fs.writeFileSync(STORE_FILE + '.tmp', JSON.stringify(STORE)); fs.renameSync(STORE_FILE + '.tmp', STORE_FILE); } catch (e) { console.error('store save failed', e.message); } }
const persistent = DATA_DIR === '/data' || !!process.env.DATA_DIR;
const envList = n => String(process.env[n] || '').split(/[,;\s]+/).map(x => x.replace(/^["'<]+|[>"']+$/g, '').trim()).filter(Boolean);
function adminList() { return envList('ADMIN_EMAILS').map(x => x.toLowerCase()); }
/* site owner: ADMIN_EMAILS (verified email) or ADMIN_UIDS (Firebase User UID — works even if the email is not verified) */
function isAdminU(u) { return !!u && ((u.verified && !!u.email && adminList().includes(u.email)) || envList('ADMIN_UIDS').includes(u.uid)); }
async function verifyAdmin(req) { const u = await verifyUser(req); return isAdminU(u) ? u : null; }
function storeSub(email) { const s = STORE.subs[email]; return s && Date.parse(s.until) > Date.now() ? s : null; }
function storeScalp(email) { const s = STORE.scalp[email]; return s && Date.parse(s.until) > Date.now() ? s : null; }
function trialOf(uid) { const t = STORE.trials[uid]; return t && Date.parse(t.until) > Date.now() ? t : null; }
const scCache = new Map();
async function hasScalper(req) {
  const u = await verifyUser(req); if (!u) return false;
  if (isAdminU(u)) return true;
  if (trialOf(u.uid)) return true;
  return !!(u.email && storeScalp(u.email));
}

/* ---------- PayPal: checks the visitor's subscription directly with PayPal (Railway variables PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, optional PAYPAL_PLAN_ID, PAYPAL_ENV=sandbox for testing) ---------- */
const PP_API = process.env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
let ppTok = { t: 0, v: '' };
async function ppToken() {
  if (ppTok.v && Date.now() < ppTok.t) return ppTok.v;
  const id = process.env.PAYPAL_CLIENT_ID, sec = process.env.PAYPAL_CLIENT_SECRET; if (!id || !sec) return '';
  const r = await fetch(PP_API + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + sec).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!r.ok) return ''; const j = await r.json(); ppTok = { v: j.access_token, t: Date.now() + Math.max(60, (j.expires_in || 3000) - 120) * 1000 }; return ppTok.v;
}
async function ppActive(subId, uid) {
  if (!/^I-[A-Z0-9]{6,}$/.test(String(subId || ''))) return false;
  const tok = await ppToken(); if (!tok) return false;
  const r = await fetch(`${PP_API}/v1/billing/subscriptions/${encodeURIComponent(subId)}`, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) return false; const s = await r.json();
  if (s.custom_id !== uid) return false;                                   // the subscription must belong to this site account
  if (process.env.PAYPAL_PLAN_ID && s.plan_id !== process.env.PAYPAL_PLAN_ID) return false;
  return s.status === 'ACTIVE';                                            // ACTIVE covers the $1 trial and paid months
}
async function fsDoc(u, coll) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FBP}/databases/(default)/documents/${coll}/${encodeURIComponent(u.uid)}`, { headers: { Authorization: 'Bearer ' + u.token } });
  return r.ok ? (((await r.json()) || {}).fields || {}) : null;
}
/* ---------- PRO check: a manual grant in Firestore subscriptions/{uid}, or an ACTIVE PayPal subscription saved in paypal/{uid} ---------- */
const proCache = new Map();
async function isPro(req, fresh) {
  const u = await verifyUser(req); if (!u) return false;
  // site owner / admins: Railway variable ADMIN_EMAILS = comma-separated emails (verified emails only)
  if (isAdminU(u)) return true;
  if (u.email && storeSub(u.email)) return true;   // approved from the admin page
  if (trialOf(u.uid)) return true;                  // free trial
  // manual PayPal subscribers: Railway variable PRO_EMAILS = "name@mail.com:2026-12-31, other@mail.com:2027-01-15"
  if (u.email) for (const e of String(process.env.PRO_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean)) {
    const [em, until] = e.split(':'); if (em !== u.email) continue;
    if (!until || Date.parse(until + 'T23:59:59Z') > Date.now()) return true;
  }
  const c = proCache.get(u.uid); if (!fresh && c && Date.now() - c.t < 10 * 6e4) return c.v;
  let v = false;
  try {
    const f = await fsDoc(u, 'subscriptions');
    if (f) { const st = f.status && f.status.stringValue, end = f.current_period_end && (f.current_period_end.timestampValue || f.current_period_end.stringValue);
      v = !!(st && /^(active|trialing)$/.test(st) && (!end || Date.parse(end) > Date.now())); }
    if (!v) { const pp = await fsDoc(u, 'paypal'); const sub = pp && pp.sub && pp.sub.stringValue; if (sub) v = await ppActive(sub, u.uid); }
  } catch (e) { v = false; }
  if (proCache.size > 2000) proCache.clear(); proCache.set(u.uid, { t: Date.now(), v }); return v;
}
/* ---------- PRO: 1-minute candles for the FD Scalper (gold futures GC=F, Nasdaq-100 futures NQ=F ≈ US Tech 100) ---------- */
let calCache = { t: 0, d: null };
const CANDLE_SYM = { gold: ['GC=F', 'XAUUSD=X'], nas: ['NQ=F', '^NDX'] };
const cCache = new Map();
async function candles(asset, tf = '1') {
  tf = tfKey(tf); const ck = asset + '|' + tf, c = cCache.get(ck); if (c && Date.now() - c.t < 25000) return c.d;
  const iv = TF[tf][2], rng = { '1m': '5d', '5m': '1mo', '15m': '1mo', '30m': '1mo', '60m': '6mo', '1d': '5y' }[iv];
  for (const sym of CANDLE_SYM[asset] || []) {
    for (const host of ['query1', 'query2']) {
      try {
        const j = JSON.parse(await getText(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${rng}&includePrePost=true`, 9000));
        const r = j && j.chart && j.chart.result && j.chart.result[0]; if (!r || !r.timestamp) continue;
        const q = r.indicators.quote[0], out = [];
        r.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(Number.isFinite)) out.push([t * 1000, +q.open[i].toFixed(3), +q.high[i].toFixed(3), +q.low[i].toFixed(3), +q.close[i].toFixed(3), q.volume[i] || 0]); });
        let bars = out; if (tf === '240') { const g = []; out.forEach(b => { const k = Math.floor(b[0] / 144e5) * 144e5, L = g[g.length - 1]; if (L && L[0] === k) { L[2] = Math.max(L[2], b[2]); L[3] = Math.min(L[3], b[3]); L[4] = b[4]; L[5] += b[5]; } else g.push([k, b[1], b[2], b[3], b[4], b[5]]); }); bars = g; }
        if (bars.length > 120) { const d = { sym, at: Date.now(), bars: bars.slice(-1200) }; cCache.set(ck, { t: Date.now(), d }); return d; }
      } catch (e) { /* try next */ }
    }
  }
  return c ? c.d : null;
}
/* ---------- Capital.com API (live 1-minute candles at your broker's prices). Railway variables: CAPITAL_API_KEY, CAPITAL_EMAIL, CAPITAL_PASSWORD (the API key's custom password), optional CAPITAL_ENV=live (default demo), CAPITAL_EPIC_NAS (default US100), CAPITAL_EPIC_GOLD (default GOLD) ---------- */
const CAP = { cst: '', xst: '', used: 0, err: '', login: null, okAt: 0, st: new Map() };
const capOn = () => !!(process.env.CAPITAL_API_KEY && process.env.CAPITAL_EMAIL && process.env.CAPITAL_PASSWORD);
const capBase = () => process.env.CAPITAL_BASE || `https://${String(process.env.CAPITAL_ENV || 'demo').toLowerCase() === 'live' ? 'api-capital' : 'demo-api-capital'}.backend-capital.com/api/v1`;
const capEpic = a => a === 'nas' ? (process.env.CAPITAL_EPIC_NAS || 'US100') : (process.env.CAPITAL_EPIC_GOLD || 'GOLD');
function capLogin() {
  if (CAP.login) return CAP.login;
  CAP.login = (async () => {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 10000);
    try {
      const r = await fetch(capBase() + '/session', { method: 'POST', signal: c.signal, headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY.trim(), 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: process.env.CAPITAL_EMAIL.trim(), password: process.env.CAPITAL_PASSWORD, encryptedPassword: false }) });
      if (!r.ok) { let m = ''; try { m = (await r.json()).errorCode || ''; } catch (e) {} CAP.err = 'login ' + r.status + (m ? ' ' + m : ''); CAP.cst = ''; CAP.failAt = Date.now(); throw new Error(CAP.err); }
      CAP.cst = r.headers.get('cst') || ''; CAP.xst = r.headers.get('x-security-token') || ''; CAP.used = Date.now(); CAP.err = '';
    } finally { clearTimeout(t); setTimeout(() => { CAP.login = null; }, 1100); }
  })();
  return CAP.login;
}
async function capGet(p, retry = true) {
  if (!CAP.cst && Date.now() - (CAP.failAt || 0) < 6e4) throw new Error(CAP.err || 'login wait');
  if (!CAP.cst || Date.now() - CAP.used > 8 * 6e4) await capLogin();
  const c = new AbortController(), t = setTimeout(() => c.abort(), 9000);
  try {
    const r = await fetch(capBase() + p, { signal: c.signal, headers: { 'X-CAP-API-KEY': process.env.CAPITAL_API_KEY.trim(), CST: CAP.cst, 'X-SECURITY-TOKEN': CAP.xst } });
    if (r.status === 401 && retry) { CAP.cst = ''; return capGet(p, false); }
    if (!r.ok) { let m = ''; try { m = (await r.json()).errorCode || ''; } catch (e) {} CAP.err = p.split('?')[0] + ' ' + r.status + (m ? ' ' + m : ''); throw new Error(CAP.err); }
    CAP.used = Date.now(); return await r.json();
  } finally { clearTimeout(t); }
}
function capBars(j) {
  const px = o => o ? (Number.isFinite(o.bid) ? o.bid : o.ask) : null;
  return ((j && j.prices) || []).map(p => [Date.parse(String(p.snapshotTimeUTC || p.snapshotTime).replace(/\//g, '-').replace(' ', 'T') + (/Z$/.test(p.snapshotTimeUTC || '') ? '' : 'Z')), px(p.openPrice), px(p.highPrice), px(p.lowPrice), px(p.closePrice), p.lastTradedVolume || 0]).filter(b => b.every(Number.isFinite));
}
/* full history refreshed every 60 s, the newest bars every ~1.5 s while someone is watching */
const TF = { '1': ['MINUTE', 6e4, '1m'], '5': ['MINUTE_5', 3e5, '5m'], '15': ['MINUTE_15', 9e5, '15m'], '30': ['MINUTE_30', 18e5, '30m'], '60': ['HOUR', 36e5, '60m'], '240': ['HOUR_4', 144e5, '60m'], 'D': ['DAY', 864e5, '1d'] };
const tfKey = v => TF[v] ? v : '1';
async function capCandles(asset, tf = '1') {
  tf = tfKey(tf); const epic = capEpic(asset), key = epic + '|' + tf, s = CAP.st.get(key) || { bars: [], full: 0, tail: 0, p: null, epic, ms: TF[tf][1] }; CAP.st.set(key, s);
  if (s.p) { await s.p.catch(() => {}); return s.bars.length ? s : null; }
  const now = Date.now(), needFull = !s.bars.length || now - s.full > 6e4, needTail = now - s.tail > 1500;
  if (needFull || needTail) {
    s.p = (async () => {
      const nb = capBars(await capGet(`/prices/${encodeURIComponent(epic)}?resolution=${TF[tf][0]}&max=${needFull ? 1000 : 3}`));
      if (!nb.length) throw new Error('no prices');
      if (needFull) { s.bars = nb; s.full = Date.now(); }
      else { const B = s.bars; nb.forEach(b => { const i = B.length - 1; if (i >= 0 && B[i][0] === b[0]) B[i] = b; else if (i < 0 || b[0] > B[i][0]) { B.push(b); if (B.length > 1200) B.shift(); } else { const k = B.findIndex(x => x[0] === b[0]); if (k >= 0) B[k] = b; } }); }
      s.tail = Date.now(); CAP.okAt = Date.now();
    })();
    try { await s.p; } catch (e) { if (!CAP.err) CAP.err = String(e.message || e); } finally { s.p = null; }
  }
  return s.bars.length ? s : null;
}
/* Capital.com streaming quotes (WebSocket, needs Node 22+): every price tick moves the current 1-minute bar and is pushed to open charts (Server-Sent Events) */
/* minimal WebSocket client (RFC 6455) so live streaming also works on Node 18/20 where the global WebSocket is missing */
class MiniWS {
  constructor(u) {
    const U = new URL(u), mod = U.protocol === 'wss:' ? require('https') : require('http'), key = crypto.randomBytes(16).toString('base64');
    this.readyState = 0; this.buf = Buffer.alloc(0); this.frag = [];
    const req = mod.request({ hostname: U.hostname, port: U.port || (U.protocol === 'wss:' ? 443 : 80), path: U.pathname + U.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    req.on('upgrade', (res, sock, head) => { this.sock = sock; this.readyState = 1; sock.setNoDelay(true); sock.on('data', d => this._data(d)); sock.on('close', () => this._close()); sock.on('error', () => { try { this.onerror && this.onerror(new Error('socket')); } catch (e) {} });
      if (head && head.length) this._data(head); try { this.onopen && this.onopen(); } catch (e) {} });
    req.on('response', () => { this._fail(); }); req.on('error', () => this._fail()); req.setTimeout(15000, () => { req.destroy(); }); req.end();
  }
  _fail() { if (this.readyState === 3) return; try { this.onerror && this.onerror(new Error('connect')); } catch (e) {} this._close(); }
  _close() { if (this.readyState === 3) return; this.readyState = 3; try { this.sock && this.sock.destroy(); } catch (e) {} try { this.onclose && this.onclose(); } catch (e) {} }
  _frame(op, data) { const p = Buffer.from(data || ''), m = crypto.randomBytes(4), n = p.length; let h;
    if (n < 126) { h = Buffer.alloc(2); h[1] = 0x80 | n; } else if (n < 65536) { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); }
    h[0] = 0x80 | op; const mp = Buffer.alloc(n); for (let i = 0; i < n; i++) mp[i] = p[i] ^ m[i & 3]; try { this.sock.write(Buffer.concat([h, m, mp])); } catch (e) {} }
  send(str) { if (this.readyState === 1) this._frame(1, str); }
  close() { if (this.readyState === 1) this._frame(8, ''); this._close(); }
  _data(d) { this.buf = Buffer.concat([this.buf, d]);
    for (;;) { const b = this.buf; if (b.length < 2) return; const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let n = b[1] & 0x7f, o = 2;
      if (n === 126) { if (b.length < 4) return; n = b.readUInt16BE(2); o = 4; } else if (n === 127) { if (b.length < 10) return; n = Number(b.readBigUInt64BE(2)); o = 10; }
      const mk = masked ? b.slice(o, o + 4) : null; if (masked) o += 4; if (b.length < o + n) return;
      let pl = b.slice(o, o + n); if (mk) { pl = Buffer.from(pl); for (let i = 0; i < pl.length; i++) pl[i] ^= mk[i & 3]; } this.buf = b.slice(o + n);
      if (op === 9) { this._frame(10, pl); continue; } if (op === 10) continue; if (op === 8) { this._close(); return; }
      if (op === 1 || op === 2 || op === 0) { this.frag.push(pl); if (fin) { const msg = Buffer.concat(this.frag); this.frag = []; try { this.onmessage && this.onmessage({ data: msg.toString('utf8') }); } catch (e) {} } } }
  }
}
const WSImpl = typeof WebSocket !== 'undefined' && !process.env.FORCE_MINIWS ? WebSocket : MiniWS;
const CAPS = { ws: null, open: false, clients: new Set(), last: 0, ping: null, retry: 0, idle: null };
function capTick(epic, px, ts) {
  if (!Number.isFinite(px)) return; ts = ts || Date.now(); CAPS.last = Date.now();
  for (const [key, s] of CAP.st) { if (s.epic !== epic || !s.bars.length) continue;
    const B = s.bars, L = B[B.length - 1], ms = s.ms || 6e4; if (ts < L[0]) continue;
    if (ts < L[0] + ms) { L[2] = Math.max(L[2], px); L[3] = Math.min(L[3], px); L[4] = px; }
    else { B.push([L[0] + Math.floor((ts - L[0]) / ms) * ms, L[4], Math.max(L[4], px), Math.min(L[4], px), px, 0]); if (B.length > 1200) B.shift(); }
    const bar = B[B.length - 1];
    const msg = 'data: ' + JSON.stringify(bar) + '\n\n'; for (const c of CAPS.clients) if (c.key === key) { try { c.res.write(msg); } catch (e) {} } }
}
async function capStream() {
  if (CAPS.ws || !capOn()) return;
  try { if (!CAP.cst || Date.now() - CAP.used > 8 * 6e4) await capLogin(); } catch (e) { return; }
  const epics = [capEpic('nas'), capEpic('gold')]; let ws;
  try { ws = new WSImpl(process.env.CAPITAL_STREAM || 'wss://api-streaming-capital.backend-capital.com/connect'); } catch (e) { return; }
  CAPS.ws = ws; const msg = (destination, payload) => JSON.stringify({ destination, correlationId: String(Date.now()), cst: CAP.cst, securityToken: CAP.xst, ...(payload ? { payload } : {}) });
  ws.onopen = () => { CAPS.open = true; CAPS.retry = 0; ws.send(msg('marketData.subscribe', { epics })); clearInterval(CAPS.ping); CAPS.ping = setInterval(() => { try { ws.send(msg('ping')); } catch (e) {} }, 5 * 6e4); };
  ws.onmessage = ev => { let j; try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (e) { return; }
    if (j && j.destination === 'quote' && j.payload) { const q = j.payload; capTick(q.epic, Number.isFinite(q.bid) ? q.bid : q.ofr, q.timestamp); }
    else if (j && j.status && j.status !== 'OK' && j.destination !== 'quote') CAP.err = 'stream ' + (j.payload && j.payload.errorCode || j.status); };
  const done = () => { clearInterval(CAPS.ping); CAPS.ws = null; CAPS.open = false; if (CAPS.clients.size) { CAPS.retry = Math.min(CAPS.retry + 1, 6); setTimeout(capStream, 1500 * CAPS.retry); } };
  ws.onclose = done; ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
function capStreamIdle() { clearTimeout(CAPS.idle); CAPS.idle = setTimeout(() => { if (!CAPS.clients.size && CAPS.ws) { const w = CAPS.ws; w.onclose = null; try { w.close(); } catch (e) {} clearInterval(CAPS.ping); CAPS.ws = null; CAPS.open = false; } }, 3 * 6e4); }
/* ---------- Customer brokerage: each subscriber links THEIR OWN Capital.com account (wallet, buy/sell orders, optional auto-trading of Khamisehawi signals).
   Credentials are encrypted (AES-256-GCM) with Railway variable TRADE_SECRET (or an auto-generated key file in DATA_DIR) and never sent back to the browser. ---------- */
const fdScalpSrv = (() => { try { return require('./indicators/khamisehawi-engine.js'); } catch (e) { console.error('engine missing', e.message); return null; } })();
const BRK_KEY = (() => { if (process.env.TRADE_SECRET) return crypto.createHash('sha256').update(process.env.TRADE_SECRET).digest();
  const f = path.join(DATA_DIR, 'trade.key'); try { return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); } catch (e) {}
  const k = crypto.randomBytes(32); try { fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 }); } catch (e) {} return k; })();
const encS = o => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', BRK_KEY, iv), d = Buffer.concat([c.update(JSON.stringify(o), 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.'); };
const decS = s => { const [iv, tag, d] = String(s).split('.').map(x => Buffer.from(x, 'base64')); const c = crypto.createDecipheriv('aes-256-gcm', BRK_KEY, iv); c.setAuthTag(tag); return JSON.parse(Buffer.concat([c.update(d), c.final()]).toString('utf8')); };
STORE.brokers = STORE.brokers || {};
const BRK = new Map(); // uid -> live client (sessions are memory only)
function brkClient(uid) {
  const rec = STORE.brokers[uid]; if (!rec || !rec.enc) return null;
  let c = BRK.get(uid); if (c && c.encRef === rec.enc) return c;
  let cr; try { cr = decS(rec.enc); } catch (e) { return null; }
  c = { encRef: rec.enc, cr, live: !!rec.live, cst: '', xst: '', used: 0, login: null, failAt: 0, err: '', st: new Map(), mk: new Map() };
  c.base = () => process.env.CAPITAL_USER_BASE || `https://${c.live ? 'api-capital' : 'demo-api-capital'}.backend-capital.com/api/v1`;
  BRK.set(uid, c); return c;
}
async function brkLogin(c) {
  if (c.login) return c.login;
  c.login = (async () => { const ac = new AbortController(), t = setTimeout(() => ac.abort(), 10000);
    try { const r = await fetch(c.base() + '/session', { method: 'POST', signal: ac.signal, headers: { 'X-CAP-API-KEY': c.cr.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: c.cr.id, password: c.cr.pw, encryptedPassword: false }) });
      if (!r.ok) { let m = ''; try { m = (await r.json()).errorCode || ''; } catch (e) {} c.err = 'login ' + r.status + (m ? ' ' + m : ''); c.cst = ''; c.failAt = Date.now(); throw new Error(c.err); }
      c.cst = r.headers.get('cst') || ''; c.xst = r.headers.get('x-security-token') || ''; c.used = Date.now(); c.err = '';
    } finally { clearTimeout(t); setTimeout(() => { c.login = null; }, 1100); } })();
  return c.login;
}
async function brkReq(c, method, p, body, retry = true) {
  if (!c.cst && Date.now() - c.failAt < 6e4) throw new Error(c.err || 'login wait');
  if (!c.cst || Date.now() - c.used > 8 * 6e4) await brkLogin(c);
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(c.base() + p, { method, signal: ac.signal, headers: { 'X-CAP-API-KEY': c.cr.key, CST: c.cst, 'X-SECURITY-TOKEN': c.xst, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (r.status === 401 && retry) { c.cst = ''; return brkReq(c, method, p, body, false); }
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const e = new Error((j && j.errorCode) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    c.used = Date.now(); return j || {};
  } finally { clearTimeout(t); }
}
async function brkConfirm(c, ref) { for (let k = 0; k < 4; k++) { try { const j = await brkReq(c, 'GET', '/confirms/' + encodeURIComponent(ref)); if (j && j.dealStatus) return j; } catch (e) {} await sleep(600); } return null; }
async function brkMarket(c, epic) { const m = c.mk.get(epic); if (m && Date.now() - m.t < 30 * 6e4) return m.d;
  const j = await brkReq(c, 'GET', '/markets/' + encodeURIComponent(epic)); const dr = j.dealingRules || {}, sn = j.snapshot || {};
  const d = { epic, name: (j.instrument && j.instrument.name) || epic, min: dr.minDealSize && dr.minDealSize.value, step: dr.minSizeIncrement && dr.minSizeIncrement.value, minStop: dr.minStopOrProfitDistance && dr.minStopOrProfitDistance.value, status: sn.marketStatus, bid: sn.bid, offer: sn.offer, dec: sn.decimalPlacesFactor };
  c.mk.set(epic, { t: Date.now(), d }); return d; }
/* candles for the bot: the site's own Capital feed when configured, otherwise the customer's session */
async function brkBars(c, asset) {
  if (capOn()) { try { const s = await capCandles(asset); if (s && s.bars.length > 300) return s.bars; } catch (e) {} }
  const epic = capEpic(asset), s = c.st.get(epic) || { bars: [], full: 0 }; c.st.set(epic, s);
  const full = !s.bars.length || Date.now() - s.full > 6e4, nb = capBars(await brkReq(c, 'GET', `/prices/${encodeURIComponent(epic)}?resolution=MINUTE&max=${full ? 1000 : 3}`));
  if (full) { s.bars = nb; s.full = Date.now(); } else nb.forEach(b => { const B = s.bars, i = B.length - 1; if (i >= 0 && B[i][0] === b[0]) B[i] = b; else if (i < 0 || b[0] > B[i][0]) B.push(b); });
  return s.bars;
}
function brkLog(rec, ar, en, kind = 'info') { rec.log = rec.log || []; rec.log.unshift({ t: Date.now(), ar, en, kind }); rec.log = rec.log.slice(0, 80); }
function brkEntitled(rec) { const e = rec.email; return isAdminU({ uid: rec.uid, email: e, verified: rec.verified }) || !!trialOf(rec.uid) || !!(e && storeScalp(e)); }
const BOT_DEF = { on: false, assets: { gold: true, nas: false }, size: { gold: 0, nas: 0 }, quality: 2, maxDay: 5, maxBars: 30, be: true };
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
async function brkOpen(c, rec, o) { // o: {asset, dir, size, sl, tp, src}
  const epic = capEpic(o.asset), body = { epic, direction: o.dir, size: +o.size, guaranteedStop: false };
  if (Number.isFinite(o.sl) && o.sl > 0) body.stopLevel = round(o.sl); if (Number.isFinite(o.tp) && o.tp > 0) body.profitLevel = round(o.tp);
  const j = await brkReq(c, 'POST', '/positions', body); const cf = j.dealReference ? await brkConfirm(c, j.dealReference) : null;
  if (!cf || cf.dealStatus !== 'ACCEPTED') { const why = (cf && (cf.reason || cf.status)) || 'no confirmation'; throw new Error('rejected: ' + why); }
  const dealId = (cf.affectedDeals && cf.affectedDeals[0] && cf.affectedDeals[0].dealId) || cf.dealId; return { dealId, level: cf.level, ref: j.dealReference };
}
let botBusy = false;
async function botLoop() {
  if (botBusy || !fdScalpSrv) return; botBusy = true; let dirty = false;
  try {
    const minute = Math.floor(Date.now() / 6e4) * 6e4, today = new Date().toISOString().slice(0, 10);
    for (const [uid, rec] of Object.entries(STORE.brokers)) {
      const bot = rec.bot; if (!bot || (!bot.on && !Object.values(rec.deals || {}).some(Boolean))) continue;
      const c = brkClient(uid); if (!c) continue;
      if (bot.on && !brkEntitled(rec)) { bot.on = false; brkLog(rec, 'أُوقف التداول الآلي: انتهى اشتراك المؤشر.', 'Auto-trading stopped: indicator subscription ended.', 'warn'); dirty = true; continue; }
      rec.deals = rec.deals || {}; rec.sig = rec.sig || {}; if (!rec.day || rec.day.d !== today) rec.day = { d: today, n: 0 };
      try {
        /* 1) manage open bot trades: closed by SL/TP? move stop to break-even at TP1, time exit after maxBars minutes */
        if (Object.values(rec.deals).some(Boolean)) {
          const pos = (await brkReq(c, 'GET', '/positions')).positions || [];
          for (const a of Object.keys(rec.deals)) { const d = rec.deals[a]; if (!d) continue; const p = pos.find(x => x.position && x.position.dealId === d.dealId);
            if (!p) { rec.deals[a] = null; brkLog(rec, `أُغلقت صفقة ${a === 'nas' ? 'US100' : 'الذهب'} (${d.dir === 'BUY' ? 'شراء' : 'بيع'}) عند الوقف أو الهدف.`, `${a === 'nas' ? 'US100' : 'Gold'} ${d.dir} trade closed at stop or target.`); dirty = true; continue; }
            const px = d.dir === 'BUY' ? p.market.bid : p.market.offer;
            if (bot.be && !d.be && Number.isFinite(px) && (d.dir === 'BUY' ? px >= d.t1 : px <= d.t1)) { try { await brkReq(c, 'PUT', '/positions/' + d.dealId, { stopLevel: round(d.level), profitLevel: round(d.t2) }); d.be = true; brkLog(rec, `تحقق الهدف الأول: نُقل الوقف إلى سعر الدخول ${round(d.level)}.`, `TP1 reached: stop moved to entry ${round(d.level)}.`, 'good'); dirty = true; } catch (e) { brkLog(rec, 'تعذّر نقل الوقف: ' + e.message, 'Could not move stop: ' + e.message, 'warn'); } }
            if (Date.now() - d.at > (bot.maxBars || 30) * 6e4) { try { await brkReq(c, 'DELETE', '/positions/' + d.dealId); rec.deals[a] = null; brkLog(rec, `أُغلقت الصفقة بعد ${bot.maxBars || 30} دقيقة (خروج زمني كما في المؤشر).`, `Closed after ${bot.maxBars || 30} minutes (time exit, as in the indicator).`); dirty = true; } catch (e) {} } }
        }
        /* 2) new signals on the last CLOSED 1-minute candle */
        if (bot.on) for (const a of ['gold', 'nas']) {
          if (!bot.assets[a] || !(bot.size[a] > 0)) continue;
          const all = await brkBars(c, a), bars = all.filter(b => b[0] < minute).map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
          if (bars.length < 300) continue; const lastT = bars[bars.length - 1].t; if (rec.sig[a] === lastT) continue;
          const R = fdScalpSrv(bars, { asset: a, quality: bot.quality || 2, session: true }), s = R.signals[R.signals.length - 1]; rec.sig[a] = lastT; dirty = true;
          if (!s || s.t !== lastT || minute - lastT > 2 * 6e4) continue;
          const nm = a === 'nas' ? 'US100' : 'الذهب', dir = s.d > 0 ? 'BUY' : 'SELL';
          if (rec.deals[a]) { brkLog(rec, `إشارة ${dir === 'BUY' ? 'شراء' : 'بيع'} ${nm} تجاهلتها: توجد صفقة مفتوحة.`, `${dir} signal on ${a} skipped: a trade is already open.`); continue; }
          if (rec.day.n >= (bot.maxDay || 5)) { brkLog(rec, `إشارة ${nm} تجاهلتها: وصلت للحد اليومي (${bot.maxDay} صفقات).`, `Signal skipped: daily limit (${bot.maxDay}) reached.`, 'warn'); continue; }
          try { const r = await brkOpen(c, rec, { asset: a, dir, size: bot.size[a], sl: s.sl, tp: s.t2 });
            rec.deals[a] = { dealId: r.dealId, dir, level: r.level || s.ent, sl: s.sl, t1: s.t1, t2: s.t2, at: Date.now(), be: false }; rec.day.n++;
            brkLog(rec, `فُتحت صفقة ${dir === 'BUY' ? 'شراء' : 'بيع'} ${nm} بحجم ${bot.size[a]} عند ${round(r.level || s.ent)} · وقف ${round(s.sl)} · هدف ${round(s.t2)}.`, `Opened ${dir} ${a} size ${bot.size[a]} @ ${round(r.level || s.ent)} · SL ${round(s.sl)} · TP ${round(s.t2)}.`, 'good');
          } catch (e) { brkLog(rec, `فشل تنفيذ إشارة ${nm}: ${e.message}`, `Signal order failed: ${e.message}`, 'bad'); }
        }
        rec.fails = 0;
      } catch (e) {
        rec.fails = (rec.fails || 0) + 1; if (rec.fails === 1 || rec.fails % 20 === 0) brkLog(rec, 'خطأ في الاتصال بالحساب: ' + e.message, 'Account connection error: ' + e.message, 'bad');
        if (rec.fails >= 60 && bot.on) { bot.on = false; brkLog(rec, 'أُوقف التداول الآلي بسبب تكرار أخطاء الاتصال. راجع بيانات الربط.', 'Auto-trading stopped after repeated connection errors.', 'bad'); }
        dirty = true;
      }
    }
  } finally { botBusy = false; if (dirty) saveStore(); }
}
/* auto-trading removed: orders are placed only by the user. Switch off any bot left from an older version. */
{ let ch = false; for (const r of Object.values(STORE.brokers)) if (r.bot && r.bot.on) { r.bot.on = false; ch = true; } if (ch) saveStore(); }
const brkHits = new Map();
async function brokerRoutes(req, res, url) {
  const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const u = await verifyUser(req); if (!u) return send({ error: 'login' }, 401);
  if (!(await hasScalper(req))) return send({ error: 'pro' }, 403);
  const p = url.pathname, rec = STORE.brokers[u.uid];
  let b = {}; if (req.method === 'POST') { try { b = JSON.parse(await readBody(req, 20000) || '{}'); } catch (e) { return send({ error: 'bad json' }, 400); } }
  try {
    if (p === '/api/broker/link' && req.method === 'POST') {
      const h = (brkHits.get(u.uid) || []).filter(t => Date.now() - t < 36e5); if (h.length >= 8) return send({ error: 'too many attempts, try later' }, 429); h.push(Date.now()); brkHits.set(u.uid, h);
      const key = String(b.apiKey || '').trim(), id = String(b.identifier || '').trim(), pw = String(b.password || ''), live = b.env === 'live';
      if (!key || !id || !pw) return send({ error: 'missing' }, 400); if (live && b.ack !== true) return send({ error: 'ack' }, 400);
      const old = STORE.brokers[u.uid];
      STORE.brokers[u.uid] = { uid: u.uid, email: u.email, verified: u.verified, live, enc: encS({ key, id, pw }), idMask: id.replace(/^(.{2}).*(@.*)$/, '$1***$2'), linkedAt: Date.now(), bot: (old && old.bot) || JSON.parse(JSON.stringify(BOT_DEF)), deals: (old && old.deals) || {}, log: (old && old.log) || [] };
      BRK.delete(u.uid); const c = brkClient(u.uid);
      try { await brkLogin(c); await brkReq(c, 'GET', '/accounts'); } catch (e) { delete STORE.brokers[u.uid]; if (old) STORE.brokers[u.uid] = old; BRK.delete(u.uid); return send({ error: 'login_failed', detail: e.message }, 400); }
      brkLog(STORE.brokers[u.uid], `رُبط حساب Capital.com ${live ? 'الحقيقي' : 'التجريبي'}.`, `Linked Capital.com ${live ? 'live' : 'demo'} account.`, 'good'); saveStore(); return send({ ok: true });
    }
    if (!rec) return send({ linked: false, secret: !!process.env.TRADE_SECRET, persistent });
    const c = brkClient(u.uid); if (!c) return send({ linked: false, error: 'decrypt' });
    if (p === '/api/broker/unlink' && req.method === 'POST') { if (rec.bot) rec.bot.on = false; delete STORE.brokers[u.uid]; BRK.delete(u.uid); saveStore(); return send({ ok: true }); }
    if (p === '/api/broker/summary') {
      const [acc, pos] = await Promise.all([brkReq(c, 'GET', '/accounts'), brkReq(c, 'GET', '/positions')]);
      const a = (acc.accounts || []).find(x => x.preferred) || (acc.accounts || [])[0] || null;
      const mk = {}; for (const k of ['gold', 'nas']) { try { mk[k] = await brkMarket(c, capEpic(k)); } catch (e) { mk[k] = { epic: capEpic(k), error: e.message }; } }
      const botIds = new Set(Object.values(rec.deals || {}).filter(Boolean).map(d => d.dealId));
      return send({ linked: true, live: rec.live, id: rec.idMask, account: a && { id: a.accountId, name: a.accountName, currency: a.currency, balance: a.balance && a.balance.balance, available: a.balance && a.balance.available, pnl: a.balance && a.balance.profitLoss, deposit: a.balance && a.balance.deposit },
        positions: (pos.positions || []).map(x => ({ dealId: x.position.dealId, epic: x.market.epic, name: x.market.instrumentName, dir: x.position.direction, size: x.position.size, level: x.position.level, sl: x.position.stopLevel, tp: x.position.profitLevel, upl: x.position.upl, ccy: x.position.currency, at: x.position.createdDateUTC, bid: x.market.bid, offer: x.market.offer, bot: botIds.has(x.position.dealId) })),
        markets: mk, bot: rec.bot, day: rec.day || null, log: (rec.log || []).slice(0, 40), persistent, epics: { gold: capEpic('gold'), nas: capEpic('nas') } });
    }
    if (p === '/api/broker/order' && req.method === 'POST') {
      const asset = b.asset === 'nas' ? 'nas' : 'gold', dir = b.dir === 'SELL' ? 'SELL' : 'BUY', size = +b.size;
      if (!(size > 0)) return send({ error: 'size' }, 400);
      const r = await brkOpen(c, rec, { asset, dir, size, sl: +b.sl, tp: +b.tp });
      brkLog(rec, `أمر يدوي: ${dir === 'BUY' ? 'شراء' : 'بيع'} ${asset === 'nas' ? 'US100' : 'الذهب'} بحجم ${size} عند ${round(r.level)}.`, `Manual ${dir} ${asset} size ${size} @ ${round(r.level)}.`, 'good'); saveStore();
      return send({ ok: true, ...r });
    }
    if (p === '/api/broker/close' && req.method === 'POST') {
      const id = String(b.dealId || ''); if (!/^[\w-]{1,80}$/.test(id)) return send({ error: 'id' }, 400);
      await brkReq(c, 'DELETE', '/positions/' + encodeURIComponent(id)); for (const k of Object.keys(rec.deals || {})) if (rec.deals[k] && rec.deals[k].dealId === id) rec.deals[k] = null;
      brkLog(rec, 'أُغلقت صفقة يدوياً.', 'Position closed manually.'); saveStore(); return send({ ok: true });
    }
    if (p === '/api/broker/bot') return send({ error: 'auto-trading is not available' }, 410);
    if (false) {
      const bot = rec.bot = Object.assign(JSON.parse(JSON.stringify(BOT_DEF)), rec.bot || {});
      if (b.on === true && !rec.botAck && b.ack !== true) return send({ error: 'ack' }, 400); if (b.on === true) rec.botAck = true;
      if (typeof b.on === 'boolean' && b.on !== bot.on) { bot.on = b.on; brkLog(rec, b.on ? 'شُغّل التداول الآلي.' : 'أُوقف التداول الآلي.', b.on ? 'Auto-trading ON.' : 'Auto-trading OFF.', b.on ? 'good' : 'info'); if (b.on) rec.sig = {}; }
      if (b.assets) for (const k of ['gold', 'nas']) if (typeof b.assets[k] === 'boolean') bot.assets[k] = b.assets[k];
      if (b.size) for (const k of ['gold', 'nas']) if (Number.isFinite(+b.size[k]) && +b.size[k] >= 0) bot.size[k] = +b.size[k];
      if ([1, 2, 3, 4].includes(+b.quality)) bot.quality = +b.quality; if (+b.maxDay >= 1 && +b.maxDay <= 50) bot.maxDay = Math.round(+b.maxDay);
      if (+b.maxBars >= 5 && +b.maxBars <= 240) bot.maxBars = Math.round(+b.maxBars); if (typeof b.be === 'boolean') bot.be = b.be;
      saveStore(); return send({ ok: true, bot });
    }
    return send({ error: 'not found' }, 404);
  } catch (e) { return send({ error: 'broker', detail: e.message }, 502); }
}
/* ---------- Owner AI trading bot (owner's own accounts only) ----------
   Signals: Khamisehawi engine on closed 1-minute candles + TradingView webhook alerts.
   Filter: Claude (ANTHROPIC_API_KEY) approves or rejects each trade with a confidence score; rule-based score when no key.
   Guards: daily trade limit, max open trades, news blackout around high-impact events.
   Venues: paper (simulation), Capital.com (owner's linked account), MetaTrader 5 / CFI (EA polls this server), Binance USDⓈ-M futures (BTC). */
STORE.bot = Object.assign({ on: false, mode: 'paper', ai: true, minConf: 65, maxDay: 6, maxOpen: 2, blackout: 15, quality: 2, maxMin: 30, be: true,
  venues: { capital: false, mt5: false, binance: false },
  assets: { gold: { on: true, size: 0.5, mt5: 'XAUUSD', lot: 0.01 }, nas: { on: false, size: 0.5, mt5: 'US100', lot: 0.1 }, btc: { on: false, qty: 0.002, mt5: 'BTCUSD', lot: 0.01 } } }, STORE.bot || {});
STORE.botLog = STORE.botLog || []; STORE.botQ = STORE.botQ || []; STORE.botPaper = STORE.botPaper || { open: {}, closed: [] }; STORE.botLive = STORE.botLive || {};
STORE.botDay = STORE.botDay || { d: '', n: 0 }; STORE.botSig = STORE.botSig || {}; STORE.botMt5 = STORE.botMt5 || { seen: 0, acct: '' }; STORE.botTv = STORE.botTv || [];
if (!STORE.botKey) { STORE.botKey = crypto.randomBytes(18).toString('hex'); saveStore(); }
const botKey = () => process.env.BOT_KEY || STORE.botKey;
const BOT_NM = { gold: ['الذهب', 'Gold'], nas: ['US100', 'US100'], btc: ['بيتكوين', 'Bitcoin'] };
function botLog(ar, en, kind = 'info') { STORE.botLog.unshift({ t: Date.now(), ar, en, kind }); STORE.botLog = STORE.botLog.slice(0, 300); }
async function botCal() {
  if (calCache.d && Date.now() - calCache.t < 30 * 6e4) return calCache.d;
  try { const j = JSON.parse(await getText('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 10000)); if (Array.isArray(j) && j.length) calCache = { t: Date.now(), d: j }; } catch (e) {}
  return calCache.d || [];
}
async function botBars(asset) {
  if (asset === 'btc') { const k = JSON.parse(await getText('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=600', 9000)); return k.map(x => [x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]); }
  const s = await capCandles(asset, '1'); return s ? s.bars : [];
}
function botTech(B) { // compact readings for the AI / rule filter
  const C = B.map(b => b[4]), n = C.length, ema = (p) => { const k = 2 / (p + 1); let e = C[0]; for (let i = 1; i < n; i++) e = C[i] * k + e * (1 - k); return e; };
  let g = 0, l = 0; for (let i = n - 14; i < n; i++) { const d = C[i] - C[i - 1]; if (d > 0) g += d; else l -= d; } const rsi = l ? 100 - 100 / (1 + g / l) : 100;
  const e12 = ema(12), e26 = ema(26), e50 = ema(50), e200 = ema(Math.min(200, n - 1)); let atr = 0; for (let i = n - 14; i < n; i++) atr += Math.max(B[i][2] - B[i][3], Math.abs(B[i][2] - C[i - 1]), Math.abs(B[i][3] - C[i - 1])); atr /= 14;
  const ch = (k) => C[n - 1] - C[n - 1 - k];
  return { price: C[n - 1], rsi14: +rsi.toFixed(1), macd: +(e12 - e26).toFixed(4), ema50: +e50.toFixed(2), ema200: +e200.toFixed(2), atr14: +atr.toFixed(4), chg5m: +ch(5).toFixed(3), chg15m: +ch(15).toFixed(3), chg60m: +ch(60).toFixed(3) };
}
async function botNews(asset) { const now = Date.now(), win = (STORE.bot.blackout || 15) * 6e4, cur = asset === 'btc' ? ['USD'] : ['USD'];
  const ev = (await botCal()).filter(e => e.impact === 'High' && cur.includes(e.country)).map(e => ({ t: Date.parse(e.date), title: e.title, f: e.forecast, p: e.previous, a: e.actual })).filter(e => e.t);
  return { block: ev.find(e => Math.abs(e.t - now) <= win) || null, upcoming: ev.filter(e => e.t > now && e.t - now < 6 * 36e5).slice(0, 4) }; }
async function botJudge(asset, c, tech, news) {
  const ruleConf = () => { const d = c.dir === 'BUY' ? 1 : -1; let a = 0; if ((tech.ema50 - tech.ema200) * d > 0) a++; if (tech.macd * d > 0) a++; if (d > 0 ? tech.rsi14 < 72 : tech.rsi14 > 28) a++; if (tech.chg15m * d > 0) a++; return { take: a >= 3, conf: 35 + a * 15, reason: `rules ${a}/4`, by: 'rules' }; };
  const key = process.env.ANTHROPIC_API_KEY; if (!STORE.bot.ai || !key) return ruleConf();
  const prompt = `You are a strict risk filter for a short-term trading bot. A ${c.src} signal proposes ${c.dir} ${asset.toUpperCase()} at ${c.ent} (stop ${c.sl}, target ${c.tp}). Market readings (1-minute chart): ${JSON.stringify(tech)}. Upcoming high-impact US news (next 6h): ${JSON.stringify(news.upcoming)}.
Decide whether to TAKE or SKIP this trade. Be conservative: skip when readings conflict, momentum is against the trade, or major news is close. Reply with JSON only: {"decision":"take"|"skip","confidence":0-100,"reason":"max 15 words"}`;
  try {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ac.signal, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }) });
    clearTimeout(t); const j = await r.json(); const txt = (j.content || []).map(x => x.text || '').join(''); const m = /\{[\s\S]*\}/.exec(txt); const o = m ? JSON.parse(m[0]) : null;
    if (!o) throw new Error('no json'); return { take: o.decision === 'take', conf: Math.max(0, Math.min(100, +o.confidence || 0)), reason: String(o.reason || '').slice(0, 160), by: 'ai' };
  } catch (e) { const r = ruleConf(); r.reason += ' (AI unavailable: ' + e.message + ')'; return r; }
}
function ownerBroker() { for (const [uid, rec] of Object.entries(STORE.brokers || {})) if (isAdminU({ uid, email: rec.email, verified: rec.verified })) return uid; return null; }
/* Binance USDⓈ-M futures (BTCUSDT). BINANCE_KEY / BINANCE_SECRET; testnet unless BINANCE_TESTNET=0. Note: Binance refuses US servers — run Railway in an EU/Asia region. */
async function bnReq(method, p, params) {
  const base = process.env.BINANCE_TESTNET === '0' ? 'https://fapi.binance.com' : 'https://testnet.binancefuture.com';
  const q = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 }).toString(), sig = crypto.createHmac('sha256', process.env.BINANCE_SECRET || '').update(q).digest('hex');
  const r = await fetch(`${base}${p}?${q}&signature=${sig}`, { method, headers: { 'X-MBX-APIKEY': process.env.BINANCE_KEY || '' } }); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.msg) || 'HTTP ' + r.status); return j;
}
async function bnOpen(dir, qty, sl, tp) {
  const side = dir === 'BUY' ? 'BUY' : 'SELL', opp = side === 'BUY' ? 'SELL' : 'BUY', px = v => (Math.round(v * 10) / 10).toFixed(1);
  const o = await bnReq('POST', '/fapi/v1/order', { symbol: 'BTCUSDT', side, type: 'MARKET', quantity: qty });
  try { await bnReq('POST', '/fapi/v1/order', { symbol: 'BTCUSDT', side: opp, type: 'STOP_MARKET', stopPrice: px(sl), closePosition: 'true', workingType: 'MARK_PRICE' }); } catch (e) { botLog('تعذّر وضع وقف Binance: ' + e.message, 'Binance stop failed: ' + e.message, 'bad'); }
  try { await bnReq('POST', '/fapi/v1/order', { symbol: 'BTCUSDT', side: opp, type: 'TAKE_PROFIT_MARKET', stopPrice: px(tp), closePosition: 'true', workingType: 'MARK_PRICE' }); } catch (e) { botLog('تعذّر وضع هدف Binance: ' + e.message, 'Binance target failed: ' + e.message, 'bad'); }
  return o;
}
async function botExecute(asset, c, j) {
  const B = STORE.bot, A = B.assets[asset], nm = BOT_NM[asset], dTxt = c.dir === 'BUY' ? ['شراء', 'BUY'] : ['بيع', 'SELL'];
  const head = `${dTxt[0]} ${nm[0]} @ ${round(c.ent)} · SL ${round(c.sl)} · TP ${round(c.tp)}`, headE = `${dTxt[1]} ${nm[1]} @ ${round(c.ent)} · SL ${round(c.sl)} · TP ${round(c.tp)}`;
  const why = ` (${j.by === 'ai' ? 'AI' : 'rules'} ${j.conf}% — ${j.reason})`;
  if (B.mode === 'paper') { STORE.botPaper.open[asset] = { asset, dir: c.dir, ent: c.ent, sl: c.sl, tp: c.tp, t1: c.t1, at: Date.now(), be: false, src: c.src }; botLog('📝 تجريبي: ' + head + why, '📝 Paper: ' + headE + why, 'good'); return; }
  let done = 0;
  if (B.venues.capital && asset !== 'btc') { const uid = ownerBroker(), cl = uid && brkClient(uid);
    if (!cl) botLog('Capital.com: اربط حسابك من صفحة المؤشر (المحفظة والتداول) أولاً.', 'Capital.com: link your account in the wallet first.', 'warn');
    else { try { const r = await brkOpen(cl, STORE.brokers[uid], { asset, dir: c.dir, size: A.size, sl: c.sl, tp: c.tp }); STORE.botLive[asset] = { dealId: r.dealId, uid, dir: c.dir, level: r.level || c.ent, t1: c.t1, tp: c.tp, at: Date.now(), be: false }; done++; botLog('✅ Capital.com: ' + head + why, '✅ Capital.com: ' + headE + why, 'good'); } catch (e) { botLog('Capital.com رفض الأمر: ' + e.message, 'Capital.com rejected: ' + e.message, 'bad'); } } }
  if (B.venues.mt5) { const it = { id: crypto.randomBytes(6).toString('hex'), t: Date.now(), asset, sym: A.mt5, dir: c.dir, lot: A.lot, slDist: +Math.abs(c.ent - c.sl).toFixed(5), tpDist: +Math.abs(c.tp - c.ent).toFixed(5), beDist: B.be ? +Math.abs(c.t1 - c.ent).toFixed(5) : 0, maxMin: B.maxMin || 30, st: 'new' };
    STORE.botQ.unshift(it); STORE.botQ = STORE.botQ.slice(0, 200); done++; botLog(`📨 MT5: أُرسل للمنصة ${A.mt5} ${dTxt[0]} ${A.lot} لوت` + why, `📨 MT5: sent ${A.mt5} ${dTxt[1]} ${A.lot} lot` + why, 'good'); }
  if (B.venues.binance && asset === 'btc') { try { await bnOpen(c.dir, A.qty, c.sl, c.tp); done++; botLog('✅ Binance: ' + head + why, '✅ Binance: ' + headE + why, 'good'); } catch (e) { botLog('Binance رفض الأمر: ' + e.message, 'Binance rejected: ' + e.message, 'bad'); } }
  if (!done) botLog('لم يُنفَّذ: لا توجد منصة مفعّلة لهذه الأداة.', 'Not executed: no venue enabled for this instrument.', 'warn');
}
async function botConsider(asset, c, last) {
  const B = STORE.bot, today = new Date().toISOString().slice(0, 10); if (STORE.botDay.d !== today) STORE.botDay = { d: today, n: 0 };
  const nm = BOT_NM[asset], dTxt = c.dir === 'BUY' ? 'شراء' : 'بيع';
  const open = Object.values(STORE.botPaper.open).filter(Boolean).length + Object.values(STORE.botLive).filter(Boolean).length;
  if ((B.mode === 'paper' ? STORE.botPaper.open[asset] : STORE.botLive[asset])) return botLog(`تجاهلت إشارة ${dTxt} ${nm[0]}: توجد صفقة مفتوحة.`, `Skipped ${c.dir} ${nm[1]}: a trade is already open.`);
  if (STORE.botDay.n >= B.maxDay) return botLog(`تجاهلت إشارة ${nm[0]}: وصل الحد اليومي (${B.maxDay}).`, `Skipped: daily limit (${B.maxDay}) reached.`, 'warn');
  if (open >= B.maxOpen) return botLog(`تجاهلت إشارة ${nm[0]}: الحد الأقصى للصفقات المفتوحة (${B.maxOpen}).`, `Skipped: max open trades (${B.maxOpen}).`, 'warn');
  const news = await botNews(asset);
  if (news.block) return botLog(`تجاهلت إشارة ${nm[0]}: خبر مهم قريب (${news.block.title}).`, `Skipped ${nm[1]}: high-impact news nearby (${news.block.title}).`, 'warn');
  const tech = botTech(last), j = await botJudge(asset, c, tech, news);
  if (!j.take || j.conf < B.minConf) return botLog(`🧠 رفض ${j.by === 'ai' ? 'الذكاء الاصطناعي' : 'الفلتر'} ${dTxt} ${nm[0]} (ثقة ${j.conf}%): ${j.reason}`, `🧠 ${j.by === 'ai' ? 'AI' : 'Filter'} rejected ${c.dir} ${nm[1]} (${j.conf}%): ${j.reason}`);
  STORE.botDay.n++; await botExecute(asset, c, j);
}
async function botManage() {
  const B = STORE.bot;
  for (const [a, p] of Object.entries(STORE.botPaper.open)) { if (!p) continue; let bars; try { bars = await botBars(a); } catch (e) { continue; } const L = bars[bars.length - 1]; if (!L) continue;
    const px = L[4], hiSL = p.dir === 'BUY' ? L[3] <= p.sl : L[2] >= p.sl, hiTP = p.dir === 'BUY' ? L[2] >= p.tp : L[3] <= p.tp;
    if (!p.be && B.be && (p.dir === 'BUY' ? L[2] >= p.t1 : L[3] <= p.t1)) { p.be = true; p.sl = p.ent; }
    const exit = hiSL ? p.sl : hiTP ? p.tp : Date.now() - p.at > (B.maxMin || 30) * 6e4 ? px : null;
    if (exit != null) { const r = (p.dir === 'BUY' ? exit - p.ent : p.ent - exit), risk = Math.abs(p.ent - (p.be ? p.ent : p.sl)) || Math.abs(p.ent - p.tp) / 2;
      STORE.botPaper.closed.unshift({ ...p, exit, pts: +r.toFixed(4), out: Date.now(), why: hiSL ? (p.be ? 'BE' : 'SL') : hiTP ? 'TP' : 'time' }); STORE.botPaper.closed = STORE.botPaper.closed.slice(0, 500); STORE.botPaper.open[a] = null;
      botLog(`📝 أُغلقت التجريبية ${BOT_NM[a][0]}: ${r >= 0 ? '+' : ''}${round(r)} نقطة (${hiSL ? (p.be ? 'التعادل' : 'الوقف') : hiTP ? 'الهدف' : 'الوقت'})`, `📝 Paper ${BOT_NM[a][1]} closed: ${r >= 0 ? '+' : ''}${round(r)} pts`, r >= 0 ? 'good' : 'bad'); } }
  for (const [a, d] of Object.entries(STORE.botLive)) { if (!d) continue; const cl = brkClient(d.uid); if (!cl) { STORE.botLive[a] = null; continue; }
    try { const pos = (await brkReq(cl, 'GET', '/positions')).positions || [], p = pos.find(x => x.position && x.position.dealId === d.dealId);
      if (!p) { STORE.botLive[a] = null; botLog(`أُغلقت صفقة ${BOT_NM[a][0]} في Capital.com (وقف أو هدف).`, `${BOT_NM[a][1]} closed on Capital.com.`); continue; }
      const px = d.dir === 'BUY' ? p.market.bid : p.market.offer;
      if (B.be && !d.be && (d.dir === 'BUY' ? px >= d.t1 : px <= d.t1)) { try { await brkReq(cl, 'PUT', '/positions/' + d.dealId, { stopLevel: round(d.level), profitLevel: round(d.tp) }); d.be = true; botLog('نُقل الوقف لسعر الدخول.', 'Stop moved to entry.', 'good'); } catch (e) {} }
      if (Date.now() - d.at > (B.maxMin || 30) * 6e4) { await brkReq(cl, 'DELETE', '/positions/' + d.dealId); STORE.botLive[a] = null; botLog(`أُغلقت ${BOT_NM[a][0]} بعد ${B.maxMin} دقيقة.`, `Closed after ${B.maxMin} min.`); }
    } catch (e) {} }
}
let botBusy2 = false;
async function botTick() {
  if (botBusy2) return; botBusy2 = true;
  try {
    const B = STORE.bot; await botManage();
    while (STORE.botTv.length) { const c = STORE.botTv.shift(); if (!B.on) { botLog('وصل تنبيه TradingView والبوت متوقف.', 'TradingView alert received while the bot is off.'); continue; }
      try { const bars = await botBars(c.asset), L = bars.slice(-300); const t = botTech(L), ent = t.price, d = c.dir === 'BUY' ? 1 : -1, sl = c.sl || ent - d * 1.2 * t.atr14, tp = c.tp || ent + d * 2.4 * t.atr14;
        await botConsider(c.asset, { dir: c.dir, ent, sl, tp, t1: ent + d * Math.abs(ent - sl), src: 'TradingView' }, L); } catch (e) { botLog('تنبيه TradingView: ' + e.message, 'TradingView alert: ' + e.message, 'bad'); } }
    if (B.on && fdScalpSrv) { const minute = Math.floor(Date.now() / 6e4) * 6e4;
      for (const a of ['gold', 'nas', 'btc']) { if (!B.assets[a] || !B.assets[a].on) continue;
        let all; try { all = await botBars(a); } catch (e) { continue; } const closed = all.filter(b => b[0] < minute); if (closed.length < 300) continue;
        const lastT = closed[closed.length - 1][0]; if (STORE.botSig[a] === lastT) continue; STORE.botSig[a] = lastT;
        const R = fdScalpSrv(closed.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] })), { asset: a === 'btc' ? 'gold' : a, quality: B.quality || 2, session: a !== 'btc' }), s = R.signals[R.signals.length - 1];
        if (s && s.t === lastT) await botConsider(a, { dir: s.d > 0 ? 'BUY' : 'SELL', ent: s.ent, sl: s.sl, tp: s.t2, t1: s.t1, src: 'Khamisehawi' }, closed); }
    }
  } catch (e) { botLog('خطأ في البوت: ' + e.message, 'Bot error: ' + e.message, 'bad'); }
  finally { botBusy2 = false; saveStore(); }
}
setInterval(() => { botTick().catch(() => {}); }, 10000);
function botEA(base) {
  try { return fs.readFileSync(path.join(ROOT, 'indicators', 'Khamisehawi_AI_Bot.mq5'), 'utf8').replace('__SERVER__', base).replace('__KEY__', botKey()); } catch (e) { return null; }
}
async function botRoutes(req, res, url) {
  const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const p = url.pathname, keyOk = () => (url.searchParams.get('key') || req.headers['x-bot-key']) === botKey();
  /* MetaTrader 5 EA */
  if (p === '/api/bot/mt5') { if (!keyOk()) return send({ error: 'key' }, 401); STORE.botMt5 = { seen: Date.now(), acct: String(url.searchParams.get('acct') || '').slice(0, 40) };
    const items = STORE.botQ.filter(x => x.st === 'new' && Date.now() - x.t < 90000); items.forEach(x => { x.st = 'sent'; });
    STORE.botQ.filter(x => x.st === 'new' && Date.now() - x.t >= 90000).forEach(x => { x.st = 'expired'; botLog(`انتهت صلاحية أمر MT5 ${x.sym}: لم تتصل المنصة خلال 90 ثانية.`, `MT5 order ${x.sym} expired: terminal did not poll within 90 s.`, 'warn'); });
    return send({ items: items.map(x => ({ id: x.id, sym: x.sym, dir: x.dir, lot: x.lot, sl: x.slDist, tp: x.tpDist, be: x.beDist, mm: x.maxMin })) }); }
  if (p === '/api/bot/mt5/ack') { if (!keyOk()) return send({ error: 'key' }, 401); let b = {}; try { b = JSON.parse(await readBody(req, 5000) || '{}'); } catch (e) {}
    const it = STORE.botQ.find(x => x.id === b.id); if (it) { it.st = b.ok ? 'filled' : 'failed'; it.ticket = b.ticket; it.err = b.err;
      botLog(b.ok ? `✅ MT5 نفّذ ${it.sym} ${it.dir} (تذكرة ${b.ticket || '—'}) بسعر ${b.price || '—'}` : `MT5 رفض ${it.sym}: ${b.err || ''}`, b.ok ? `✅ MT5 filled ${it.sym} ${it.dir} #${b.ticket || ''}` : `MT5 failed ${it.sym}: ${b.err || ''}`, b.ok ? 'good' : 'bad'); }
    return send({ ok: true }); }
  /* TradingView webhook: message {"action":"buy","asset":"gold"} (optional "sl","tp") or plain text like "buy gold" */
  if (p === '/api/bot/tv') { if (!keyOk()) return send({ error: 'key' }, 401); const raw = await readBody(req, 5000).catch(() => ''); let b = {}; try { b = JSON.parse(raw); } catch (e) { b = { text: raw }; }
    const txt = String(b.action || b.side || b.text || '').toLowerCase() + ' ' + String(b.asset || b.symbol || b.ticker || b.text || '').toLowerCase();
    const dir = /\b(buy|long)\b/.test(txt) ? 'BUY' : /\b(sell|short)\b/.test(txt) ? 'SELL' : null, asset = /xau|gold/.test(txt) ? 'gold' : /nas|us100|ndx|nq|ustec/.test(txt) ? 'nas' : /btc|bitcoin/.test(txt) ? 'btc' : null;
    if (!dir || !asset) return send({ error: 'could not read action/asset', got: txt.slice(0, 80) }, 400);
    STORE.botTv.push({ dir, asset, sl: +b.sl || 0, tp: +b.tp || 0 }); botLog(`📩 تنبيه TradingView: ${dir === 'BUY' ? 'شراء' : 'بيع'} ${BOT_NM[asset][0]}`, `📩 TradingView alert: ${dir} ${BOT_NM[asset][1]}`); setTimeout(() => botTick().catch(() => {}), 50); return send({ ok: true }); }
  /* owner only below */
  const u = await verifyUser(req); if (!isAdminU(u)) return send({ error: 'owner only' }, 403);
  if (p === '/api/bot/state') { const P = STORE.botPaper, cl = P.closed, wins = cl.filter(x => x.pts > 0).length;
    return send({ cfg: STORE.bot, key: botKey(), log: STORE.botLog.slice(0, 120), paper: { open: P.open, closed: cl.slice(0, 50), n: cl.length, wins, pts: cl.reduce((s, x) => s + x.pts, 0) }, live: STORE.botLive, day: STORE.botDay, queue: STORE.botQ.slice(0, 20),
      ready: { capital: !!ownerBroker(), capitalFeed: capOn(), ai: !!process.env.ANTHROPIC_API_KEY, binance: !!(process.env.BINANCE_KEY && process.env.BINANCE_SECRET), binanceTestnet: process.env.BINANCE_TESTNET !== '0', mt5Seen: STORE.botMt5.seen, mt5Acct: STORE.botMt5.acct, persistent } }); }
  if (p === '/api/bot/config' && req.method === 'POST') { let b = {}; try { b = JSON.parse(await readBody(req, 20000) || '{}'); } catch (e) { return send({ error: 'json' }, 400); }
    const B = STORE.bot; if (b.mode === 'live' && B.mode !== 'live' && b.ack !== true) return send({ error: 'ack' }, 400);
    if (['paper', 'live'].includes(b.mode)) { if (b.mode !== B.mode) botLog(b.mode === 'live' ? '⚠️ التحويل إلى التداول الحقيقي.' : 'التحويل إلى الوضع التجريبي.', b.mode === 'live' ? '⚠️ Switched to LIVE trading.' : 'Switched to paper mode.', b.mode === 'live' ? 'warn' : 'info'); B.mode = b.mode; }
    if (typeof b.on === 'boolean' && b.on !== B.on) { B.on = b.on; botLog(b.on ? '▶️ شُغّل البوت.' : '⏸️ أُوقف البوت.', b.on ? '▶️ Bot started.' : '⏸️ Bot stopped.', b.on ? 'good' : 'info'); if (b.on) STORE.botSig = {}; }
    if (typeof b.ai === 'boolean') B.ai = b.ai; for (const k of ['minConf', 'maxDay', 'maxOpen', 'blackout', 'quality', 'maxMin']) if (Number.isFinite(+b[k]) && +b[k] >= 0) B[k] = +b[k]; if (typeof b.be === 'boolean') B.be = b.be;
    if (b.venues) for (const k of ['capital', 'mt5', 'binance']) if (typeof b.venues[k] === 'boolean') B.venues[k] = b.venues[k];
    if (b.assets) for (const k of ['gold', 'nas', 'btc']) { const s = b.assets[k]; if (!s) continue; const A = B.assets[k]; if (typeof s.on === 'boolean') A.on = s.on; for (const f of ['size', 'lot', 'qty']) if (Number.isFinite(+s[f]) && +s[f] >= 0) A[f] = +s[f]; if (typeof s.mt5 === 'string') A.mt5 = s.mt5.trim().slice(0, 30); }
    saveStore(); return send({ ok: true, cfg: B }); }
  if (p === '/api/bot/test' && req.method === 'POST') { const v = url.searchParams.get('v');
    try { if (v === 'capital') { const uid = ownerBroker(); if (!uid) throw new Error('link your Capital.com account in the wallet first'); const a = await brkReq(brkClient(uid), 'GET', '/accounts'); const x = (a.accounts || [])[0] || {}; return send({ ok: true, info: `${x.accountName || ''} · ${x.currency || ''} ${x.balance && x.balance.balance}` }); }
      if (v === 'binance') { const a = await bnReq('GET', '/fapi/v2/balance', {}); const usdt = (a || []).find(x => x.asset === 'USDT'); return send({ ok: true, info: 'USDT ' + (usdt ? usdt.balance : '0') + (process.env.BINANCE_TESTNET === '0' ? '' : ' (testnet)') }); }
      if (v === 'ai') { const j = await botJudge('gold', { dir: 'BUY', ent: 1, sl: 0.9, tp: 1.2, src: 'test' }, { price: 1, rsi14: 50, macd: 0, ema50: 1, ema200: 1, atr14: 0.01, chg5m: 0, chg15m: 0, chg60m: 0 }, { upcoming: [] }); return send({ ok: j.by === 'ai', info: `${j.by} · ${j.conf}% · ${j.reason}` }); }
      if (v === 'tv') { STORE.botTv.push({ dir: 'BUY', asset: 'gold' }); botLog('🧪 تنبيه تجريبي من صفحة البوت.', '🧪 Test alert from the bot page.'); botTick().catch(() => {}); return send({ ok: true, info: 'queued' }); }
      return send({ error: 'venue' }, 400); } catch (e) { return send({ ok: false, error: e.message }); } }
  if (p === '/api/bot/ea') { const base = `https://${req.headers['x-forwarded-host'] || req.headers.host}`; const ea = botEA(base); if (!ea) return send({ error: 'missing' }, 404);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="Khamisehawi_AI_Bot.mq5"', 'Cache-Control': 'no-store' }); return res.end(ea); }
  if (p === '/api/bot/reset-paper' && req.method === 'POST') { STORE.botPaper = { open: {}, closed: [] }; saveStore(); return send({ ok: true }); }
  return send({ error: 'not found' }, 404);
}
/* ---------- AI assistant: forwards signed-in users' questions to Claude with YOUR key (Railway variable ANTHROPIC_API_KEY) ---------- */
function readBody(req, max = 300000) { return new Promise((res, rej) => { let n = 0; const ch = []; req.on('data', d => { n += d.length; if (n > max) { rej(new Error('too big')); req.destroy(); } else ch.push(d); }); req.on('end', () => res(Buffer.concat(ch).toString())); req.on('error', rej); }); }
const aiHits = new Map();
async function aiHandler(req, res) {
  const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (req.method !== 'POST') return send({ error: 'method' }, 405);
  const u = await verifyUser(req); if (!u) return send({ error: 'login' }, 401);
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return send({ error: 'ANTHROPIC_API_KEY is not set' }, 404);
  const h = aiHits.get(u.uid) || []; const now = Date.now(); const recent = h.filter(t => now - t < 36e5); if (recent.length >= 60) return send({ error: 'Too many requests, try again later' }, 429); recent.push(now); aiHits.set(u.uid, recent);
  let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return send({ error: 'bad json' }, 400); }
  const messages = (body.messages || []).filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-12).map(m => ({ role: m.role, content: m.content.slice(0, 30000) }));
  if (!messages.length || messages[0].role !== 'user') return send({ error: 'no messages' }, 400);
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 1500, 200), 2500);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, system: "You are the analysis assistant of figurdiscover.com, a financial and statistical analysis website. Answer in the language of the user's message, clearly and concisely, using Markdown. Never invent numbers that are not in the data. Remind users that results are not binding financial, tax or legal advice.", messages }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return send({ error: (data && data.error && data.error.message) || 'anthropic ' + r.status }, 502);
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return send({ text, truncated: data.stop_reason === 'max_tokens' });
  } catch (e) { return send({ error: 'ai unavailable' }, 502); }
}
function freeView(d) {
  // free visitors: full list of events, but only the 5 strongest reactions of the most recent event
  return { ...d, pro: false, events: d.events.map((e, i) => { if (i > 0) return { ...e, rows: {}, locked: true, n: Object.keys(e.rows).length };
    const top = Object.entries(e.rows).sort((a, b) => Math.abs(b[1][1]) - Math.abs(a[1][1])).slice(0, 5); return { ...e, rows: Object.fromEntries(top), locked: true, n: Object.keys(e.rows).length }; }) };
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

async function payRoutes(req, res, url) {
  const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const p = url.pathname;
  // user: upload a payment receipt
  if (p === '/api/receipt' && req.method === 'POST') {
    const u = await verifyUser(req); if (!u) return send({ error: 'login' }, 401);
    let b; try { b = JSON.parse(await readBody(req, 4500000)); } catch (e) { return send({ error: 'too big' }, 413); }
    const m = /^data:(image\/(jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.file || ''));
    if (!m) return send({ error: 'file' }, 400);
    const buf = Buffer.from(m[3], 'base64'); if (buf.length > 3200000) return send({ error: 'too big' }, 413);
    const pending = STORE.receipts.filter(r => r.uid === u.uid && r.status === 'pending');
    if (pending.length >= 3) return send({ error: 'pending' }, 429);
    const id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex'), ext = m[1] === 'application/pdf' ? 'pdf' : m[2] === 'png' ? 'png' : m[2] === 'webp' ? 'webp' : 'jpg';
    try { fs.writeFileSync(path.join(RCPT_DIR, id + '.' + ext), buf); } catch (e) { return send({ error: 'save' }, 500); }
    const plan = ['pro_week', 'scalper_month', 'bundle'].includes(b.plan) ? b.plan : 'pro_week';
    STORE.receipts.unshift({ id, uid: u.uid, email: u.email, plan, txn: String(b.txn || '').slice(0, 80), note: String(b.note || '').slice(0, 300), file: id + '.' + ext, type: m[1], at: Date.now(), status: 'pending' });
    STORE.receipts = STORE.receipts.slice(0, 2000); saveStore();
    return send({ ok: true, id });
  }
  // user: status of my latest receipt / subscription
  if (p === '/api/receipt/status') {
    const u = await verifyUser(req); if (!u) return send({ error: 'login' }, 401);
    const r = STORE.receipts.find(x => x.uid === u.uid), t = trialOf(u.uid);
    const ps = u.email ? storeSub(u.email) : null, ss = u.email ? storeScalp(u.email) : null;
    const later = (a, b) => (!a ? b : !b ? a : Date.parse(a.until) >= Date.parse(b.until) ? a : b);
    const used = !!STORE.trials[u.uid] || Object.values(STORE.trials).some(x => u.email && x.email === u.email);
    const access = { pro: await isPro(req), scalper: await hasScalper(req) };
    return send({ access, receipt: r ? { status: r.status, plan: r.plan, at: r.at } : null, pro: later(ps, t && { until: t.until, trial: true }), scalper: later(ss, t && { until: t.until, trial: true }), trialUsed: used, sub: ps });
  }
  if (p === '/api/trial/start' && req.method === 'POST') {
    const u = await verifyUser(req); if (!u) return send({ error: 'login' }, 401);
    if (STORE.trials[u.uid] || Object.values(STORE.trials).some(x => u.email && x.email === u.email)) return send({ error: 'used' }, 409);
    STORE.trials[u.uid] = { email: u.email, start: new Date().toISOString(), until: new Date(Date.now() + TRIAL_HOURS * 36e5).toISOString() };
    proCache.delete(u.uid); saveStore(); return send({ ok: true, until: STORE.trials[u.uid].until });
  }
  if (p === '/api/indicator') {
    if (!(await hasScalper(req))) return send({ error: 'pro' }, 403);
    const f = url.searchParams.get('f') === 'mq5' ? 'Khamisehawi_MT5.mq5' : 'Khamisehawi_Indicator.pine';
    try { const buf = fs.readFileSync(path.join(ROOT, 'indicators', f)); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + f + '"', 'Cache-Control': 'no-store' }); return res.end(buf); }
    catch (e) { return send({ error: 'missing' }, 404); }
  }
  // admin
  const a = await verifyAdmin(req); if (!a) return send({ error: 'admin' }, 403);
  if (p === '/api/admin/receipts') {
    const subs = [].concat(Object.entries(STORE.subs).map(([email, s]) => ({ email, product: 'pro', ...s })), Object.entries(STORE.scalp).map(([email, s]) => ({ email, product: 'scalper', ...s })),
      Object.values(STORE.trials).map(t => ({ email: t.email, product: 'pro', until: t.until, trial: true }))).map(x => ({ ...x, active: Date.parse(x.until) > Date.now() })).sort((x, y) => Date.parse(y.until) - Date.parse(x.until)).slice(0, 500);
    return send({ persistent, dataDir: DATA_DIR, receipts: STORE.receipts.slice(0, 300), subs });
  }
  let mm;
  if ((mm = /^\/api\/admin\/receipt\/([a-z0-9]+)\/file$/.exec(p))) {
    const r = STORE.receipts.find(x => x.id === mm[1]); if (!r) return send({ error: 'not found' }, 404);
    try { const buf = fs.readFileSync(path.join(RCPT_DIR, r.file)); res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'no-store' }); return res.end(buf); } catch (e) { return send({ error: 'file missing' }, 404); }
  }
  if (req.method !== 'POST') return send({ error: 'method' }, 405);
  let b = {}; try { b = JSON.parse((await readBody(req, 20000)) || '{}'); } catch (e) {}
  if ((mm = /^\/api\/admin\/receipt\/([a-z0-9]+)\/(approve|reject)$/.exec(p))) {
    const r = STORE.receipts.find(x => x.id === mm[1]); if (!r) return send({ error: 'not found' }, 404);
    if (mm[2] === 'approve') {
      const extend = (bag, days) => { const cur = bag[r.email], base = cur && Date.parse(cur.until) > Date.now() ? Date.parse(cur.until) : Date.now(); bag[r.email] = { until: new Date(base + days * 864e5).toISOString(), plan: r.plan, by: a.email, at: Date.now() }; };
      if (r.plan === 'pro_week' || r.plan === 'bundle' || r.plan === 'trial' || r.plan === 'month') extend(STORE.subs, r.plan === 'month' ? 30 : r.plan === 'trial' ? 3 : 7);
      if (r.plan === 'scalper_month' || r.plan === 'bundle') extend(STORE.scalp, 30);
      r.status = 'approved'; r.days = r.plan === 'scalper_month' ? 30 : 7;
    } else { r.status = 'rejected'; r.reason = String(b.reason || '').slice(0, 200); }
    r.reviewedAt = Date.now(); proCache.clear(); saveStore(); return send({ ok: true });
  }
  if (p === '/api/admin/sub') {
    const email = String(b.email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send({ error: 'email' }, 400);
    const bag = b.product === 'scalper' ? STORE.scalp : STORE.subs;
    if (b.remove) { delete bag[email]; if (b.product !== 'scalper') for (const k of Object.keys(STORE.trials)) if (STORE.trials[k].email === email) STORE.trials[k].until = new Date(0).toISOString(); }
    else { const days = Math.min(400, Math.max(1, +b.days || 7)); const cur = bag[email], base = cur && Date.parse(cur.until) > Date.now() ? Date.parse(cur.until) : Date.now(); bag[email] = { until: new Date(base + days * 864e5).toISOString(), plan: 'manual', by: a.email, at: Date.now() }; }
    proCache.clear(); saveStore(); return send({ ok: true });
  }
  return send({ error: 'unknown' }, 404);
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
  if (url.pathname === '/api/ai') return aiHandler(req, res);
  if (url.pathname.startsWith('/api/receipt') || url.pathname.startsWith('/api/admin/') || url.pathname === '/api/trial/start' || url.pathname === '/api/indicator') return payRoutes(req, res, url);
  if (url.pathname === '/api/pro/refresh') {
    let pro = false; try { for (let k = 0; k < 3 && !pro; k++) { pro = await isPro(req, true); if (!pro && k < 2) await sleep(2500); } } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ pro }));
  }
  if (url.pathname === '/api/calendar') {
    if (!calCache.d || Date.now() - calCache.t > 10 * 6e4) { try { const j = JSON.parse(await getText('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 10000));
        if (Array.isArray(j) && j.length) { let all = j.slice();
          for (const w of ['lastweek', 'nextweek']) { try { const k = JSON.parse(await getText(`https://nfs.faireconomy.media/ff_calendar_${w}.json`, 8000)); if (Array.isArray(k)) all = all.concat(k); } catch (e) {} }
          const seen = new Set(); all = all.filter(e => { const id = e.title + '|' + e.country + '|' + e.date; if (seen.has(id)) return false; seen.add(id); return true; }); calCache = { t: Date.now(), d: all }; } } catch (e) {} }
    res.writeHead(calCache.d ? 200 : 502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(calCache.d || []));
  }
  if (url.pathname === '/api/capital/status') {
    let test = null; if (capOn() && url.searchParams.get('test') === '1') { try { const s = await capCandles('nas'); test = s ? { epic: capEpic('nas'), bars: s.bars.length, last: s.bars[s.bars.length - 1] } : null; } catch (e) {} }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ configured: capOn(), env: String(process.env.CAPITAL_ENV || 'demo').toLowerCase() === 'live' ? 'live' : 'demo', loggedIn: !!CAP.cst, stream: CAPS.open ? 'on' : 'off', node: process.version, lastTick: CAPS.last ? new Date(CAPS.last).toISOString() : null, viewers: CAPS.clients.size, lastOk: CAP.okAt ? new Date(CAP.okAt).toISOString() : null, error: CAP.err || null, epics: { nas: capEpic('nas'), gold: capEpic('gold') }, test }));
  }
  if (url.pathname.startsWith('/api/broker/')) return brokerRoutes(req, res, url);
  if (url.pathname.startsWith('/api/bot/')) return botRoutes(req, res, url);
  if (url.pathname === '/api/stream') {
    const tk = url.searchParams.get('tk'); if (tk && !req.headers.authorization) req.headers.authorization = 'Bearer ' + tk;
    if (!capOn()) { res.writeHead(404); return res.end(); }
    if (!(await hasScalper(req))) { res.writeHead(403); return res.end(); }
    const a = url.searchParams.get('a') === 'nas' ? 'nas' : 'gold', tf = tfKey(url.searchParams.get('tf') || '1'); try { await capCandles(a, tf); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write('retry: 3000\n\n');
    const c = { epic: capEpic(a), key: capEpic(a) + '|' + tf, res, sent: 0, tm: null }; CAPS.clients.add(c); capStream();
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(hb); clearTimeout(c.tm); CAPS.clients.delete(c); if (!CAPS.clients.size) capStreamIdle(); });
    return;
  }
  if (url.pathname === '/api/whoami') {
    const u = await verifyUser(req), em = adminList(), ids = envList('ADMIN_UIDS');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    if (!u) return res.end(JSON.stringify({ signedIn: false, tokenSent: !!req.headers.authorization, authError: req._authErr || '', adminEmailsSet: em.length, adminUidsSet: ids.length }));
    return res.end(JSON.stringify(u ? { signedIn: true, email: u.email, verified: u.verified, uid: u.uid, adminEmailsSet: em.length, adminUidsSet: ids.length, emailListed: em.includes(u.email), uidListed: ids.includes(u.uid), admin: isAdminU(u), pro: await isPro(req), scalper: await hasScalper(req) } : { signedIn: false, adminEmailsSet: em.length, adminUidsSet: ids.length }));
  }
  if (url.pathname === '/api/history') {
    const send = (o, st = 200) => { const b = JSON.stringify(o), gz = /\bgzip\b/.test(req.headers['accept-encoding'] || ''); res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) }); res.end(gz ? zlib.gzipSync(b) : b); };
    if (!(await hasScalper(req))) return send({ error: 'pro' }, 403);
    const a = url.searchParams.get('a') === 'nas' ? 'nas' : 'gold', tf = tfKey(url.searchParams.get('tf') || '1'), to = Math.min(+url.searchParams.get('to') || Date.now(), Date.now()), ms = TF[tf][1];
    if (capOn()) {
      const iso = t => new Date(t).toISOString().slice(0, 19);
      for (const span of [1000, 3000]) { // a second, wider window skips weekends and holidays
        try { const j = await capGet(`/prices/${encodeURIComponent(capEpic(a))}?resolution=${TF[tf][0]}&max=1000&from=${iso(to - span * ms)}&to=${iso(to - 1000)}`);
          const bars = capBars(j).filter(b => b[0] < to); if (bars.length) return send({ src: 'capital', bars: bars.slice(-1000) }); } catch (e) { if (/daterange|range|history/i.test(String(e.message))) break; }
      }
      return send({ src: 'capital', bars: [], end: true });
    }
    if (tf === 'D') { try { const k = 'max|' + a; let c = cCache.get(k);
        if (!c || Date.now() - c.t > 36e5) { const sym = CANDLE_SYM[a][0], j = JSON.parse(await getText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=max`, 12000)), r = j.chart.result[0], q = r.indicators.quote[0], out = [];
          r.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(Number.isFinite)) out.push([t * 1000, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] || 0]); }); c = { t: Date.now(), d: out }; cCache.set(k, c); }
        const bars = c.d.filter(b => b[0] < to); return send({ src: 'yahoo', bars: bars.slice(-2000), end: bars.length <= 2000 }); } catch (e) {} }
    return send({ bars: [], end: true });
  }
  if (url.pathname === '/api/sentiment') {
    const send = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (!(await hasScalper(req))) return send({ error: 'pro' }, 403); if (!capOn()) return send({ error: 'nocap' }, 404);
    const a = url.searchParams.get('a') === 'nas' ? 'nas' : 'gold', epic = capEpic(a), k = 'snt|' + epic, c = CAP.st.get(k);
    if (c && Date.now() - c.t < 3e5) return send(c.d);
    let j = null; try { j = await capGet('/clientsentiment/' + encodeURIComponent(epic)); } catch (e) {}
    if (!j || j.longPositionPercentage == null) { try { const m = await capGet('/markets/' + encodeURIComponent(epic)); const id = m && m.instrument && (m.instrument.marketId || m.instrument.symbol); if (id) j = await capGet('/clientsentiment/' + encodeURIComponent(id)); } catch (e) {} }
    if (!j || j.longPositionPercentage == null) return send({ error: 'unavailable' }, 502);
    const d = { epic, long: +j.longPositionPercentage, short: +j.shortPositionPercentage, at: Date.now() }; CAP.st.set(k, { t: Date.now(), d, epic: '' }); return send(d);
  }
  if (url.pathname === '/api/candles') {
    const send = (o, st = 200) => { const b = JSON.stringify(o), gz = /\bgzip\b/.test(req.headers['accept-encoding'] || ''); res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) }); res.end(gz ? zlib.gzipSync(b) : b); };
    if (!(await hasScalper(req))) return send({ error: 'pro' }, 403);
    const a = url.searchParams.get('a') === 'nas' ? 'nas' : 'gold', tf = tfKey(url.searchParams.get('tf') || '1');
    if (capOn()) {
      try { const s = await capCandles(a, tf); if (s) { const tail = url.searchParams.get('tail') === '1';
        return send({ sym: 'Capital.com ' + capEpic(a) + (String(process.env.CAPITAL_ENV || 'demo').toLowerCase() === 'live' ? '' : ' (demo)'), src: 'capital', live: true, at: Date.now(), bars: tail ? s.bars.slice(-3) : s.bars }); } } catch (e) {}
    }
    if (url.searchParams.get('cap') === '1') return send({ error: 'nocap', capital: capOn() }, 404);
    const d = await candles(a, tf); return d ? send(d) : send({ error: 'data' }, 502);
  }
  if (url.pathname === '/api/reactions') {
    try {
      const d = reactions();
      if (!d) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ building: true, phase: MK_ST.phase, done: MK_ST.done, total: MK_ST.total || MK_ASSETS.length, ok: MK_ST.ok, last: MK_ST.phase === 'failed' ? MK_ST.last : '' })); }
      const pro = await isPro(req);
      const body = JSON.stringify(pro ? { ...d, pro: true } : freeView(d));
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Authorization, Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      return res.end(gz ? zlib.gzipSync(body) : body);
    } catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end('{"events":[]}'); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!rel || BLOCK.test(rel)) rel = 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  sendFile(req, res, file);
}).listen(PORT, '0.0.0.0', () => console.log('figurdiscover listening on ' + PORT));
