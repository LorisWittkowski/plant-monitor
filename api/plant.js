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

// read request body robustly (Arduino/browser safe)
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sensorId = (req.query.sensorId || "soil-1").toString();
  const keyProfile = `soil:${sensorId}:plant:profile`;
  const keyLog = `soil:${sensorId}:plant:log`;

  const r = await redis();

  if (req.method === "GET") {
    const [profileRaw, logList] = await Promise.all([
      r.get(keyProfile),
      r.lRange(keyLog, 0, 20)
    ]);
    const profile = profileRaw ? JSON.parse(profileRaw) : null;
    const careLog = (logList || []).map(s => JSON.parse(s));
    if (!profile && careLog.length===0) return res.status(204).end();
    return res.status(200).json({ profile, careLog });
  }

  if (req.method === "POST") {
    const { profile, log } = await readJson(req);

    if (profile) {
      const merged = { ...(JSON.parse(await r.get(keyProfile) || "{}")), ...profile, updatedAt: new Date().toISOString() };
      await r.set(keyProfile, JSON.stringify(merged));
    }
    if (log) {
      const entry = { at: new Date().toISOString(), ...log };
      await r.lPush(keyLog, JSON.stringify(entry));
      await r.lTrim(keyLog, 0, 50);
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", ["GET","POST"]);
  res.status(405).end("Method Not Allowed");
}
