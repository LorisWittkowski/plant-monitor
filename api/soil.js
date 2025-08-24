import { kv } from "@vercel/kv";

// robuster JSON-Parser (funktioniert mit ArduinoHttpClient)
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export default async function handler(req, res) {
  // CORS (hilfreich bei lokalen Tests, schadet nicht in Prod)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // ein optionaler sensorId-Query-Param; wenn weggelassen → "soil-1"
  const sensorId = (req.query.sensorId || "soil-1").toString();

  if (req.method === "GET") {
    const latest = await kv.get(`soil:${sensorId}:latest`);
    // Falls noch nie ein Wert kam → 204 (No Content)
    if (!latest) return res.status(204).end();
    return res.status(200).json(latest);
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const { raw, token } = body || {};

    if (process.env.INGEST_TOKEN && token !== process.env.INGEST_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const r = Number(raw);
    if (!Number.isFinite(r)) return res.status(400).json({ error: "raw numeric required" });

    const payload = { raw: r, at: new Date().toISOString() };
    await kv.set(`soil:${sensorId}:latest`, payload);
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end("Method Not Allowed");
}
