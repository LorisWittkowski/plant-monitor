// Config
const SENSOR_ID = "soil-1";
const POLL_MS = 3000;
const RAW_MAX = 4095;
const MAX_POINTS = 180; // ~9 Min

// State
let latest = null, config = null, history = [];
let step = 1;

// DOM helpers
const $ = s => document.querySelector(s);
const els = {
  value: $("#value"), raw: $("#raw"), ts: $("#ts"), fill: $("#fill"),
  chart: $("#chart"), sensorId: $("#sensorId"),
  calibBtn: $("#calibBtn"), modal: $("#calibModal"),
  dryInput: $("#dryInput"), wetInput: $("#wetInput"),
  useDryNow: $("#useDryNow"), useWetNow: $("#useWetNow"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"),
  saveCalib: $("#saveCalib"), resetCalib: $("#resetCalib")
};

// Percent from calibration (fallback: raw%)
function calcPercent(raw){
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry === config.rawWet) {
    return Math.max(0, Math.min(100, (raw / RAW_MAX) * 100));
  }
  const p = 100 * (raw - config.rawDry) / (config.rawWet - config.rawDry);
  return Math.max(0, Math.min(100, p));
}

// Micro interaction
function bump(el){ el.classList.add("bump"); setTimeout(()=>el.classList.remove("bump"),200); }

// UI set
function setBarAndValue(raw, at){
  const p = calcPercent(raw);
  els.fill.style.width = p.toFixed(1) + "%";
  els.value.textContent = Math.round(p) + "%";
  els.raw.textContent = raw;
  els.ts.textContent = new Date(at).toLocaleString();
  bump(els.value);
}

// Chart (minimalist: no axes/grid/legend)
let chart;
function initChart(){
  const ctx = els.chart.getContext("2d");
  const gradient = (ctx, area) => {
    const g = ctx.createLinearGradient(0, area.bottom, 0, area.top);
    g.addColorStop(0, "rgba(122,162,255,0.00)");
    g.addColorStop(1, "rgba(122,162,255,0.18)");
    return g;
  };
  chart = new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [{
      data: [],
      borderWidth: 2,
      borderColor: "rgba(122,162,255,0.95)",
      fill: { target: "origin" },
      backgroundColor: (c) => gradient(c.chart.ctx, c.chart.chartArea),
      cubicInterpolationMode: "monotone",
      pointRadius: 0
    }]},
    options: {
      animation: { duration: 500 },
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { display:false }, y: { display:false, min:0, max:100 } },
      plugins: { legend: { display:false }, tooltip: { enabled:true, intersect:false, mode:"index" } },
      layout: { padding: 8 }
    }
  });
}
function updateChart(){
  if (!chart) return;
  const series = history.map(h => (h.percent!=null ? h.percent : (h.raw/RAW_MAX*100)));
  const labels = history.map(h => new Date(h.at).toLocaleTimeString());
  chart.data.labels = labels.slice(-MAX_POINTS);
  chart.data.datasets[0].data = series.slice(-MAX_POINTS);
  chart.update();
}

// Fetch
async function fetchSoil(){
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&limit=${MAX_POINTS}`, { cache:"no-store" });
  if (r.status === 204) return;
  const data = await r.json();
  latest = data.latest; config = data.config || null; history = data.history || [];
  setBarAndValue(latest.raw, latest.at);
  updateChart();
}

// Poll
initChart();
fetchSoil();
setInterval(fetchSoil, POLL_MS);

// ===== Calibration =====
function showStep(n){
  step = n;
  // steps
  document.querySelectorAll(".modal .step").forEach(sec => {
    sec.hidden = Number(sec.dataset.step) !== n;
  });
  // dots
  document.querySelectorAll(".steps-dots .dot").forEach(dot=>{
    dot.classList.toggle("active", Number(dot.dataset.step) === n);
  });
  // footer buttons
  els.prevStep.style.visibility = (n===1) ? "hidden" : "visible";
  els.nextStep.hidden = (n===2);
  els.saveCalib.hidden = (n!==2);
}

els.calibBtn.onclick = () => {
  els.modal.showModal();
  showStep(1);
};
els.prevStep.onclick = () => showStep(1);
els.nextStep.onclick = () => showStep(2);

els.useDryNow.onclick = () => { if (latest) els.dryInput.value = latest.raw; };
els.useWetNow.onclick = () => { if (latest) els.wetInput.value = latest.raw; };

els.saveCalib.onclick = async () => {
  const rawDry = Number(els.dryInput.value);
  const rawWet = Number(els.wetInput.value);
  if (!Number.isFinite(rawDry) || !Number.isFinite(rawWet)) {
    alert("Bitte beide RAW-Werte eingeben oder übernehmen.");
    return;
  }
  const body = { sensorId: SENSOR_ID, rawDry, rawWet };
  const resp = await fetch("/api/calibrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (resp.ok) {
    els.modal.close();
    await fetchSoil();
  } else {
    alert("Kalibrierung fehlgeschlagen.");
  }
};

els.resetCalib.onclick = async () => {
  if (!confirm("Kalibrierung zurücksetzen?")) return;
  await fetch("/api/calibrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sensorId: SENSOR_ID, reset: true })
  });
  await fetchSoil();
};
