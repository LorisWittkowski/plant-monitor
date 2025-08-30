// file: public/assets/app.js
// ==== Config & State ====
const POLL_MS = 3000;
const RAW_MAX = 4095;
let SENSOR_ID = localStorage.getItem("sensorId") || "soil-1";
const DEFAULT_RANGE = "1h";

let latest = null, config = null, lastSeenAt = null, currentDisplayedPercent = null;
let currentRange = DEFAULT_RANGE, plantProfile = null;
let fixedScale = false;

// ==== DOM ====
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
  readNow: $("#readNow"), liveRaw: $("#liveRaw"), livePct: $("#livePct"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"),
  saveCalib: $("#saveCalib"), resetCalib: $("#resetCalib"),
  calibLabel: $("#calibLabel"), calibMeta: $("#calibMeta"), calibPlantName: $("#calibPlantName"),
  pi_name: $("#pi_name"), pi_species: $("#pi_species"),
  pi_location: $("#pi_location"), pi_pot: $("#pi_pot"),
  pi_note: $("#pi_note"), saveInfo: $("#saveInfo"),
  scaleFixed: $("#scaleFixed"),

  // Sidebar + Topbar
  menuBtn: $("#menuBtn"),
  sidebar: $("#sidebar"),
  sidebarClose: $("#sidebarClose"),
  sidebarOverlay: $("#sidebarOverlay"),
  plantList: $("#plantList"),
  addPlantBtn: $("#addPlantBtn"),
  newPlantModal: $("#newPlantModal"),
  np_id: $("#np_id"), np_name: $("#np_name"), np_save: $("#np_save"),

  // Info modal
  infoBtn: $("#infoBtn"),
  infoModal: $("#infoModal"),
  info_sensorId: $("#info_sensorId"),
  info_name: $("#info_name"),
  info_created: $("#info_created"),
  info_updated: $("#info_updated"),
  info_counts: $("#info_counts"),
  info_size: $("#info_size"),
  deletePlantBtn: $("#deletePlantBtn"),
};

// ==== Theme ====
(function initTheme(){
  const saved = localStorage.getItem("theme");
  const prefers = matchMedia("(prefers-color-scheme: dark)").matches;
  const t = saved || (prefers ? "dark":"light");
  document.documentElement.setAttribute("data-theme", t);
  updateThemeButtonLabel();
})();
function updateThemeButtonLabel(){
  const cur = document.documentElement.getAttribute("data-theme");
  if (els.themeToggle) els.themeToggle.textContent = (cur === "dark" ? "Light" : "Dark");
}
els.themeToggle?.addEventListener("click", ()=>{
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur==="dark"?"light":"dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeButtonLabel();
  if (chart) chart.update();
});

// ==== Helpers ====
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const asPercent = raw => {
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet)
    return clamp((raw/RAW_MAX)*100,0,100);
  return clamp(100*(raw - config.rawDry)/(config.rawWet - config.rawDry),0,100);
};
function autosize(el){ if (!el) return; el.style.height='auto'; el.style.height=(el.scrollHeight+2)+'px'; }
function bindAutosize(el){
  if (!el || el._autosizeBound) return;
  const h = ()=>autosize(el);
  el.addEventListener('input',h); window.addEventListener('resize',h,{passive:true});
  if (document.fonts?.ready) document.fonts.ready.then(h).catch(()=>{});
  el._autosizeBound = true; autosize(el);
}

// NEW: Live-UI zurücksetzen (wenn Sensor wechselt / keine Daten)
function resetLiveUI(){
  els.fill.style.width = "0%";
  els.value.textContent = "—%";
  els.raw.textContent = "—";
  els.ts.textContent = "—";
  currentDisplayedPercent = null;
}

// ==== Live UI ====
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

// ==== Calibration summary ====
function renderCalibSummary(){
  if (!els.calibLabel || !els.calibMeta) return;
  if (config && typeof config.rawDry==="number" && typeof config.rawWet==="number"){
    els.calibLabel.textContent = `DRY: ${config.rawDry} · WET: ${config.rawWet}`;
    const stamp = config.lastCalibrated || config.updatedAt;
    els.calibMeta.textContent = stamp
      ? `Zuletzt aktualisiert: ${new Date(stamp).toLocaleString()}`
      : `Kalibrierung aktiv.`;
  } else {
    els.calibLabel.textContent = "Keine Kalibrierung gespeichert";
    els.calibMeta.textContent = "Fallback: Prozent aus RAW (0..4095).";
  }
}

// ==== Chart ====
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
      borderColor: () => cssVar('--fg-strong', '#222'),
      clip: 12
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
      layout:{ padding:{ top:18, bottom:12, left:6, right:6 } }
    }
  });
}

function setSeries(points){
  let norm = (points||[])
    .map(p=>{
      const t = new Date(p.at || p.time || Date.now()).getTime();
      let y = null;
      if (typeof p.percent === "number") y = p.percent;
      else if (typeof p.raw === "number") y = asPercent(p.raw);
      else if (typeof p.rawAvg === "number") y = asPercent(p.rawAvg);
      return {t,y};
    })
    .filter(p=>Number.isFinite(p.t))
    .sort((a,b)=>a.t-b.t);

  if (config?.lastCalibrated || config?.updatedAt){
    const hushBefore = 30*1000, hushAfter = 60*1000;
    const t0 = new Date(config.lastCalibrated || config.updatedAt).toISOString();
    const t0ms = Date.parse(t0);
    norm = norm.map(p => (p.t >= t0ms-30000 && p.t <= t0ms+60000) ? {...p,y:null}:p);
  }

  if (norm.length===0 && latest){
    const t = new Date(latest.at).getTime();
    const y = (typeof latest.percent==="number") ? latest.percent : asPercent(latest.raw);
    norm.push({t,y});
  }

  const HARD_CAP = 1200;
  const data = norm.length>HARD_CAP ? norm.slice(-HARD_CAP) : norm;

  chart.data.labels = data.map(d=>d.t);
  chart.data.datasets[0].data = data.map(d=>d.y);

  const vals = data.map(d=>d.y).filter(v=>typeof v==="number" && isFinite(v));
  if (fixedScale){
    chart.options.scales.y.min = 0;
    chart.options.scales.y.max = 100;
  } else if (vals.length){
    const minV = Math.max(0, Math.min(...vals));
    const maxV = Math.min(100, Math.max(...vals));
    const spread = Math.max(2, maxV-minV);
    const pad = Math.max(3, spread * 0.12);
    chart.options.scales.y.min = Math.max(0, Math.floor((minV - pad) * 10) / 10);
    chart.options.scales.y.max = Math.min(100, Math.ceil((maxV + pad) * 10) / 10);
  } else {
    chart.options.scales.y.min = 0;
    chart.options.scales.y.max = 100;
  }

  const nonNull = vals.length;
  chart.data.datasets[0].pointRadius = (nonNull < 2) ? 3 : 0;
  chart.options.plugins.decimation.enabled = (nonNull >= 200);
  chart.update();
}

// ==== Fetching ====
async function fetchSeries(range){
  els.rangeButtons().forEach(b=>{
    const active = b.dataset.range===range;
    b.setAttribute("aria-selected", active?"true":"false");
  });
  try{
    const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=${encodeURIComponent(range)}`, {cache:"no-store"});
    if (r.status===204){ setSeries([]); resetLiveUI(); config=null; renderCalibSummary(); return; }
    const data = await r.json();
    if (data.config){ config = data.config; renderCalibSummary(); }
    if (data.latest){ latest = data.latest; updateLive(latest.raw, latest.at); }
    else { resetLiveUI(); }
    setSeries(data.series||[]);
  }catch{ setSeries([]); resetLiveUI(); }
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

// ==== Plant info ====
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
    const active = els.plantList?.querySelector('.plant-item[aria-selected="true"] .plant-name');
    if (active && els.pi_name?.value) active.textContent = els.pi_name.value;
  }catch{ btn.textContent="Fehler ❌"; }
  finally{ setTimeout(()=>{btn.textContent=old; btn.disabled=false;},900); }
}

// ==== Calibration (UI) ====
function setCalibPreviewFromInputs(){
  const rawStr = els.liveRaw?.textContent;
  const raw = Number(rawStr?.replace(/[^\d.]/g,'')); // tolerant
  const dry = Number(els.dryInput?.value);
  const wet = Number(els.wetInput?.value);
  if (!Number.isFinite(raw) || !Number.isFinite(dry) || !Number.isFinite(wet) || dry===wet){
    if (els.livePct) els.livePct.textContent = "—%";
    return;
  }
  const p = clamp(100*(raw - dry)/(wet - dry), 0, 100);
  els.livePct.textContent = Math.round(p)+"%";
}
async function readCurrentRaw(){
  try{
    const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=latest`, {cache:"no-store"});
    if (!r.ok){ els.liveRaw.textContent = "—"; return; }
    const data = await r.json();
    if (data?.latest?.raw != null){
      els.liveRaw.textContent = String(data.latest.raw);
      setCalibPreviewFromInputs();
    } else {
      els.liveRaw.textContent = "—";
    }
  }catch{ els.liveRaw.textContent = "—"; }
}
function openCalibModal(){
  els.calibPlantName.textContent = plantProfile?.name || SENSOR_ID;
  renderCalibSummary();
  // vorbefüllen, falls vorhanden
  els.dryInput.value = (config?.rawDry ?? "");
  els.wetInput.value = (config?.rawWet ?? "");
  els.liveRaw.textContent = "—";
  els.livePct.textContent = "—%";
  els.modal?.showModal();
  // direkt einmal versuchen zu lesen
  readCurrentRaw();
}
els.calibBtn?.addEventListener("click", openCalibModal);
els.useDryNow?.addEventListener("click", async ()=>{ await readCurrentRaw(); const v = Number(els.liveRaw.textContent); if (Number.isFinite(v)) els.dryInput.value = v; setCalibPreviewFromInputs(); });
els.useWetNow?.addEventListener("click", async ()=>{ await readCurrentRaw(); const v = Number(els.liveRaw.textContent); if (Number.isFinite(v)) els.wetInput.value = v; setCalibPreviewFromInputs(); });
els.readNow?.addEventListener("click", async ()=>{ await readCurrentRaw(); });

els.dryInput?.addEventListener("input", setCalibPreviewFromInputs);
els.wetInput?.addEventListener("input", setCalibPreviewFromInputs);

els.saveCalib?.addEventListener("click", async ()=>{
  const rawDry=Number(els.dryInput?.value), rawWet=Number(els.wetInput?.value);
  if (!Number.isFinite(rawDry) || !Number.isFinite(rawWet)) { alert("Bitte DRY und WET RAW eingeben."); return; }
  if (rawDry===rawWet) { alert("Trocken und Nass müssen verschieden sein."); return; }
  const resp = await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,rawDry,rawWet})});
  if (resp.ok){ els.modal?.close(); await fetchSeries(currentRange); } else {
    const t = await resp.text().catch(()=> "");
    alert("Kalibrierung fehlgeschlagen: "+t);
  }
});
els.resetCalib?.addEventListener("click", async ()=>{
  if (!confirm("Kalibrierung für diese Pflanze zurücksetzen?")) return;
  await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,reset:true})});
  await fetchSeries(currentRange); renderCalibSummary(); setCalibPreviewFromInputs();
});

// ==== Scale switch ====
(function initScaleSwitch(){
  const saved = localStorage.getItem("fixedScale");
  fixedScale = saved === "1";
  if (els.scaleFixed) {
    els.scaleFixed.checked = fixedScale;
    els.scaleFixed.addEventListener("change", () => {
      fixedScale = !!els.scaleFixed.checked;
      localStorage.setItem("fixedScale", fixedScale ? "1" : "0");
      if (chart) setSeries(chart.data.datasets[0].data.map((y, i) => ({ t: chart.data.labels[i], y })));
    });
  }
})();

// ==== Sidebar controls ====
function openSidebar(){ els.sidebar?.classList.add('open'); els.sidebar?.setAttribute('aria-hidden','false'); els.sidebarOverlay.hidden = false; }
function closeSidebar(){ els.sidebar?.classList.remove('open'); els.sidebar?.setAttribute('aria-hidden','true'); els.sidebarOverlay.hidden = true; }
els.menuBtn?.addEventListener('click', openSidebar);
els.sidebarClose?.addEventListener('click', closeSidebar);
els.sidebarOverlay?.addEventListener('click', closeSidebar);

// ==== Sensors (Liste) ====
async function loadSensors(){
  try {
    const r = await fetch("/api/sensors", {cache:"no-store"});
    if (!r.ok) return;
    const data = await r.json();
    const sensors = (data.sensors || []);
    const list = els.plantList;
    list.innerHTML = "";

    sensors.forEach(s=>{
      const item = document.createElement('button');
      item.className = 'plant-item';
      item.setAttribute('role','option');
      item.dataset.id = s.id;
      item.innerHTML = `
        <span class="plant-name">${s.name || s.id}</span>
        <span class="plant-meta">${s.calibrated ? 'kalibriert' : 'unkalibriert'}</span>
      `;
      if (s.id === SENSOR_ID) item.setAttribute('aria-selected','true');
      item.addEventListener('click', ()=>{
        SENSOR_ID = s.id;
        localStorage.setItem("sensorId", SENSOR_ID);
        latest = null; config = null; lastSeenAt = null;
        resetLiveUI(); setSeries([]);
        list.querySelectorAll('.plant-item[aria-selected="true"]').forEach(el=>el.removeAttribute('aria-selected'));
        item.setAttribute('aria-selected','true');
        closeSidebar();
        fetchSeries(currentRange);
        fetchPlant();
      });
      list.appendChild(item);
    });

    if (!sensors.some(s=>s.id===SENSOR_ID) && sensors.length){
      SENSOR_ID = sensors[0].id;
      localStorage.setItem("sensorId", SENSOR_ID);
    }
    if (sensors.length){
      fetchSeries(currentRange);
      fetchPlant();
    } else {
      resetLiveUI(); setSeries([]); plantProfile=null; fillInfoUI();
    }
  } catch (e) { console.error(e); }
}

els.addPlantBtn?.addEventListener("click", ()=> els.newPlantModal?.showModal());
els.np_save?.addEventListener("click", async ()=>{
  const id = els.np_id?.value?.trim();
  const name = els.np_name?.value?.trim();
  if (!id) { alert("Bitte Sensor-ID eingeben!"); return; }
  try{
    const r = await fetch("/api/register",{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ sensorId:id, name })});
    if (!r.ok) { const txt = await r.text().catch(()=> ""); alert(`Fehler: ${r.status} ${txt}`); return; }
    els.newPlantModal?.close(); els.np_id.value = ""; els.np_name.value = "";
    await loadSensors(); SENSOR_ID = id; localStorage.setItem("sensorId", id);
    fetchSeries(currentRange); fetchPlant();
  }catch(e){ alert("Fehler beim Anlegen!"); }
});

// --- ersetze die komplette Funktion deleteCurrentPlant() ---
async function deleteCurrentPlant(){
  if (!SENSOR_ID) { alert("Keine Pflanze ausgewählt."); return; }

  const displayName = plantProfile?.name || els.info_name?.textContent || SENSOR_ID;

  if (!confirm(`Wirklich löschen?\n"${displayName}" (ID: ${SENSOR_ID})`)) return;
  if (!confirm("Letzte Bestätigung: ALLE Daten dieser Pflanze werden gelöscht. Fortfahren?")) return;

  const btn = els.deletePlantBtn;
  const oldLabel = btn?.textContent;
  if (btn){ btn.disabled = true; btn.textContent = "Lösche…"; }

  // Request mit Timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(()=>controller.abort(), 10000); // 10s

  try{
    const r = await fetch("/api/delete-plant", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ sensorId: SENSOR_ID }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!r.ok) {
      const txt = await r.text().catch(()=> "");
      throw new Error(`Serverfehler ${r.status}: ${txt}`);
    }

    // Modalschließen + State hart resetten (kein Ghost-State)
    els.infoModal?.close();

    SENSOR_ID = null;
    localStorage.removeItem("sensorId");
    latest = null; config = null; lastSeenAt = null;
    resetLiveUI(); setSeries([]); plantProfile = null; fillInfoUI(); renderCalibSummary();

    // Sidebar neu laden und ggf. erste Pflanze aktivieren
    await loadSensors();

    const first = els.plantList?.querySelector('.plant-item');
    if (first){
      const newId = first.dataset.id;
      SENSOR_ID = newId;
      localStorage.setItem("sensorId", newId);
      first.setAttribute('aria-selected','true');
      fetchSeries(currentRange);
      fetchPlant();
    } else {
      alert(`„${displayName}“ wurde entfernt. Es sind keine Pflanzen mehr vorhanden.`);
    }

  }catch(e){
    const reason = e?.name === "AbortError" ? "Zeitüberschreitung (10s)" : (e?.message || e);
    alert(`Löschen fehlgeschlagen: ${reason}`);
  }finally{
    clearTimeout(timeoutId);
    if (btn){ btn.disabled = false; btn.textContent = oldLabel; }
  }
}

// ==== Range + Save bindings ====
els.rangeButtons().forEach(b=> b.addEventListener("click", ()=>{
  currentRange = b.dataset.range; localStorage.setItem("range", currentRange); fetchSeries(currentRange);
}));
els.saveInfo?.addEventListener("click", savePlantProfile);

// ==== Init ====
(function init(){
  const savedRange = localStorage.getItem("range");
  if (savedRange && ["1h","24h","7d"].includes(savedRange)) currentRange = savedRange;

  initChart();
  loadSensors();

  if (els.pi_note) bindAutosize(els.pi_note);
  setInterval(pollLatest, POLL_MS);
})();
