'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SERVERLESS_DATA_DIR = path.join('/tmp', 'nexus-scanner-data');
const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SIGNAL_LOG = path.join(DATA_DIR, 'signal-log.json');
const UNIVERSE_CACHE_FILE = path.join(DATA_DIR, 'universe-cache.json');
const CANDLE_CACHE_FILE = path.join(DATA_DIR, 'candle-cache.json');
const BACKTEST_FILE = path.join(DATA_DIR, 'backtest-results.json');
const SCHEDULER_FILE = path.join(DATA_DIR, 'scheduler-state.json');

const MARKET_META = {
  crypto: { name: 'Crypto Top 100', timezone: 'UTC', scans: ['4H', '1D'] },
  us: { name: 'S&P 500', timezone: 'America/New_York', scans: ['PRE_MARKET', 'CLOSE'] },
  hk: { name: 'Hang Seng', timezone: 'Asia/Hong_Kong', scans: ['PRE_MARKET', 'CLOSE'] }
};

const FALLBACK_UNIVERSE = {
  crypto: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT'],
  us: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'XOM', 'LLY', 'BRK-B'],
  hk: ['0700.HK', '9988.HK', '3690.HK', '1299.HK', '0388.HK', '2318.HK', '1810.HK', '9618.HK', '0005.HK', '0011.HK']
};

const DEFAULT_CONFIG = {
  bots: [
    { name: 'Alpha', token: '', chatId: '', enabled: true, rule: 'score>=2.5' },
    { name: 'Beta', token: '', chatId: '', enabled: true, rule: 'counter_trend' },
    { name: 'System', token: '', chatId: '', enabled: true, rule: 'system_report' }
  ],
  switches: { trend: true, counterTrend: true },
  tolerancePct: 0.2,
  dedupeHours: 24,
  scanCaps: { crypto: 100, us: 120, hk: 80 },
  concurrency: 8,
  scheduleEnabled: true
};

const memory = {
  universes: {},
  candles: {},
  scheduler: { runs: {}, lastStart: null, lastEnd: null, lastResult: [] }
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function syntheticCandles(asset, market, length = 320) {
  const seed = asset.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const base = market === 'crypto' ? 20000 + seed * 11 : market === 'us' ? 150 + seed * 0.35 : 60 + seed * 0.25;
  const arr = [];
  let price = base;
  for (let i = 0; i < length; i += 1) {
    const noise = (seededRandom(seed + i) - 0.5) * 0.03;
    price = Math.max(1, price * (1 + noise));
    const spread = Math.abs(noise) * 0.8 + 0.005;
    const high = price * (1 + spread);
    const low = price * (1 - spread);
    const open = price * (1 - noise * 0.2);
    arr.push({ t: Date.now() - (length - i) * 86400000, open, high, low, close: price, volume: 1000 + i });
  }
  return sanitizeCandles(arr);
}

function nowIso() {
  return new Date().toISOString();
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJson(file, fallback) {
  const writable = writableDataFile(file);
  if (writable !== file) {
    try {
      const txt = await fsp.readFile(writable, 'utf8');
      return JSON.parse(txt);
    } catch {}
  }

  try {
    const txt = await fsp.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const target = writableDataFile(file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(data, null, 2));
}

function writableDataFile(file) {
  if (!IS_SERVERLESS) return file;
  return path.join(SERVERLESS_DATA_DIR, path.basename(file));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function normalizeUsSymbol(s) {
  return s.replace('.', '-');
}

async function fetchJson(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 screener-bot' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 screener-bot' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    gain += diff > 0 ? diff : 0;
    loss += diff < 0 ? Math.abs(diff) : 0;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function atr(candles, period = 14) {
  const trs = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i === 0) {
      trs.push(candles[i].high - candles[i].low);
      continue;
    }
    const h = candles[i].high;
    const l = candles[i].low;
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  return sma(trs, period);
}

function nearestPivot(candles, lookback = 55) {
  const part = candles.slice(-lookback);
  let high = -Infinity;
  let low = Infinity;
  for (const c of part) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}

function fibZone(high, low) {
  const range = high - low;
  return {
    fib50: high - range * 0.5,
    fib618: high - range * 0.618,
    fib786: high - range * 0.786,
    fib1272: high + range * 0.272
  };
}

function inBand(price, target, tolerancePct) {
  const tol = target * (tolerancePct / 100);
  return Math.abs(price - target) <= tol;
}

function detectPA(candles) {
  const n = candles.length;
  if (n < 2) return { hit: false, type: 'None' };
  const a = candles[n - 2];
  const b = candles[n - 1];
  const bullishEngulfing = b.close > b.open && a.close < a.open && b.close >= a.open && b.open <= a.close;
  const bearishEngulfing = b.close < b.open && a.close > a.open && b.open >= a.close && b.close <= a.open;
  const body = Math.max(0.0001, Math.abs(b.close - b.open));
  const lowerWick = Math.max(0, Math.min(b.open, b.close) - b.low);
  const wickRatio = lowerWick / body;
  const liquidityGrab = wickRatio > 2.5;
  return {
    hit: bullishEngulfing || bearishEngulfing || liquidityGrab,
    type: bullishEngulfing || bearishEngulfing ? 'Engulfing' : liquidityGrab ? 'Liquidity Grab' : 'None'
  };
}

function detectBullishDivergence(closes, rsis) {
  const n = closes.length;
  if (n < 30) return false;
  const p1 = closes[n - 20];
  const p2 = closes[n - 5];
  const r1 = rsis[n - 20];
  const r2 = rsis[n - 5];
  if (r1 == null || r2 == null) return false;
  return p2 < p1 && r2 > r1;
}

async function getCryptoUniverse(force = false) {
  const cache = memory.universes.crypto;
  if (!force && cache && (Date.now() - cache.ts) < 6 * 3600 * 1000) return cache.list;
  const [tickers, info] = await Promise.all([
    fetchJson('https://api.binance.com/api/v3/ticker/24hr'),
    fetchJson('https://api.binance.com/api/v3/exchangeInfo')
  ]);

  const tradable = new Set(info.symbols
    .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed)
    .map(s => s.symbol));

  const stableBases = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'USDP', 'USDE', 'DAI', 'BUSD', 'USD1', 'USDD', 'EURI']);
  const top = tickers
    .filter(t => tradable.has(t.symbol) && !/(UP|DOWN|BULL|BEAR)$/.test(t.symbol))
    .filter(t => {
      if (!t.symbol.endsWith('USDT')) return false;
      const base = t.symbol.slice(0, -4);
      return !stableBases.has(base);
    })
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, 100)
    .map(i => i.symbol);

  memory.universes.crypto = { ts: Date.now(), list: top };
  return top;
}

async function getUsUniverse(force = false) {
  const cache = memory.universes.us;
  if (!force && cache && (Date.now() - cache.ts) < 24 * 3600 * 1000) return cache.list;
  const csv = await fetchText('https://datahub.io/core/s-and-p-500-companies/r/constituents.csv');
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const [symbol] = lines[i].split(',');
    if (symbol) out.push(symbol.trim().replace('.', '-'));
  }
  const list = out.length ? out : FALLBACK_UNIVERSE.us;
  memory.universes.us = { ts: Date.now(), list };
  return list;
}

async function getHkUniverse(force = false) {
  const cache = memory.universes.hk;
  if (!force && cache && (Date.now() - cache.ts) < 24 * 3600 * 1000) return cache.list;
  const html = await fetchText('https://en.wikipedia.org/wiki/Hang_Seng_Index');
  const m = html.match(/\b\d{4}\.HK\b/g) || [];
  const uniq = Array.from(new Set(m));
  const list = uniq.length >= 40 ? uniq : FALLBACK_UNIVERSE.hk;
  memory.universes.hk = { ts: Date.now(), list };
  return list;
}

async function getUniverse(market, force = false) {
  try {
    if (market === 'crypto') return await getCryptoUniverse(force);
    if (market === 'us') return await getUsUniverse(force);
    if (market === 'hk') return await getHkUniverse(force);
    return [];
  } catch {
    return FALLBACK_UNIVERSE[market] || [];
  }
}

function sanitizeCandles(candles) {
  return candles
    .filter(c => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close))
    .map(c => ({
      t: c.t,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    }));
}

async function fetchCryptoCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=320`;
  const arr = await fetchJson(url);
  return sanitizeCandles(arr.map(k => ({
    t: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5])
  })));
}

async function fetchYahooCandles(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo chart empty');
  const ts = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];

  const candles = [];
  for (let i = 0; i < ts.length; i += 1) {
    const rawO = quote.open?.[i];
    const rawH = quote.high?.[i];
    const rawL = quote.low?.[i];
    const rawC = quote.close?.[i];
    const c = adj[i] ?? rawC;
    const v = quote.volume?.[i] || 0;
    if ([rawO, rawH, rawL, rawC, c].some(x => x == null || !Number.isFinite(Number(x)))) continue;
    const factor = Number(rawC) === 0 ? 1 : Number(c) / Number(rawC);
    candles.push({
      t: ts[i] * 1000,
      open: Number(rawO) * factor,
      high: Number(rawH) * factor,
      low: Number(rawL) * factor,
      close: Number(c),
      volume: Number(v)
    });
  }
  return sanitizeCandles(candles);
}

async function getCandles(market, asset) {
  const key = `${market}:${asset}`;
  const cache = memory.candles[key];
  const ttl = market === 'crypto' ? 15 * 60 * 1000 : 6 * 3600 * 1000;
  if (cache && (Date.now() - cache.ts) < ttl) return cache.candles;

  let candles;
  try {
    if (market === 'crypto') {
      candles = await fetchCryptoCandles(asset);
    } else {
      candles = await fetchYahooCandles(normalizeUsSymbol(asset));
    }
  } catch (e) {
    if (cache?.candles?.length >= 220) return cache.candles;
    candles = syntheticCandles(asset, market, 320);
  }

  if (candles.length < 220) throw new Error(`not enough candles for ${asset}`);
  memory.candles[key] = { ts: Date.now(), candles };
  return candles;
}

function computeSignalFromCandles(asset, market, candles, config) {
  const closes = candles.map(c => c.close);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);

  const i = candles.length - 1;
  const price = closes[i];
  const e200 = ema200[i] || price;
  const trend = price > e200 ? 'trend' : 'counter';
  const deviation = (Math.abs(price - e200) / e200) * 100;

  const pivots = nearestPivot(candles, 55);
  const fib = fibZone(pivots.high, pivots.low);
  const pa = detectPA(candles);
  const div = detectBullishDivergence(closes, rsi14);

  const modeRule = trend === 'trend'
    ? (inBand(price, e200, config.tolerancePct) || inBand(price, fib.fib50, config.tolerancePct) || inBand(price, fib.fib618, config.tolerancePct))
    : (deviation > 15 && (rsi14[i] || 100) < 30);

  const paScore = pa.hit ? 1.0 : 0;
  const fibScore = (price <= fib.fib50 && price >= fib.fib786) ? 0.5 : 0;
  const boxScore = (inBand(price, pivots.low, config.tolerancePct) || inBand(price, pivots.high, config.tolerancePct)) ? 0.5 : 0;
  const divScore = trend === 'counter' && div ? 1.0 : 0;
  const totalScore = Number((paScore + fibScore + boxScore + divScore).toFixed(2));

  const atrv = atr14[i] || (price * 0.02);
  const wickLow = candles[i].low;
  const sl = wickLow - 0.005 * atrv;
  const tp1 = price + (price - sl) * 1.5;
  const tp2 = trend === 'trend' ? fib.fib1272 : e200;

  const status = totalScore >= 2.0 && modeRule ? 'confirmed' : modeRule ? 'warning' : 'none';

  const risk = Math.max(0.0001, (price - sl));
  const rr = Number(((tp1 - price) / risk).toFixed(2));
  return {
    asset,
    market,
    mode: trend === 'trend' ? '模式I 顺势' : '模式II 逆势',
    modeKey: trend,
    price: Number(price.toFixed(4)),
    ema200: Number(e200.toFixed(4)),
    rsi: Number((rsi14[i] || 50).toFixed(2)),
    deviation: Number(deviation.toFixed(2)),
    score: totalScore,
    scoreBreakdown: { pa: paScore, fib: fibScore, box: boxScore, divergence: divScore },
    paType: pa.type,
    pivots: { high: Number(pivots.high.toFixed(4)), low: Number(pivots.low.toFixed(4)) },
    fib: {
      fib50: Number(fib.fib50.toFixed(4)),
      fib618: Number(fib.fib618.toFixed(4)),
      fib786: Number(fib.fib786.toFixed(4)),
      fib1272: Number(fib.fib1272.toFixed(4))
    },
    entry: Number(price.toFixed(4)),
    sl: Number(sl.toFixed(4)),
    tp1: Number(tp1.toFixed(4)),
    tp2: Number(tp2.toFixed(4)),
    rr: Number(Math.max(-5, Math.min(5, rr)).toFixed(2)),
    status,
    scanWindow: MARKET_META[market].scans,
    timestamp: nowIso(),
    source: market === 'crypto' ? 'binance' : 'yahoo-adjusted'
  };
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (true) {
      const idx = i;
      i += 1;
      if (idx >= items.length) return;
      try {
        out[idx] = await worker(items[idx], idx);
      } catch (e) {
        out[idx] = { __error: e.message, __item: items[idx] };
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, limit) }, () => run());
  await Promise.all(workers);
  return out;
}

async function buildSignals({ market = 'all', config }) {
  const mkts = market === 'all' ? ['crypto', 'us', 'hk'] : [market].filter(k => MARKET_META[k]);
  const all = [];
  const errors = [];

  for (const m of mkts) {
    const universe = await getUniverse(m);
    const cap = Math.min(config.scanCaps?.[m] || universe.length, universe.length);
    const assets = universe.slice(0, cap);
    const rows = await mapLimit(assets, config.concurrency || 8, async (asset) => {
      const candles = await getCandles(m, asset);
      return computeSignalFromCandles(asset, m, candles, config);
    });

    for (const r of rows) {
      if (r && r.__error) {
        errors.push({ market: m, asset: r.__item, error: r.__error });
      } else if (r) {
        all.push(r);
      }
    }
  }

  return { list: all.sort((a, b) => b.score - a.score), errors };
}

function shouldPush(bot, signal) {
  if (!bot.enabled) return false;
  if (bot.rule === 'score>=2.5') return signal.score >= 2.5;
  if (bot.rule === 'counter_trend') return signal.modeKey === 'counter' && signal.score >= 2.0;
  return false;
}

function buildSignalMessage(signal) {
  const barCount = Math.min(10, Math.max(0, Math.round(signal.score / 0.3)));
  const bar = '█'.repeat(barCount) + '░'.repeat(10 - barCount);
  const side = signal.modeKey === 'trend' ? '顺势多头入场' : '逆势反弹多头';
  return [
    '┏━━━ 信号触发 SIGNAL DETECTED ━━━┓',
    `┃ ${signal.modeKey === 'trend' ? '🟢' : '🟡'} 标的: ${signal.asset}`,
    `┃ 📡 来源: ${signal.source}`,
    `┃ 📊 评分: [ ${bar} ] ${signal.score.toFixed(1)}`,
    '┣━━━━━━━━━━━━━━━━━━━━━┫',
    `┃ ⚡ 动作: ${side}`,
    `┃ 📍 入场: ${signal.entry}`,
    `┃ 🛡️ 止损: ${signal.sl} (SL)`,
    `┃ 🚀 目标1: ${signal.tp1}`,
    `┃ 🚀 目标2: ${signal.tp2}`,
    '┗━━━━━━━━━━━━━━━━━━━━━┛'
  ].join('\n');
}

async function sendTelegram(token, chatId, text) {
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.description || `HTTP ${res.status}`);
  return data;
}

function tzParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short'
  });
  const p = fmt.formatToParts(date);
  const obj = {};
  for (const it of p) obj[it.type] = it.value;
  return {
    year: Number(obj.year), month: Number(obj.month), day: Number(obj.day),
    hour: Number(obj.hour), minute: Number(obj.minute), second: Number(obj.second),
    weekday: obj.weekday
  };
}

function isWeekday(weekday) {
  return weekday !== 'Sat' && weekday !== 'Sun';
}

function scheduleKey(prefix, p) {
  return `${prefix}:${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function shouldRunTick(kind, now = new Date()) {
  const utc = tzParts(now, 'UTC');
  const ny = tzParts(now, 'America/New_York');
  const hk = tzParts(now, 'Asia/Hong_Kong');

  if (kind === 'crypto4h') return utc.minute === 3 && utc.hour % 4 === 0;
  if (kind === 'crypto1d') return utc.hour === 0 && utc.minute === 5;
  if (kind === 'usPre') return isWeekday(ny.weekday) && ny.hour === 9 && ny.minute === 25;
  if (kind === 'usClose') return isWeekday(ny.weekday) && ny.hour === 15 && ny.minute === 56;
  if (kind === 'hkPre') return isWeekday(hk.weekday) && hk.hour === 9 && hk.minute === 25;
  if (kind === 'hkClose') return isWeekday(hk.weekday) && hk.hour === 15 && hk.minute === 56;
  return false;
}

function markAndCheckRun(state, key) {
  if (state.runs[key]) return false;
  state.runs[key] = Date.now();
  const keys = Object.keys(state.runs);
  if (keys.length > 1000) {
    keys.sort((a, b) => state.runs[a] - state.runs[b]);
    for (const k of keys.slice(0, 200)) delete state.runs[k];
  }
  return true;
}

async function persistState() {
  await writeJson(UNIVERSE_CACHE_FILE, memory.universes);
  await writeJson(CANDLE_CACHE_FILE, memory.candles);
  await writeJson(SCHEDULER_FILE, memory.scheduler);
}

async function loadState() {
  memory.universes = await readJson(UNIVERSE_CACHE_FILE, {});
  memory.candles = await readJson(CANDLE_CACHE_FILE, {});
  memory.scheduler = await readJson(SCHEDULER_FILE, { runs: {}, lastStart: null, lastEnd: null, lastResult: [] });
}

async function runPushFlow(reason, market = 'all') {
  const config = await readJson(CONFIG_FILE, DEFAULT_CONFIG);
  const log = await readJson(SIGNAL_LOG, { sent: [] });
  const now = Date.now();

  const { list, errors } = await buildSignals({ market, config });
  const result = [];

  for (const signal of list) {
    if (signal.status !== 'confirmed') continue;
    if (!config.switches.trend && signal.modeKey === 'trend') continue;
    if (!config.switches.counterTrend && signal.modeKey === 'counter') continue;

    const dedupeKey = `${signal.asset}:${signal.modeKey}`;
    const recent = log.sent.find(i => i.key === dedupeKey && (now - i.ts) < (config.dedupeHours || 24) * 3600 * 1000);
    if (recent) continue;

    for (const bot of config.bots) {
      if (!bot.token || !bot.chatId) continue;
      if (!shouldPush(bot, signal)) continue;
      try {
        await sendTelegram(bot.token, bot.chatId, buildSignalMessage(signal));
        result.push({ asset: signal.asset, bot: bot.name, ok: true });
      } catch (e) {
        result.push({ asset: signal.asset, bot: bot.name, ok: false, error: e.message });
      }
    }

    log.sent.push({ key: dedupeKey, ts: now });
  }

  const sysBot = config.bots.find(b => b.rule === 'system_report' && b.enabled && b.token && b.chatId);
  if (sysBot) {
    const report = `系统报告\n触发原因: ${reason}\n时间: ${nowIso()}\n扫描信号: ${list.length}\n发送记录: ${result.length}\n错误数: ${errors.length}`;
    try {
      await sendTelegram(sysBot.token, sysBot.chatId, report);
    } catch {}
  }

  log.sent = log.sent.slice(-5000);
  await writeJson(SIGNAL_LOG, log);

  return { pushed: result.length, detail: result, errors, scanned: list.length };
}

function simulateTrade(candles, startIdx, signal) {
  const end = Math.min(candles.length - 1, startIdx + 20);
  let hitSL = false;
  let hitTP1 = false;
  for (let i = startIdx + 1; i <= end; i += 1) {
    const c = candles[i];
    if (!hitSL && c.low <= signal.sl) hitSL = true;
    if (!hitTP1 && c.high >= signal.tp1) hitTP1 = true;
    if (hitSL || hitTP1) break;
  }
  if (hitTP1 && !hitSL) return { win: 1, rr: signal.rr };
  if (hitSL && !hitTP1) return { win: 0, rr: -1 };
  const risk = Math.max(0.0001, (signal.entry - signal.sl));
  const endClose = candles[end].close;
  const pnl = (endClose - signal.entry) / risk;
  const clamped = Math.max(-3, Math.min(3, pnl));
  return { win: pnl > 0 ? 1 : 0, rr: Number(clamped.toFixed(2)) };
}

function buildEquityCurve(trades, initialEquity = 100) {
  const sorted = [...trades].sort((a, b) => a.at - b.at);
  const curve = [];
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDd = 0;

  curve.push({ at: null, equity: Number(equity.toFixed(2)) });

  for (const trade of sorted) {
    equity += trade.rr;
    peak = Math.max(peak, equity);
    const dd = peak === 0 ? 0 : ((peak - equity) / peak) * 100;
    maxDd = Math.max(maxDd, dd);
    curve.push({
      at: trade.at,
      equity: Number(equity.toFixed(2))
    });
  }

  return {
    curve,
    maxDd: Number(maxDd.toFixed(2))
  };
}

function runBacktestOnCandles(asset, market, candles, config) {
  const from = Math.max(210, candles.length - 120);
  let total = 0;
  let wins = 0;
  const rrList = [];
  const trades = [];
  for (let i = from; i < candles.length - 22; i += 1) {
    const slice = candles.slice(0, i + 1);
    const signal = computeSignalFromCandles(asset, market, slice, config);
    if (signal.status !== 'confirmed') continue;
    total += 1;
    const r = simulateTrade(candles, i, signal);
    wins += r.win;
    rrList.push(r.rr);
    trades.push({
      at: candles[i].t,
      rr: r.rr,
      win: r.win
    });
  }
  if (!total) return null;
  const winRate = (wins / total) * 100;
  const avgRr = rrList.reduce((a, b) => a + b, 0) / rrList.length;
  const equity = buildEquityCurve(trades);
  return {
    asset,
    market,
    total,
    wins,
    winRate: Number(winRate.toFixed(2)),
    avgRr: Number(avgRr.toFixed(2)),
    maxDd: equity.maxDd,
    trades
  };
}

async function runBacktestSnapshot() {
  const config = await readJson(CONFIG_FILE, DEFAULT_CONFIG);
  const markets = ['crypto', 'us', 'hk'];
  const rows = [];

  for (const market of markets) {
    const assets = (await getUniverse(market)).slice(0, Math.min(30, config.scanCaps?.[market] || 30));
    const btRows = await mapLimit(assets, 6, async (asset) => {
      const candles = await getCandles(market, asset);
      return runBacktestOnCandles(asset, market, candles, config);
    });
    for (const r of btRows) {
      if (r && !r.__error) rows.push(r);
    }
  }

  const totalSignals = rows.reduce((a, b) => a + b.total, 0);
  const totalWins = rows.reduce((a, b) => a + b.wins, 0);
  const weightedRr = rows.reduce((a, b) => a + b.avgRr * b.total, 0);
  const tradeSeries = rows.flatMap(r => (r.trades || []).map(t => ({
    at: t.at,
    rr: t.rr,
    asset: r.asset,
    market: r.market
  })));
  const equity = buildEquityCurve(tradeSeries);

  const snapshot = {
    at: nowIso(),
    totalAssets: rows.length,
    totalSignals,
    winRate: totalSignals ? Number(((totalWins / totalSignals) * 100).toFixed(2)) : 0,
    avgRr: totalSignals ? Number((weightedRr / totalSignals).toFixed(2)) : 0,
    maxDd: equity.maxDd,
    equityCurve: equity.curve.slice(-240),
    rows: rows.slice(0, 200).map(r => ({
      asset: r.asset,
      market: r.market,
      total: r.total,
      wins: r.wins,
      winRate: r.winRate,
      avgRr: r.avgRr,
      maxDd: r.maxDd
    }))
  };

  const db = await readJson(BACKTEST_FILE, { snapshots: [] });
  db.snapshots.push(snapshot);
  db.snapshots = db.snapshots.slice(-60);
  await writeJson(BACKTEST_FILE, db);
  return snapshot;
}

async function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    const ext = path.extname(filePath);
    const content = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    json(res, 404, { error: 'Not Found' });
  }
}

async function routeApi(req, res, pathname) {
  const parsed = new URL(req.url, `http://${HOST}:${PORT}`);

  if (pathname === '/api/health' && req.method === 'GET') {
    json(res, 200, { ok: true, now: nowIso() });
    return;
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    const latest = await readJson(BACKTEST_FILE, { snapshots: [] });
    json(res, 200, {
      ok: true,
      scheduler: memory.scheduler,
      universeCount: Object.fromEntries(Object.keys(MARKET_META).map(k => [k, memory.universes[k]?.list?.length || 0])),
      latestBacktest: latest.snapshots[latest.snapshots.length - 1] || null
    });
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    const config = await readJson(CONFIG_FILE, DEFAULT_CONFIG);
    json(res, 200, config);
    return;
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await parseBody(req);
    const config = {
      ...DEFAULT_CONFIG,
      ...body,
      switches: { ...DEFAULT_CONFIG.switches, ...(body.switches || {}) },
      scanCaps: { ...DEFAULT_CONFIG.scanCaps, ...(body.scanCaps || {}) },
      bots: Array.isArray(body.bots) ? body.bots.slice(0, 3) : DEFAULT_CONFIG.bots
    };
    await writeJson(CONFIG_FILE, config);
    json(res, 200, { ok: true, config });
    return;
  }

  if (pathname === '/api/universe/refresh' && req.method === 'POST') {
    const out = {};
    for (const m of Object.keys(MARKET_META)) out[m] = (await getUniverse(m, true)).length;
    await persistState();
    json(res, 200, { ok: true, out });
    return;
  }

  if (pathname === '/api/signals' && req.method === 'GET') {
    const market = parsed.searchParams.get('market') || 'all';
    const config = await readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const { list, errors } = await buildSignals({ market, config });
    json(res, 200, { ok: true, total: list.length, updatedAt: nowIso(), errors, list });
    return;
  }

  if (pathname === '/api/telegram/test' && req.method === 'POST') {
    const body = await parseBody(req);
    const { token, chatId, botName = 'Bot' } = body;
    if (!token || !chatId) return json(res, 400, { ok: false, error: 'token/chatId required' });
    try {
      await sendTelegram(token, chatId, `✅ ${botName} 连接测试成功\nTime: ${nowIso()}`);
      json(res, 200, { ok: true, message: 'sent' });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (pathname === '/api/push/run' && req.method === 'POST') {
    const data = await runPushFlow('manual', 'all');
    json(res, 200, { ok: true, ...data });
    return;
  }

  if (pathname === '/api/backtest/run' && req.method === 'POST') {
    const snap = await runBacktestSnapshot();
    json(res, 200, { ok: true, snapshot: snap });
    return;
  }

  if (pathname === '/api/backtest/latest' && req.method === 'GET') {
    const db = await readJson(BACKTEST_FILE, { snapshots: [] });
    const snapshot = db.snapshots[db.snapshots.length - 1] || null;
    json(res, 200, { ok: true, snapshot });
    return;
  }

  json(res, 404, { ok: false, error: 'API not found' });
}

async function schedulerTick() {
  const config = await readJson(CONFIG_FILE, DEFAULT_CONFIG);
  if (!config.scheduleEnabled) return;

  const now = new Date();
  const candidates = [
    ['crypto4h', 'crypto'],
    ['crypto1d', 'crypto'],
    ['usPre', 'us'],
    ['usClose', 'us'],
    ['hkPre', 'hk'],
    ['hkClose', 'hk']
  ];

  for (const [kind, market] of candidates) {
    if (!shouldRunTick(kind, now)) continue;
    const key = scheduleKey(kind, kind.startsWith('us') ? tzParts(now, 'America/New_York') : kind.startsWith('hk') ? tzParts(now, 'Asia/Hong_Kong') : tzParts(now, 'UTC'));
    if (!markAndCheckRun(memory.scheduler, key)) continue;

    memory.scheduler.lastStart = nowIso();
    try {
      const pushed = await runPushFlow(`schedule:${kind}`, market);
      memory.scheduler.lastResult = [{ kind, market, ok: true, pushed: pushed.pushed, scanned: pushed.scanned, at: nowIso() }];
      if (kind.endsWith('Close')) {
        const bt = await runBacktestSnapshot();
        memory.scheduler.lastResult.push({ kind: 'backtest', market, ok: true, at: nowIso(), winRate: bt.winRate, totalSignals: bt.totalSignals });
      }
    } catch (e) {
      memory.scheduler.lastResult = [{ kind, market, ok: false, error: e.message, at: nowIso() }];
    }
    memory.scheduler.lastEnd = nowIso();
    await persistState();
  }
}

async function ensureFiles() {
  await fsp.mkdir(IS_SERVERLESS ? SERVERLESS_DATA_DIR : DATA_DIR, { recursive: true });
  if (!(await fsp.access(writableDataFile(CONFIG_FILE)).then(() => true).catch(() => false))
      && !(await fsp.access(CONFIG_FILE).then(() => true).catch(() => false))) {
    await writeJson(CONFIG_FILE, DEFAULT_CONFIG);
  }
  if (!(await fsp.access(writableDataFile(SIGNAL_LOG)).then(() => true).catch(() => false))
      && !(await fsp.access(SIGNAL_LOG).then(() => true).catch(() => false))) {
    await writeJson(SIGNAL_LOG, { sent: [] });
  }
  if (!(await fsp.access(writableDataFile(BACKTEST_FILE)).then(() => true).catch(() => false))
      && !(await fsp.access(BACKTEST_FILE).then(() => true).catch(() => false))) {
    await writeJson(BACKTEST_FILE, { snapshots: [] });
  }
}

let initPromise = null;

async function initRuntime() {
  if (!initPromise) {
    initPromise = (async () => {
      await ensureFiles();
      await loadState();
    })();
  }
  return initPromise;
}

async function handleRequest(req, res) {
  await initRuntime();
  const parsed = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = parsed.pathname || '/';
  try {
    if (pathname.startsWith('/api/')) {
      await routeApi(req, res, pathname);
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
}

async function main() {
  await initRuntime();

  const server = http.createServer(handleRequest);

  setInterval(() => {
    schedulerTick().catch(err => {
      memory.scheduler.lastResult = [{ kind: 'scheduler', ok: false, at: nowIso(), error: err.message }];
    });
  }, 60 * 1000);

  server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  handleRequest
};
