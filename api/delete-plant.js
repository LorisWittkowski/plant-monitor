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

// Hilfsfunktion: große Arrays in kleineren Blöcken löschen
async function delChunks(client, keys, size=256){
  for (let i=0; i<keys.length; i+=size){
    const slice = keys.slice(i, i+size);
    if (slice.length) await client.del(slice);
  }
}

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(204).end();
  if (req.method!=="POST") { res.setHeader("Allow",["POST"]); return res.status(405).end("Method Not Allowed"); }

  try{
    const { sensorId } = await readJson(req);
    const id = (sensorId || "").toString().trim();
    if (!id) return res.status(400).json({ error:"sensorId_required" });

    const r = await redis();

    // bekannte Schlüssel
    const fixed = [
      `soil:${id}:latest`,
      `soil:${id}:history`,
      `soil:${id}:config`,
      `soil:${id}:agg10m`,
      `soil:${id}:agg10m:curWindow`,
      `soil:${id}:agg10m:sum`,
      `soil:${id}:agg10m:cnt`,
      `soil:${id}:plant:profile`,
      `soil:${id}:notes`,
    ];

    // alle Keys mit Prefix via SCAN einsammeln (node-redis v4: {cursor, keys})
    const extra = [];
    let cursor = "0";
    const pattern = `soil:${id}:*`;
    do {
      const { cursor: next, keys } = await r.scan(cursor, { MATCH: pattern, COUNT: 200 });
      cursor = next;
      for (const k of keys) if (!fixed.includes(k)) extra.push(k);
    } while (cursor !== "0");

    const toDelete = [...new Set([...fixed, ...extra])];

    // sicher löschen (in Blöcken)
    await delChunks(r, toDelete, 256);
    await r.sRem("soil:sensors", id);

    return res.json({ ok:true, deletedKeys: toDelete.length });
  } catch (err) {
    console.error("delete-plant failed:", err);
    // gib eine lesbare Fehlermeldung zurück, damit du sie im Frontend siehst
    return res.status(500).send(String(err && err.stack || err));
  }
}
