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
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ''); if (!m || !FBP) return null;
  const tok = m[1], parts = tok.split('.'); if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(b64u(parts[0]).toString()), pay = JSON.parse(b64u(parts[1]).toString()), now = Date.now() / 1000;
    if (head.alg !== 'RS256' || pay.aud !== FBP || pay.iss !== 'https://securetoken.google.com/' + FBP || !pay.sub || pay.exp < now || pay.iat > now + 300) return null;
    const keys = await googleKeys(); const pem = keys[head.kid]; if (!pem) return null;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey(pem), b64u(parts[2]));
    return ok ? { uid: pay.sub, email: String(pay.email || '').toLowerCase(), verified: pay.email_verified === true, token: tok } : null;
  } catch (e) { return null; }
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
function adminList() { return String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean); }
async function verifyAdmin(req) { const u = await verifyUser(req); return u && u.verified && u.email && adminList().includes(u.email) ? u : null; }
function storeSub(email) { const s = STORE.subs[email]; return s && Date.parse(s.until) > Date.now() ? s : null; }
function storeScalp(email) { const s = STORE.scalp[email]; return s && Date.parse(s.until) > Date.now() ? s : null; }
function trialOf(uid) { const t = STORE.trials[uid]; return t && Date.parse(t.until) > Date.now() ? t : null; }
const scCache = new Map();
async function hasScalper(req) {
  const u = await verifyUser(req); if (!u) return false;
  if (u.verified && u.email && adminList().includes(u.email)) return true;
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
  const admins = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);
  if (u.verified && u.email && admins.includes(u.email)) return true;
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
const CANDLE_SYM = { gold: ['GC=F', 'XAUUSD=X'], nas: ['NQ=F', '^NDX'] };
const cCache = new Map();
async function candles(asset) {
  const c = cCache.get(asset); if (c && Date.now() - c.t < 25000) return c.d;
  for (const sym of CANDLE_SYM[asset] || []) {
    for (const host of ['query1', 'query2']) {
      try {
        const j = JSON.parse(await getText(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=5d&includePrePost=true`, 9000));
        const r = j && j.chart && j.chart.result && j.chart.result[0]; if (!r || !r.timestamp) continue;
        const q = r.indicators.quote[0], out = [];
        r.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(Number.isFinite)) out.push([t * 1000, +q.open[i].toFixed(3), +q.high[i].toFixed(3), +q.low[i].toFixed(3), +q.close[i].toFixed(3), q.volume[i] || 0]); });
        if (out.length > 300) { const d = { sym, at: Date.now(), bars: out }; cCache.set(asset, { t: Date.now(), d }); return d; }
      } catch (e) { /* try next */ }
    }
  }
  return c ? c.d : null;
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
  if (url.pathname === '/api/candles') {
    const send = (o, st = 200) => { const b = JSON.stringify(o), gz = /\bgzip\b/.test(req.headers['accept-encoding'] || ''); res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) }); res.end(gz ? zlib.gzipSync(b) : b); };
    if (!(await hasScalper(req))) return send({ error: 'pro' }, 403);
    const a = url.searchParams.get('a') === 'nas' ? 'nas' : 'gold';
    const d = await candles(a); return d ? send(d) : send({ error: 'data' }, 502);
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
