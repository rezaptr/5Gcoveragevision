'use strict';
/* ================================================
   simulationcom.js — v8 MULTISITE PURE MODEL REBUILD
   - Multi-file upload (1 file CSV = sudah punya Sim & Aktual sekaligus)
   - Auto-detect Site / Scenario (UMi/UMa) / Condition (LOS/NLOS)
   - Metrik ME, RMSE, SD dari Sim vs Aktual (MODEL MURNI, tanpa kalibrasi)
   - Tabel ringkasan per Site > Scenario > Condition
   - Auto-detect skenario terbaik (RMSE rata-rata terkecil lintas site)
   - Drill-down akurasi per rentang jarak, khusus skenario terbaik
   - Peta side-by-side: Drive Test Aktual vs Hasil Simulasi (multisite)
   - Switch metrik SS-RSRP / SS-SINR (tab, bukan tampil bersamaan)
   ================================================ */

const $ = id => document.getElementById(id);

const DIST_RANGES = [
  { label: '< 200 m',     min: 0,   max: 200,      desc: 'Jarak dekat' },
  { label: '200–400 m',   min: 200, max: 400,      desc: 'Jarak sedang' },
  { label: '400–600 m',   min: 400, max: 600,      desc: 'Jarak menengah' },
  { label: '600–800 m',   min: 600, max: 800,      desc: 'Jarak jauh' },
  { label: '> 800 m',     min: 800, max: Infinity, desc: 'Jarak sangat jauh' },
];

const state = {
  files: [],           // [{id, filename, site, scenario, condition, rows:[...]}]
  activeMetric: 'rsrp',
  bestScenario: null,  // {scenario, condition, rmse}
  map: null, dtMap: null, simMap: null,
  dtLayer: null, simLayer: null,
  mapFilterFileId: 'all', // 'all' = gabung semua file, atau id file spesifik
  nextId: 1,
};

document.addEventListener('DOMContentLoaded', () => {
  initMaps();
  attachEvents();
  renderAll();
});

/* ── SETUP MAP ─────────────────────────────────────────────────────── */
function initMaps() {
  const tile = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const opt  = { attribution: '© OpenStreetMap', maxZoom: 19 };
  const ctr  = [-6.2088, 106.8456];
  state.dtMap  = L.map('dtMap').setView(ctr, 13);
  state.simMap = L.map('simMap').setView(ctr, 13);
  L.tileLayer(tile, opt).addTo(state.dtMap);
  L.tileLayer(tile, opt).addTo(state.simMap);
  state.dtLayer  = L.layerGroup().addTo(state.dtMap);
  state.simLayer = L.layerGroup().addTo(state.simMap);

  let syncing = false;
  const sync = (src, dst) => src.on('move', () => {
    if (syncing) return; syncing = true;
    dst.setView(src.getCenter(), src.getZoom(), { animate: false });
    syncing = false;
  });
  sync(state.dtMap, state.simMap);
  sync(state.simMap, state.dtMap);
}

function attachEvents() {
  $('uploadBtn')?.addEventListener('click', () => $('csvInput').click());
  $('csvInput')?.addEventListener('change', handleUpload);
  $('resetBtn')?.addEventListener('click', resetAll);
  $('exportPdfBtn')?.addEventListener('click', () => window.print());

  $('metricTabRsrp')?.addEventListener('click', () => switchMetric('rsrp'));
  $('metricTabSinr')?.addEventListener('click', () => switchMetric('sinr'));

  $('fileChipRow')?.addEventListener('click', e => {
    const btn = e.target.closest('.fc-remove');
    if (!btn) return;
    removeFile(btn.dataset.file);
  });

  $('mapFileFilter')?.addEventListener('change', e => {
    state.mapFilterFileId = e.target.value;
    renderMaps();
  });
}

/* ── UPLOAD & PARSE ────────────────────────────────────────────────── */
function handleUpload(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  e.target.value = '';
  showLoading(`Memproses ${files.length} file CSV...`);
  const startTime = Date.now();

  Promise.allSettled(files.map(parseFileAsync)).then(results => {
    const succeeded = [];
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') succeeded.push(r.value);
      else failed.push({ filename: files[i].name, message: r.reason?.message || 'Gagal memproses file' });
    });
    state.files.push(...succeeded);
    hideLoading();
    renderAll();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalPts = succeeded.reduce((s, f) => s + f.rows.length, 0);

    // ── Susun 1 alert ringkas: berhasil / kurang lengkap / gagal ──
    const lines = [];
    if (succeeded.length) {
      lines.push(`✅ ${succeeded.length} file berhasil diupload (${totalPts.toLocaleString()} titik) dalam ${elapsed} detik.`);
      succeeded.forEach(f => {
        lines.push(`   • ${f.filename} — ${f.site} ${f.scenario}-${f.condition} (${f.rows.length.toLocaleString()} titik)`);
      });
    }
    const withWarnings = succeeded.filter(f => f.warnings.length);
    if (withWarnings.length) {
      lines.push('');
      lines.push(`⚠️ ${withWarnings.length} file kurang lengkap (tetap diproses):`);
      withWarnings.forEach(f => {
        lines.push(`   ${f.filename}:`);
        f.warnings.forEach(w => lines.push(`     - ${w}`));
      });
    }
    if (failed.length) {
      lines.push('');
      lines.push(`❌ ${failed.length} file gagal diproses:`);
      failed.forEach(f => lines.push(`   • ${f.filename}: ${f.message}`));
    }
    alert(lines.join('\n'));
  });
}

function parseFileAsync(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true, dynamicTyping: true, skipEmptyLines: true,
      complete: res => {
        try { resolve(buildFileEntry(res.data, file.name)); }
        catch (err) { reject(err); }
      },
      error: () => reject(new Error(`Gagal membaca ${file.name}`)),
    });
  });
}

function normalizeHeader(h) { return h.toLowerCase().replace(/[\s()_./-]/g, ''); }

function findCol(headers, cands) {
  for (const c of cands) for (const h of headers) if (normalizeHeader(h) === c) return h;
  for (const c of cands) for (const h of headers) if (normalizeHeader(h).includes(c)) return h;
  return null;
}

function mostFrequent(arr) {
  if (!arr.length) return null;
  const tally = {};
  arr.forEach(v => { tally[v] = (tally[v] || 0) + 1; });
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
}

function buildFileEntry(rows, filename) {
  if (!rows.length) throw new Error(`${filename}: file kosong — tidak ada baris data.`);
  const headers = Object.keys(rows[0]);

  const colLat    = findCol(headers, ['latitude', 'lat']);
  const colLng    = findCol(headers, ['longitude', 'lng', 'long']);
  const colSite   = findCol(headers, ['servingsite', 'site']);
  const colScen   = findCol(headers, ['scenario']);
  const colCond   = findCol(headers, ['condition']);
  const colDist   = findCol(headers, ['distancetoservingm', 'distance']);

  const colRsrpSim = findCol(headers, ['rsrpsimdbm', 'rsrpsim']);
  const colSinrSim = findCol(headers, ['sinrsimdb', 'sinrsim']);
  const colRsrpAkt = findCol(headers, ['rsrpaktualdbm', 'rsrpaktual']);
  const colSinrAkt = findCol(headers, ['sinraktualdb', 'sinraktual']);

  const colDRsrpSim = findCol(headers, ['deltarsrpsimdb', 'deltarsrpsim']);
  const colDSinrSim = findCol(headers, ['deltasinrsimdb', 'deltasinrsim']);

  if (!colLat || !colLng) throw new Error(`${filename}: kolom Latitude/Longitude tidak ditemukan. Header terbaca: ${headers.slice(0, 6).join(', ')}...`);
  if (!colRsrpSim && !colSinrSim) throw new Error(`${filename}: kolom RSRP_Sim / SINR_Sim tidak ditemukan. Pastikan file adalah hasil ekspor simulasi yang benar.`);

  // Kumpulkan peringatan (bukan error fatal) — file tetap diproses, tapi
  // pengguna perlu tahu ada bagian yang tidak lengkap.
  const warnings = [];
  if (!colSite) warnings.push('kolom Serving_Site tidak ditemukan (site akan tertulis "Unknown")');
  if (!colScen) warnings.push('kolom Scenario tidak ditemukan (skenario tidak dapat dikelompokkan)');
  if (!colCond) warnings.push('kolom Condition tidak ditemukan (LOS/NLOS tidak dapat dikelompokkan)');
  if (!colDist) warnings.push('kolom Distance_to_Serving tidak ditemukan (analisis per rentang jarak akan kosong)');
  if (!colRsrpSim) warnings.push('kolom RSRP_Sim tidak ditemukan (metrik SS-RSRP tidak akan tersedia)');
  if (!colSinrSim) warnings.push('kolom SINR_Sim tidak ditemukan (metrik SS-SINR tidak akan tersedia)');
  if (!colRsrpAkt) warnings.push('kolom RSRP_Aktual tidak ditemukan (ME/RMSE/SD RSRP tidak dapat dihitung tanpa Delta_RSRP_Sim)');
  if (!colSinrAkt) warnings.push('kolom SINR_Aktual tidak ditemukan (ME/RMSE/SD SINR tidak dapat dihitung tanpa Delta_SINR_Sim)');

  const pn = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

  const parsedRows = rows.map(r => {
    const lat = pn(r[colLat]), lng = pn(r[colLng]);
    const rsrpSim = colRsrpSim ? pn(r[colRsrpSim]) : null;
    const sinrSim = colSinrSim ? pn(r[colSinrSim]) : null;
    const rsrpAkt = colRsrpAkt ? pn(r[colRsrpAkt]) : null;
    const sinrAkt = colSinrAkt ? pn(r[colSinrAkt]) : null;

    // Model murni: Delta = Sim - Aktual. Pakai kolom Delta kalau tersedia,
    // fallback hitung sendiri supaya tetap jalan walau kolom delta tidak ada.
    const deltaRsrp = colDRsrpSim ? pn(r[colDRsrpSim]) : (rsrpSim != null && rsrpAkt != null ? rsrpSim - rsrpAkt : null);
    const deltaSinr = colDSinrSim ? pn(r[colDSinrSim]) : (sinrSim != null && sinrAkt != null ? sinrSim - sinrAkt : null);

    return {
      lat, lng,
      dist: colDist ? pn(r[colDist]) : null,
      rsrpSim, sinrSim, rsrpAkt, sinrAkt,
      deltaRsrp, deltaSinr,
    };
  }).filter(r => r.lat !== null && r.lng !== null &&
    Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180 && r.lat !== 0 && r.lng !== 0);

  if (!parsedRows.length) throw new Error(`${filename}: tidak ada titik valid (cek kolom Lat/Lng — mungkin format angka tidak sesuai, misal pakai koma bukan titik).`);

  const droppedCount = rows.length - parsedRows.length;
  if (droppedCount > 0) {
    const pctDropped = (droppedCount / rows.length) * 100;
    if (pctDropped >= 5) warnings.push(`${droppedCount.toLocaleString()} baris (${pctDropped.toFixed(1)}%) dibuang karena Lat/Lng tidak valid`);
  }

  const siteVals = colSite ? rows.map(r => String(r[colSite] || '').trim()).filter(Boolean) : [];
  const scenVals = colScen ? rows.map(r => String(r[colScen] || '').trim().toUpperCase()).filter(Boolean) : [];
  const condVals = colCond ? rows.map(r => String(r[colCond] || '').trim().toUpperCase()).filter(Boolean) : [];

  const site      = mostFrequent(siteVals) || 'Unknown';
  const scenario  = mostFrequent(scenVals) || '—';
  const condition = mostFrequent(condVals) || '—';

  const entry = {
    id: state.nextId++, filename, site, scenario, condition, rows: parsedRows, warnings,
  };
  entry.metrics = {
    rsrp: calcStats(parsedRows.map(r => r.deltaRsrp).filter(v => v !== null)),
    sinr: calcStats(parsedRows.map(r => r.deltaSinr).filter(v => v !== null)),
  };
  return entry;
}

/* ── STATS ─────────────────────────────────────────────────────────── */
function calcStats(diffs) {
  const n = diffs.length;
  if (!n) return { n: 0, me: null, rmse: null, sd: null };
  const me   = diffs.reduce((s, v) => s + v, 0) / n;
  const rmse = Math.sqrt(diffs.reduce((s, v) => s + v * v, 0) / n);
  const sd   = Math.sqrt(Math.max(0, rmse * rmse - me * me));
  return { n, me, rmse, sd };
}

function fmtNum(v, d = 3) { return (v === null || v === undefined) ? '—' : v.toFixed(d); }
function fmtSigned(v, d = 3) {
  if (v === null || v === undefined) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(d);
}

/* ── GROUPING: Site > (Scenario, Condition) ──────────────────────────── */
function buildSiteGroups() {
  const bySite = {};
  state.files.forEach(f => {
    if (!bySite[f.site]) bySite[f.site] = [];
    bySite[f.site].push(f);
  });
  Object.values(bySite).forEach(list =>
    list.sort((a, b) => (a.scenario + a.condition).localeCompare(b.scenario + b.condition)));
  return bySite;
}

// Cari kombinasi (Scenario, Condition) dengan rata-rata RMSE terkecil,
// dirata-ratakan lintas SEMUA site yang punya kombinasi tsb (global best).
function findBestScenario(metric) {
  const combos = {}; // key: "SCEN|COND" -> [rmse,...]
  state.files.forEach(f => {
    const key = `${f.scenario}|${f.condition}`;
    const rmse = f.metrics[metric]?.rmse;
    if (rmse === null || rmse === undefined) return;
    if (!combos[key]) combos[key] = [];
    combos[key].push(rmse);
  });
  let best = null;
  Object.entries(combos).forEach(([key, arr]) => {
    const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
    if (!best || avg < best.avgRmse) {
      const [scenario, condition] = key.split('|');
      best = { scenario, condition, avgRmse: avg };
    }
  });
  return best;
}

/* ── ACTIONS ───────────────────────────────────────────────────────── */
function removeFile(id) {
  state.files = state.files.filter(f => String(f.id) !== String(id));
  renderAll();
}

function resetAll() {
  state.files = [];
  const input = $('csvInput'); if (input) input.value = '';
  renderAll();
}

function switchMetric(metric) {
  state.activeMetric = metric;
  $('metricTabRsrp')?.classList.toggle('active', metric === 'rsrp');
  $('metricTabSinr')?.classList.toggle('active', metric === 'sinr');
  renderAll();
}

/* ── RENDER: ALL ───────────────────────────────────────────────────── */
function renderAll() {
  renderFileChips();
  updateStatus();
  populateMapFileFilter();
  renderMaps();
  renderSummaryTables();
  renderDistanceAnalysis();
  applyReadyState();
}

// Isi dropdown filter peta dengan daftar file yang sudah diupload,
// supaya pengguna bisa lihat peta per skenario (bukan selalu gabungan semua).
function populateMapFileFilter() {
  const sel = $('mapFileFilter'); if (!sel) return;
  const prev = state.mapFilterFileId;
  sel.innerHTML = `<option value="all">Semua Skenario (gabungan)</option>` +
    state.files.map(f => `<option value="${f.id}">${f.site} · ${f.scenario}-${f.condition} (${f.rows.length.toLocaleString()} titik)</option>`).join('');
  sel.value = state.files.some(f => String(f.id) === String(prev)) ? prev : 'all';
  state.mapFilterFileId = sel.value;
}

function applyReadyState() {
  const has = state.files.length > 0;
  $('metricsSection')?.style && ($('metricsSection').style.display = has ? 'block' : 'none');
  $('extraPanelsContainer') && ($('extraPanelsContainer').style.display = has ? 'block' : 'none');
}

function updateStatus() {
  const el = $('csvStatus');
  if (!el) return;
  if (!state.files.length) { el.textContent = 'CSV: —'; el.classList.remove('uploaded'); return; }
  const totalPts = state.files.reduce((s, f) => s + f.rows.length, 0);
  const nSites = new Set(state.files.map(f => f.site)).size;
  el.textContent = `${state.files.length} file · ${nSites} site · ${totalPts.toLocaleString()} titik`;
  el.classList.add('uploaded');
}

/* ── RENDER: FILE CHIPS ────────────────────────────────────────────── */
function renderFileChips() {
  const wrap = $('fileChipRow'); if (!wrap) return;
  if (!state.files.length) {
    wrap.innerHTML = `<div class="file-chip-empty">Belum ada file diupload. Klik "Upload File Simulasi" — bisa pilih banyak file sekaligus (masing-masing file sudah berisi Sim &amp; Aktual).</div>`;
    return;
  }
  wrap.innerHTML = state.files.map(f => `
    <div class="file-chip">
      <div>
        <div class="fc-name" title="${f.filename}">${f.site} · ${f.scenario}-${f.condition}</div>
        <div class="fc-meta">${f.rows.length.toLocaleString()} titik</div>
      </div>
      <button class="fc-remove" data-file="${f.id}" title="Hapus file"><i class="fas fa-xmark"></i></button>
    </div>`).join('');
}

/* ── RENDER: MAPS (multisite, dari 1 file yang sudah punya Sim+Aktual) ── */
function renderMaps() {
  state.dtLayer.clearLayers();
  state.simLayer.clearLayers();
  if (!state.files.length) {
    $('dtMapPlaceholder')?.classList.remove('hidden');
    $('simMapPlaceholder')?.classList.remove('hidden');
    return;
  }
  $('dtMapPlaceholder')?.classList.add('hidden');
  $('simMapPlaceholder')?.classList.add('hidden');

  const metric = state.activeMetric, unit = metric === 'rsrp' ? 'dBm' : 'dB';
  const dtVals = [], simVals = [], dtPts = [], simPts = [];

  const filesToShow = state.mapFilterFileId === 'all'
    ? state.files
    : state.files.filter(f => String(f.id) === String(state.mapFilterFileId));

  filesToShow.forEach(f => {
    f.rows.forEach(r => {
      const akt = metric === 'rsrp' ? r.rsrpAkt : r.sinrAkt;
      const sim = metric === 'rsrp' ? r.rsrpSim : r.sinrSim;
      if (akt !== null && !isNaN(akt)) {
        dtVals.push(akt); dtPts.push([r.lat, r.lng]);
        L.circleMarker([r.lat, r.lng], { radius: 4, fillColor: getColor(akt, metric), color: 'rgba(0,0,0,0.25)', weight: 0.5, fillOpacity: 0.9 })
          .bindPopup(`<b>${f.site}</b> — ${f.scenario}/${f.condition}<br>Aktual ${metric.toUpperCase()}: <b>${akt.toFixed(1)} ${unit}</b>`)
          .addTo(state.dtLayer);
      }
      if (sim !== null && !isNaN(sim)) {
        simVals.push(sim); simPts.push([r.lat, r.lng]);
        L.circleMarker([r.lat, r.lng], { radius: 4, fillColor: getColor(sim, metric), color: 'rgba(0,0,0,0.25)', weight: 0.5, fillOpacity: 0.85 })
          .bindPopup(`<b>${f.site}</b> — ${f.scenario}/${f.condition}<br>Simulasi ${metric.toUpperCase()}: <b>${sim.toFixed(1)} ${unit}</b>`)
          .addTo(state.simLayer);
      }
    });
  });

  if (dtPts.length) state.dtMap.fitBounds(dtPts, { maxZoom: 16 });
  if (simPts.length) state.simMap.fitBounds(simPts, { maxZoom: 16 });

  renderLegend('dtLegend', 'dtLegendTitle', 'dtLegendBody', metric, dtVals);
  renderLegend('simLegend', 'simLegendTitle', 'simLegendBody', metric, simVals);
  $('dtPointCount') && ($('dtPointCount').textContent = `${dtVals.length.toLocaleString()} titik`);
  $('simCellCount') && ($('simCellCount').textContent = `${simVals.length.toLocaleString()} titik`);
}

function getBuckets(metric) {
  return metric === 'rsrp' ? [
    { label: 'Excellent', range: '-85 ~ 0',     color: '#0042a5', min: -85,       max: Infinity },
    { label: 'Good',      range: '-95 ~ -85',   color: '#00a955', min: -95,       max: -85 },
    { label: 'Moderate',  range: '-105 ~ -95',  color: '#70ff66', min: -105,      max: -95 },
    { label: 'Poor',      range: '-120 ~ -105', color: '#fffb00', min: -120,      max: -105 },
    { label: 'Very Bad',  range: '-140 ~ -120', color: '#ff3333', min: -Infinity, max: -120 },
  ] : [
    { label: 'Excellent', range: '20 ~ 40',  color: '#0042a5', min: 20,        max: Infinity },
    { label: 'Good',      range: '10 ~ 20',  color: '#00a955', min: 10,        max: 20 },
    { label: 'Moderate',  range: '0 ~ 10',   color: '#70ff66', min: 0,         max: 10 },
    { label: 'Poor',      range: '-5 ~ 0',   color: '#fffb00', min: -5,        max: 0 },
    { label: 'Very Bad',  range: '-40 ~ -5', color: '#ff3333', min: -Infinity, max: -5 },
  ];
}
function getColor(v, metric) {
  for (const b of getBuckets(metric)) if (v >= b.min && v < b.max) return b.color;
  return '#ccc';
}
function renderLegend(legendId, titleId, bodyId, metric, values) {
  const el = $(legendId); if (!el) return;
  const buckets = getBuckets(metric), total = values.length || 1;
  el.style.display = 'block';
  $(titleId).textContent = metric === 'rsrp' ? 'RSRP (dBm)' : 'SINR (dB)';
  const tbody = $(bodyId); tbody.innerHTML = '';
  buckets.forEach(b => {
    const count = values.filter(v => v >= b.min && v < b.max).length;
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td><span class="legend-color-swatch" style="background:${b.color}"></span></td>
        <td>${b.range}</td>
        <td><b>${((count / total) * 100).toFixed(1)}%</b></td>
      </tr>`);
  });
}

/* ── RENDER: SUMMARY TABLES per Site (ME/RMSE/SD murni) ─────────────── */
function renderSummaryTables() {
  const container = $('summaryTablesContainer'); if (!container) return;
  if (!state.files.length) {
    container.innerHTML = `<div class="waiting-notice"><i class="fas fa-table"></i>Upload file simulasi untuk melihat ringkasan ME / RMSE / SD per site.</div>`;
    $('bestScenarioBanner') && ($('bestScenarioBanner').style.display = 'none');
    return;
  }

  const metric = state.activeMetric, unit = metric === 'rsrp' ? 'dBm' : 'dB', label = metric.toUpperCase();
  const bySite = buildSiteGroups();
  state.bestScenario = findBestScenario(metric);

  let html = '';
  Object.entries(bySite).forEach(([site, files]) => {
    html += `
    <div class="site-summary-block">
      <div class="site-summary-title"><i class="fas fa-tower-broadcast"></i> Site ${site}</div>
      <table class="dist-table site-summary-table">
        <thead>
          <tr>
            <th style="text-align:left">No</th>
            <th style="text-align:left">Skenario</th>
            <th style="text-align:left">Kondisi</th>
            <th>N</th>
            <th>ME (${unit})</th>
            <th>RMSE (${unit})</th>
            <th>SD (${unit})</th>
          </tr>
        </thead>
        <tbody>
          ${files.map((f, i) => {
            const m = f.metrics[metric];
            const isBest = state.bestScenario && f.scenario === state.bestScenario.scenario && f.condition === state.bestScenario.condition;
            return `
            <tr class="${isBest ? 'row-best' : ''}">
              <td style="text-align:left">${i + 1}</td>
              <td style="text-align:left">${f.scenario}</td>
              <td style="text-align:left">${f.condition} ${isBest ? '<span class="best-badge" title="Skenario terbaik (RMSE rata-rata terkecil lintas site)"><i class=\"fas fa-star\"></i></span>' : ''}</td>
              <td>${m.n}</td>
              <td>${fmtSigned(m.me)}</td>
              <td><b>${fmtNum(m.rmse)}</b></td>
              <td>${fmtNum(m.sd)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  });

  container.innerHTML = html;

  const banner = $('bestScenarioBanner');
  if (banner && state.bestScenario) {
    banner.style.display = 'flex';
    banner.innerHTML = `
      <i class="fas fa-star"></i>
      <div>
        <b>Skenario terbaik (${label}):</b>
        ${state.bestScenario.scenario} ${state.bestScenario.condition}
        — rata-rata RMSE lintas site terkecil (${fmtNum(state.bestScenario.avgRmse)} ${unit}).
        Analisis rentang jarak di bawah dihitung khusus untuk skenario ini.
      </div>`;
  } else if (banner) {
    banner.style.display = 'none';
  }
}

/* ── RENDER: DRILL-DOWN PER RENTANG JARAK (khusus skenario terbaik) ──── */
function renderDistanceAnalysis() {
  const el = $('distanceAnalysisContent'); if (!el) return;
  if (!state.files.length || !state.bestScenario) {
    el.innerHTML = `<div class="waiting-notice"><i class="fas fa-route"></i>Upload data untuk melihat analisis akurasi per rentang jarak pada skenario terbaik.</div>`;
    return;
  }

  const metric = state.activeMetric, unit = metric === 'rsrp' ? 'dBm' : 'dB', label = metric.toUpperCase();
  const { scenario, condition } = state.bestScenario;

  // Ambil semua file yang termasuk skenario terbaik, breakdown per site (kolom)
  const bestFiles = state.files.filter(f => f.scenario === scenario && f.condition === condition);
  if (!bestFiles.length) {
    el.innerHTML = `<div class="waiting-notice">Tidak ada data untuk skenario terbaik.</div>`;
    return;
  }

  const deltaKey = metric === 'rsrp' ? 'deltaRsrp' : 'deltaSinr';

  let html = `
    <div class="dist-metric-title">
      <span class="mgh-badge">${label}</span>
      Akurasi per Rentang Jarak — Skenario Terbaik: ${scenario} ${condition}
    </div>
    <div class="dist-table-wrap">
      <table class="dist-table">
        <thead>
          <tr>
            <th rowspan="2" style="text-align:left">Rentang Jarak</th>
            ${bestFiles.map(f => `<th colspan="3">${f.site}</th>`).join('')}
          </tr>
          <tr>
            ${bestFiles.map(() => `<th>ME (${unit})</th><th>RMSE (${unit})</th><th>SD (${unit})</th>`).join('')}
          </tr>
        </thead>
        <tbody>`;

  DIST_RANGES.forEach(range => {
    html += `<tr><td style="text-align:left"><b>${range.label}</b><br><span style="font-size:9px;color:#999">${range.desc}</span></td>`;
    bestFiles.forEach(f => {
      const pts = f.rows.filter(r => r.dist !== null && r.dist >= range.min && r.dist < range.max && r[deltaKey] !== null);
      if (!pts.length) {
        html += `<td colspan="3" style="text-align:center;color:#bbb;font-style:italic">—</td>`;
        return;
      }
      const stats = calcStats(pts.map(r => r[deltaKey]));
      html += `
        <td>${fmtSigned(stats.me, 2)}</td>
        <td><b>${fmtNum(stats.rmse, 2)}</b></td>
        <td>${fmtNum(stats.sd, 2)}</td>`;
    });
    html += `</tr>`;
  });

  html += `</tbody></table></div>`;
  el.innerHTML = html;
}

/* ── LOADING ───────────────────────────────────────────────────────── */
function showLoading(msg) {
  hideLoading();
  const el = document.createElement('div');
  el.id = 'scOverlay'; el.className = 'loading-overlay';
  el.innerHTML = `<div class="loading-box"><div class="spinner"></div><p class="loading-txt">${msg || 'Memproses...'}</p></div>`;
  document.body.appendChild(el);
}
function hideLoading() { $('scOverlay')?.remove(); }

console.log('simulationcom.js v11 — notifikasi upload pakai alert() bawaan browser, informatif (berhasil/kurang lengkap/gagal)');