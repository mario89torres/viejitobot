const API_URL = 'http://localhost:3001/api';
let activeTab = 'accepted';

function switchTab(tabName) {
  activeTab = tabName;
  const btnAcc = document.getElementById('btnTabAccepted');
  const btnRej = document.getElementById('btnTabRejected');
  const viewAcc = document.getElementById('viewAccepted');
  const viewRej = document.getElementById('viewRejected');
  const title = document.getElementById('tableTitle');

  if (tabName === 'accepted') {
    btnAcc.classList.add('active');
    btnRej.classList.remove('active');
    viewAcc.style.display = 'block';
    viewRej.style.display = 'none';
    title.innerText = '⚡ HISTÓRICO DE PICKS EMITIDOS EN VIVO (ÚLTIMOS 50)';
  } else {
    btnRej.classList.add('active');
    btnAcc.classList.remove('active');
    viewRej.style.display = 'block';
    viewAcc.style.display = 'none';
    title.innerText = '🛡️ PICKS DESCARTADOS POR LA DOBLE CAPA & RESOLUCIÓN REAL';
  }
}

async function loadDashboardData() {
  try {
    const [resSummary, resAccepted, resRejected] = await Promise.all([
      fetch(`${API_URL}/summary`).then(r => r.json()),
      fetch(`${API_URL}/accepted`).then(r => r.json()),
      fetch(`${API_URL}/rejected`).then(r => r.json()),
    ]);

    const { health, stats } = resSummary;

    // Actualizar KPIs
    document.getElementById('kpiRoi').innerText = `${health.roi >= 0 ? '+' : ''}${health.roi.toFixed(2)}%`;
    document.getElementById('kpiProfit').innerText = `${health.totalProfit >= 0 ? '+' : ''}${health.totalProfit.toFixed(2)}u ganancia neta`;
    document.getElementById('kpiWr').innerText = `${health.wr.toFixed(1)}%`;
    document.getElementById('kpiWins').innerText = `${health.wins} aciertos / ${health.n} picks`;
    document.getElementById('kpiBrier').innerText = health.brierScore.toFixed(4);
    document.getElementById('kpiEce').innerText = `${(health.ece * 100).toFixed(2)}%`;

    if (resRejected) {
      document.getElementById('kpiSavedUnits').innerText = `+${resRejected.savedUnits || 0}u`;
      document.getElementById('kpiLossesAvoided').innerText = `${resRejected.totalLossesAvoided || 0} pérdidas prevenidas`;
    }

    const badge = document.getElementById('healthBadge');
    badge.innerText = `${health.color} ${health.status}`;
    badge.style.color = health.ece > 0.08 ? '#ff1744' : '#00e676';
    badge.style.borderColor = health.ece > 0.08 ? 'rgba(255, 23, 68, 0.4)' : 'rgba(0, 230, 118, 0.4)';

    // Renderizar gráfico de Banca Acumulada
    if (stats && stats.byDay) {
      const labels = stats.byDay.map(d => d.dia.slice(5));
      const equityData = stats.byDay.map(d => d.acumulado);

      const ctxEquity = document.getElementById('chartEquity').getContext('2d');
      new Chart(ctxEquity, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Banca Acumulada (u)',
            data: equityData,
            borderColor: '#00f2fe',
            backgroundColor: 'rgba(0, 242, 254, 0.08)',
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#00f2fe',
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#64748b', font: { family: 'JetBrains Mono' } } },
            y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#64748b', font: { family: 'JetBrains Mono' } } }
          }
        }
      });
    }

    // Renderizar gráfico por deporte
    if (stats && stats.bySport) {
      const sportLabels = stats.bySport.map(s => s.sport);
      const sportProfits = stats.bySport.map(s => s.profit);

      const ctxSports = document.getElementById('chartSports').getContext('2d');
      new Chart(ctxSports, {
        type: 'bar',
        data: {
          labels: sportLabels,
          datasets: [{
            label: 'Ganancia (u)',
            data: sportProfits,
            backgroundColor: sportProfits.map(v => v >= 0 ? '#00e676' : '#ff1744'),
            borderRadius: 6,
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#64748b' } },
            y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#64748b' } }
          }
        }
      });
    }

    // Renderizar Tabla 1: Picks Emitidos (Últimos 50)
    const tbodyAccepted = document.getElementById('tbodyAccepted');
    if (resAccepted && resAccepted.accepted && resAccepted.accepted.length > 0) {
      tbodyAccepted.innerHTML = resAccepted.accepted.map(p => {
        let tagClass = 'tag-win';
        let resTag = `✅ +${p.profit.toFixed(2)}u`;
        if (p.result === 'loss') {
          tagClass = 'tag-loss';
          const minLoss = p.loss_minute ? ` (min ${p.loss_minute}')` : '';
          resTag = `❌ -${p.stake.toFixed(2)}u${minLoss}`;
        } else if (p.result === 'push') {
          tagClass = 'mono';
          resTag = `⚪ 0.00u`;
        }

        return `
          <tr>
            <td class="mono">#${p.id}</td>
            <td class="mono">${p.ts ? p.ts.slice(11, 16) : '-'}</td>
            <td><b>${p.event}</b></td>
            <td>${p.sport}</td>
            <td>${p.market}: <b>${p.selection}</b></td>
            <td class="mono">@ ${p.odd_decimal.toFixed(2)}</td>
            <td class="mono">${p.confPct}</td>
            <td class="mono">${p.stake}u</td>
            <td class="${tagClass} mono">${resTag}</td>
          </tr>
        `;
      }).join('');
    } else {
      tbodyAccepted.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Sin picks emitidos recientes.</td></tr>`;
    }

    // Renderizar Tabla 2: Picks Descartados
    const tbodyRejected = document.getElementById('tbodyRejected');
    if (resRejected && resRejected.rejected && resRejected.rejected.length > 0) {
      tbodyRejected.innerHTML = resRejected.rejected.slice(0, 30).map(r => {
        let resColor = '#8b949e';
        if (r.result === 'win') resColor = '#00e676';
        else if (r.result === 'loss') resColor = '#ff1744';

        return `
          <tr>
            <td class="mono">#${r.id}</td>
            <td class="mono">${r.ts ? r.ts.slice(11, 16) : '-'}</td>
            <td><b>${r.event}</b></td>
            <td>${r.sport}</td>
            <td>${r.market}: <b>${r.selection}</b></td>
            <td class="mono">@ ${r.odd_decimal.toFixed(2)}</td>
            <td class="mono">${r.stake}u</td>
            <td><span class="tag-reason">⚠️ ${r.reason}</span></td>
            <td><span class="mono" style="color: ${resColor}; font-weight: 700;">${r.statusTag}</span></td>
          </tr>
        `;
      }).join('');
    } else {
      tbodyRejected.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Sin picks descartados recientes.</td></tr>`;
    }

  } catch (e) {
    console.error('Error cargando datos del dashboard:', e);
  }
}

document.addEventListener('DOMContentLoaded', loadDashboardData);
