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

// ---- helpers ----
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
function toPercent(raw, dry, wet) {
  if (typeof dry!=="number" || typeof wet!=="number" || dry===wet) return null;
  return clamp(100*(raw - dry)/(wet - dry), 0, 100);
}

// bucketize entries into fixed time windows; prefer averaging raw, else percent
function bucketize(entries, windowMs, cfg) {
  if (!entries || !entries.length) return [];
  const buckets = new Map();
  for (const e of entries) {
    const t = new Date(e.at).getTime();
    if (!Number.isFinite(t)) continue;
    const k = Math.floor(t / windowMs) * windowMs;
    let b = buckets.get(k);
    if (!b) { b = { sumRaw:0, cntRaw:0, sumPct:0, cntPct:0 }; buckets.set(k, b); }
    if (typeof e.raw === "number") { b.sumRaw += e.raw; b.cntRaw++; }
    else if (typeof e.rawAvg === "number") { b.sumRaw += e.rawAvg; b.cntRaw++; }
    else if (typeof e.percent === "number") { b.sumPct += e.percent; b.cntPct++; }
  }
  const out = [];
  for (const [k,b] of buckets.entries()) {
    let pct = null;
    if (b.cntRaw > 0) {
      const avgRaw = b.sumRaw / b.cntRaw;
      if (cfg?.rawDry!=null && cfg?.rawWet!=null) pct = toPercent(avgRaw, cfg.rawDry, cfg.rawWet);
    }
    if (pct == null && b.cntPct > 0) pct = b.sumPct / b.cntPct;
    if (pct != null) out.push({ at: new Date(k + windowMs/2).toISOString(), percent: pct });
  }
  // sort ascending by time
  out.sort((a,b)=>new Date(a.at)-new Date(b.at));
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sensorId = (req.query.sensorId || "soil-1").toString();
  const r = await redis();

  const keyLatest    = `soil:${sensorId}:latest`;    // {raw, percent?, at}
  const keyHistory   = `soil:${sensorId}:history`;   // rohe Posts (kurz)
  const keyConfig    = `soil:${sensorId}:config`;    // {rawDry,rawWet}

  // 10-Min Aggregation state & series
  const keyCurWin    = `soil:${sensorId}:agg10m:curWindow`;
  const keyCurSum    = `soil:${sensorId}:agg10m:sum`;
  const keyCurCnt    = `soil:${sensorId}:agg10m:cnt`;
  const keyAgg10m    = `soil:${sensorId}:agg10m`;    // list of {at, rawAvg, percent?}

  if (req.method === "GET") {
    const range = (req.query.range || "latest").toString(); // latest | 1h | 24h | 7d

    const [cfgRaw, latestRaw] = await Promise.all([ r.get(keyConfig), r.get(keyLatest) ]);
    const config = cfgRaw ? JSON.parse(cfgRaw) : null;
    const latest = latestRaw ? JSON.parse(latestRaw) : null;

    if (range === "latest") {
      if (!latest) return res.status(204).end();
      return res.status(200).json({ latest, config });
    }

    // choose source + bucket size
    let entries = [];
    let windowMs = 0;
    const now = Date.now();

    if (range === "1h") {
      // source: raw history (fine). Need last 60 minutes.
      const list = await r.lRange(keyHistory, 0, 4000); // plenty for >2h @5s
      const from = now - 60*60*1000;
      entries = (list || []).map(s => JSON.parse(s)).filter(p => new Date(p.at).getTime() >= from).reverse();
      windowMs = 60 * 1000; // 1 minute
    } else if (range === "24h") {
      // source: agg10m (coarse)
      const list = await r.lRange(keyAgg10m, 0, 5000);
      const from = now - 24*60*60*1000;
      entries = (list || []).map(s => JSON.parse(s)).filter(p => new Date(p.at).getTime() >= from).reverse();
      windowMs = 30 * 60 * 1000; // 30 minutes
    } else { // "7d"
      const list = await r.lRange(keyAgg10m, 0, 5000);
      const from = now - 7*24*60*60*1000;
      entries = (list || []).map(s => JSON.parse(s)).filter(p => new Date(p.at).getTime() >= from).reverse();
      windowMs = 2 * 60 * 60 * 1000; // 2 hours
    }

    const series = bucketize(entries, windowMs, config);

    if (!latest && series.length===0) return res.status(204).end();
    return res.status(200).json({ sensorId, latest, config, series });
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
    const percent = (cfg?.rawDry!=null && cfg?.rawWet!=null) ? toPercent(value, cfg.rawDry, cfg.rawWet) : null;

    const now = Date.now();
    const payload = { raw: value, percent, at: new Date(now).toISOString() };

    // store latest + fine history (trim generously for >2h @5s)
    await Promise.all([
      r.set(`soil:${id}:latest`, JSON.stringify(payload)),
      r.lPush(`soil:${id}:history`, JSON.stringify(payload)),
      r.lTrim(`soil:${id}:history`, 0, 4000)
    ]);

    // maintain 10-min window aggregation for long-term
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

    // if window changed, flush previous window average
    if (storedWin !== null && storedWin !== curWindow && cnt > 0) {
      const avg = sum / cnt;
      const entry = {
        at: new Date(storedWin + windowMs/2).toISOString(),
        rawAvg: avg,
        percent: (cfg?.rawDry!=null && cfg?.rawWet!=null) ? toPercent(avg, cfg.rawDry, cfg.rawWet) : null
      };
      await Promise.all([
        r.lPush(`soil:${id}:agg10m`, JSON.stringify(entry)),
        r.lTrim(`soil:${id}:agg10m`, 0, 5000) // ≈34 Tage
      ]);
      sum = 0; cnt = 0;
    }

    // accumulate current window
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
