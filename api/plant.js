// file: api/plant.js
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

// --- helpers: validation / sanitize ---
const ALLOWED_PINS = new Set([
  "A0","A1","A2","A3","A4","A5","A6","A7","A8","A9","A10","A11","A12","A13"
]);
function s(x) { return (typeof x === "string") ? x.trim() : x; }
function sanitizeProfile(input = {}) {
  const out = {};
  if ("name"     in input) out.name     = s(input.name)     || "";
  if ("species"  in input) out.species  = s(input.species)  || "";
  if ("location" in input) out.location = s(input.location) || "";
  if ("note"     in input) out.note     = s(input.note)     || "";
  if ("potCm"    in input) {
    const n = Number(input.potCm);
    out.potCm = Number.isFinite(n) ? n : "";
  }
  if ("pin" in input) {
    const pin = s(input.pin);
    out.pin = (pin && ALLOWED_PINS.has(pin)) ? pin : "";
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sensorId = s(req.query.sensorId || req.body?.sensorId || "soil-1");
  if (!sensorId) return res.status(400).json({ error: "sensorId_required" });

  const keyProfile = `soil:${sensorId}:plant:profile`;
  const r = await redis();

  if (req.method === "GET") {
    const profileRaw = await r.get(keyProfile);
    const profile = profileRaw ? JSON.parse(profileRaw) : null;
    if (!profile) return res.status(204).end();
    return res.status(200).json({ profile });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const requested = sanitizeProfile(body?.profile || {});

    // Non-destructive merge: nur Keys, die *im Request vorkommen*, werden angefasst
    const prevRaw = await r.get(keyProfile);
    const current = prevRaw ? JSON.parse(prevRaw) : {};

    const allowedKeys = new Set(["name", "species", "location", "potCm", "note", "pin"]);
    for (const k of Object.keys(requested)) {
      if (!allowedKeys.has(k)) continue;
      const val = requested[k];
      // Explizites Löschen nur bei null/"" (leerer String), sonst setzen
      if (val === null || val === "") {
        delete current[k];
      } else {
        current[k] = val;
      }
    }

    // Wenn ein Feld gar nicht im Request war → NICHT löschen/ändern

    // Leeres Profil komplett entfernen
    const hasAny = Object.keys(current).some(k => allowedKeys.has(k));
    if (!hasAny) {
      await r.del(keyProfile);
      return res.status(200).json({ ok: true, cleared: true });
    }

    if (!current.createdAt) current.createdAt = new Date().toISOString();
    current.updatedAt = new Date().toISOString();
    await r.set(keyProfile, JSON.stringify(current));
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end("Method Not Allowed");
}
