// public/assets/app.js
// ————————————————————————————————————————————————————————————————
// Plant Monitor – Frontend Logic (Live, Chart, Calibration, Plant Info)
// - Dynamische Y-Skalierung (auf Basis der beobachteten %-Werte, 0..100-geklemmt)
// - Kalibrier-Spitzen werden kurzzeitig ausgeblendet (hush window)
// - Gaps im Zeitverlauf bleiben sichtbar (y:null → Linienunterbruch)
// - Prozentberechnung nutzt Server-Config (DRY/WET) mit Fallback auf RAW
// ————————————————————————————————————————————————————————————————

// ===== Config =====
const POLL_MS = 3000;
const RAW_MAX = 4095;
const SENSOR_ID = "soil-1";
const DEFAULT_RANGE = "1h"; // "1h" | "24h" | "7d"

// ===== State =====
let latest = null;
let config = null;
let lastSeenAt = null;
let currentDisplayedPercent = null;
let currentRange = DEFAULT_RANGE;
let plantProfile = null;

// ===== DOM =====
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const els = {
  // Live
  value: $("#value"),
  raw: $("#raw"),
  ts: $("#ts"),
  fill: $("#fill"),
  // Chart
  chart: $("#chart"),
  rangeButtons: () => $$(".range .btn"),
  // Theme
  themeToggle: $("#themeToggle"),
  // Calibration
  calibBtn: $("#calibBtn"),
  modal: $("#calibModal"),
  dryInput: $("#dryInput"),
  wetInput: $("#wetInput"),
  useDryNow: $("#useDryNow"),
  useWetNow: $("#useWetNow"),
  prevStep: $("#prevStep"),
  nextStep: $("#nextStep"),
  saveCalib: $("#saveCalib"),
  resetCalib: $("#resetCalib"),
  calibLabel: $("#calibLabel"),
  calibMeta: $("#calibMeta"),
  // Plant info
  pi_name: $("#pi_name"),
  pi_species: $("#pi_species"),
  pi_location: $("#pi_location"),
  pi_pot: $("#pi_pot"),
  pi_note: $("#pi_note"),
  saveInfo: $("#saveInfo"),
};

// ===== Theme =====
(function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();
els.themeToggle?.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  if (chart) chart.update(); // Chart übernimmt neue CSS-Farben
});

// ===== Helpers =====
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const cssVar = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
  fallback;

const asPercent = (raw) => {
  if (!config || config.rawDry == null || config.rawWet == null || config.rawDry === config.rawWet) {
    return clamp((raw / RAW_MAX) * 100, 0, 100); // Fallback ohne Kalibrierung
  }
  return clamp((100 * (raw - config.rawDry)) / (config.rawWet - config.rawDry), 0, 100);
};

// ===== Live UI =====
function updateLive(raw, atIso) {
  const p = asPercent(raw);
  els.fill.style.width = p.toFixed(1) + "%";
  const show = Math.round(p);
  if (currentDisplayedPercent == null || Math.abs(currentDisplayedPercent - p) >= 1) {
    els.value.textContent = show + "%";
  }
  currentDisplayedPercent = p;
  els.raw.textContent = raw;
  els.ts.textContent = new Date(atIso).toLocaleString();
}

// ===== Calibration Summary (im Dialog) =====
function renderCalibSummary() {
  if (!els.calibLabel || !els.calibMeta) return;
  if (config && typeof config.rawDry === "number" && typeof config.rawWet === "number") {
    els.calibLabel.textContent = `DRY: ${config.rawDry} · WET: ${config.rawWet}`;
    if (config.lastCalibrated) {
      const dt = new Date(config.lastCalibrated);
      els.calibMeta.textContent = `Zuletzt aktualisiert: ${dt.toLocaleString()}`;
    } else {
      els.calibMeta.textContent = `Kalibrierung aktiv.`;
    }
  } else {
    els.calibLabel.textContent = "Keine Kalibrierung gespeichert";
    els.calibMeta.textContent = "Fallback: Prozent aus RAW (0..4095).";
  }
}

// ===== Chart =====
let chart;

function initChart() {
  const ctx = els.chart.getContext("2d");
  chart = new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [{
      data: [],
      borderWidth: 2,
      tension: 0.35,
      fill: false,
      pointRadius: 0, // dynamisch bei wenigen Punkten
      borderColor: () => cssVar('--fg-strong', '#222')
    }]},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 350, easing: "easeOutCubic" },
      events: [],                       // keine Hover/Marker
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        decimation: { enabled: true, algorithm: 'lttb', samples: 120 }
      },
      scales: {
        x: { display: false },
        y: {
          // min/max werden dynamisch in setSeries() gesetzt
          grid: { display: false },
          ticks: { display: false },
          border: { display: true, color: cssVar('--muted', '#9a9a9b') }
        }
      },
      layout: { padding: 6 }
    }
  });
}

/**
 * Setzt die Serie im Chart.
 * - percent darf null sein (→ Lücken sichtbar).
 * - Kalibrier-Spitzen (direkt um lastCalibrated) werden ausgeblendet.
 * - Y-Achse wird dynamisch auf beobachtete Werte (0..100-geklemmt) + Padding gesetzt.
 */
function setSeries(points) {
  // 1) Normieren (y darf null sein → Gaps)
  let norm = (points || [])
    .map((p) => {
      const t = new Date(p.at || p.time || Date.now()).getTime();
      let y = null;
      if (typeof p.percent === "number") y = p.percent;
      else if (typeof p.raw === "number") y = (p.raw / RAW_MAX) * 100;
      else if (typeof p.rawAvg === "number") y = (p.rawAvg / RAW_MAX) * 100;
      return { t, y };
    })
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

  // 2) Kalibrier-Fenster ausblenden (verhindert dominierende Spikes)
  if (config?.lastCalibrated) {
    const CALIB_HUSH_BEFORE_MS = 30 * 1000; // 30s davor
    const CALIB_HUSH_AFTER_MS  = 60 * 1000; // 60s danach
    const t0 = new Date(config.lastCalibrated).getTime();
    norm = norm.map(p => {
      if (p.t >= (t0 - CALIB_HUSH_BEFORE_MS) && p.t <= (t0 + CALIB_HUSH_AFTER_MS)) {
        return { ...p, y: null }; // Lücke zeichnen
      }
      return p;
    });
  }

  // 3) Fallback: wenn komplett leer, aber latest vorhanden → 1 Marker
  if (norm.length === 0 && latest) {
    const t = new Date(latest.at).getTime();
    const y = (typeof latest.percent === "number") ? latest.percent : (latest.raw / RAW_MAX) * 100;
    norm.push({ t, y });
  }

  // 4) Hard Cap
  const HARD_CAP = 1200;
  const data = (norm.length > HARD_CAP) ? norm.slice(-HARD_CAP) : norm;

  // 5) Daten ins Chart
  chart.data.labels = data.map((d) => d.t);
  chart.data.datasets[0].data = data.map((d) => d.y); // null → Linienbruch

  // 6) Dynamische Y-Skalierung (0..100-geklemmt, mit sanftem Padding)
  const vals = data.map(d => d.y).filter(v => typeof v === "number" && isFinite(v));
  if (vals.length >= 1) {
    const minV = Math.max(0, Math.min(...vals));
    const maxV = Math.min(100, Math.max(...vals));
    const spread = Math.max(2, maxV - minV);              // min. 2 %-Punkte
    const pad = Math.min(6, Math.max(2, spread * 0.08));  // 2..6 % Padding
    chart.options.scales.y.min = Math.max(0, Math.floor((minV - pad) * 10) / 10);
    chart.options.scales.y.max = Math.min(100, Math.ceil((maxV + pad) * 10) / 10);
  } else {
    // nur Lücken → volle Skala
    chart.options.scales.y.min = 0;
    chart.options.scales.y.max = 100;
  }

  // 7) Marker bei sehr wenig Daten
  const nonNull = vals.length;
  chart.data.datasets[0].pointRadius = (nonNull < 2) ? 3 : 0;
  chart.options.plugins.decimation.enabled = (nonNull >= 200);

  chart.update();
}

// ===== Data Fetching =====
async function fetchSeries(range) {
  els.rangeButtons().forEach((b) => {
    const active = b.dataset.range === range;
    b.setAttribute("aria-selected", active ? "true" : "false");
  });

  try {
    const r = await fetch(
      `/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=${encodeURIComponent(range)}`,
      { cache: "no-store" }
    );
    if (r.status === 204) { setSeries([]); return; }
    const data = await r.json();
    if (data.config) { config = data.config; renderCalibSummary(); }
    if (data.latest) {
      latest = data.latest;
      updateLive(latest.raw, latest.at);
    }
    setSeries(data.series || []);
  } catch {
    setSeries([]); // Fallback
  }
}

async function pollLatest() {
  try {
    const r = await fetch(`/api/soil?sensorId=${encodeURIComponent(SENSOR_ID)}&range=latest`, { cache: "no-store" });
    if (r.status !== 200) return;
    const data = await r.json();
    if (!data.latest) return;
    const nowAt = data.latest.at;
    if (nowAt && nowAt !== lastSeenAt) {
      lastSeenAt = nowAt;
      config = data.config || config;
      renderCalibSummary();
      latest = data.latest;
      updateLive(latest.raw, latest.at);
      fetchSeries(currentRange);
    }
  } catch {}
}

// ===== Plant Info =====
function fillInfoUI() {
  const p = plantProfile || {};
  els.pi_name && (els.pi_name.value = p.name ?? "");
  els.pi_species && (els.pi_species.value = p.species ?? "");
  els.pi_location && (els.pi_location.value = p.location ?? "");
  els.pi_pot && (els.pi_pot.value = (p.potCm != null ? String(p.potCm) : ""));
  els.pi_note && (els.pi_note.value = p.note ?? "");
}

async function fetchPlant() {
  try {
    const r = await fetch(`/api/plant?sensorId=${encodeURIComponent(SENSOR_ID)}`, { cache: "no-store" });
    if (r.status === 204) { plantProfile = null; fillInfoUI(); return; }
    const data = await r.json();
    plantProfile = data.profile || null;
    fillInfoUI();
  } catch {}
}

function normalizeEmptyToNull(v) {
  if (v == null) return null;
  const t = (typeof v === "string") ? v.trim() : v;
  if (t === "" || t === undefined) return null;
  return t;
}

async function savePlantProfile() {
  const btn = els.saveInfo;
  if (!btn) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Speichere…";

  const body = {
    sensorId: SENSOR_ID,
    profile: {
      name: normalizeEmptyToNull(els.pi_name?.value),
      species: normalizeEmptyToNull(els.pi_species?.value),
      location: normalizeEmptyToNull(els.pi_location?.value),
      potCm: normalizeEmptyToNull(els.pi_pot?.value ? Number(els.pi_pot.value) : null),
      note: normalizeEmptyToNull(els.pi_note?.value),
    },
  };

  try {
    const r = await fetch("/api/plant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("save failed");
    btn.textContent = "Gespeichert ✓";
    await fetchPlant();
  } catch {
    btn.textContent = "Fehler ❌";
  } finally {
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 900);
  }
}

// ===== Calibration Flow =====
function showStep(n) {
  $$(".modal .step").forEach((sec) => (sec.hidden = Number(sec.dataset.step) !== n));
  $$(".steps-dots .dot").forEach((dot) => dot.classList.toggle("active", Number(dot.dataset.step) === n));
  if (els.prevStep) els.prevStep.style.visibility = n === 1 ? "hidden" : "visible";
  if (els.nextStep) els.nextStep.hidden = n === 2;
  if (els.saveCalib) els.saveCalib.hidden = n !== 2;
}

els.calibBtn?.addEventListener("click", () => {
  renderCalibSummary();
  els.modal?.showModal();
  showStep(1);
});
els.prevStep?.addEventListener("click", () => showStep(1));
els.nextStep?.addEventListener("click", () => showStep(2));
els.useDryNow?.addEventListener("click", () => { if (latest && els.dryInput) els.dryInput.value = latest.raw; });
els.useWetNow?.addEventListener("click", () => { if (latest && els.wetInput) els.wetInput.value = latest.raw; });

els.saveCalib?.addEventListener("click", async () => {
  const rawDry = Number(els.dryInput?.value);
  const rawWet = Number(els.wetInput?.value);
  if (!Number.isFinite(rawDry) || !Number.isFinite(rawWet)) { alert("Bitte DRY und WET RAW eingeben."); return; }
  const resp = await fetch("/api/calibrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sensorId: SENSOR_ID, rawDry, rawWet }),
  });
  if (resp.ok) {
    els.modal?.close();
    await fetchSeries(currentRange); // lädt config neu (inkl. lastCalibrated)
  } else {
    alert("Kalibrierung fehlgeschlagen.");
  }
});

els.resetCalib?.addEventListener("click", async () => {
  if (!confirm("Kalibrierung zurücksetzen?")) return;
  await fetch("/api/calibrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sensorId: SENSOR_ID, reset: true }),
  });
  await fetchSeries(currentRange);
  renderCalibSummary();
});

// ===== Range & Init =====
els.rangeButtons().forEach((b) => {
  b.addEventListener("click", () => {
    currentRange = b.dataset.range;
    localStorage.setItem("range", currentRange);
    fetchSeries(currentRange);
  });
});

(function init() {
  const savedRange = localStorage.getItem("range");
  if (savedRange && ["1h", "24h", "7d"].includes(savedRange)) currentRange = savedRange;

  initChart();
  fetchSeries(currentRange);
  fetchPlant();
  setInterval(pollLatest, POLL_MS);
})();
