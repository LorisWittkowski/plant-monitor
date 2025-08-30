// file: api/register.js
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

function normalizeId(s){ return (s||"").toString().trim().toLowerCase(); }
function isValidId(s){ return /^[a-z0-9][a-z0-9_-]{1,62}$/.test(s); }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(204).end();
  if (req.method!=="POST") { res.setHeader("Allow",["POST"]); return res.status(405).end("Method Not Allowed"); }

  const body = await readJson(req);
  let { sensorId, name } = body;
  sensorId = normalizeId(sensorId);

  if (!sensorId) return res.status(400).json({ error:"sensorId_required" });
  if (!isValidId(sensorId)) return res.status(400).json({ error:"sensorId_invalid", hint:"erlaubt: a-z 0-9 _ -" });

  const r = await redis();
  const existed = await r.sIsMember("soil:sensors", sensorId);
  await r.sAdd("soil:sensors", sensorId);

  if (typeof name === "string" && name.trim()){
    const keyProfile = `soil:${sensorId}:plant:profile`;
    const prevRaw = await r.get(keyProfile);
    const current = prevRaw ? JSON.parse(prevRaw) : {};
    current.name = name.trim();
    current.createdAt = current.createdAt || new Date().toISOString();
    current.updatedAt = new Date().toISOString();
    await r.set(keyProfile, JSON.stringify(current));
  }

  return res.json({ ok:true, existed: !!existed, sensorId });
}
