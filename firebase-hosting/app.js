const API_URL = window.location.origin + '/api';

// ── Tab navigation ────────────────────────────────────────────
const TABS = ['charts', 'picks', 'rejected', 'live', 'matrix'];
let cachedAcceptedPicks = [];

async function openTab(name) {
  TABS.forEach(t => {
    const cap = t.charAt(0).toUpperCase() + t.slice(1);
    document.getElementById('panel' + cap)?.classList.remove('active');
    document.getElementById('btn'   + cap)?.classList.remove('active');
  });
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  document.getElementById('panel' + cap)?.classList.add('active');
  document.getElementById('btn'   + cap)?.classList.add('active');
  
  if (name === 'live') refreshLive();
  if (name === 'matrix') {
    if (!cachedAcceptedPicks || !cachedAcceptedPicks.length) {
      try {
        const res = await fetch(`${API_URL}/accepted`).then(r => r.json());
        if (res?.accepted) cachedAcceptedPicks = res.accepted;
      } catch (e) {}
    }
    renderMatrix(cachedAcceptedPicks);
  }
}

// ── Formatters ────────────────────────────────────────────────
function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('es-MX', { month: '2-digit', day: '2-digit' })
    + ' ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtOdd(v)  { return v == null ? '—' : v.toFixed(3); }
function fmtPct(v)  { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
function fmtEdge(v) { return v == null ? '—' : v.toFixed(3); }

function clvTag(entry, closing) {
  if (!entry || !closing) return '<span class="c-dim">—</span>';
  const c = ((entry - closing) / closing * 100).toFixed(1);
  const cls = parseFloat(c) >= 0 ? 'clv-pos' : 'clv-neg';
  return `<span class="${cls}">${c >= 0 ? '+' : ''}${c}%</span>`;
}

function playdoitLink(eventId, sportId, eventName) {
  if (!eventName) return '—';
  if (!eventId) return eventName;
  const url = `https://www.playdoit.mx/#/sport/${sportId || 66}/event/${eventId}`;
  return `<a href="${url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;text-decoration-color:var(--border2)" title="Apostar en Playdoit">${eventName}</a>`;
}

function miniBar(val, color) {
  if (val == null) return '<span class="c-dim">—</span>';
  const w = Math.round(val * 40);
  const pct = Math.round(val * 100);
  return `<span class="mbar">
    <span class="mbar-track"><span class="mbar-fill" style="width:${w}px;background:${color}"></span></span>
    <span class="mbar-num">${pct}%</span>
  </span>`;
}

const COLORS = {
  f_prob:  '#56b6c2',
  f_av:    '#98c379',
  f_sit:   '#e5c07b',
  f_lin:   '#c678dd',
  f_ap:    '#e06c75',
};

const modeLabel = m => ({ half_kelly: '½K', full_kelly: 'K', flat: 'F' }[m] || (m || '—'));

// ── Canvas: Equity curve ──────────────────────────────────────
function drawEquity(byDay) {
  try {
    const canvas = document.getElementById('chartEquity');
    if (!canvas || !byDay?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.getBoundingClientRect().width || 500;
    const H = 160;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const vals = byDay.map(d => d.acumulado || 0);
    const labs = byDay.map(d => (d.dia || '').slice(5));
    const minV = Math.min(0, ...vals), maxV = Math.max(1, ...vals);
    const range = maxV - minV || 1;
    const pL = 46, pR = 12, pT = 12, pB = 24;
    const gW = W - pL - pR, gH = H - pT - pB;

    // grid lines
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
    ctx.font = '9px JetBrains Mono, monospace'; ctx.fillStyle = '#3a3a3a';
    for (let i = 0; i <= 4; i++) {
      const yV = minV + range * i / 4;
      const yP = pT + gH - (i / 4) * gH;
      ctx.beginPath(); ctx.moveTo(pL, yP); ctx.lineTo(W - pR, yP); ctx.stroke();
      ctx.fillText(`${yV >= 0 ? '+' : ''}${yV.toFixed(1)}`, 2, yP + 3);
    }

    const pts = vals.map((v, i) => ({
      x: pL + (vals.length < 2 ? gW / 2 : i / (vals.length - 1) * gW),
      y: pT + gH - ((v - minV) / range) * gH,
    }));

    // area fill
    const grad = ctx.createLinearGradient(0, pT, 0, pT + gH);
    grad.addColorStop(0, 'rgba(152,195,121,0.12)');
    grad.addColorStop(1, 'rgba(152,195,121,0)');
    ctx.beginPath(); ctx.moveTo(pts[0].x, pT + gH);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts.at(-1).x, pT + gH); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // line
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = '#98c379'; ctx.lineWidth = 1.5; ctx.stroke();

    // dots + labels
    const step = Math.ceil(pts.length / 7);
    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#98c379'; ctx.fill();
      if (i % step === 0 || i === pts.length - 1) {
        ctx.fillStyle = '#3a3a3a'; ctx.fillText(labs[i], p.x - 10, H - 6);
      }
    });
  } catch (e) { console.error('drawEquity', e); }
}

// ── Canvas: Sports bars ───────────────────────────────────────
function drawSports(bySport) {
  try {
    const canvas = document.getElementById('chartSports');
    if (!canvas || !bySport?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.getBoundingClientRect().width || 260;
    const H = 160;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const pL = 80, pR = 50, pT = 8, pB = 8;
    const bH = Math.min(18, (H - pT - pB) / bySport.length - 5);
    const maxV = Math.max(0.1, ...bySport.map(s => Math.abs(s.profit || 0)));

    bySport.forEach((s, i) => {
      const y = pT + i * (bH + 6);
      const bW = (Math.abs(s.profit || 0) / maxV) * (W - pL - pR);
      const pos = (s.profit || 0) >= 0;
      const col = pos ? '#98c379' : '#e06c75';

      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = '#3a3a3a';
      ctx.fillText((s.sport || '').slice(0, 10), 2, y + bH - 2);
      ctx.fillStyle = col;
      ctx.fillRect(pL, y, Math.max(2, bW), bH);
      ctx.fillStyle = col;
      ctx.fillText(`${pos ? '+' : ''}${(s.profit || 0).toFixed(1)}u`, pL + Math.max(2, bW) + 5, y + bH - 2);
    });
  } catch (e) { console.error('drawSports', e); }
}

// ── Render picks table ────────────────────────────────────────
function renderPicks(accepted) {
  const tbody = document.getElementById('tbodyPicks');
  if (!tbody) return;
  const cnt = document.getElementById('cntAccepted');

  if (!accepted?.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="21">sin picks emitidos</td></tr>`;
    if (cnt) cnt.textContent = '';
    return;
  }

  if (cnt) cnt.textContent = `(${accepted.length})`;

  tbody.innerHTML = accepted.map(p => {
    let res = '';
    if (p.result === 'win') {
      res = `<span class="tag-win">+${(p.profit || 0).toFixed(2)}u</span>`;
    } else if (p.result === 'loss') {
      const mb = p.loss_minute ? `<span class="min-badge">min ${p.loss_minute}'</span>` : '';
      res = `<span class="tag-loss">-${(p.stake || 0).toFixed(2)}u${mb}</span>`;
    } else {
      res = `<span class="tag-push">0.00u</span>`;
    }

    const eng = p.score_version === 2
      ? `<span class="eng eng-ml">ML</span>`
      : `<span class="eng eng-h">H</span>`;

    return `<tr>
      <td class="col-id">#${p.id}</td>
      <td class="col-ts">${fmtTs(p.ts)}</td>
      <td class="col-event">${playdoitLink(p.event_id, p.sport_id, p.event)}</td>
      <td class="col-sport">${p.sport || '—'}</td>
      <td class="col-mkt">${p.market || '—'} <span class="c-dim">·</span> <b>${p.selection || '—'}</b></td>
      <td>${eng}</td>
      <td class="col-odd">${fmtOdd(p.odd_decimal)}</td>
      <td class="c-dim">${fmtOdd(p.opening_odd_decimal)}</td>
      <td>${clvTag(p.odd_decimal, p.sharp_closing_odd)}</td>
      <td class="col-conf">${p.confPct || fmtPct(p.conf)}</td>
      <td class="c-dim">${p.confHeurPct || fmtPct(p.conf_heuristic)}</td>
      <td class="col-ml">${p.confMLPct || fmtPct(p.conf_learned)}</td>
      <td class="col-edge">${fmtEdge(p.edge)}</td>
      <td>${miniBar(p.f_prob_justa, COLORS.f_prob)}</td>
      <td>${miniBar(p.f_avance,    COLORS.f_av)}</td>
      <td>${miniBar(p.f_situacion, COLORS.f_sit)}</td>
      <td>${miniBar(p.f_linea,     COLORS.f_lin)}</td>
      <td>${miniBar(p.f_apertura,  COLORS.f_ap)}</td>
      <td class="col-stake">${p.stake != null ? p.stake + 'u' : '—'}</td>
      <td class="c-dim">${modeLabel(p.stake_mode)}</td>
      <td>${res}</td>
    </tr>`;
  }).join('');
}

// ── Render rejected table ─────────────────────────────────────
function renderRejected(rejected) {
  const tbody = document.getElementById('tbodyRejected');
  if (!tbody) return;
  const cnt = document.getElementById('cntRejected');

  if (!rejected?.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">sin picks descartados</td></tr>`;
    if (cnt) cnt.textContent = '';
    return;
  }

  if (cnt) cnt.textContent = `(${rejected.length})`;

  tbody.innerHTML = rejected.slice(0, 50).map(r => {
    let resTxt = r.statusTag || '—';
    let resCol = '#555';
    if (r.result === 'win') resCol = '#98c379';
    else if (r.result === 'loss') resCol = '#e06c75';
    if (r.result === 'loss' && r.loss_minute) {
      resTxt += ` <span class="min-badge">min ${r.loss_minute}'</span>`;
    }

    return `<tr>
      <td class="col-id">#${r.id}</td>
      <td class="col-ts">${fmtTs(r.ts)}</td>
      <td class="col-event">${playdoitLink(r.event_id, r.sport_id, r.event)}</td>
      <td class="col-sport">${r.sport || '—'}</td>
      <td class="col-mkt">${r.market || '—'} <span class="c-dim">·</span> <b>${r.selection || '—'}</b></td>
      <td class="col-odd">${fmtOdd(r.odd_decimal)}</td>
      <td class="col-stake">${r.stake ? r.stake + 'u' : '—'}</td>
      <td class="reason">${r.reason || 'bloqueado'}</td>
      <td style="color:${resCol}">${resTxt}</td>
    </tr>`;
  }).join('');
}

// ── Main data load ────────────────────────────────────────────
async function loadData() {
  const badge = document.getElementById('statusBadge');
  const upd   = document.getElementById('lastUpdate');

  try {
    const [resSummary, resAccepted, resRejected] = await Promise.all([
      fetch(`${API_URL}/summary`).then(r => r.json()).catch(() => null),
      fetch(`${API_URL}/accepted`).then(r => r.json()).catch(() => null),
      fetch(`${API_URL}/rejected`).then(r => r.json()).catch(() => null),
    ]);

    // KPIs
    if (resSummary?.health) {
      const { health, stats } = resSummary;
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

      const roi = health.roi;
      document.getElementById('kpiRoi').textContent = `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`;
      document.getElementById('kpiRoi').className = `kpi-val ${roi >= 0 ? 'c-green' : 'c-red'}`;
      set('kpiProfit', `${health.totalProfit >= 0 ? '+' : ''}${health.totalProfit.toFixed(2)}u neto`);
      set('kpiWr', `${health.wr.toFixed(1)}%`);
      set('kpiWins', `${health.wins}W / ${health.n} picks`);
      set('kpiN', health.n);
      set('kpiBrier', health.brierScore.toFixed(4));

      const ece = health.ece;
      const eceEl = document.getElementById('kpiEce');
      if (eceEl) {
        eceEl.textContent = `${(ece * 100).toFixed(2)}%`;
        eceEl.className = `kpi-val ${ece > 0.08 ? 'c-red' : ece > 0.05 ? 'c-orange' : 'c-green'}`;
      }

      if (health.logLoss != null) set('kpiLogLoss', health.logLoss.toFixed(4));

      if (badge) {
        badge.textContent = `● ${health.status}`;
        badge.style.color = ece > 0.08 ? '#e06c75' : '#98c379';
      }
      if (upd) upd.textContent = `updated ${fmtTs(new Date().toISOString())}`;

      if (stats?.byDay)   drawEquity(stats.byDay);
      if (stats?.bySport) drawSports(stats.bySport);
    }

    // Accepted
    if (resAccepted?.accepted) {
      cachedAcceptedPicks = resAccepted.accepted;
      renderPicks(cachedAcceptedPicks);
      const cntMat = document.getElementById('cntMatrix');
      if (cntMat) cntMat.textContent = `(${cachedAcceptedPicks.length})`;
      if (document.getElementById('panelMatrix')?.classList.contains('active')) {
        renderMatrix(cachedAcceptedPicks);
      }
    }

    // Rejected
    if (resRejected) {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('kpiSaved', `+${resRejected.savedUnits || 0}u`);
      set('kpiLossesAvoided', `${resRejected.totalLossesAvoided || 0} pérdidas bloqueadas`);
      if (resRejected.rejected) renderRejected(resRejected.rejected);
    }

  } catch (e) {
    console.error('loadData error:', e);
    if (badge) { badge.textContent = '● error'; badge.style.color = '#e06c75'; }
  }
}

// ── Sparkline canvas ──────────────────────────────────────────
function drawSparkline(canvasEl, data, entryOdd) {
  if (!canvasEl || !data?.length) return;
  const W = 70, H = 22, dpr = window.devicePixelRatio || 1;
  canvasEl.width = W * dpr; canvasEl.height = H * dpr;
  const ctx = canvasEl.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const minV = Math.min(...data), maxV = Math.max(...data);
  const range = (maxV - minV) || 0.01;
  const pts = data.map((v, i) => ({
    x: (i / Math.max(data.length - 1, 1)) * (W - 4) + 2,
    y: H - 4 - ((v - minV) / range) * (H - 8),
  }));

  // entry odd line
  if (entryOdd != null) {
    const ey = H - 4 - ((entryOdd - minV) / range) * (H - 8);
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(0, ey); ctx.lineTo(W, ey);
    ctx.strokeStyle = '#3a3a3a'; ctx.lineWidth = 1; ctx.stroke();
    ctx.setLineDash([]);
  }

  // line
  const last = data.at(-1), first = data[0];
  const col = last <= first ? '#98c379' : '#e06c75'; // cuota bajó = verde para nosotros
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();

  // last dot
  const lp = pts.at(-1);
  ctx.beginPath(); ctx.arc(lp.x, lp.y, 2, 0, Math.PI * 2);
  ctx.fillStyle = col; ctx.fill();
}

// ── Render Live table ─────────────────────────────────────────
function renderLive(liveData) {
  const tbody = document.getElementById('tbodyLive');
  const cnt   = document.getElementById('cntLive');
  const sync  = document.getElementById('liveLastSync');

  if (sync) sync.textContent = new Date().toLocaleTimeString('es-MX', { hour12: false });

  if (!tbody) return;
  if (!liveData?.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="16">no hay picks pendientes de resolución en este momento</td></tr>`;
    if (cnt) cnt.textContent = '';
    return;
  }

  if (cnt) cnt.textContent = `(${liveData.length})`;

  tbody.innerHTML = liveData.map((p, rowIdx) => {
    // Dirección del movimiento
    const dirArrow = p.direction === 'up'   ? '<span class="dir-up">↑</span>'
                   : p.direction === 'down' ? '<span class="dir-down">↓</span>'
                   : '<span class="dir-stbl">—</span>';

    // Δ entre entry y actual
    const delta = (p.current_odd != null && p.entry_odd != null)
      ? (p.current_odd - p.entry_odd).toFixed(3)
      : null;
    const deltaTag = delta == null ? '—'
      : `<span class="${parseFloat(delta) < 0 ? 'live-clv-pos' : parseFloat(delta) > 0 ? 'live-clv-neg' : 'c-dim'}">${parseFloat(delta) > 0 ? '+' : ''}${delta}</span>`;

    // Live CLV
    const clvTag = p.live_clv == null ? '<span class="c-dim">—</span>'
      : `<span class="${p.live_clv > 0 ? 'live-clv-pos' : p.live_clv < 0 ? 'live-clv-neg' : 'c-dim'}">${p.live_clv > 0 ? '+' : ''}${p.live_clv}%</span>`;

    // Drift total
    const driftTag = p.total_drift == null ? '<span class="c-dim">—</span>'
      : `<span class="c-dim">${p.total_drift > 0 ? '+' : ''}${p.total_drift}%</span>`;

    // Alert badge
    let alertTag = '<span class="alert-ok">ok</span>';
    if (p.alert === 'SUSPENDED')           alertTag = '<span class="alert-badge alert-suspended">⏸ SUSPENDIDA</span>';
    else if (p.alert === 'LINE_MOVED_AGAINST_US') alertTag = '<span class="alert-badge alert-against">⚠ LÍNEA vs</span>';
    else if (p.alert === 'LINE_MOVED_FOR_US')     alertTag = '<span class="alert-badge alert-for">✓ LÍNEA a favor</span>';

    // Tiempo transcurrido
    const elapsed = p.elapsed_min < 60
      ? `${p.elapsed_min}m`
      : `${Math.floor(p.elapsed_min / 60)}h ${p.elapsed_min % 60}m`;

    // Canvas ID único para sparkline
    const sparkId = `spark-${rowIdx}-${p.id}`;

    return `<tr>
      <td class="col-id">#${p.id}</td>
      <td class="c-dim">${elapsed}</td>
      <td class="col-event">${playdoitLink(p.event_id, p.sport_id, p.event)}</td>
      <td class="col-sport">${p.sport || '—'}</td>
      <td class="col-mkt">${p.market || '—'} <span class="c-dim">·</span> <b>${p.selection || '—'}</b></td>
      <td class="col-odd">${p.entry_odd != null ? p.entry_odd.toFixed(3) : '—'}</td>
      <td class="col-odd" style="color:${p.current_odd != null && p.current_odd < p.entry_odd ? '#98c379' : p.current_odd != null && p.current_odd > p.entry_odd ? '#e06c75' : '#d4d4d4'}">${p.current_odd != null ? p.current_odd.toFixed(3) : '<span class="c-dim">sin datos</span>'}</td>
      <td>${dirArrow} ${deltaTag}</td>
      <td>${clvTag}</td>
      <td>${driftTag}</td>
      <td><canvas class="sparkline" id="${sparkId}"></canvas></td>
      <td class="snap-count">${p.snapshot_count || 0}</td>
      <td class="col-conf">${p.conf != null ? (p.conf * 100).toFixed(1) + '%' : '—'}</td>
      <td class="col-edge">${p.edge != null ? p.edge.toFixed(3) : '—'}</td>
      <td class="col-stake">${p.stake != null ? p.stake + 'u' : '—'}</td>
      <td>${alertTag}</td>
    </tr>`;
  }).join('');

  // Dibujar sparklines después del render
  requestAnimationFrame(() => {
    liveData.forEach((p, rowIdx) => {
      const canvas = document.getElementById(`spark-${rowIdx}-${p.id}`);
      if (canvas && p.sparkline?.length) drawSparkline(canvas, p.sparkline, p.entry_odd);
    });
  });
}

// ── Refresh live ──────────────────────────────────────────────
async function refreshLive() {
  try {
    const res = await fetch(`${API_URL}/live`).then(r => r.json());
    renderLive(res?.live || []);
  } catch (e) {
    console.error('refreshLive error:', e);
  }
}

// ── Auto-refresh live cada 30s ────────────────────────────────
setInterval(() => {
  const livePanel = document.getElementById('panelLive');
  if (livePanel?.classList.contains('active')) refreshLive();
}, 30000);

// ── Render Matrix 10x5 ─────────────────────────────────────────
function renderMatrix(picks) {
  const grid = document.getElementById('matrixGrid');
  if (!grid) return;

  if (!picks || !picks.length) {
    grid.innerHTML = `<div class="c-dim" style="grid-column:1/-1;text-align:center;padding:40px">no hay picks para mostrar en la matriz</div>`;
    return;
  }

  // Tomar los últimos 50 picks
  const list = picks.slice(0, 50);

  grid.innerHTML = list.map((p, idx) => {
    let cardClass = 'card-pending';
    let badgeText = '● LIVE';
    let badgeStyle = 'background:rgba(229,192,123,0.15);color:var(--yellow)';

    if (p.result === 'win') {
      cardClass = 'card-win';
      badgeText = `✓ +${(p.profit || 0).toFixed(2)}u`;
      badgeStyle = 'background:rgba(152,195,121,0.2);color:var(--green)';
    } else if (p.result === 'loss') {
      cardClass = 'card-loss';
      badgeText = `✗ -${(p.stake || 0).toFixed(2)}u`;
      badgeStyle = 'background:rgba(224,108,117,0.2);color:var(--red)';
    } else if (p.result === 'push') {
      cardClass = 'card-push';
      badgeText = '⚪ 0.00u';
      badgeStyle = 'background:rgba(255,255,255,0.05);color:var(--gray)';
    }

    const shortSport = (p.sport || 'Fútbol').slice(0, 8);
    const shortEvent = (p.event || '—').slice(0, 24);
    const shortMkt   = (p.selection || p.market || '—').slice(0, 18);
    const oddVal     = p.odd_decimal ? `@ ${p.odd_decimal.toFixed(2)}` : '—';

    return `<div class="matrix-card ${cardClass}" onclick="openPickModal(${p.id})">
      <div>
        <div class="mcard-top">
          <span class="mcard-id">#${p.id}</span>
          <span class="mcard-sport">${shortSport}</span>
        </div>
        <div class="mcard-event">${shortEvent}</div>
        <div class="mcard-mkt">${shortMkt}</div>
      </div>
      <div class="mcard-bottom">
        <span class="mcard-odd">${oddVal}</span>
        <span class="mcard-badge" style="${badgeStyle}">${badgeText}</span>
      </div>
    </div>`;
  }).join('');
}

// ── Fullscreen Pick Inspector Modal ────────────────────────────
async function openPickModal(pickId) {
  const modal = document.getElementById('modalPickInspector');
  if (!modal) return;
  modal.classList.add('active');

  // Reset modal fields
  document.getElementById('mModalTitle').innerHTML = `<span>#${pickId}</span> <span style="color:var(--gray)">|</span> <span>Cargando datos de snapshots...</span>`;
  document.getElementById('mModalSub').textContent = 'Consultando base de datos cuantitativa...';
  document.getElementById('mModalRecText').textContent = 'Analizando trayectoria de cuotas...';
  document.getElementById('mModalRecBadge').textContent = 'PROCESANDO';

  try {
    const res = await fetch(`${API_URL}/pick-timeline?id=${pickId}`).then(r => r.json());
    if (res.error) {
      document.getElementById('mModalTitle').textContent = `Error: ${res.error}`;
      return;
    }

    const { pick, analytics, timeline } = res;

    // Header
    const titleEl = document.getElementById('mModalTitle');
    const playLink = playdoitLink(pick.event_id, pick.sport_id, pick.event);
    titleEl.innerHTML = `<span>#${pick.id}</span> <span style="color:var(--gray)">|</span> <span>${playLink}</span> <span class="c-cyan" style="font-size:12px">(${pick.sport})</span>`;

    const subEl = document.getElementById('mModalSub');
    subEl.innerHTML = `Mercado: <b>${pick.market}</b> · Selección: <b style="color:var(--yellow)">${pick.selection}</b> · Emitido: ${fmtTs(pick.ts)}`;

    // Banner recommendation
    const banner = document.getElementById('mModalBanner');
    const recText = document.getElementById('mModalRecText');
    const recBadge = document.getElementById('mModalRecBadge');

    recText.textContent = analytics.recommendation;
    recBadge.textContent = analytics.trajectory;
    recBadge.style.background = analytics.recColor;
    recBadge.style.color = '#000';
    banner.style.background = analytics.recColor + '1a';
    banner.style.borderColor = analytics.recColor + '66';
    banner.style.color = analytics.recColor;

    // Stats breakdown
    const statsEl = document.getElementById('mModalStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="modal-stat-row"><span class="modal-stat-label">Cuota Entrada:</span><span class="modal-stat-value c-orange">@ ${fmtOdd(pick.odd_decimal)}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Última Cuota Snap:</span><span class="modal-stat-value" style="color:${analytics.lastOdd < pick.odd_decimal ? '#98c379' : analytics.lastOdd > pick.odd_decimal ? '#e06c75' : '#d4d4d4'}">@ ${fmtOdd(analytics.lastOdd)}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Rango Cuota Snap:</span><span class="modal-stat-value c-dim">mín @ ${fmtOdd(analytics.minOdd)} / máx @ ${fmtOdd(analytics.maxOdd)}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Confianza Total:</span><span class="modal-stat-value c-blue">${pick.confPct}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">ConfHeuristic / ConfML:</span><span class="modal-stat-value c-purple">${pick.confHeurPct || '—'} / ${pick.confMLPct || '—'}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Edge Estimado:</span><span class="modal-stat-value c-yellow">${fmtEdge(pick.edge)}</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Stake Recomendado:</span><span class="modal-stat-value">${pick.stake}u (${modeLabel(pick.stake_mode)})</span></div>
        <div class="modal-stat-row"><span class="modal-stat-label">Resultado Final:</span><span class="modal-stat-value" style="color:${pick.result === 'win' ? '#98c379' : pick.result === 'loss' ? '#e06c75' : '#555'}">${(pick.result || 'PENDIENTE').toUpperCase()} ${pick.loss_minute ? `(min ${pick.loss_minute}')` : ''}</span></div>
      `;
    }

    // Canvas Chart
    drawModalSnapshotChart('chartModalSnapshot', timeline, pick.odd_decimal);

    // Timeline Table
    const snapBody = document.getElementById('mModalSnapBody');
    const snapCount = document.getElementById('mModalSnapCount');
    if (snapCount) snapCount.textContent = timeline.length;

    if (snapBody) {
      if (!timeline.length) {
        snapBody.innerHTML = `<tr><td colspan="7" class="c-dim" style="text-align:center">sin snapshots registrados para este evento</td></tr>`;
      } else {
        snapBody.innerHTML = timeline.map(s => {
          const isSusp = s.suspended === 1;
          return `<tr>
            <td class="col-id">#${s.id}</td>
            <td class="c-dim">${fmtTs(s.ts)}</td>
            <td class="col-ts">${s.live_time || '—'}</td>
            <td style="color:#fff;font-weight:600">${s.score || '—'}</td>
            <td class="col-odd" style="color:${s.odd_decimal < pick.odd_decimal ? '#98c379' : s.odd_decimal > pick.odd_decimal ? '#e06c75' : '#d4d4d4'}">@ ${fmtOdd(s.odd_decimal)}</td>
            <td class="c-dim">${s.odd_american || '—'}</td>
            <td>${isSusp ? '<span class="alert-badge alert-suspended">⏸ SUSPENDIDO</span>' : '<span class="c-green">✓ ACTIVO</span>'}</td>
          </tr>`;
        }).join('');
      }
    }

  } catch (e) {
    console.error('openPickModal error:', e);
  }
}

function closePickModal() {
  const modal = document.getElementById('modalPickInspector');
  if (modal) modal.classList.remove('active');
}

// Esc key listener to close modal
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePickModal();
});

// ── Draw Modal Odds Timeline Chart ──────────────────────────────
function drawModalSnapshotChart(canvasId, timeline, entryOdd) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const W = rect.width || 700;
  const H = 220;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const activeSnaps = timeline.filter(s => !s.suspended && s.odd_decimal > 0);
  const data = activeSnaps.map(s => s.odd_decimal);

  if (!data.length) {
    ctx.font = '12px JetBrains Mono, monospace'; ctx.fillStyle = '#555';
    ctx.fillText('Sin historial de cuotas disponible en snapshots', 20, H / 2);
    return;
  }

  const allVals = [...data, entryOdd].filter(Boolean);
  const minV = Math.min(...allVals) * 0.95;
  const maxV = Math.max(...allVals) * 1.05;
  const range = (maxV - minV) || 0.1;

  const pL = 50, pR = 20, pT = 20, pB = 30;
  const gW = W - pL - pR, gH = H - pT - pB;

  // Grid
  ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
  ctx.font = '10px JetBrains Mono, monospace'; ctx.fillStyle = '#3a3a3a';
  for (let i = 0; i <= 4; i++) {
    const yV = minV + range * i / 4;
    const yP = pT + gH - (i / 4) * gH;
    ctx.beginPath(); ctx.moveTo(pL, yP); ctx.lineTo(W - pR, yP); ctx.stroke();
    ctx.fillText(`@${yV.toFixed(2)}`, 5, yP + 3);
  }

  // Entry Odd Baseline
  if (entryOdd) {
    const ey = pT + gH - ((entryOdd - minV) / range) * gH;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#e5c07b'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pL, ey); ctx.lineTo(W - pR, ey); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e5c07b'; ctx.fillText(`Entry @ ${entryOdd.toFixed(2)}`, W - pR - 90, ey - 4);
  }

  const pts = activeSnaps.map((s, i) => ({
    x: pL + (activeSnaps.length < 2 ? gW / 2 : i / (activeSnaps.length - 1) * gW),
    y: pT + gH - ((s.odd_decimal - minV) / range) * gH,
    score: s.score,
    time: s.live_time || fmtTs(s.ts).slice(6),
  }));

  // Line
  const first = data[0], last = data.at(-1);
  const col = last <= entryOdd ? '#98c379' : '#e06c75';

  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();

  // Dots
  pts.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = '#09090b'; ctx.lineWidth = 1; ctx.stroke();
  });
}

// Init
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadData);
else loadData();
