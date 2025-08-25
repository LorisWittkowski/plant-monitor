// ===== Config =====
const POLL_MS = 3000;
const RAW_MAX = 4095;
const SENSOR_ID = "soil-1";
const DEFAULT_RANGE = "1h"; // 1h | 24h | 7d

// ===== State =====
let latest = null, config = null, lastSeenAt = null, currentDisplayedPercent = null;
let currentRange = DEFAULT_RANGE;
let plantProfile = null;

// ===== DOM =====
const $ = s => document.querySelector(s);
const els = {
  value: $("#value"), raw: $("#raw"), ts: $("#ts"), fill: $("#fill"),
  chart: $("#chart"),
  themeToggle: $("#themeToggle"), themeIcon: $("#themeIcon"),
  calibBtn: $("#calibBtn"), modal: $("#calibModal"),
  dryInput: $("#dryInput"), wetInput: $("#wetInput"),
  useDryNow: $("#useDryNow"), useWetNow: $("#useWetNow"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"), saveCalib: $("#saveCalib"), resetCalib: $("#resetCalib"),
  pi_name: $("#pi_name"), pi_species: $("#pi_species"), pi_location: $("#pi_location"), pi_pot: $("#pi_pot"), pi_note: $("#pi_note"),
  saveInfo: $("#saveInfo")
};

// ===== Theme =====
(function initTheme(){
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
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
  if (chart) chart.update(); // Linie zieht neue CSS-Farben
};

// ===== Helpers =====
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const asPercent = raw => {
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet)
    return clamp((raw/RAW_MAX)*100,0,100);
  return clamp(100*(raw - config.rawDry)/(config.rawWet - config.rawDry),0,100);
};
const tweenValue = (from,to,ms=450) => {
  const start = performance.now();
  const step = t => {
    const k = Math.min(1,(t-start)/ms);
    const v = Math.round(from + (to-from)*k);
    els.value.textContent = v + "%";
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

// ===== Live UI =====
function updateLive(raw, atIso){
  const p = asPercent(raw);
  els.fill.style.width = p.toFixed(1) + "%";
  if (currentDisplayedPercent == null) els.value.textContent = Math.round(p) + "%";
  else if (Math.abs(currentDisplayedPercent - p) >= 1) tweenValue(Math.round(currentDisplayedPercent), Math.round(p));
  else els.value.textContent = Math.round(p) + "%";
  currentDisplayedPercent = p;
  els.raw.textContent = raw;
  els.ts.textContent = new Date(atIso).toLocaleString();
}

// ===== Chart (minimal, keine Hover, mit Decimation) =====
let chart;
const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function initChart() {
  const ctx = els.chart.getContext("2d");
  chart = new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [{
      data: [],
      borderWidth: 2,
      tension: 0.35,
      fill: false,
      pointRadius: 0,
      segment: {
        borderColor: (c) => {
          const ds = c.chart.data.datasets[0];
          const total = ds.data.length || 1;
          const i = c.p0DataIndex ?? 0;
          const alpha = 0.25 + 0.75 * (i / total); // links transparenter → rechts deckender
          const fg = cssVar('--fg-strong', '#000');
          if (fg.startsWith('rgb(')) return fg.replace('rgb','rgba').replace(')',`,`+alpha+`)`);
          return `rgba(242,242,243,${alpha})`;
        }
      }
    }]},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 450, easing: "easeOutCubic" },
      // keine Interaktion / Hover
      events: [],
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        decimation: { enabled: true, algorithm: 'lttb', samples: 120 }
      },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 100,
          grid: { display: false },
          ticks: { display: false },
          border: { display: true, color: cssVar('--muted', '#9a9a9b') }
        }
      },
      layout: { padding: 6 }
    }
  });
}

// Serie setzen: streng zeitlich sortieren, cap (gegen „Abpfeifen“ & Überlänge)
function setSeries(points) {
  const norm = (points || [])
    .map(p => ({
      t: new Date(p.at || p.time || Date.now()).getTime(),
      y: (p.percent != null ? p.percent : (p.raw / RAW_MAX * 100))
    }))
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.y))
    .sort((a, b) => a.t - b.t);

  const HARD_CAP = 1000;                    // obere sichtbare Grenze
  const data = (norm.length > HARD_CAP) ? norm.slice(-HARD_CAP) : norm;

  chart.data.labels = data.map(d => d.t);
  chart.data.datasets[0].data = data.map(d => d.y);
  chart.update();
}

// Range vom Server holen (Server liefert bereits passende Dichte)
async function fetchSeries(range) {
  document.querySelectorAll('.range .btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=${encodeURIComponent(range)}`, { cache: "no-store" });
  if (r.status === 204) { setSeries([]); return; }
  const data = await r.json();

  if (data.config) config = data.config;
  if (data.latest) {
    latest = data.latest;
    updateLive(latest.raw, latest.at);
  }
  setSeries(data.series || []);
}

// separat: Live-Poll für Kopf & Graph-Refresh (leicht, nicht flooden)
async function pollLatest(){
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=latest`, { cache:"no-store" });
  if (r.status!==200) return;
  const data = await r.json();
  if (!data.latest) return;
  const nowAt = data.latest.at;
  if (nowAt && nowAt !== lastSeenAt) {
    lastSeenAt = nowAt;
    config = data.config || config;
    latest  = data.latest;
    updateLive(latest.raw, latest.at);
    // Graph nachladen (Server-seitig bereits verdichtet)
    await fetchSeries(currentRange);
  }
}

// ===== Plant Info =====
function fillInfoUI(){
  const p = plantProfile || {};
  els.pi_name.value = p.name || "";
  els.pi_species.value = p.species || "";
  els.pi_location.value = p.location || "";
  els.pi_pot.value = p.potCm ?? "";
  els.pi_note.value = p.note || "";
}
async function fetchPlant(){
  const r = await fetch(`/api/plant?sensorId=${encodeURIComponent(SENSOR_ID)}`, { cache:"no-store" });
  if (r.status===204){ plantProfile=null; fillInfoUI(); return; }
  const data = await r.json();
  plantProfile = data.profile || null;
  fillInfoUI();
}
async function savePlantProfile(){
  const body = {
    sensorId: SENSOR_ID,
    profile: {
      name: els.pi_name.value.trim() || null,
      species: els.pi_species.value.trim() || null,
      location: els.pi_location.value.trim() || null,
      potCm: els.pi_pot.value ? Number(els.pi_pot.value) : null,
      note: els.pi_note.value.trim() || null
    }
  };
  const r = await fetch("/api/plant", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (!r.ok) alert("Speichern fehlgeschlagen.");
}

// ===== Calibration =====
function showStep(n){
  document.querySelectorAll(".modal .step").forEach(sec => sec.hidden = Number(sec.dataset.step)!==n);
  document.querySelectorAll(".steps-dots .dot").forEach(dot=>dot.classList.toggle("active", Number(dot.dataset.step)===n));
  els.prevStep.style.visibility = (n===1)?"hidden":"visible";
  els.nextStep.hidden = (n===2);
  els.saveCalib.hidden = (n!==2);
}
els.calibBtn.onclick = () => { els.modal.showModal(); showStep(1); };
els.prevStep.onclick = () => showStep(1);
els.nextStep.onclick = () => showStep(2);
els.useDryNow.onclick = () => { if(latest) els.dryInput.value = latest.raw; };
els.useWetNow.onclick = () => { if(latest) els.wetInput.value = latest.raw; };
els.saveCalib.onclick = async ()=>{
  const rawDry=Number(els.dryInput.value), rawWet=Number(els.wetInput.value);
  if(!Number.isFinite(rawDry)||!Number.isFinite(rawWet)){alert("Bitte DRY und WET RAW eingeben.");return;}
  const resp=await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,rawDry,rawWet})});
  if(resp.ok){els.modal.close(); await fetchSeries(currentRange);} else alert("Kalibrierung fehlgeschlagen.");
};
els.resetCalib.onclick = async()=>{
  if(!confirm("Kalibrierung zurücksetzen?"))return;
  await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,reset:true})});
  await fetchSeries(currentRange);
};

// ===== Events =====
document.querySelectorAll('.range .btn').forEach(b=>{
  b.onclick = async ()=>{ currentRange = b.dataset.range; await fetchSeries(currentRange); };
});
els.saveInfo.onclick = savePlantProfile;

// ===== Init =====
initChart();
fetchSeries(currentRange);
setInterval(pollLatest, POLL_MS);
fetchPlant();
