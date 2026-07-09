'use strict';
// ================================================
// NEW SITE PLANNING — PURE v1.0
// Halaman perencanaan site baru standalone.
// TIDAK ada before/after, TIDAK ada gap-guided.
//
// Fitur utama:
//   - User taruh site baru di mana saja di peta
//   - Kalkulasi coverage RSRP & SINR via 3GPP TR 38.901
//   - Neighbour dari siteIndex dijadikan INTERFERER SINR
//   - Tidak ada ketergantungan session dari halaman lain
//
// Model propagasi: 3GPP TR 38.901 (UMa/UMi/RMa LOS/NLOS)
// Referensi: identik coverage.js & simulation_dt.js
// ================================================

let map;
let sectorLayer, coverageLayer;
let newSiteMarker       = null;
let currentSiteLocation = null;
let currentCoverageType = 'rsrp';
let sectorCount         = 3;
let azimuths            = [];
let siteIndex           = {};
let neighbourSites      = [];   // site tetangga dari siteIndex untuk SINR

const SESSION_KEY   = 'siteIndexData';
const MAX_NEIGHBOUR = 6;

const SECTOR_COLORS = ['#ff2d55','#00c7be','#ffcc00','#af52de','#ff9500','#34c759'];

// ── Konstanta fisik (3GPP TR 38.901) ─────────────────────────────────────
const PARAM_DEFAULTS = {
  TX_POWER  : 46,
  FREQUENCY : 2300,
  BANDWIDTH : 20,
  ANTENNA_Am: 25,
  BEAMWIDTH : 35,
  NF        : 7,
  SCENARIO  : 'uma',
  CONDITION : 'nlos',
  CLUTTER   : 'urban',
};

const MOBILE_H               = 1.5;
const RX_SENSITIVITY_FLOOR   = -125.2;
const INTERFERENCE_MARGIN_DB = 2.0;
const INTERFERENCE_MARGIN_FACTOR = Math.pow(10, INTERFERENCE_MARGIN_DB / 10);
const DOMINANT_INTERFERER_THRESHOLD_DB = 30;

// [FIX-8-EQUIV] Ambang "coverage exist" — dipakai konsisten sebagai basis
// band terlemah kontur DAN sebagai penentu apakah suatu titik dianggap
// masih tercover (dipakai untuk masking SINR matrix). Selaras dengan
// GAP_CFG.RSRP_BLANK di coverage.js supaya definisi antar halaman senada.
const RSRP_BLANK_THRESHOLD = -120;

const SHADOW_STD_3GPP = {
  uma_los: 4.0, uma_nlos: 6.0, uma_los_nlos: 5.5,
  umi_los: 4.0, umi_nlos: 7.82, umi_los_nlos: 7.0,
  rma_los: 4.0, rma_nlos: 8.0, rma_los_nlos: 6.5,
};

const CLUTTER_LOSS_DB = {
  dense_urban: 0.0, metropolitan: 0.0, urban: 0.0,
  suburban: 1.0, sub_urban: 1.0, rural: 0.5, open: 0.0,
  industrial: 2.0, forest: 3.0, water: -1.0, highway: -1.5, 'n/a': 0.0,
};

// ── Helper ────────────────────────────────────────────────────────────────
function getParams() {
  const num = (id, def) => { const el = document.getElementById(id); if (!el) return def; const v = parseFloat(el.value); return isFinite(v) ? v : def; };
  const str = (id, def) => { const el = document.getElementById(id); return el?.value || def; };
  const bwMhz = num('bwPure', PARAM_DEFAULTS.BANDWIDTH);
  const bwHz  = bwMhz * 1e6;
  const nf    = PARAM_DEFAULTS.NF;
  const thermalNoise = -174 + 10 * Math.log10(bwHz) + nf;
  return {
    TX_POWER     : num('txPure',   PARAM_DEFAULTS.TX_POWER),
    FREQUENCY    : num('freqPure', PARAM_DEFAULTS.FREQUENCY),
    BANDWIDTH    : bwMhz,
    BANDWIDTH_HZ : bwHz,
    NF           : nf,
    ANTENNA_Am   : PARAM_DEFAULTS.ANTENNA_Am,
    BEAMWIDTH    : PARAM_DEFAULTS.BEAMWIDTH,
    SCENARIO     : str('scenarioPure',  PARAM_DEFAULTS.SCENARIO),
    CONDITION    : str('conditionPure', PARAM_DEFAULTS.CONDITION),
    CLUTTER      : str('clutterPure',   PARAM_DEFAULTS.CLUTTER),
    THERMAL_NOISE_DBM: thermalNoise,
    THERMAL_NOISE_LIN: Math.pow(10, thermalNoise / 10),
    SINR_FLOOR: -10, SINR_CEIL: 40,
  };
}

function getClutterLoss(name) {
  const key = (name || 'n/a').toLowerCase().replace(/[\s-]+/g, '_');
  if (CLUTTER_LOSS_DB[key] !== undefined) return CLUTTER_LOSS_DB[key];
  for (const [k, v] of Object.entries(CLUTTER_LOSS_DB)) if (key.includes(k) || k.includes(key)) return v;
  return CLUTTER_LOSS_DB['n/a'];
}
function getShadowStd(sc, cond) { return SHADOW_STD_3GPP[`${sc}_${cond}`] || 6.0; }
function dbmToLinear(d) { return Math.pow(10, d / 10); }
function linearToDbm(m) { return 10 * Math.log10(Math.max(m, 1e-15)); }

// ── Path loss TR 38.901 ───────────────────────────────────────────────────
function pathLoss(scenario, condition, dist_m, freq_mhz, hBS, hUT) {
  const d = Math.max(dist_m, 10), hU = hUT || MOBILE_H, fc = freq_mhz / 1000, c = 3e8;
  const d3D = Math.sqrt(d * d + (hBS - hU) ** 2);
  const pLOS_UMa = d2 => { if (d2 <= 18) return 1; const C = hU <= 13 ? 0 : Math.pow((hU - 13) / 10, 1.5); return (18 / d2 + Math.exp(-d2 / 63) * (1 - 18 / d2)) * (1 + C * (5 / 4) * Math.pow(d2 / 100, 3) * Math.exp(-d2 / 150)); };
  const pLOS_UMi = d2 => d2 <= 18 ? 1 : 18 / d2 + Math.exp(-d2 / 36) * (1 - 18 / d2);
  switch (scenario) {
    case 'uma': {
      const hE = 1, dBP = 4 * (hBS - hE) * (hU - hE) * (freq_mhz * 1e6) / c;
      const pl_los = d <= dBP
        ? 28 + 22 * Math.log10(d3D) + 20 * Math.log10(fc)
        : 28 + 40 * Math.log10(d3D) + 20 * Math.log10(fc) - 9 * Math.log10(dBP ** 2 + (hBS - hU) ** 2);
      if (condition === 'los') return pl_los;
      const pl_nlos = Math.max(13.54 + 39.08 * Math.log10(d3D) + 20 * Math.log10(fc) - 0.6 * (hU - 1.5), pl_los);
      if (condition === 'nlos') return pl_nlos;
      const p = pLOS_UMa(d); return p * pl_los + (1 - p) * pl_nlos;
    }
    case 'umi': {
      const hE = 1, dBP = 4 * (hBS - hE) * (hU - hE) * (freq_mhz * 1e6) / c;
      const pl_los = d <= dBP
        ? 32.4 + 21 * Math.log10(d3D) + 20 * Math.log10(fc)
        : 32.4 + 40 * Math.log10(d3D) + 20 * Math.log10(fc) - 9.5 * Math.log10(dBP ** 2 + (hBS - hU) ** 2);
      if (condition === 'los') return pl_los;
      const pl_nlos = Math.max(22.4 + 35.3 * Math.log10(d3D) + 21.3 * Math.log10(fc) - 0.3 * (hU - 1.5), pl_los);
      if (condition === 'nlos') return pl_nlos;
      const p = pLOS_UMi(d); return p * pl_los + (1 - p) * pl_nlos;
    }
    case 'rma': {
      const h = 5, W = 20, dBP = 2 * Math.PI * hBS * hU * (freq_mhz * 1e6) / c;
      const A1 = Math.min(0.03 * Math.pow(h, 1.72), 10), A2 = Math.min(0.044 * Math.pow(h, 1.72), 14.77), A3 = 0.002 * Math.log10(h);
      let pl_los;
      if (d <= dBP) { pl_los = 20 * Math.log10(40 * Math.PI * d3D * fc / 3) + A1 * Math.log10(d3D) - A2 + A3 * d3D; }
      else { const d3D_BP = Math.sqrt(dBP ** 2 + (hBS - hU) ** 2); pl_los = 20 * Math.log10(40 * Math.PI * d3D_BP * fc / 3) + A1 * Math.log10(d3D_BP) - A2 + A3 * d3D_BP + 40 * Math.log10(d3D / d3D_BP); }
      if (condition === 'los') return pl_los;
      return Math.max(161.04 - 7.1 * Math.log10(W) + 7.5 * Math.log10(h) - (24.37 - 3.7 * (h / hBS) ** 2) * Math.log10(hBS) + (43.42 - 3.1 * Math.log10(hBS)) * (Math.log10(d3D) - 3) + 20 * Math.log10(fc) - (3.2 * (Math.log10(11.75 * hU)) ** 2 - 4.97), pl_los);
    }
    default: return 28 + 22 * Math.log10(d3D) + 20 * Math.log10(fc);
  }
}

// ── Antenna gain TR 36.942 ────────────────────────────────────────────────
// [FIX-6-EQUIV] Sama seperti perbaikan di coverage.js: θ_3dB pada formula
// TR 36.942 adalah BEAMWIDTH PENUH, bukan setengahnya. offset/(bw/2) yang
// lama membuat sektor terlalu tajam (di offset=bw/2 harusnya -3dB, bukan -12dB).
function antennaGain(offset, bw, Am) { return -Math.min(12 * (offset / bw) ** 2, Am); }
function bestSectorGain(brng, sectors, bw, Am) {
  if (!sectors?.length) return { gain: 0 };
  let best = -Infinity;
  sectors.forEach(az => { const g = antennaGain(Math.abs(((brng - az + 540) % 360) - 180), bw, Am); if (g > best) best = g; });
  return { gain: best };
}

// ── Shadow fading spatial hash ────────────────────────────────────────────
// [FIX-9-EQUIV] Interpolasi bilinear+smoothstep (bukan hard nearest-bucket)
// — sama seperti perbaikan di coverage.js — supaya blob shadow-fading
// menyambung mulus, bukan noise "statis TV" saat resolusi grid berdekatan
// dengan decorrelation distance.
const SPATIAL_GRID_SIZE = 0.0005;
function hashInt(n) { n = ((n >>> 16) ^ n) * 0x45d9f3b; n = ((n >>> 16) ^ n) * 0x45d9f3b; return ((n >>> 16) ^ n) >>> 0; }
function cornerGaussian(cx, cy, seed) {
  const s1 = hashInt(cx * 73856093 ^ cy * 19349663 ^ seed), s2 = hashInt(s1 + 2654435761);
  const u1 = (s1 >>> 0) / 4294967296 + 1e-10, u2 = (s2 >>> 0) / 4294967296 + 1e-10;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function smoothStep(t) { return t * t * (3 - 2 * t); }
function spatialNoise(lat, lng, std, siteId) {
  let seed = 0; for (let i = 0; i < siteId.length; i++) seed = (seed * 17 + siteId.charCodeAt(i)) & 0xffff;
  const fx = lat / SPATIAL_GRID_SIZE, fy = lng / SPATIAL_GRID_SIZE;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = smoothStep(fx - ix), ty = smoothStep(fy - iy);
  const n00 = cornerGaussian(ix, iy, seed), n10 = cornerGaussian(ix + 1, iy, seed);
  const n01 = cornerGaussian(ix, iy + 1, seed), n11 = cornerGaussian(ix + 1, iy + 1, seed);
  const nx0 = n00 * (1 - tx) + n10 * tx, nx1 = n01 * (1 - tx) + n11 * tx;
  const raw = (nx0 * (1 - ty) + nx1 * ty) * std;
  return Math.max(-2 * std, Math.min(2 * std, raw));
}

// ── RSRP ─────────────────────────────────────────────────────────────────
function computeRSRP(dist, gainDb, hBS, sc, cond, lat, lon, siteId, clutter, P) {
  const pl = pathLoss(sc, cond, dist, P.FREQUENCY, hBS, MOBILE_H);
  const cl = getClutterLoss(clutter);
  const xi = spatialNoise(lat, lon, getShadowStd(sc, cond), siteId);
  return P.TX_POWER + gainDb - pl - cl + xi;
}

/**
 * [FIX-13-EQUIV] Varian DETERMINISTIK (tanpa shadow fading) — dipakai
 * KHUSUS untuk matrix visual/kontur, sama seperti coverage.js. Tool RF
 * planning nyata (Atoll dkk) menggambar RSRP deterministik; shadow fading
 * dipakai untuk analisis probabilitas terpisah, bukan warna piksel.
 * `grids[]` (dipakai statistik/legend/klik-detail) TETAP pakai computeRSRP()
 * dengan noise seperti sebelumnya — tidak berubah.
 */
function computeRSRPDeterministic(dist, gainDb, hBS, sc, cond, clutter, P) {
  const pl = pathLoss(sc, cond, dist, P.FREQUENCY, hBS, MOBILE_H);
  const cl = getClutterLoss(clutter);
  return P.TX_POWER + gainDb - pl - cl;
}

function computeSINRWithNeighbours(lat, lon, rsrpServing, P) {
  const S = dbmToLinear(rsrpServing);
  let I   = 0; // interferensi murni, noise dipisah

  neighbourSites.forEach(nb => {
    const dist = calcDistance({ lat, lng: lon }, { lat: nb.lat, lng: nb.lng });

    // Skip neighbour yang terlalu jauh — sinyal mereka sudah di bawah noise floor
    // Threshold: jika jarak > 5x radius coverage, pengaruhnya negligible
    const radius = parseInt(document.getElementById('radiusPure')?.value) || 500;
    if (dist > radius * 5) return;

    const brng    = bearingTo(nb.lat, nb.lng, lat, lon);
    const sectors = normalizeSectors(nb);
    const gainDb  = sectors.length
      ? bestSectorGain(brng, sectors, P.BEAMWIDTH, P.ANTENNA_Am).gain
      : 0;

    const rsrpNb = computeRSRP(
      dist, gainDb, nb.height || 30,
      P.SCENARIO, P.CONDITION,
      lat, lon, nb.id, P.CLUTTER, P
    );

    // Clamp ke RX floor — sinyal di bawah floor tidak relevan
    const rsrpNbClamped = Math.max(RX_SENSITIVITY_FLOOR, rsrpNb);

    // Hanya hitung sebagai interferer jika cukup kuat
    // (tidak lebih lemah dari serving - DOMINANT_INTERFERER_THRESHOLD_DB)
    if (rsrpServing - rsrpNbClamped < DOMINANT_INTERFERER_THRESHOLD_DB) {
      I += dbmToLinear(rsrpNbClamped) * INTERFERENCE_MARGIN_FACTOR;
    }
  });

  // SINR = S / (I + N) — noise sebagai floor minimum
  const sinr_lin = S / (I + P.THERMAL_NOISE_LIN);
  return Math.max(P.SINR_FLOOR, Math.min(P.SINR_CEIL, linearToDbm(sinr_lin)));
}

/**
 * [FIX-13-EQUIV] Varian deterministik dari computeSINRWithNeighbours —
 * dipakai khusus untuk matrix visual. Logika kompetisi/interferensi SAMA
 * PERSIS (radius cutoff 5x, dominant interferer threshold 30dB), cuma
 * RSRP neighbour dan RSRP serving-nya pakai versi tanpa shadow fading.
 */
function computeSINRWithNeighboursDeterministic(lat, lon, rsrpServingDet, P) {
  const S = dbmToLinear(rsrpServingDet);
  let I = 0;
  neighbourSites.forEach(nb => {
    const dist = calcDistance({ lat, lng: lon }, { lat: nb.lat, lng: nb.lng });
    const radius = parseInt(document.getElementById('radiusPure')?.value) || 500;
    if (dist > radius * 5) return;
    const brng    = bearingTo(nb.lat, nb.lng, lat, lon);
    const sectors = normalizeSectors(nb);
    const gainDb  = sectors.length ? bestSectorGain(brng, sectors, P.BEAMWIDTH, P.ANTENNA_Am).gain : 0;
    const rsrpNb  = computeRSRPDeterministic(dist, gainDb, nb.height || 30, P.SCENARIO, P.CONDITION, P.CLUTTER, P);
    const rsrpNbClamped = Math.max(RX_SENSITIVITY_FLOOR, rsrpNb);
    if (rsrpServingDet - rsrpNbClamped < DOMINANT_INTERFERER_THRESHOLD_DB) {
      I += dbmToLinear(rsrpNbClamped) * INTERFERENCE_MARGIN_FACTOR;
    }
  });
  const sinr_lin = S / (I + P.THERMAL_NOISE_LIN);
  return Math.max(P.SINR_FLOOR, Math.min(P.SINR_CEIL, linearToDbm(sinr_lin)));
}

// ── Color & category ──────────────────────────────────────────────────────
function getRSRPColor(v) { if (v >= -85) return '#0042a5'; if (v >= -95) return '#00a955'; if (v >= -105) return '#70ff66'; if (v >= -120) return '#fffb00'; if (v >= -140) return '#ff3333'; return '#800000'; }
function getSINRColor(v) { if (v >= 20) return '#0042a5'; if (v >= 10) return '#00a955'; if (v >= 0) return '#70ff66'; if (v >= -5) return '#fffb00'; if (v >= -10) return '#ff3333'; return '#800000'; }
function getRSRPCategory(v) { if (v >= -85) return 'S1'; if (v >= -95) return 'S2'; if (v >= -105) return 'S3'; if (v >= -120) return 'S4'; if (v >= -140) return 'S5'; return 'S6'; }
function getSINRCategory(v) { if (v >= 20) return 'S1'; if (v >= 10) return 'S2'; if (v >= 0) return 'S3'; if (v >= -5) return 'S4'; if (v >= -10) return 'S5'; return 'S6'; }
function getCategoryName(c) { return { S1: 'Excellent', S2: 'Good', S3: 'Moderate', S4: 'Poor', S5: 'Bad', S6: 'Very Bad' }[c] || 'Unknown'; }

// ── Geo utils ─────────────────────────────────────────────────────────────
function destinationPoint(lat, lng, az, dist) {
  const R = 6378137, b = az * Math.PI / 180, d = dist / R;
  const la1 = lat * Math.PI / 180, lo1 = lng * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 * 180 / Math.PI, lng: lo2 * 180 / Math.PI };
}
function calcDistance(a, b) {
  const R = 6378137, la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const dLa = (b.lat - a.lat) * Math.PI / 180, dLo = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function bearingTo(la1, lo1, la2, lo2) {
  const p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180, dl = (lo2 - lo1) * Math.PI / 180;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}
function normalizeSectors(site) {
  if (!Array.isArray(site.sectors) || !site.sectors.length) return [];
  return site.sectors.map(s => {
    if (typeof s === 'object' && s !== null) return parseFloat(s.azimuth ?? s.az ?? 0);
    const n = parseFloat(s); return isNaN(n) ? 0 : n;
  });
}

// ── INIT ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  attachEvents();
  generateAzimuthInputs();
  updateBadges();
  loadSiteIndex();
});

function initMap() {
  map = L.map('pureMap').setView([-6.2088, 106.8456], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }).addTo(map);
  sectorLayer   = L.layerGroup().addTo(map);
  coverageLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
}

function attachEvents() {
  document.getElementById('btnSetLoc')?.addEventListener('click', setSiteFromInput);
  document.getElementById('btnClear')?.addEventListener('click', clearSite);
  document.getElementById('sectorCountPure')?.addEventListener('change', function () {
    sectorCount = parseInt(this.value); generateAzimuthInputs(); if (currentSiteLocation) generateCoverage();
  });
  document.getElementById('antennaHeightPure')?.addEventListener('input', () => { if (currentSiteLocation) generateCoverage(); });
  document.getElementById('scenarioPure')?.addEventListener('change',  () => { updateBadges(); if (currentSiteLocation) generateCoverage(); });
  document.getElementById('conditionPure')?.addEventListener('change', () => { updateBadges(); if (currentSiteLocation) generateCoverage(); });
  document.getElementById('clutterPure')?.addEventListener('change',   () => { updateBadges(); if (currentSiteLocation) generateCoverage(); });
  document.getElementById('btnRSRP')?.addEventListener('click', () => setViz('rsrp'));
  document.getElementById('btnSINR')?.addEventListener('click', () => setViz('sinr'));
  ['txPure','freqPure','bwPure','gridPure','radiusPure'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => { updateBadges(); if (currentSiteLocation) generateCoverage(); });
  });
}

// ── Site index ─────────────────────────────────────────────────────────────
function loadSiteIndex() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (saved) {
    try {
      const d = JSON.parse(saved);
      if (Object.keys(d).length) { siteIndex = d; renderExistingSites(); return; }
    } catch {}
  }
  fetch('/api/get-site')
    .then(r => r.json())
    .then(data => {
      if (data.has_site && data.siteIndex) {
        siteIndex = data.siteIndex;
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex));
        renderExistingSites();
      }
    }).catch(() => console.warn('[pure] Tidak bisa load site index'));
}

let existingLayer = null;
function renderExistingSites() {
  if (existingLayer) { map.removeLayer(existingLayer); existingLayer = null; }
  const lg = L.layerGroup();
  Object.entries(siteIndex).forEach(([id, s]) => {
    L.circleMarker([s.lat, s.lng], { radius: 5, fillColor: '#ffd000', color: '#333', weight: 1.2, fillOpacity: 0.85 })
      .bindTooltip(id, { permanent: false, direction: 'top' })
      .bindPopup(`<b>📡 ${id}</b><br>H: ${s.height}m`)
      .addTo(lg);
  });
  existingLayer = lg.addTo(map);
}

// ── Neighbour detection ───────────────────────────────────────────────────
function detectNeighbours(lat, lng) {
  neighbourSites = Object.entries(siteIndex)
    .map(([id, s]) => ({ id, ...s, _dist: calcDistance({ lat, lng }, { lat: s.lat, lng: s.lng }) }))
    .sort((a, b) => a._dist - b._dist)
    .slice(0, MAX_NEIGHBOUR);
  const el = document.getElementById('neighbourBadge');
  if (el) {
    el.textContent = neighbourSites.length
      ? `${neighbourSites.length} neighbour terdeteksi sebagai interferer`
      : 'Tidak ada site tetangga';
  }
}

// ── Map interaction ───────────────────────────────────────────────────────
function onMapClick(e) {
  document.getElementById('latPure').value = e.latlng.lat.toFixed(6);
  document.getElementById('lngPure').value = e.latlng.lng.toFixed(6);
  placeSite(e.latlng.lat, e.latlng.lng);
}

function setSiteFromInput() {
  const lat = parseFloat(document.getElementById('latPure').value);
  const lng = parseFloat(document.getElementById('lngPure').value);
  if (!isFinite(lat) || !isFinite(lng)) { alert('Masukkan koordinat yang valid'); return; }
  placeSite(lat, lng);
}

function placeSite(lat, lng) {
  currentSiteLocation = { lat, lng };
  detectNeighbours(lat, lng);

  if (newSiteMarker) map.removeLayer(newSiteMarker);
  const icon = L.divIcon({ className: '', html: '<div class="pure-site-pin"></div>', iconSize: [24, 24], iconAnchor: [12, 24] });
  newSiteMarker = L.marker([lat, lng], { icon, draggable: true }).addTo(map);
  newSiteMarker.bindPopup(`<b>📡 Site Baru</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}`).openPopup();
  newSiteMarker.on('dragend', e => {
    const p = e.target.getLatLng();
    document.getElementById('latPure').value = p.lat.toFixed(6);
    document.getElementById('lngPure').value = p.lng.toFixed(6);
    currentSiteLocation = { lat: p.lat, lng: p.lng };
    detectNeighbours(p.lat, p.lng);
    generateCoverage();
  });

  const locEl = document.getElementById('currentLocPure');
  if (locEl) { locEl.style.display = 'flex'; locEl.querySelector('span').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`; }
  document.getElementById('pureInstructions')?.remove();
  document.getElementById('btnClear').style.display = 'flex';
  map.setView([lat, lng], 15);
  generateCoverage();
}

function clearSite() {
  if (newSiteMarker) { map.removeLayer(newSiteMarker); newSiteMarker = null; }
  sectorLayer.clearLayers();
  coverageLayer.clearLayers();
  if (_coverageClickHandler) { map.off('click', _coverageClickHandler); _coverageClickHandler = null; map.on('click', onMapClick); }
  currentSiteLocation = null;
  neighbourSites = [];
  document.getElementById('latPure').value = '';
  document.getElementById('lngPure').value = '';
  document.getElementById('currentLocPure').style.display = 'none';
  document.getElementById('btnClear').style.display = 'none';
  document.getElementById('pureMapLegend').style.display = 'none';
  document.getElementById('pureResult').innerHTML = `
    <div class="pure-waiting">
      <i class="fas fa-map-marker-alt"></i>
      <p>Klik peta atau masukkan koordinat untuk memulai prediksi</p>
    </div>`;
  document.getElementById('pureStats').innerHTML = '';
  document.getElementById('neighbourBadge').textContent = '';
}

// ── Azimuth ───────────────────────────────────────────────────────────────
function generateAzimuthInputs() {
  const container = document.getElementById('azimuthsPure');
  if (!container) return;
  container.innerHTML = '';
  const step = 360 / sectorCount;
  for (let i = 0; i < sectorCount; i++) {
    const defaultAz = Math.round(i * step);
    const color = SECTOR_COLORS[i % SECTOR_COLORS.length];
    const grp = document.createElement('div');
    grp.className = 'pure-az-group';
    grp.innerHTML = `
      <label><span class="pure-dot" style="background:${color}"></span>Sek ${i + 1}</label>
      <input type="number" id="az${i}" value="${defaultAz}" min="0" max="359" step="1">`;
    container.appendChild(grp);
    document.getElementById('az' + i)?.addEventListener('input', () => { if (currentSiteLocation) generateCoverage(); });
  }
}

function getAzimuths() {
  return Array.from({ length: sectorCount }, (_, i) => {
    const v = parseFloat(document.getElementById('az' + i)?.value); return isFinite(v) ? v : 0;
  });
}

// ── Visualization ─────────────────────────────────────────────────────────
function setViz(type) {
  currentCoverageType = type;
  document.getElementById('btnRSRP')?.classList.toggle('active', type === 'rsrp');
  document.getElementById('btnSINR')?.classList.toggle('active', type === 'sinr');
  if (currentSiteLocation) generateCoverage();
}

// ── Badges ────────────────────────────────────────────────────────────────
function updateBadges() {
  const P = getParams();
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('badgeTx',   P.TX_POWER + ' dBm');
  set('badgeFreq', P.FREQUENCY + ' MHz');
  set('badgeSc',   P.SCENARIO.toUpperCase() + ' ' + P.CONDITION.toUpperCase().replace('_', '/'));
  set('badgeGrid', (document.getElementById('gridPure')?.value || '50') + 'm');
  set('badgeH',    (document.getElementById('antennaHeightPure')?.value || '30') + 'm');
}

// ── COVERAGE GENERATION ───────────────────────────────────────────────────
// [FIX-14-EQUIV / ALIGN3-EQUIV] Perubahan utama dari versi sebelumnya:
//  1) Circular cutoff (`if (dist > radius) continue`) DIHAPUS — itu yang
//     bikin coverage selalu jadi LINGKARAN SEMPURNA, gak peduli bentuk
//     sinyal aslinya. Sekarang loop berbasis bounding-box index (numRows x
//     numCols), semua titik dihitung apa adanya (sama seperti coverage.js).
//  2) Loop sekarang membangun DUA hal sekaligus dari satu sumber fisika:
//     - grids[] → nilai BER-NOISE (shadow fading), dipakai statistik/
//       legend/popup klik — TIDAK berubah dari sebelumnya.
//     - rsrpMatrix/sinrMatrix → nilai DETERMINISTIK (tanpa noise), dipakai
//       KHUSUS untuk render kontur — supaya visualnya rapi & pola sektor
//       jelas seperti tool RF planning (Atoll dkk), bukan berbintik.
//  3) Rendering pakai CONTOUR (d3-contour) kalau tersedia, fallback ke grid
//     per-cell (perilaku lama) kalau script d3 belum di-include di HTML.
function generateCoverage() {
  if (!currentSiteLocation) return;
  showLoading('Menghitung prediksi coverage...');

  setTimeout(() => {
    try {
      const P          = getParams();
      const gridSizeIn = parseInt(document.getElementById('gridPure')?.value) || 50;
      const radius     = parseInt(document.getElementById('radiusPure')?.value) || 500;
      const antennaH   = parseInt(document.getElementById('antennaHeightPure')?.value) || 30;
      azimuths         = getAzimuths();

      const lat0  = currentSiteLocation.lat, lng0 = currentSiteLocation.lng;
      const mpdLat = 111320, mpdLon = 111320 * Math.cos(lat0 * Math.PI / 180);

      // [FIX-14-EQUIV] Radius dari UI = kontrol utama. Margin +20% cuma
      // buat ngasih ruang kontur fade natural di tepi, TIDAK PERNAH
      // membesarkan jauh melebihi yang diminta user (beda dari bug lama).
      // [FIX-15] Margin dinaikkan 1.2 → 1.6 supaya radius yang lo MINTA di UI
      // tetap tampil full-strength (taper baru mulai SETELAH radius itu,
      // di ring buffer tambahan) — bukan taper "memakan" area yang lo minta.
      const searchRadius = radius * 1.6;
      const minLat = lat0 - searchRadius / mpdLat, maxLat = lat0 + searchRadius / mpdLat;
      const minLon = lng0 - searchRadius / mpdLon, maxLon = lng0 + searchRadius / mpdLon;

      // [PERF] Auto-coarsen ringan kalau grid terlalu halus utk area yang diminta
      const MAX_CELLS = 45000;
      const areaWidthM = (maxLon - minLon) * mpdLon, areaHeightM = (maxLat - minLat) * mpdLat;
      const estCells = (areaWidthM / gridSizeIn) * (areaHeightM / gridSizeIn);
      let gridSize = gridSizeIn;
      if (estCells > MAX_CELLS) gridSize = Math.sqrt((areaWidthM * areaHeightM) / MAX_CELLS);

      const dLat = gridSize / mpdLat, dLon = gridSize / mpdLon;
      const numRows = Math.floor((maxLat - minLat) / dLat + 1e-9) + 1;
      const numCols = Math.floor((maxLon - minLon) / dLon + 1e-9) + 1;

      sectorLayer.clearLayers();

      // Gambar sektor fan (indikator arah, layer terpisah — tidak berubah)
      azimuths.forEach((az, idx) => drawSectorFan(lat0, lng0, az, P.BEAMWIDTH, 200, idx));

      const grids = [];
      const rsrpMatrix = new Float64Array(numRows * numCols);
      const sinrMatrix = new Float64Array(numRows * numCols);

      for (let ri = 0; ri < numRows; ri++) {
        const lat = minLat + ri * dLat;
        for (let ci = 0; ci < numCols; ci++) {
          const lon = minLon + ci * dLon;

          const dist   = calcDistance({ lat: lat0, lng: lng0 }, { lat, lng: lon });
          const brng   = bearingTo(lat0, lng0, lat, lon);
          const gainDb = azimuths.length ? bestSectorGain(brng, azimuths, P.BEAMWIDTH, P.ANTENNA_Am).gain : 0;

          // Nilai ber-noise — dipakai grids[]/statistik/popup (TIDAK berubah)
          const rsrp  = computeRSRP(dist, gainDb, antennaH, P.SCENARIO, P.CONDITION, lat, lon, 'SITE_BARU', P.CLUTTER, P);
          const rsrpC = Math.max(RX_SENSITIVITY_FLOOR, rsrp);
          const sinr  = computeSINRWithNeighbours(lat, lon, rsrpC, P);

          let value, color, category;
          if (currentCoverageType === 'rsrp') {
            value = Math.round(rsrpC * 10) / 10;
            color = getRSRPColor(value); category = getRSRPCategory(value);
          } else {
            value = Math.round(sinr * 10) / 10;
            color = getSINRColor(value); category = getSINRCategory(value);
          }

          const bounds = [[lat, lon], [lat + dLat, lon], [lat + dLat, lon + dLon], [lat, lon + dLon]];
          grids.push({ lat, lon, dist, rsrpValue: rsrpC, sinrValue: sinr, value, color, category, bounds });

          // Nilai deterministik (tanpa noise) — KHUSUS untuk kontur visual
          const rsrpDet  = computeRSRPDeterministic(dist, gainDb, antennaH, P.SCENARIO, P.CONDITION, P.CLUTTER, P);
          const rsrpDetC = Math.max(RX_SENSITIVITY_FLOOR, rsrpDet);
          const sinrDet  = computeSINRWithNeighboursDeterministic(lat, lon, rsrpDetC, P);

          const mi = ri * numCols + ci;

          // [FIX-15] EDGE TAPER — murni kosmetik, HANYA untuk matrix visual
          // (rsrpMatrix/sinrMatrix), TIDAK menyentuh grids[]/statistik sama
          // sekali. Root cause border kotak yang masih kelihatan tegas:
          // box pencarian itu PERSEGI (jarak searchRadius sama ke 4 sisi),
          // sementara pola sinyal 3-sektor itu BUNGA (gak seragam segala
          // arah) — di "lembah" antar sektor, gain cuma diredam maksimal
          // Am (bukan sampai nol), jadi sinyal masih "hidup" pas nyentuh
          // SISI kotak (titik terdekat), walau di SUDUT kotak (lebih jauh)
          // sinyal sudah pudar duluan. Makanya sisi kiri-kanan-atas-bawah
          // kelihatan kepotong tegas, sementara pojoknya natural.
          //
          // Fix: makin dekat ke SISI TERDEKAT kotak manapun (bukan cuma
          // sudut), makin diredam paksa — dijamin habis sebelum nyentuh
          // tepi dari arah manapun (sisi maupun sudut), terlepas dari
          // seberapa kuat sinyal aslinya di lembah antar sektor.
          const distToEdgeM = Math.min(
            (lat - minLat) * mpdLat, (maxLat - lat) * mpdLat,
            (lon - minLon) * mpdLon, (maxLon - lon) * mpdLon
          );
          const taperZoneM = searchRadius * 0.35; // 35% terluar mulai diredam
          const taperT = Math.max(0, Math.min(1, 1 - distToEdgeM / taperZoneM));
          const taperSmooth = taperT * taperT * (3 - 2 * taperT); // smoothstep
          const taperDb = taperSmooth * 45; // sampai -45dB tepat di tepi kotak

          rsrpMatrix[mi] = rsrpDetC - taperDb;
          // [BLANK-UNIFIED-EQUIV] Keputusan "blank atau tidak" tetap pakai
          // nilai ber-noise (rsrpC, sama sumber dengan grids[]/statistik) —
          // hanya besaran SINR yang ditampilkan yang dibersihkan dari noise
          // (dan kena taper yang sama biar kontur SINR juga fade konsisten).
          sinrMatrix[mi] = rsrpC < RSRP_BLANK_THRESHOLD ? (P.SINR_FLOOR - 1) : (sinrDet - taperSmooth * 20);
        }
      }

      renderCoverageContour(grids, currentCoverageType, { numRows, numCols, minLat, minLon, dLat, dLon, rsrpMatrix, sinrMatrix });
      updateLegend(grids);
      updateStats(grids, gridSize);
      hideLoading();
    } catch (err) {
      console.error('[pure] Error:', err);
      hideLoading();
      alert('Error: ' + err.message);
    }
  }, 100);
}

function drawSectorFan(lat, lng, az, bw, radius, idx) {
  const pts = [[lat, lng]];
  for (let i = 0; i <= 20; i++) {
    const ang = (az - bw / 2) + (i / 20) * (bw);
    const p = destinationPoint(lat, lng, ang, radius);
    pts.push([p.lat, p.lng]);
  }
  pts.push([lat, lng]);
  const color = SECTOR_COLORS[idx % SECTOR_COLORS.length];
  L.polygon(pts, { color, fillColor: color, fillOpacity: 0.15, weight: 2, opacity: 0.7 })
    .addTo(sectorLayer)
    .bindPopup(`<b>Sektor ${idx + 1}</b><br>Azimuth: ${az}°`);
}

// ══════════════════════════════════════════════════════════════════════════
// [CONTOUR-EQUIV] Rendering kontur — sama pendekatan dengan coverage.js.
// Butuh <script src=".../d3.min.js"> sebelum <script src="newsite.js">.
// Kalau d3 tidak tersedia, fallback otomatis ke grid per-cell (perilaku lama).
// ══════════════════════════════════════════════════════════════════════════
const CONTOUR_ANCHORS = {
  rsrp: [
    { min: RSRP_BLANK_THRESHOLD, color: '#fffb00' },
    { min: -105, color: '#70ff66' },
    { min: -95,  color: '#00a955' },
    { min: -85,  color: '#0042a5' },
    { min: -75,  color: '#00286b' },
  ],
  sinr: [
    { min: -10, color: '#ff3333' },
    { min: -5,  color: '#fffb00' },
    { min: 0,   color: '#70ff66' },
    { min: 10,  color: '#00a955' },
    { min: 20,  color: '#0042a5' },
    { min: 30,  color: '#00286b' },
  ],
};
const STEP_DB = 3;
function hexToRgb(hex){ const n=parseInt(hex.slice(1),16); return [(n>>16)&255,(n>>8)&255,n&255]; }
function rgbToHex([r,g,b]){ return '#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join(''); }
function lerpColor(c1,c2,t){ const a=hexToRgb(c1),b=hexToRgb(c2); return rgbToHex(a.map((v,i)=>v+(b[i]-v)*t)); }
function buildFineThresholds(type){
  const anchors = CONTOUR_ANCHORS[type];
  const out = [];
  for(let i=0;i<anchors.length-1;i++){
    const a=anchors[i], b=anchors[i+1];
    const span = b.min - a.min;
    const steps = Math.max(1, Math.round(span/STEP_DB));
    for(let s=0;s<steps;s++){ const t=s/steps; out.push({ min: a.min+span*t, color: lerpColor(a.color,b.color,t) }); }
  }
  out.push(anchors[anchors.length-1]);
  return out;
}
const CONTOUR_THRESHOLDS = { rsrp: buildFineThresholds('rsrp'), sinr: buildFineThresholds('sinr') };

let _coverageClickHandler = null;

function renderCoverageContour(grids, type, gridMeta) {
  coverageLayer.clearLayers();
  if (_coverageClickHandler) { map.off('click', _coverageClickHandler); _coverageClickHandler = null; }
  map.off('click', onMapClick); // sementara nonaktif selama ada coverage; diaktifkan lagi di clearSite()
  if (!grids.length) return;

  if (typeof d3 === 'undefined' || !d3.contours) {
    console.warn('[CONTOUR] d3-contour tidak terdeteksi — fallback ke grid per-cell. Tambahkan <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"> sebelum newsite.js.');
    return renderCoverageGridFallback(grids, type);
  }

  const { numRows, numCols, minLat, minLon, dLat, dLon, rsrpMatrix, sinrMatrix } = gridMeta;
  const matrix = type === 'rsrp' ? rsrpMatrix : sinrMatrix;
  const bands  = CONTOUR_THRESHOLDS[type];

  function idxToLatLng([x,y]){ return [minLat + y*dLat, minLon + x*dLon]; }
  function polygonToLatLngRings(polygon){ return polygon.map(ring => ring.map(idxToLatLng)); }

  const contourGen = d3.contours().size([numCols, numRows]);

  bands.forEach(band => {
    let multiPolygon;
    try { multiPolygon = contourGen.contour(matrix, band.min); }
    catch(e){ console.warn('[CONTOUR] gagal hitung threshold', band.min, e); return; }
    if (!multiPolygon?.coordinates?.length) return;
    multiPolygon.coordinates.forEach(polygonRings => {
      const latlngRings = polygonToLatLngRings(polygonRings);
      L.polygon(latlngRings, { stroke:false, fillColor: band.color, fillOpacity: 0.68 }).addTo(coverageLayer);
    });
  });

  // [PROBE] Klik cari cell terdekat dari grids[] mentah untuk popup detail presisi
  _coverageClickHandler = function(e){
    if (!grids.length) return;
    const clat=e.latlng.lat, clon=e.latlng.lng;
    let nearest=null, nd=Infinity;
    for (const g of grids){ const dd=(g.lat-clat)**2+(g.lon-clon)**2; if (dd<nd){ nd=dd; nearest=g; } }
    if (!nearest) return;
    const unit = currentCoverageType==='rsrp' ? 'dBm' : 'dB';
    const val  = currentCoverageType==='rsrp' ? nearest.rsrpValue : nearest.sinrValue;
    L.popup({maxWidth:260}).setLatLng(e.latlng).setContent(
      `<b>${currentCoverageType.toUpperCase()}: ${val.toFixed(1)} ${unit}</b><br>
       Kategori: ${getCategoryName(nearest.category)}<br>
       SS-RSRP: ${nearest.rsrpValue.toFixed(1)} dBm | SS-SINR: ${nearest.sinrValue.toFixed(1)} dB<br>
       Jarak: ${nearest.dist.toFixed(0)} m`
    ).openOn(map);
  };
  map.on('click', _coverageClickHandler);
}

// [FALLBACK] Grid per-cell (perilaku lama) — dipakai otomatis kalau d3 belum ada
function renderCoverageGridFallback(grids, type) {
  const unit = type==='rsrp' ? 'dBm' : 'dB';
  grids.forEach(g => {
    if (g.rsrpValue < RSRP_BLANK_THRESHOLD) return; // konsisten dgn definisi blank
    L.polygon(g.bounds, { color:g.color, fillColor:g.color, fillOpacity:0.72, weight:0 })
      .bindPopup(`<b>${type.toUpperCase()}: ${g.value} ${unit}</b><br>Kategori: ${getCategoryName(g.category)}<br>SS-RSRP: ${g.rsrpValue.toFixed(1)} dBm | SS-SINR: ${g.sinrValue.toFixed(1)} dB<br>Jarak: ${g.dist.toFixed(0)} m`)
      .addTo(coverageLayer);
  });
  map.on('click', onMapClick); // fallback tetap boleh reposisi site dgn klik ulang
}

function updateLegend(grids) {
  const legend = document.getElementById('pureMapLegend');
  const tbody  = document.getElementById('pureLegendBody');
  const title  = document.getElementById('pureLegendTitle');
  if (!legend || !tbody) return;
  legend.style.display = 'block';
  const isRSRP = currentCoverageType === 'rsrp';
  if (title) title.textContent = isRSRP ? 'SS-RSRP (dBm)' : 'SS-SINR (dB)';
  const rows = isRSRP ? [
    { cat: 'S1', color: '#0042a5', range: '-85 ~ 0' },
    { cat: 'S2', color: '#00a955', range: '-95 ~ -85' },
    { cat: 'S3', color: '#70ff66', range: '-105 ~ -95' },
    { cat: 'S4', color: '#fffb00', range: '-120 ~ -105' },
    { cat: 'S5', color: '#ff3333', range: '-140 ~ -120' },
  ] : [
    { cat: 'S1', color: '#0042a5', range: '≥ 20 dB' },
    { cat: 'S2', color: '#00a955', range: '10 ~ 20' },
    { cat: 'S3', color: '#70ff66', range: '0 ~ 10' },
    { cat: 'S4', color: '#fffb00', range: '-5 ~ 0' },
    { cat: 'S5', color: '#ff3333', range: '-40 ~ -5' },
  ];
  const total = grids.length || 1;
  tbody.innerHTML = rows.map(r => {
    const cnt = grids.filter(g => g.category === r.cat).length;
    return `<tr>
      <td><div style="width:14px;height:14px;background:${r.color};border-radius:3px;display:inline-block;"></div></td>
      <td>${r.range}</td>
      <td><b>${((cnt / total) * 100).toFixed(1)}%</b></td>
    </tr>`;
  }).join('');
}

function updateStats(grids, gridSize) {
  const total   = grids.length || 1;
  const gridKm2 = (gridSize / 1000) ** 2;
  const cats    = {};
  grids.forEach(g => { cats[g.category] = (cats[g.category] || 0) + 1; });
  const s1Pct   = ((cats.S1 || 0) / total * 100).toFixed(1);
  const s2Pct   = ((cats.S2 || 0) / total * 100).toFixed(1);
  const poorPct = (((cats.S4 || 0) + (cats.S5 || 0) + (cats.S6 || 0)) / total * 100).toFixed(1);
  const totalKm = (grids.length * gridKm2).toFixed(3);
  const nbInfo  = neighbourSites.length > 0
    ? `<p style="color:#666;font-size:11.5px;margin:4px 0 0;">📡 SS-SINR dihitung dengan ${neighbourSites.length} neighbour sebagai interferer: <b>${neighbourSites.map(n => n.id).join(', ')}</b></p>`
    : `<p style="color:#999;font-size:11.5px;margin:4px 0 0;">⚠️ Tidak ada neighbour terdeteksi — SINR dihitung noise-limited</p>`;

  document.getElementById('pureResult').innerHTML = `
    <div class="pure-result-content">
      <div class="pure-stat-grid">
        <div class="pure-stat-box"><span class="psl">Total Area</span><span class="psv">${totalKm} km²</span></div>
        <div class="pure-stat-box excellent"><span class="psl">Excellent (S1)</span><span class="psv">${s1Pct}%</span></div>
        <div class="pure-stat-box good"><span class="psl">Good (S2)</span><span class="psv">${s2Pct}%</span></div>
        <div class="pure-stat-box poor"><span class="psl">Poor/Bad</span><span class="psv">${poorPct}%</span></div>
      </div>
      ${nbInfo}
    </div>`;
}

// ── Loading ───────────────────────────────────────────────────────────────
function showLoading(text) {
  hideLoading();
  const el = document.createElement('div');
  el.id = 'pureLoading'; el.className = 'pure-loading-overlay';
  el.innerHTML = `<div class="pure-loading-box"><div class="pure-spinner"></div><p>${text || 'Memproses...'}</p></div>`;
  document.body.appendChild(el);
}
function hideLoading() { document.getElementById('pureLoading')?.remove(); }

console.log(
  'newsite_pure.js v2.1 — edge taper (FIX-15) + kontur + deterministik + radius dihormati\n' +
  '  ⚠️  BUTUH <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js">\n' +
  '     ditambahkan SEBELUM <script src="...newsite.js"> di HTML.\n' +
  '  ✅ [FIX-15] Edge taper — root cause border kotak MASIH kelihatan tegas\n' +
  '     di beberapa sisi (walau bentuk sinyal sudah organik/bunga per-sektor):\n' +
  '     box pencarian PERSEGI (jarak sama ke 4 sisi), tapi sinyal di "lembah"\n' +
  '     antar sektor cuma diredam sampai Am (bukan nol) — jadi masih "hidup"\n' +
  '     pas nyentuh SISI kotak (titik terdekat), walau di SUDUT kotak (lebih\n' +
  '     jauh) sudah pudar duluan. Sekarang matrix visual (BUKAN grids[]/\n' +
  '     statistik) diredam progresif makin dekat ke sisi kotak MANAPUN,\n' +
  '     dijamin habis sebelum tepi dari arah manapun. Margin dinaikkan\n' +
  '     1.2×→1.6× supaya radius yang diminta user tetap full-strength,\n' +
  '     taper cuma di ring buffer tambahan setelahnya.\n' +
  '  ✅ [ALIGN3-EQUIV] Circular cutoff (if dist>radius continue) DIHAPUS —\n' +
  '     dulu ini yang bikin coverage SELALU jadi lingkaran sempurna.\n' +
  '  ✅ [FIX-13-EQUIV] Matrix visual (kontur) pakai RSRP/SINR DETERMINISTIK\n' +
  '     (tanpa shadow fading) — pola sektor jelas & rapi gaya Atoll.\n' +
  '     grids[] (statistik/legend/klik-detail) TETAP pakai nilai ber-noise,\n' +
  '     tidak berubah dari versi sebelumnya.\n' +
  '  ✅ [FIX-14-EQUIV] Radius dari UI = kontrol utama.\n' +
  '  ✅ [FIX-6-EQUIV] antennaGain(): offset/(bw/2) → offset/bw\n' +
  '  ✅ [FIX-9-EQUIV] Shadow fading interpolasi bilinear+smoothstep\n' +
  '  ✅ [PROBE] Klik peta cari cell terdekat dari grids[] mentah utk popup detail\n' +
  '  ✅ Fallback otomatis ke grid per-cell kalau d3 belum ter-load\n' +
  '  ℹ️  CATATAN: computeRSRP() di file ini belum menyertakan ANTENNA_GAIN/\n' +
  '     CABLE_LOSS terpisah seperti coverage.js (ALIGN fix +8dB/-0.5dB) —\n' +
  '     sengaja belum diselaraskan, di luar scope perbaikan visual/border.'
);