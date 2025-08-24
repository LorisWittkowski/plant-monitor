const els = {
  fill: $('#fill'), value: $('#value'), raw: $('#raw'), ts: $('#timestamp'),
  liveDot: $('#liveDot'), status: $('#status'), sensorSelect: $('#sensorSelect'),
  sensorId: $('#sensorId'), sensorName: $('#sensorName'), useSensor: $('#useSensor'),
  refreshSensors: $('#refreshSensors'), saveName: $('#saveName'), token: $('#token'),
  saveToken: $('#saveToken'), dryInput: $('#dryInput'), wetInput: $('#wetInput'),
  useCurrentDry: $('#useCurrentDry'), useCurrentWet: $('#useCurrentWet'),
  saveCalib: $('#saveCalib'), resetCalib: $('#resetCalib'), history: $('#history'),
  sensorMeta: $('#sensorMeta'), configInfo: $('#configInfo'),
};
let state = {
  sensorId: localStorage.getItem('sensorId') || 'soil-1',
  token: localStorage.getItem('ingestToken') || '',
  lastOk: 0, latest: null, config: null
};
function $(s){ return document.querySelector(s); }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function cssVar(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function setAccent(p){
  const a = p<20 ? cssVar('--warn') : (p<60 ? cssVar('--accent') : cssVar('--wet'));
  document.documentElement.style.setProperty('--accent', a);
}
function updateBar(percent){
  const p = clamp(Number(percent||0), 0, 100);
  els.fill.style.width = p + '%';
  els.value.textContent = p.toFixed(0) + '%';
  setAccent(p);
}
function updateMeta(raw, ts){
  els.raw.textContent = (raw ?? '—');
  els.ts.textContent = ts ? new Date(ts).toLocaleString() : '—';
}
function updateLive(){
  const alive = (Date.now() - state.lastOk) < 10000;
  els.liveDot.classList.toggle('live', alive);
  els.status.textContent = alive ? 'live' : 'offline';
}

async function fetchSensors(){
  try {
    const r = await fetch('/api/sensors');
    const data = await r.json();
    els.sensorSelect.innerHTML = '';
    data.sensors.forEach(s=>{
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.name || s.id;
      els.sensorSelect.appendChild(o);
    });
    if (state.sensorId) els.sensorSelect.value = state.sensorId;
  } catch {}
}

async function fetchSoil(){
  try {
    const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(state.sensorId)}&limit=10`, { cache:'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    state.latest = data.latest; state.config = data.config; state.lastOk = Date.now();
    if (state.latest){
      updateBar(state.latest.percent ?? 0);
      updateMeta(state.latest.raw, state.latest.at);
    }
    els.sensorMeta.textContent = `${state.sensorId}${state.config && state.config.name ? ' · ' + state.config.name : ''}`;
    if (state.config && (Number.isFinite(state.config.rawDry) || Number.isFinite(state.config.rawWet))){
      els.configInfo.textContent =
        `Kalibrierung: DRY=${state.config.rawDry ?? '—'}, WET=${state.config.rawWet ?? '—'} (zuletzt: ${new Date(state.config.updatedAt).toLocaleString()})`;
      els.dryInput.value = state.config.rawDry ?? '';
      els.wetInput.value = state.config.rawWet ?? '';
      els.sensorName.value = state.config.name || '';
    } else {
      els.configInfo.textContent = 'Kalibrierung: —';
    }
    els.history.innerHTML = '';
    (data.history || []).forEach(it=>{
      const li = document.createElement('li');
      li.innerHTML = `<span>${new Date(it.at).toLocaleTimeString()}</span><span>${it.raw} RAW</span><span>${(it.percent??0).toFixed(0)}%</span>`;
      els.history.appendChild(li);
    });
  } catch {}
  updateLive();
}

// UI events
els.useSensor.onclick = ()=>{
  const fromSelect = els.sensorSelect.value;
  const manual = els.sensorId.value.trim();
  state.sensorId = manual || fromSelect || 'soil-1';
  localStorage.setItem('sensorId', state.sensorId);
  fetchSoil();
};
els.refreshSensors.onclick = fetchSensors;
els.saveToken.onclick = ()=>{ state.token = els.token.value; localStorage.setItem('ingestToken', state.token); };
els.saveName.onclick = async ()=>{
  if (!state.sensorId) return;
  const body = { sensorId: state.sensorId, name: els.sensorName.value || null, token: state.token };
  await fetch('/api/calibrate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  fetchSoil();
};
els.useCurrentDry.onclick = ()=>{ if (state.latest) els.dryInput.value = state.latest.raw; };
els.useCurrentWet.onclick = ()=>{ if (state.latest) els.wetInput.value = state.latest.raw; };
els.saveCalib.onclick = async ()=>{
  const body = { sensorId: state.sensorId, rawDry: num(els.dryInput.value), rawWet: num(els.wetInput.value), token: state.token };
  await fetch('/api/calibrate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  fetchSoil();
};
els.resetCalib.onclick = async ()=>{
  const body = { sensorId: state.sensorId, reset: true, token: state.token };
  await fetch('/api/calibrate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  els.dryInput.value = ''; els.wetInput.value = '';
  fetchSoil();
};
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

// init
els.token.value = state.token;
fetchSensors(); fetchSoil();
setInterval(fetchSoil, 3000);
setInterval(updateLive, 1000);
