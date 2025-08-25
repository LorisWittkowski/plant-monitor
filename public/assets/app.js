// public/assets/app.js

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
    calibMeta: $("#calibMeta"),
    calDry: $("#calDry"),
    calWet: $("#calWet"),
    calDate: $("#calDate"),

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

function renderCalibrationMeta() {
  const has = config && Number.isFinite(config?.rawDry) && Number.isFinite(config?.rawWet);
  if (!has) {
    els.calibMeta?.setAttribute("hidden", "true");
    return;
  }
  els.calibMeta?.removeAttribute("hidden");
  els.calDry && (els.calDry.textContent = Math.round(config.rawDry));
  els.calWet && (els.calWet.textContent = Math.round(config.rawWet));
  if (config.lastCalibrated) {
    const d = new Date(config.lastCalibrated);
    els.calDate.textContent = "· " + d.toLocaleDateString() + ", " + d.toLocaleTimeString();
  } else {
    els.calDate.textContent = "";
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
          min: 0, max: 100,
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
 * - Erwartet Punkte [{at, percent}] – percent darf auch null sein (→ Linienbruch).
 * - Fallback: wenn komplett leer, aber latest vorhanden → 1 Marker.
 */
function setSeries(points) {
  const norm = (points || [])
    .map((p) => {
      const t = new Date(p.at || p.time || Date.now()).getTime();
      let y = null;
      if (typeof p.percent === "number") y = p.percent;
      else if (typeof p.raw === "number") y = (p.raw / RAW_MAX) * 100;
      else if (typeof p.rawAvg === "number") y = (p.rawAvg / RAW_MAX) * 100;
      return { t, y };
    })
    .filter((p) => Number.isFinite(p.t)) // Zeit muss valide sein, y darf null sein
    .sort((a, b) => a.t - b.t);

  if (norm.length === 0 && latest) {
    const t = new Date(latest.at).getTime();
    const y = (typeof latest.percent === "number") ? latest.percent : (latest.raw / RAW_MAX) * 100;
    norm.push({ t, y });
  }

  const HARD_CAP = 1200;
  const data = (norm.length > HARD_CAP) ? norm.slice(-HARD_CAP) : norm;

  chart.data.labels = data.map((d) => d.t);
  chart.data.datasets[0].data = data.map((d) => d.y); // null => Linienbruch

  // Markerlogik: Wenn <2 non-null Punkte → Marker sichtbar, sonst keine
  const nonNull = data.filter((d) => typeof d.y === "number").length;
  chart.data.datasets[0].pointRadius = (nonNull < 2) ? 3 : 0;
  chart.options.plugins.decimation.enabled = (nonNull >= 200);

  chart.update();
}

// ===== Data Fetching =====
async function fetchSeries(range) {
  // UI: active Range
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
    if (data.config) config = data.config;
    renderCalibrationMeta();
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
      renderCalibrationMeta();
      latest = data.latest;
      updateLive(latest.raw, latest.at);
      // Bei neuem Wert die aktuelle Range neu laden
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

// ===== Calibration =====
function showStep(n) {
  $$(".modal .step").forEach((sec) => (sec.hidden = Number(sec.dataset.step) !== n));
  $$(".steps-dots .dot").forEach((dot) => dot.classList.toggle("active", Number(dot.dataset.step) === n));
  if (els.prevStep) els.prevStep.style.visibility = n === 1 ? "hidden" : "visible";
  if (els.nextStep) els.nextStep.hidden = n === 2;
  if (els.saveCalib) els.saveCalib.hidden = n !== 2;
}

els.calibBtn?.addEventListener("click", () => {
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
    await fetchSeries(currentRange);
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
});

// ===== Events =====
els.rangeButtons().forEach((b) => {
  b.addEventListener("click", () => {
    currentRange = b.dataset.range;
    localStorage.setItem("range", currentRange);
    fetchSeries(currentRange);
  });
});
els.saveInfo?.addEventListener("click", savePlantProfile);

// ===== Init =====
(function init() {
  const savedRange = localStorage.getItem("range");
  if (savedRange && ["1h", "24h", "7d"].includes(savedRange)) currentRange = savedRange;

  initChart();
  fetchSeries(currentRange);
  fetchPlant();
  setInterval(pollLatest, POLL_MS);
})();
