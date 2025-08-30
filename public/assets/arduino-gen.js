//
//  arduino-gen.js
//  
//
//  Created by Loris Schulz on 31.08.25.
//
// file: public/assets/arduino-gen.js
// Lightweight, on-demand Arduino Code Generator
// Hängt sich als window.ArduinoGen an das globale Objekt.

(() => {
  const ANALOG_PINS = ["A0","A1","A2","A3","A4","A5"]; // UNO R4 WiFi
  const LS_KEY = "arduinoPinMap";

  // ------- Helpers -------
  const $ = (s) => document.querySelector(s);
  function getEls() {
    return {
      modal: $("#arduinoModal"),
      list: $("#arduinoList"),
      inSsid: $("#ard_ssid"),
      inPass: $("#ard_pass"),
      inHost: $("#ard_host"),
      inToken: $("#ard_token"),
      btnGen: $("#arduinoGenBtn"),
      btnCopy: $("#arduinoCopyBtn"),
      outCode: $("#arduinoCode"),
    };
  }
  function getSavedPinMap() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
  }
  function savePinMap(map) {
    localStorage.setItem(LS_KEY, JSON.stringify(map || {}));
  }
  function readPinMapFromUI() {
    const container = $("#arduinoList");
    const map = {};
    container?.querySelectorAll(".arduino-row").forEach(row => {
      const id = row.dataset.id;
      const sel = row.querySelector("select");
      const pin = sel?.value || "";
      if (id && pin) map[id] = pin;
    });
    return map;
  }
  function safeShowModal(dlg){
    if (!dlg) return;
    try { dlg.showModal(); }
    catch(e){ if (!dlg.open) dlg.setAttribute('open',''); }
  }

  async function fetchSensors() {
    const r = await fetch("/api/sensors", { cache: "no-store" });
    if (!r.ok) return [];
    const data = await r.json().catch(()=>({sensors:[]}));
    return Array.isArray(data.sensors) ? data.sensors : [];
  }

  function renderRows(sensors) {
    const els = getEls();
    const saved = getSavedPinMap();
    els.list.innerHTML = "";
    if (!sensors.length) {
      els.list.innerHTML = `<div class="arduino-row muted">Keine Pflanzen vorhanden – bitte zuerst eine Pflanze anlegen.</div>`;
      return;
    }
    sensors.forEach(s => {
      const row = document.createElement("div");
      row.className = "arduino-row";
      row.dataset.id = s.id;

      const label = document.createElement("div");
      label.innerHTML = `
        <div class="label">Pflanze</div>
        <div><strong>${escapeHtml(s.name || s.id)}</strong><span class="muted small"> &nbsp;(${escapeHtml(s.id)})</span></div>
      `;

      const selectWrap = document.createElement("div");
      selectWrap.innerHTML = `<label class="label">Analog-Pin</label>`;
      const sel = document.createElement("select");
      sel.className = "select pin-select";
      sel.innerHTML = `<option value="">— Pin wählen —</option>` + ANALOG_PINS.map(p=>`<option value="${p}">${p}</option>`).join("");
      if (saved[s.id]) sel.value = saved[s.id];
      selectWrap.appendChild(sel);

      const note = document.createElement("div");
      note.innerHTML = `
        <label class="label">Hinweis</label>
        <div class="muted small">Der gewählte Pin wird im Sketch für <code>${escapeHtml(s.id)}</code> verwendet.</div>
      `;

      row.appendChild(label);
      row.appendChild(selectWrap);
      row.appendChild(note);
      els.list.appendChild(row);

      sel.addEventListener("change", () => {
        const map = readPinMapFromUI();
        savePinMap(map);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function genSketch(sensors, pinMap, ssid, pass, host, token) {
    const mapped = sensors
      .map(s => ({ id: s.id, name: s.name || s.id, pin: pinMap[s.id] || "" }))
      .filter(x => x.pin); // nur mit zugewiesenem Pin

    const SENSOR_ARRAY = mapped.map(m => `  { "${m.id}", ${m.pin} }`).join(",\n");

    const sketch = `/**
 * UNO R4 WiFi – Multi Soil Monitor (HTTPS → Vercel)
 * Auto-generiert von Plant Monitor – ${new Date().toLocaleString()}
 *
 * Bitte trage unten SSID, Passwort, Host und Ingest-Token ein.
 * Die Sensorliste und Pins wurden aus deiner Website übernommen.
 */

#include <WiFiS3.h>

// ── USER SETTINGS ───────────────────────────────────────────────────────────
const char* WIFI_SSID  = "${escapeC(ssid || "<WIFI_SSID>")}";
const char* WIFI_PASS  = "${escapeC(pass || "<WIFI_PASS>")}";
const char* HOST       = "${escapeC(host || "<YOUR_VERCEL_HOST>")}";  // z.B. plant-monitor-xxx.vercel.app (ohne https://)
const int   HTTPS_PORT = 443;
const char* API_PATH   = "/api/soil";
const char* INGEST_TOKEN = "${escapeC(token || "<INGEST_TOKEN>")}";

// Sende-Intervall & Timing
const unsigned long POST_INTERVAL_MS = 5000; // alle 5s jeden Sensor senden
const unsigned long CONNECT_WAIT_MS  = 8000;
const unsigned long DHCP_WAIT_MS     = 8000;
const unsigned long HTTPS_READ_MS    = 5000;

// ── SENSOR LISTE (auto-generated) ───────────────────────────────────────────
struct SensorCfg { const char* id; int pin; };
SensorCfg SENSORS[] = {
${SENSOR_ARRAY || "  // (noch keine Pins ausgewählt – bitte in der Website die Pins zuordnen)"}
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

// stabile Messung an einem Analog-Pin: Median + Mean
int readSoilRaw(uint8_t pin, uint8_t n=7){
  if(!(n&1)) n++; if(n>15) n=15;
  int b[15];
  for(uint8_t i=0;i<n;i++){ b[i]=analogRead(pin); delayMicroseconds(200); }
  for(uint8_t i=1;i<n;i++){ int k=b[i], j=i-1; while(j>=0 && b[j]>k){ b[j+1]=b[j]; j--; } b[j+1]=k; }
  int med=b[n/2]; long sum=0; for(uint8_t i=0;i<n;i++) sum+=b[i]; int mean=sum/n;
  return (int)(0.7f*med + 0.3f*mean);
}

// direkter HTTPS-POST
bool postRawFor(const char* sensorId, int raw) {
  if (!net.connect(HOST, HTTPS_PORT)) return false;

  String body = String("{\"sensorId\":\"") + sensorId +
                "\",\"raw\":" + raw +
                ",\"token\":\"" + INGEST_TOKEN + "\"}";

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
      SensorCfg s = SENSORS[sensorIndex];
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
    return sketch;
  }

  function escapeC(s) {
    return String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"');
  }

  // ------- Public API -------
  async function open() {
    const els = getEls();
    // Liste rendern
    const sensors = await fetchSensors();
    renderRows(sensors);

    // Events (einmalig/pro re-open unkritisch)
    els.btnGen?.addEventListener("click", () => {
      const map = readPinMapFromUI();
      savePinMap(map);
      const code = genSketch(
        sensors,
        map,
        els.inSsid?.value || "",
        els.inPass?.value || "",
        els.inHost?.value || "",
        els.inToken?.value || ""
      );
      els.outCode.value = code;
      // Auto-resize (falls Styles so gesetzt sind)
      try {
        els.outCode.style.height = "auto";
        els.outCode.style.height = Math.max(280, els.outCode.scrollHeight + 2) + "px";
      } catch {}
    });

    els.btnCopy?.addEventListener("click", async () => {
      const txt = els.outCode?.value || "";
      try {
        await navigator.clipboard.writeText(txt);
        els.btnCopy.textContent = "Kopiert ✓";
        setTimeout(()=> els.btnCopy.textContent = "In Zwischenablage kopieren", 900);
      } catch {
        // Fallback
        els.outCode?.select();
        document.execCommand?.("copy");
      }
    });

    // Beim Öffnen gleich Code vorschlagen (nur wenn Pins vorhanden)
    const initialMap = getSavedPinMap();
    const code = genSketch(
      sensors,
      initialMap,
      els.inSsid?.value || "",
      els.inPass?.value || "",
      els.inHost?.value || "",
      els.inToken?.value || ""
    );
    els.outCode.value = code;

    safeShowModal(els.modal);
  }

  // Expose
  window.ArduinoGen = { open };
})();
