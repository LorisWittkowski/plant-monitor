import { createClient } from "redis";
import crypto from "node:crypto";

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

export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(204).end();

  const sensorId = (req.query.sensorId || "soil-1").toString();
  const key = `soil:${sensorId}:notes`;
  const r = await redis();

  if (req.method === "GET") {
    const list = await r.lRange(key, 0, 100);
    const notes = (list||[]).map(s=>JSON.parse(s));
    if (notes.length===0) return res.status(204).end();
    return res.status(200).json({ notes });
  }

  if (req.method === "POST") {
    const { text } = await readJson(req);
    if (!text || typeof text !== "string") return res.status(400).json({ error:"text_required" });
    const entry = { id: crypto.randomUUID(), text: text.trim(), at: new Date().toISOString() };
    await Promise.all([
      r.lPush(key, JSON.stringify(entry)),
      r.lTrim(key, 0, 200) // bis zu 200 Notizen
    ]);
    return res.status(200).json({ ok:true, note: entry });
  }

  if (req.method === "DELETE") {
    const id = (req.query.id || "").toString();
    if (!id) return res.status(400).json({ error:"id_required" });
    // naive remove: scan lrange, remove matching
    const list = await r.lRange(key, 0, 500);
    const target = list.find(s => {
      try { return JSON.parse(s).id === id; } catch { return false; }
    });
    if (target) await r.lRem(key, 1, target);
    return res.status(200).json({ ok:true });
  }

  res.setHeader("Allow",["GET","POST","DELETE"]);
  res.status(405).end("Method Not Allowed");
}
