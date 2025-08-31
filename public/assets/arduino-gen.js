// file: public/assets/arduino-gen.js
// Liest Sensoren + Profile (inkl. pin) und erzeugt einen Mehr-Sensor-Sketch.
// Pins werden NICHT hier editiert – nur Anzeige & Generierung.

(function(){
    const ALLOWED_PINS = [
      "A0","A1","A2","A3","A4","A5",
      "A6","A7","A8","A9","A10","A11","A12","A13"
    ];

  // ---------- helpers ----------
  async function fetchJSON(url){
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.status === 204 ? null : await r.json();
  }
  async function listSensors(){
    const data = await fetchJSON("/api/sensors");
    return Array.isArray(data?.sensors) ? data.sensors : [];
  }
  async function getProfile(id){
    try{
      const data = await fetchJSON(`/api/plant?sensorId=${encodeURIComponent(id)}`);
      return data?.profile || null;
    }catch{ return null; }
  }
  function getEl(id){ return document.getElementById(id); }
  function getSummaryContainer(){ return getEl("arduinoSummary") || getEl("arduinoList"); }

  // ---------- UI render ----------
  function renderSummary(list){
    const wrap = getSummaryContainer();
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!list.length){
      const div = document.createElement("div");
      div.className = "card subtle";
      div.style.padding = "10px";
      div.textContent = "Keine Pflanzen vorhanden. Lege zuerst welche an und setze die Pins in den Pflanzen-Infos.";
      wrap.appendChild(div);
      return;
    }
    list.forEach(s=>{
      const row = document.createElement("div");
      row.className = "card subtle";
      row.style.padding = "10px";
      row.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px">
          <div>
            <strong>${escapeHtml(s.name || s.id)}</strong>
            <div class="muted small">
              <span class="mono">${escapeHtml(s.id)}</span>
            </div>
          </div>
          <div class="mono" title="Analog-Pin">
            Pin: <strong>${escapeHtml(s.pin || "—")}</strong>
          </div>
        </div>`;
      wrap.appendChild(row);
    });
  }

  function escapeHtml(str){
    return String(str ?? "")
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;");
  }

  // ---------- data collect ----------
  async function collectSensorsWithPins(){
    const sensors = await listSensors();           // [{id,name,calibrated}, ...]
    const withProfiles = await Promise.all(
      sensors.map(async s=>{
        const p = await getProfile(s.id);          // may contain { pin, ... }
        const pin = p?.pin || null;
        return { id: s.id, name: s.name || p?.name || s.id, pin };
      })
    );
    // Reihenfolge stabil lassen, aber ungültige Pins markieren
    return withProfiles;
  }

  // ---------- sketch gen ----------
  function genSensorsArray(sensors){
    // nur valide Pins zulassen
    const withPin = sensors.filter(s => ALLOWED_PINS.includes(s.pin || ""));
    const lines = withPin.map(s => `  { "${s.id}", ${s.pin} }`);
    return { lines, count: withPin.length, skipped: sensors.length - withPin.length };
  }

  function genSketch(sensors, ssid, pass, host, token){
    const now = new Date();
    const ts = now.toLocaleString();
    const { lines, count } = genSensorsArray(sensors);

    return `/**
 * UNO R4 WiFi – Multi Soil Monitor (HTTPS → Vercel)
 * Auto-generiert von Plant Monitor – ${ts}
 *
 * Bitte trage unten SSID, Passwort, Host und Ingest-Token ein.
 * Die Sensorliste und Pins stammen aus den Pflanzen-Infos der Website.
 */

#include <WiFiS3.h>

// ── YOUR SETTINGS ────────────────────────────────────────────────────────────
const char* WIFI_SSID    = "${ssid || "<WIFI_SSID>"}";
const char* WIFI_PASS    = "${pass || "<WIFI_PASS>"}";
const char* HOST         = "${host || "<YOUR_VERCEL_HOST>"}";   // ohne https://
const int   HTTPS_PORT   = 443;
const char* API_PATH     = "/api/soil";
const char* INGEST_TOKEN = "${token || "<INGEST_TOKEN>"}";

// ── TIMING ───────────────────────────────────────────────────────────────────
const unsigned long POST_INTERVAL_MS = 5000; // Runde-zu-Runde (pro Sensor round-robin)
const unsigned long CONNECT_WAIT_MS  = 8000;
const unsigned long DHCP_WAIT_MS     = 8000;
const unsigned long HTTPS_READ_MS    = 5000;

// ── SENSOR LISTE (aus Website) ──────────────────────────────────────────────
struct SensorCfg { const char* id; int pin; };
SensorCfg SENSORS[] = {
${lines.join(",\n")}
};
const int SENSOR_COUNT = ${count};

// ── NET ─────────────────────────────────────────────────────────────────────
WiFiSSLClient net;

// ── HELPERS ─────────────────────────────────────────────────────────────────
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
int readSoilRawOn(uint8_t pin, uint8_t n=7){
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

// ── ARDUINO LIFECYCLE ───────────────────────────────────────────────────────
unsigned long nextSendAt = 0;
int sensorIndex = 0;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("Multi-Soil → Vercel (clean)");
  for (int i=0; i<SENSOR_COUNT; i++){ pinMode(SENSORS[i].pin, INPUT); }
  ensureWiFi();
  nextSendAt = millis() + 1000;
}

void loop() {
  if (!(WiFi.status() == WL_CONNECTED && hasValidIP(WiFi.localIP()))) {
    ensureWiFi();
  }

  if (millis() >= nextSendAt) {
    if (SENSOR_COUNT > 0) {
      const SensorCfg &s = SENSORS[sensorIndex];
      int raw = readSoilRawOn(s.pin);
      bool ok = postRawFor(s.id, raw);

      Serial.print("["); Serial.print(s.id); Serial.print("] ");
      Serial.print("PIN="); Serial.print(s.pin);
      Serial.print(" RAW="); Serial.print(raw);
      Serial.print(" POST="); Serial.println(ok ? "OK" : "FAIL");

      sensorIndex = (sensorIndex + 1) % SENSOR_COUNT;  // round-robin
    }
    nextSendAt = millis() + POST_INTERVAL_MS;
  }

  delay(5);
}
`;
  }

  // ---------- events / wiring ----------
  function loadSavedCreds(){
    return {
      ssid: localStorage.getItem("ard_ssid") || "",
      pass: localStorage.getItem("ard_pass") || "",
      host: localStorage.getItem("ard_host") || "",
      token: localStorage.getItem("ard_token") || "",
    };
  }
  function saveCreds(c){
    if (!c) return;
    if ("ssid" in c)  localStorage.setItem("ard_ssid",  c.ssid || "");
    if ("pass" in c)  localStorage.setItem("ard_pass",  c.pass || "");
    if ("host" in c)  localStorage.setItem("ard_host",  c.host || "");
    if ("token" in c) localStorage.setItem("ard_token", c.token || "");
  }

  async function open(){
    const modal = getEl("arduinoModal");
    if (!modal) return;
    // 1) Liste laden
    let sensorList = [];
    try{
      sensorList = await collectSensorsWithPins();
    }catch(e){
      console.error(e);
      sensorList = [];
    }
    renderSummary(sensorList);

    // 2) Felder füllen
    const { ssid, pass, host, token } = loadSavedCreds();
    const fSsid  = getEl("ard_ssid");
    const fPass  = getEl("ard_pass");
    const fHost  = getEl("ard_host");
    const fToken = getEl("ard_token");
    if (fSsid)  fSsid.value  = ssid;
    if (fPass)  fPass.value  = pass;
    if (fHost)  fHost.value  = host;
    if (fToken) fToken.value = token;

    // 3) Buttons verkabeln
    const btnGen  = getEl("arduinoGenBtn");
    const btnCopy = getEl("arduinoCopyBtn");
    const out     = getEl("arduinoCode");

    btnGen?.addEventListener("click", async ()=>{
      // Creds live lesen & speichern
      const creds = {
        ssid:  fSsid?.value || "",
        pass:  fPass?.value || "",
        host:  fHost?.value || "",
        token: fToken?.value || "",
      };
      saveCreds(creds);

      // Frische Sensorliste holen (falls zwischenzeitlich geändert)
      let current = [];
      try { current = await collectSensorsWithPins(); } catch {}
      // Hinweis, wenn keiner einen gültigen Pin hat
      const validCount = current.filter(s => ALLOWED_PINS.includes(s.pin || "")).length;
      if (!validCount){
        alert("Es sind (noch) keine gültigen Pins gesetzt. Öffne die Pflanzen-Infos und wähle A0–A5.");
      }
      const code = genSketch(current, creds.ssid, creds.pass, creds.host, creds.token);
      if (out) { out.value = code; autoGrow(out); out.scrollTop = 0; }
    }, { once:false });

    btnCopy?.addEventListener("click", async ()=>{
      if (!out?.value) return;
      try{
        await navigator.clipboard.writeText(out.value);
        btnCopy.textContent = "Kopiert ✓";
        setTimeout(()=>{ btnCopy.textContent = "In Zwischenablage kopieren"; }, 900);
      }catch{
        // Fallback
        out.select(); document.execCommand("copy");
        btnCopy.textContent = "Kopiert ✓";
        setTimeout(()=>{ btnCopy.textContent = "In Zwischenablage kopieren"; }, 900);
      }
    }, { once:false });

    // 4) öffnen
    try{ modal.showModal(); }catch{ modal.setAttribute("open",""); }
  }

  function autoGrow(textarea){
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = (textarea.scrollHeight + 2) + "px";
  }

  // Expose
  window.ArduinoGen = { open };

})();
