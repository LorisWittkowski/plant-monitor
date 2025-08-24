export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Body robust lesen (wie in soil.js)
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  // Token maskieren, falls enthalten
  const safeBody = rawBody.replace(/("token"\s*:\s*")([^"]*)(")/i, '$1***$3');

  return res.status(200).json({
    method: req.method,
    url: req.url,
    headers: req.headers,
    bodyRaw: safeBody,
    bodyLen: rawBody.length
  });
}
