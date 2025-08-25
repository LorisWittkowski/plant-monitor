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

const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
function toPercent(raw, dry, wet) {
  if (typeof dry!=="number" || typeof wet!=="number" || dry===wet) return null;
  return clamp(100*(raw - dry)/(wet - dry), 0, 100);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sensorId = (req.query.sensorId || "soil-1").toString();
  const r = await redis();

  const keyLatest    = `soil:${sensorId}:latest`;
  const keyHistory   = `soil:${sensorId}:history`;   // kurze Historie (roh)
  const keyConfig    = `soil:${sensorId}:config`;

  // Aggregation (10 Min Fenster)
  const keyCurWin    = `soil:${sensorId}:agg10m:curWindow`;
  const keyCurSum    = `soil:${sensorId}:agg10m:sum`;
  const keyCurCnt    = `soil:${sensorId}:agg10m:cnt`;
  const keyAgg10m    = `soil:${sensorId}:agg10m`;    // Liste von Einträgen

  if (req.method === "GET") {
    const range = (req.query.range || "latest").toString(); // latest | 1h | 24h | 7d

    // Immer config + latest laden
    const [cfgRaw, latestRaw] = await Promise.all([ r.get(keyConfig), r.get(keyLatest) ]);
    const config = cfgRaw ? JSON.parse(cfgRaw) : null;
    const latest = latestRaw ? JSON.parse(latestRaw) : null;

    if (range === "latest") {
      if (!latest) return res.status(204).end();
      return res.status(200).json({ latest, config });
    }

    let series = [];

    if (range === "1h") {
      // Nimm die feine Historie und filtere auf letzte Stunde
      const list = await r.lRange(keyHistory, 0, 2000);
      const until = Date.now() - 60*60*1000;
      series = (list || []).map(s => JSON.parse(s)).filter(p => new Date(p.at).getTime() >= until).reverse();
    } else {
      // 24h / 7d → aggregierte Serie (10-Minuten-Mittel)
      const list = await r.lRange(keyAgg10m, 0, 2000);
      const hours = range === "24h" ? 24 : 24*7;
      const until = Date.now() - hours*60*60*1000;
      series = (list || []).map(s => JSON.parse(s)).filter(p => new Date(p.at).getTime() >= until).reverse();
    }

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

    // Kurz-Historie
    await Promise.all([
      r.set(`soil:${id}:latest`, JSON.stringify(payload)),
      r.lPush(`soil:${id}:history`, JSON.stringify(payload)),
      r.lTrim(`soil:${id}:history`, 0, 2000) // hält genug für ~1-2h bei hohem Takt
    ]);

    // ── 10-Min Aggregation ──
    const windowMs = 10 * 60 * 1000;                 // 10 Minuten
    const curWindow = Math.floor(now / windowMs) * windowMs;

    const [storedWinRaw, sumRaw, cntRaw] = await Promise.all([
      r.get(keyCurWin), r.get(keyCurSum), r.get(keyCurCnt)
    ]);
    const storedWin = storedWinRaw ? Number(storedWinRaw) : null;
    let sum = sumRaw ? Number(sumRaw) : 0;
    let cnt = cntRaw ? Number(cntRaw) : 0;

    // wenn Fensterwechsel: schreibe vorheriges Fenster als Durchschnitt in Liste
    if (storedWin !== null && storedWin !== curWindow && cnt > 0) {
      const avg = sum / cnt;
      const entry = {
        at: new Date(storedWin + windowMs/2).toISOString(), // Mitte des Fensters
        rawAvg: avg,
        percent: (cfg?.rawDry!=null && cfg?.rawWet!=null) ? toPercent(avg, cfg.rawDry, cfg.rawWet) : null
      };
      await Promise.all([
        r.lPush(keyAgg10m, JSON.stringify(entry)),
        r.lTrim(keyAgg10m, 0, 5000) // ca. 5000*10min ≈ 34 Tage
      ]);
      sum = 0; cnt = 0;
    }

    // Aktuelles Fenster akkumulieren
    sum += value; cnt += 1;
    await Promise.all([
      r.set(keyCurWin, String(curWindow)),
      r.set(keyCurSum, String(sum)),
      r.set(keyCurCnt, String(cnt)),
    ]);

    return res.status(200).json({ ok:true });
  }

  res.setHeader("Allow", ["GET","POST"]);
  res.status(405).end("Method Not Allowed");
}
