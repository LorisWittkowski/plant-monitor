const fill = document.getElementById("fill");
const valueEl = document.getElementById("value");
const tsEl = document.getElementById("timestamp");
const liveDot = document.getElementById("liveDot");
const statusEl = document.getElementById("status");
const demoToggle = document.getElementById("demoToggle");
const demoSlider = document.getElementById("demoSlider");
const demoVal = document.getElementById("demoVal");


let lastOk = 0;
let demoMode = false;


function updateUI(percent, isoTs) {
const clamped = Math.max(0, Math.min(100, percent));
fill.style.width = clamped + "%";
valueEl.textContent = clamped.toFixed(0) + "%";
tsEl.textContent = isoTs ? new Date(isoTs).toLocaleString() : "—";
document.documentElement.style.setProperty("--accent",
clamped < 25 ? "#f59e0b" : (clamped < 60 ? "#6ee7b7" : "#60a5fa")
);
}


function updateLive() {
const alive = (Date.now() - lastOk) < 10_000; // 10s seit letztem OK
liveDot.classList.toggle("live", alive);
statusEl.textContent = alive ? "live" : "offline";
}


async function fetchMoisture() {
if (demoMode) {
const m = Number(demoSlider.value);
updateUI(m, new Date().toISOString());
lastOk = Date.now();
return updateLive();
}
try {
// Platzhalter: später echte API wie /api/soil
// Aktuell: wenn keine API existiert, fallback auf Demo-Mode
const res = await fetch("/api/soil", { cache: "no-store" });
if (res.ok) {
const data = await res.json();
const m = Number(data.moisture);
if (Number.isFinite(m)) {
updateUI(m, data.at);
lastOk = Date.now();
}
} else if (res.status === 404 || res.status === 204) {
// Kein Backend vorhanden → Demo aktivieren
demoToggle.checked = true; setDemo(true);
}
} catch (_) {
// still bleiben
}
updateLive();
}


function setDemo(on) {
demoMode = on;
demoSlider.disabled = !on;
demoVal.textContent = demoSlider.value + "%";
}


demoToggle.addEventListener("change", (e) => setDemo(e.target.checked));
demoSlider.addEventListener("input", () => {
demoVal.textContent = demoSlider.value + "%";
if (demoMode) updateUI(Number(demoSlider.value), new Date().toISOString());
});


fetchMoisture();
setInterval(fetchMoisture, 3000);
setInterval(updateLive, 1000);