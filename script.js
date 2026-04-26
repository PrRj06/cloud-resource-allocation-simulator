let vms = [];
let simInterval = null;
let isRunning = false;
let simSpeed = 2;
let taskRate = 3;
let totalAllocated = 0;
let totalFailed = 0;
let demandLevel = 'low';
let rrPointer = 0;
let timeLabels = [];
let cpuHistory = [];
let memHistory = [];
const MAX_HISTORY = 30;
let darkMode = false;
let barChart;
let lineChart;

function getTaskDuration() {
  return parseInt(document.getElementById('taskDuration').value, 10) || 10;
}

function expireTasks() {
  const now = Date.now();
  let freed = 0;

  for (const vm of vms) {
    const remaining = [];
    for (const task of vm.tasks) {
      if (now >= task.expiresAt) {
        vm.cpuUsed = Math.max(0, vm.cpuUsed - task.cpuReq);
        vm.memUsed = Math.max(0, vm.memUsed - task.memReq);
        freed++;
      } else {
        remaining.push(task);
      }
    }

    if (remaining.length !== vm.tasks.length) {
      const completed = vm.tasks.length - remaining.length;
      log(`${completed} task(s) completed on ${vm.name}`, 'ok');
    }

    vm.tasks = remaining;
  }

  return freed;
}

function initVMs() {
  const n = parseInt(document.getElementById('numVMs').value, 10) || 4;
  const cpu = parseInt(document.getElementById('vmCPU').value, 10) || 8;
  const mem = parseInt(document.getElementById('vmMem').value, 10) || 16;

  if (isRunning) pauseSim();
  resetCounters();

  vms = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `vm-${String(i + 1).padStart(2, '0')}`,
    cpuCap: cpu,
    memCap: mem,
    cpuUsed: 0,
    memUsed: 0,
    tasks: [],
  }));

  rrPointer = 0;
  renderVMGrid();
  updateBarChart();
  updateMetrics();
  log(`Initialized ${n} VMs (${cpu} cores / ${mem} GB each)`, 'ok');
  updateAlgoDisplay();
  showToast(`${n} VMs ready`);
}

function allocateTask(cpuReq, memReq, durationSec = getTaskDuration()) {
  if (!vms.length) {
    log('No VMs initialized!', 'err');
    return false;
  }

  const algo = document.getElementById('algoSel').value;
  let target = null;

  if (algo === 'round-robin') {
    for (let i = 0; i < vms.length; i++) {
      const vm = vms[(rrPointer + i) % vms.length];
      if (vm.cpuUsed + cpuReq <= vm.cpuCap && vm.memUsed + memReq <= vm.memCap) {
        target = vm;
        rrPointer = (vms.indexOf(vm) + 1) % vms.length;
        break;
      }
    }
  } else if (algo === 'first-fit') {
    target = vms.find(vm => vm.cpuUsed + cpuReq <= vm.cpuCap && vm.memUsed + memReq <= vm.memCap) || null;
  } else if (algo === 'best-fit') {
    let minWaste = Infinity;
    for (const vm of vms) {
      if (vm.cpuUsed + cpuReq <= vm.cpuCap && vm.memUsed + memReq <= vm.memCap) {
        const waste = (vm.cpuCap - vm.cpuUsed - cpuReq) + (vm.memCap - vm.memUsed - memReq);
        if (waste < minWaste) {
          minWaste = waste;
          target = vm;
        }
      }
    }
  }

  if (target) {
    target.cpuUsed += cpuReq;
    target.memUsed += memReq;
    target.tasks.push({
      cpuReq,
      memReq,
      durationSec,
      expiresAt: Date.now() + (durationSec * 1000),
    });
    totalAllocated++;
    log(`Task [${cpuReq}c/${memReq}GB, ${durationSec}s] → ${target.name}`, 'ok');
    return true;
  }

  totalFailed++;
  log(`Task [${cpuReq}c/${memReq}GB] → FAILED (no capacity)`, 'err');
  return false;
}

function addTask() {
  if (!vms.length) {
    showToast('Initialize VMs first');
    return;
  }
  const cpu = parseInt(document.getElementById('taskCPU').value, 10) || 1;
  const mem = parseInt(document.getElementById('taskMem').value, 10) || 1;
  const duration = getTaskDuration();
  allocateTask(cpu, mem, duration);
  refreshAll();
}

function autoGenWorkload() {
  if (!vms.length) {
    showToast('Initialize VMs first');
    return;
  }

  const count = demandLevel === 'low' ? 3 : demandLevel === 'med' ? 6 : 10;
  const maxCPU = vms[0]?.cpuCap || 8;
  const maxMem = vms[0]?.memCap || 16;

  let ok = 0;
  for (let i = 0; i < count; i++) {
    const mult = demandLevel === 'low' ? 0.25 : demandLevel === 'med' ? 0.45 : 0.7;
    const c = Math.max(1, Math.round(Math.random() * maxCPU * mult));
    const m = Math.max(1, Math.round(Math.random() * maxMem * mult));
    const duration = getTaskDuration();
    if (allocateTask(c, m, duration)) ok++;
  }

  log(`Auto-generated ${count} tasks (${ok} placed, ${count - ok} failed)`, ok === count ? 'ok' : 'warn');
  refreshAll();
}

function setDemand(level, el) {
  demandLevel = level;
  document.querySelectorAll('.demand-btn').forEach(button => {
    button.classList.remove('active-low', 'active-med', 'active-high');
  });
  el.classList.add(`active-${level === 'med' ? 'med' : level}`);
}

function startSim() {
  if (!vms.length) {
    showToast('Initialize VMs first!');
    return;
  }

  isRunning = true;
  document.getElementById('btnStart').disabled = true;
  document.getElementById('btnPause').disabled = false;
  document.getElementById('statusDot').className = 'status-dot running';
  document.getElementById('statusText').textContent = 'Running';
  log('Simulation started', 'ok');
  scheduleLoop();
}

function scheduleLoop() {
  if (!isRunning) return;

  const delay = Math.round(1000 / simSpeed);
  clearInterval(simInterval);
  simInterval = setInterval(() => {
    const maxCPU = vms[0]?.cpuCap || 8;
    const maxMem = vms[0]?.memCap || 16;

    for (let i = 0; i < Math.ceil(taskRate / 3); i++) {
      expireTasks();
      const mult = demandLevel === 'low' ? 0.2 : demandLevel === 'med' ? 0.4 : 0.65;
      const c = Math.max(1, Math.round(Math.random() * maxCPU * mult));
      const m = Math.max(1, Math.round(Math.random() * maxMem * mult));

      if (Math.random() < 0.3) freeRandomTask();
      allocateTask(c, m, getTaskDuration());
    }

    refreshAll();
  }, delay);
}

function pauseSim() {
  isRunning = false;
  clearInterval(simInterval);
  document.getElementById('btnStart').disabled = false;
  document.getElementById('btnPause').disabled = true;
  document.getElementById('statusDot').className = 'status-dot paused';
  document.getElementById('statusText').textContent = 'Paused';
  log('Simulation paused', 'warn');
}

function resetSim() {
  pauseSim();
  vms.forEach(vm => {
    vm.cpuUsed = 0;
    vm.memUsed = 0;
    vm.tasks = [];
  });
  resetCounters();
  document.getElementById('statusDot').className = 'status-dot';
  document.getElementById('statusText').textContent = 'Idle';
  timeLabels = [];
  cpuHistory = [];
  memHistory = [];
  lineChart.data.labels = [];
  lineChart.data.datasets[0].data = [];
  lineChart.data.datasets[1].data = [];
  lineChart.update('none');
  refreshAll();
  log('Simulation reset', 'warn');
}

function freeRandomTask() {
  const active = vms.filter(vm => vm.tasks.length > 0);
  if (!active.length) return;
  const vm = active[Math.floor(Math.random() * active.length)];
  const task = vm.tasks.shift();
  if (task) {
    vm.cpuUsed -= task.cpuReq;
    vm.memUsed -= task.memReq;
  }
}

function resetCounters() {
  totalAllocated = 0;
  totalFailed = 0;
}

function updateSpeed(value) {
  simSpeed = parseInt(value, 10);
  document.getElementById('speedVal').textContent = `${value}x`;
  if (isRunning) {
    clearInterval(simInterval);
    scheduleLoop();
  }
}

function updateRate(value) {
  taskRate = parseInt(value, 10);
  document.getElementById('rateVal').textContent = `${value}/s`;
}

function refreshAll() {
  renderVMGrid();
  updateBarChart();
  updateLineChart();
  updateMetrics();
}

function renderVMGrid() {
  const grid = document.getElementById('vmGrid');
  if (!vms.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><i class="fas fa-server"></i><div>No VMs initialized.<br>Configure and click <strong>Initialize VMs</strong>.</div></div>`;
    return;
  }

  grid.innerHTML = vms.map(vm => {
    const cpuPct = Math.min(100, Math.round((vm.cpuUsed / vm.cpuCap) * 100));
    const memPct = Math.min(100, Math.round((vm.memUsed / vm.memCap) * 100));
    const avgPct = (cpuPct + memPct) / 2;
    const cls = avgPct >= 75 ? 'vm-high' : avgPct >= 40 ? 'vm-med' : 'vm-low';
    const badge = avgPct >= 75
      ? '<span class="vm-badge badge-red">HIGH</span>'
      : avgPct >= 40
        ? '<span class="vm-badge badge-yellow">MED</span>'
        : '<span class="vm-badge badge-green">LOW</span>';
    const fillCls = cpuPct >= 75 ? 'fill-red' : cpuPct >= 40 ? 'fill-yellow' : 'fill-green';
    const fillMem = memPct >= 75 ? 'fill-red' : memPct >= 40 ? 'fill-yellow' : 'fill-green';

    return `<div class="vm-card ${cls}">
      <div class="vm-header">
        <div class="vm-name">${vm.name}</div>
        ${badge}
      </div>
      <div class="vm-metric">
        <div class="vm-metric-row">
          <span class="vm-metric-label"><i class="fas fa-microchip"></i> CPU</span>
          <span class="vm-metric-val">${vm.cpuUsed}/${vm.cpuCap}c · ${cpuPct}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill ${fillCls}" style="width:${cpuPct}%"></div></div>
      </div>
      <div class="vm-metric">
        <div class="vm-metric-row">
          <span class="vm-metric-label"><i class="fas fa-memory"></i> MEM</span>
          <span class="vm-metric-val">${vm.memUsed}/${vm.memCap}GB · ${memPct}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill ${fillMem}" style="width:${memPct}%"></div></div>
      </div>
      <div class="vm-tasks">
        <i class="fas fa-list-check"></i>
        ${vm.tasks.length} task${vm.tasks.length !== 1 ? 's' : ''} running
        ${vm.tasks.length > 0 ? `· next done in ${Math.max(0, Math.ceil((Math.min(...vm.tasks.map(task => task.expiresAt)) - Date.now()) / 1000))}s` : ''}
      </div>
    </div>`;
  }).join('');
}

function updateMetrics() {
  if (!vms.length) {
    document.getElementById('metricUtil').textContent = '0%';
    document.getElementById('metricVMs').textContent = '0';
    document.getElementById('metricVMsSub').textContent = 'of 0 initialized';
    document.getElementById('metricTasks').textContent = '0';
    document.getElementById('metricTasksSub').textContent = '0 failed';
    document.getElementById('metricEff').textContent = '—';
    return;
  }

  const cpuUtils = vms.map(v => (v.cpuUsed / v.cpuCap) * 100);
  const memUtils = vms.map(v => (v.memUsed / v.memCap) * 100);
  const avgUtil = ((cpuUtils.reduce((a, b) => a + b, 0) + memUtils.reduce((a, b) => a + b, 0)) / (2 * vms.length));
  const activeVMs = vms.filter(v => v.tasks.length > 0).length;
  const eff = totalAllocated + totalFailed === 0
    ? '—'
    : `${Math.round((totalAllocated / (totalAllocated + totalFailed)) * 100)}%`;

  document.getElementById('metricUtil').textContent = `${Math.round(avgUtil)}%`;
  document.getElementById('metricVMs').textContent = activeVMs;
  document.getElementById('metricVMsSub').textContent = `of ${vms.length} initialized`;
  document.getElementById('metricTasks').textContent = totalAllocated;
  document.getElementById('metricTasksSub').textContent = `${totalFailed} failed`;
  document.getElementById('metricEff').textContent = eff;
}

function buildCharts() {
  const barCtx = document.getElementById('barChart').getContext('2d');
  barChart = new Chart(barCtx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'CPU %', data: [], backgroundColor: 'rgba(59,130,246,0.75)', borderRadius: 5, borderSkipped: false },
        { label: 'Memory %', data: [], backgroundColor: 'rgba(99,102,241,0.65)', borderRadius: 5, borderSkipped: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { family: 'DM Sans', size: 11 }, boxWidth: 10, usePointStyle: true },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'DM Mono', size: 10 }, color: '#94a3b8' } },
        y: {
          min: 0,
          max: 100,
          ticks: { callback: value => `${value}%`, font: { family: 'DM Sans', size: 10 }, color: '#94a3b8' },
          grid: { color: 'rgba(148,163,184,0.1)' },
        },
      },
      animation: { duration: 300 },
    },
  });

  const lineCtx = document.getElementById('lineChart').getContext('2d');
  lineChart = new Chart(lineCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Avg CPU %', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', tension: 0.4, fill: true, pointRadius: 2, borderWidth: 2 },
        { label: 'Avg Mem %', data: [], borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)', tension: 0.4, fill: true, pointRadius: 2, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { family: 'DM Sans', size: 11 }, boxWidth: 10, usePointStyle: true },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'DM Mono', size: 10 }, color: '#94a3b8', maxTicksLimit: 8 } },
        y: {
          min: 0,
          max: 100,
          ticks: { callback: value => `${value}%`, font: { family: 'DM Sans', size: 10 }, color: '#94a3b8' },
          grid: { color: 'rgba(148,163,184,0.1)' },
        },
      },
      animation: { duration: 200 },
    },
  });
}

function updateBarChart() {
  if (!vms.length) {
    barChart.data.labels = [];
    barChart.data.datasets[0].data = [];
    barChart.data.datasets[1].data = [];
    barChart.update('none');
    return;
  }

  barChart.data.labels = vms.map(v => v.name);
  barChart.data.datasets[0].data = vms.map(v => Math.round((v.cpuUsed / v.cpuCap) * 100));
  barChart.data.datasets[1].data = vms.map(v => Math.round((v.memUsed / v.memCap) * 100));
  barChart.data.datasets[0].backgroundColor = vms.map(v => {
    const p = v.cpuUsed / v.cpuCap;
    return p >= 0.75 ? 'rgba(239,68,68,0.75)' : p >= 0.4 ? 'rgba(245,158,11,0.75)' : 'rgba(59,130,246,0.75)';
  });
  barChart.update();
}

function updateLineChart() {
  if (!vms.length) return;

  const now = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const avgCPU = vms.reduce((a, vm) => a + (vm.cpuUsed / vm.cpuCap) * 100, 0) / vms.length;
  const avgMem = vms.reduce((a, vm) => a + (vm.memUsed / vm.memCap) * 100, 0) / vms.length;

  timeLabels.push(now);
  cpuHistory.push(Math.round(avgCPU));
  memHistory.push(Math.round(avgMem));

  if (timeLabels.length > MAX_HISTORY) {
    timeLabels.shift();
    cpuHistory.shift();
    memHistory.shift();
  }

  lineChart.data.labels = [...timeLabels];
  lineChart.data.datasets[0].data = [...cpuHistory];
  lineChart.data.datasets[1].data = [...memHistory];
  lineChart.update();
}

function log(message, type = '') {
  const el = document.getElementById('taskLog');
  const entry = document.createElement('div');
  entry.className = `log-entry${type ? ' log-' + type : ''}`;
  const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = `[${ts}] ${message}`;
  el.prepend(entry);
  if (el.children.length > 50) el.lastChild.remove();
}

function clearLog() {
  document.getElementById('taskLog').innerHTML = '<div class="log-entry">Log cleared</div>';
}

let toastTimer;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function updateAlgoDisplay() {
  const map = { 'round-robin': 'Round Robin', 'first-fit': 'First Fit', 'best-fit': 'Best Fit' };
  document.getElementById('algoDisplay').textContent = map[document.getElementById('algoSel').value];
}

function toggleDark() {
  darkMode = !darkMode;
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : '');
  document.getElementById('darkIcon').className = darkMode ? 'fas fa-sun' : 'fas fa-moon';

  const gridColor = darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(148,163,184,0.1)';
  const tickColor = darkMode ? '#475569' : '#94a3b8';

  [barChart, lineChart].forEach(chart => {
    chart.options.scales.x.ticks.color = tickColor;
    chart.options.scales.y.ticks.color = tickColor;
    chart.options.scales.y.grid.color = gridColor;
    chart.update('none');
  });
}

window.addEventListener('DOMContentLoaded', () => {
  buildCharts();
  initVMs();
  setTimeout(() => {
    autoGenWorkload();
    refreshAll();
  }, 200);
});