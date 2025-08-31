// ==== Config & State ====
const POLL_MS = 3000;
const RAW_MAX = 4095;
let SENSOR_ID = localStorage.getItem("sensorId") || "soil-1";
const DEFAULT_RANGE = "1h";

let latest = null, config = null, lastSeenAt = null, currentDisplayedPercent = null;
let currentRange = DEFAULT_RANGE, plantProfile = null;
let fixedScale = false;

// ==== Tiny DOM helpers (always fresh) ====
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

// cached-but-noncritical (may be null; we re-query when needed)
const els = {
  value: $("#value"), raw: $("#raw"), ts: $("#ts"), fill: $("#fill"),
  chart: $("#chart"),
  rangeButtons: () => $$(".range .btn.seg"),
  themeToggle: $("#themeToggle"),

  // plant fields
  pi_name: $("#pi_name"), pi_species: $("#pi_species"),
  pi_location: $("#pi_location"), pi_pot: $("#pi_pot"),
  pi_note: $("#pi_note"), saveInfo: $("#saveInfo"),

  // calibration quick refs (will be re-queried too)
  calibLabel: $("#calibLabel"), calibMeta: $("#calibMeta"), calibPlantName: $("#calibPlantName"),
  dryInput: $("#dryInput"), wetInput: $("#wetInput"),
  liveRaw: $("#liveRaw"), livePct: $("#livePct"),
  saveCalib: $("#saveCalib"), resetCalib: $("#resetCalib"),

  // Sidebar + Topbar
  menuBtn: $("#menuBtn"),
  sidebar: $("#sidebar"),
  sidebarClose: $("#sidebarClose"),
  sidebarOverlay: $("#sidebarOverlay"),
  plantList: $("#plantList"),
  addPlantBtn: $("#addPlantBtn"),
  newPlantModal: $("#newPlantModal"),
  np_id: $("#np_id"), np_name: $("#np_name"), np_pin: $("#np_pin"), np_save: $("#np_save"),

  // Info + Wipe
  infoBtn: $("#infoBtn"),
  arduinoBtn: $("#arduinoBtn"),
  infoModal: $("#infoModal"),
  info_sensorId: $("#info_sensorId"),
  info_name: $("#info_name"),
  info_created: $("#info_created"),
  info_updated: $("#info_updated"),
  info_counts: $("#info_counts"),
  info_size: $("#info_size"),
  info_pin: $("#info_pin"),
  info_pin_save: $("#info_pin_save"),
  deletePlantBtn: $("#deletePlantBtn"),
  openWipeBtn: $("#openWipeBtn"),
  wipeModal: $("#wipeModal"),
  wipeRange: $("#wipeRange"),
  wipeLabel: $("#wipeLabel"),
  wipeConfirm: $("#wipeConfirm"),

  scaleFixed: $("#scaleFixed"),
};

const ALLOWED_PINS = ["A0","A1","A2","A3","A4","A5"];

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
  const r = Number(raw);
  if (!Number.isFinite(r)) return 0;
  const hasCfg = config
    && Number.isFinite(config.rawDry)
    && Number.isFinite(config.rawWet)
    && config.rawDry !== config.rawWet;
  let p = hasCfg ? 100 * (r - config.rawDry) / (config.rawWet - config.rawDry)
                 : 100 * (r / RAW_MAX);
  if (!Number.isFinite(p)) p = 0;
  return clamp(p, 0, 100);
};

function autosize(el){ if (!el) return; el.style.height='auto'; el.style.height=(el.scrollHeight+2)+'px'; }
function bindAutosize(el){
  if (!el || el._autosizeBound) return;
  const h = ()=>autosize(el);
  el.addEventListener('input',h); window.addEventListener('resize',h,{passive:true});
  if (document.fonts?.ready) document.fonts.ready.then(h).catch(()=>{});
  el._autosizeBound = true; autosize(el);
}
function resetLiveUI(){
  els.fill?.style && (els.fill.style.width = "0%");
  els.value && (els.value.textContent = "—%");
  els.raw && (els.raw.textContent = "—");
  els.ts && (els.ts.textContent = "—");
  currentDisplayedPercent = null;
}
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

// ==== Live UI ====
function updateLive(raw, atIso){
  const p = asPercent(raw);
  const safeP = Number.isFinite(p) ? p : 0;
  if (els.fill?.style) els.fill.style.width = safeP.toFixed(1) + "%";
  const show = Math.round(safeP);
  if (els.value && (currentDisplayedPercent==null || Math.abs(currentDisplayedPercent - safeP) >= 1))
    els.value.textContent = show + "%";
  currentDisplayedPercent = safeP;
  if (els.raw) els.raw.textContent = raw;
  if (els.ts) els.ts.textContent = new Date(atIso).toLocaleString();
}

// ==== Calibration summary ====
function renderCalibSummary(){
  const lab = $("#calibLabel");
  const meta = $("#calibMeta");
  if (!lab || !meta) return;

  if (config && typeof config.rawDry==="number" && typeof config.rawWet==="number"){
    lab.textContent = `DRY: ${config.rawDry} · WET: ${config.rawWet}`;
    const stamp = config.lastCalibrated || config.updatedAt;
    meta.textContent = stamp ? `Zuletzt aktualisiert: ${new Date(stamp).toLocaleString()}` : `Kalibrierung aktiv.`;
  } else {
    lab.textContent = "Keine Kalibrierung gespeichert";
    meta.textContent = "Fallback: Prozent aus RAW (0..4095).";
  }
}

// ==== Chart ====
let chart;
function initChart(){
  const ctx = els.chart?.getContext && els.chart.getContext("2d");
  if (!ctx) return;
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
      plugins:{ legend:{ display:false }, tooltip:{ enabled:false }, decimation:{ enabled:true, algorithm:'lttb', samples:120 } },
      scales:{ x:{ display:false }, y:{ grid:{display:false}, ticks:{display:false}, border:{ display:true, color: cssVar('--muted','#9a9a9b') } } },
      layout:{ padding:{ top:18, bottom:12, left:6, right:6 } }
    }
  });
}

function setSeries(points){
  if (!chart) return;
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
    const t0 = new Date(config.lastCalibrated || config.updatedAt).getTime();
    norm = norm.map(p => (p.t >= t0-30000 && p.t <= t0+60000) ? {...p,y:null}:p);
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

// ==== Calibration UI ====
// preview helper
function setCalibPreviewFromInputs(){
  const rawStr = $("#liveRaw")?.textContent;
  const raw = Number(rawStr?.replace(/[^\d.]/g,''));
  const dry = Number($("#dryInput")?.value);
  const wet = Number($("#wetInput")?.value);
  const livePct = $("#livePct");
  if (!Number.isFinite(raw) || !Number.isFinite(dry) || !Number.isFinite(wet) || dry===wet){
    if (livePct) livePct.textContent = "—%";
    return;
  }
  const p = clamp(100*(raw - dry)/(wet - dry), 0, 100);
  if (livePct) livePct.textContent = Math.round(p)+"%";
}
async function readCurrentRaw(){
  const liveRawEl = $("#liveRaw");
  try{
    const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=latest`, {cache:"no-store"});
    if (!r.ok){ if (liveRawEl) liveRawEl.textContent = "—"; return; }
    const data = await r.json();
    if (data?.latest?.raw != null){
      if (liveRawEl) liveRawEl.textContent = String(data.latest.raw);
      setCalibPreviewFromInputs();
    } else {
      if (liveRawEl) liveRawEl.textContent = "—";
    }
  }catch{ if (liveRawEl) liveRawEl.textContent = "—"; }
}

// robust modal opener
function openCalibModal(){
  // close sidebar/overlay if open
  try { closeSidebar(); } catch {}
  const dlg = document.getElementById("calibModal");
  if (!dlg) { alert("Kalibrierungs-Dialog nicht gefunden."); return; }

  const name = (plantProfile?.name && String(plantProfile.name).trim())
    ? plantProfile.name : (SENSOR_ID || "—");
  const titleSpan = document.getElementById("calibPlantName");
  if (titleSpan) titleSpan.textContent = name;

  renderCalibSummary();
  const dry = document.getElementById("dryInput");
  const wet = document.getElementById("wetInput");
  const liveRaw = document.getElementById("liveRaw");
  const livePct = document.getElementById("livePct");
  if (dry) dry.value = (config?.rawDry ?? "");
  if (wet) wet.value = (config?.rawWet ?? "");
  if (liveRaw) liveRaw.textContent = "—";
  if (livePct) livePct.textContent = "—%";

  try { dlg.showModal(); }
  catch { dlg.setAttribute("open",""); }

  readCurrentRaw();
}

// input wiring for calibration dialog
$("#useDryNow")?.addEventListener("click", async ()=>{
  await readCurrentRaw();
  const v = Number($("#liveRaw")?.textContent);
  const dry = $("#dryInput");
  if (Number.isFinite(v) && dry) dry.value = v;
  setCalibPreviewFromInputs();
});
$("#useWetNow")?.addEventListener("click", async ()=>{
  await readCurrentRaw();
  const v = Number($("#liveRaw")?.textContent);
  const wet = $("#wetInput");
  if (Number.isFinite(v) && wet) wet.value = v;
  setCalibPreviewFromInputs();
});
$("#readNow")?.addEventListener("click", readCurrentRaw);
$("#dryInput")?.addEventListener("input", setCalibPreviewFromInputs);
$("#wetInput")?.addEventListener("input", setCalibPreviewFromInputs);

$("#saveCalib")?.addEventListener("click", async ()=>{
  const rawDry=Number($("#dryInput")?.value), rawWet=Number($("#wetInput")?.value);
  if (!Number.isFinite(rawDry) || !Number.isFinite(rawWet)) { alert("Bitte DRY und WET RAW eingeben."); return; }
  if (rawDry===rawWet) { alert("Trocken und Nass müssen verschieden sein."); return; }
  const resp = await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,rawDry,rawWet})});
  if (resp.ok){ $("#calibModal")?.close(); await fetchSeries(currentRange); } else {
    const t = await resp.text().catch(()=> "");
    alert("Kalibrierung fehlgeschlagen: "+t);
  }
});
$("#resetCalib")?.addEventListener("click", async ()=>{
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
function openSidebar(){ els.sidebar?.classList.add('open'); els.sidebar?.setAttribute('aria-hidden','false'); if ($("#sidebarOverlay")) $("#sidebarOverlay").hidden = false; }
function closeSidebar(){ els.sidebar?.classList.remove('open'); els.sidebar?.setAttribute('aria-hidden','true'); if ($("#sidebarOverlay")) $("#sidebarOverlay").hidden = true; }
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
    if (list) list.innerHTML = "";

    sensors.forEach(s=>{
      const item = document.createElement('button');
      item.className = 'plant-item';
      item.type = 'button';
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
      list?.appendChild(item);
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
      const empty = document.createElement('div');
      empty.className = 'plant-item';
      empty.style.cursor = 'default';
      empty.innerHTML = `<span class="plant-name">Keine Pflanzen</span><span class="plant-meta">Lege eine neue an</span>`;
      list?.appendChild(empty);
    }
  } catch (e) { console.error(e); }
}

// Neue Pflanze (mit Pin)
els.addPlantBtn?.addEventListener("click", ()=> els.newPlantModal?.showModal());
els.np_save?.addEventListener("click", async ()=>{
  const id = els.np_id?.value?.trim();
  const name = els.np_name?.value?.trim();
  const pin = els.np_pin?.value?.trim();
  if (!id) { alert("Bitte Sensor-ID eingeben!"); return; }
  if (!pin || !ALLOWED_PINS.includes(pin)) { alert("Bitte gültigen Analog-Pin wählen (A0–A5)."); return; }

  try{
    const r = await fetch("/api/register",{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ sensorId:id, name })});
    if (!r.ok) { const txt = await r.text().catch(()=> ""); alert(`Fehler: ${r.status} ${txt}`); return; }

    await fetch("/api/plant",{ method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ sensorId:id, profile:{ name: name || null, pin } })
    });

    els.newPlantModal?.close(); els.np_id.value = ""; els.np_name.value = ""; els.np_pin.value = "";
    await loadSensors(); SENSOR_ID = id; localStorage.setItem("sensorId", id);
    fetchSeries(currentRange); fetchPlant();
  }catch(e){ console.error(e); alert("Fehler beim Anlegen!"); }
});

// ==== Info modal + Wipe + Delete ====
async function openInfo(){
  if (!SENSOR_ID) return;
  closeSidebar();
  try{
    const r = await fetch(`/api/plant-stats?sensorId=${encodeURIComponent(SENSOR_ID)}`, {cache:"no-store"});
    const data = r.ok ? await r.json() : null;
    if (els.info_sensorId) els.info_sensorId.textContent = data?.sensorId || SENSOR_ID;
    const name = (plantProfile?.name && String(plantProfile.name).trim()) ? plantProfile.name : (data?.profile?.name || SENSOR_ID);
    if (els.info_name) els.info_name.textContent = name;
    if (els.info_created) els.info_created.textContent = data?.profile?.createdAt ? new Date(data.profile.createdAt).toLocaleString() : "—";
    if (els.info_updated) els.info_updated.textContent = data?.profile?.updatedAt ? new Date(data.profile.updatedAt).toLocaleString() : "—";
    const c = data?.counts || {};
    if (els.info_counts) els.info_counts.textContent = `${c.history ?? 0} / ${c.agg10m ?? 0} / ${c.notes ?? 0}`;
    const b = data?.bytes || {};
    if (els.info_size) els.info_size.textContent = `${b?.total ? Math.round(b.total/1024) : 0} KB (gesamt)`;

    const pin = data?.profile?.pin || plantProfile?.pin || "";
    if (els.info_pin) els.info_pin.value = ALLOWED_PINS.includes(pin) ? pin : "";
  }catch{
    if (els.info_sensorId) els.info_sensorId.textContent = SENSOR_ID;
    if (els.info_name) els.info_name.textContent = (plantProfile?.name && String(plantProfile.name).trim()) ? plantProfile.name : SENSOR_ID;
    if (els.info_created) els.info_created.textContent = "—";
    if (els.info_updated) els.info_updated.textContent = "—";
    if (els.info_counts) els.info_counts.textContent = "—";
    if (els.info_size) els.info_size.textContent = "—";
    if (els.info_pin) els.info_pin.value = plantProfile?.pin || "";
  }
  const dlg = document.getElementById("infoModal");
  try { dlg?.showModal(); } catch { dlg?.setAttribute("open",""); }
}
els.infoBtn?.addEventListener("click", openInfo, { passive:true });

// Pin speichern im Info-Dialog
els.info_pin_save?.addEventListener("click", async ()=>{
  if (!SENSOR_ID) return;
  const pin = els.info_pin?.value?.trim();
  if (!pin || !ALLOWED_PINS.includes(pin)) { alert("Bitte gültigen Analog-Pin wählen (A0–A5)."); return; }
  try{
    const r = await fetch("/api/plant",{ method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ sensorId: SENSOR_ID, profile:{ pin } })
    });
    if (!r.ok){ const t = await r.text().catch(()=> ""); throw new Error(`${r.status} ${t}`); }
    await fetchPlant();
    alert("Pin gespeichert.");
  }catch(e){ console.error(e); alert("Pin konnte nicht gespeichert werden."); }
});

// Wipe-Dialog
function renderWipeLabel(){
  const v = Number(els.wipeRange?.value || 24);
  if (els.wipeLabel) els.wipeLabel.textContent = (v === 25) ? "ALLE Daten" : `${v} h`;
}
els.openWipeBtn?.addEventListener("click", ()=>{
  if (!SENSOR_ID) { alert("Keine Pflanze ausgewählt."); return; }
  if (els.wipeRange) els.wipeRange.value = "24";
  renderWipeLabel();
  const dlg = document.getElementById("wipeModal");
  try { dlg?.showModal(); } catch { dlg?.setAttribute("open",""); }
});
els.wipeRange?.addEventListener("input", renderWipeLabel);

els.wipeConfirm?.addEventListener("click", async ()=>{
  if (!SENSOR_ID) return;
  const v = Number(els.wipeRange.value);
  const isAll = (v === 25);
  const question = isAll
    ? "Wirklich ALLE historischen Daten dieser Pflanze löschen?\n(History + 10-Min-Aggregation)"
    : `Wirklich alle historischen Daten löschen, die älter sind als ${v} Stunden?`;
  if (!confirm(question)) return;

  const btn = els.wipeConfirm;
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "Setze zurück…";

  try{
    const r = await fetch("/api/wipe-history", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ sensorId: SENSOR_ID, hours: isAll? null : v, all: isAll })
    });
    if (!r.ok){
      const t = await r.text().catch(()=> "");
      throw new Error(`Serverfehler ${r.status}: ${t}`);
    }
    document.getElementById("wipeModal")?.close();
    await fetchSeries(currentRange);
    await openInfo();
    alert("Historie wurde zurückgesetzt.");
  }catch(e){
    console.error(e);
    alert(`Zurücksetzen fehlgeschlagen: ${e.message || e}`);
  }finally{
    btn.disabled = false; btn.textContent = old;
  }
});

// Löschen (mit UI-Reset)
async function deleteCurrentPlant(){
  if (!SENSOR_ID) { alert("Keine Pflanze ausgewählt."); return; }
  const displayName = plantProfile?.name || els.info_name?.textContent || SENSOR_ID;
  if (!confirm(`Wirklich löschen?\n"${displayName}" (ID: ${SENSOR_ID})`)) return;
  if (!confirm("Letzte Bestätigung: ALLE Daten dieser Pflanze werden gelöscht. Fortfahren?")) return;

  const btn = els.deletePlantBtn;
  const oldLabel = btn?.textContent;
  if (btn){ btn.disabled = true; btn.textContent = "Lösche…"; }

  const controller = new AbortController();
  const timeoutId = setTimeout(()=>controller.abort(), 10000);

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

    document.getElementById("infoModal")?.close();

    SENSOR_ID = null;
    localStorage.removeItem("sensorId");
    latest = null; config = null; lastSeenAt = null;
    resetLiveUI(); setSeries([]); plantProfile = null; fillInfoUI(); renderCalibSummary();

    await loadSensors();
    const first = els.plantList?.querySelector('.plant-item[data-id]');
    if (first){
      const newId = first.dataset.id;
      if (newId){
        SENSOR_ID = newId;
        localStorage.setItem("sensorId", newId);
        first.setAttribute('aria-selected','true');
        fetchSeries(currentRange);
        fetchPlant();
      }
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
els.deletePlantBtn?.addEventListener("click", deleteCurrentPlant);

// === Arduino Generator (lazy load) ===
async function openArduinoGenerator(){
  if (!window.ArduinoGen) {
    await (function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src; s.defer=true; s.onload=res; s.onerror=rej; document.head.appendChild(s); });})("/assets/arduino-gen.js");
  }
  window.ArduinoGen.open();
}
els.arduinoBtn?.addEventListener("click", openArduinoGenerator);

// ==== Robust button binding for Calibrate (direct + tiny delegation) ====
document.getElementById("calibBtn")?.addEventListener("click", (e)=>{
  e.preventDefault();
  openCalibModal();
});
document.addEventListener("click", (ev)=>{
  const hit = ev.target?.closest?.("#calibBtn");
  if (!hit) return;
  ev.preventDefault();
  openCalibModal();
}, { passive:false });

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
