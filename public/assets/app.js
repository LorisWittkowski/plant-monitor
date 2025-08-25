// Config
const POLL_MS = 3000;
const RAW_MAX = 4095;
const SENSOR_ID = "soil-1";
const DEFAULT_RANGE = "1h";

// State
let latest = null, config = null, lastSeenAt = null, currentDisplayedPercent = null;
let currentRange = DEFAULT_RANGE, plantProfile = null;

// DOM
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const els = {
  value: $("#value"), raw: $("#raw"), ts: $("#ts"), fill: $("#fill"),
  chart: $("#chart"),
  rangeButtons: () => $$(".range .btn.seg"),
  themeToggle: $("#themeToggle"),
  calibBtn: $("#calibBtn"), modal: $("#calibModal"),
  dryInput: $("#dryInput"), wetInput: $("#wetInput"),
  useDryNow: $("#useDryNow"), useWetNow: $("#useWetNow"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"),
  saveCalib: $("#saveCalib"), resetCalib: $("#resetCalib"),
  calibLabel: $("#calibLabel"), calibMeta: $("#calibMeta"),
  pi_name: $("#pi_name"), pi_species: $("#pi_species"),
  pi_location: $("#pi_location"), pi_pot: $("#pi_pot"),
  pi_note: $("#pi_note"), saveInfo: $("#saveInfo"),
};

// Theme
(function initTheme(){
  const saved = localStorage.getItem("theme");
  const prefers = matchMedia("(prefers-color-scheme: dark)").matches;
  const t = saved || (prefers ? "dark":"light");
  document.documentElement.setAttribute("data-theme", t);
})();
els.themeToggle?.addEventListener("click", ()=>{
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur==="dark"?"light":"dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  if (chart) chart.update();
});

// Helpers
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const asPercent = raw => {
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet)
    return clamp((raw/RAW_MAX)*100,0,100);
  return clamp(100*(raw - config.rawDry)/(config.rawWet - config.rawDry),0,100);
};

// Textarea autosize
function autosize(el){ if (!el) return; el.style.height='auto'; el.style.height=(el.scrollHeight+2)+'px'; }
function bindAutosize(el){
  if (!el || el._autosizeBound) return;
  const h = ()=>autosize(el);
  el.addEventListener('input',h); window.addEventListener('resize',h,{passive:true});
  if (document.fonts?.ready) document.fonts.ready.then(h).catch(()=>{});
  el._autosizeBound = true; autosize(el);
}

// Live UI
function updateLive(raw, atIso){
  const p = asPercent(raw);
  els.fill.style.width = p.toFixed(1) + "%";
  const show = Math.round(p);
  if (currentDisplayedPercent==null || Math.abs(currentDisplayedPercent - p) >= 1)
    els.value.textContent = show + "%";
  currentDisplayedPercent = p;
  els.raw.textContent = raw;
  els.ts.textContent = new Date(atIso).toLocaleString();
}

// Calibration summary
function renderCalibSummary(){
  if (!els.calibLabel || !els.calibMeta) return;
  if (config && typeof config.rawDry==="number" && typeof config.rawWet==="number"){
    els.calibLabel.textContent = `DRY: ${config.rawDry} · WET: ${config.rawWet}`;
    els.calibMeta.textContent = config.lastCalibrated
      ? `Zuletzt aktualisiert: ${new Date(config.lastCalibrated).toLocaleString()}`
      : `Kalibrierung aktiv.`;
  } else {
    els.calibLabel.textContent = "Keine Kalibrierung gespeichert";
    els.calibMeta.textContent = "Fallback: Prozent aus RAW (0..4095).";
  }
}

// Chart
let chart;
function initChart(){
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
      responsive:true, maintainAspectRatio:false,
      animation:{ duration:350, easing:"easeOutCubic" },
      events:[],
      plugins:{
        legend:{ display:false },
        tooltip:{ enabled:false },
        decimation:{ enabled:true, algorithm:'lttb', samples:120 }
      },
      scales:{
        x:{ display:false },
        y:{ grid:{display:false}, ticks:{display:false},
            border:{ display:true, color: cssVar('--muted','#9a9a9b') } }
      },
      layout:{ padding:6 }
    }
  });
}

function setSeries(points){
  let norm = (points||[])
    .map(p=>{
      const t = new Date(p.at || p.time || Date.now()).getTime();
      let y = null;
      if (typeof p.percent === "number") y = p.percent;
      else if (typeof p.raw === "number") y = (p.raw/RAW_MAX)*100;
      else if (typeof p.rawAvg === "number") y = (p.rawAvg/RAW_MAX)*100;
      return {t,y};
    })
    .filter(p=>Number.isFinite(p.t))
    .sort((a,b)=>a.t-b.t);

  if (config?.lastCalibrated){
    const hushBefore = 30*1000, hushAfter = 60*1000;
    const t0 = new Date(config.lastCalibrated).getTime();
    norm = norm.map(p => (p.t >= t0-hushBefore && p.t <= t0+hushAfter) ? {...p,y:null}:p);
  }

  if (norm.length===0 && latest){
    const t = new Date(latest.at).getTime();
    const y = (typeof latest.percent==="number") ? latest.percent : (latest.raw/RAW_MAX)*100;
    norm.push({t,y});
  }

  const HARD_CAP = 1200;
  const data = norm.length>HARD_CAP ? norm.slice(-HARD_CAP) : norm;

  chart.data.labels = data.map(d=>d.t);
  chart.data.datasets[0].data = data.map(d=>d.y);

  const vals = data.map(d=>d.y).filter(v=>typeof v==="number" && isFinite(v));
  if (vals.length){
    const minV = Math.max(0, Math.min(...vals));
    const maxV = Math.min(100, Math.max(...vals));
    const spread = Math.max(2, maxV-minV);
    const pad = Math.min(6, Math.max(2, spread*0.08));
    chart.options.scales.y.min = Math.max(0, Math.floor((minV-pad)*10)/10);
    chart.options.scales.y.max = Math.min(100, Math.ceil((maxV+pad)*10)/10);
  } else {
    chart.options.scales.y.min = 0;
    chart.options.scales.y.max = 100;
  }

  const nonNull = vals.length;
  chart.data.datasets[0].pointRadius = (nonNull < 2) ? 3 : 0;
  chart.options.plugins.decimation.enabled = (nonNull >= 200);

  chart.update();
}

// Fetching
async function fetchSeries(range){
  els.rangeButtons().forEach(b=>{
    const active = b.dataset.range===range;
    b.setAttribute("aria-selected", active?"true":"false");
  });
  try{
    const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=${encodeURIComponent(range)}`, {cache:"no-store"});
    if (r.status===204){ setSeries([]); return; }
    const data = await r.json();
    if (data.config){ config = data.config; renderCalibSummary(); }
    if (data.latest){ latest = data.latest; updateLive(latest.raw, latest.at); }
    setSeries(data.series||[]);
  }catch{ setSeries([]); }
}

async function pollLatest(){
  try{
    const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=latest`, {cache:"no-store"});
    if (r.status!==200) return;
    const data = await r.json();
    if (!data.latest) return;
    if (data.latest.at !== lastSeenAt){
      lastSeenAt = data.latest.at;
      config = data.config || config; renderCalibSummary();
      latest = data.latest; updateLive(latest.raw, latest.at);
      fetchSeries(currentRange);
    }
  }catch{}
}

// Plant info
function fillInfoUI(){
  const p = plantProfile || {};
  if (els.pi_name) els.pi_name.value = p.name ?? "";
  if (els.pi_species) els.pi_species.value = p.species ?? "";
  if (els.pi_location) els.pi_location.value = p.location ?? "";
  if (els.pi_pot) els.pi_pot.value = (p.potCm != null ? String(p.potCm) : "");
  if (els.pi_note){ els.pi_note.value = p.note ?? ""; autosize(els.pi_note); }
}
async function fetchPlant(){
  try{
    const r = await fetch(`/api/plant?sensorId=${encodeURIComponent(SENSOR_ID)}`, {cache:"no-store"});
    if (r.status===204){ plantProfile=null; fillInfoUI(); return; }
    const data = await r.json(); plantProfile = data.profile || null; fillInfoUI();
  }catch{}
}
const normalizeEmptyToNull = v => (v==null || (typeof v==="string" && v.trim()==="")) ? null : v;
async function savePlantProfile(){
  const btn = els.saveInfo; if (!btn) return;
  const old = btn.textContent; btn.disabled=true; btn.textContent="Speichere…";
  const body = {
    sensorId:SENSOR_ID,
    profile:{
      name:normalizeEmptyToNull(els.pi_name?.value),
      species:normalizeEmptyToNull(els.pi_species?.value),
      location:normalizeEmptyToNull(els.pi_location?.value),
      potCm: normalizeEmptyToNull(els.pi_pot?.value ? Number(els.pi_pot.value) : null),
      note: normalizeEmptyToNull(els.pi_note?.value),
    }
  };
  try{
    const r = await fetch("/api/plant",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if (!r.ok) throw 0; btn.textContent="Gespeichert ✓"; await fetchPlant();
  }catch{ btn.textContent="Fehler ❌"; }
  finally{ setTimeout(()=>{btn.textContent=old; btn.disabled=false;},900); }
}

// Calibration flow
function showStep(n){
  $$(".modal .step").forEach(sec => sec.hidden = Number(sec.dataset.step)!==n);
  $$(".steps-dots .dot").forEach(dot => dot.classList.toggle("active", Number(dot.dataset.step)===n));
  if (els.prevStep) els.prevStep.style.visibility = n===1 ? "hidden" : "visible";
  if (els.nextStep) els.nextStep.hidden = n===2;
  if (els.saveCalib) els.saveCalib.hidden = n!==2;
}
els.calibBtn?.addEventListener("click", ()=>{ renderCalibSummary(); els.modal?.showModal(); showStep(1); });
els.prevStep?.addEventListener("click", ()=>showStep(1));
els.nextStep?.addEventListener("click", ()=>showStep(2));
els.useDryNow?.addEventListener("click", ()=>{ if (latest && els.dryInput) els.dryInput.value = latest.raw; });
els.useWetNow?.addEventListener("click", ()=>{ if (latest && els.wetInput) els.wetInput.value = latest.raw; });
els.saveCalib?.addEventListener("click", async ()=>{
  const rawDry=Number(els.dryInput?.value), rawWet=Number(els.wetInput?.value);
  if (!Number.isFinite(rawDry) || !Number.isFinite(rawWet)) { alert("Bitte DRY und WET RAW eingeben."); return; }
  const resp = await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,rawDry,rawWet})});
  if (resp.ok){ els.modal?.close(); await fetchSeries(currentRange); } else alert("Kalibrierung fehlgeschlagen.");
});
els.resetCalib?.addEventListener("click", async ()=>{
  if (!confirm("Kalibrierung zurücksetzen?")) return;
  await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,reset:true})});
  await fetchSeries(currentRange); renderCalibSummary();
});

// Events & Init
els.rangeButtons().forEach(b=> b.addEventListener("click", ()=>{
  currentRange = b.dataset.range; localStorage.setItem("range", currentRange); fetchSeries(currentRange);
}));
els.saveInfo?.addEventListener("click", savePlantProfile);

(function init(){
  const savedRange = localStorage.getItem("range");
  if (savedRange && ["1h","24h","7d"].includes(savedRange)) currentRange = savedRange;

  initChart();
  fetchSeries(currentRange);
  fetchPlant();
  if (els.pi_note) bindAutosize(els.pi_note);
  setInterval(pollLatest, POLL_MS);
})();
