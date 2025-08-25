// ——— Config
const SENSOR_ID = "soil-1";
const POLL_MS = 3000;
const RAW_MAX = 4095;
const MAX_POINTS = 180; // ~9 Minuten Historie

// ——— State
let latest=null, config=null, history=[];
let step=1;

// ——— DOM
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

// ——— Helpers
function clamp(n,a,b){ return Math.max(a,Math.min(b,n)); }
function bump(el){ el.classList.add("bump"); setTimeout(()=>el.classList.remove("bump"),200); }
function calcPercent(raw){
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet) {
    return clamp((raw/RAW_MAX)*100, 0, 100);
  }
  const p = 100*(raw - config.rawDry)/(config.rawWet - config.rawDry);
  return clamp(p, 0, 100);
}

// ——— UI
function setBarAndValue(raw, atISO){
  const p = calcPercent(raw);
  els.fill.style.width = p.toFixed(1) + "%";
  els.value.textContent = Math.round(p) + "%";
  els.raw.textContent = raw;
  els.ts.textContent = new Date(atISO).toLocaleString();
  bump(els.value);
}

// ——— Chart: nur Punkte, Fade nach links, ohne Grid/Achsen (bis auf dezente Y-Linie + DRY/WET)
let chart;
function initChart(){
  const ctx = els.chart.getContext("2d");

  // Custom plugin für dünne Y-Achse + DRY/WET Labels
  const minimalistAxis = {
    id: "minimalistAxis",
    afterDraw(c) {
      const { ctx, chartArea:{top,bottom,left,right}, scales:{y} } = c;
      ctx.save();
      // dünne Y-Linie
      ctx.strokeStyle = "#1b1b1c";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left+8, top);
      ctx.lineTo(left+8, bottom);
      ctx.stroke();
      // DRY / WET Labels
      ctx.fillStyle = "#9a9a9b";
      ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("WET", left+12, y.getPixelForValue(100));
      ctx.fillText("DRY", left+12, y.getPixelForValue(0));
      ctx.restore();
    }
  };

  chart = new Chart(ctx, {
    type: "scatter",
    data: { datasets: [{
      data: [], // {x, y}
      showLine: false,
      pointRadius: 4,
      pointHoverRadius: 5,
      pointBorderWidth: 0,
      pointBackgroundColor: (c) => {
        const i = c.dataIndex, total = c.dataset.data.length || 1;
        const fade = 1 - (i/total)*0.85; // nach links verblassen
        return `rgba(242,242,243,${fade.toFixed(3)})`;
      }
    }]},
    options: {
      animations: {
        numbers: { duration: 500, easing: "easeOutCubic" },
      },
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { display:false, min: 0, max: MAX_POINTS-1 },
        y: { display:false, min: 0, max: 100 }
      },
      plugins: { legend:{display:false}, tooltip:{enabled:false} },
      layout: { padding: { top: 8, right: 8, bottom: 8, left: 28 } }
    },
    plugins: [minimalistAxis]
  });
}

function updateChart(){
  if (!chart) return;
  const series = history.map((h, idx) => ({
    x: idx,
    y: (h.percent!=null ? h.percent : (h.raw/RAW_MAX*100))
  }));
  chart.data.datasets[0].data = series.slice(-MAX_POINTS);
  chart.update();
}

// ——— Data
async function fetchSoil(){
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&limit=${MAX_POINTS}`, { cache:"no-store" });
  if (r.status === 204) return;
  const data = await r.json();
  latest = data.latest; config = data.config || null; history = data.history || [];
  setBarAndValue(latest.raw, latest.at);
  updateChart();
}

// ——— Poll
initChart();
fetchSoil();
setInterval(fetchSoil, POLL_MS);

// ——— Calibration (2 Schritte)
function showStep(n){
  step = n;
  document.querySelectorAll(".modal .step").forEach(sec => {
    sec.hidden = Number(sec.dataset.step) !== n;
  });
  document.querySelectorAll(".steps-dots .dot").forEach(dot => {
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
  const dry = Number(els.dryInput.value);
  const wet = Number(els.wetInput.value);
  if (!Number.isFinite(dry) || !Number.isFinite(wet)) {
    alert("Bitte DRY und WET als Zahlen eingeben/übernehmen.");
    return;
  }
  const resp = await fetch("/api/calibrate", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ sensorId: SENSOR_ID, rawDry: dry, rawWet: wet })
  });
  if (resp.ok) { els.modal.close(); await fetchSoil(); }
  else { alert("Kalibrierung fehlgeschlagen."); }
};

els.resetCalib.onclick = async () => {
  if (!confirm("Kalibrierung wirklich zurücksetzen?")) return;
  await fetch("/api/calibrate", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ sensorId: SENSOR_ID, reset: true })
  });
  await fetchSoil();
};
