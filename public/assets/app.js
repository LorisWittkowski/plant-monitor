// Config
const POLL_MS = 3000;
const RAW_MAX = 4095;
const SENSOR_ID = "soil-1";
const DEFAULT_RANGE = "1h"; // 1h | 24h | 7d

// State
let latest = null, config = null, lastSeenAt = null, currentDisplayedPercent = null;
let currentRange = DEFAULT_RANGE;
let plantProfile = null, notes = [];

// DOM
const $ = s => document.querySelector(s);
const els = {
  // live
  value: $("#value"), raw: $("#raw"), ts: $("#ts"), fill: $("#fill"),
  chart: $("#chart"),
  // header
  calibBtn: $("#calibBtn"), themeToggle: $("#themeToggle"), themeIcon: $("#themeIcon"),
  // calibration
  modal: $("#calibModal"), dryInput: $("#dryInput"), wetInput: $("#wetInput"),
  useDryNow: $("#useDryNow"), useWetNow: $("#useWetNow"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"), saveCalib: $("#saveCalib"),
  resetCalib: $("#resetCalib"),
  // plant info
  pi_name: $("#pi_name"), pi_species: $("#pi_species"), pi_location: $("#pi_location"), pi_pot: $("#pi_pot"), pi_note: $("#pi_note"),
  saveInfo: $("#saveInfo"),
  // notes
  noteText: $("#noteText"), addNote: $("#addNote"), notesList: $("#notesList"),
};

// Theme
(function initTheme(){
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  $("#themeIcon").textContent = theme === "dark" ? "☾" : "☼";
})();
els.themeToggle.onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  $("#themeIcon").textContent = next === "dark" ? "☾" : "☼";
};

// Helpers
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

// Live UI
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

// Chart
let chart;
function cssVar(name, fallback){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
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
          const fg = cssVar('--fg','rgb(242,242,243)');
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
          min: 0, max: 100, grid: { display: false },
          ticks: {
            color: cssVar('--muted','#9a9a9b'),
            callback: v => v===0 ? "DRY" : v===100 ? "WET" : "",
            font: { size: 12 }
          },
          border: { display: true, color: cssVar('--muted','#9a9a9b') }
        }
      },
      plugins: { legend: { display:false }, tooltip: { enabled:false } },
      layout: { padding: 6 }
    }
  });
}
function setSeries(points){
  const data = points.map(p => p.percent ?? (p.raw/RAW_MAX*100));
  chart.data.labels = data.map((_,i)=>i);
  chart.data.datasets[0].data = data;
  chart.update();
}

// Fetch series by range
async function fetchSeries(range){
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=${encodeURIComponent(range)}`, { cache:"no-store" });
  if (r.status===204) { setSeries([]); return; }
  const data = await r.json();
  config = data.config || null;
  latest = data.latest || null;
  if (latest) updateLive(latest.raw, latest.at);
  setSeries(data.series || []);
}

// Poll latest for live value (independent of range)
async function pollLatest(){
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=latest`, { cache:"no-store" });
  if (r.status!==200) return;
  const data = await r.json();
  const nowAt = data.latest?.at;
  if (nowAt && nowAt !== lastSeenAt) {
    lastSeenAt = nowAt;
    config = data.config || config;
    latest  = data.latest;
    updateLive(latest.raw, latest.at);
    // auch Graph live updaten (rechter Rand)
    await fetchSeries(currentRange);
  }
}

// Range buttons
document.querySelectorAll('.range .btn').forEach(b=>{
  b.onclick = async ()=>{ currentRange = b.dataset.range; await fetchSeries(currentRange); };
});

// Plant info
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

// Notes
function renderNotes(){
  els.notesList.innerHTML = "";
  (notes || []).forEach(n=>{
    const li = document.createElement("li");
    li.innerHTML = `<span>${n.text}<span class="meta"> · ${new Date(n.at).toLocaleString()}</span></span>
                    <button class="del" data-id="${n.id}">Löschen</button>`;
    els.notesList.appendChild(li);
  });
  els.notesList.querySelectorAll('.del').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.dataset.id;
      const r = await fetch(`/api/notes?sensorId=${encodeURIComponent(SENSOR_ID)}&id=${encodeURIComponent(id)}`, { method:"DELETE" });
      if (r.ok) { await fetchNotes(); } else alert("Löschen fehlgeschlagen.");
    };
  });
}
async function fetchNotes(){
  const r = await fetch(`/api/notes?sensorId=${encodeURIComponent(SENSOR_ID)}`, { cache:"no-store" });
  if (r.status===204){ notes=[]; renderNotes(); return; }
  const data = await r.json();
  notes = data.notes || [];
  renderNotes();
}
async function addNote(){
  const text = els.noteText.value.trim();
  if (!text) return;
  const r = await fetch("/api/notes", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ sensorId: SENSOR_ID, text }) });
  if (r.ok){ els.noteText.value=""; await fetchNotes(); } else alert("Notiz konnte nicht gespeichert werden.");
}

// Calibration
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

// Events
els.saveInfo.onclick = savePlantProfile;
els.addNote.onclick = addNote;

// Init
initChart();
fetchSeries(currentRange);
setInterval(pollLatest, POLL_MS);
fetchPlant();
fetchNotes();
