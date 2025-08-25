// ---- Config ----
const POLL_MS = 3000;
const RAW_MAX = 4095;
const MAX_POINTS = 180;
const FETCH_LIMIT = 360;
const SENSOR_ID = "soil-1";

// ---- State ----
let latest = null, config = null, lastSeenAt = null, currentDisplayedPercent = null;
let plantProfile = null, careLog = [];

// ---- DOM ----
const $ = s => document.querySelector(s);
const els = {
  value: $("#value"), raw: $("#raw"), ts: $("#ts"), fill: $("#fill"),
  chart: $("#chart"),
  calibBtn: $("#calibBtn"), modal: $("#calibModal"),
  dryInput: $("#dryInput"), wetInput: $("#wetInput"),
  useDryNow: $("#useDryNow"), useWetNow: $("#useWetNow"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"), saveCalib: $("#saveCalib"),
  resetCalib: $("#resetCalib"), themeToggle: $("#themeToggle"), themeIcon: $("#themeIcon"),
  // plant info
  pi_name: $("#pi_name"), pi_species: $("#pi_species"), pi_location: $("#pi_location"), pi_pot: $("#pi_pot"), pi_note: $("#pi_note"),
  saveInfo: $("#saveInfo"), addLog: $("#addLog"), logList: $("#logList"),
  logModal: $("#logModal"), log_action: $("#log_action"), log_amount: $("#log_amount"), log_note: $("#log_note"), saveLog: $("#saveLog")
};

// ---- Theme ----
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
};

// ---- Helpers ----
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const asPercent = raw => {
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet)
    return clamp((raw/RAW_MAX)*100,0,100);
  return clamp(100*(raw - config.rawDry)/(config.rawWet - config.rawDry),0,100);
};
const tweenValue = (from,to,ms=500) => {
  const start = performance.now();
  const step = t => {
    const k = Math.min(1,(t-start)/ms);
    const v = Math.round(from + (to-from)*k);
    els.value.textContent = v + "%";
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

// ---- Live UI ----
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

// ---- Chart ----
let chart;
function getCssVar(name, fallback){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
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
      segment: {
        borderColor: ctx => {
          const total = ctx.chart.data.datasets[0].data.length || 1;
          const i = ctx.p0DataIndex ?? 0;
          const fade = 0.2 + 0.8*(i/total);
          const fg = getCssVar('--fg', 'rgb(242,242,243)');
          if (fg.startsWith('rgb(')) return fg.replace('rgb','rgba').replace(')',`,`+fade+`)`);
          return `rgba(242,242,243,${fade})`;
        }
      }
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 500, easing: "easeOutCubic" },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 100,
          grid: { display: false },
          ticks: {
            color: getCssVar('--muted', '#9a9a9b'),
            callback: v => v===0 ? "DRY" : v===100 ? "WET" : "",
            font: { size: 12 }
          },
          border: { display: true, color: getCssVar('--muted', '#9a9a9b') }
        }
      },
      plugins: { legend: { display:false }, tooltip: { enabled:false } },
      layout: { padding: 6 }
    }
  });
}
function setSeries(percents){
  const capped = percents.slice(-MAX_POINTS);
  chart.data.labels = capped.map((_,i)=>i);
  chart.data.datasets[0].data = capped;
  chart.update();
}
function pushValue(percent){
  const ds = chart.data.datasets[0];
  ds.data.push(percent);
  if (ds.data.length > MAX_POINTS) ds.data.shift();
  chart.data.labels = ds.data.map((_,i)=>i);
  chart.update();
}

// ---- Data Fetch ----
async function fetchSoil(){
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&limit=${FETCH_LIMIT}`, { cache: "no-store" });
  if (r.status === 204) return;
  const data = await r.json();
  latest = data.latest; config = data.config || null;

  if (!lastSeenAt) {
    const hist = Array.isArray(data.history) ? data.history : [];
    const percents = (hist.length ? hist : [latest]).map(h => (h.percent!=null ? h.percent : clamp((h.raw/RAW_MAX)*100,0,100)));
    setSeries(percents);
  }

  if (lastSeenAt !== latest.at) {
    lastSeenAt = latest.at;
    const p = asPercent(latest.raw);
    pushValue(p);
    updateLive(latest.raw, latest.at);
  }
}

// ---- Plant Info (profile + care log) ----
function fillInfoUI(){
  const p = plantProfile || {};
  els.pi_name.value = p.name || "";
  els.pi_species.value = p.species || "";
  els.pi_location.value = p.location || "";
  els.pi_pot.value = p.potCm ?? "";
  els.pi_note.value = p.note || "";
}
function renderLog(){
  els.logList.innerHTML = "";
  (careLog || []).slice(0,8).forEach(item => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${new Date(item.at).toLocaleDateString()} · ${item.action}${item.amount? " ("+item.amount+")":""}</span><span>${item.note||""}</span>`;
    els.logList.appendChild(li);
  });
}
async function fetchPlant(){
  const r = await fetch(`/api/plant?sensorId=${encodeURIComponent(SENSOR_ID)}`, { cache:"no-store" });
  if (r.status===204) { plantProfile=null; careLog=[]; fillInfoUI(); renderLog(); return; }
  const data = await r.json();
  plantProfile = data.profile || null;
  careLog = data.careLog || [];
  fillInfoUI();
  renderLog();
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
  if (r.ok) { await fetchPlant(); } else { alert("Speichern fehlgeschlagen."); }
}
async function saveCareLog(){
  const body = {
    sensorId: SENSOR_ID,
    log: {
      action: els.log_action.value.trim() || "Aktion",
      amount: els.log_amount.value.trim() || "",
      note: els.log_note.value.trim() || ""
    }
  };
  const r = await fetch("/api/plant", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  if (r.ok) { els.logModal.close(); els.log_action.value=""; els.log_amount.value=""; els.log_note.value=""; await fetchPlant(); }
  else { alert("Log-Eintrag fehlgeschlagen."); }
}

// ---- Calibration (unchanged logic, polished modal already) ----
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
  if(resp.ok){els.modal.close();lastSeenAt=null;await fetchSoil();} else alert("Kalibrierung fehlgeschlagen.");
};
els.resetCalib.onclick = async()=>{
  if(!confirm("Kalibrierung zurücksetzen?"))return;
  await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,reset:true})});
  lastSeenAt=null;await fetchSoil();
};

// ---- Events for Plant info ----
els.saveInfo.onclick = savePlantProfile;
els.addLog.onclick = () => els.logModal.showModal();
els.saveLog.onclick = saveCareLog;

// ---- Init ----
initChart();
fetchSoil(); setInterval(fetchSoil, POLL_MS);
fetchPlant();
