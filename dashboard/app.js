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
    if (title) title.innerText = '⚡ HISTÓRICO DE PICKS EMITIDOS EN VIVO (ÚLTIMOS 50)';
  } else {
    if (btnRej) btnRej.className = 'tab-btn active';
    if (btnAcc) btnAcc.className = 'tab-btn';
    if (viewRej) viewRej.style.display = 'block';
    if (viewAcc) viewAcc.style.display = 'none';
    if (title) title.innerText = '🛡️ PICKS DESCARTADOS POR LA DOBLE CAPA & RESOLUCIÓN REAL';
  }
}

function formatDate(tsStr) {
  if (!tsStr) return '-';
  try {
    const d = new Date(tsStr);
    const datePart = d.toLocaleDateString('es-MX', { month: '2-digit', day: '2-digit' });
    const timePart = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${datePart} ${timePart}`;
  } catch (e) {
    return tsStr.slice(5, 16);
  }
}

// Renderizador Nativo HTML5 Canvas 2D ultra-defensivo para la Curva de Banca
function drawEquityCanvas(byDay) {
  try {
    const canvas = document.getElementById('chartEquity');
    if (!canvas || !byDay || !Array.isArray(byDay) || byDay.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const wVal = rect.width > 0 ? rect.width : 600;
    const hVal = rect.height > 0 ? rect.height : 180;

    canvas.width = wVal * dpr;
    canvas.height = hVal * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const W = wVal;
    const H = hVal;
    ctx.clearRect(0, 0, W, H);

    const values = byDay.map(d => d.acumulado || 0);
    const labels = byDay.map(d => (d.dia || '').slice(5));
    let minV = Math.min(0, ...values);
    let maxV = Math.max(10, ...values);
    const range = (maxV - minV) || 1;

    const padLeft = 45, padRight = 20, padTop = 20, padBottom = 30;
    const graphW = W - padLeft - padRight;
    const graphH = H - padTop - padBottom;

    if (graphW <= 0 || graphH <= 0) return;

    // Cuadrícula tenue
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#64748b';

    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const yVal = minV + (range * i) / gridSteps;
      const yPos = padTop + graphH - (i / gridSteps) * graphH;
      ctx.beginPath();
      ctx.moveTo(padLeft, yPos);
      ctx.lineTo(W - padRight, yPos);
      ctx.stroke();
      ctx.fillText(`${yVal >= 0 ? '+' : ''}${yVal.toFixed(1)}u`, 5, yPos + 3);
    }

    // Mapear puntos
    const points = values.map((v, i) => {
      const x = padLeft + (i / (values.length - 1 || 1)) * graphW;
      const y = padTop + graphH - ((v - minV) / range) * graphH;
      return { x, y, val: v, label: labels[i] };
    });

    if (!points || points.length === 0) return;

    // Relleno cian degradado
    const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + graphH);
    gradient.addColorStop(0, 'rgba(0, 242, 254, 0.25)');
    gradient.addColorStop(1, 'rgba(0, 242, 254, 0.0)');

    ctx.beginPath();
    ctx.moveTo(points[0].x, padTop + graphH);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.lineTo(points[points.length - 1].x, padTop + graphH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Línea neón cian
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      if (i === 0) ctx.moveTo(points[i].x, points[i].y);
      else ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = '#00f2fe';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Puntos y etiquetas
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#00f2fe';
      ctx.fill();
      ctx.strokeStyle = '#07090e';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (i % Math.ceil(points.length / 6) === 0 || i === points.length - 1) {
        ctx.fillStyle = '#64748b';
        ctx.fillText(p.label || '', p.x - 12, H - 8);
      }
    }
  } catch (err) {
    console.error('Error drawing equity canvas:', err);
  }
}

// Renderizador Nativo HTML5 Canvas 2D ultra-defensivo para Deportes
function drawSportsCanvas(bySport) {
  try {
    const canvas = document.getElementById('chartSports');
    if (!canvas || !bySport || !Array.isArray(bySport) || bySport.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const wVal = rect.width > 0 ? rect.width : 300;
    const hVal = rect.height > 0 ? rect.height : 180;

    canvas.width = wVal * dpr;
    canvas.height = hVal * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const W = wVal;
    const H = hVal;
    ctx.clearRect(0, 0, W, H);

    const padLeft = 80, padRight = 50, padTop = 15, padBottom = 15;
    const barHeight = Math.min(22, Math.max(8, (H - padTop - padBottom) / bySport.length - 6));

    let maxVal = Math.max(1, ...bySport.map(s => Math.abs(s.profit || 0)));

    bySport.forEach((s, i) => {
      const y = padTop + i * (barHeight + 8);
      const barW = (Math.abs(s.profit || 0) / maxVal) * Math.max(1, W - padLeft - padRight);
      const isPos = (s.profit || 0) >= 0;

      ctx.font = '11px "Inter", sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText((s.sport || '').slice(0, 12), 5, y + barHeight - 6);

      ctx.fillStyle = isPos ? '#00e676' : '#ff1744';
      ctx.fillRect(padLeft, y, Math.max(4, barW), barHeight);

      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillStyle = isPos ? '#00e676' : '#ff1744';
      ctx.fillText(`${isPos ? '+' : ''}${(s.profit || 0).toFixed(1)}u`, padLeft + Math.max(4, barW) + 6, y + barHeight - 6);
    });
  } catch (err) {
    console.error('Error drawing sports canvas:', err);
  }
}

async function loadDashboardData() {
  const badge = document.getElementById('healthBadge');

  // Peticiones paralelas defensivas
  const [resSummary, resAccepted, resRejected] = await Promise.all([
    fetch(`${API_URL}/summary`).then(r => r.json()).catch(err => { console.error('Summary API err:', err); return null; }),
    fetch(`${API_URL}/accepted`).then(r => r.json()).catch(err => { console.error('Accepted API err:', err); return null; }),
    fetch(`${API_URL}/rejected`).then(r => r.json()).catch(err => { console.error('Rejected API err:', err); return null; }),
  ]);

  // 1. KPIs y Gráficas
  if (resSummary && resSummary.health) {
    const { health, stats } = resSummary;
    const elRoi = document.getElementById('kpiRoi');
    const elProfit = document.getElementById('kpiProfit');
    const elWr = document.getElementById('kpiWr');
    const elWins = document.getElementById('kpiWins');
    const elBrier = document.getElementById('kpiBrier');
    const elEce = document.getElementById('kpiEce');

    if (elRoi) elRoi.innerText = `${health.roi >= 0 ? '+' : ''}${health.roi.toFixed(2)}%`;
    if (elProfit) elProfit.innerText = `${health.totalProfit >= 0 ? '+' : ''}${health.totalProfit.toFixed(2)}u ganancia neta`;
    if (elWr) elWr.innerText = `${health.wr.toFixed(1)}%`;
    if (elWins) elWins.innerText = `${health.wins} aciertos / ${health.n} picks`;
    if (elBrier) elBrier.innerText = health.brierScore.toFixed(4);
    if (elEce) elEce.innerText = `${(health.ece * 100).toFixed(2)}%`;

    if (badge) {
      badge.innerText = `${health.color} ${health.status}`;
      badge.style.color = health.ece > 0.08 ? '#ff1744' : '#00e676';
      badge.style.borderColor = health.ece > 0.08 ? 'rgba(255, 23, 68, 0.4)' : 'rgba(0, 230, 118, 0.4)';
    }

    if (stats && stats.byDay) drawEquityCanvas(stats.byDay);
    if (stats && stats.bySport) drawSportsCanvas(stats.bySport);
  } else if (badge) {
    badge.innerText = '🟢 SISTEMA CONECTADO';
    badge.style.color = '#00e676';
  }

  // 2. Renderizar Tabla 1: Picks Emitidos (Últimos 50)
  const tbodyAccepted = document.getElementById('tbodyAccepted');
  if (tbodyAccepted) {
    if (resAccepted && Array.isArray(resAccepted.accepted) && resAccepted.accepted.length > 0) {
      tbodyAccepted.innerHTML = resAccepted.accepted.map(p => {
        let tagClass = 'tag-win';
        let resTag = `✅ +${(p.profit || 0).toFixed(2)}u`;
        if (p.result === 'loss') {
          tagClass = 'tag-loss';
          const minBadge = p.loss_minute ? `<span class="badge-loss-min">⏱️ min ${p.loss_minute}'</span>` : '';
          resTag = `❌ -${(p.stake || 0).toFixed(2)}u ${minBadge}`;
        } else if (p.result === 'push') {
          tagClass = 'mono';
          resTag = `⚪ 0.00u`;
        }

        const oddVal = p.odd_decimal ? p.odd_decimal.toFixed(2) : '-';
        const confVal = p.confPct || `${((p.conf || 0) * 100).toFixed(1)}%`;
        const stakeVal = p.stake ? `${p.stake}u` : '-';

        return `
          <tr>
            <td class="mono">#${p.id}</td>
            <td class="mono">${formatDate(p.ts)}</td>
            <td><b>${p.event || '-'}</b></td>
            <td>${p.sport || '-'}</td>
            <td>${p.market || '-'}: <b>${p.selection || '-'}</b></td>
            <td class="mono">@ ${oddVal}</td>
            <td class="mono">${confVal}</td>
            <td class="mono">${stakeVal}</td>
            <td class="${tagClass} mono">${resTag}</td>
          </tr>
        `;
      }).join('');
    } else {
      tbodyAccepted.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Sin picks emitidos recientes.</td></tr>`;
    }
  }

  // 3. Renderizar Tabla 2: Picks Descartados
  if (resRejected) {
    const elSaved = document.getElementById('kpiSavedUnits');
    const elLosses = document.getElementById('kpiLossesAvoided');
    if (elSaved) elSaved.innerText = `+${resRejected.savedUnits || 0}u`;
    if (elLosses) elLosses.innerText = `${resRejected.totalLossesAvoided || 0} pérdidas prevenidas`;
  }

  const tbodyRejected = document.getElementById('tbodyRejected');
  if (tbodyRejected) {
    if (resRejected && Array.isArray(resRejected.rejected) && resRejected.rejected.length > 0) {
      tbodyRejected.innerHTML = resRejected.rejected.slice(0, 50).map(r => {
        let resColor = '#8b949e';
        if (r.result === 'win') resColor = '#00e676';
        else if (r.result === 'loss') resColor = '#ff1744';

        const oddVal = r.odd_decimal ? r.odd_decimal.toFixed(2) : '-';
        const stakeVal = r.stake ? `${r.stake}u` : '-';

        let statusTag = r.statusTag || '-';
        if (r.result === 'loss' && r.loss_minute) {
          statusTag = `❌ Perdido (-${r.stake.toFixed(2)}u) <span class="badge-loss-min">⏱️ min ${r.loss_minute}'</span>`;
        }

        return `
          <tr>
            <td class="mono">#${r.id}</td>
            <td class="mono">${formatDate(r.ts)}</td>
            <td><b>${r.event || '-'}</b></td>
            <td>${r.sport || '-'}</td>
            <td>${r.market || '-'}: <b>${r.selection || '-'}</b></td>
            <td class="mono">@ ${oddVal}</td>
            <td class="mono">${stakeVal}</td>
            <td><span class="tag-reason">⚠️ ${r.reason || 'Bloqueado'}</span></td>
            <td><span class="mono" style="color: ${resColor}; font-weight: 700;">${statusTag}</span></td>
          </tr>
        `;
      }).join('');
    } else {
      tbodyRejected.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Sin picks descartados recientes.</td></tr>`;
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
