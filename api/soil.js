import { kv } from "@vercel/kv";
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }
function toPercent(raw,dry,wet){ if(typeof dry!=='number'||typeof wet!=='number'||dry===wet) return null; const p = 100 * (raw - dry) / (wet - dry); return clamp(p,0,100); }
export default async function handler(req,res){
if(req.method==='GET'){
const sensorId = req.query.sensorId || null; const limit = Number(req.query.limit||10);
if(!sensorId){ const ids = await kv.smembers('soil:sensors'); const sensors=[]; for(const id of ids){ const latest = await kv.get(`soil:${id}:latest`); const cfg = await kv.get(`soil:${id}:config`); sensors.push({ id, name: cfg?.name||null, calibrated: !!(cfg?.rawDry!=null && cfg?.rawWet!=null), latest }); } return res.json({ sensors }); }
const latest = await kv.get(`soil:${sensorId}:latest`); const config = await kv.get(`soil:${sensorId}:config`); const history = await kv.lrange(`soil:${sensorId}:history`, 0, Math.max(0, limit-1)); const parsed = (history||[]).map(x=>JSON.parse(x)); return res.json({ sensorId, latest, config, history: parsed }); }
if(req.method==='POST'){
try{ const { sensorId, raw, token } = req.body || {}; if(!sensorId) return res.status(400).json({ error:'sensorId required' }); if(process.env.INGEST_TOKEN && token !== process.env.INGEST_TOKEN) return res.status(401).json({ error:'unauthorized' }); const r = Number(raw); if(!Number.isFinite(r)) return res.status(400).json({ error:'raw numeric required' }); await kv.sadd('soil:sensors', sensorId); const cfg = await kv.get(`soil:${sensorId}:config`); const percent = (cfg && cfg.rawDry!=null && cfg.rawWet!=null) ? toPercent(r, cfg.rawDry, cfg.rawWet) : null; const payload = { raw:r, percent: percent??null, at:new Date().toISOString() }; await kv.set(`soil:${sensorId}:latest`, payload); await kv.lpush(`soil:${sensorId}:history`, JSON.stringify(payload)); await kv.ltrim(`soil:${sensorId}:history`, 0, 99); return res.json({ ok:true }); }catch(e){ return res.status(500).json({ error:'server error' }); }
}
res.setHeader('Allow',['GET','POST']); res.status(405).end('Method Not Allowed');
}