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

export default async function handler(_req, res){
  const r = await redis();
  const ids = await r.sMembers('soil:sensors');
  const sensors = [];
  for (const id of ids){
    const [cfgRaw, profRaw] = await Promise.all([
      r.get(`soil:${id}:config`),
      r.get(`soil:${id}:plant:profile`)
    ]);
    const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
    const profile = profRaw ? JSON.parse(profRaw) : null;
    sensors.push({
      id,
      name: profile?.name || id,
      calibrated: !!(cfg?.rawDry!=null && cfg?.rawWet!=null)
    });
  }
  sensors.sort((a,b)=> (a.name||a.id).localeCompare(b.name||b.id, 'de', {numeric:true, sensitivity:'base'}));
  res.json({ sensors });
}
