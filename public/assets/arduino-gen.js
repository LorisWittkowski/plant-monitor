// file: public/assets/arduino-gen.js
// Arduino Code Generator (standalone, lazy-loaded by app.js / index.html)
// Exposes window.ArduinoGen.open()

(() => {
  const $  = (s,root=document)=>root.querySelector(s);
  const $$ = (s,root=document)=>Array.from(root.querySelectorAll(s));

  // DOM targets (live-queried on open to survive hot reloads)
  function els() {
    return {
      modal:        $("#arduinoModal"),
      list:         $("#arduinoList"),
      genBtn:       $("#arduinoGenBtn"),
      copyBtn:      $("#arduinoCopyBtn"),
      code:         $("#arduinoCode"),
      ssid:         $("#ard_ssid"),
      pass:         $("#ard_pass"),
      host:         $("#ard_host"),
      token:        $("#ard_token"),
    };
  }

  // Fetch sensors from backend
  async function fetchSensors() {
    const r = await fetch("/api/sensors", { cache: "no-store" });
    if (!r.ok) throw new Error(`/api/sensors -> ${r.status}`);
    const data = await r.json();
    const sensors = Array.isArray(data.sensors) ? data.sensors : [];
    // Normalize: {id, name}
    return sensors.map(s => ({ id: String(s.id), name: s.name || null }));
  }

  // Render one row per sensor with pin-select
  function renderList(listEl, sensors) {
    listEl.innerHTML = "";
    if (sensors.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted small";
      empty.textContent = "Keine Pflanzen vorhanden. Lege zuerst eine Pflanze an.";
      listEl.appendChild(empty);
      return;
    }

    sensors.forEach((s, idx) => {
      const card = document.createElement("div");
      card.className = "card subtle";
      card.style.padding = "12px";
      card.style.marginBottom = "10px";

      // default pin suggestion A0..A7.. then A0 again
      const defaultPin = `A${idx % 8}`;

      card.innerHTML = `
        <div class="grid2 gap">
          <div class="field">
            <span class="label">Sensor-ID</span>
            <div class="mono" style="font-size:18px">${escapeHtml(s.id)}</div>
            <div class="muted small">(Pflanzenname: ${escapeHtml(s.name || "—")})</div>
          </div>

          <label class="field">
            <span class="label">Analog-Pin</span>
            <select class="input ard-pin" data-id="${escapeAttr(s.id)}" style="height:44px">
              ${pinOptions(defaultPin)}
            </select>
          </label>
        </div>
        <div class="muted small" style="margin-top:6px">
          Der gewählte Pin wird im Sketch für <strong>${escapeHtml(s.id)}</strong> verwendet.
        </div>
      `;
      listEl.appendChild(card);
    });
  }

  function pinOptions(selected) {
    const pins = ["A0","A1","A2","A3","A4","A5","A6","A7",
                  // Fallbacks / alternative Boards (wird selten genutzt)
                  "0","1","2","3","4","5","6","7","8","9","10","11","12","13"];
    return pins.map(p => `<option value="${p}" ${p===selected?'selected':''}>${p}</option>`).join("");
  }

  // Read all selected pins from UI
  function readPinMap(listEl) {
    const map = {};
    $$(".ard-pin", listEl).forEach(sel => {
      const id  = sel.getAttribute("data-id");
      const val = (sel.value || "").toUpperCase().trim();
      // normalize simple numbers to numbers, keep A0..A7 as-is
      map[id] = (/^A\d+$/i.test(val) || /^\d+$/.test(val)) ? val.toUpperCase() : "A0";
    });
    return map;
  }

  // Settings from inputs
  function readSettings() {
    const { ssid, pass, host, token } = els();
    return {
      ssid:  (ssid?.value || "").trim() || "<WIFI_SSID>",
      pass:  (pass?.value || "").trim() || "<WIFI_PASS>",
      host:  (host?.value || "").trim() || "<YOUR_VERCEL_HOST>",
      token: (token?.value || "").trim() || "<INGEST_TOKEN>",
    };
  }

  // Generate full Arduino sketch
  function generateSketch(sensors, pinMap, settings) {
    const now = new Date();
    const ts  = now.toLocaleString();

    const sensorLines = sensors.map(s => {
      const pin = pinMap[s.id] || "A0";
      const comment = s.name ? ` // ${s.name}` : "";
      return `  { "${escapeForC(s.id)}", ${pin} },${comment}`;
    }).join("\n");

    return `/**
 * UNO R4 WiFi – Multi Soil Monitor (HTTPS → Vercel)
 * Auto-generiert von Plant Monitor – ${ts}
 *
 * Bitte trage unten SSID, Passwort, Host und Ingest-Token ein.
 * Die Sensorliste enthält ALLE registrierten Pflanzen (Sensor-IDs).
 */

#include <WiFiS3.h>

// ── USER SETTINGS ───────────────────────────────────────────────────────────
const char* WIFI_SSID    = "${escapeForC(settings.ssid)}";
const char* WIFI_PASS    = "${escapeForC(settings.pass)}";
const char* HOST         = "${escapeForC(settings.host)}";  // z.B. plant-monitor-xxx.vercel.app (ohne https://)
const int   HTTPS_PORT   = 443;
const char* API_PATH     = "/api/soil";
const char* INGEST_TOKEN = "${escapeForC(settings.token)}";

// Sende-Intervall & Timing
const unsigned long POST_INTERVAL_MS = 5000; // alle 5s EIN Sensor; bei N Sensoren also ~N*5s pro Sensor
const unsigned long CONNECT_WAIT_MS  = 8000;
const unsigned long DHCP_WAIT_MS     = 8000;
const unsigned long HTTPS_READ_MS    = 5000;

// ── SENSORS (Sensor-IDs, nicht die Pflanzennamen!) ─────────────────────────
struct SensorCfg { const char* id; int pin; };
SensorCfg SENSORS[] = {
${sensorLines}
};
const int SENSOR_COUNT = sizeof(SENSORS)/sizeof(SENSORS[0]);

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
    delay(1500);
  }
}

// robuste Messung: Median + Mean
int readSoilRaw(uint8_t pin, uint8_t n=7){
  if(!(n&1)) n++; if(n>15) n=15;
  int b[15];
  for(uint8_t i=0;i<n;i++){ b[i]=analogRead(pin); delayMicroseconds(200); }
  for(uint8_t i=1;i<n;i++){ int k=b[i], j=i-1; while(j>=0 && b[j]>k){ b[j+1]=b[j]; j--; } b[j+1]=k; }
  int med=b[n/2]; long sum=0; for(uint8_t i=0;i<n;i++) sum+=b[i]; int mean=sum/n;
  return (int)(0.7f*med + 0.3f*mean);
}

// direkter HTTPS-POST (korrektes JSON)
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

  // Statuszeile lesen
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

// ── LOOP ────────────────────────────────────────────────────────────────────
unsigned long nextSendAt = 0;
int sensorIndex = 0;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("Multi-Soil → Vercel (auto-generated)");
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
      int raw = readSoilRaw(s.pin);
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

  // Copy helper
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    }
  }

  // Small utils
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function escapeAttr(s){ return escapeHtml(s).replace(/"/g, "&quot;"); }
  function escapeForC(s){ return String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"'); }

  // Bind events (on every open to be safe)
  function bindEvents(sensors) {
    const { list, genBtn, copyBtn, code } = els();
    genBtn?.addEventListener("click", () => {
      const pins = readPinMap(list);
      const settings = readSettings();
      const sketch = generateSketch(sensors, pins, settings);
      code.value = sketch;
    });

    copyBtn?.addEventListener("click", async ()=>{
      if (!code?.value) return;
      const old = copyBtn.textContent;
      copyBtn.disabled = true;
      const ok = await copyToClipboard(code.value);
      copyBtn.textContent = ok ? "✓ Kopiert" : "✕ Kopieren fehlgeschlagen";
      setTimeout(()=>{ copyBtn.textContent = old; copyBtn.disabled = false; }, 1200);
    });
  }

  // Public open()
  async function open() {
    try {
      const E = els();
      // clear previous code
      if (E.code) E.code.value = "";
      // load sensors
      const sensors = await fetchSensors();
      renderList(E.list, sensors);
      bindEvents(sensors);
      // open modal
      try { E.modal?.showModal(); }
      catch { if (!E.modal?.open) E.modal?.setAttribute("open",""); }
    } catch (e) {
      alert("Arduino-Generator konnte nicht geladen werden.\n" + (e && e.message ? e.message : e));
      console.error(e);
    }
  }

  // expose
  window.ArduinoGen = { open };
})();
