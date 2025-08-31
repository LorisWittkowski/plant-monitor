// file: public/assets/arduino-gen.js
// Arduino Generator – Live-Config, Slider, Round-Robin-Multi-Sensor
// Hängt sich an das bestehende Modal (#arduinoModal) in index.html.
// Öffnen via window.ArduinoGen.open()

(function(){
  const PIN_KEY = "arduinoPins"; // { [sensorId]: "A0" | "A1" | ... }
  const CFG_KEY = "arduinoCfg";  // persistierte Generator-Einstellungen

  // --- Helpers ---
  const $ = s => document.querySelector(s);
  const h = (l) => l.toString().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const nowStamp = () => {
    const d = new Date();
    const pad = n => n.toString().padStart(2,"0");
    return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const getPins = ()=> {
    try { return JSON.parse(localStorage.getItem(PIN_KEY) || "{}"); }
    catch { return {}; }
  };
  const setPins = (m)=> localStorage.setItem(PIN_KEY, JSON.stringify(m||{}));
  const getCfg = ()=> {
    const def = {
      postMs: 5000, samples: 7, retryMin: 4000, retryMax: 30000,
      connectMs: 8000, dhcpMs: 8000, readMs: 5000, logLevel: 2,
      ssid: "", pass: "", host: "", token: ""
    };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(CFG_KEY) || "{}")); }
    catch { return def; }
  };
  const setCfg = (c)=> localStorage.setItem(CFG_KEY, JSON.stringify(c||{}));

  // valid analog pin labels for UNO R4 WiFi
  const ANALOG_PINS = ["A0","A1","A2","A3","A4","A5"];

  // --- UI wiring ---
  async function open(){
    const dlg = $("#arduinoModal");
    if (!dlg) return;
    await refreshSensorsUI();
    bindConfigInputs();
    renderCode(); // live preview initial
    try { dlg.showModal(); } catch { dlg.setAttribute("open",""); }
  }

  async function fetchSensors(){
    const r = await fetch("/api/sensors", {cache:"no-store"});
    if (!r.ok) return [];
    const { sensors=[] } = await r.json();
    // Fallback name: id
    return sensors.map(s => ({ id: s.id, name: s.name || s.id }));
  }

  async function refreshSensorsUI(){
    const list = $("#arduinoList");
    if (!list) return;
    list.innerHTML = "";

    const sensors = await fetchSensors();
    const pins = getPins();

    if (!sensors.length){
      const d = document.createElement("div");
      d.className = "muted small";
      d.textContent = "Keine Pflanzen vorhanden. Lege zuerst welche an.";
      list.appendChild(d);
      return;
    }

    sensors.forEach(s=>{
      const row = document.createElement("div");
      row.className = "card subtle";
      row.style.padding = "10px";
      row.style.display = "flex";
      row.style.gap = "12px";
      row.style.alignItems = "center";
      row.innerHTML = `
        <div style="flex:1; min-width:0">
          <div class="mono" style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${h(s.name)}</div>
          <div class="muted small">${h(s.id)}</div>
        </div>
        <label class="field" style="min-width:120px">
          <span class="label">Analog-Pin</span>
          <select class="input pin-select" data-sid="${h(s.id)}">
            ${ANALOG_PINS.map(p => `<option value="${p}" ${pins[s.id]===p?'selected':''}>${p}</option>`).join("")}
          </select>
        </label>
      `;
      list.appendChild(row);
    });

    list.querySelectorAll(".pin-select").forEach(sel=>{
      sel.addEventListener("change", ()=>{
        const pinsCur = getPins();
        pinsCur[sel.dataset.sid] = sel.value;
        setPins(pinsCur);
        renderCode();
      });
    });
  }

  function bindConfigInputs(){
    const cfg = getCfg();

    const link = (id, lblId, key, transform = v=>v, fmt=v=>v) => {
      const el = $("#"+id), lbl = lblId ? $("#"+lblId) : null;
      if (!el) return;
      if (el.type === "range" || el.tagName === "SELECT") el.value = cfg[key];
      else el.value = cfg[key] || "";
      if (lbl) lbl.textContent = fmt(cfg[key]);
      el.addEventListener("input", ()=>{
        const cur = getCfg();
        cur[key] = transform(el.type==="range"||el.tagName==="SELECT" ? Number(el.value) : el.value);
        setCfg(cur);
        if (lbl) lbl.textContent = fmt(cur[key]);
        renderCode();
      });
      el.addEventListener("change", ()=>{ // ensure persist on select change
        const cur = getCfg();
        cur[key] = transform(el.type==="range"||el.tagName==="SELECT" ? Number(el.value) : el.value);
        setCfg(cur); renderCode();
      });
    };

    // sliders + selects
    link("ard_post_ms","ard_post_ms_lbl","postMs", Number, v=>String(v));
    link("ard_samples","ard_samples_lbl","samples", n=>Math.max(3, Math.min(15, Math.round(n)|1)), v=>String(v));
    link("ard_retry_min","ard_retry_min_lbl","retryMin", Number, v=>String(v));
    link("ard_retry_max","ard_retry_max_lbl","retryMax", Number, v=>String(v));
    link("ard_connect_ms","ard_connect_ms_lbl","connectMs", Number, v=>String(v));
    link("ard_dhcp_ms","ard_dhcp_ms_lbl","dhcpMs", Number, v=>String(v));
    link("ard_read_ms","ard_read_ms_lbl","readMs", Number, v=>String(v));
    link("ard_log_level",null,"logLevel", Number, v=>String(v));

    // text inputs
    ["ssid","pass","host","token"].forEach(k=>{
      const el = $("#ard_"+k);
      if (el) el.value = cfg[k] || "";
      el?.addEventListener("input", ()=>{ const c=getCfg(); c[k]=el.value; setCfg(c); renderCode(); });
    });

    // actions
    $("#arduinoGenBtn")?.addEventListener("click", renderCode);
    $("#arduinoCopyBtn")?.addEventListener("click", copyCode);
  }

  function copyCode(){
    const ta = $("#arduinoCode");
    if (!ta) return;
    ta.select(); ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    if (!ok && navigator.clipboard) navigator.clipboard.writeText(ta.value);
  }

  function renderCode(){
    const ta = $("#arduinoCode");
    if (!ta) return;

    const sensors = Object.entries(getPins()).map(([id,pin])=>({id, pin: pin||"A0"}));
    // Falls noch keine Pins gesetzt sind, lade aktuelle Sensors & mappe default A0..A5 reihum
    if (!sensors.length){
      // attempt to seed from UI
      document.querySelectorAll("#arduinoList .pin-select")?.forEach(sel=>{
        const sid = sel.getAttribute("data-sid");
        const pin = sel.value;
        const pins = getPins(); pins[sid]=pin; setPins(pins);
      });
    }

    const cfg = getCfg();
    const code = generateSketch({
      host: cfg.host || "<YOUR_VERCEL_HOST>",
      ssid: cfg.ssid || "<WIFI_SSID>",
      pass: cfg.pass || "<WIFI_PASS>",
      token: cfg.token || "<INGEST_TOKEN>",
      postMs: cfg.postMs,
      samples: cfg.samples,
      retryMin: cfg.retryMin,
      retryMax: cfg.retryMax,
      connectMs: cfg.connectMs,
      dhcpMs: cfg.dhcpMs,
      readMs: cfg.readMs,
      logLevel: cfg.logLevel,
      sensors: collectSensorsFromUI() // always read from UI to be exact
    });
    ta.value = code;
  }

  function collectSensorsFromUI(){
    const out = [];
    document.querySelectorAll("#arduinoList .pin-select")?.forEach(sel=>{
      const sid = sel.getAttribute("data-sid");
      const pin = sel.value;
      if (sid && pin) out.push({ id: sid, pin });
    });
    return out;
  }

  function generateSketch(opts){
    const {
      host, ssid, pass, token,
      postMs, samples, retryMin, retryMax,
      connectMs, dhcpMs, readMs, logLevel,
      sensors
    } = opts;

    const sanitized = sensors.filter(s=>s && s.id && ANALOG_PINS.includes(s.pin));
    const sensorLines = sanitized.map(s => `  { "${s.id}", ${s.pin} }`).join(",\n  ");

    const ts = nowStamp();

    return `/**
 * UNO R4 WiFi – Multi Soil Monitor (HTTPS → Vercel)
 * Auto-generiert von Plant Monitor – ${ts}
 *
 * Hinweise:
 *  - Host OHNE "https://", z. B. plant-monitor-xyz.vercel.app
 *  - Round-Robin: pro Loop wird genau EIN Sensor gelesen & gesendet
 *  - Effektives Intervall je Sensor ≈ POST_INTERVAL_MS × SENSOR_COUNT
 */

#include <WiFiS3.h>

// ── USER SETTINGS ───────────────────────────────────────────────────────────
const char* WIFI_SSID    = "${ssid}";
const char* WIFI_PASS    = "${pass}";
const char* HOST         = "${host}";
const int   HTTPS_PORT   = 443;
const char* API_PATH     = "/api/soil";
const char* INGEST_TOKEN = "${token}";

// ── TIMING ───────────────────────────────────────────────────────────────────
const unsigned long POST_INTERVAL_MS = ${postMs};   // je Loop: ein Sensor
const unsigned long RETRY_MIN_MS     = ${retryMin}; // Backoff Start
const unsigned long RETRY_MAX_MS     = ${retryMax}; // Backoff Max
const unsigned long CONNECT_WAIT_MS  = ${connectMs};
const unsigned long DHCP_WAIT_MS     = ${dhcpMs};
const unsigned long HTTPS_READ_MS    = ${readMs};

// ── SENSOREN (auto-generated) ───────────────────────────────────────────────
struct SensorCfg { const char* id; uint8_t pin; };
SensorCfg SENSORS[] = {
${sensorLines}
};
const int SENSOR_COUNT = sizeof(SENSORS)/sizeof(SENSORS[0]);

// ── NET ─────────────────────────────────────────────────────────────────────
WiFiSSLClient net;

// ── STATE ───────────────────────────────────────────────────────────────────
unsigned long nextPostAt   = 0;
unsigned long retryDelayMs = 0;
int sensorIndex            = 0;

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
        ${logLevel>=2 ? 'Serial.print("[WiFi] "); Serial.println(WiFi.localIP());' : '// connected'}
        return;
      }
    }
    delay(1500);
  }
}

// Messung: Median (robust) + Mean-Anteil; n wird geklammert (odd: 3..15)
int readSoilRaw(uint8_t pin, uint8_t n=${samples}){
  if(!(n&1)) n++; if(n<3) n=3; if(n>15) n=15;
  int b[15];
  for(uint8_t i=0;i<n;i++){ b[i]=analogRead(pin); delayMicroseconds(200); }
  for(uint8_t i=1;i<n;i++){ int k=b[i], j=i-1; while(j>=0 && b[j]>k){ b[j+1]=b[j]; j--; } b[j+1]=k; }
  int med=b[n/2]; long sum=0; for(uint8_t i=0;i<n;i++) sum+=b[i]; int mean=sum/n;
  return (int)(0.7f*med + 0.3f*mean);
}

// direkter HTTPS-POST (minimale Abhängigkeiten)
bool postRawFor(const char* sensorId, int raw) {
  if (!net.connect(HOST, HTTPS_PORT)) return false;

  String body = String("{\\"sensorId\\":\\"") + sensorId +
                "\\",\\"raw\\":" + raw +
                ",\\"token\\":\\"" + INGEST_TOKEN + "\\"}";

  String req =
    String("POST ") + API_PATH + " HTTP/1.1\\r\\n" +
    "Host: " + String(HOST) + "\\r\\n" +
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
    retryDelayMs = (retryDelayMs == 0) ? RETRY_MIN_MS : min((unsigned long)(retryDelayMs * 2), (unsigned long)RETRY_MAX_MS);
    nextPostAt = millis() + retryDelayMs;
  }
}

// ── ARDUINO LIFECYCLE ───────────────────────────────────────────────────────
void setup() {
  ${logLevel>=2 ? 'Serial.begin(115200); delay(200); Serial.println("Multi-Soil → Vercel (clean)");' : ''}
  for (int i=0; i<SENSOR_COUNT; i++){ pinMode(SENSORS[i].pin, INPUT); }
  ensureWiFi();
  nextPostAt = millis() + 1000;
}

void loop() {
  if (!(WiFi.status() == WL_CONNECTED && hasValidIP(WiFi.localIP()))) {
    ensureWiFi();
  }

  if (millis() >= nextPostAt) {
    if (SENSOR_COUNT > 0) {
      SensorCfg s = SENSORS[sensorIndex];
      int raw = readSoilRaw(s.pin);
      bool ok = postRawFor(s.id, raw);

      ${logLevel>=1 ? `
      Serial.print("["); Serial.print(s.id); Serial.print("] ");
      Serial.print("PIN="); Serial.print(s.pin);
      Serial.print(" RAW="); Serial.print(raw);
      Serial.print(" POST="); Serial.println(ok ? "OK" : "FAIL");` : ''}

      sensorIndex = (sensorIndex + 1) % SENSOR_COUNT;  // round-robin
      scheduleNext(ok);
    } else {
      nextPostAt = millis() + POST_INTERVAL_MS;
    }
  }
  delay(5);
}
`;
  }

  // expose
  window.ArduinoGen = { open };
})();
