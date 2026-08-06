const API_URL = window.location.origin + '/api';
let activeTab = 'accepted';

function switchTab(tabName) {
  activeTab = tabName;
  const btnAcc = document.getElementById('btnTabAccepted');
  const btnRej = document.getElementById('btnTabRejected');
  const viewAcc = document.getElementById('viewAccepted');
  const viewRej = document.getElementById('viewRejected');
  const title = document.getElementById('tableTitle');
  if (tabName === 'accepted') {
    if (btnAcc) btnAcc.className = 'tab-btn active';
    if (btnRej) btnRej.className = 'tab-btn';
    if (viewAcc) viewAcc.style.display = 'block';
    if (viewRej) viewRej.style.display = 'none';
    if (title) title.innerText = '⚡ ÚLTIMOS 50 PICKS EMITIDOS — FEATURES COMPLETOS';
  } else {
    if (btnRej) btnRej.className = 'tab-btn active';
    if (btnAcc) btnAcc.className = 'tab-btn';
    if (viewRej) viewRej.style.display = 'block';
    if (viewAcc) viewAcc.style.display = 'none';
    if (title) title.innerText = '🛡️ PICKS DESCARTADOS POR LA DOBLE CAPA';
  }
}

function formatDate(tsStr) {
  if (!tsStr) return '-';
  try {
    const d = new Date(tsStr);
    return d.toLocaleDateString('es-MX', { month: '2-digit', day: '2-digit' })
      + ' ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) { return tsStr.slice(5, 16); }
}

function pct(val) {
  if (val == null) return '—';
  return (val * 100).toFixed(1) + '%';
}

function fmtOdd(val) {
  if (val == null) return '—';
  return val.toFixed(3);
}

// Mini barra visual para features 0-1
function miniBar(val, color) {
  if (val == null) return '—';
  const pctVal = Math.round(val * 100);
  return `<span class="feat-bar">
    <span class="bar" style="width:${pctVal}px;max-width:60px;background:${color}"></span>
    ${pctVal}%
  </span>`;
}

// CLV = (momio_entrada - momio_cierre_sharp) / momio_cierre_sharp * 100
function calcCLV(entry, closing) {
  if (!entry || !closing) return null;
  return ((entry - closing) / closing * 100).toFixed(1);
}

// Renderizador Canvas nativo — Curva de Banca
function drawEquityCanvas(byDay) {
  try {
    const canvas = document.getElementById('chartEquity');
    if (!canvas || !byDay || !byDay.length) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = rect.width > 0 ? rect.width : 600;
    const H = rect.height > 0 ? rect.height : 160;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const values = byDay.map(d => d.acumulado || 0);
    const labels = byDay.map(d => (d.dia || '').slice(5));
    const minV = Math.min(0, ...values);
    const maxV = Math.max(10, ...values);
    const range = (maxV - minV) || 1;
    const padL = 48, padR = 20, padT = 20, padB = 30;
    const gW = W - padL - padR, gH = H - padT - padB;

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = '#4a5568';
    for (let i = 0; i <= 4; i++) {
      const yV = minV + (range * i / 4);
      const yP = padT + gH - (i / 4) * gH;
      ctx.beginPath(); ctx.moveTo(padL, yP); ctx.lineTo(W - padR, yP); ctx.stroke();
      ctx.fillText(`${yV >= 0 ? '+' : ''}${yV.toFixed(1)}`, 5, yP + 3);
    }

    const pts = values.map((v, i) => ({
      x: padL + (i / (values.length - 1 || 1)) * gW,
      y: padT + gH - ((v - minV) / range) * gH,
      label: labels[i]
    }));

    const grad = ctx.createLinearGradient(0, padT, 0, padT + gH);
    grad.addColorStop(0, 'rgba(0,242,254,0.22)');
    grad.addColorStop(1, 'rgba(0,242,254,0)');
    ctx.beginPath(); ctx.moveTo(pts[0].x, padT + gH);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(pts[pts.length - 1].x, padT + gH); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) i === 0 ? ctx.moveTo(pts[i].x, pts[i].y) : ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = '#00f2fe'; ctx.lineWidth = 2.5; ctx.stroke();

    const step = Math.ceil(pts.length / 6);
    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#00f2fe'; ctx.fill();
      ctx.strokeStyle = '#07090e'; ctx.lineWidth = 1.5; ctx.stroke();
      if (i % step === 0 || i === pts.length - 1) {
        ctx.fillStyle = '#4a5568'; ctx.fillText(p.label, p.x - 12, H - 8);
      }
    });
  } catch (e) { console.error('drawEquity:', e); }
}

// Renderizador Canvas nativo — Barras por Deporte
function drawSportsCanvas(bySport) {
  try {
    const canvas = document.getElementById('chartSports');
    if (!canvas || !bySport || !bySport.length) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = rect.width > 0 ? rect.width : 300;
    const H = rect.height > 0 ? rect.height : 160;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const padL = 85, padR = 55, padT = 15, padB = 15;
    const bH = Math.min(22, Math.max(8, (H - padT - padB) / bySport.length - 6));
    const maxVal = Math.max(1, ...bySport.map(s => Math.abs(s.profit || 0)));

    bySport.forEach((s, i) => {
      const y = padT + i * (bH + 8);
      const bW = (Math.abs(s.profit || 0) / maxVal) * Math.max(1, W - padL - padR);
      const pos = (s.profit || 0) >= 0;
      ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = '#718096';
      ctx.fillText((s.sport || '').slice(0, 12), 4, y + bH - 5);
      ctx.fillStyle = pos ? '#00e676' : '#ff1744';
      ctx.fillRect(padL, y, Math.max(4, bW), bH);
      ctx.font = '11px JetBrains Mono, monospace'; ctx.fillStyle = pos ? '#00e676' : '#ff1744';
      ctx.fillText(`${pos ? '+' : ''}${(s.profit || 0).toFixed(1)}u`, padL + Math.max(4, bW) + 6, y + bH - 5);
    });
  } catch (e) { console.error('drawSports:', e); }
}

async function loadDashboardData() {
  const badge = document.getElementById('healthBadge');

  const [resSummary, resAccepted, resRejected] = await Promise.all([
    fetch(`${API_URL}/summary`).then(r => r.json()).catch(() => null),
    fetch(`${API_URL}/accepted`).then(r => r.json()).catch(() => null),
    fetch(`${API_URL}/rejected`).then(r => r.json()).catch(() => null),
  ]);

  // KPIs
  if (resSummary && resSummary.health) {
    const { health, stats } = resSummary;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
    set('kpiRoi', `${health.roi >= 0 ? '+' : ''}${health.roi.toFixed(2)}%`);
    set('kpiProfit', `${health.totalProfit >= 0 ? '+' : ''}${health.totalProfit.toFixed(2)}u ganancia neta`);
    set('kpiWr', `${health.wr.toFixed(1)}%`);
    set('kpiWins', `${health.wins} aciertos / ${health.n} picks`);
    set('kpiBrier', health.brierScore.toFixed(4));
    set('kpiEce', `${(health.ece * 100).toFixed(2)}%`);

    if (badge) {
      badge.innerText = `${health.color} ${health.status}`;
      badge.style.color = health.ece > 0.08 ? '#ff1744' : '#00e676';
    }

    if (stats) {
      if (stats.byDay) drawEquityCanvas(stats.byDay);
      if (stats.bySport) drawSportsCanvas(stats.bySport);
    }
  } else if (badge) {
    badge.innerText = '🟢 SISTEMA CONECTADO';
    badge.style.color = '#00e676';
  }

  // Tabla Emitidos — 21 columnas con todos los features
  const tbodyAcc = document.getElementById('tbodyAccepted');
  if (tbodyAcc) {
    if (resAccepted && Array.isArray(resAccepted.accepted) && resAccepted.accepted.length > 0) {
      tbodyAcc.innerHTML = resAccepted.accepted.map(p => {
        // Resultado
        let tagClass = 'tag-win', resTag = '';
        if (p.result === 'win') {
          resTag = `<span class="tag-win">✅ +${(p.profit || 0).toFixed(2)}u</span>`;
        } else if (p.result === 'loss') {
          const mb = p.loss_minute ? `<span class="badge-loss-min">⏱️ min ${p.loss_minute}'</span>` : '';
          resTag = `<span class="tag-loss">❌ -${(p.stake || 0).toFixed(2)}u</span>${mb}`;
        } else {
          resTag = `<span class="tag-push">⚪ 0.00u</span>`;
        }

        // Motor
        const engineBadge = p.score_version === 2
          ? `<span class="badge-engine engine-ml">ML</span>`
          : `<span class="badge-engine engine-h">HEU</span>`;

        // CLV
        const clvVal = calcCLV(p.odd_decimal, p.sharp_closing_odd);
        const clvTag = clvVal != null
          ? `<span class="${parseFloat(clvVal) >= 0 ? 'clv-pos' : 'clv-neg'}">${clvVal >= 0 ? '+' : ''}${clvVal}%</span>`
          : '—';

        // Modo stake
        const modeLabel = {
          'half_kelly': '½ Kelly',
          'full_kelly': 'Kelly',
          'flat': 'Flat',
        }[p.stake_mode] || (p.stake_mode || '—');

        return `<tr>
          <td class="mono" style="color:var(--text-muted)">#${p.id}</td>
          <td class="mono">${formatDate(p.ts)}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;"><b>${p.event || '-'}</b></td>
          <td>${p.sport || '-'}</td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;">${p.market || '-'}: <b>${p.selection || '-'}</b></td>
          <td>${engineBadge}</td>
          <td class="mono">@ ${fmtOdd(p.odd_decimal)}</td>
          <td class="mono" style="color:var(--text-muted)">${fmtOdd(p.opening_odd_decimal)}</td>
          <td class="mono">${clvTag}</td>
          <td class="mono" style="color:var(--accent)">${p.confPct || pct(p.conf)}</td>
          <td class="mono" style="color:var(--text-muted)">${p.confHeurPct || pct(p.conf_heuristic)}</td>
          <td class="mono" style="color:var(--purple)">${p.confMLPct || pct(p.conf_learned)}</td>
          <td class="mono" style="color:var(--yellow)">${p.edge != null ? p.edge.toFixed(3) : '—'}</td>
          <td>${miniBar(p.f_prob_justa, '#00f2fe')}</td>
          <td>${miniBar(p.f_avance, '#00e676')}</td>
          <td>${miniBar(p.f_situacion, '#ffb300')}</td>
          <td>${miniBar(p.f_linea, '#b983ff')}</td>
          <td>${miniBar(p.f_apertura, '#ff6b6b')}</td>
          <td class="mono"><b>${p.stake != null ? p.stake + 'u' : '—'}</b></td>
          <td class="mono" style="color:var(--text-muted);font-size:10px">${modeLabel}</td>
          <td class="mono">${resTag}</td>
        </tr>`;
      }).join('');
    } else {
      tbodyAcc.innerHTML = `<tr><td colspan="21" style="text-align:center;color:var(--text-muted);padding:30px;">Sin picks emitidos recientes.</td></tr>`;
    }
  }

  // Tabla Descartados
  if (resRejected) {
    const elSaved = document.getElementById('kpiSavedUnits');
    const elLosses = document.getElementById('kpiLossesAvoided');
    if (elSaved) elSaved.innerText = `+${resRejected.savedUnits || 0}u`;
    if (elLosses) elLosses.innerText = `${resRejected.totalLossesAvoided || 0} pérdidas prevenidas`;
  }

  const tbodyRej = document.getElementById('tbodyRejected');
  if (tbodyRej) {
    if (resRejected && Array.isArray(resRejected.rejected) && resRejected.rejected.length > 0) {
      tbodyRej.innerHTML = resRejected.rejected.slice(0, 50).map(r => {
        let resColor = '#4a5568';
        if (r.result === 'win') resColor = '#00e676';
        else if (r.result === 'loss') resColor = '#ff1744';

        const oddVal = r.odd_decimal ? r.odd_decimal.toFixed(3) : '—';
        const stakeVal = r.stake ? `${r.stake}u` : '—';

        let statusTag = r.statusTag || '—';
        if (r.result === 'loss' && r.loss_minute) {
          statusTag = `❌ Perdido (-${r.stake.toFixed(2)}u) <span class="badge-loss-min">⏱️ min ${r.loss_minute}'</span>`;
        }

        return `<tr>
          <td class="mono" style="color:var(--text-muted)">#${r.id}</td>
          <td class="mono">${formatDate(r.ts)}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;"><b>${r.event || '-'}</b></td>
          <td>${r.sport || '-'}</td>
          <td>${r.market || '-'}: <b>${r.selection || '-'}</b></td>
          <td class="mono">@ ${oddVal}</td>
          <td class="mono">${stakeVal}</td>
          <td><span class="tag-reason">⚠️ ${r.reason || 'Bloqueado'}</span></td>
          <td style="color:${resColor};font-weight:700;" class="mono">${statusTag}</td>
        </tr>`;
      }).join('');
    } else {
      tbodyRej.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:30px;">Sin picks descartados.</td></tr>`;
    }
  }
}

function runInit() {
  switchTab('accepted');
  loadDashboardData();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runInit);
} else {
  runInit();
}
