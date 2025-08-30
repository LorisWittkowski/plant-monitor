// file: api/soil.js
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

const RAW_MAX = 4095;
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
function toPercentWithFallback(raw, cfg) {
  if (typeof raw !== "number") return null;
  if (cfg && typeof cfg.rawDry === "number" && typeof cfg.rawWet === "number" && cfg.rawDry !== cfg.rawWet) {
    return clamp(100 * (raw - cfg.rawDry) / (cfg.rawWet - cfg.rawDry), 0, 100);
  }
  return clamp(100 * (raw / RAW_MAX), 0, 100);
}

function bucketize(entries, windowMs, cfg) {
  if (!entries || !entries.length) return [];
  const buckets = new Map();
  for (const e of entries) {
    const t = new Date(e.at).getTime();
    if (!Number.isFinite(t)) continue;
    const k = Math.floor(t / windowMs) * windowMs;
    let b = buckets.get(k);
    if (!b) { b = { sumRaw:0, cnt:0 }; buckets.set(k, b); }
    if (typeof e.raw === "number") { b.sumRaw += e.raw; b.cnt++; }
    else if (typeof e.rawAvg === "number") { b.sumRaw += e.rawAvg; b.cnt++; }
    else if (typeof e.percent === "number") { b.sumRaw += (e.percent/100)*RAW_MAX; b.cnt++; }
  }
  const out = [];
  for (const [k,b] of buckets.entries()) {
    if (b.cnt <= 0) continue;
    const avgRaw = b.sumRaw / b.cnt;
    const pct = toPercentWithFallback(avgRaw, cfg);
    out.push({ at: new Date(k + windowMs/2).toISOString(), rawAvg: avgRaw, percent: pct });
  }
  out.sort((a,b)=> new Date(a.at) - new Date(b.at));
  return out;
}

function fillMissing(series, fromMs, toMs, windowMs) {
  if (!windowMs || fromMs >= toMs) return series || [];
  const byBucket = new Map();
  for (const item of (series || [])) {
    const t = new Date(item.at).getTime();
    const k = Math.floor(t / windowMs) * windowMs;
    byBucket.set(k, item);
  }
  const start = Math.floor(fromMs / windowMs) * windowMs;
  const end   = Math.floor(toMs   / windowMs) * windowMs;
  const full = [];
  for (let k = start; k <= end; k += windowMs) {
    const hit = byBucket.get(k);
    if (hit) full.push(hit);
    else full.push({ at: new Date(k + windowMs/2).toISOString(), rawAvg: null, percent: null });
  }
  return full;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sensorId = (req.query.sensorId || "soil-1").toString();
  const r = await redis();

  if (req.method === "GET") {
    const range = (req.query.range || "latest").toString();

    const [cfgRaw, latestRaw] = await Promise.all([
      r.get(`soil:${sensorId}:config`),
      r.get(`soil:${sensorId}:latest`)
    ]);
    const config = cfgRaw ? JSON.parse(cfgRaw) : null;
    const latest = latestRaw ? JSON.parse(latestRaw) : null;

    if (range === "latest") {
      if (!latest) return res.status(204).end();
      const raw = Number(latest.raw);
      const percent = toPercentWithFallback(raw, config);
      return res.status(200).json({ latest: { ...latest, percent }, config });
    }

    const now = Date.now();
    let entries = [];
    let windowMs = 0;
    let from = 0;

    if (range === "1h") {
      const list = await r.lRange(`soil:${sensorId}:history`, 0, 4000);
      from = now - 60*60*1000;
      entries = (list || []).map(s => JSON.parse(s)).filter(p => new Date(p.at).getTime() >= from).reverse();
      windowMs = 60 * 1000;
    } else if (range === "24h") {
      const list = await r.lRange(`soil:${sensorId}:agg10m`, 0, 5000);
      from = now - 24*60*60*1000;
      entries = (list || []).map(s => JSON.parse(s)).filter(p => new Date(p.at).getTime() >= from).reverse();
      windowMs = 30 * 60 * 1000;
    } else { // 7d
      const list = await r.lRange(`soil:${sensorId}:agg10m`, 0, 5000);
      from = now - 7*24*60*60*1000;
      entries = (list || []).map(s => JSON.parse(s)).filter(p => new Date(p.at).getTime() >= from).reverse();
      windowMs = 2 * 60 * 60 * 1000;
    }

    const seriesAgg = bucketize(entries, windowMs, config);
    const seriesFull = fillMissing(seriesAgg, from, now, windowMs);

    if (!latest && seriesFull.every(p => p.percent == null)) return res.status(204).end();

    const safeLatest = latest
      ? { ...latest, percent: toPercentWithFallback(Number(latest.raw), config) }
      : null;

    return res.status(200).json({ sensorId, latest: safeLatest, config, series: seriesFull });
  }

  if (req.method === "POST") {
    const { sensorId: sid, raw, token } = await readJson(req);
    const id = (sid || sensorId).toString();

    if (process.env.INGEST_TOKEN && token !== process.env.INGEST_TOKEN) {
      return res.status(401).json({ error: "unauthorized_token" });
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) return res.status(422).json({ error:"raw_numeric_required" });

    const cfgRaw = await r.get(`soil:${id}:config`);
    const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
    const percent = toPercentWithFallback(value, cfg);

    const now = Date.now();
    const payload = { raw: value, percent, at: new Date(now).toISOString() };

    await Promise.all([
      r.set(`soil:${id}:latest`, JSON.stringify(payload)),
      r.lPush(`soil:${id}:history`, JSON.stringify(payload)),
      r.lTrim(`soil:${id}:history`, 0, 4000),
      r.sAdd('soil:sensors', id) // <— registriere Sensor-ID für die Liste
    ]);

    // 10-Min Aggregation
    const windowMs = 10 * 60 * 1000;
    const curWindow = Math.floor(now / windowMs) * windowMs;

    const [storedWinRaw, sumRaw, cntRaw] = await Promise.all([
      r.get(`soil:${id}:agg10m:curWindow`),
      r.get(`soil:${id}:agg10m:sum`),
      r.get(`soil:${id}:agg10m:cnt`)
    ]);
    const storedWin = storedWinRaw ? Number(storedWinRaw) : null;
    let sum = sumRaw ? Number(sumRaw) : 0;
    let cnt = cntRaw ? Number(cntRaw) : 0;

    if (storedWin !== null && storedWin !== curWindow && cnt > 0) {
      const avg = sum / cnt;
      const entry = {
        at: new Date(storedWin + windowMs/2).toISOString(),
        rawAvg: avg,
        percent: toPercentWithFallback(avg, cfg)
      };
      await Promise.all([
        r.lPush(`soil:${id}:agg10m`, JSON.stringify(entry)),
        r.lTrim(`soil:${id}:agg10m`, 0, 5000)
      ]);
      sum = 0; cnt = 0;
    }

    sum += value; cnt += 1;
    await Promise.all([
      r.set(`soil:${id}:agg10m:curWindow`, String(curWindow)),
      r.set(`soil:${id}:agg10m:sum`, String(sum)),
      r.set(`soil:${id}:agg10m:cnt`, String(cnt)),
    ]);

    return res.status(200).json({ ok:true });
  }

  res.setHeader("Allow", ["GET","POST"]);
  res.status(405).end("Method Not Allowed");
}
