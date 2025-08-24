// Config
const SENSOR_ID = "soil-1";
const POLL_MS = 3000;
const MAX_POINTS = 120; // ~6 Min bei 3s Takt

// State
let token = localStorage.getItem("ingestToken") || "";
let latest = null;
let config = null;
let history = [];

// DOM
const $ = s => document.querySelector(s);
const els = {
  value: $("#value"),
  raw: $("#raw"),
  ts: $("#ts"),
  fill: $("#fill"),
  sensorId: $("#sensorId"),
  sensorName: $("#sensorName"),
  chart: $("#chart"),
  calibBtn: $("#calibBtn"),
  modal: $("#calibModal"),
  dryInput: $("#dryInput"),
  wetInput: $("#wetInput"),
  nameInput: $("#nameInput"),
  tokenInput: $("#tokenInput"),
  rememberToken: $("#rememberToken"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"), saveCalib: $("#saveCalib"),
  resetCalib: $("#resetCalib")
};

// helpers
function clamp(n,a,b){ return Math.max(a,Math.min(b,n)); }
function fmtTS(s){ try{ return new Date(s).toLocaleString(); }catch{ return "—"; } }
function bump(el){ el.classList.add("bump"); setTimeout(()=>el.classList.remove("bump"),220); }

// percent based on config if available
function calcPercent(raw){
  if (!config || config.rawDry == null || config.rawWet == null || config.rawDry === config.rawWet) return null;
  const p = 100 * (raw - config.rawDry) / (config.rawWet - config.rawDry);
  return clamp(p, 0, 100);
}

// UI updates
function setBar(raw){
  const p = calcPercent(raw);
  const percent = p == null ? (raw / 4095) * 100 : p;
  els.fill.style.width = clamp(percent,0,100).toFixed(1) + "%";
  els.value.textContent = (p == null ? Math.round(percent) : Math.round(p)) + "%";
  bump(els.value);
}
function setMeta(raw, at){
  els.raw.textContent = raw ?? "—";
  els.ts.textContent  = at ? fmtTS(at) : "—";
}

// Chart setup
let chart;
function makeChart() {
  const ctx = els.chart.getContext("2d");
  chart = new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [{
      label: "Bodenfeuchte (%)",
      data: [],
      borderWidth: 2,
      tension: 0.25,
      pointRadius: 0,
    } ]},
    options: {
      responsive: true,
      animation: { duration: 500 },
      scales: {
        x: { ticks: { color: "#93a1b3" }, grid: { color: "rgba(146,162,179,.1)" } },
        y: { min: 0, max: 100, ticks: { color: "#93a1b3" }, grid: { color: "rgba(146,162,179,.1)" } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.parsed.y.toFixed(0)}%`
          }
        }
      }
    }
  });
}
function updateChart() {
  if (!chart) return;
  // map history to percent
  const series = history.map(h => {
    const p = h.percent != null ? h.percent : (h.raw / 4095 * 100);
    return clamp(p, 0, 100);
  });
  const labels = history.map(h => new Date(h.at).toLocaleTimeString());
  chart.data.labels = labels.slice(-MAX_POINTS);
  chart.data.datasets[0].data = series.slice(-MAX_POINTS);
  chart.update();
}

// fetch data
async function fetchSoil() {
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&limit=${MAX_POINTS}`, { cache: "no-store" });
  if (r.status === 204) return;
  const data = await r.json();
  latest = data.latest; config = data.config; history = data.history || [];

  if (config?.name) els.sensorName.textContent = `· ${config.name}`;
  setBar(latest.raw);
  setMeta(latest.raw, latest.at);
  updateChart();
}

// poll
makeChart();
fetchSoil();
setInterval(fetchSoil, POLL_MS);

// ==== Calibration Wizard ====
let step = 1;
function showStep(n){
  step = n;
  document.querySelectorAll(".step").forEach(li => {
    li.classList.toggle("active", Number(li.dataset.step) === n);
  });
  els.prevStep.style.display = (n>1) ? "inline-block" : "none";
  els.nextStep.style.display = (n<3) ? "inline-block" : "none";
  els.saveCalib.style.display = (n===3) ? "inline-block" : "none";
}

// open modal
els.calibBtn.onclick = () => {
  els.modal.showModal();
  showStep(1);
  // prefill current values if exist
  if (latest) {
    // nichts automatisch einsetzen, erst via Button
  }
  if (config) {
    els.dryInput.value = config.rawDry ?? "";
    els.wetInput.value = config.rawWet ?? "";
    els.nameInput.value = config.name ?? "";
  }
  els.tokenInput.value = token;
};
// close via backdrop Esc handled by dialog

// step nav
els.prevStep.onclick = () => showStep(Math.max(1, step-1));
els.nextStep.onclick = () => showStep(Math.min(3, step+1));

$("#useDryNow").onclick = () => { if (latest) els.dryInput.value = latest.raw; };
$("#useWetNow").onclick = () => { if (latest) els.wetInput.value = latest.raw; };

els.rememberToken.onclick = () => {
  token = els.tokenInput.value || "";
  if (token) localStorage.setItem("ingestToken", token);
};

// save calib
els.saveCalib.onclick = async () => {
  const body = {
    sensorId: SENSOR_ID,
    rawDry: num(els.dryInput.value),
    rawWet: num(els.wetInput.value),
    name: els.nameInput.value || null,
    token
  };
  const r = await fetch("/api/calibrate", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
  if (r.ok) {
    els.modal.close();
    await fetchSoil();
  } else {
    alert("Kalibrierung fehlgeschlagen (Token/Netz prüfen).");
  }
};

// reset calib
els.resetCalib.onclick = async () => {
  const ok = confirm("Kalibrierung zurücksetzen?");
  if (!ok) return;
  const r = await fetch("/api/calibrate", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ sensorId: SENSOR_ID, reset: true, token })
  });
  if (r.ok) {
    els.dryInput.value = ""; els.wetInput.value = "";
    await fetchSoil();
  }
};

function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
