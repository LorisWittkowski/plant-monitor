// file: api/delete-plant.js
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

async function deleteKeysChunked(r, keys, chunk=256){
  if (!keys || !keys.length) return 0;
  let deleted = 0;
  const hasUnlink = typeof r.unlink === "function";
  for (let i=0; i<keys.length; i+=chunk){
    const slice = keys.slice(i, i+chunk);
    if (!slice.length) continue;
    try {
      deleted += hasUnlink ? await r.unlink(...slice) : await r.del(...slice);
    } catch {
      for (const k of slice){ try { deleted += hasUnlink ? await r.unlink(k) : await r.del(k); } catch{} }
    }
  }
  return deleted;
}

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") { res.setHeader("Allow",["POST"]); return res.status(405).end("Method Not Allowed"); }

  try {
    const { sensorId } = await readJson(req);
    const id = (sensorId || "").toString().trim();
    if (!id) return res.status(400).json({ error:"sensorId_required" });

    const r = await redis();

    const keys = [];
    for await (const key of r.scanIterator({ MATCH: `soil:${id}:*`, COUNT: 500 })) keys.push(key);
    [
      `soil:${id}:latest`,
      `soil:${id}:history`,
      `soil:${id}:config`,
      `soil:${id}:agg10m`,
      `soil:${id}:agg10m:curWindow`,
      `soil:${id}:agg10m:sum`,
      `soil:${id}:agg10m:cnt`,
      `soil:${id}:plant:profile`,
      `soil:${id}:notes`,
    ].forEach(k => keys.push(k));

    const allKeys = Array.from(new Set(keys));
    const deleted = await deleteKeysChunked(r, allKeys, 256);
    await r.sRem("soil:sensors", id);

    return res.status(200).json({ ok:true, sensorId:id, scanned: allKeys.length, deleted });
  } catch (err) {
    console.error("delete-plant failed:", err);
    return res.status(500).send(String(err && (err.stack || err.message) || err));
  }
}
