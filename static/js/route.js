// ================= GLOBAL =================
let map;
let siteLayer, sectorLayer;
let ringLayer, mainRouteLayer, altRouteLayer, samplingLayer;

let siteIndex = {};
let selectedSite = null;
let ringPoints = [];
let mainRouteData = null;
let altRouteData = null;

let activeRoute = 'main';

const SESSION_KEY       = 'siteIndexData';
const SESSION_ROUTE_KEY = 'routeSessionData';

const SECTOR_COLORS = ['#ff2d55','#00c7be','#ffcc00','#af52de','#ff9500','#34c759'];

// ================= INIT MAP =================
document.addEventListener("DOMContentLoaded", () => {
  const mapElement = document.getElementById("map");
  if (!mapElement) { console.log('⏭️ No map element'); return; }

  map = L.map("map").setView([-6.2, 106.816], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);

  siteLayer     = L.layerGroup().addTo(map);
  sectorLayer   = L.layerGroup().addTo(map);
  samplingLayer = L.layerGroup().addTo(map);

  createSiteBadge();
  setupEventListeners();
  restoreSiteIndex();
  restoreRouteSession();
});

// ================= RESTORE SITE INDEX =================
function restoreSiteIndex() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    if (!parsed || Object.keys(parsed).length === 0) return;
    siteIndex = parsed;
    renderSitesOnMap();
    populateSiteSearch();
    updateUploadStatus(`✅ ${Object.keys(siteIndex).length} site`);
  } catch (e) {
    console.warn('Gagal restore sessionStorage:', e);
    sessionStorage.removeItem(SESSION_KEY);
  }
}

// ================= RESTORE ROUTE SESSION =================
function restoreRouteSession() {
  const saved = sessionStorage.getItem(SESSION_ROUTE_KEY);
  if (!saved) return;

  let data;
  try { data = JSON.parse(saved); } catch { return; }
  if (!data || !data.selectedSite || !siteIndex[data.selectedSite]) return;

  selectedSite = data.selectedSite;
  activeRoute  = data.activeRoute || 'main';

  updateSiteBadge(selectedSite);
  const ssEl = document.getElementById('siteSearch');
  if (ssEl) ssEl.value = selectedSite;
  const csEl = document.getElementById('currentSite');
  if (csEl) csEl.textContent = selectedSite;

  const s = siteIndex[selectedSite];
  sectorLayer.clearLayers();
  s.sectors.forEach((az, idx) => drawSectorFan(s.lat, s.lng, az, 65, 100, idx));

  if (data.mainRoute && data.mainRoute.length) {
    mainRouteData = data.mainRouteData;
    const pts = data.mainRoute.map(p => [p.lat, p.lng]);
    mainRouteLayer = L.polyline(pts, { color: '#0015ff', weight: 7, opacity: 0.7 }).addTo(map);
    map.fitBounds(mainRouteLayer.getBounds());
    if (mainRouteData) {
      _updatePanelStats(mainRouteData, false);
      renderRoadAnalysis(mainRouteData, false);
    }
    const btn = document.getElementById('btnSimulate');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }
  }

  if (data.altRoute && data.altRoute.length) {
    altRouteData = data.altRouteData;
    const pts = data.altRoute.map(p => [p.lat, p.lng]);
    altRouteLayer = L.polyline(pts, { color: '#ff8800', weight: 7, opacity: 0.7 }).addTo(map);
    if (altRouteData) {
      _updatePanelStats(altRouteData, true);
      renderRoadAnalysis(altRouteData, true);
    }
  }

  if (mainRouteLayer && altRouteLayer) showRouteSelector();
  updateRouteSelectorUI();

  const banner = document.getElementById('sessionRestoreBanner');
  if (banner) {
    banner.style.display  = 'flex';
    banner.style.opacity  = '1';
    banner.style.transition = 'opacity 0.5s';
    setTimeout(() => {
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; }, 500);
    }, 3000);
  }

  updatePanelStatus('route',   'ok', `Rute dipulihkan — ${selectedSite}`);
  updatePanelStatus('road',    'ok', 'Data jalan siap');
  updatePanelStatus('session', 'ok', `Sesi aktif: ${selectedSite}`);

  console.log('[Session] ✅ Route session dipulihkan untuk site:', selectedSite);
}

// ================= SAVE / CLEAR ROUTE SESSION =================
function saveRouteSession() {
  if (!selectedSite) return;
  const data = {
    selectedSite,
    activeRoute,
    mainRoute    : mainRouteLayer ? mainRouteLayer.getLatLngs().map(p => ({ lat: p.lat, lng: p.lng })) : null,
    altRoute     : altRouteLayer  ? altRouteLayer.getLatLngs().map(p  => ({ lat: p.lat, lng: p.lng })) : null,
    mainRouteData: mainRouteData  || null,
    altRouteData : altRouteData   || null,
  };
  try {
    sessionStorage.setItem(SESSION_ROUTE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[Session] Gagal simpan route session:', e);
  }
}

function clearRouteSession() {
  sessionStorage.removeItem(SESSION_ROUTE_KEY);
}

// ================= RENDER SITES =================
function renderSitesOnMap() {
  siteLayer.clearLayers();
  sectorLayer.clearLayers();
  const cg = L.markerClusterGroup({
    chunkedLoading: true, chunkInterval: 100, chunkDelay: 50,
    maxClusterRadius: 60, disableClusteringAtZoom: 15, spiderfyOnMaxZoom: true
  });
  const bounds = [];
  Object.entries(siteIndex).forEach(([id, s]) => {
    bounds.push([s.lat, s.lng]);
    const m = L.circleMarker([s.lat, s.lng], {
      radius: 7, fillColor: "#ffd000", color: "#000", weight: 1.5, fillOpacity: 1
    });
    m.bindTooltip(id, { permanent: false, direction: "top", offset: [0,-8], className: 'site-label' });
    m.bindPopup(`<b>SITE: ${id}</b><br>Lat:${s.lat.toFixed(6)}<br>Lng:${s.lng.toFixed(6)}<br>Height:${s.height}m`);
    cg.addLayer(m);
  });
  siteLayer.addLayer(cg);
  if (bounds.length > 0) map.fitBounds(bounds);
}

// ================= EVENTS =================
function setupEventListeners() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  const fi = document.getElementById("fileInput");
  const ss = document.getElementById("siteSearch");
  if (fi) fi.addEventListener("change", processXLSX);
  if (ss) ss.addEventListener("input", onSiteSelect);
  on('btnGenerateRing', () => {
    const r = parseInt(document.getElementById('radiusSelect')?.value) || 150;
    generateRing(r);
  });
  on('btnMainRoute',    generateMainRoute);
  on('btnAltRoute',     generateAltRoute);
  on('btnSampling',     generateSampling);
  on('btnReset',        resetAll);
  on('btnExportKML',    exportToKML);
  on('btnSimulate',     goToSimulation);
  on('btnClearSite', () => {
    if (!confirm("Hapus data site? Harus upload XLSX lagi.")) return;
    sessionStorage.removeItem(SESSION_KEY);
    siteIndex = {};
    siteLayer.clearLayers();
    sectorLayer.clearLayers();
    populateSiteSearch();
    updateUploadStatus('');
  });
}

function updateUploadStatus(msg) {
  const el = document.getElementById("uploadStatus");
  if (el) el.textContent = msg;
}

// ================= UI BADGE =================
function createSiteBadge() {
  const badge = L.control({ position: "topright" });
  badge.onAdd = () => {
    const div = L.DomUtil.create("div", "site-badge");
    div.id = "siteBadge";
    div.style.cssText = "background:linear-gradient(135deg,#1f3c88,#2850b0);color:#fff;padding:12px 18px;border-radius:10px;font-weight:bold;display:none;box-shadow:0 4px 12px rgba(31,60,136,0.3);border:2px solid rgba(255,255,255,0.2)";
    return div;
  };
  badge.addTo(map);
}

function updateSiteBadge(id) {
  const b = document.getElementById("siteBadge");
  if (b) {
    b.style.display = "block";
    b.innerHTML = `SITE ID: <span style="font-size:18px;letter-spacing:1px">${id}</span>`;
  }
}

// ================= PANEL STATUS =================
function updatePanelStatus(key, state, text) {
  const cap    = key.charAt(0).toUpperCase() + key.slice(1);
  const dotEl  = document.getElementById('dot'    + cap);
  const textEl = document.getElementById('status' + cap);
  if (dotEl)  dotEl.className    = 'status-dot ' + state;
  if (textEl) textEl.textContent = text;
}

// ================= GEO UTILS =================
function destinationPoint(lat, lng, az, dist) {
  const R = 6378137, brng = az * Math.PI / 180, d = dist / R;
  const lat1 = lat * Math.PI / 180, lng1 = lng * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
}

function bearingBetween(a, b) {
  const y = Math.sin((b.lng - a.lng) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
  const x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180)
          - Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lng - a.lng) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function haversineM(a, b) {
  const R = 6378137, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const aa = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

// ================= NEIGHBOUR BUILDER =================
const MAX_NEIGHBOURS = 6;

function buildNeighbourList(servingSiteId) {
  const serving = siteIndex[servingSiteId];
  if (!serving) return [];

  const nb = Object.entries(siteIndex)
    .filter(([id]) => id !== servingSiteId)
    .map(([id, s]) => ({
      siteId    : id,
      lat       : s.lat,
      lng       : s.lng,
      height    : s.height    || 30,
      sectors   : s.sectors   || [],
      sectorData: s.sectorData || [],
      gnbId     : s.gnbId     || null,
      clutter   : s.clutter   || 'N/A',
      scenario  : s.scenario  || 'uma',
      condition : s.condition || 'nlos',
      _dist     : haversineM(serving, s),
    }))
    .sort((a, b) => a._dist - b._dist)
    .slice(0, MAX_NEIGHBOURS);

  nb.forEach(n => {
    const hasPCI = n.sectorData?.length > 0 && n.sectorData[0].pci !== null;
    console.log(`[Neighbour] ${n.siteId}: sectorData=${n.sectorData?.length} sektor, PCI ok=${hasPCI}`);
  });

  return nb.map(({ _dist, ...rest }) => rest);
}

// ================= XLSX PROCESSING =================
async function processXLSX(e) {
  const file = e.target.files[0];
  if (!file) return;
  const fileSizeMB = file.size / (1024 * 1024);
  const estimatedSeconds = Math.max(5, Math.round(2 + fileSizeMB * 30));
  showLoadingWithProgress('Mengunggah dan memproses data site...', 0, estimatedSeconds);
  const startTime = Date.now();
  let progressInterval;
  try {
    let fakeProgress = 0;
    progressInterval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      fakeProgress = Math.min(85, Math.round((elapsed / estimatedSeconds) * 85));
      updateLoadingProgress(fakeProgress, `Memproses file... (~${Math.max(0, estimatedSeconds - Math.round(elapsed))}s)`);
    }, 300);

    const formData = new FormData();
    formData.append('file', file);
    const res  = await fetch('/api/upload-site', { method: 'POST', body: formData });
    clearInterval(progressInterval);
    updateLoadingProgress(92, 'Menerima data dari server...');
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Upload gagal');
    updateLoadingProgress(97, 'Menyusun tampilan peta...');
    await new Promise(r => setTimeout(r, 150));

    siteIndex = json.siteIndex;

    const sampleId = Object.keys(siteIndex)[0];
    if (sampleId) {
      const sample        = siteIndex[sampleId];
      const hasSectorData = sample.sectorData && sample.sectorData.length > 0;
      const hasPCI        = hasSectorData && sample.sectorData[0].pci !== null;
      console.log(`[Upload] Sample ${sampleId}: sectorData=${hasSectorData}, PCI ok=${hasPCI}`);
      if (!hasSectorData) {
        console.warn('[Upload] PERINGATAN: sectorData TIDAK ADA di response backend!');
      } else if (!hasPCI) {
        console.warn('[Upload] PERINGATAN: sectorData ada tapi PCI null!');
      } else {
        console.log(`[Upload] ✅ sectorData & PCI OK! Sample PCI: ${sample.sectorData.map(s => s.pci).join(', ')}`);
      }
    }

    sessionStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex));
    renderSitesOnMap();
    populateSiteSearch();
    hideLoading();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    updateUploadStatus(`✅ ${json.siteCount} site`);
    alert(`✅ Berhasil load ${json.siteCount} site dari "${json.filename}" dalam ${elapsed} detik.`);
  } catch (err) {
    if (progressInterval) clearInterval(progressInterval);
    hideLoading();
    alert('❌ Gagal: ' + err.message);
  }
  e.target.value = '';
}

// ================= SEARCH =================
function populateSiteSearch() {
  const list = document.getElementById("siteList");
  if (!list) return;
  list.innerHTML = "";
  Object.keys(siteIndex).sort().forEach(id => {
    const o = document.createElement("option");
    o.value = id;
    list.appendChild(o);
  });
}

function onSiteSelect() {
  const id = document.getElementById("siteSearch").value.trim();
  if (!siteIndex[id]) return;
  selectedSite = id;
  updateSiteBadge(id);
  const el = document.getElementById("currentSite");
  if (el) el.textContent = id;
  sectorLayer.clearLayers();
  const s = siteIndex[id];
  s.sectors.forEach((az, idx) => drawSectorFan(s.lat, s.lng, az, 65, 100, idx));
  map.setView([s.lat, s.lng], 16);
}

// ================= SECTOR FAN =================
function drawSectorFan(lat, lng, az, beamwidth, radius, sectorIdx) {
  const start = az - beamwidth / 2, end = az + beamwidth / 2;
  const pts = [[lat, lng]];
  for (let i = 0; i <= 16; i++) {
    const ang = start + (i / 16) * (end - start);
    const p = destinationPoint(lat, lng, ang, radius);
    pts.push([p.lat, p.lng]);
  }
  pts.push([lat, lng]);
  const color = SECTOR_COLORS[sectorIdx % SECTOR_COLORS.length];
  L.polygon(pts, { color, fillColor: color, fillOpacity: 0.15, weight: 2, opacity: 0.6 })
    .addTo(sectorLayer)
    .bindPopup(`<b>Sektor ${sectorIdx + 1}</b><br>Azimuth: ${az}°`);
}

// ================= RING =================
function generateRing(radius = 150) {
  if (!selectedSite) return alert("⚠️ Pilih site dulu");
  if (ringLayer) map.removeLayer(ringLayer);
  ringPoints = [];
  const s = siteIndex[selectedSite];
  for (let d = 0; d <= 360; d += 10) ringPoints.push(destinationPoint(s.lat, s.lng, d, radius));
  ringLayer = L.polyline(ringPoints.map(p => [p.lat, p.lng]), { color: "#00ffff", dashArray: "6 6", weight: 2 }).addTo(map);
}

// ================= ROUTE =================
async function generateMainRoute() {
  if (!selectedSite) return alert("⚠️ Pilih site dulu");
  const r = parseInt(document.getElementById('radiusSelect')?.value) || 150;
  await buildRoute(r, false);
}

async function generateAltRoute() {
  if (!selectedSite) return alert("⚠️ Pilih site dulu");
  const r = parseInt(document.getElementById('radiusSelect')?.value) || 150;
  await buildRoute(Math.round(r * 1.6), true);
}

function showRouteSelector() {
  const el = document.getElementById("routeSelector");
  if (el) el.style.display = "block";
  updateRouteSelectorUI();
}

function updateRouteSelectorUI() {
  const bM = document.getElementById("btnSelectMain");
  const bA = document.getElementById("btnSelectAlt");
  if (bM) bM.className = "route-select-btn" + (activeRoute === 'main' ? " active-main" : "");
  if (bA) bA.className = "route-select-btn" + (activeRoute === 'alt'  ? " active-alt"  : "");
}

function setActiveRoute(type) {
  activeRoute = type;
  updateRouteSelectorUI();
  saveRouteSession();
}

function generateSampling() {
  if (!mainRouteLayer || !selectedSite) return alert("⚠️ Generate rute utama dulu");
  samplingLayer.clearLayers();
  const s = siteIndex[selectedSite], pts = mainRouteLayer.getLatLngs(), sp = {};
  s.sectors.forEach((az, idx) => {
    let best = null, minDiff = Infinity;
    pts.forEach((p, i) => {
      if (i === 0) return;
      const dir = bearingBetween({ lat: s.lat, lng: s.lng }, { lat: p.lat, lng: p.lng });
      let diff = Math.abs(dir - az);
      if (diff > 180) diff = 360 - diff;
      if (diff < 30 && diff < minDiff) { minDiff = diff; best = p; }
    });
    if (best) {
      sp[idx] = best;
      L.circleMarker(best, { radius: 6, fillColor: SECTOR_COLORS[idx % SECTOR_COLORS.length], color: '#000', weight: 2, fillOpacity: 1 })
        .addTo(samplingLayer)
        .bindPopup(`<b>📍 Sektor ${idx + 1}</b><br>Azimuth:${az}°`);
    }
  });
  const found = Object.values(sp).filter(p => p !== null).length;
  const el = document.getElementById("samplingCount");
  if (el) { el.textContent = `${found} titik`; el.classList.remove('empty'); }
  saveRouteSession();
  alert(`✅ ${found} titik sampling dari ${s.sectors.length} sektor`);
}

// ================= FILTER ISOLATED POINTS (OSRM TABLE) =================
/**
 * filterIsolatedPoints — buang ring points yang kemungkinan besar
 * berada di "sisi lain" barrier (jalan tol, sungai, dll).
 *
 * Cara kerja:
 *   1. 1 request ke OSRM Table endpoint (source = site, dest = semua ring points)
 *   2. Ring point dengan durasi driving > MAX_DURATION_SEC → terisolir → drop
 *   3. Fallback ke semua titik kalau hasil filter terlalu sedikit (< MIN_POINTS)
 *      atau kalau OSRM Table error — rute tetap bisa generate
 */
async function filterIsolatedPoints(points, site) {
  const MIN_POINTS       = 6;
  const MAX_DURATION_SEC = 240;

  try {
    // ── Step 1: OSRM Table (sama seperti sebelumnya) ──────────────────
    const allCoords = [site, ...points]
      .map(p => `${p.lng},${p.lat}`).join(';');

    const tableRes  = await fetch(
      `https://router.project-osrm.org/table/v1/driving/${allCoords}?sources=0&annotations=duration`
    );
    const tableJson = await tableRes.json();

    if (tableJson.code !== 'Ok' || !tableJson.durations?.[0]) {
      console.warn('[FilterPoints] Table gagal, fallback:', tableJson.code);
      return points;
    }

    const durations = tableJson.durations[0];

    // ── Step 2: Pisahkan titik "suspect" (durasi tinggi) ─────────────
    const suspectIndices = [];
    points.forEach((_, i) => {
      const dur = durations[i + 1];
      if (dur != null && dur > MAX_DURATION_SEC) suspectIndices.push(i);
    });

    // Kalau tidak ada suspect → return semua langsung
    if (suspectIndices.length === 0) return points;

    // ── Step 3: Cek OSRM Nearest untuk tiap titik suspect ────────────
    // Kalau snap distance < 80m → ada jalan di sana → KEEP (kondisi B)
    // Kalau snap distance ≥ 80m → tidak ada jalan / di atas tol → DROP (kondisi A)
    const SNAP_THRESHOLD_M = 80;

    const snapChecks = await Promise.all(
      suspectIndices.map(async (i) => {
        const pt = points[i];
        try {
          const res  = await fetch(
            `https://router.project-osrm.org/nearest/v1/driving/${pt.lng},${pt.lat}?number=1`
          );
          const json = await res.json();
          const nearest = json.waypoints?.[0];
          if (!nearest) return { i, drop: true };

          const snapDist = haversineM(pt, {
            lat: nearest.location[1],
            lng: nearest.location[0]
          });

          const drop = snapDist >= SNAP_THRESHOLD_M;
          console.log(
            `[FilterPoints] Titik ${i} (arah ~${i*10}°): durasi=${Math.round(durations[i+1])}s, ` +
            `snap=${Math.round(snapDist)}m → ${drop ? '❌ DROP (di atas tol/barrier)' : '✅ KEEP (ada jalan seberang tol)'}`
          );
          return { i, drop };
        } catch {
          return { i, drop: false }; // error → keep (aman)
        }
      })
    );

    // ── Step 4: Bangun set index yang benar-benar di-drop ────────────
    const dropSet = new Set(
      snapChecks.filter(r => r.drop).map(r => r.i)
    );

    const filtered = points.filter((_, i) => !dropSet.has(i));

    console.log(
      `[FilterPoints] ${points.length} titik → ${filtered.length} (drop ${dropSet.size}: ` +
      `${[...dropSet].map(i => `titik${i}(${i*10}°)`).join(', ')})`
    );

    return filtered.length >= MIN_POINTS ? filtered : points;

  } catch (err) {
    console.warn('[FilterPoints] Error, fallback:', err.message);
    return points;
  }
}

// ================= BUILD ROUTE =================
async function buildRoute(radius, isAlt) {
  if (!selectedSite) return;

  const routeType = isAlt ? "alternatif" : "utama";
  const div = document.getElementById("infoText");

  // Step 1 — Generate ring visual
  generateRing(radius);
  const rawCount = ringPoints.length;

  // Step 3 — Filter ring points via OSRM Table (1 API call)
  const site       = siteIndex[selectedSite];
  const safePoints = await filterIsolatedPoints(ringPoints, site);
  const dropped    = rawCount - safePoints.length;

  // Step 4 — OSRM Route dengan safe points
  const coords = safePoints.map(p => `${p.lng},${p.lat}`).join(";");
  const url    = `https://router.project-osrm.org/route/v1/driving/${coords}`
               + `?overview=full&geometries=geojson&steps=true`
               + `&annotations=speed,duration,distance`;

  try {
    const res  = await fetch(url);
    const json = await res.json();

    if (!json.routes?.length) throw new Error("Tidak ada rute");

    const route = json.routes[0];
    const pts   = route.geometry.coordinates.map(c => [c[1], c[0]]);

    if (isAlt  && altRouteLayer)  map.removeLayer(altRouteLayer);
    if (!isAlt && mainRouteLayer) map.removeLayer(mainRouteLayer);

    const layer = L.polyline(pts, {
      color  : isAlt ? "#ff8800" : "#0066ff",
      weight : 7,
      opacity: 0.7
    }).addTo(map);

    if (isAlt) {
      altRouteLayer = layer;
      altRouteData  = route;
      activeRoute   = 'alt';
      showRouteSelector();
    } else {
      mainRouteLayer = layer;
      mainRouteData  = route;
      if (altRouteLayer) showRouteSelector();
    }

    map.fitBounds(layer.getBounds());

    updateRouteInfo(route, isAlt);

    const btn = document.getElementById("btnSimulate");
    if (btn) {
      btn.disabled      = false;
      btn.style.opacity = "1";
      btn.style.cursor  = "pointer";
    }

  } catch (e) {
    if (div) {
      div.innerHTML = `❌ ${e.message || "Route error"}`;
      div.classList.add("show");
    }
    updatePanelStatus('route', 'danger', `❌ Gagal generate rute ${routeType}`);
    console.error('[BuildRoute] Error:', e);
  }
}

// ================= ROAD ANALYSIS =================
function analyzeRoadTypes(route) {
  const result = {
    totalDist   : 0,
    primary     : 0,
    secondary   : 0,
    residential : 0,
    service     : 0,
    restricted  : 0,
    uturns      : 0,
    hasMotorway : false,
    hasTunnel   : false,
    hasFerry    : false,
    hasToll     : false,
    avgSpeedKmh : 0,
    _speedSamples: [],
  };

  const legs = route.legs || [];

  legs.forEach(leg => {
    const annSpeeds = leg.annotation?.speed || [];
    annSpeeds.forEach(s => {
      if (s != null && s >= 0) result._speedSamples.push(s * 3.6);
    });

    const steps = leg.steps || [];
    steps.forEach(step => {
      const dist = step.distance || 0;
      const dur  = step.duration || 0;
      result.totalDist += dist;

      const stepSpeedKmh = dur > 0 ? (dist / dur) * 3.6 : 0;

      if      (stepSpeedKmh >= 60) result.primary     += dist;
      else if (stepSpeedKmh >= 30) result.secondary   += dist;
      else if (stepSpeedKmh >= 10) result.residential += dist;
      else if (stepSpeedKmh >  0)  result.service     += dist;

      (step.intersections || []).forEach(ix => {
        const classes = ix.classes || [];
        if (classes.includes('motorway'))   result.hasMotorway  = true;
        if (classes.includes('tunnel'))     result.hasTunnel    = true;
        if (classes.includes('ferry'))      result.hasFerry     = true;
        if (classes.includes('toll'))       result.hasToll      = true;
        if (classes.includes('restricted')) result.restricted  += (dist / Math.max(step.intersections.length, 1));
      });

      if (step.maneuver?.type === 'turn' && step.maneuver?.modifier === 'uturn') {
        result.uturns++;
      }
    });
  });

  const td = result.totalDist || 1;
  result.primaryPct     = Math.round((result.primary     / td) * 100);
  result.secondaryPct   = Math.round((result.secondary   / td) * 100);
  result.residentialPct = Math.round((result.residential / td) * 100);
  result.servicePct     = Math.round((result.service     / td) * 100);
  result.restrictedPct  = Math.round((result.restricted  / td) * 100);

  if (result._speedSamples.length > 0) {
    const sum = result._speedSamples.reduce((a, b) => a + b, 0);
    result.avgSpeedKmh = Math.round(sum / result._speedSamples.length);
  } else {
    const totalDur = legs.reduce((a, leg) => a + (leg.duration || 0), 0);
    result.avgSpeedKmh = totalDur > 0 ? Math.round((result.totalDist / totalDur) * 3.6) : 0;
  }

  console.log('[RoadAnalysis]', result);
  return result;
}

function renderRoadAnalysis(route, isAlt) {
  const boxId  = isAlt ? 'roadAnalysisAltBox' : 'roadAnalysisBox';
  const barsId = isAlt ? 'altRoadBars'        : 'mainRoadBars';
  const tagsId = isAlt ? 'altRoadTags'        : 'mainRoadTags';

  const box = document.getElementById(boxId);
  if (!box) return;

  const a = analyzeRoadTypes(route);

  const bars = [
    { label: '🛣️ Jalan Besar', pct: a.primaryPct,     cls: 'bar-primary'     },
    { label: '🚗 Jalan Lokal', pct: a.secondaryPct,   cls: 'bar-secondary'   },
    { label: '🏘️ Perumahan',   pct: a.residentialPct, cls: 'bar-residential' },
    { label: '🔧 Gang/Sempit', pct: a.servicePct,     cls: 'bar-service'     },
  ].filter(b => b.pct > 0);

  const barsEl = document.getElementById(barsId);
  if (barsEl) {
    barsEl.innerHTML = bars.map(b => `
      <div class="analysis-bar-row">
        <div class="analysis-bar-header">
          <span class="analysis-bar-label">${b.label}</span>
          <span class="analysis-bar-pct">${b.pct}%</span>
        </div>
        <div class="analysis-bar-track">
          <div class="analysis-bar-fill ${b.cls}" style="width:0%" data-target="${b.pct}"></div>
        </div>
      </div>
    `).join('');
    requestAnimationFrame(() => {
      barsEl.querySelectorAll('.analysis-bar-fill').forEach(el => {
        el.style.width = el.dataset.target + '%';
      });
    });
  }

  const tags = [];
  if (a.residentialPct >= 50) tags.push({ cls: 'tag-danger', text: `⚠️ Mayoritas perumahan (${a.residentialPct}%) — akses terbatas` });
  else if (a.residentialPct >= 25) tags.push({ cls: 'tag-warn', text: `🏘️ Sebagian perumahan (${a.residentialPct}%)` });
  if (a.servicePct >= 20) tags.push({ cls: 'tag-danger', text: `🔧 Banyak gang sempit (${a.servicePct}%) — perhatikan akses` });
  else if (a.servicePct >= 10) tags.push({ cls: 'tag-warn', text: `🔧 Ada gang sempit (${a.servicePct}%)` });
  if (a.uturns >= 3) tags.push({ cls: 'tag-danger', text: `↩️ ${a.uturns} potensi gang buntu (U-turn)` });
  else if (a.uturns > 0) tags.push({ cls: 'tag-warn', text: `↩️ ${a.uturns} titik U-turn` });
  if (a.hasMotorway) tags.push({ cls: 'tag-info',   text: '🛣️ Melewati jalan tol/bebas hambatan' });
  if (a.hasTunnel)   tags.push({ cls: 'tag-info',   text: '🚇 Melewati terowongan' });
  if (a.hasFerry)    tags.push({ cls: 'tag-warn',   text: '⛴️ Melewati jalur feri' });
  if (a.hasToll)     tags.push({ cls: 'tag-warn',   text: '💳 Ada titik berbayar/tol' });
  if (a.restrictedPct > 5) tags.push({ cls: 'tag-danger', text: `🚫 Area terbatas terdeteksi (${a.restrictedPct}%)` });
  if (a.avgSpeedKmh > 0 && a.avgSpeedKmh < 20) tags.push({ cls: 'tag-warn', text: `🐢 Kecepatan rata-rata rendah (${a.avgSpeedKmh} km/h)` });
  if (tags.length === 0) tags.push({ cls: 'tag-ok', text: '✅ Rute kondusif, tidak ada hambatan khusus' });

  const tagsEl = document.getElementById(tagsId);
  if (tagsEl) {
    tagsEl.innerHTML = tags.map(t => `<span class="analysis-tag ${t.cls}">${t.text}</span>`).join('');
  }

  box.style.display = 'block';

  if (!isAlt) {
    let areaState = 'ok', areaText = '';
    if      (a.residentialPct >= 50) { areaState = 'danger'; areaText = `Mayoritas perumahan (${a.residentialPct}%)`; }
    else if (a.residentialPct >= 25) { areaState = 'warn';   areaText = `Sebagian perumahan (${a.residentialPct}%)`; }
    else if (a.primaryPct >= 50)     { areaState = 'ok';     areaText = `Dominan jalan besar (${a.primaryPct}%)`; }
    else                             { areaState = 'ok';     areaText = `Jalan campuran, aman`; }
    updatePanelStatus('area', areaState, `🗺️ ${areaText}`);

    const accessProblems = [];
    if (a.uturns >= 3)       accessProblems.push(`${a.uturns} gang buntu`);
    if (a.servicePct >= 20)  accessProblems.push(`gang sempit ${a.servicePct}%`);
    if (a.restrictedPct > 5) accessProblems.push('area terbatas');
    if (a.hasFerry)          accessProblems.push('jalur feri');

    if (accessProblems.length > 0) {
      updatePanelStatus('access', 'danger', `⚠️ Perlu perhatian: ${accessProblems.join(', ')}`);
    } else if (a.residentialPct >= 25 || a.uturns > 0) {
      updatePanelStatus('access', 'warn', `⚠️ Akses perumahan, cek izin masuk`);
    } else {
      updatePanelStatus('access', 'ok', `✅ Akses jalan normal`);
    }
  }
}

// ================= UPDATE ROUTE INFO =================
function _updatePanelStats(route, isAlt) {
  const dist = (route.distance / 1000).toFixed(2);
  const dur  = Math.round(route.duration / 60);
  const spd  = Math.round((route.distance / route.duration) * 3.6);

  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = v;
    el.classList.remove('empty');
  };

  if (isAlt) {
    set('altDistance', `${dist} km`);
    set('altTime',     `${dur} mnt`);
    set('altSpeed',    `${spd} km/j`);
    set('altStatus',   '✅ Aktif');
    const badge = document.getElementById('altStatusBadge');
    if (badge) { badge.className = 'alt-status-badge generated'; badge.textContent = '🟢 Sudah di-generate'; }
  } else {
    set('totalDistance', `${dist} km`);
    set('estTime',       `${dur} mnt`);
    set('avgSpeed',      `${spd} km/j`);
  }
}

function updateRouteInfo(route, isAlt = false) {
  if (route.loading || route.error) return;

  _updatePanelStats(route, isAlt);
  renderRoadAnalysis(route, isAlt);

  if (isAlt) {
    updatePanelStatus('road', 'ok', 'Rute alternatif siap');
  } else {
    const dist = (route.distance / 1000).toFixed(2);
    updatePanelStatus('route',   'ok', `Rute utama siap — ${dist} km`);
    updatePanelStatus('road',    'ok', 'Data jalan teranalisis');
    updatePanelStatus('session', 'ok', `Sesi aktif: ${selectedSite || '—'}`);
  }

  saveRouteSession();
}

// ================= RESET ALL =================
function resetAll() {
  if (!confirm("Reset semua rute? Site data tetap.")) return;

  if (ringLayer)      map.removeLayer(ringLayer);
  if (mainRouteLayer) map.removeLayer(mainRouteLayer);
  if (altRouteLayer)  map.removeLayer(altRouteLayer);
  sectorLayer.clearLayers();
  samplingLayer.clearLayers();

  ringLayer = mainRouteLayer = altRouteLayer = mainRouteData = altRouteData = null;
  ringPoints = [];
  activeRoute = 'main';

  clearRouteSession();

  ['totalDistance','estTime','avgSpeed','samplingCount',
   'altDistance','altTime','altSpeed','altStatus'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = '—'; el.classList.add('empty'); }
  });

  const boxMain = document.getElementById('roadAnalysisBox');
  const boxAlt  = document.getElementById('roadAnalysisAltBox');
  if (boxMain) boxMain.style.display = 'none';
  if (boxAlt)  boxAlt.style.display  = 'none';

  const badge = document.getElementById('altStatusBadge');
  if (badge) { badge.className = 'alt-status-badge not-generated'; badge.textContent = '⚪ Belum di-generate'; }

  const banner = document.getElementById('sessionRestoreBanner');
  if (banner) banner.style.display = 'none';

  const infoDiv = document.getElementById('infoText');
  if (infoDiv) { infoDiv.innerHTML = ''; infoDiv.classList.remove('show'); }

  updatePanelStatus('route',   'waiting', 'Menunggu analisis rute...');
  updatePanelStatus('road',    'waiting', 'Menunggu analisis jalan...');
  updatePanelStatus('session', 'idle',    'Sesi rute: tidak ada');
  updatePanelStatus('area',    'idle',    'Tipe area: belum dianalisis');
  updatePanelStatus('access',  'idle',    'Potensi akses: belum dianalisis');

  const sel = document.getElementById("routeSelector");
  if (sel) sel.style.display = "none";

  const btn = document.getElementById("btnSimulate");
  if (btn) { btn.disabled = true; btn.style.opacity = "0.5"; btn.style.cursor = "not-allowed"; }

  if (selectedSite && siteIndex[selectedSite]) {
    const s = siteIndex[selectedSite];
    map.setView([s.lat, s.lng], 16);
    s.sectors.forEach((az, idx) => drawSectorFan(s.lat, s.lng, az, 65, 100, idx));
  }

  alert("✅ Reset berhasil!");
}

// ================= EXPORT KML =================
function exportToKML() {
  if (!mainRouteLayer && !altRouteLayer) return alert("⚠️ Belum ada rute!");
  const siteInfo = selectedSite ? siteIndex[selectedSite] : null, siteName = selectedSite || "Site";
  const esc = str => String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n<name>Route ${esc(siteName)}</name>\n`;
  kml += `<Style id="mr"><LineStyle><color>ffff6600</color><width>4</width></LineStyle></Style>\n`;
  kml += `<Style id="ar"><LineStyle><color>ff0088ff</color><width>4</width></LineStyle></Style>\n`;
  if (siteInfo) kml += `<Placemark><name>${esc(siteName)}</name><Point><coordinates>${siteInfo.lng},${siteInfo.lat},0</coordinates></Point></Placemark>\n`;
  if (mainRouteLayer) { const c = mainRouteLayer.getLatLngs().map(p => `${p.lng},${p.lat},0`).join(' '); kml += `<Placemark><name>Main Route</name><styleUrl>#mr</styleUrl><LineString><coordinates>${c}</coordinates></LineString></Placemark>\n`; }
  if (altRouteLayer)  { const c = altRouteLayer.getLatLngs().map(p  => `${p.lng},${p.lat},0`).join(' '); kml += `<Placemark><name>Alt Route</name><styleUrl>#ar</styleUrl><LineString><coordinates>${c}</coordinates></LineString></Placemark>\n`;  }
  kml += `</Document></kml>`;
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }));
  a.download = `Route_${siteName}_${ts}.kml`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ================= GO TO SIMULATION =================
function goToSimulation() {
  if (!selectedSite || !mainRouteLayer || !mainRouteData) return alert("⚠️ Generate rute utama terlebih dahulu!");
  if (activeRoute === 'alt' && (!altRouteLayer || !altRouteData)) return alert("⚠️ Rute alternatif belum di-generate!");

  const siteData    = siteIndex[selectedSite];
  const chosenLayer = activeRoute === 'alt' ? altRouteLayer : mainRouteLayer;
  const chosenData  = activeRoute === 'alt' ? altRouteData  : mainRouteData;
  const neighbours  = buildNeighbourList(selectedSite);

  console.log(`[goToSimulation] Site: ${selectedSite}`);
  if (!siteData.sectorData?.length) {
    console.error(`❌ sectorData KOSONG untuk serving site ${selectedSite}!`);
  }

  const driveTestData = {
    siteId     : selectedSite,
    activeRoute: activeRoute === 'alt' ? 'alt' : 'main',
    site: {
      lat       : siteData.lat,
      lng       : siteData.lng,
      height    : siteData.height    || 30,
      sectors   : siteData.sectors   || [],
      sectorData: siteData.sectorData || [],
      gnbId     : siteData.gnbId     || null,
      clutter   : siteData.clutter   || 'N/A',
      scenario  : siteData.scenario  || 'uma',
      condition : siteData.condition || 'nlos',
    },
    neighbours,
    mainRoute: {
      coords  : mainRouteLayer.getLatLngs().map(p => ({ lat: p.lat, lng: p.lng })),
      distance: mainRouteData.distance,
      duration: mainRouteData.duration,
    },
    altRoute: altRouteData ? {
      coords  : altRouteLayer.getLatLngs().map(p => ({ lat: p.lat, lng: p.lng })),
      distance: altRouteData.distance,
      duration: altRouteData.duration,
    } : null,
    activeRouteData: {
      coords  : chosenLayer.getLatLngs().map(p => ({ lat: p.lat, lng: p.lng })),
      distance: chosenData.distance,
      duration: chosenData.duration,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    sessionStorage.setItem('driveTestData', JSON.stringify(driveTestData));
    window.location.href = '/simulationroute';
  } catch (e) {
    alert("❌ Error menyimpan data: " + e.message);
  }
}

// ================= LOADING =================
function showLoadingWithProgress(text, progress, estimatedSeconds) {
  hideLoading();
  const overlay = document.createElement('div');
  overlay.className = 'loading-overlay';
  overlay.id = 'loadingOverlay';
  overlay.innerHTML = `
    <div class="loading-content">
      <div class="spinner"></div>
      <p class="loading-text" id="loadingText">${text}</p>
      ${estimatedSeconds !== null ? `
        <p class="loading-est">Estimasi: ~${estimatedSeconds} detik</p>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" id="progressBarFill" style="width:${progress}%"></div>
        </div>
        <p class="progress-label" id="progressLabel">${progress}%</p>` : ''}
    </div>`;
  document.body.appendChild(overlay);
}

function updateLoadingProgress(progress, text) {
  const fill  = document.getElementById('progressBarFill');
  const label = document.getElementById('progressLabel');
  const txt   = document.getElementById('loadingText');
  if (fill)  fill.style.width  = `${progress}%`;
  if (label) label.textContent = `${progress}%`;
  if (txt && text) txt.textContent = text;
}

function hideLoading() {
  document.getElementById('loadingOverlay')?.remove();
}

console.log('✅ route.js — filterIsolatedPoints (OSRM Table) aktif');