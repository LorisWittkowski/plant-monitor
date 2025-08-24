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
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end("Method Not Allowed");
  }

  const { sensorId = "soil-1", rawDry, rawWet, name, reset, token } = await readJson(req);

  if (process.env.INGEST_TOKEN && token !== process.env.INGEST_TOKEN) {
    return res.status(401).json({ error: "unauthorized_token" });
  }

  const r = await redis();
  const keyConfig = `soil:${sensorId}:config`;

  if (reset) {
    await r.del(keyConfig);
    return res.status(200).json({ ok: true, reset: true });
  }

  const prev = (await r.get(keyConfig)) ? JSON.parse(await r.get(keyConfig)) : {};
  const cfg = {
    rawDry: Number.isFinite(rawDry) ? rawDry : (prev.rawDry ?? null),
    rawWet: Number.isFinite(rawWet) ? rawWet : (prev.rawWet ?? null),
    name:   typeof name === "string" ? name : (prev.name ?? null),
    updatedAt: new Date().toISOString()
  };

  await r.set(keyConfig, JSON.stringify(cfg));
  return res.status(200).json({ ok: true, config: cfg });
}
