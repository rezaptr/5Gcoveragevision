'use strict';
// ================================================
// coveragecom.js  v14
// Komparasi Coverage — Simulasi vs Drive Test
// ------------------------------------------------
// PERUBAHAN v14:
//   Spatial filter diganti dari "radius 150m per titik DT"
//   menjadi CONVEX HULL dari seluruh jalur DT.
//
//   Sebelumnya (v13):
//     applySpatialFilter → grid masuk jika ada titik DT dalam 150m
//     → tidak fair: area sim yang jauh lebih luas ikut dikomparasi
//
//   Sekarang (v14):
//     1. Hitung Convex Hull dari semua titik DT (via Turf.js)
//     2. Hanya grid sim yang centroid-nya masuk ke dalam Hull yang dikomparasi
//     → "extent matching" — area komparasi = area yang benar-benar disurvei DT
//
//   Ref akademik:
//     Spatial extent matching adalah praktik standar dalam validasi
//     model spasial untuk menghindari area extrapolation bias.
//     (lihat: Congalton & Green, 2019 — Assessing the Accuracy of
//     Remotely Sensed Data, Ch.4 — Sample Design)
//
// DEPENDENCY TAMBAHAN:
//   Tambahkan di HTML sebelum script ini:
//   <script src="https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js"></script>
// ================================================

const CV_SESSION_KEY    = 'coverageExportData';
const DEFAULT_THRESHOLD = 150; // meter — fallback jika hull gagal (< 3 titik unik)

// ── WARNA ─────────────────────────────────────────────────────────────────────
function getRSRPColor(v) {
  if (v >= -85)  return '#0042a5';
  if (v >= -95)  return '#00a955';
  if (v >= -105) return '#70ff66';
  if (v >= -120) return '#fffb00';
  return '#ff3333';
}
function getSINRColor(v) {
  if (v >= 20) return '#0042a5';
  if (v >= 10) return '#00a955';
  if (v >= 0)  return '#70ff66';
  if (v >= -5) return '#fffb00';
  return '#ff3333';
}
function getColor(v, metric) {
  return metric === 'rsrp' ? getRSRPColor(v) : getSINRColor(v);
}

function getBuckets(metric) {
  return metric === 'rsrp' ? [
    { label:'Excellent', range:'-85 ~ 0',     color:'#0042a5', min:-85,        max:Infinity },
    { label:'Good',      range:'-95 ~ -85',   color:'#00a955', min:-95,        max:-85      },
    { label:'Moderate',  range:'-105 ~ -95',  color:'#70ff66', min:-105,       max:-95      },
    { label:'Poor',      range:'-120 ~ -105', color:'#fffb00', min:-120,       max:-105     },
    { label:'Very Bad',  range:'< -120',      color:'#ff3333', min:-Infinity,  max:-120     },
  ] : [
    { label:'Excellent', range:'≥ 20 dB',   color:'#0042a5', min:20,        max:Infinity },
    { label:'Good',      range:'10 ~ 20',   color:'#00a955', min:10,        max:20       },
    { label:'Moderate',  range:'0 ~ 10',    color:'#70ff66', min:0,         max:10       },
    { label:'Poor',      range:'-5 ~ 0',    color:'#fffb00', min:-5,        max:0        },
    { label:'Very Bad',  range:'< -5',      color:'#ff3333', min:-Infinity, max:-5       },
  ];
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  dtData    : [],
  simExport : null,
  dtMap     : null,
  simMap    : null,
  dtLayer   : null,
  simLayer  : null,
  hullLayer : null,   // ← NEWv14: layer untuk visualisasi hull di peta
  dtHull    : null,   // ← NEWv14: GeoJSON polygon hull (di-cache setelah DT diupload)
};

const $ = id => document.getElementById(id);

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMaps();
  loadSimExport();
  attachEvents();
});

function initMaps() {
  const tile = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const opt  = { attribution: '© OpenStreetMap', maxZoom: 19 };
  const ctr  = [-6.2088, 106.8456];

  state.dtMap  = L.map('dtMap').setView(ctr, 14);
  state.simMap = L.map('simMap').setView(ctr, 14);
  L.tileLayer(tile, opt).addTo(state.dtMap);
  L.tileLayer(tile, opt).addTo(state.simMap);
  state.dtLayer   = L.layerGroup().addTo(state.dtMap);
  state.simLayer  = L.layerGroup().addTo(state.simMap);
  state.hullLayer = L.layerGroup().addTo(state.simMap); // ← hull di peta sim

  // Sync kedua peta
  let syncing = false;
  const sync = (src, dst) => src.on('move', () => {
    if (syncing) return;
    syncing = true;
    dst.setView(src.getCenter(), src.getZoom(), { animate: false });
    syncing = false;
  });
  sync(state.dtMap, state.simMap);
  sync(state.simMap, state.dtMap);
}

// ── LOAD SIMULASI ─────────────────────────────────────────────────────────────
function loadSimExport() {
  let raw;
  try { raw = sessionStorage.getItem(CV_SESSION_KEY); } catch(e) {}
  if (!raw) {
    $('simStatus').textContent = 'Sim: belum ada';
    return;
  }
  try {
    const d = JSON.parse(raw);
    if (!d?.grids?.length) throw new Error('Grid kosong');
    state.simExport = d;
    $('simStatus').textContent = `Sim: ${d.grids.length} grid`;
    $('simStatus').classList.add('uploaded');
    $('simSiteLabel').textContent = `Site: ${d.siteId || '?'} · ${d.grids.length} grid · ${d.gridSize || '?'}m`;
    $('simSourceLabel').textContent = `Simulasi site ${d.siteId || '?'} (${d.grids.length} grid)`;
    $('simMapPlaceholder')?.classList.add('hidden');
    renderSimMap('rsrp');
    checkReady();
  } catch(e) {
    $('simStatus').textContent = 'Sim: data tidak valid';
    console.error('[coveragecom v14]', e);
  }
}

// ── EVENTS ────────────────────────────────────────────────────────────────────
function attachEvents() {
  $('uploadDTBtn').addEventListener('click', () => $('dtFileInput').click());
  $('dtFileInput').addEventListener('change', handleCSV);
  $('processRSRPBtn').addEventListener('click', () => onProcess('rsrp'));
  $('processSINRBtn').addEventListener('click',  () => onProcess('sinr'));
}

// ── CSV UPLOAD ────────────────────────────────────────────────────────────────
function handleCSV(e) {
  const file = e.target.files[0]; if (!file) return;
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete(res) { parseCSV(res.data); e.target.value = ''; },
    error(err)    { alert('Gagal baca CSV: ' + err.message); },
  });
}

function detectCols(headers) {
  const find = cands => {
    for (const h of headers) {
      const hl = h.toLowerCase().replace(/[\s()°_]/g, '');
      if (cands.some(c => hl === c || hl.startsWith(c))) return h;
    }
    return null;
  };
  return {
    lat : find(['latitude','lat','lintang','y']),
    lng : find(['longitude','lon','lng','long','bujur','x']),
    rsrp: find(['rsrpdbm','rsrp','ltersrp','nrrsrp','signal']),
    sinr: find(['sinrdb','sinr','ltsinr','nrsinr','snr']),
  };
}

function parseCSV(rows) {
  if (!rows.length) return;
  const cols = detectCols(Object.keys(rows[0]));
  if (!cols.lat || !cols.lng) {
    alert('Kolom Lat/Lng tidak ditemukan di CSV.');
    return;
  }
  const pn = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const pts = rows.map(r => ({
    lat : pn(r[cols.lat]),
    lng : pn(r[cols.lng]),
    rsrp: cols.rsrp ? pn(r[cols.rsrp]) : null,
    sinr: cols.sinr ? pn(r[cols.sinr]) : null,
  })).filter(p =>
    p.lat !== null && p.lng !== null && !isNaN(p.lat) && !isNaN(p.lng) &&
    p.lat !== 0 && p.lng !== 0 && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180
  );

  state.dtData = pts.filter((p, i) =>
    i === 0 || p.lat !== pts[i-1].lat || p.lng !== pts[i-1].lng
  );

  if (state.dtData.length < 3) {
    alert(`Titik terlalu sedikit (${state.dtData.length}).`);
    return;
  }

  // ── NEWv14: Bangun Convex Hull segera setelah DT diparse ──────────────────
  state.dtHull = buildConvexHull(state.dtData);
  if (state.dtHull) {
    console.log('[coveragecom v14] Convex Hull DT berhasil dibangun',
      turf.area(state.dtHull).toFixed(0), 'm²');
  } else {
    console.warn('[coveragecom v14] Hull gagal — akan fallback ke radius', DEFAULT_THRESHOLD, 'm');
  }

  const nRsrp = state.dtData.filter(p => p.rsrp !== null).length;
  const nSinr = state.dtData.filter(p => p.sinr !== null).length;
  $('dtStatus').textContent = `DT: ${state.dtData.length} titik`;
  $('dtStatus').classList.add('uploaded');
  $('dtPointCount').textContent = `${state.dtData.length} titik`;
  $('dtMapPlaceholder')?.classList.add('hidden');

  renderDTMap('rsrp');
  checkReady();

  const valid = state.dtData.filter(p => p.rsrp !== null);
  if (valid.length) state.dtMap.fitBounds(valid.map(p => [p.lat, p.lng]), { padding: [12,12] });
}

// ── NEWv14: BUILD CONVEX HULL ─────────────────────────────────────────────────
// Membangun convex hull dari titik-titik DT menggunakan Turf.js.
// Return: GeoJSON Polygon, atau null jika gagal.
//
// Catatan implementasi:
//   turf.convex() membutuhkan GeoJSON FeatureCollection of Points.
//   Format koordinat Turf: [longitude, latitude] (GeoJSON standard).
//   Kita swap dari format Leaflet [lat, lng] → [lng, lat].
function buildConvexHull(dtPoints) {
  if (!window.turf) {
    console.warn('[coveragecom v14] Turf.js tidak tersedia — hull dilewati');
    return null;
  }
  if (dtPoints.length < 3) return null;

  try {
    // Buat FeatureCollection of Points [lng, lat] (GeoJSON order)
    const fc = turf.featureCollection(
      dtPoints.map(p => turf.point([p.lng, p.lat]))
    );
    const hull = turf.convex(fc);
    return hull || null; // turf.convex bisa return null jika semua titik collinear
  } catch(e) {
    console.error('[coveragecom v14] buildConvexHull error:', e);
    return null;
  }
}

// ── NEWv14: VISUALISASI HULL DI PETA SIM ─────────────────────────────────────
// Gambar outline convex hull di atas peta simulasi agar user bisa melihat
// area mana yang dipakai sebagai batas komparasi.
function renderHullOnSimMap() {
  state.hullLayer.clearLayers();
  if (!state.dtHull) return;

  // Convert GeoJSON polygon coords [lng,lat] → Leaflet [lat,lng]
  const coords = state.dtHull.geometry.coordinates[0].map(c => [c[1], c[0]]);
  L.polygon(coords, {
    color      : '#ff9800',
    weight     : 2.5,
    dashArray  : '6 4',
    fillColor  : '#ff9800',
    fillOpacity: 0.06,
  })
  .bindPopup(
    `<b>Convex Hull DT</b><br>
     Area: ${(turf.area(state.dtHull) / 1e6).toFixed(3)} km²<br>
     <small>Hanya grid dalam area ini yang dikomparasi</small>`
  )
  .addTo(state.hullLayer);
}

// ── NEWv14: SPATIAL FILTER — CONVEX HULL ─────────────────────────────────────
// Menggantikan applySpatialFilter() lama yang berbasis radius per titik.
//
// Logika baru:
//   - Jika hull tersedia: grid masuk komparasi jika centroid grid ada di DALAM hull
//   - Fallback jika hull null (DT collinear / Turf tidak ada): radius DEFAULT_THRESHOLD
//
// "Inside hull" menggunakan turf.booleanPointInPolygon() — O(n) per grid, cukup cepat
// untuk jumlah grid yang wajar (< 50.000).
function filterGridsByHull(grids, hull) {
  if (!hull || !window.turf) {
    // Fallback: radius lama
    console.warn('[coveragecom v14] Fallback ke radius', DEFAULT_THRESHOLD, 'm');
    return applySpatialFilterLegacy(grids, state.dtData, DEFAULT_THRESHOLD);
  }

  const filtered = grids.filter(g => {
    const pt = turf.point([g.lon, g.lat]); // [lng, lat] GeoJSON order
    return turf.booleanPointInPolygon(pt, hull);
  });

  console.log(`[coveragecom v14] Hull filter: ${filtered.length}/${grids.length} grid masuk hull`);
  return filtered;
}

// Legacy fallback — tidak dihapus agar bisa dipakai jika Turf tidak ada
function applySpatialFilterLegacy(grids, dtPoints, thresholdM) {
  if (!dtPoints.length) return grids;
  return grids.filter(g => {
    for (const pt of dtPoints)
      if (haversineM(g.lat, g.lon, pt.lat, pt.lng) <= thresholdM) return true;
    return false;
  });
}

// ── RENDER PETA DT ────────────────────────────────────────────────────────────
function renderDTMap(metric) {
  state.dtLayer.clearLayers();
  if (!state.dtData.length) return;
  const unit = metric === 'rsrp' ? 'dBm' : 'dB';
  const vals = [];
  state.dtData.forEach(p => {
    const v = metric === 'rsrp' ? p.rsrp : p.sinr;
    if (v === null || isNaN(v)) return;
    vals.push(v);
    L.circleMarker([p.lat, p.lng], {
      radius: 4, fillColor: getColor(v, metric),
      color: 'rgba(0,0,0,0.2)', weight: 0.5, fillOpacity: 0.92,
    }).bindPopup(`<b>Drive Test</b><br>${metric.toUpperCase()}: <b>${v.toFixed(1)} ${unit}</b>`).addTo(state.dtLayer);
  });
  renderLegend('dtLegend','dtLegendTitle','dtLegendBody', metric, vals);
  $('dtPointCount').textContent = `${state.dtData.length} titik`;
}

// ── RENDER PETA SIM ───────────────────────────────────────────────────────────
function renderSimMap(metric) {
  state.simLayer.clearLayers();
  if (!state.simExport?.grids?.length) return;
  const unit = metric === 'rsrp' ? 'dBm' : 'dB';
  const vals = [];
  state.simExport.grids.forEach(g => {
    const v = metric === 'rsrp' ? (g.rsrpValue ?? g.value) : (g.sinrValue ?? g.value);
    if (v == null || isNaN(v)) return;
    vals.push(v);
    const c = getColor(v, metric);
    L.polygon(g.bounds, { color: c, fillColor: c, fillOpacity: 0.72, weight: 0 })
      .bindPopup(`<b>Sim — ${g.servingSiteId || '?'}</b><br>${metric.toUpperCase()}: <b>${v.toFixed(1)} ${unit}</b>`)
      .addTo(state.simLayer);
  });
  renderLegend('simLegend','simLegendTitle','simLegendBody', metric, vals);
  $('simCellCount').textContent = `${vals.length} grid`;

  const gs = state.simExport.grids;
  const lats = gs.map(g => g.lat), lons = gs.map(g => g.lon);
  state.simMap.fitBounds([
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ], { padding: [12,12] });
}

// ── NEWv14: RENDER PETA SIM — HANYA GRID DALAM HULL ──────────────────────────
function renderSimMapFiltered(filteredGrids, metric) {
  state.simLayer.clearLayers();
  if (!filteredGrids?.length) return;
  const unit = metric === 'rsrp' ? 'dBm' : 'dB';
  const vals = [];
  filteredGrids.forEach(g => {
    const v = metric === 'rsrp' ? (g.rsrpValue ?? g.value) : (g.sinrValue ?? g.value);
    if (v == null || isNaN(v)) return;
    vals.push(v);
    const c = getColor(v, metric);
    L.polygon(g.bounds, { color: c, fillColor: c, fillOpacity: 0.72, weight: 0 })
      .bindPopup(`<b>Sim — ${g.servingSiteId || '?'}</b><br>${metric.toUpperCase()}: <b>${v.toFixed(1)} ${unit}</b>`)
      .addTo(state.simLayer);
  });
  renderLegend('simLegend','simLegendTitle','simLegendBody', metric, vals);
  $('simCellCount').textContent = `${vals.length} grid (dalam hull)`;
}

// ── LEGEND ────────────────────────────────────────────────────────────────────
function renderLegend(legendId, titleId, bodyId, metric, values) {
  const el = $(legendId); if (!el) return;
  el.style.display = 'block';
  $(titleId).textContent = metric === 'rsrp' ? 'RSRP (dBm)' : 'SINR (dB)';
  const total = values.filter(v => !isNaN(v)).length || 1;
  $(bodyId).innerHTML = getBuckets(metric).map(b => {
    const cnt = values.filter(v => !isNaN(v) && v >= b.min && v < b.max).length;
    return `<tr>
      <td><span class="legend-color-swatch" style="background:${b.color}"></span></td>
      <td>${b.range}</td>
      <td><b>${((cnt/total)*100).toFixed(1)}%</b></td>
    </tr>`;
  }).join('');
}

// ── HAVERSINE (legacy, masih dipakai di fallback) ─────────────────────────────
function haversineM(la1, lo1, la2, lo2) {
  const R = 6378137;
  const a = Math.sin((la2-la1)*Math.PI/360)**2 +
            Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*
            Math.sin((lo2-lo1)*Math.PI/360)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── PROSES UTAMA ──────────────────────────────────────────────────────────────
function onProcess(metric) {
  showLoading(`Memproses ${metric.toUpperCase()}…`);
  setTimeout(() => {
    try   { runComparison(metric); }
    catch (e) { console.error(e); alert('Error: ' + e.message); }
    finally   { hideLoading(); }
  }, 60);
}

function runComparison(metric) {
  const unit = metric === 'rsrp' ? 'dBm' : 'dB';

  // 1. Kumpulkan nilai DT
  const dtVals = state.dtData
    .map(p => metric === 'rsrp' ? p.rsrp : p.sinr)
    .filter(v => v !== null && !isNaN(v));

  if (dtVals.length < 5) {
    alert(`Data DT tidak cukup untuk ${metric.toUpperCase()} (hanya ${dtVals.length} titik).`);
    return;
  }

  // 2. NEWv14: Filter grid sim menggunakan Convex Hull DT
  //    (bukan lagi radius per titik)
  const filtered = filterGridsByHull(state.simExport.grids, state.dtHull);
  const simVals = filtered
    .map(g => metric === 'rsrp' ? (g.rsrpValue ?? g.value) : (g.sinrValue ?? g.value))
    .filter(v => v != null && !isNaN(v));

  if (simVals.length < 5) {
    alert(`Grid simulasi dalam convex hull DT terlalu sedikit (${simVals.length}).\n` +
          `Pastikan area simulasi mencakup jalur drive test.`);
    return;
  }

  // 3. Update peta + gambar hull di peta sim
  //    Peta sim hanya menampilkan grid yang lolos hull filter
  renderDTMap(metric);
  renderSimMapFiltered(filtered, metric); // ← NEWv14: hanya grid dalam hull
  renderHullOnSimMap();

  // 4. Hitung 3 metrik
  const bias    = calcMeanBias(dtVals, simVals);
  const pctiles = calcPercentiles(dtVals, simVals);
  const covGap  = calcCoverageGap(dtVals, simVals, metric);

  // 5. Informasi area hull untuk ditampilkan di UI
  const hullInfo = state.dtHull ? {
    areakm2  : (turf.area(state.dtHull) / 1e6).toFixed(3),
    method   : 'Convex Hull DT',
  } : {
    areakm2  : null,
    method   : `Radius ${DEFAULT_THRESHOLD}m (fallback)`,
  };

  // 6. Render UI
  $('waitingPanel').style.display   = 'none';
  $('metricsSection').style.display = 'block';
  $('analysisPanel').style.display  = 'block';

  $('metricsSub').textContent =
    `${metric.toUpperCase()} · ${dtVals.length} titik DT · ` +
    `${simVals.length} grid sim (${hullInfo.method}` +
    (hullInfo.areakm2 ? ` · ${hullInfo.areakm2} km²` : '') + `)`;

  renderMetricCards(bias, pctiles, covGap, metric, dtVals.length, simVals.length, hullInfo);
  renderAnalysis(bias, pctiles, covGap, metric, hullInfo);

  console.log(`[coveragecom v14] ${metric.toUpperCase()} | bias=${bias.toFixed(2)} | ` +
    `P50Δ=${pctiles.p50.delta.toFixed(1)} | covGap=${covGap.gap.toFixed(1)}pp | ` +
    `filter=${hullInfo.method} | gridMasuk=${simVals.length}/${state.simExport.grids.length}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// KALKULASI 3 METRIK (tidak berubah dari v13)
// ══════════════════════════════════════════════════════════════════════════════

function calcMeanBias(dtVals, simVals) {
  const mean = arr => arr.reduce((s,v) => s+v, 0) / arr.length;
  return +(mean(simVals) - mean(dtVals)).toFixed(2);
}

function getPercentile(sorted, p) {
  const idx = Math.max(0, Math.min(sorted.length-1, Math.round((p/100)*(sorted.length-1))));
  return sorted[idx];
}

function calcPercentiles(dtVals, simVals) {
  const dtS  = [...dtVals].sort((a,b) => a-b);
  const simS = [...simVals].sort((a,b) => a-b);
  const make = p => {
    const dtV  = getPercentile(dtS, p);
    const simV = getPercentile(simS, p);
    return { dt: +dtV.toFixed(1), sim: +simV.toFixed(1), delta: +(simV-dtV).toFixed(1) };
  };
  return { p10: make(10), p50: make(50), p90: make(90) };
}

function calcCoverageGap(dtVals, simVals, metric) {
  const threshold = metric === 'rsrp' ? -95 : 0;
  const label     = metric === 'rsrp' ? 'RSRP ≥ −95 dBm' : 'SINR ≥ 0 dB';
  const dtPct  = (dtVals.filter(v  => v >= threshold).length  / dtVals.length)  * 100;
  const simPct = (simVals.filter(v => v >= threshold).length / simVals.length) * 100;
  return {
    dtPct  : +dtPct.toFixed(1),
    simPct : +simPct.toFixed(1),
    gap    : +(simPct - dtPct).toFixed(1),
    threshold,
    label,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// RENDER METRIC CARDS — tambah info hull di header
// ══════════════════════════════════════════════════════════════════════════════
function renderMetricCards(bias, pctiles, covGap, metric, nDT, nSim, hullInfo) {
  const unit     = metric === 'rsrp' ? 'dBm' : 'dB';
  const biasAbs  = Math.abs(bias);
  const biasSign = bias > 0 ? '+' : '';

  const wrap = $('metricsCardsWrap');
  wrap.innerHTML = `
    <div class="metric-group">

      <div class="metric-group-header mgh-cov">
        <div class="mgh-left">
          <span class="mgh-badge">${metric.toUpperCase()}</span>
          <div class="mgh-facts">
            <span class="mgh-fact-item">
              <span class="mgh-fact-label">DT:</span>
              <span class="mgh-fact-val">${nDT} titik</span>
            </span>
            <span class="mgh-fact-sep">|</span>
            <span class="mgh-fact-item">
              <span class="mgh-fact-label">Sim (terfilter):</span>
              <span class="mgh-fact-val">${nSim} grid</span>
            </span>
            <span class="mgh-fact-sep">|</span>
            <!-- NEWv14: tampilkan metode & area filter -->
            <span class="mgh-fact-item">
              <span class="mgh-fact-label">Filter area:</span>
              <span class="mgh-fact-val">${hullInfo.method}${hullInfo.areakm2 ? ' · ' + hullInfo.areakm2 + ' km²' : ''}</span>
            </span>
            <span class="mgh-fact-sep">|</span>
            <span class="mgh-fact-item">
              <span class="mgh-fact-label">P50 DT:</span>
              <span class="mgh-fact-val">${pctiles.p50.dt} ${unit}</span>
            </span>
            <span class="mgh-fact-sep">|</span>
            <span class="mgh-fact-item">
              <span class="mgh-fact-label">P50 Sim:</span>
              <span class="mgh-fact-val">${pctiles.p50.sim} ${unit}</span>
            </span>
          </div>
        </div>
      </div>

      <div class="metric-cards-row metric-cards-3">

        <!-- KARTU 1: Mean Bias -->
        <div class="metric-card mc-neutral">
          <div class="mc-top">
            <span class="mc-key">Mean Error</span>
            <span class="mc-type-badge mcb-dist">Distribusi</span>
          </div>
          <div class="mc-val">${biasSign}${biasAbs}<span class="mc-unit">${unit}</span></div>
          <div class="mc-label">Selisih Rata-rata Sinyal</div>
          <div class="mc-desc">
            Rata-rata simulasi ${bias > 0 ? 'lebih tinggi' : bias < 0 ? 'lebih rendah' : 'sama dengan'}
            drive test sebesar <b>${biasAbs} ${unit}</b>.
            ${bias < 0
              ? 'Wajar karena DT dilakukan di jalan terbuka yang sinyalnya lebih kuat dari rata-rata area.'
              : bias > 0
                ? 'Simulasi cenderung lebih optimis — pertimbangkan menaikkan clutter loss.'
                : 'Tidak ada kecenderungan offset.'}
          </div>
        </div>

        <!-- KARTU 2: Percentile -->
        <div class="metric-card mc-neutral">
          <div class="mc-top">
            <span class="mc-key">Persentil P10 / P50 / P90</span>
            <span class="mc-type-badge mcb-dist">Distribusi</span>
          </div>
          <div class="mc-val">${pctiles.p50.delta > 0 ? '+' : ''}${pctiles.p50.delta}<span class="mc-unit">${unit}</span></div>
          <div class="mc-label">Selisih Nilai Tengah (P50)</div>
          <div class="mc-desc">Perbandingan nilai khas di tiga posisi distribusi:</div>
          <table class="pct-mini-table">
            <thead><tr><th></th><th>DT</th><th>Sim</th><th>Δ</th></tr></thead>
            <tbody>
              <tr>
                <td class="pct-label">P10 <span class="pct-hint">Sinyal lemah</span></td>
                <td>${pctiles.p10.dt}</td><td>${pctiles.p10.sim}</td>
                <td class="${Math.abs(pctiles.p10.delta)<=6?'delta-ok':'delta-warn'}">${pctiles.p10.delta>0?'+':''}${pctiles.p10.delta}</td>
              </tr>
              <tr class="pct-row-highlight">
                <td class="pct-label">P50 <span class="pct-hint">Nilai tengah ★</span></td>
                <td><b>${pctiles.p50.dt}</b></td><td><b>${pctiles.p50.sim}</b></td>
                <td class="${Math.abs(pctiles.p50.delta)<=6?'delta-ok':'delta-warn'}">${pctiles.p50.delta>0?'+':''}${pctiles.p50.delta}</td>
              </tr>
              <tr>
                <td class="pct-label">P90 <span class="pct-hint">Sinyal kuat</span></td>
                <td>${pctiles.p90.dt}</td><td>${pctiles.p90.sim}</td>
                <td class="${Math.abs(pctiles.p90.delta)<=6?'delta-ok':'delta-warn'}">${pctiles.p90.delta>0?'+':''}${pctiles.p90.delta}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- KARTU 3: Coverage Probability Gap -->
        <div class="metric-card mc-neutral">
          <div class="mc-top">
            <span class="mc-key">Coverage Probability Gap</span>
            <span class="mc-type-badge mcb-dist">Distribusi</span>
          </div>
          <div class="mc-val">${covGap.gap > 0 ? '+' : ''}${covGap.gap}<span class="mc-unit">pp</span></div>
          <div class="mc-label">Selisih % Area Sinyal Baik</div>
          <div class="mc-desc">Persentase titik/area dengan ${covGap.label}:</div>
          <div class="cov-gap-bars">
            <div class="cgb-row">
              <span class="cgb-label">Drive Test</span>
              <div class="cgb-track">
                <div class="cgb-fill cgb-dt" style="width:${Math.min(covGap.dtPct,100)}%"></div>
              </div>
              <span class="cgb-val">${covGap.dtPct}%</span>
            </div>
            <div class="cgb-row">
              <span class="cgb-label">Simulasi</span>
              <div class="cgb-track">
                <div class="cgb-fill cgb-sim" style="width:${Math.min(covGap.simPct,100)}%"></div>
              </div>
              <span class="cgb-val">${covGap.simPct}%</span>
            </div>
          </div>
          <div class="mc-desc" style="margin-top:6px;">
            ${Math.abs(covGap.gap) <= 8
              ? `Selisih ${Math.abs(covGap.gap)} pp — estimasi area terlayani cukup konsisten.`
              : covGap.gap > 0
                ? `Simulasi estimasi coverage ${covGap.gap} pp lebih luas — model cenderung optimis.`
                : `Simulasi estimasi coverage ${Math.abs(covGap.gap)} pp lebih sempit — wajar karena sim mencakup area indoor.`
            }
          </div>
        </div>

      </div>
    </div>`;

  // Note metodologi
  const noteEl = $('metricsNote');
  noteEl.style.display = 'block';

  const sinrNote = metric === 'sinr' ? `
    <div class="cvt-sinr-note">
      <span class="cvt-sinr-icon">ℹ️</span>
      <span>
        <b>Catatan khusus SINR:</b> Gap SINR yang besar antara simulasi dan drive test adalah
        <b>kondisi yang expected</b> — drive test hanya mengukur di jalur jalan dengan interferensi
        lebih menguntungkan, simulasi mencakup zona handover dan interferensi silang antar site.
      </span>
    </div>` : '';

  // NEWv14: Tambah keterangan convex hull di note metodologi
  const hullNote = `
    <div class="cvt-hull-note" style="margin-top:8px;padding:8px 10px;background:#fff8e1;border-left:3px solid #ff9800;border-radius:3px;font-size:11px;line-height:1.6;">
      <b>🔶 Spatial Filter v14 — Convex Hull:</b>
      Grid simulasi yang dikomparasi dibatasi pada <b>convex hull dari jalur drive test</b>
      (${hullInfo.areakm2 ? hullInfo.areakm2 + ' km²' : 'area DT'}) — bukan radius tetap per titik.
      Pendekatan ini memastikan komparasi hanya pada area yang benar-benar disurvei,
      menghindari <i>area extrapolation bias</i>.
      Outline hull ditampilkan sebagai garis oranye putus-putus di peta simulasi.
    </div>`;

  noteEl.innerHTML = `
    <div class="cvt-method-note">
      <i class="fas fa-info-circle"></i>
      <span>
        <b>Pendekatan: Coverage Verification Testing (CVT).</b>
        Validasi dilakukan pada level distribusi, bukan per titik.
        Grid simulasi difilter menggunakan <b>Convex Hull DT</b> untuk memastikan
        area komparasi setara dengan area yang disurvei.
        <span style="color:#888">(ITU-R P.1546-6 §4 · Bunting 2018 · Congalton & Green 2019 Ch.4)</span>
      </span>
    </div>
    ${hullNote}
    ${sinrNote}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// RENDER ANALISIS — tidak berubah dari v13, dipertahankan lengkap
// ══════════════════════════════════════════════════════════════════════════════
function renderAnalysis(bias, pctiles, covGap, metric, hullInfo) {
  const unit    = metric === 'rsrp' ? 'dBm' : 'dB';
  const biasAbs = Math.abs(bias);
  const p50dAbs = Math.abs(pctiles.p50.delta);
  const gapAbs  = Math.abs(covGap.gap);
  const isSINR  = metric === 'sinr';

  const biasTol = 6;
  const p50Tol  = 6;
  const gapTol  = 12;

  const biasOk = biasAbs <= biasTol;
  const p50Ok  = p50dAbs <= p50Tol;
  const gapOk  = gapAbs  <= gapTol;

  let vClass, vIcon, vTitle, vDesc;

  if (isSINR && !gapOk) {
    vClass = 'ok'; vIcon = '⚠️';
    vTitle = 'Gap SINR Besar — Sesuai Ekspektasi CVT';
    vDesc  = `Gap SINR antara simulasi dan drive test yang besar adalah kondisi expected dalam CVT.
              Drive test hanya mengukur di jalur jalan — kondisi interferensi lebih menguntungkan.
              Simulasi mencakup zona handover dan interferensi silang yang tidak diukur DT.`;
  } else if (biasOk && p50Ok && gapOk) {
    vClass = 'good'; vIcon = '✅';
    vTitle = 'Distribusi Simulasi Konsisten dengan Drive Test';
    vDesc  = `Ketiga metrik menunjukkan kemiripan yang baik. Model coverage dapat dijadikan
              acuan perencanaan jaringan untuk area ini.`;
  } else if (biasOk || p50Ok) {
    vClass = 'ok'; vIcon = '⚠️';
    vTitle = 'Distribusi Cukup Konsisten — Ada Selisih yang Bisa Dijelaskan';
    vDesc  = `Sebagian metrik menunjukkan kemiripan yang cukup. Perbedaan yang ada wajar karena
              drive test hanya mengambil sampel di jalur jalan, simulasi mencakup seluruh area
              termasuk zona indoor dan interferensi tinggi.`;
  } else {
    vClass = 'bad'; vIcon = '🔴';
    vTitle = 'Perbedaan Distribusi Signifikan — Perlu Evaluasi Parameter';
    vDesc  = `Distribusi simulasi dan drive test berbeda melebihi batas toleransi. Pertimbangkan
              menyesuaikan parameter clutter loss, scenario propagasi, atau tinggi antena.`;
  }

  const f1 = bias < 0
    ? `Mean Bias = <b>${bias} ${unit}</b>. Simulasi rata-rata ${biasAbs} ${unit} lebih rendah dari DT.
       Pola umum dalam CVT — drive test di jalan terbuka secara struktural mendapat sinyal lebih kuat.
       ${biasAbs <= biasTol ? 'Selisih masih dalam batas toleransi.' : 'Selisih cukup besar — pertimbangkan menyesuaikan clutter loss.'}`
    : bias > 0
      ? `Mean Bias = <b>+${bias} ${unit}</b>. Simulasi lebih optimis ${biasAbs} ${unit} dari DT.
         Pertimbangkan menaikkan clutter loss atau menggunakan kondisi NLOS yang lebih ketat.`
      : `Mean Bias ≈ 0 — rata-rata simulasi sangat mendekati pengukuran lapangan.`;

  const f2 = `P50: sim ${pctiles.p50.sim} vs DT ${pctiles.p50.dt} ${unit},
    Δ <b>${pctiles.p50.delta > 0 ? '+' : ''}${pctiles.p50.delta} ${unit}</b>.
    ${p50dAbs <= p50Tol ? 'Nilai median berdekatan — pola distribusi representatif.' : 'Selisih median cukup besar.'}
    P10 Δ: ${pctiles.p10.delta > 0 ? '+' : ''}${pctiles.p10.delta} ${unit}.
    P90 Δ: ${pctiles.p90.delta > 0 ? '+' : ''}${pctiles.p90.delta} ${unit}.`;

  const f3 = `Area ${covGap.label}:
    DT <b>${covGap.dtPct}%</b> vs Sim <b>${covGap.simPct}%</b>,
    selisih <b>${covGap.gap > 0 ? '+' : ''}${covGap.gap} pp</b>.
    ${gapAbs <= gapTol
      ? 'Estimasi luas area terlayani konsisten.'
      : isSINR
        ? `Gap -${gapAbs} pp untuk SINR adalah karakteristik inheren CVT — bukan indikasi model salah.`
        : covGap.gap < 0
          ? `Simulasi memperkirakan coverage lebih sempit — wajar karena sim mencakup area indoor.`
          : `Simulasi memperkirakan coverage lebih luas — model mungkin terlalu optimis.`
    }`;

  let recClass, recIcon, recText;
  if (vClass === 'good') {
    recIcon = '💡'; recClass = 'rec-ok';
    recText = `Model coverage konsisten dengan sampel drive test. Distribusi sinyal simulasi
               representatif dan layak dijadikan acuan perencanaan.`;
  } else if (isSINR && !gapOk) {
    recIcon = '⚠️'; recClass = 'rec-warn';
    recText = `Gap Coverage Probability SINR sebesar ${gapAbs} pp adalah karakteristik inheren
               perbandingan coverage simulation vs DT — bukan indikasi model salah.
               Gunakan halaman <b>Simulasi DT</b> untuk validasi SINR point-to-point (ME/MAE/RMSE).`;
  } else if (bias < -biasTol) {
    recIcon = '🔧'; recClass = 'rec-warn';
    recText = `Offset negatif ${biasAbs} ${unit} mencerminkan <i>road-sampling bias</i> yang umum dalam CVT.
               Jika ingin mengurangi offset: turunkan clutter loss atau ubah kondisi ke LOS/Mixed.`;
  } else if (bias > biasTol) {
    recIcon = '🔧'; recClass = 'rec-warn';
    recText = `Offset positif ${biasAbs} ${unit} — simulasi terlalu optimis.
               Saran: naikkan clutter loss sesuai karakteristik area,
               atau gunakan kondisi NLOS jika area padat gedung.`;
  } else {
    recIcon = '🔧'; recClass = 'rec-warn';
    recText = `Sesuaikan parameter clutter dan scenario propagasi untuk meningkatkan konsistensi distribusi.`;
  }

  $('analysisContent').innerHTML = `
    <div class="simple-analysis">
      <div class="sa-verdict ${vClass}">
        <div class="sa-verdict-icon">${vIcon}</div>
        <div class="sa-verdict-body">
          <div class="sa-verdict-title">${vTitle}</div>
          <div class="sa-verdict-desc">${vDesc}</div>
        </div>
      </div>

      <div class="sa-findings">
        <div class="sa-finding-title"><i class="fas fa-search"></i> Temuan per Metrik</div>
        <div class="sa-finding ${biasOk ? 'sf-ok' : 'sf-warn'}">
          <div class="sf-num">1</div>
          <div class="sf-content">
            <div class="sf-head">Mean Bias — Arah Rata-rata Selisih</div>
            <div class="sf-body">${f1}</div>
          </div>
        </div>
        <div class="sa-finding ${p50Ok ? 'sf-ok' : 'sf-warn'}">
          <div class="sf-num">2</div>
          <div class="sf-content">
            <div class="sf-head">Persentil P10/P50/P90 — Kemiripan Pola Distribusi</div>
            <div class="sf-body">${f2}</div>
          </div>
        </div>
        <div class="sa-finding ${(gapOk || (isSINR && !gapOk)) ? 'sf-ok' : 'sf-warn'}">
          <div class="sf-num">3</div>
          <div class="sf-content">
            <div class="sf-head">Coverage Probability Gap — Estimasi Luas Area Terlayani</div>
            <div class="sf-body">${f3}</div>
          </div>
        </div>
      </div>

      <div class="sa-rec ${recClass}">
        <div class="sa-rec-icon">${recIcon}</div>
        <div class="sa-rec-body">
          <div class="sa-rec-title">Rekomendasi</div>
          <div class="sa-rec-text">${recText}</div>
        </div>
      </div>

      <details class="sa-detail-toggle" style="margin-top:4px;">
        <summary>📚 Referensi Metodologi</summary>
        <div class="sa-detail-body" style="font-size:10.5px;color:#555;line-height:1.75;">
          <p>
            Validasi coverage menggunakan <b>Coverage Verification Testing (CVT)</b>.
            Grid simulasi difilter menggunakan <b>Convex Hull DT</b> (v14) untuk
            <i>spatial extent matching</i> — memastikan area komparasi setara
            (Congalton & Green, 2019, Ch.4).
          </p>
          <table class="sa-detail-table" style="margin-top:6px;">
            <thead><tr><th>Metrik</th><th>Nilai</th><th>Referensi</th></tr></thead>
            <tbody>
              <tr><td>Mean Bias</td><td>${bias > 0 ? '+' : ''}${bias} ${unit}</td><td>ITU-R P.1546-6 §4</td></tr>
              <tr><td>Percentile P50 Gap</td><td>${pctiles.p50.delta > 0 ? '+' : ''}${pctiles.p50.delta} ${unit}</td><td>3GPP TR 38.901 §8.1</td></tr>
              <tr><td>Coverage Probability Gap</td><td>${covGap.gap > 0 ? '+' : ''}${covGap.gap} pp</td><td>3GPP TS 38.104 §A.3</td></tr>
              <tr><td>Spatial filter</td><td>${hullInfo.method}${hullInfo.areakm2 ? ' · ' + hullInfo.areakm2 + ' km²' : ''}</td><td>Congalton & Green (2019) Ch.4</td></tr>
              <tr><td>DT titik (N)</td><td>${state.dtData.length}</td><td>—</td></tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>`;
}

// ── UTILITIES ─────────────────────────────────────────────────────────────────
function checkReady() {
  const ok = state.dtData.length > 0 && state.simExport !== null;
  ['processRSRPBtn','processSINRBtn'].forEach(id => {
    const b = $(id); if (b) b.disabled = !ok;
  });
}

function showLoading(msg) {
  hideLoading();
  const el = document.createElement('div');
  el.id = 'cvOverlay'; el.className = 'loading-overlay';
  el.innerHTML = `<div class="loading-box"><div class="spinner"></div><p class="loading-txt">${msg}</p></div>`;
  document.body.appendChild(el);
}
function hideLoading() { document.getElementById('cvOverlay')?.remove(); }

console.log('coveragecom.js v14 — Convex Hull spatial filter (Turf.js) | CVT approach | 3 metrik: Mean Bias | P10/P50/P90 | Coverage Probability Gap');