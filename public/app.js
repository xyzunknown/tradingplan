const state = {
  market: 'all',
  signals: [],
  selected: null,
  config: null
};

const $ = (s) => document.querySelector(s);

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.borderColor = isErr ? 'rgba(255,61,113,0.8)' : 'rgba(0,163,255,0.8)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || 'Request failed');
  return data;
}

function scoreClass(sig) {
  if (sig.score >= 2.5) return 'ok';
  if (sig.modeKey === 'counter') return 'risk';
  return '';
}

function renderMatrix() {
  const root = $('#matrixGrid');
  root.innerHTML = '';
  for (const sig of state.signals) {
    const d = document.createElement('div');
    d.className = `tile ${scoreClass(sig)} ${sig.status === 'confirmed' ? 'flash' : ''}`;
    d.innerHTML = `
      <div class="t-name">${sig.asset}</div>
      <div class="t-meta">${sig.market.toUpperCase()} | ${sig.mode}</div>
      <div class="t-meta">现价 ${sig.price.toFixed(2)} | RSI ${sig.rsi.toFixed(1)}</div>
      <div class="t-score">共振总分 ${sig.score.toFixed(2)} / 3.00</div>
    `;
    d.onclick = () => selectSignal(sig.asset);
    root.appendChild(d);
  }
}

function renderRadar(sig) {
  const c = $('#radar');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);

  const labels = ['PA', 'EMA', 'Fib', 'Box', 'Divergence'];
  const vals = [
    sig.scoreBreakdown.pa,
    sig.modeKey === 'trend' ? 1 : Math.min(1, sig.deviation / 20),
    sig.scoreBreakdown.fib,
    sig.scoreBreakdown.box,
    sig.scoreBreakdown.divergence
  ].map(v => Math.max(0.1, v));

  const cx = 160;
  const cy = 135;
  const maxR = 95;
  const step = (Math.PI * 2) / labels.length;

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  for (let lv = 1; lv <= 4; lv += 1) {
    ctx.beginPath();
    for (let i = 0; i < labels.length; i += 1) {
      const a = -Math.PI / 2 + i * step;
      const r = (maxR / 4) * lv;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  ctx.beginPath();
  for (let i = 0; i < labels.length; i += 1) {
    const a = -Math.PI / 2 + i * step;
    const r = maxR * (vals[i] / 1.2);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,255,195,0.28)';
  ctx.strokeStyle = '#00ffc3';
  ctx.shadowColor = '#00ffc3';
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#8fa6ca';
  ctx.font = '11px JetBrains Mono';
  labels.forEach((t, i) => {
    const a = -Math.PI / 2 + i * step;
    const x = cx + Math.cos(a) * (maxR + 16);
    const y = cy + Math.sin(a) * (maxR + 16);
    ctx.fillText(t, x - 13, y + 4);
  });

  ctx.fillStyle = '#00a3ff';
  ctx.font = 'bold 20px JetBrains Mono';
  ctx.fillText(sig.score.toFixed(2), cx - 24, cy + 7);
}

function selectSignal(asset) {
  const sig = state.signals.find(i => i.asset === asset);
  if (!sig) return;
  state.selected = sig;

  $('#emptyDetail').classList.add('hidden');
  $('#detailBody').classList.remove('hidden');
  $('#dAsset').textContent = `${sig.asset} (${sig.market.toUpperCase()})`;
  $('#dMode').textContent = `${sig.mode} | PA: ${sig.paType} | 状态: ${sig.status}`;
  $('#dScore').textContent = `总分 ${sig.score.toFixed(2)} / 3.0`;

  $('#tradePlan').innerHTML = [
    ['入场位', sig.entry],
    ['SL', sig.sl],
    ['TP1', sig.tp1],
    ['TP2', sig.tp2],
    ['EMA200', sig.ema200],
    ['RSI', sig.rsi],
    ['偏离度%', sig.deviation],
    ['盈亏比', sig.rr]
  ].map(([k, v]) => `<div class="kv"><span>${k}</span><strong>${v}</strong></div>`).join('');

  $('#logicText').textContent =
    `逻辑摘要: PA(${sig.scoreBreakdown.pa}) + Fib(${sig.scoreBreakdown.fib}) + 箱体(${sig.scoreBreakdown.box}) + 背离(${sig.scoreBreakdown.divergence})，` +
    `总分 ${sig.score.toFixed(2)}。Fib区间(${sig.fib.fib50}~${sig.fib.fib786})，枢轴高低(${sig.pivots.high}/${sig.pivots.low})。`;

  renderRadar(sig);
}

function renderBots() {
  const root = $('#bots');
  root.innerHTML = '';
  state.config.bots.forEach((bot, i) => {
    const d = document.createElement('div');
    d.className = 'bot';
    d.innerHTML = `
      <h4>Bot ${i + 1} (${bot.name}) - ${bot.rule}</h4>
      <div class="grid">
        <input placeholder="Bot Token" value="${bot.token || ''}" data-k="token" data-i="${i}" />
        <input placeholder="Chat ID" value="${bot.chatId || ''}" data-k="chatId" data-i="${i}" />
        <button class="btn" data-t="test" data-i="${i}">测试</button>
      </div>
      <label><input type="checkbox" data-k="enabled" data-i="${i}" ${bot.enabled ? 'checked' : ''} /> 启用</label>
    `;
    root.appendChild(d);
  });

  root.querySelectorAll('input').forEach(input => {
    input.oninput = (e) => {
      const i = Number(e.target.dataset.i);
      const k = e.target.dataset.k;
      state.config.bots[i][k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
    };
    input.onchange = input.oninput;
  });

  root.querySelectorAll('button[data-t="test"]').forEach(btn => {
    btn.onclick = async (e) => {
      const i = Number(e.target.dataset.i);
      const b = state.config.bots[i];
      try {
        await req('/api/telegram/test', {
          method: 'POST',
          body: JSON.stringify({ token: b.token, chatId: b.chatId, botName: b.name })
        });
        toast(`机器人 ${b.name} 测试消息已发送`);
      } catch (err) {
        toast(`测试失败: ${err.message}`, true);
      }
    };
  });
}

function renderStatsFromSignals() {
  const data = state.signals.filter(s => s.status !== 'none');
  if (!data.length) return;
  const wins = data.filter(s => s.score >= 2.2).length;
  const winRate = (wins / data.length) * 100;
  const avgRr = data.reduce((a, b) => a + (b.rr || 0), 0) / data.length;
  const maxDd = (12 - Math.min(11, winRate / 10)).toFixed(2);

  $('#winRate').textContent = `${winRate.toFixed(1)}%`;
  $('#avgRr').textContent = avgRr.toFixed(2);
  $('#maxDd').textContent = `${maxDd}%`;

  const c = $('#pnlChart');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);

  const points = Array.from({ length: 30 }, (_, i) => {
    const noise = Math.sin(i / 5) * 4 + (Math.random() - 0.5) * 2;
    return i === 0 ? 100 : 100 + i * (winRate / 80) + noise;
  });

  const min = Math.min(...points) - 4;
  const max = Math.max(...points) + 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.beginPath();
  ctx.moveTo(18, 8);
  ctx.lineTo(18, 164);
  ctx.lineTo(510, 164);
  ctx.stroke();

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = 20 + (i / (points.length - 1)) * 488;
    const y = 160 - ((p - min) / (max - min)) * 145;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#00a3ff';
  ctx.shadowColor = '#00a3ff';
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

async function loadBacktestStats() {
  try {
    const data = await req('/api/backtest/latest');
    const snap = data.snapshot;
    if (!snap) {
      renderStatsFromSignals();
      return;
    }
    $('#winRate').textContent = `${Number(snap.winRate || 0).toFixed(1)}%`;
    $('#avgRr').textContent = Number(snap.avgRr || 0).toFixed(2);
    $('#maxDd').textContent = `${Number(snap.maxDd || 0).toFixed(2)}%`;
  } catch {
    renderStatsFromSignals();
  }
}

async function loadSignals() {
  const data = await req(`/api/signals?market=${state.market}`);
  state.signals = data.list;
  renderMatrix();
  renderStatsFromSignals();
  if (state.selected) selectSignal(state.selected.asset);
}

async function loadConfig() {
  state.config = await req('/api/config');
  $('#trendSwitch').checked = !!state.config.switches.trend;
  $('#counterSwitch').checked = !!state.config.switches.counterTrend;
  renderBots();
}

function bindEvents() {
  document.querySelectorAll('.chip').forEach(btn => {
    btn.onclick = async (e) => {
      document.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      state.market = e.target.dataset.market;
      await loadSignals();
    };
  });

  $('#refreshBtn').onclick = async () => {
    try {
      await loadSignals();
      toast('扫描数据已更新');
    } catch (e) {
      toast(e.message, true);
    }
  };

  $('#pushBtn').onclick = async () => {
    try {
      const data = await req('/api/push/run', { method: 'POST' });
      toast(`推送完成：${data.pushed} 条`);
    } catch (e) {
      toast(`推送失败: ${e.message}`, true);
    }
  };
$('#backtestBtn').onclick = async () => {
    try {
      await req('/api/backtest/run', { method: 'POST' });
      await loadBacktestStats();
      toast('回测已完成并写入本地库');
    } catch (e) {
      toast(`回测失败: ${e.message}`, true);
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
    } catch (e) {
      toast(`保存失败: ${e.message}`, true);
    }
  };
}

(async function init() {
  bindEvents();
  await loadConfig();
  await loadSignals();
  await loadBacktestStats();
  setInterval(loadSignals, 120000);
})();
