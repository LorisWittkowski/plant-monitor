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
  themeToggle: $("#themeToggle"),
  rangeButtons: () => document.querySelectorAll(".range .btn"),
  calibBtn: $("#calibBtn"), modal: $("#calibModal"),
  dryInput: $("#dryInput"), wetInput: $("#wetInput"),
  useDryNow: $("#useDryNow"), useWetNow: $("#useWetNow"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"), saveCalib: $("#saveCalib"), resetCalib: $("#resetCalib"),
  // Plant Info
  pi_name: $("#pi_name"), pi_species: $("#pi_species"), pi_location: $("#pi_location"), pi_pot: $("#pi_pot"), pi_note: $("#pi_note"),
  saveInfo: $("#saveInfo")
};

// ===== Theme =====
(function initTheme(){
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();
els.themeToggle.onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  if (chart) chart.update();
};

// ===== Helpers =====
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const asPercent = raw => {
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet)
    return clamp((raw/RAW_MAX)*100,0,100);
  return clamp(100*(raw - config.rawDry)/(config.rawWet - config.rawDry),0,100);
};

// ===== Live UI =====
function updateLive(raw, atIso){
  const p = asPercent(raw);
  els.fill.style.width = p.toFixed(1) + "%";
  const show = Math.round(p);
  if (currentDisplayedPercent == null || Math.abs(currentDisplayedPercent - p) >= 1) {
    $("#value").textContent = show + "%";
  }
  currentDisplayedPercent = p;
  els.raw.textContent = raw;
  els.ts.textContent = new Date(atIso).toLocaleString();
}

// ===== Chart =====
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
      borderColor: () => cssVar('--fg-strong', '#222')
    }]},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400, easing: "easeOutCubic" },
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

function setSeries(points) {
  const norm = (points || [])
    .map(p => ({ t: new Date(p.at || p.time || Date.now()).getTime(),
                 y: (p.percent != null ? p.percent : (p.raw / RAW_MAX * 100)) }))
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.y))
    .sort((a,b)=>a.t-b.t);

  if (norm.length === 0 && latest) {
    const t = new Date(latest.at).getTime();
    const y = (latest.percent != null) ? latest.percent : (latest.raw / RAW_MAX * 100);
    norm.push({ t, y });
  }

  const HARD_CAP = 1000;
  const data = (norm.length > HARD_CAP) ? norm.slice(-HARD_CAP) : norm;

  chart.data.labels = data.map(d => d.t);
  chart.data.datasets[0].data = data.map(d => d.y);
  chart.data.datasets[0].pointRadius = (data.length < 2) ? 3 : 0;
  chart.options.plugins.decimation.enabled = (data.length >= 200);
  chart.update();
}

async function fetchSeries(range) {
  document.querySelectorAll('.range .btn').forEach(b=>{
    const active = b.dataset.range === range;
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  try {
    const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=${encodeURIComponent(range)}`, { cache: "no-store" });
    if (r.status === 204) { setSeries([]); return; }
    const data = await r.json();
    if (data.config) config = data.config;
    if (data.latest) { latest = data.latest; updateLive(latest.raw, latest.at); }
    setSeries(data.series || []);
  } catch { setSeries([]); }
}

async function pollLatest(){
  try {
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
      fetchSeries(currentRange);
    }
  } catch {}
}

// ===== Plant Info: laden, speichern, leeren =====
function fillInfoUI(){
  const p = plantProfile || {};
  els.pi_name.value     = p.name     ?? "";
  els.pi_species.value  = p.species  ?? "";
  els.pi_location.value = p.location ?? "";
  els.pi_pot.value      = (p.potCm != null ? String(p.potCm) : "");
  els.pi_note.value     = p.note     ?? "";
}

async function fetchPlant(){
  try {
    const r = await fetch(`/api/plant?sensorId=${encodeURIComponent(SENSOR_ID)}`, { cache:"no-store" });
    if (r.status === 204) { plantProfile = null; fillInfoUI(); return; }
    const data = await r.json();
    plantProfile = data.profile || null;
    fillInfoUI();
  } catch { /* ignore */ }
}

function normalizeEmptyToNull(v) {
  if (v == null) return null;
  const t = (typeof v === "string") ? v.trim() : v;
  if (t === "" || t === undefined) return null;
  return t;
}

async function savePlantProfile(){
  // Leere Eingaben -> null (löschen auf Server)
  const body = {
    sensorId: SENSOR_ID,
    profile: {
      name:     normalizeEmptyToNull(els.pi_name.value),
      species:  normalizeEmptyToNull(els.pi_species.value),
      location: normalizeEmptyToNull(els.pi_location.value),
      potCm:    normalizeEmptyToNull(els.pi_pot.value ? Number(els.pi_pot.value) : null),
      note:     normalizeEmptyToNull(els.pi_note.value)
    }
  };

  // Wenn alles null ist, schicken wir es trotzdem – Server löscht dann den gesamten Key
  els.saveInfo.disabled = true;
  const oldLabel = els.saveInfo.textContent;
  els.saveInfo.textContent = "Speichere…";
  try {
    const r = await fetch("/api/plant", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error("save failed");
    els.saveInfo.textContent = "Gespeichert ✓";
    await fetchPlant(); // UI mit Serverzustand abgleichen
  } catch(e) {
    alert("Speichern fehlgeschlagen.");
    els.saveInfo.textContent = oldLabel;
  } finally {
    setTimeout(()=>{ els.saveInfo.textContent = "Speichern"; els.saveInfo.disabled = false; }, 900);
  }
}

// ===== Calibration (unverändert) =====
function showStep(n){
  document.querySelectorAll(".modal .step").forEach(sec => sec.hidden = Number(sec.dataset.step)!==n);
  document.querySelectorAll(".steps-dots .dot").forEach(dot=>dot.classList.toggle("active", Number(dot.dataset.step)===n));
  els.prevStep.style.visibility = (n===1)?"hidden":"visible";
  els.nextStep.hidden = (n===2);
  els.saveCalib.hidden = (n!==2);
}
document.getElementById("calibBtn").onclick = () => { document.getElementById("calibModal").showModal(); showStep(1); };
document.getElementById("prevStep").onclick = () => showStep(1);
document.getElementById("nextStep").onclick = () => showStep(2);
document.getElementById("useDryNow").onclick = () => { if(latest) document.getElementById("dryInput").value = latest.raw; };
document.getElementById("useWetNow").onclick = () => { if(latest) document.getElementById("wetInput").value = latest.raw; };
document.getElementById("saveCalib").onclick = async ()=>{
  const rawDry=Number(document.getElementById("dryInput").value), rawWet=Number(document.getElementById("wetInput").value);
  if(!Number.isFinite(rawDry)||!Number.isFinite(rawWet)){alert("Bitte DRY und WET RAW eingeben.");return;}
  const resp=await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,rawDry,rawWet})});
  if(resp.ok){document.getElementById("calibModal").close(); await fetchSeries(currentRange);} else alert("Kalibrierung fehlgeschlagen.");
};
document.getElementById("resetCalib").onclick = async()=>{
  if(!confirm("Kalibrierung zurücksetzen?"))return;
  await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,reset:true})});
  await fetchSeries(currentRange);
};

// ===== Events & Init =====
els.rangeButtons().forEach(b=>{ b.onclick = ()=>{ currentRange = b.dataset.range; fetchSeries(currentRange); }; });
els.saveInfo.onclick = savePlantProfile;

initChart();
fetchSeries(currentRange);
setInterval(pollLatest, POLL_MS);
fetchPlant();
