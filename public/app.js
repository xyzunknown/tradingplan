const state = {
  market: 'all',
  minScore: 0,
  signals: [],
  selectedAsset: null,
  config: null,
  status: null,
  backtest: null,
  updatedAt: null,
  refreshCountdown: 120,
  refreshTimer: null,
  statsSource: 'empty'
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.style.borderColor = isError ? 'rgba(255,61,113,0.75)' : 'rgba(0,163,255,0.55)';
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2400);
}

async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();
  let data = null;

  if (raw) {
    if (contentType.includes('application/json')) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`接口返回了损坏的 JSON: ${path}`);
      }
    } else {
      const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
      throw new Error(`接口未返回 JSON: ${path} -> ${preview || 'empty response'}`);
    }
  }

  if (!res.ok || (data && data.ok === false)) throw new Error((data && data.error) || `Request failed: ${path}`);
  return data;
}

function formatNumber(value) {
  const num = Number(value || 0);
  if (Math.abs(num) >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(num) >= 1) return num.toFixed(2);
  if (Math.abs(num) >= 0.01) return num.toFixed(4);
  return num.toFixed(6);
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function updateSystemClock() {
  $('#systemTime').textContent = new Date().toLocaleTimeString('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function updateCountdownText() {
  const sec = Math.max(0, state.refreshCountdown);
  const minute = String(Math.floor(sec / 60)).padStart(2, '0');
  const second = String(sec % 60).padStart(2, '0');
  $('#nextRefreshText').textContent = `下次自动刷新 ${minute}:${second}`;
}

function startRefreshCountdown() {
  clearInterval(state.refreshTimer);
  state.refreshCountdown = 120;
  updateCountdownText();
  state.refreshTimer = setInterval(() => {
    state.refreshCountdown -= 1;
    if (state.refreshCountdown <= 0) state.refreshCountdown = 120;
    updateCountdownText();
  }, 1000);
}

function filteredSignals() {
  return state.signals.filter((sig) => sig.score >= state.minScore);
}

function renderMarketCounts() {
  const counts = {
    all: state.signals.length,
    crypto: state.signals.filter((s) => s.market === 'crypto').length,
    us: state.signals.filter((s) => s.market === 'us').length,
    hk: state.signals.filter((s) => s.market === 'hk').length
  };
  $('#count-all').textContent = counts.all;
  $('#count-crypto').textContent = counts.crypto;
  $('#count-us').textContent = counts.us;
  $('#count-hk').textContent = counts.hk;
  $('#signalTotal').textContent = counts.all;
  $('#confirmedTotal').textContent = state.signals.filter((s) => s.status === 'confirmed').length;
  $('#updatedAt').textContent = formatTime(state.updatedAt);
}

function signalMarketLabel(market) {
  if (market === 'crypto') return 'CRYPTO';
  if (market === 'us') return 'NYSE';
  return 'HKEX';
}

function signalModeLabel(sig) {
  return sig.modeKey === 'trend' ? 'TREND' : 'COUNTER';
}

function signalStatusLabel(status) {
  if (status === 'confirmed') return 'CONFIRMED';
  if (status === 'warning') return 'WARNING';
  return 'MONITOR';
}

function scoreFillWidth(score) {
  return `${Math.max(0, Math.min(100, (score / 3) * 100))}%`;
}

function renderSignals() {
  const list = $('#signalList');
  const empty = $('#signalEmpty');
  const rows = filteredSignals();
  list.innerHTML = '';

  if (!rows.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  rows.forEach((sig) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `signal-row ${sig.status} ${state.selectedAsset === sig.asset ? 'selected' : ''}`;
    row.innerHTML = `
      <div class="asset-cell">
        <span class="asset-market ${sig.market}">${signalMarketLabel(sig.market)}</span>
        <div class="asset-main">
          <div class="asset-symbol">${sig.asset}</div>
          <div class="asset-meta">${sig.paType} | ${formatTime(sig.timestamp)}</div>
        </div>
      </div>
      <div class="price-cell">
        <strong>${formatNumber(sig.price)}</strong>
        <span>EMA200 ${formatNumber(sig.ema200)}</span>
      </div>
      <div class="score-box">
        <strong>${sig.score.toFixed(2)}</strong>
        <span>RR ${sig.rr.toFixed(2)}</span>
        <div class="score-track"><div class="score-fill" style="width:${scoreFillWidth(sig.score)}"></div></div>
      </div>
      <div class="structure-dots">
        <span class="dot ${sig.scoreBreakdown.pa > 0 ? 'on' : ''}"></span>
        <span class="dot ${sig.scoreBreakdown.fib > 0 ? 'on' : sig.modeKey === 'trend' ? 'alt' : ''}"></span>
        <span class="dot ${sig.scoreBreakdown.divergence > 0 ? 'on' : ''}"></span>
      </div>
      <div><span class="mode-chip ${sig.modeKey}">${signalModeLabel(sig)}</span></div>
      <div><span class="status-chip ${sig.status}">${signalStatusLabel(sig.status)}</span></div>
    `;
    row.onclick = () => {
      state.selectedAsset = sig.asset;
      renderSignals();
      renderDetail();
    };
    list.appendChild(row);
  });
}

function resizeCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function renderRadar(sig) {
  const canvas = $('#radar');
  const width = Math.max(240, Math.min(300, canvas.parentElement.clientWidth || 280));
  const height = Math.round(width * 0.86);
  const { ctx } = resizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);

  const labels = ['PA', 'EMA', 'Fib', 'Box', 'Div'];
  const values = [
    sig.scoreBreakdown.pa,
    sig.modeKey === 'trend' ? 1 : Math.min(1, sig.deviation / 20),
    sig.scoreBreakdown.fib,
    sig.scoreBreakdown.box,
    sig.scoreBreakdown.divergence
  ].map((value) => Math.max(0.1, value));

  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.min(width, height) * 0.34;
  const step = (Math.PI * 2) / labels.length;

  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  for (let ring = 1; ring <= 4; ring += 1) {
    ctx.beginPath();
    for (let i = 0; i < labels.length; i += 1) {
      const angle = -Math.PI / 2 + i * step;
      const radius = (maxR / 4) * ring;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  ctx.beginPath();
  for (let i = 0; i < labels.length; i += 1) {
    const angle = -Math.PI / 2 + i * step;
    const radius = maxR * (values[i] / 1.15);
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,255,195,0.2)';
  ctx.strokeStyle = '#00ffc3';
  ctx.shadowColor = '#00ffc3';
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#8ba2c5';
  ctx.font = '11px JetBrains Mono';
  labels.forEach((label, i) => {
    const angle = -Math.PI / 2 + i * step;
    const x = cx + Math.cos(angle) * (maxR + 18);
    const y = cy + Math.sin(angle) * (maxR + 18);
    ctx.fillText(label, x - 10, y + 4);
  });

  ctx.fillStyle = '#00a3ff';
  ctx.font = 'bold 20px JetBrains Mono';
  ctx.fillText(sig.score.toFixed(2), cx - 22, cy + 6);
}

function renderDetail() {
  const sig = state.signals.find((item) => item.asset === state.selectedAsset);
  const empty = $('#emptyDetail');
  const body = $('#detailBody');

  if (!sig) {
    empty.classList.remove('hidden');
    body.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  body.classList.remove('hidden');
  $('#dAsset').textContent = `${sig.asset} · ${signalMarketLabel(sig.market)}`;
  $('#dMode').textContent = `${sig.mode} | ${sig.paType} | ${signalStatusLabel(sig.status)} | ${sig.source}`;
  $('#dScore').textContent = `总分 ${sig.score.toFixed(2)} / 3.00`;

  const entries = [
    ['入场位', formatNumber(sig.entry)],
    ['止损', formatNumber(sig.sl)],
    ['TP1', formatNumber(sig.tp1)],
    ['TP2', formatNumber(sig.tp2)],
    ['EMA200', formatNumber(sig.ema200)],
    ['RSI', sig.rsi.toFixed(2)],
    ['偏离度', `${sig.deviation.toFixed(2)}%`],
    ['盈亏比', sig.rr.toFixed(2)],
    ['Fib 0.5', formatNumber(sig.fib.fib50)],
    ['Fib 0.786', formatNumber(sig.fib.fib786)],
    ['箱体高点', formatNumber(sig.pivots.high)],
    ['箱体低点', formatNumber(sig.pivots.low)]
  ];

  $('#tradePlan').innerHTML = entries
    .map(([label, value]) => `<div class="kv"><span>${label}</span><strong>${value}</strong></div>`)
    .join('');

  $('#logicText').textContent =
    `PA ${sig.scoreBreakdown.pa.toFixed(1)} + Fib ${sig.scoreBreakdown.fib.toFixed(1)} + ` +
    `Box ${sig.scoreBreakdown.box.toFixed(1)} + Div ${sig.scoreBreakdown.divergence.toFixed(1)}。` +
    ` 当前为${sig.modeKey === 'trend' ? '顺势' : '逆势'}模式，扫描窗口 ${sig.scanWindow.join(' / ')}，` +
    `价格位于 ${formatNumber(sig.pivots.low)} - ${formatNumber(sig.pivots.high)} 的枢轴区间内。`;

  renderRadar(sig);
}

function renderBots() {
  const root = $('#bots');
  if (!state.config) {
    root.innerHTML = '<div class="empty-state">配置尚未加载。</div>';
    return;
  }

  root.innerHTML = state.config.bots.map((bot, index) => `
    <section class="bot-card">
      <h3>${bot.name}</h3>
      <div class="bot-rule">${bot.rule}</div>
      <div class="field">
        <label>Bot Token</label>
        <input type="password" data-bot-index="${index}" data-key="token" value="${bot.token || ''}" />
      </div>
      <div class="field">
        <label>Chat ID</label>
        <input type="text" data-bot-index="${index}" data-key="chatId" value="${bot.chatId || ''}" />
      </div>
      <div class="field">
        <label>启用</label>
        <input type="checkbox" data-bot-index="${index}" data-key="enabled" ${bot.enabled ? 'checked' : ''} />
      </div>
      <div class="bot-actions">
        <button class="action-btn" data-action="test-bot" data-bot-index="${index}">测试发送</button>
      </div>
    </section>
  `).join('');

  root.querySelectorAll('input').forEach((input) => {
    input.oninput = (event) => {
      const index = Number(event.target.dataset.botIndex);
      const key = event.target.dataset.key;
      state.config.bots[index][key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value.trim();
    };
    input.onchange = input.oninput;
  });

  root.querySelectorAll('[data-action="test-bot"]').forEach((button) => {
    button.onclick = async () => {
      const index = Number(button.dataset.botIndex);
      const bot = state.config.bots[index];
      try {
        await req('/api/telegram/test', {
          method: 'POST',
          body: JSON.stringify({ token: bot.token, chatId: bot.chatId, botName: bot.name })
        });
        toast(`${bot.name} 测试消息已发送`);
      } catch (error) {
        toast(`测试失败: ${error.message}`, true);
      }
    };
  });
}

function calcMaxDrawdown(points) {
  if (!points.length) return 0;
  let peak = points[0];
  let maxDd = 0;
  for (const value of points) {
    peak = Math.max(peak, value);
    maxDd = Math.max(maxDd, peak === 0 ? 0 : ((peak - value) / peak) * 100);
  }
  return maxDd;
}

function drawPnlChart(points) {
  const canvas = $('#pnlChart');
  const width = Math.max(280, canvas.parentElement.clientWidth || 320);
  const height = 220;
  const { ctx } = resizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(20, 10);
  ctx.lineTo(20, height - 20);
  ctx.lineTo(width - 12, height - 20);
  ctx.stroke();

  if (!points.length) return;

  const min = Math.min(...points, 100) - 2;
  const max = Math.max(...points, 100) + 2;
  const span = Math.max(1, max - min);

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = 24 + (index / Math.max(1, points.length - 1)) * (width - 40);
    const y = (height - 24) - ((point - min) / span) * (height - 40);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#00a3ff';
  ctx.shadowColor = '#00a3ff';
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const last = points[points.length - 1];
  ctx.fillStyle = '#d7e9ff';
  ctx.font = '12px JetBrains Mono';
  ctx.fillText(`Equity ${last.toFixed(2)}`, Math.max(28, width - 140), 18);
}

function histogramBuckets(values) {
  const defs = [
    { key: '<-2', label: '<-2R', count: 0, test: (v) => v < -2 },
    { key: '-2~-1', label: '-2R', count: 0, test: (v) => v >= -2 && v < -1 },
    { key: '-1~0', label: '-1R', count: 0, test: (v) => v >= -1 && v < 0 },
    { key: '0', label: '0', count: 0, test: (v) => v === 0 },
    { key: '0~1', label: '1R', count: 0, test: (v) => v > 0 && v <= 1 },
    { key: '1~1.5', label: '1.5R', count: 0, test: (v) => v > 1 && v <= 1.5 },
    { key: '1.5~2', label: '2R', count: 0, test: (v) => v > 1.5 && v <= 2 },
    { key: '>2', label: '3R+', count: 0, test: (v) => v > 2 }
  ];

  values.forEach((value) => {
    const bucket = defs.find((item) => item.test(value));
    if (bucket) bucket.count += 1;
  });
  return defs;
}

function renderHistogram(values) {
  const root = $('#rrHistogram');
  const buckets = histogramBuckets(values);
  const max = Math.max(1, ...buckets.map((item) => item.count));
  root.innerHTML = buckets.map((item) => `
    <div class="hist-bar">
      <div class="hist-bar-value">${item.count}</div>
      <div class="hist-bar-fill" style="height:${Math.max(4, (item.count / max) * 120)}px"></div>
      <div class="hist-bar-label">${item.label}</div>
    </div>
  `).join('');
}

function renderStatsMeta(text) {
  $('#statsMeta').textContent = text;
}

function renderStatsFromSignals() {
  const confirmed = state.signals.filter((item) => item.status === 'confirmed');
  if (!confirmed.length) {
    $('#winRate').textContent = '-';
    $('#avgRr').textContent = '-';
    $('#maxDd').textContent = '-';
    $('#backtestCount').textContent = '0';
    drawPnlChart([]);
    renderHistogram([]);
    renderStatsMeta('暂无回测快照，且当前确认信号不足以估算统计。');
    state.statsSource = 'empty';
    return;
  }

  let equity = 100;
  const curve = confirmed.map((sig) => {
    equity += sig.rr || 0;
    return Number(equity.toFixed(2));
  });
  const wins = confirmed.filter((sig) => sig.rr > 0).length;
  const winRate = (wins / confirmed.length) * 100;
  const avgRr = confirmed.reduce((sum, sig) => sum + (sig.rr || 0), 0) / confirmed.length;
  const maxDd = calcMaxDrawdown([100, ...curve]);

  $('#winRate').textContent = `${winRate.toFixed(1)}%`;
  $('#avgRr').textContent = avgRr.toFixed(2);
  $('#maxDd').textContent = `${maxDd.toFixed(2)}%`;
  $('#backtestCount').textContent = confirmed.length;
  drawPnlChart(curve);
  renderHistogram(confirmed.map((sig) => sig.rr || 0));
  renderStatsMeta('当前无历史快照，以下为基于确认信号 RR 的即时估算。');
  state.statsSource = 'estimated';
}

function applyBacktestSnapshot(snapshot) {
  $('#winRate').textContent = `${Number(snapshot.winRate || 0).toFixed(1)}%`;
  $('#avgRr').textContent = Number(snapshot.avgRr || 0).toFixed(2);
  $('#maxDd').textContent = `${Number(snapshot.maxDd || 0).toFixed(2)}%`;
  $('#backtestCount').textContent = Number(snapshot.totalSignals || 0);
  drawPnlChart((snapshot.equityCurve || []).map((point) => Number(point.equity || 0)));
  renderHistogram((snapshot.trades || []).map((trade) => Number(trade.rr || 0)));
  renderStatsMeta(`历史回测快照 ${formatTime(snapshot.at)}`);
  state.statsSource = 'snapshot';
}

function renderStatus() {
  const root = $('#statusCards');
  const status = state.status;
  if (!status) {
    root.innerHTML = '<div class="empty-state">系统状态尚未加载。</div>';
    return;
  }

  const latestRun = (status.scheduler?.lastResult || []).find(Boolean) || null;
  const cards = [
    ['Crypto Universe', status.universeCount?.crypto || 0],
    ['US Universe', status.universeCount?.us || 0],
    ['HK Universe', status.universeCount?.hk || 0],
    ['最近调度', latestRun ? `${latestRun.kind} / ${latestRun.market}` : '暂无'],
    ['最近回测', status.latestBacktest ? `${Number(status.latestBacktest.winRate || 0).toFixed(1)}%` : '暂无'],
    ['调度结束', status.scheduler?.lastEnd ? formatTime(status.scheduler.lastEnd) : '暂无']
  ];

  root.innerHTML = cards.map(([label, value]) => `
    <div class="status-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join('');
}

function renderLogs() {
  const root = $('#liveLog');
  const logs = [];

  state.signals.slice(0, 8).forEach((sig) => {
    logs.push({
      time: formatTime(sig.timestamp),
      title: `${sig.asset} · ${sig.status}`,
      text: `${sig.mode}，评分 ${sig.score.toFixed(2)}，RR ${sig.rr.toFixed(2)}，来源 ${sig.source}`
    });
  });

  (state.status?.scheduler?.lastResult || []).forEach((item) => {
    logs.unshift({
      time: formatTime(item.at),
      title: `Scheduler · ${item.kind}`,
      text: `market=${item.market}，ok=${item.ok ? 'true' : 'false'}，pushed=${item.pushed ?? '-'}，scanned=${item.scanned ?? '-'}`
    });
  });

  if (!logs.length) {
    root.innerHTML = '<div class="empty-state">还没有日志。</div>';
    return;
  }

  root.innerHTML = logs.slice(0, 12).map((log) => `
    <div class="log-item">
      <div class="log-time">${log.time}</div>
      <div class="log-title">${log.title}</div>
      <div class="log-text">${log.text}</div>
    </div>
  `).join('');
}

async function loadSignals() {
  const data = await req(`/api/signals?market=${state.market}`);
  state.signals = data.list || [];
  state.updatedAt = data.updatedAt || new Date().toISOString();
  if (!state.selectedAsset && state.signals.length) state.selectedAsset = state.signals[0].asset;
  if (state.selectedAsset && !state.signals.some((sig) => sig.asset === state.selectedAsset)) {
    state.selectedAsset = state.signals[0]?.asset || null;
  }
  renderMarketCounts();
  renderSignals();
  renderDetail();
  if (state.statsSource !== 'snapshot') renderStatsFromSignals();
}

async function loadConfig() {
  state.config = await req('/api/config');
  $('#trendSwitch').checked = !!state.config.switches?.trend;
  $('#counterSwitch').checked = !!state.config.switches?.counterTrend;
  renderBots();
}

async function loadBacktestStats() {
  try {
    const data = await req('/api/backtest/latest');
    state.backtest = data.snapshot;
    if (data.snapshot) applyBacktestSnapshot(data.snapshot);
    else renderStatsFromSignals();
  } catch {
    renderStatsFromSignals();
  }
}

async function loadStatus() {
  state.status = await req('/api/status');
  renderStatus();
  renderLogs();
}

function switchTab(tab) {
  $$('.nav-tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab));
}

function bindEvents() {
  $$('.nav-tab').forEach((button) => {
    button.onclick = () => switchTab(button.dataset.tab);
  });

  $$('.filter-btn').forEach((button) => {
    button.onclick = async () => {
      $$('.filter-btn').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      state.market = button.dataset.market;
      await refreshAll({ signalsOnly: true, preserveSnapshot: true });
    };
  });

  $('#scoreThreshold').oninput = (event) => {
    state.minScore = Number(event.target.value) / 10;
    $('#scoreThresholdLabel').textContent = state.minScore.toFixed(1);
    event.target.style.background = `linear-gradient(90deg, var(--accent-green) ${(state.minScore / 3) * 100}%, var(--text-dim) ${(state.minScore / 3) * 100}%)`;
    renderSignals();
  };
  $('#scoreThreshold').dispatchEvent(new Event('input'));

  $('#refreshBtn').onclick = async () => {
    try {
      await refreshAll({ preserveSnapshot: true });
      toast('扫描数据已更新');
    } catch (error) {
      toast(`刷新失败: ${error.message}`, true);
    }
  };

  $('#refreshUniverseBtn').onclick = async () => {
    try {
      await req('/api/universe/refresh', { method: 'POST' });
      await refreshAll({ preserveSnapshot: true });
      toast('标的池已刷新');
    } catch (error) {
      toast(`刷新标的池失败: ${error.message}`, true);
    }
  };

  $('#pushBtn').onclick = async () => {
    try {
      const data = await req('/api/push/run', { method: 'POST' });
      await loadStatus();
      toast(`推送完成：${data.pushed} 条`);
    } catch (error) {
      toast(`推送失败: ${error.message}`, true);
    }
  };

  $('#saveConfigBtn').onclick = async () => {
    try {
      state.config.switches.trend = $('#trendSwitch').checked;
      state.config.switches.counterTrend = $('#counterSwitch').checked;
      await req('/api/config', {
        method: 'POST',
        body: JSON.stringify(state.config)
      });
      toast('配置已保存');
      await loadConfig();
    } catch (error) {
      toast(`保存失败: ${error.message}`, true);
    }
  };

  $('#backtestBtn').onclick = async () => {
    try {
      const data = await req('/api/backtest/run', { method: 'POST' });
      state.backtest = data.snapshot;
      if (data.snapshot) applyBacktestSnapshot(data.snapshot);
      await loadStatus();
      toast('回测已完成并写入本地库');
    } catch (error) {
      toast(`回测失败: ${error.message}`, true);
    }
  };

  window.addEventListener('resize', () => {
    renderDetail();
    if (state.statsSource === 'snapshot' && state.backtest) applyBacktestSnapshot(state.backtest);
    else renderStatsFromSignals();
  });
}

async function refreshAll({ signalsOnly = false, preserveSnapshot = false } = {}) {
  await loadSignals();
  if (signalsOnly) {
    await loadStatus();
    startRefreshCountdown();
    return;
  }
  await loadConfig();
  await loadStatus();
  if (!preserveSnapshot) await loadBacktestStats();
  else if (state.backtest) applyBacktestSnapshot(state.backtest);
  else renderStatsFromSignals();
  startRefreshCountdown();
}

(async function init() {
  try {
    bindEvents();
    updateSystemClock();
    setInterval(updateSystemClock, 1000);
    await refreshAll();
    setInterval(() => {
      refreshAll({ preserveSnapshot: true }).catch((error) => toast(`自动刷新失败: ${error.message}`, true));
    }, 120000);
  } catch (error) {
    toast(`初始化失败: ${error.message}`, true);
    renderStatsMeta('页面加载失败，请检查后端接口或本地配置。');
  }
})();
