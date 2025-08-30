// file: api/plant-stats.js
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

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(204).end();
  if (req.method!=="GET") { res.setHeader("Allow",["GET"]); return res.status(405).end("Method Not Allowed"); }

  // Case beibehalten (kein .toLowerCase())
  const sensorId = (req.query.sensorId || "").toString().trim();
  if (!sensorId) return res.status(400).json({ error:"sensorId_required" });

  const r = await redis();

  const keyLatest = `soil:${sensorId}:latest`;
  const keyHistory = `soil:${sensorId}:history`;
  const keyAgg10   = `soil:${sensorId}:agg10m`;
  const keyConfig  = `soil:${sensorId}:config`;
  const keyProfile = `soil:${sensorId}:plant:profile`;
  const keyNotes   = `soil:${sensorId}:notes`;

  const [profileRaw, latestStr, cfgStr, histLen, aggLen, notesLen] = await Promise.all([
    r.get(keyProfile),
    r.get(keyLatest),
    r.get(keyConfig),
    r.lLen(keyHistory),
    r.lLen(keyAgg10),
    r.lLen(keyNotes),
  ]);

  const [histItems, aggItems, notesItems] = await Promise.all([
    histLen ? r.lRange(keyHistory, 0, Math.max(0, histLen-1)) : [],
    aggLen  ? r.lRange(keyAgg10, 0, Math.max(0, aggLen-1))   : [],
    notesLen? r.lRange(keyNotes, 0, Math.max(0, notesLen-1)) : [],
  ]);

  const sizeOf = (s)=> (s ? Buffer.byteLength(s, "utf8") : 0);
  const bytes = {
    latest: sizeOf(latestStr),
    config: sizeOf(cfgStr),
    profile: sizeOf(profileRaw),
    history: histItems.reduce((n,s)=> n + sizeOf(s), 0),
    agg10m:  aggItems.reduce((n,s)=> n + sizeOf(s), 0),
    notes:   notesItems.reduce((n,s)=> n + sizeOf(s), 0),
  };
  bytes.total = Object.values(bytes).reduce((a,b)=>a+b,0);

  const profile = profileRaw ? JSON.parse(profileRaw) : null;

  res.json({
    sensorId,
    profile: profile ? {
      name: profile.name || null,
      createdAt: profile.createdAt || null,
      updatedAt: profile.updatedAt || null,
    } : null,
    counts: { history: histLen||0, agg10m: aggLen||0, notes: notesLen||0 },
    bytes
  });
}
