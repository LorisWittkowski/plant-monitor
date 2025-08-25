// ---- Config ----
const POLL_MS = 3000;
const RAW_MAX = 4095;
const MAX_POINTS = 120;           // sichtbare Punkte
const SENSOR_ID = "soil-1";       // UI zeigt es nicht; nur intern

// ---- State ----
let latest = null, config = null;
let percentSeries = [];           // nur Prozentwerte (0..100)
let lastSeenAt = null;
let step = 1;

// ---- DOM ----
const $ = s => document.querySelector(s);
const els = {
  value: $("#value"), raw: $("#raw"), ts: $("#ts"), fill: $("#fill"),
  chart: $("#chart"), calibBtn: $("#calibBtn"),
  modal: $("#calibModal"), dryInput: $("#dryInput"), wetInput: $("#wetInput"),
  useDryNow: $("#useDryNow"), useWetNow: $("#useWetNow"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"), saveCalib: $("#saveCalib"),
  resetCalib: $("#resetCalib"), themeToggle: $("#themeToggle"), themeIcon: $("#themeIcon")
};

// ---- Theme Toggle (pref + localStorage) ----
(function initTheme(){
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  els.themeIcon.textContent = theme === "dark" ? "☾" : "☼";
})();
els.themeToggle.onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  els.themeIcon.textContent = next === "dark" ? "☾" : "☼";
};

// ---- Helpers ----
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const bump = el => { el.classList.add("bump"); setTimeout(()=>el.classList.remove("bump"),200); };
const asPercent = (raw)=>{
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet) {
    return clamp((raw/RAW_MAX)*100, 0, 100);
  }
  const p = 100*(raw - config.rawDry)/(config.rawWet - config.rawDry);
  return clamp(p, 0, 100);
};

// ---- Live UI ----
function updateLive(raw, atIso){
  const p = asPercent(raw);
  els.fill.style.width = p.toFixed(1) + "%";
  els.value.textContent = Math.round(p) + "%";
  els.raw.textContent = raw;
  els.ts.textContent = new Date(atIso).toLocaleString();
  bump(els.value);
}

// ---- Chart (wandernde Punkte, links verblassen) ----
let chart;
function initChart(){
  const ctx = els.chart.getContext("2d");
  chart = new Chart(ctx, {
    type: "scatter",
    data: { datasets: [{
      data: [], showLine: false, borderWidth: 0,
      pointRadius: 4, pointHoverRadius: 5,
      pointBackgroundColor: ctx => {
        const i = ctx.dataIndex;
        const total = ctx.dataset.data.length || 1;
        const fade = 1 - (i/total)*0.85;        // nach links verblassen
        return `rgba(242,242,243,${fade})`;     // passt sich im Light-Theme via canvas overlay nicht auto an
      }
    }]},
    options: {
      animation: { duration: 600, easing: "easeOutCubic" },
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { display: false, min: 0, max: MAX_POINTS-1 },
        y: {
          min: 0, max: 100,
          grid: { display: false },
          ticks: {
            display: true,
            color: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || "#9a9a9b",
            callback: (val) => (val===0 ? "DRY" : (val===100 ? "WET" : "")),
            maxTicksLimit: 2
          },
          border: {
            display: true,
            color: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || "#9a9a9b",
            width: 1
          }
        }
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      layout: { padding: 6 }
    }
  });
}
function applySeriesToChart(series){
  const data = series.map((y,i)=>({x:i, y}));
  chart.data.datasets[0].data = data;
  chart.update();
}
// „Wandernde Punkte“: bei neuem Wert nehmen alle Punkte den Y-Wert ihres rechten Nachbarn an.
// Finalzustand entspricht normalem Shift, erzeugt aber eine vertikale Bewegung.
function shiftAnimateWith(newPercent){
  const old = percentSeries.slice();
  if (old.length === 0) {
    percentSeries = [newPercent];
  } else {
    const shifted = old.map((_,i) => (i < old.length-1 ? old[i+1] : newPercent));
    percentSeries = shifted;
  }
  if (percentSeries.length > MAX_POINTS) percentSeries = percentSeries.slice(-MAX_POINTS);
  applySeriesToChart(percentSeries);
}

// ---- Fetch & Poll ----
async function fetchSoil(){
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&limit=${MAX_POINTS}`, { cache: "no-store" });
  if (r.status === 204) return;
  const data = await r.json();
  latest = data.latest; config = data.config || null;
  const at = latest.at;
  // Initial history → setze Serie einmalig
  if (!lastSeenAt && Array.isArray(data.history)) {
    const hist = data.history;
    percentSeries = hist.map(h => (h.percent!=null ? h.percent : clamp((h.raw/RAW_MAX)*100,0,100)));
    if (percentSeries.length > MAX_POINTS) percentSeries = percentSeries.slice(-MAX_POINTS);
    initChart(); applySeriesToChart(percentSeries);
  }

  // neuer Wert?
  if (lastSeenAt !== at) {
    lastSeenAt = at;
    const p = asPercent(latest.raw);
    shiftAnimateWith(p);
    updateLive(latest.raw, latest.at);
  }
}

initChart();  // Chart existiert sofort
fetchSoil();
setInterval(fetchSoil, POLL_MS);

// ---- Calibration (2 Schritte, nur DRY/WET) ----
function showStep(n){
  step = n;
  document.querySelectorAll(".modal .step").forEach(sec => {
    sec.hidden = Number(sec.dataset.step) !== n;
  });
  document.querySelectorAll(".steps-dots .dot").forEach(dot=>{
    dot.classList.toggle("active", Number(dot.dataset.step) === n);
  });
  els.prevStep.style.visibility = (n===1) ? "hidden" : "visible";
  els.nextStep.hidden = (n===2);
  els.saveCalib.hidden = (n!==2);
}

els.calibBtn.onclick = () => { els.modal.showModal(); showStep(1); };
els.prevStep.onclick = () => showStep(1);
els.nextStep.onclick = () => showStep(2);

els.useDryNow.onclick = () => { if (latest) els.dryInput.value = latest.raw; };
els.useWetNow.onclick = () => { if (latest) els.wetInput.value = latest.raw; };

els.saveCalib.onclick = async () => {
  const rawDry = Number(els.dryInput.value);
  const rawWet = Number(els.wetInput.value);
  if (!Number.isFinite(rawDry) || !Number.isFinite(rawWet)) {
    alert("Bitte RAW trocken & RAW nass eingeben oder übernehmen.");
    return;
  }
  const resp = await fetch("/api/calibrate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sensorId: SENSOR_ID, rawDry, rawWet })
  });
  if (resp.ok) {
    els.modal.close();
    // re-fetch Config & Latest
    lastSeenAt = null; // force full apply
    await fetchSoil();
  } else {
    alert("Kalibrierung fehlgeschlagen.");
  }
};

els.resetCalib.onclick = async () => {
  if (!confirm("Kalibrierung zurücksetzen?")) return;
  await fetch("/api/calibrate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sensorId: SENSOR_ID, reset: true })
  });
  lastSeenAt = null; await fetchSoil();
};
