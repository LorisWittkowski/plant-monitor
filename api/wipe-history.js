// file: api/wipe-history.js
import { createClient } from "redis";

let redisP;
function redis() {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL missing");
  if (!redisP) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (e) => console.error("Redis error:", e));
    redisP = client.connect().then(() => client);
  }
  return redisP;
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks=[]; for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
const parseISO = t => { const n = Date.parse(t); return Number.isFinite(n) ? n : null; };

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") { res.setHeader("Allow",["POST"]); return res.status(405).end("Method Not Allowed"); }

  try{
    const { sensorId, hours, all } = await readJson(req);
    const id = (sensorId || "").toString().trim();
    if (!id) return res.status(400).json({ error:"sensorId_required" });

    const r = await redis();
    const keyHistory = `soil:${id}:history`;
    const keyAgg10m  = `soil:${id}:agg10m`;
    const keyCurWin  = `soil:${id}:agg10m:curWindow`;
    const keySum     = `soil:${id}:agg10m:sum`;
    const keyCnt     = `soil:${id}:agg10m:cnt`;

    // "Alle Daten" löschen
    if (all === true || Number(hours) === 25) {
      await Promise.all([ r.del(keyHistory), r.del(keyAgg10m), r.del(keyCurWin), r.del(keySum), r.del(keyCnt) ]);
      return res.json({ ok:true, mode:"all" });
    }

    // Teilweise löschen: älter als X Stunden (1..24)
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 1 || h > 24) return res.status(400).json({ error:"hours_between_1_and_24_required" });
    const cutoff = Date.now() - h*60*60*1000;

    // History neu aufbauen
    const histList = await r.lRange(keyHistory, 0, 20000);
    const histKept = [];
    for (const s of histList) { try { const p=JSON.parse(s); const t=parseISO(p.at); if (t!=null && t>=cutoff) histKept.push(p); } catch{} }
    histKept.sort((a,b)=> parseISO(b.at)-parseISO(a.at));

    // Agg10m neu aufbauen
    const aggList = await r.lRange(keyAgg10m, 0, 50000);
    const aggKept = [];
    for (const s of aggList) { try { const p=JSON.parse(s); const t=parseISO(p.at); if (t!=null && t>=cutoff) aggKept.push(p); } catch{} }
    aggKept.sort((a,b)=> parseISO(b.at)-parseISO(a.at));

    // Atomar ersetzen
    const multi = r.multi();
    multi.del(keyHistory); multi.del(keyAgg10m);
    if (histKept.length){ for (const p of histKept) multi.lPush(keyHistory, JSON.stringify(p)); multi.lTrim(keyHistory,0,4000); }
    if (aggKept.length){ for (const p of aggKept) multi.lPush(keyAgg10m, JSON.stringify(p)); multi.lTrim(keyAgg10m,0,5000); }
    await multi.exec();

    return res.json({ ok:true, mode:"olderThan", hours:h, kept:{ history: histKept.length, agg10m: aggKept.length } });
  }catch(err){
    console.error("wipe-history failed:", err);
    return res.status(500).send(String(err && (err.stack || err.message) || err));
  }
}
