const POLL_MS = 3000;
const RAW_MAX = 4095;
const MAX_POINTS = 100;
const SENSOR_ID = "soil-1";

let latest = null, config = null;
let lastSeenAt = null;

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
const bump = el => { el.classList.add("bump"); setTimeout(()=>el.classList.remove("bump"),200); };
const asPercent = (raw)=>{
  if (!config || config.rawDry==null || config.rawWet==null || config.rawDry===config.rawWet) {
    return clamp((raw/RAW_MAX)*100,0,100);
  }
  return clamp(100*(raw - config.rawDry)/(config.rawWet - config.rawDry),0,100);
};

// Live UI
function updateLive(raw, atIso){
  const p = asPercent(raw);
  els.fill.style.width = p.toFixed(1) + "%";
  els.value.textContent = Math.round(p) + "%";
  els.raw.textContent = raw;
  els.ts.textContent = new Date(atIso).toLocaleString();
  bump(els.value);
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
        borderColor: ctx => {
          const total = ctx.chart.data.datasets[0].data.length || 1;
          const i = ctx.p0DataIndex;
          const fade = 0.2 + 0.8*(i/total);
          const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || "rgb(242,242,243)";
          if(fg.startsWith("rgb(")) {
            return fg.replace("rgb","rgba").replace(")",`,`+fade+`)`);
          }
          return fg;
        }
      }
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 600, easing: "easeOutCubic" },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 100,
          grid: { display: false },
          ticks: {
            color: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(),
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

function pushValue(percent){
  const ds = chart.data.datasets[0];
  ds.data.push(percent);
  if (ds.data.length > MAX_POINTS) ds.data.shift();
  chart.update();
}

// Fetch & Poll
async function fetchSoil(){
  const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&limit=${MAX_POINTS}`, { cache: "no-store" });
  if (r.status === 204) return;
  const data = await r.json();
  latest = data.latest; config = data.config || null;
  const at = latest.at;

  if (!lastSeenAt && Array.isArray(data.history)) {
    const hist = data.history;
    const percents = hist.map(h => (h.percent!=null ? h.percent : (h.raw/RAW_MAX*100)));
    chart.data.datasets[0].data = percents.slice(-MAX_POINTS);
    chart.update();
  }

  if (lastSeenAt !== at) {
    lastSeenAt = at;
    const p = asPercent(latest.raw);
    pushValue(p);
    updateLive(latest.raw, latest.at);
  }
}

initChart();
fetchSoil();
setInterval(fetchSoil, POLL_MS);

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
  if(resp.ok){els.modal.close();lastSeenAt=null;await fetchSoil();} else alert("Kalibrierung fehlgeschlagen.");
};
els.resetCalib.onclick = async()=>{
  if(!confirm("Kalibrierung zurücksetzen?"))return;
  await fetch("/api/calibrate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sensorId:SENSOR_ID,reset:true})});
  lastSeenAt=null;await fetchSoil();
};
