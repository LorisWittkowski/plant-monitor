// api/soil.js
import { createClient } from "redis";

// ---- Redis client (optional) ----
let redisPromise = null;
function getRedis() {
  if (!process.env.REDIS_URL) return null; // Storage optional
  if (!redisPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (e) => console.error("Redis error:", e));
    redisPromise = client.connect().then(() => client);
  }
  return redisPromise;
}

// ---- robust JSON parser (ArduinoHttpClient safe) ----
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export default async function handler(req, res) {
  // CORS ok
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sensorId = (req.query.sensorId || "soil-1").toString();
  const keyLatest = `soil:${sensorId}:latest`;

  if (req.method === "GET") {
    try {
      const clientP = getRedis();
      if (!clientP) return res.status(204).end(); // kein Storage -> noch nichts
      const client = await clientP;
      const raw = await client.get(keyLatest);
      if (!raw) return res.status(204).end();
      return res.status(200).json(JSON.parse(raw));
    } catch (e) {
      console.error("GET soil error:", e);
      return res.status(500).json({ error: "server_error_get" });
    }
  }

  if (req.method === "POST") {
    try {
      const { raw, token } = await readJson(req);

      // Token check (klare 401 bei mismatch)
      if (process.env.INGEST_TOKEN && token !== process.env.INGEST_TOKEN) {
        return res.status(401).json({ error: "unauthorized_token" });
      }

      // raw validieren (klare 422 statt 400)
      const r = Number(raw);
      if (!Number.isFinite(r)) {
        return res.status(422).json({ error: "raw_numeric_required" });
      }

      const payload = { raw: r, at: new Date().toISOString() };

      let stored = false;
      const clientP = getRedis();
      if (clientP) {
        const client = await clientP;
        await client.set(keyLatest, JSON.stringify(payload));
        stored = true;
      }

      return res.status(200).json({ ok: true, stored });
    } catch (e) {
      console.error("POST soil error:", e);
      return res.status(500).json({ error: "server_error_post" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end("Method Not Allowed");
}
