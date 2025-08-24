// api/soil.js
import { createClient } from "redis";

// Redis client singleton
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

// robust JSON parser (Arduino-safe)
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function toPercent(raw, dry, wet) {
  if (typeof dry !== "number" || typeof wet !== "number" || dry === wet) return null;
  const p = 100 * (raw - dry) / (wet - dry);
  return clamp(p, 0, 100);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sensorId = (req.query.sensorId || "soil-1").toString();
  const limit = Number(req.query.limit || 60); // letzte 60 Einträge
  const keyLatest  = `soil:${sensorId}:latest`;
  const keyHistory = `soil:${sensorId}:history`;
  const keyConfig  = `soil:${sensorId}:config`;

  const r = await redis();

  if (req.method === "GET") {
    const [latestRaw, cfgRaw, list] = await Promise.all([
      r.get(keyLatest),
      r.get(keyConfig),
      r.lRange(keyHistory, 0, Math.max(0, limit - 1)) // ⬅️ camelCase
    ]);
    if (!latestRaw) return res.status(204).end();

    const latest = JSON.parse(latestRaw);
    const config = cfgRaw ? JSON.parse(cfgRaw) : null;
    const history = (list || []).map(s => JSON.parse(s)).reverse(); // ältestes→neu
    return res.status(200).json({ sensorId, latest, config, history });
  }

  if (req.method === "POST") {
    const { sensorId: sid, raw, token } = await readJson(req);
    const id = (sid || sensorId).toString();

    if (process.env.INGEST_TOKEN && token !== process.env.INGEST_TOKEN) {
      return res.status(401).json({ error: "unauthorized_token" });
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return res.status(422).json({ error: "raw_numeric_required" });
    }

    const cfgRaw = await r.get(`soil:${id}:config`);
    const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
    const percent = (cfg?.rawDry != null && cfg?.rawWet != null)
      ? toPercent(value, cfg.rawDry, cfg.rawWet) : null;

    const payload = { raw: value, percent, at: new Date().toISOString() };
    await Promise.all([
      r.set(`soil:${id}:latest`, JSON.stringify(payload)),
      r.lPush(`soil:${id}:history`, JSON.stringify(payload)), // ⬅️ camelCase
      r.lTrim(`soil:${id}:history`, 0, 299)                  // ⬅️ camelCase
    ]);

    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", ["GET","POST"]);
  res.status(405).end("Method Not Allowed");
}
