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

function checkAdmin(req) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = req.headers["x-admin-token"] || req.headers["x-admin"];
  return got === need;
}

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, X-Admin-Token, X-Admin");
  if (req.method==="OPTIONS") return res.status(204).end();
  if (req.method!=="POST") { res.setHeader("Allow",["POST"]); return res.status(405).end("Method Not Allowed"); }
  if (!checkAdmin(req)) return res.status(401).json({ error:"unauthorized" });

  const { sensorId } = await readJson(req);
  const id = (sensorId || "").toString().trim();
  if (!id) return res.status(400).json({ error:"sensorId_required" });

  const r = await redis();

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

  const extra = [];
  let cursor = "0";
  const pattern = `soil:${id}:*`;
  do {
    const [next, batch] = await r.scan(cursor, { MATCH: pattern, COUNT: 200 });
    cursor = next;
    for (const k of batch) if (!fixed.includes(k)) extra.push(k);
  } while (cursor !== "0");

  const toDelete = [...new Set([...fixed, ...extra])];
  if (toDelete.length) await r.del(toDelete);
  await r.sRem("soil:sensors", id);

  return res.json({ ok:true, deletedKeys: toDelete.length });
}
