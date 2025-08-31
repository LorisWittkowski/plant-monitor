// file: public/assets/arduino-gen.js
// Arduino Code Generator (UNO R4 WiFi, Multi-Sensor, HTTPS → Vercel)
// - Rundet exakt deine "stabile" Single-Sensor-Logik auf mehrere Sensoren hoch
// - Nutzt dieselbe WLAN-/DHCP-Logik, Median+Mean-Messung, Content-Length, Backoff
// - Pins pro Pflanze (Sensor-ID) via UI wählbar (A0..A5), gespeichert in localStorage

(function(){
  const $ = s => document.querySelector(s);

  // DOM aus index.html
  const modal = $("#arduinoModal");
  const listWrap = $("#arduinoList");
  const genBtn = $("#arduinoGenBtn");
  const copyBtn = $("#arduinoCopyBtn");
  const outTA = $("#arduinoCode");
  const inSsid = $("#ard_ssid");
  const inPass = $("#ard_pass");
  const inHost = $("#ard_host");
  const inToken= $("#ard_token");

  // Lokale Persistenz für Pin-Zuordnung & Zugangsdaten
  const LS_PINS  = "arduinoPins";   // { [sensorId]: "A0"|"A1"|... }
  const LS_WIFI  = "arduinoWifi";   // { ssid, pass, host, token }

  const UNO_ANALOG_PINS = ["A0","A1","A2","A3","A4","A5"];

  function loadPins(){
    try{ return JSON.parse(localStorage.getItem(LS_PINS) || "{}"); }catch{ return {}; }
  }
  function savePins(map){ localStorage.setItem(LS_PINS, JSON.stringify(map||{})); }

  function loadWifi(){
    try{ return JSON.parse(localStorage.getItem(LS_WIFI) || "{}"); }catch{ return {}; }
  }
  function saveWifi(){
    const data = {
      ssid: inSsid?.value || "",
      pass: inPass?.value || "",
      host: inHost?.value || "",
      token: inToken?.value || "",
    };
    localStorage.setItem(LS_WIFI, JSON.stringify(data));
  }

  function fmtDateTime(){
    const d = new Date();
    const pad = n => String(n).padStart(2,"0");
    return `${d.getDate()}.${pad(d.getMonth()+1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function ensureModalOpen(){
    try { modal.showModal(); }
    catch(e){ if (!modal.open) modal.setAttribute('open',''); }
  }

  async function fetchSensors(){
    try{
      const r = await fetch("/api/sensors",{cache:"no-store"});
      if (!r.ok) throw 0;
      const data = await r.json();
      return Array.isArray(data.sensors) ? data.sensors : [];
    }catch{
      return [];
    }
  }

  function buildPinSelect(sensorId, current){
    const sel = document.createElement("select");
    sel.className = "input";
    sel.style.maxWidth = "110px";
    [...UNO_ANALOG_PINS, "(keiner)"].forEach(pin=>{
      const opt = document.createElement("option");
      opt.value = pin === "(keiner)" ? "" : pin;
      opt.textContent = pin;
      if (opt.value === (current||"")) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", ()=>{
      const map = loadPins();
      const v = sel.value || "";
      if (v) map[sensorId] = v; else delete map[sensorId];
      savePins(map);
    });
    return sel;
  }

  async function renderList(){
    const sensors = await fetchSensors();  // [{id, name, calibrated}]
    const pinMap = loadPins();

    listWrap.innerHTML = "";
    if (!sensors.length){
      const empty = document.createElement("div");
      empty.className = "muted small";
      empty.textContent = "Keine Pflanzen vorhanden. Lege zuerst eine Pflanze an.";
      listWrap.appendChild(empty);
      return;
    }

    sensors.forEach(s=>{
      const row = document.createElement("div");
      row.className = "card subtle";
      row.style.padding = "10px 12px";

      const title = document.createElement("div");
      title.style.display = "flex";
      title.style.justifyContent = "space-between";
      title.style.alignItems = "center";
      title.style.gap = "12px";

      const left = document.createElement("div");
      left.innerHTML = `
        <div class="mono" style="font-weight:600">${s.name || s.id}</div>
        <div class="muted small">${s.id}${s.calibrated ? " · kalibriert" : ""}</div>
      `;

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "8px";
      right.style.alignItems = "center";

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = "Analog-Pin";

      const sel = buildPinSelect(s.id, pinMap[s.id] || "");
      right.appendChild(label);
      right.appendChild(sel);

      title.appendChild(left);
      title.appendChild(right);
      row.appendChild(title);
      listWrap.appendChild(row);
    });
  }

  function buildSensorArrayCode(){
    const map = loadPins(); // { id: "A0", ... }
    const entries = Object.entries(map)
      .filter(([,pin])=> !!pin)
      .map(([id,pin])=> `  { "${id}", ${pin} }`);
    if (!entries.length) return { arrayCode: "", countCode: "0" };
    const arrayCode = `SensorCfg SENSORS[] = {\n${entries.join(",\n")}\n};`;
    const countCode = `sizeof(SENSORS)/sizeof(SENSORS[0])`;
    return { arrayCode, countCode };
  }

  function sanitize(s){
    return (s||"").replace(/\r\n/g,"\n");
  }

  function makeSketch(){
    // Zugangsdaten speichern (UX)
    saveWifi();
    const wifi = loadWifi();

    const { arrayCode, countCode } = buildSensorArrayCode();
    if (!arrayCode){
      return `// Bitte mindestens einer Pflanze einen Analog-Pin zuweisen (A0..A5).`;
    }

    const now = fmtDateTime();
    const ssid  = sanitize(wifi.ssid)  || "<WIFI_SSID>";
    const pass  = sanitize(wifi.pass)  || "<WIFI_PASS>";
    const host  = sanitize(wifi.host)  || "<YOUR_VERCEL_HOST>";
    const token = sanitize(wifi.token) || "<INGEST_TOKEN>";

    // ——— Exakt deine stabile Logik, hochskaliert auf mehrere Sensoren ———
    const code = `/**
 * UNO R4 WiFi – Multi Soil Monitor (HTTPS → Vercel)
 * Auto-generiert von Plant Monitor – ${now}
 *
 * Bitte trage unten SSID, Passwort, Host und Ingest-Token ein.
 * Die Sensorliste und Pins sind aus deiner Website übernommen.
 */

#include <WiFiS3.h>

// ── YOUR SETTINGS ────────────────────────────────────────────────────────────
const char* WIFI_SSID    = "${ssid}";
const char* WIFI_PASS    = "${pass}";
const char* HOST         = "${host}";            // ohne https://
const int   HTTPS_PORT   = 443;
const char* API_PATH     = "/api/soil";
const char* INGEST_TOKEN = "${token}";           // Vercel ENV

// ── SENSOR-ZUORDNUNG ────────────────────────────────────────────────────────
struct SensorCfg { const char* id; int pin; };
${arrayCode}
const int SENSOR_COUNT = ${countCode};

// ── TIMING (identisch zur stabilen Vorlage) ─────────────────────────────────
const unsigned long POST_INTERVAL_MS   = 5000;   // pro Loop 1 Sensor
const unsigned long RETRY_MIN_MS       = 4000;   // Backoff start
const unsigned long RETRY_MAX_MS       = 30000;  // Backoff Kappe
const unsigned long CONNECT_WAIT_MS    = 8000;   // pro Verbindungsversuch
const unsigned long DHCP_WAIT_MS       = 8000;   // auf gültige IP warten
const unsigned long HTTPS_READ_MS      = 5000;   // Statuszeile lesen

// ── NET / STATE ─────────────────────────────────────────────────────────────
WiFiSSLClient net;
unsigned long nextPostAt   = 0;
unsigned long retryDelayMs = 0;
int sensorIndex            = 0;   // round-robin

// ── HELPERS (wie stabile Vorlage) ───────────────────────────────────────────
static inline bool hasValidIP(IPAddress ip){
  return !(ip[0]==0 && ip[1]==0 && ip[2]==0 && ip[3]==0);
}

void waitForDHCP(){
  unsigned long until = millis() + DHCP_WAIT_MS;
  while (millis() < until && !hasValidIP(WiFi.localIP())) delay(200);
}

void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED && hasValidIP(WiFi.localIP())) return;

  WiFi.disconnect();
  while (true) {
    WiFi.begin(WIFI_SSID, WIFI_PASS);

    unsigned long start = millis();
    while (millis() - start < CONNECT_WAIT_MS && WiFi.status() != WL_CONNECTED) delay(200);

    if (WiFi.status() == WL_CONNECTED) {
      waitForDHCP();
      if (hasValidIP(WiFi.localIP())) {
        Serial.print("[WiFi] "); Serial.println(WiFi.localIP());
        return;
      }
    }
    delay(1500); // kurze Pause, dann nochmal
  }
}

// stabile Messung: Median (robust) + kleiner Mittelwert-Anteil
int readSoilRawAtPin(uint8_t pin, uint8_t n=7){
  if(!(n&1)) n++; if(n>15) n=15;
  int b[15];
  for(uint8_t i=0;i<n;i++){ b[i]=analogRead(pin); delayMicroseconds(200); }
  for(uint8_t i=1;i<n;i++){ int k=b[i], j=i-1; while(j>=0 && b[j]>k){ b[j+1]=b[j]; j--; } b[j+1]=k; }
  int med=b[n/2]; long sum=0; for(uint8_t i=0;i<n;i++) sum+=b[i]; int mean=sum/n;
  return (int)(0.7f*med + 0.3f*mean);
}

// direkter HTTPS-POST (ohne ArduinoHttpClient): klar & kompatibel
bool postRawFor(const char* sensorId, int raw) {
  if (!net.connect(HOST, HTTPS_PORT)) return false;

  String body = String("{\\\"sensorId\\\":\\\"") + sensorId +
                "\\\",\\\"raw\\\":" + raw +
                ",\\\"token\\\":\\\"" + INGEST_TOKEN + "\\\"}";

  String req =
    String("POST ") + API_PATH + " HTTP/1.1\\r\\n" +
    "Host: " + HOST + "\\r\\n" +
    "Content-Type: application/json\\r\\n" +
    "Connection: close\\r\\n" +
    "Content-Length: " + body.length() + "\\r\\n\\r\\n" +
    body;

  net.print(req);

  // Statuszeile lesen (z. B. "HTTP/1.1 200 OK")
  String statusLine;
  unsigned long until = millis() + HTTPS_READ_MS;
  while (millis() < until && net.connected()) {
    if (net.available()) {
      char c = net.read();
      if (c == '\\n') break;
      if (c != '\\r') statusLine += c;
    }
  }
  net.stop();

  int sp1 = statusLine.indexOf(' ');
  int sp2 = statusLine.indexOf(' ', sp1 + 1);
  int code = (sp1 > 0 && sp2 > sp1) ? statusLine.substring(sp1 + 1, sp2).toInt() : -1;
  return (code >= 200 && code < 300);
}

void scheduleNext(bool success){
  if (success) {
    retryDelayMs = 0;
    nextPostAt = millis() + POST_INTERVAL_MS;
  } else {
    retryDelayMs = (retryDelayMs == 0) ? RETRY_MIN_MS : min(retryDelayMs * 2, RETRY_MAX_MS);
    nextPostAt = millis() + retryDelayMs;
  }
}

// ── ARDUINO LIFECYCLE ───────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("Multi-Soil → Vercel (clean)");
  for (int i=0; i<SENSOR_COUNT; i++){ pinMode(SENSORS[i].pin, INPUT); }

  ensureWiFi();                 // ruhig verbinden
  nextPostAt = millis() + 1000; // erster Post leicht verzögert
}

void loop() {
  // Netz pflegen
  if (!(WiFi.status() == WL_CONNECTED && hasValidIP(WiFi.localIP()))) {
    ensureWiFi();
  }

  unsigned long now = millis();
  if (now >= nextPostAt && SENSOR_COUNT > 0) {
    const SensorCfg &s = SENSORS[sensorIndex];
    int raw = readSoilRawAtPin(s.pin);
    bool ok = postRawFor(s.id, raw);

    // kurze, klare Logzeile pro Zyklus
    Serial.print("["); Serial.print(s.id); Serial.print("] ");
    Serial.print("PIN="); Serial.print(s.pin);
    Serial.print(" RAW="); Serial.print(raw);
    Serial.print(" POST="); Serial.println(ok ? "OK" : "FAIL");

    // immer weiter rotieren, damit nichts "hängen" bleibt
    sensorIndex = (sensorIndex + 1) % SENSOR_COUNT;

    scheduleNext(ok);
  }

  delay(5);
}
`;
    return code;
  }

  async function open(){
    // Prefill WLAN-Felder aus LS
    const wifi = loadWifi();
    if (inSsid) inSsid.value = wifi.ssid || "";
    if (inPass) inPass.value = wifi.pass || "";
    if (inHost) inHost.value = wifi.host || "";
    if (inToken)inToken.value= wifi.token|| "";

    await renderList();
    ensureModalOpen();
  }

  function generate(){
    const code = makeSketch();
    outTA.value = code;
    // Auto-Resize
    outTA.style.height = "auto";
    outTA.style.height = Math.max(280, outTA.scrollHeight + 8) + "px";
  }

  async function copyCode(){
    try{
      await navigator.clipboard.writeText(outTA.value || "");
      copyBtn.textContent = "Kopiert ✓";
      setTimeout(()=>{ copyBtn.textContent = "In Zwischenablage kopieren"; }, 1200);
    }catch{
      copyBtn.textContent = "Kopieren fehlgeschlagen";
      setTimeout(()=>{ copyBtn.textContent = "In Zwischenablage kopieren"; }, 1500);
    }
  }

  // Events
  genBtn?.addEventListener("click", generate);
  copyBtn?.addEventListener("click", copyCode);
  inSsid?.addEventListener("change", saveWifi);
  inPass?.addEventListener("change", saveWifi);
  inHost?.addEventListener("change", saveWifi);
  inToken?.addEventListener("change", saveWifi);

  // Expose
  window.ArduinoGen = { open, generate };
})();
