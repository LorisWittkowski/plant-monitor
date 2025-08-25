// public/assets/app.js

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const els = {
  moisture: $("#moisture"),
  raw: $("#raw"),
  ts: $("#ts"),
  barFill: $("#bar-fill"),
  rangeBtns: $$(".range-btn"),
  pi_name: $("#pi_name"),
  pi_species: $("#pi_species"),
  pi_location: $("#pi_location"),
  pi_pot: $("#pi_pot"),
  pi_note: $("#pi_note"),
};

const API = "/api/soil";
const API_PLANT = "/api/plant";
const POLL_MS = 5000;
const RAW_MAX = 4095;
let latest = null;
let chart = null;
let currentRange = "1h";
let plantProfile = null;

// CSS var reader
function cssVar(name, fallback){
  return getComputedStyle(document.documentElement).getPropertyValue(name) || fallback;
}

// Format time
function fmtTime(s){
  return new Date(s).toLocaleString("de-DE",{day:"2-digit",month:"2-digit",year:"numeric",
    hour:"2-digit",minute:"2-digit",second:"2-digit"});
}

// ──────────────────────────────────────────────────────────────
// Auto-Resize für Textareas
// ──────────────────────────────────────────────────────────────
function autosize(el){
  if (!el) return;
  el.style.height = "auto";
  el.style.height = (el.scrollHeight + 2) + "px";
}
function bindAutosize(el){
  if (!el || el._autosizeBound) return;
  const handler = () => autosize(el);
  el.addEventListener("input", handler);
  window.addEventListener("resize", handler, { passive:true });
  if (document.fonts && document.fonts.ready){
    document.fonts.ready.then(handler).catch(()=>{});
  }
  el._autosizeBound = true;
  autosize(el);
}

// ──────────────────────────────────────────────────────────────
// Chart Init
// ──────────────────────────────────────────────────────────────
function initChart(){
  const ctx = document.getElementById("chart").getContext("2d");
  chart = new Chart(ctx,{
    type:"line",
    data:{
      labels:[],
      datasets:[{
        data:[],
        borderWidth:2,
        tension:0.35,
        fill:false,
        pointRadius:0,
        borderColor:() => cssVar('--fg-strong','#222'),
        clip:12 // Headroom gegen abgeschnittene Linien
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:{duration:350,easing:"easeOutCubic"},
      events:[],
      plugins:{
        legend:{display:false},
        tooltip:{enabled:false},
        decimation:{enabled:true,algorithm:"lttb",samples:120}
      },
      scales:{
        x:{display:false},
        y:{
          grid:{display:false},
          ticks:{display:false},
          border:{display:true,color:cssVar('--muted','#9a9a9b')}
        }
      },
      layout:{padding:{top:18,bottom:12,left:6,right:6}}
    }
  });
}

// ──────────────────────────────────────────────────────────────
// Chart Update
// ──────────────────────────────────────────────────────────────
function setSeries(points){
  let norm=(points||[])
    .map(p=>{
      const t=new Date(p.at||p.time||Date.now()).getTime();
      let y=null;
      if(typeof p.percent==="number") y=p.percent;
      else if(typeof p.raw==="number") y=(p.raw/RAW_MAX)*100;
      else if(typeof p.rawAvg==="number") y=(p.rawAvg/RAW_MAX)*100;
      return {t,y};
    })
    .filter(p=>Number.isFinite(p.t))
    .sort((a,b)=>a.t-b.t);

  if(norm.length===0 && latest){
    const t=new Date(latest.at).getTime();
    const y=(typeof latest.percent==="number")?latest.percent:(latest.raw/RAW_MAX)*100;
    norm.push({t,y});
  }

  const HARD_CAP=1200;
  const data=(norm.length>HARD_CAP)?norm.slice(-HARD_CAP):norm;

  chart.data.labels=data.map(d=>d.t);
  chart.data.datasets[0].data=data.map(d=>d.y);

  // Dynamische Y-Skalierung mit Puffer
  const vals=data.map(d=>d.y).filter(v=>typeof v==="number"&&isFinite(v));
  if(vals.length){
    const minV=Math.max(0,Math.min(...vals));
    const maxV=Math.min(100,Math.max(...vals));
    const spread=Math.max(2,maxV-minV);
    const pad=Math.max(3,spread*0.12); // mehr Luft
    chart.options.scales.y.min=Math.max(0,Math.floor((minV-pad)*10)/10);
    chart.options.scales.y.max=Math.min(100,Math.ceil((maxV+pad)*10)/10);
  } else {
    chart.options.scales.y.min=0;
    chart.options.scales.y.max=100;
  }

  const nonNull=vals.length;
  chart.data.datasets[0].pointRadius=(nonNull<2)?3:0;
  chart.options.plugins.decimation.enabled=(nonNull>=200);

  chart.update();
}

// ──────────────────────────────────────────────────────────────
// Fetch
// ──────────────────────────────────────────────────────────────
async function fetchSeries(range){
  try{
    const r=await fetch(`${API}?range=${encodeURIComponent(range)}`);
    const js=await r.json();
    latest=js.latest||null;
    setSeries(js.series||[]);
    fillLatest();
  }catch(e){console.error(e);}
}

async function pollLatest(){
  try{
    const r=await fetch(`${API}?range=1h`);
    const js=await r.json();
    latest=js.latest||null;
    setSeries(js.series||[]);
    fillLatest();
  }catch(e){console.error(e);}
}

// ──────────────────────────────────────────────────────────────
// UI
// ──────────────────────────────────────────────────────────────
function fillLatest(){
  if(!latest) return;
  const pct=(typeof latest.percent==="number")?latest.percent:null;
  if(els.moisture) els.moisture.textContent=pct!=null?`${pct.toFixed(0)}%`:"–";
  if(els.raw) els.raw.textContent=latest.raw??"–";
  if(els.ts) els.ts.textContent=fmtTime(latest.at);
  if(els.barFill){
    if(pct!=null){
      els.barFill.style.width=`${Math.min(100,Math.max(0,pct))}%`;
    } else els.barFill.style.width="0%";
  }
}

function fillInfoUI(){
  const p=plantProfile||{};
  if(els.pi_name) els.pi_name.value=p.name??"";
  if(els.pi_species) els.pi_species.value=p.species??"";
  if(els.pi_location) els.pi_location.value=p.location??"";
  if(els.pi_pot) els.pi_pot.value=(p.potCm!=null?String(p.potCm):"");
  if(els.pi_note){ els.pi_note.value=p.note??""; autosize(els.pi_note); }
}

// Save plant profile
async function savePlant(){
  const payload={
    name:els.pi_name?.value||"",
    species:els.pi_species?.value||"",
    location:els.pi_location?.value||"",
    potCm:parseInt(els.pi_pot?.value)||null,
    note:els.pi_note?.value||""
  };
  try{
    const r=await fetch(API_PLANT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(r.ok){ plantProfile=payload; fillInfoUI(); }
  }catch(e){console.error(e);}
}
async function fetchPlant(){
  try{
    const r=await fetch(API_PLANT);
    const js=await r.json();
    plantProfile=js||{};
    fillInfoUI();
  }catch(e){console.error(e);}
}

// ──────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────
(function init(){
  const savedRange=localStorage.getItem("range");
  if(savedRange&&["1h","24h","7d"].includes(savedRange)) currentRange=savedRange;
  initChart();
  fetchSeries(currentRange);
  fetchPlant();
  if(els.pi_note) bindAutosize(els.pi_note);
  setInterval(pollLatest,POLL_MS);
})();

els.rangeBtns.forEach(btn=>{
  btn.addEventListener("click",()=>{
    currentRange=btn.dataset.range;
    localStorage.setItem("range",currentRange);
    els.rangeBtns.forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    fetchSeries(currentRange);
  });
});

$("#plant-save")?.addEventListener("click",savePlant);
