const RAW_MAX = 4095;           // UNO R4 (12-bit ADC)
const SENSOR_ID = "soil-1";     // fix (minimal)
const els = {
  fill: qs("#fill"), raw: qs("#raw"), ts: qs("#ts"), status: qs("#status")
};

function qs(s){ return document.querySelector(s); }
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }

function setBarByRaw(raw){
  const p = clamp((Number(raw) / RAW_MAX) * 100, 0, 100);
  els.fill.style.width = p.toFixed(1) + "%";
}

async function poll(){
  try{
    const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}`, { cache:"no-store" });
    if (r.status === 204){ els.status.textContent = "wartet…"; return; }
    if (!r.ok) { els.status.textContent = "error"; return; }
    const d = await r.json();
    els.raw.textContent = d.raw ?? "—";
    els.ts.textContent  = d.at ? new Date(d.at).toLocaleString() : "—";
    setBarByRaw(d.raw ?? 0);
    els.status.textContent = "live";
  } catch {
    els.status.textContent = "offline";
  }
}

poll();
setInterval(poll, 3000);
