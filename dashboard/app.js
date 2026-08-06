const API_URL = 'http://localhost:3001/api';

async function loadDashboardData() {
  try {
    const [resSummary, resRejected] = await Promise.all([
      fetch(`${API_URL}/summary`).then(r => r.json()),
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
    document.getElementById('kpiSharpe').innerText = health.sharpeRatio ? health.sharpeRatio.toFixed(2) : 'N/A';

    const badge = document.getElementById('healthBadge');
    badge.innerText = `${health.color} ${health.status}`;
    badge.className = `badge ${health.ece > 0.08 ? 'badge-warn' : 'badge-ok'}`;

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
            borderColor: '#3fb950',
            backgroundColor: 'rgba(63, 185, 80, 0.1)',
            fill: true,
            tension: 0.3,
            borderWidth: 2,
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e' } },
            y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e' } }
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
            backgroundColor: sportProfits.map(v => v >= 0 ? '#238636' : '#da3633'),
            borderRadius: 4,
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e' } },
            y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e' } }
          }
        }
      });
    }

    // Renderizar tabla de rechazados
    const tbody = document.getElementById('tableRejected');
    if (resRejected && resRejected.rejected && resRejected.rejected.length > 0) {
      tbody.innerHTML = resRejected.rejected.slice(0, 20).map(r => `
        <tr>
          <td>#${r.id}</td>
          <td>${r.ts ? r.ts.slice(11, 16) : '-'}</td>
          <td><b>${r.event}</b></td>
          <td>${r.sport}</td>
          <td>${r.market}: <b>${r.selection}</b> @ ${r.odd_decimal.toFixed(2)}</td>
          <td>${r.stake}u</td>
          <td><span style="color: #f85149; font-weight: 600;">⚠️ ${r.reason}</span></td>
        </tr>
      `).join('');
    } else {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No hay picks rechazados recientemente.</td></tr>`;
    }

  } catch (e) {
    console.error('Error cargando datos del dashboard:', e);
  }
}

document.addEventListener('DOMContentLoaded', loadDashboardData);
