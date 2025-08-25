const POLL_MS = 3000;
const RAW_MAX = 4095;
const MAX_POINTS = 120;          // so viel zeigen
const FETCH_LIMIT = 300;         // so viel vom Server holen (wir capen auf MAX_POINTS)
const SENSOR_ID = "soil-1";

let latest = null, config = null;
let lastSeenAt = null;
let currentDisplayedPercent = null; // für Counter-Animation

// DOM
const $ = s => document.querySelector(s);
const els = {
  value: $("#value"), raw: $("#raw"), ts: $("#ts"), fill: $("#fill"),
  chart: $("#chart"), calibBtn: $("#calibBtn"),
  modal: $("#calibModal"), dryInput: $("#dryInput"), wetInput: $("#wetInput"),
  useDryNow: $("#useDryNow"), useWetNow: $("#useWetNow"),
  prevStep: $("#prevStep"), nextStep: $("#nextStep"), saveCalib: $("#saveCalib"),
  resetCalib: $("#resetCalib"), themeToggle: $("#themeToggle"), themeIcon: $("#themeIcon")
};

// Theme Toggle
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

// Helpers
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const asPercent = (raw)=>{
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet) {
    return clamp((raw/RAW_MAX)*100,0,100);
  }
  return clamp(100*(raw - config.rawDry)/(config.rawWet - config.rawWet),0,100); // (Bugfix: rawWet - rawWet? Nein:) 
};
// ↑ Korrektur: Tippfehler fixen:
function calcPercent(raw){
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet) {
    return clamp((raw/RAW_MAX)*100,0,100);
  }
  return clamp(100*(raw - config.rawDry)/(config.rawWet - config.rawDry),0,100);
}

// Counter-Tween (Design Upgrade #1)
function tweenValue(from, to, ms = 500){
  const start = performance.now();
  function frame(t){
    const k = Math.min(1, (t - start)/ms);
    const val = Math.round(from + (to - from)*k);
    els.value.textContent = val + "%";
    if (k < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Live UI update
function updateLive(raw, atIso){
  const p = calcPercent(raw);
  // progressbar
  els.fill.style.width = p.toFixed(1) + "%";
  // counter animation
  if (currentDisplayedPercent == null) {
    els.value.textContent = Math.round(p) + "%";
  } else if (Math.abs(currentDisplayedPercent - p) >= 1) {
    tweenValue(Math.round(currentDisplayedPercent), Math.round(p));
  } else {
    els.value.textContent = Math.round(p) + "%";
  }
  currentDisplayedPercent = p;
  // meta
  els.raw.textContent = raw;
  els.ts.textContent = new Date(atIso).toLocaleString();
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
      segment: {
        borderColor: segColorWithFade
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
            color: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || "#9a9a9b",
            callback: val => val===0 ? "DRY" : val===100 ? "WET" : "",
            font: { size: 12 }
          },
          border: { display: true, color: "var(--muted)" }
        }
      },
      plugins: { legend: { display:false }, tooltip: { enabled:false } },
      layout: { padding: 6 }
    }
  });
}

// Segment color with left fade
function segColorWithFade(ctx){
  const ds = ctx.chart?.data?.datasets?.[0];
  const total = ds?.data?.length || 1;
  const i = ctx.p0DataIndex ?? 0;
  const fade = 0.2 + 0.8*(i/total);
  // get current theme --fg as rgb/hex
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || "rgb(242,242,243)";
  if (fg.startsWith("rgb(")) return fg.replace("rgb","rgba").replace(")",`,`+fade+`)`);
  // hex → rgba fallback
  if (/^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(fg)) {
    const c = fg.length===4
      ? fg.replace(/^#(.)(.)(.)$/i,(m,r,g,b)=>`#${r}${r}${g}${g}${b}${b}`)
      : fg;
    const r = parseInt(c.substr(1,2),16), g = parseInt(c.substr(3,2),16), b = parseInt(c.substr(5,2),16);
    return `rgba(${r},${g},${b},${fade})`;
  }
  return "rgba(242,242,243,"+fade+")";
}

// Robust chart data setting
function setSeries(percents){
  const capped = percents.slice(-MAX_POINTS);
  const labels = capped.map((_,i)=>i); // eindeutige x-Indexlabels
  const ds = chart.data.datasets[0];
  chart.data.labels = labels;
  ds.data = capped;
  chart.update();
}

function pushValue(percent){
  const ds = chart.data.datasets[0];
  ds.data.push(percent);
  if (ds.data.length > MAX_POINTS) ds.data.shift();
  chart.data.labels = ds.data.map((_,i)=>i);
  chart.update();
}

// Fetch & Poll (Graph-Fix: sichere Initialbefüllung + großzügiges Limit)
async function fetchSoil(){
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&limit=${FETCH_LIMIT}`, { cache: "no-store" });
  if (r.status === 204) return;
  const data = await r.json();
  latest = data.latest; config = data.config || null;

  // Initial: Historie setzen (falls vorhanden)
  if (!lastSeenAt) {
    const hist = Array.isArray(data.history) ? data.history : [];
    if (hist.length > 0) {
      const percents = hist.map(h => (h.percent!=null ? h.percent : clamp((h.raw/RAW_MAX)*100,0,100)));
      setSeries(percents);
    } else {
      // Keine Historie? dann mit aktuellem Wert starten, damit der Graph nicht leer wirkt
      const p = calcPercent(latest.raw);
      setSeries([p]);
    }
  }

  // Neuer Wert?
  if (lastSeenAt !== latest.at) {
    lastSeenAt = latest.at;
    const p = calcPercent(latest.raw);
    pushValue(p);
    updateLive(latest.raw, latest.at);
  }
}

// Init
initChart();
fetchSoil();
setInterval(fetchSoil, POLL_MS);

// Calibration (2 Steps)
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
