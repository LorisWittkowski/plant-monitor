// file: api/sensors.js
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

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") { res.setHeader("Allow",["GET"]); return res.status(405).end("Method Not Allowed"); }

  try{
    const r = await redis();

    // Set mit allen bekannten Sensoren
    const ids = await r.sMembers("soil:sensors"); // [] wenn leer

    // Für jede ID Profil + Kalibrierung einsammeln
    const results = [];
    for (const id of ids){
      const keyProfile = `soil:${id}:plant:profile`;
      const keyConfig  = `soil:${id}:config`;

      const [profRaw, cfgRaw] = await Promise.all([
        r.get(keyProfile),
        r.get(keyConfig)
      ]);

      let profile = null;
      try { profile = profRaw ? JSON.parse(profRaw) : null; } catch {}
      let config = null;
      try { config = cfgRaw ? JSON.parse(cfgRaw) : null; } catch {}

      const name = profile?.name || null;
      const pin  = profile?.pin || null;
      const calibrated = Number.isFinite(config?.rawDry) && Number.isFinite(config?.rawWet) && config.rawDry !== config.rawWet;

      results.push({ id, name, pin, calibrated });
    }

    // konsistente Sortierung: Name (fallback id)
    results.sort((a,b)=> (a.name || a.id).localeCompare(b.name || b.id, 'de'));

    return res.status(200).json({ sensors: results });
  }catch(e){
    console.error("sensors route failed:", e);
    return res.status(500).send("Internal Server Error");
  }
}
