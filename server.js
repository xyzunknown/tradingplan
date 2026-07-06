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
const ALLOW_SYNTHETIC = process.env.ALLOW_SYNTHETIC === '1';

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
  hk: ['0700.HK', '9988.HK', '3690.HK', '1299.HK', '0941.HK', '0388.HK', '2318.HK', '0005.HK', '0001.HK', '0002.HK']
};

const HK_BLUE_CHIPS = [
  '0700.HK', '9988.HK', '3690.HK', '1299.HK', '0941.HK', '0388.HK', '2318.HK', '0005.HK',
  '0001.HK', '0002.HK', '0003.HK', '0016.HK', '0027.HK', '0066.HK', '0883.HK', '0857.HK',
  '0939.HK', '1398.HK', '3988.HK', '3968.HK', '1211.HK', '2020.HK', '2269.HK', '9618.HK',
  '1024.HK', '1810.HK', '2388.HK', '6862.HK', '9999.HK', '2319.HK'
];

const STABLE_BASES = new Set([
  'USDT', 'USDC', 'FDUSD', 'TUSD', 'USDP', 'USDE', 'DAI', 'BUSD', 'USD1', 'USDD', 'EURI',
  'PYUSD', 'USDS', 'WBTC', 'WETH', 'STETH', 'WSTETH', 'WEETH', 'CBBTC', 'LEO', 'BGB'
]);

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
  minMarketCaps: { crypto: 10_000_000_000, us: 1_000_000_000, hk: 1_000_000_000 },
  maxStopPct: 3,
  concurrency: 8,
  scheduleEnabled: true
};

const BASE_STRATEGY_STATS = {
  R3: { '1d': { wr: 68, pf: 1.69, fee: 'taker即可' } },
  ConnorsRSI: { '1d': { wr: 67, pf: 2.17, fee: 'taker即可' } },
  MDD: { '1d': { wr: 68, pf: 1.39, fee: 'taker即可' } },
  RSI2: { '1d': { wr: 67, pf: 1.41, fee: 'taker即可' } },
  CumRSI2: { '1d': { wr: 67, pf: 1.52, fee: 'taker即可' } },
  IBS: { '1d': { wr: 60, pf: 1.32, fee: 'taker即可' } },
  'BB%b': { '1d': { wr: 62, pf: 1.41, fee: 'taker即可' } },
  Breakout20: { '1d': { wr: 50, pf: 4.33, fee: 'taker即可' } },
  NR7: { '1d': { wr: 42, pf: 1.50, fee: 'taker即可' } },
  GoldenCross: { '1d': { wr: 42, pf: 7.80, fee: 'taker即可' } },
  Supertrend: { '1d': { wr: 42, pf: 4.27, fee: 'taker即可' } },
  'Supertrend-S': { '1d': { wr: 44, pf: 2.18, fee: 'taker即可' } },
  Breakdown20: { '1d': { wr: 44, pf: 1.57, fee: 'taker即可' } },
  'TREND-PULLBACK': { '1d': { wr: 52, pf: 1.53, fee: '' } },
  'SQUEEZE-BREAK': { '1d': { wr: 46, pf: 1.40, fee: '' } },
  'DEEP-REVERSAL': { '1d': { wr: 50, pf: 1.40, fee: '' } }
};

const memory = {
  universes: {},
  cryptoMarketMeta: {},
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

function cryptoBase(symbol) {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
}

function cryptoYahooSymbol(symbol) {
  return `${cryptoBase(symbol)}-USD`;
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

function arrMin(values, start, end) {
  return Math.min(...values.slice(Math.max(0, start), Math.max(0, end)));
}

function arrMax(values, start, end) {
  return Math.max(...values.slice(Math.max(0, start), Math.max(0, end)));
}

function stddev(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function connorsRsi(values) {
  const rsi3 = rsi(values, 3);
  const streak = [0];
  for (let i = 1; i < values.length; i += 1) {
    const sign = Math.sign(values[i] - values[i - 1]);
    const prev = streak[i - 1];
    streak.push(sign === 0 ? 0 : (Math.sign(prev) === sign ? prev + sign : sign));
  }
  const streakRsi = rsi(streak.map(Number), 2);
  const roc = values.map((value, index) => index ? (value / values[index - 1]) - 1 : 0);
  const out = new Array(values.length).fill(null);
  for (let i = 100; i < values.length; i += 1) {
    const window = roc.slice(Math.max(1, i - 99), i + 1);
    const percentile = (window.filter(value => value < roc[i]).length / window.length) * 100;
    if (rsi3[i] != null && streakRsi[i] != null) out[i] = (rsi3[i] + streakRsi[i] + percentile) / 3;
  }
  return out;
}

function supertrendState(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 2) return { now: 1, prev: 1 };
  const atrs = atr(candles, period);
  let dir = 1;
  let prev = 1;
  let fub = null;
  let flb = null;
  for (let i = 1; i < candles.length; i += 1) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const ub = hl2 + multiplier * (atrs[i] || 0);
    const lb = hl2 - multiplier * (atrs[i] || 0);
    fub = fub == null ? ub : (candles[i - 1].close <= fub ? Math.min(ub, fub) : ub);
    flb = flb == null ? lb : (candles[i - 1].close >= flb ? Math.max(lb, flb) : lb);
    prev = dir;
    dir = candles[i].close > fub ? 1 : candles[i].close < flb ? -1 : dir;
  }
  return { now: dir, prev };
}

function statFor(type, tf = '1d', dynamicStats = {}) {
  return dynamicStats?.[type]?.[tf] || BASE_STRATEGY_STATS[type]?.[tf] || BASE_STRATEGY_STATS[type]?.['1d'] || null;
}

function roundPrice(value) {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) >= 1000) return Number(value.toFixed(2));
  if (Math.abs(value) >= 1) return Number(value.toFixed(4));
  if (Math.abs(value) >= 0.01) return Number(value.toFixed(6));
  return Number(value.toPrecision(4));
}

async function getCryptoUniverse(force = false, minMarketCap = DEFAULT_CONFIG.minMarketCaps.crypto) {
  const minCap = Math.max(0, Number(minMarketCap) || 0);
  const cacheKey = `crypto:${minCap}`;
  const cache = memory.universes[cacheKey];
  if (!force && cache && (Date.now() - cache.ts) < 6 * 3600 * 1000) return cache.list;
  try {
    const [info, markets] = await Promise.all([
      fetchJson('https://api.binance.com/api/v3/exchangeInfo'),
      fetchJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false')
    ]);

    const tradable = new Set(info.symbols
      .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed)
      .map(s => s.symbol));

    const top = [];
    const meta = {};
    const seen = new Set();
    for (const coin of markets) {
      const base = String(coin.symbol || '').toUpperCase();
      const symbol = `${base}USDT`;
      if (!/^[A-Z0-9]+$/.test(base) || STABLE_BASES.has(base) || seen.has(symbol)) continue;
      if (!tradable.has(symbol) || Number(coin.market_cap || 0) < minCap) continue;
      seen.add(symbol);
      meta[symbol] = {
        id: coin.id,
        name: coin.name,
        marketCap: Number(coin.market_cap || 0),
        marketCapRank: coin.market_cap_rank || null
      };
      top.push(symbol);
      if (top.length >= 100) break;
    }

    memory.cryptoMarketMeta = { ...memory.cryptoMarketMeta, ...meta };
    memory.universes[cacheKey] = { ts: Date.now(), list: top };
    return top;
  } catch {}

  const markets = await fetchJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false');
  const top = [];
  const meta = {};
  const seen = new Set();
  for (const coin of markets) {
    const base = String(coin.symbol || '').toUpperCase();
    const symbol = `${base}USDT`;
    if (!/^[A-Z0-9]+$/.test(base) || STABLE_BASES.has(base) || seen.has(base)) continue;
    if (Number(coin.market_cap || 0) < minCap) continue;
    seen.add(base);
    meta[symbol] = {
      id: coin.id,
      name: coin.name,
      marketCap: Number(coin.market_cap || 0),
      marketCapRank: coin.market_cap_rank || null
    };
    top.push(symbol);
    if (top.length >= 100) break;
  }

  memory.cryptoMarketMeta = { ...memory.cryptoMarketMeta, ...meta };
  memory.universes[cacheKey] = { ts: Date.now(), list: top };
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
  const list = HK_BLUE_CHIPS;
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

async function fetchCryptoCandles(symbol, interval = '1d', limit = 320) {
  const safeInterval = ['15m', '1h', '4h', '1d', '1w'].includes(interval) ? interval : '1d';
  const safeLimit = Math.max(120, Math.min(800, Number(limit) || 320));
  const query = `symbol=${encodeURIComponent(symbol)}&interval=${safeInterval}&limit=${safeLimit}`;
  let arr;
  try {
    arr = await fetchJson(`https://api.binance.com/api/v3/klines?${query}`);
  } catch (e) {
    arr = await fetchJson(`https://data-api.binance.vision/api/v3/klines?${query}`);
  }
  return {
    sourceName: 'binance',
    candles: sanitizeCandles(arr.map(k => ({
      t: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5])
    })))
  };
}

async function fetchCryptoYahooCandles(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cryptoYahooSymbol(symbol))}?range=2y&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo crypto chart empty');
  const ts = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i += 1) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i] || 0;
    if ([open, high, low, close].some(x => x == null || !Number.isFinite(Number(x)))) continue;
    candles.push({
      t: ts[i] * 1000,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume)
    });
  }
  return {
    sourceName: 'yahoo-crypto',
    candles: sanitizeCandles(candles)
  };
}

async function fetchCryptoCandlesWithFallback(symbol) {
  try {
    return await fetchCryptoCandles(symbol);
  } catch {}

  return fetchCryptoYahooCandles(symbol);
}

function withSource(candles, sourceName) {
  Object.defineProperty(candles, 'sourceName', {
    value: sourceName,
    enumerable: false,
    configurable: true
  });
  return candles;
}

function usableCandleCache(cache) {
  return cache?.candles?.length >= 220 && cache.sourceName && cache.sourceName !== 'synthetic';
}

async function fetchSyntheticCandles(asset, market) {
  return {
    sourceName: 'synthetic',
    candles: syntheticCandles(asset, market, 320)
  };
}

async function fetchYahooCandles(symbol, interval = '1d', range = '2y') {
  const intervalMap = { '15m': '15m', '1h': '60m', '1d': '1d', '1wk': '1wk' };
  const safeInterval = intervalMap[interval] || '1d';
  const safeRange = safeInterval === '1wk' ? '5y' : safeInterval === '15m' ? '60d' : safeInterval === '60m' ? '730d' : range;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${safeRange}&interval=${safeInterval}&events=div%2Csplits&includeAdjustedClose=true`;
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
  return {
    sourceName: 'yahoo-adjusted',
    candles: sanitizeCandles(candles)
  };
}

async function getCandles(market, asset) {
  const key = `${market}:${asset}`;
  const cache = memory.candles[key];
  const ttl = market === 'crypto' ? 15 * 60 * 1000 : 6 * 3600 * 1000;
  if (cache && (Date.now() - cache.ts) < ttl && usableCandleCache(cache)) {
    return withSource(cache.candles, cache.sourceName);
  }

  let data;
  try {
    if (market === 'crypto') {
      data = await fetchCryptoCandlesWithFallback(asset);
    } else {
      data = await fetchYahooCandles(market === 'us' ? normalizeUsSymbol(asset) : asset);
    }
  } catch (e) {
    if (usableCandleCache(cache)) return withSource(cache.candles, cache.sourceName);
    if (!ALLOW_SYNTHETIC) throw e;
    data = await fetchSyntheticCandles(asset, market);
  }

  if (data.candles.length < 220) throw new Error(`not enough candles for ${asset}`);
  memory.candles[key] = { ts: Date.now(), candles: data.candles, sourceName: data.sourceName };
  return withSource(data.candles, data.sourceName);
}

async function getChartCandles(market, asset, tf = '1d') {
  const normalizedTf = ['15m', '1h', '4h', '1d', '1w'].includes(tf) ? tf : '1d';
  if (normalizedTf === '1d') return getCandles(market, asset);
  if (market === 'crypto') {
    const limit = normalizedTf === '15m' || normalizedTf === '1h' ? 800 : normalizedTf === '4h' ? 500 : 320;
    const data = await fetchCryptoCandles(asset, normalizedTf, limit);
    return withSource(data.candles, data.sourceName);
  }
  const yahooTf = normalizedTf === '1w' ? '1wk' : normalizedTf;
  const data = await fetchYahooCandles(market === 'us' ? normalizeUsSymbol(asset) : asset, yahooTf);
  return withSource(data.candles, data.sourceName);
}

function computeSignalsFromCandles(asset, market, candles, config, dynamicStats = {}) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma60 = sma(closes, 60);
  const ma120 = sma(closes, 120);
  const ma200 = sma(closes, 200);
  const rsi2 = rsi(closes, 2);
  const rsi3 = rsi(closes, 3);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const crsi = connorsRsi(closes);

  const i = candles.length - 1;
  if (i < 210) return [];
  const price = closes[i];
  const e200 = ma200[i] || price;
  const trend = price > e200 ? 'trend' : 'counter';
  const deviation = (Math.abs(price - e200) / e200) * 100;
  const atrv = atr14[i] || price * 0.02;
  const tf = '1d';
  const timestamp = nowIso();
  const source = candles.sourceName || (market === 'crypto' ? 'crypto-real' : 'yahoo-adjusted');
  const out = [];

  function makeSignal({ type, direction, status, sl = null, tp = null, exitRule = '', why = '', score = null }) {
    const stat = statFor(type, tf, dynamicStats);
    const entry = price;
    const maxStopPct = Number(config.maxStopPct || DEFAULT_CONFIG.maxStopPct);
    let effectiveSl = sl;
    let risk = direction === 'SHORT'
      ? (effectiveSl ? effectiveSl - entry : null)
      : (effectiveSl ? entry - effectiveSl : null);
    const originalRiskPct = risk ? (risk / Math.max(0.0001, entry)) * 100 : null;
    const stopCapped = status === 'CONFIRMED' && originalRiskPct != null && Number.isFinite(originalRiskPct) && originalRiskPct > maxStopPct;
    if (status === 'CONFIRMED' && originalRiskPct != null && (!Number.isFinite(originalRiskPct) || originalRiskPct <= 0)) return;
    if (stopCapped) {
      effectiveSl = direction === 'SHORT'
        ? entry * (1 + maxStopPct / 100)
        : entry * (1 - maxStopPct / 100);
      risk = direction === 'SHORT'
        ? effectiveSl - entry
        : entry - effectiveSl;
    }
    const riskPct = risk ? (risk / Math.max(0.0001, entry)) * 100 : null;
    const reward = direction === 'SHORT'
      ? (tp ? entry - tp : null)
      : (tp ? tp - entry : null);
    const rr = risk && reward ? Number((reward / Math.max(0.0001, risk)).toFixed(2)) : '-';
    out.push({
      asset,
      market,
      tf,
      type,
      direction,
      mode: trend === 'trend' ? '模式I 顺势' : '模式II 逆势',
      modeKey: trend,
      price: roundPrice(price),
      ema200: roundPrice(e200),
      ma20: roundPrice(ma20[i]),
      ma60: roundPrice(ma60[i]),
      ma120: roundPrice(ma120[i]),
      rsi: Number((rsi14[i] || 50).toFixed(2)),
      rsi2: rsi2[i] == null ? null : Number(rsi2[i].toFixed(2)),
      deviation: Number(deviation.toFixed(2)),
      score: score == null ? (stat?.wr ? Number((stat.wr / 25).toFixed(2)) : 0) : score,
      scoreBreakdown: { pa: 0, fib: 0, box: 0, divergence: 0 },
      paType: type,
      entry: roundPrice(entry),
      sl: effectiveSl == null ? null : roundPrice(effectiveSl),
      tp1: tp == null ? null : roundPrice(tp),
      tp2: null,
      rr,
      riskPct: riskPct == null ? null : Number(riskPct.toFixed(2)),
      originalRiskPct: originalRiskPct == null ? null : Number(originalRiskPct.toFixed(2)),
      stopCapped,
      status: status === 'CONFIRMED' ? 'confirmed' : 'none',
      boardStatus: status,
      exitRule,
      why,
      wr: stat?.wr ?? null,
      pf: stat?.pf ?? null,
      feeNote: stat?.fee || '',
      scanWindow: MARKET_META[market].scans,
      timestamp,
      source
    });
  }

  const maSet = [ma20[i], ma60[i], ma120[i]].filter(Number.isFinite);
  if (maSet.length === 3) {
    const dispSeries = [];
    for (let k = 120; k <= i; k += 1) {
      const set = [ma20[k], ma60[k], ma120[k]].filter(Number.isFinite);
      dispSeries[k] = set.length === 3 ? ((Math.max(...set) - Math.min(...set)) / closes[k]) : null;
    }
    const window = dispSeries.slice(Math.max(120, i - 252), i + 1).filter(x => x != null).sort((a, b) => a - b);
    const pct = value => window.length ? window.filter(x => x <= value).length / window.length : 1;
    const recentSqueeze = Array.from({ length: 11 }, (_, idx) => i - 10 + idx)
      .some(k => k >= 120 && pct(dispSeries[k]) < 0.15);
    const maxMa = Math.max(...maSet);
    const minMa = Math.min(...maSet);
    const prevSet = [ma20[i - 1], ma60[i - 1], ma120[i - 1]].filter(Number.isFinite);
    if (recentSqueeze && prevSet.length === 3) {
      const prevMax = Math.max(...prevSet);
      const prevMin = Math.min(...prevSet);
      if (price > maxMa && closes[i - 1] <= prevMax) {
        makeSignal({
          type: 'SQUEEZE-BREAK',
          direction: 'BUY',
          status: 'CONFIRMED',
          sl: price - 2 * atrv,
          tp: price + 3 * atrv,
          why: 'MA20/60/120 聚合后, 收盘突破三线上方。'
        });
      } else if (price < minMa && closes[i - 1] >= prevMin) {
        makeSignal({
          type: 'SQUEEZE-BREAK',
          direction: 'SELL',
          status: 'CONFIRMED',
          why: 'MA20/60/120 聚合后, 收盘跌破三线下方。'
        });
      } else if (pct(dispSeries[i]) < 0.15) {
        makeSignal({
          type: 'SQUEEZE',
          direction: 'WATCH',
          status: 'MONITOR',
          why: `MA20/60/120 正在聚合, 当前离散度处于近一年低分位。`
        });
      }
    }
  }

  const tolerance = ((config.v8TolerancePct ?? 2) / 100);
  if (e200) {
    if (price > e200) {
      let touched = false;
      for (let k = i - 5; k <= i; k += 1) {
        if (k >= 0 && ma200[k] && lows[k] <= ma200[k] * (1 + tolerance)) touched = true;
      }
      const high5 = arrMax(highs, i - 5, i);
      if (touched && price > high5) {
        const swingLow = arrMin(lows, i - 10, i + 1);
        makeSignal({
          type: 'TREND-PULLBACK',
          direction: 'BUY',
          status: 'CONFIRMED',
          sl: Math.min(price - 2 * atrv, swingLow - 0.5 * atrv),
          tp: price + 3 * atrv,
          why: '200MA 上方回踩关键区后, 收盘收复近 5 日高点。'
        });
      } else if (touched) {
        makeSignal({
          type: 'TREND-PULLBACK',
          direction: 'WATCH',
          status: 'MONITOR',
          why: '已回踩 200MA 关键区, 但尚未收复近 5 日高点。'
        });
      }
    } else {
      const dev = (price / e200) - 1;
      if (dev <= -0.15 && (rsi14[i] || 100) < 30) {
        const priorLow = arrMin(lows, i - 20, i);
        const priorLowIndex = lows.slice(Math.max(0, i - 20), i).indexOf(priorLow) + Math.max(0, i - 20);
        const div = lows[i] <= priorLow && rsi14[i] != null && rsi14[priorLowIndex] != null && rsi14[i] > rsi14[priorLowIndex] + 2;
        const engulf = closes[i] > opens[i] && closes[i - 1] < opens[i - 1] && closes[i] >= opens[i - 1] && opens[i] <= closes[i - 1];
        makeSignal({
          type: 'DEEP-REVERSAL',
          direction: div || engulf ? 'BUY' : 'WATCH',
          status: div || engulf ? 'CONFIRMED' : 'MONITOR',
          sl: div || engulf ? price - 2 * atrv : null,
          tp: div || engulf ? price + 3 * atrv : null,
          why: `深度超卖: 偏离 200MA ${(dev * 100).toFixed(1)}%, RSI ${Number(rsi14[i]).toFixed(0)}${div ? ', 底背离' : engulf ? ', 看涨吞没' : ', 等反转证据'}。`
        });
      }
      if (ma200[i - 1] && closes[i - 1] > ma200[i - 1] && price < e200) {
        makeSignal({
          type: 'MA200-LOST',
          direction: 'SELL',
          status: 'CONFIRMED',
          why: '收盘跌破 200MA, 趋势转空。'
        });
      }
    }
  }

  const above = e200 && price > e200;
  if (above) {
    if (rsi2[i] != null && rsi2[i - 1] != null && rsi2[i - 2] != null && rsi2[i] < rsi2[i - 1] && rsi2[i - 1] < rsi2[i - 2] && rsi2[i - 2] < 60 && rsi2[i] < 10) {
      makeSignal({ type: 'R3', direction: 'BUY', status: 'CONFIRMED', sl: price - 2.5 * atrv, exitRule: 'RSI(2)>70 或 10 根后', why: 'RSI(2) 三连降至极低位。' });
    }
    if (crsi[i] != null && crsi[i] < 15) {
      makeSignal({ type: 'ConnorsRSI', direction: 'BUY', status: 'CONFIRMED', sl: price - 2.5 * atrv, exitRule: 'ConnorsRSI>70 或 10 根后', why: `ConnorsRSI=${crsi[i].toFixed(1)} < 15。` });
    }
    const downCount = Array.from({ length: 5 }, (_, idx) => i - 4 + idx).filter(k => k > 0 && closes[k] < closes[k - 1]).length;
    if (downCount >= 4) {
      makeSignal({ type: 'MDD', direction: 'BUY', status: 'CONFIRMED', sl: price - 2.5 * atrv, exitRule: '收盘破前一根高点 或 RSI2>65 或 10 根后', why: '近 5 根至少 4 根收跌。' });
    }
    if (rsi2[i] != null && rsi2[i] < 10) {
      makeSignal({ type: 'RSI2', direction: 'BUY', status: 'CONFIRMED', sl: price - 2.5 * atrv, exitRule: 'RSI(2)>50 或 10 根后', why: `RSI(2)=${rsi2[i].toFixed(1)} < 10。` });
    }
    if (rsi2[i] != null && rsi2[i - 1] != null && rsi2[i] + rsi2[i - 1] < 35) {
      makeSignal({ type: 'CumRSI2', direction: 'BUY', status: 'CONFIRMED', sl: price - 2.5 * atrv, exitRule: 'RSI(2)>65 或 10 根后', why: `两日 RSI(2) 合计 ${(rsi2[i] + rsi2[i - 1]).toFixed(1)} < 35。` });
    }
    const range = highs[i] - lows[i];
    const ibs = range > 0 ? (price - lows[i]) / range : 0.5;
    if (ibs < 0.15) {
      makeSignal({ type: 'IBS', direction: 'BUY', status: 'CONFIRMED', sl: price - 2.5 * atrv, exitRule: 'IBS>0.8 或 10 根后', why: `IBS=${ibs.toFixed(2)} < 0.15。` });
    }
    if (ma20[i]) {
      const sd = stddev(closes.slice(i - 19, i + 1));
      if (price < ma20[i] - 2 * sd) {
        makeSignal({ type: 'BB%b', direction: 'BUY', status: 'CONFIRMED', sl: price - 2.5 * atrv, exitRule: '回到布林中轨 或 15 根后', why: '收盘跌破布林下轨。' });
      }
    }
    const high20 = arrMax(highs, i - 20, i);
    if (price > high20) {
      makeSignal({ type: 'Breakout20', direction: 'BUY', status: 'CONFIRMED', sl: price - 3 * atrv, exitRule: '3ATR 吊灯跟踪止损', why: '收盘突破 20 期高点。' });
    }
    const priorRange = highs[i - 1] - lows[i - 1];
    const nr7 = Array.from({ length: 6 }, (_, idx) => i - 7 + idx).every(k => k >= 0 && highs[k] - lows[k] >= priorRange);
    if (nr7 && price > highs[i - 1]) {
      makeSignal({ type: 'NR7', direction: 'BUY', status: 'CONFIRMED', sl: price - 3 * atrv, exitRule: '3ATR 跟踪 或 20 根后', why: 'NR7 波动收缩后向上突破。' });
    }
    if (ma50[i] && ma200[i] && ma50[i - 1] && ma200[i - 1] && ma50[i] > ma200[i] && ma50[i - 1] <= ma200[i - 1]) {
      makeSignal({ type: 'GoldenCross', direction: 'BUY', status: 'CONFIRMED', sl: price - 3 * atrv, exitRule: '死叉离场', why: 'MA50 金叉 MA200。' });
    }
    const st = supertrendState(candles);
    if (st.now === 1 && st.prev === -1) {
      makeSignal({ type: 'Supertrend', direction: 'BUY', status: 'CONFIRMED', sl: price - 3 * atrv, exitRule: 'Supertrend 翻空离场', why: 'Supertrend(10,3) 翻多。' });
    }
  } else if (e200) {
    const low20 = arrMin(lows, i - 20, i);
    if (price < low20) {
      makeSignal({ type: 'Breakdown20', direction: 'SHORT', status: 'CONFIRMED', sl: price + 3 * atrv, exitRule: '3ATR 吊灯跟踪(向下)', why: '200MA 下方跌破 20 期低点追空。' });
    }
    const st = supertrendState(candles);
    if (st.now === -1 && st.prev === 1) {
      makeSignal({ type: 'Supertrend-S', direction: 'SHORT', status: 'CONFIRMED', sl: price + 3 * atrv, exitRule: 'Supertrend 翻多平空', why: '200MA 下方 Supertrend 翻空。' });
    }
  }

  return out;
}

function computeSignalFromCandles(asset, market, candles, config) {
  return computeSignalsFromCandles(asset, market, candles, config)[0] || null;
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

async function latestStrategyStats() {
  const db = await readJson(BACKTEST_FILE, { snapshots: [] });
  const latest = db.snapshots?.[db.snapshots.length - 1];
  return latest?.strategyStats || {};
}

function signalSortValue(signal) {
  return (signal.status === 'confirmed' ? 100000 : 0)
    + (signal.direction === 'BUY' || signal.direction === 'SHORT' ? 10000 : 0)
    + (Number(signal.wr || 0) * 100)
    + Number(signal.pf || 0);
}

function mergeSignalsByAsset(list) {
  const groups = new Map();
  for (const signal of list) {
    const key = `${signal.market}:${signal.asset}:${signal.tf || '1d'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(signal);
  }

  return Array.from(groups.values()).map(group => {
    const ordered = [...group].sort((a, b) => signalSortValue(b) - signalSortValue(a));
    const primary = { ...ordered[0] };
    primary.relatedSignals = ordered.map(s => ({
      type: s.type,
      direction: s.direction,
      status: s.status,
      wr: s.wr,
      pf: s.pf,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      rr: s.rr,
      exitRule: s.exitRule,
      why: s.why
    }));
    primary.types = ordered.map(s => s.type);
    if (ordered.length > 1) {
      primary.type = `${ordered[0].type} +${ordered.length - 1}`;
      primary.why = `${ordered[0].why || ''}\n\n同标的还命中: ${ordered.slice(1).map(s => s.type).join(', ')}`;
    }
    return primary;
  });
}

async function buildSignals({ market = 'all', config, strategyStats = {} }) {
  const mkts = market === 'all' ? ['crypto', 'us', 'hk'] : [market].filter(k => MARKET_META[k]);
  const all = [];
  const errors = [];

  for (const m of mkts) {
    const universe = m === 'crypto'
      ? await getCryptoUniverse(false, config.minMarketCaps?.crypto ?? DEFAULT_CONFIG.minMarketCaps.crypto)
      : await getUniverse(m);
    const cap = Math.min(config.scanCaps?.[m] || universe.length, universe.length);
    const assets = universe.slice(0, cap);
    const rows = await mapLimit(assets, config.concurrency || 8, async (asset) => {
      const candles = await getCandles(m, asset);
      const signals = computeSignalsFromCandles(asset, m, candles, config, strategyStats);
      const meta = m === 'crypto' ? memory.cryptoMarketMeta?.[asset] : null;
      return meta ? signals.map(s => ({
        ...s,
        marketCap: meta.marketCap,
        marketCapRank: meta.marketCapRank,
        assetName: meta.name
      })) : signals;
    });

    for (const r of rows) {
      if (r && r.__error) {
        errors.push({ market: m, asset: r.__item, error: r.__error });
      } else if (Array.isArray(r)) {
        all.push(...r);
      } else if (r) {
        all.push(r);
      }
    }
  }

  const merged = mergeSignalsByAsset(all);
  return {
    list: merged.sort((a, b) => (a.status === 'confirmed' ? -1 : 1) - (b.status === 'confirmed' ? -1 : 1) || (b.wr || b.score || 0) - (a.wr || a.score || 0)),
    errors
  };
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

  const strategyStats = await latestStrategyStats();
  const { list, errors } = await buildSignals({ market, config, strategyStats });
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

function signalHoldingBars(signal) {
  if (['R3', 'ConnorsRSI', 'MDD', 'RSI2', 'CumRSI2', 'IBS'].includes(signal.type)) return 10;
  if (['BB%b'].includes(signal.type)) return 15;
  if (['Breakout20', 'Breakdown20', 'NR7', 'Supertrend', 'Supertrend-S', 'GoldenCross'].includes(signal.type)) return 30;
  return 20;
}

function simulateSignalTrade(candles, startIdx, signal) {
  const end = Math.min(candles.length - 1, startIdx + signalHoldingBars(signal));
  const entry = signal.entry || signal.price;
  const sl = signal.sl;
  const tp = signal.tp1;
  const direction = signal.direction || 'BUY';
  for (let i = startIdx + 1; i <= end; i += 1) {
    const c = candles[i];
    if (direction === 'SHORT') {
      if (sl && c.high >= sl) return { win: 0, rr: -1, at: c.t };
      if (tp && c.low <= tp) {
        const risk = Math.max(0.0001, sl ? sl - entry : entry * 0.03);
        return { win: 1, rr: Number(((entry - tp) / risk).toFixed(2)), at: c.t };
      }
    } else {
      if (sl && c.low <= sl) return { win: 0, rr: -1, at: c.t };
      if (tp && c.high >= tp) {
        const risk = Math.max(0.0001, entry - sl);
        return { win: 1, rr: Number(((tp - entry) / risk).toFixed(2)), at: c.t };
      }
    }
  }

  const endClose = candles[end].close;
  const risk = direction === 'SHORT'
    ? Math.max(0.0001, sl ? sl - entry : entry * 0.03)
    : Math.max(0.0001, sl ? entry - sl : entry * 0.03);
  const pnl = direction === 'SHORT' ? (entry - endClose) / risk : (endClose - entry) / risk;
  const clamped = Math.max(-3, Math.min(5, pnl));
  return { win: pnl > 0 ? 1 : 0, rr: Number(clamped.toFixed(2)), at: candles[end].t };
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
    const signals = computeSignalsFromCandles(asset, market, slice, config, {});
    for (const signal of signals) {
      if (signal.status !== 'confirmed') continue;
      total += 1;
      const r = simulateSignalTrade(candles, i, signal);
      wins += r.win;
      rrList.push(r.rr);
      trades.push({
        at: r.at || candles[i].t,
        rr: r.rr,
        win: r.win,
        type: signal.type,
        direction: signal.direction,
        tf: signal.tf || '1d'
      });
    }
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
    market: r.market,
    type: t.type,
    direction: t.direction,
    tf: t.tf || '1d'
  })));
  const equity = buildEquityCurve(tradeSeries);
  const totalGrossWin = tradeSeries.reduce((sum, trade) => sum + (trade.rr > 0 ? trade.rr : 0), 0);
  const totalGrossLoss = tradeSeries.reduce((sum, trade) => sum + (trade.rr < 0 ? Math.abs(trade.rr) : 0), 0);
  const profitFactor = totalGrossLoss ? Number((totalGrossWin / totalGrossLoss).toFixed(2)) : totalGrossWin ? 99 : 0;
  const strategyStats = {};
  for (const trade of tradeSeries) {
    const type = trade.type || 'UNKNOWN';
    const tf = trade.tf || '1d';
    strategyStats[type] ||= {};
    strategyStats[type][tf] ||= { total: 0, wins: 0, grossWin: 0, grossLoss: 0, rrSum: 0 };
    const row = strategyStats[type][tf];
    row.total += 1;
    row.wins += trade.rr > 0 ? 1 : 0;
    row.rrSum += trade.rr;
    if (trade.rr > 0) row.grossWin += trade.rr;
    if (trade.rr < 0) row.grossLoss += Math.abs(trade.rr);
  }
  for (const type of Object.keys(strategyStats)) {
    for (const tf of Object.keys(strategyStats[type])) {
      const row = strategyStats[type][tf];
      row.wr = row.total ? Number(((row.wins / row.total) * 100).toFixed(1)) : 0;
      row.pf = row.grossLoss ? Number((row.grossWin / row.grossLoss).toFixed(2)) : row.grossWin ? 99 : 0;
      row.avgRr = row.total ? Number((row.rrSum / row.total).toFixed(2)) : 0;
      row.fee = BASE_STRATEGY_STATS[type]?.[tf]?.fee || BASE_STRATEGY_STATS[type]?.['1d']?.fee || '';
      delete row.rrSum;
      delete row.grossWin;
      delete row.grossLoss;
    }
  }

  const snapshot = {
    at: nowIso(),
    totalAssets: rows.length,
    totalSignals,
    winRate: totalSignals ? Number(((totalWins / totalSignals) * 100).toFixed(2)) : 0,
    profitFactor,
    avgRr: totalSignals ? Number((weightedRr / totalSignals).toFixed(2)) : 0,
    maxDd: equity.maxDd,
    equityCurve: equity.curve.slice(-240),
    strategyStats,
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
    const savedConfig = await readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const cryptoMinYi = parsed.searchParams.get('cryptoMinYi');
    const maxStopPct = parsed.searchParams.get('maxStopPct');
    const config = {
      ...savedConfig,
      minMarketCaps: {
        ...DEFAULT_CONFIG.minMarketCaps,
        ...(savedConfig.minMarketCaps || {}),
        ...(cryptoMinYi == null ? {} : { crypto: Math.max(0, Number(cryptoMinYi) || 0) * 1e8 })
      },
      maxStopPct: maxStopPct == null ? (savedConfig.maxStopPct || DEFAULT_CONFIG.maxStopPct) : Math.max(1, Number(maxStopPct) || DEFAULT_CONFIG.maxStopPct)
    };
    const strategyStats = await latestStrategyStats();
    const { list, errors } = await buildSignals({ market, config, strategyStats });
    json(res, 200, { ok: true, total: list.length, updatedAt: nowIso(), errors, list });
    return;
  }

  if (pathname === '/api/candles' && req.method === 'GET') {
    const market = parsed.searchParams.get('market');
    const asset = parsed.searchParams.get('asset');
    const tf = parsed.searchParams.get('tf') || '1d';
    if (!MARKET_META[market] || !asset) return json(res, 400, { ok: false, error: 'market/asset required' });
    try {
      const candles = await getChartCandles(market, asset, tf);
      json(res, 200, {
        ok: true,
        market,
        asset,
        tf,
        source: candles.sourceName || (market === 'crypto' ? 'crypto-real' : 'yahoo-adjusted'),
        candles: candles.map(c => ({
          t: c.t,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume || 0
        }))
      });
    } catch (e) {
      json(res, 502, { ok: false, error: e.message });
    }
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
