import { createClient } from "redis";

// Redis-Client einmalig pro Lambda-Container initialisieren (Serverless-sicher)
let redisPromise;
function getRedis() {
  if (!redisPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (err) => console.error("Redis error:", err));
    redisPromise = client.connect().then(() => client);
  }
  return redisPromise;
}

// robuster JSON-Parser (kompatibel mit ArduinoHttpClient)
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export default async function handler(req, res) {
  // CORS (praktisch fürs Debuggen)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sensorId = (req.query.sensorId || "soil-1").toString();
  const keyLatest = `soil:${sensorId}:latest`;

  const redis = await getRedis();

  if (req.method === "GET") {
    const raw = await redis.get(keyLatest);
    if (!raw) return res.status(204).end(); // noch keine Daten
    return res.status(200).json(JSON.parse(raw));
  }

  if (req.method === "POST") {
    const { raw, token } = await readJson(req);

    if (process.env.INGEST_TOKEN && token !== process.env.INGEST_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const r = Number(raw);
    if (!Number.isFinite(r)) return res.status(400).json({ error: "raw numeric required" });

    const payload = { raw: r, at: new Date().toISOString() };
    await redis.set(keyLatest, JSON.stringify(payload));
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end("Method Not Allowed");
}
