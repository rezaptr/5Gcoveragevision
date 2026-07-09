'use strict';
/* ================================================
   evaluation.js — v6 MULTISITE REBUILD
   - Multi-file upload, auto-detect clutter/site/scenario dari kolom CSV
   - Ringkasan RMSE per Clutter > Site > Scenario, before vs after kalibrasi
   - Grafik tren RMSE (per file & per clutter)
   - Peta multisite dengan filter clutter/file + mode Clutter/Error
   - Drill-down per jarak per file
   - Export PDF (print)
   ================================================ */

const $ = id => document.getElementById(id);

const CLUTTER_MAP = {
  DRB: { label: 'Dense Urban', cls: 'clu-dense', color: '#4338ca', short: 'DU' },
  URB: { label: 'Urban',       cls: 'clu-urban', color: '#0891b2', short: 'UR' },
  SRB: { label: 'Sub Urban',   cls: 'clu-sub',   color: '#b45309', short: 'SU' },
};
const CLUTTER_UNKNOWN = { label: 'Tidak Diketahui', cls: 'clu-unknown', color: '#64748b', short: 'UNK' };
const CLUTTER_ORDER = ['DRB', 'URB', 'SRB', 'UNK'];

const state = {
  files: [],              // [{id, filename, site, scenario, condition, clutter:{code,label,cls,color,short}, rows:[...], metrics:{...}}]
  currentMetric: 'rsrp',
  currentClutterFilter: null, // scope stat cards & summary table to ONE clutter at a time
  fileManagerOpen: false,
  map: null, mapLayer: null,
  mapFilterClutter: 'all', mapFilterFileId: 'all',
  mapColorMode: 'clutter', mapErrorPhase: 'after',
  chartPerFile: null, chartPerClutter: null,
  nextId: 1,
};

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  attachEvents();
  renderAll();
});

/* ── SETUP ─────────────────────────────────────────────────────────── */
function initMap() {
  const tile = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const opt  = { attribution: '© OpenStreetMap', maxZoom: 19 };
  state.map = L.map('multiMap').setView([-6.2088, 106.8456], 12);
  L.tileLayer(tile, opt).addTo(state.map);
  state.mapLayer = L.layerGroup().addTo(state.map);
}

function attachEvents() {
  $('uploadBtn')?.addEventListener('click', () => $('csvInput').click());
  $('csvInput')?.addEventListener('change', handleUpload);
  $('resetEvalBtn')?.addEventListener('click', resetAll);
  $('exportPdfBtn')?.addEventListener('click', () => window.print());

  $('fileManagerToggle')?.addEventListener('click', () => {
    state.fileManagerOpen = !state.fileManagerOpen;
    applyFileManagerState();
  });

  $('clutterFilterSelect')?.addEventListener('change', e => {
    state.currentClutterFilter = e.target.value;
    renderStatCards();
    renderSummaryTable();
  });

  $('metricTabRsrp')?.addEventListener('click', () => switchMetric('rsrp'));
  $('metricTabSinr')?.addEventListener('click', () => switchMetric('sinr'));

  $('mapModeClutter')?.addEventListener('click', () => switchMapMode('clutter'));
  $('mapModeError')?.addEventListener('click', () => switchMapMode('error'));
  $('mapPhaseBefore')?.addEventListener('click', () => switchMapPhase('before'));
  $('mapPhaseAfter')?.addEventListener('click', () => switchMapPhase('after'));

  $('mapClutterFilter')?.addEventListener('change', e => {
    state.mapFilterClutter = e.target.value;
    updateFileFilterOptions();
    renderMap();
  });
  $('mapFileFilter')?.addEventListener('change', e => {
    state.mapFilterFileId = e.target.value;
    renderMap();
  });

  $('fileChipRow')?.addEventListener('change', e => {
    if (!e.target.classList.contains('fc-fix')) return;
    const id = e.target.dataset.file;
    const f = state.files.find(x => String(x.id) === String(id));
    if (!f) return;
    const code = e.target.value;
    f.clutter = code === 'UNK' ? { code: 'UNK', ...CLUTTER_UNKNOWN } : { code, ...CLUTTER_MAP[code] };
    renderAll();
  });
  $('fileChipRow')?.addEventListener('click', e => {
    const btn = e.target.closest('.fc-remove');
    if (!btn) return;
    removeFile(btn.dataset.file);
  });
}

function applyFileManagerState() {
  $('fileChipRow')?.classList.toggle('collapsed', !state.fileManagerOpen);
  $('fileManagerToggle')?.classList.toggle('open', state.fileManagerOpen);
}

/* ── UPLOAD & PARSE ────────────────────────────────────────────────── */
function handleUpload(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  e.target.value = '';
  showLoading(`Memproses ${files.length} file CSV...`);

  Promise.allSettled(files.map(parseFileAsync)).then(results => {
    const errors = [];
    results.forEach(r => {
      if (r.status === 'fulfilled') state.files.push(r.value);
      else errors.push(r.reason?.message || 'Gagal memproses file');
    });
    hideLoading();
    if (errors.length) alert('⚠️ Beberapa file gagal diproses:\n' + errors.join('\n'));
    renderAll();
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

function detectClutter(siteStr) {
  const m = /^\s*(DRB|URB|SRB)/i.exec(siteStr || '');
  if (m) { const code = m[1].toUpperCase(); return { code, ...CLUTTER_MAP[code] }; }
  return { code: 'UNK', ...CLUTTER_UNKNOWN };
}

function buildFileEntry(rows, filename) {
  if (!rows.length) throw new Error(`${filename}: file kosong`);
  const headers = Object.keys(rows[0]);

  const colLat  = findCol(headers, ['latitude', 'lat']);
  const colLng  = findCol(headers, ['longitude', 'lng', 'long']);
  const colSite = findCol(headers, ['servingsite', 'site']);
  const colScen = findCol(headers, ['scenario']);
  const colCond = findCol(headers, ['condition']);
  const colDist = findCol(headers, ['distancetoservingm', 'distance']);
  const colSplit = findCol(headers, ['splitkalibrasi', 'split']);

  const colRsrpSim   = findCol(headers, ['rsrpsimdbm', 'rsrpsim']);
  const colSinrSim   = findCol(headers, ['sinrsimdb', 'sinrsim']);
  const colRsrpKalib = findCol(headers, ['rsrpkalibrasidbm', 'rsrpkalibrasi', 'rsrpkalib']);
  const colSinrKalib = findCol(headers, ['sinrkalibrasidb', 'sinrkalibrasi', 'sinrkalib']);
  const colRsrpAkt   = findCol(headers, ['rsrpaktualdbm', 'rsrpaktual']);
  const colSinrAkt   = findCol(headers, ['sinraktualdb', 'sinraktual']);

  const colDRsrpSim   = findCol(headers, ['deltarsrpsimdb', 'deltarsrpsim']);
  const colDRsrpKalib = findCol(headers, ['deltarsrpkalibdb', 'deltarsrpkalib']);
  const colDSinrSim   = findCol(headers, ['deltasinrsimdb', 'deltasinrsim']);
  const colDSinrKalib = findCol(headers, ['deltasinrkalibdb', 'deltasinrkalib']);

  if (!colLat || !colLng) throw new Error(`${filename}: kolom Latitude/Longitude tidak ditemukan`);

  const pn = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

  const parsedRows = rows.map(r => {
    const lat = pn(r[colLat]), lng = pn(r[colLng]);
    const rsrpSim = colRsrpSim ? pn(r[colRsrpSim]) : null;
    const sinrSim = colSinrSim ? pn(r[colSinrSim]) : null;
    const rsrpKalib = colRsrpKalib ? pn(r[colRsrpKalib]) : null;
    const sinrKalib = colSinrKalib ? pn(r[colSinrKalib]) : null;
    const rsrpAkt = colRsrpAkt ? pn(r[colRsrpAkt]) : null;
    const sinrAkt = colSinrAkt ? pn(r[colSinrAkt]) : null;

    const deltaRsrpSim   = colDRsrpSim   ? pn(r[colDRsrpSim])   : (rsrpSim   != null && rsrpAkt != null ? rsrpSim   - rsrpAkt : null);
    const deltaRsrpKalib = colDRsrpKalib ? pn(r[colDRsrpKalib]) : (rsrpKalib != null && rsrpAkt != null ? rsrpKalib - rsrpAkt : null);
    const deltaSinrSim   = colDSinrSim   ? pn(r[colDSinrSim])   : (sinrSim   != null && sinrAkt != null ? sinrSim   - sinrAkt : null);
    const deltaSinrKalib = colDSinrKalib ? pn(r[colDSinrKalib]) : (sinrKalib != null && sinrAkt != null ? sinrKalib - sinrAkt : null);

    return {
      lat, lng,
      dist: colDist ? pn(r[colDist]) : null,
      split: colSplit ? String(r[colSplit] || 'n_a').trim().toLowerCase() : 'n_a',
      deltaRsrpSim, deltaRsrpKalib, deltaSinrSim, deltaSinrKalib,
    };
  }).filter(r => r.lat !== null && r.lng !== null);

  if (!parsedRows.length) throw new Error(`${filename}: tidak ada titik valid (cek kolom Lat/Lng)`);

  const siteVals = colSite ? rows.map(r => String(r[colSite] || '').trim()).filter(Boolean) : [];
  const scenVals = colScen ? rows.map(r => String(r[colScen] || '').trim()).filter(Boolean) : [];
  const condVals = colCond ? rows.map(r => String(r[colCond] || '').trim()).filter(Boolean) : [];

  const site = mostFrequent(siteVals) || 'Unknown';
  const scenario = mostFrequent(scenVals) || '—';
  const condition = mostFrequent(condVals) || '—';
  const clutter = detectClutter(site);

  const entry = {
    id: state.nextId++, filename, site, scenario, condition, clutter, rows: parsedRows,
    hasKalib: !!(colRsrpKalib || colSinrKalib),
    hasSplit: !!colSplit,
  };
  const evalRows = parsedRows.filter(r => r.split === 'val');
  // [TIER] Model Murni = seluruh baris, pakai Delta_..._Sim (N Total).
  // Evaluasi Kalibrasi = HANYA baris Split_Kalibrasi='val' (N Eval), before
  // dari Delta_..._Sim dan after dari Delta_..._Kalib pada baris yang SAMA —
  // supaya before/after apple-to-apple (lihat diskusi halaman Simulasi DT).
  entry.metrics = {
    rsrp: {
      pure: statsForRows(parsedRows, 'rsrp', 'before'),
      evalBefore: statsForRows(evalRows, 'rsrp', 'before'),
      evalAfter: statsForRows(evalRows, 'rsrp', 'after'),
    },
    sinr: {
      pure: statsForRows(parsedRows, 'sinr', 'before'),
      evalBefore: statsForRows(evalRows, 'sinr', 'before'),
      evalAfter: statsForRows(evalRows, 'sinr', 'after'),
    },
  };
  return entry;
}

/* ── STATS ─────────────────────────────────────────────────────────── */
function calcStats(diffs) {
  const n = diffs.length;
  if (!n) return { n: 0, me: null, rmse: null, sd: null };
  const me = diffs.reduce((s, v) => s + v, 0) / n;
  const rmse = Math.sqrt(diffs.reduce((s, v) => s + v * v, 0) / n);
  const sd = Math.sqrt(Math.max(0, rmse * rmse - me * me));
  return { n, me, rmse, sd };
}

function deltaKeyFor(metric, phase) {
  if (metric === 'rsrp') return phase === 'before' ? 'deltaRsrpSim' : 'deltaRsrpKalib';
  return phase === 'before' ? 'deltaSinrSim' : 'deltaSinrKalib';
}

function statsForRows(rows, metric, phase) {
  const key = deltaKeyFor(metric, phase);
  return calcStats(rows.map(r => r[key]).filter(v => v !== null));
}

function rmsePct(before, after) {
  if (before == null || after == null || before === 0) return null;
  return ((before - after) / before) * 100;
}
function classify(pct) {
  if (pct == null) return 'imp-warn';
  if (pct >= 30) return 'imp-good';
  if (pct >= 10) return 'imp-warn';
  return 'imp-bad';
}
function fmtNum(v, d = 2) { return (v === null || v === undefined) ? '—' : v.toFixed(d); }
function evalRowsOf(f) { return f.rows.filter(r => r.split === 'val'); }
function pctBadge(pct) {
  if (pct == null) return '';
  const cls = classify(pct);
  const sign = pct >= 0 ? '-' : '+';
  return `<span class="pct-badge ${cls}">${sign}${Math.abs(pct).toFixed(0)}%</span>`;
}

/* ── GROUPING ──────────────────────────────────────────────────────── */
function buildGroups() {
  const groups = {};
  state.files.forEach(f => {
    const c = f.clutter.code;
    if (!groups[c]) groups[c] = { code: c, label: f.clutter.label, cls: f.clutter.cls, color: f.clutter.color, short: f.clutter.short, files: [] };
    groups[c].files.push(f);
  });
  CLUTTER_ORDER.forEach(c => {
    if (groups[c]) groups[c].files.sort((a, b) => (a.site + a.scenario + a.condition).localeCompare(b.site + b.scenario + b.condition));
  });
  return CLUTTER_ORDER.filter(c => groups[c]).map(c => groups[c]);
}

/* ── ACTIONS ───────────────────────────────────────────────────────── */
function removeFile(id) {
  state.files = state.files.filter(f => String(f.id) !== String(id));
  renderAll();
}

function resetAll() {
  state.files = [];
  state.currentClutterFilter = null;
  state.fileManagerOpen = false;
  state.mapFilterClutter = 'all'; state.mapFilterFileId = 'all';
  const input = $('csvInput'); if (input) input.value = '';
  renderAll();
}

function switchMetric(metric) {
  state.currentMetric = metric;
  $('metricTabRsrp')?.classList.toggle('active', metric === 'rsrp');
  $('metricTabSinr')?.classList.toggle('active', metric === 'sinr');
  renderStatCards(); renderSummaryTable(); renderCharts(); renderMap();
}

// Sinkronkan dropdown filter clutter (buat stat cards & tabel rekap) dengan
// clutter yang benar-benar ada di file yang terupload. Kalau clutter yang
// lagi dipilih sudah tidak ada (file dihapus), fallback ke clutter pertama.
function updateClutterFilterOptions() {
  const sel = $('clutterFilterSelect'); if (!sel) return;
  const groups = buildGroups();
  if (!groups.length) {
    sel.innerHTML = `<option value="">—</option>`;
    state.currentClutterFilter = null;
    return;
  }
  sel.innerHTML = groups.map(g => `<option value="${g.code}">${g.label} (${g.files.length} file)</option>`).join('');
  const stillValid = groups.some(g => g.code === state.currentClutterFilter);
  state.currentClutterFilter = stillValid ? state.currentClutterFilter : groups[0].code;
  sel.value = state.currentClutterFilter;
}

function switchMapMode(mode) {
  state.mapColorMode = mode;
  $('mapModeClutter')?.classList.toggle('active', mode === 'clutter');
  $('mapModeError')?.classList.toggle('active', mode === 'error');
  $('mapPhaseToggle')?.classList.toggle('hidden', mode !== 'error');
  renderMap();
}
function switchMapPhase(phase) {
  state.mapErrorPhase = phase;
  $('mapPhaseBefore')?.classList.toggle('active', phase === 'before');
  $('mapPhaseAfter')?.classList.toggle('active', phase === 'after');
  renderMap();
}

/* ── RENDER: ALL ───────────────────────────────────────────────────── */
function renderAll() {
  renderFileChips();
  updateClutterFilterOptions();
  renderStatCards();
  renderSummaryTable();
  renderCharts();
  populateMapFilters();
  renderMap();
  updateCsvStatus();
  applyFileManagerState();
}

function updateCsvStatus() {
  const el = $('csvStatus');
  const summaryEl = $('fileManagerSummary');
  if (!state.files.length) {
    if (el) { el.textContent = 'CSV: —'; el.classList.remove('uploaded'); }
    if (summaryEl) summaryEl.textContent = 'Belum ada file diupload';
    return;
  }
  const totalPts = state.files.reduce((s, f) => s + f.rows.length, 0);
  const nClutter = buildGroups().length;
  if (el) { el.textContent = `${state.files.length} file · ${totalPts.toLocaleString()} titik`; el.classList.add('uploaded'); }
  if (summaryEl) summaryEl.textContent = `${state.files.length} file dimuat · ${nClutter} clutter · ${totalPts.toLocaleString()} titik`;
}

/* ── RENDER: FILE CHIPS ────────────────────────────────────────────── */
function renderFileChips() {
  const wrap = $('fileChipRow'); if (!wrap) return;
  if (!state.files.length) { wrap.innerHTML = `<div class="file-chip-empty">Belum ada file diupload. Klik "Import CSV" untuk mulai — bisa pilih banyak file sekaligus.</div>`; return; }
  wrap.innerHTML = state.files.map(f => `
    <div class="file-chip ${f.clutter.cls}">
      ${f.clutter.code === 'UNK' ? `<span class="fc-warn" title="Clutter tidak terdeteksi otomatis — pilih manual"><i class="fas fa-triangle-exclamation"></i></span>` : ''}
      <div>
        <div class="fc-name" title="${f.filename}">${f.site} · ${f.scenario}-${f.condition}</div>
        <div class="fc-meta">${f.rows.length} titik</div>
      </div>
      <select class="fc-fix" data-file="${f.id}" title="Koreksi clutter manual">
        <option value="DRB" ${f.clutter.code === 'DRB' ? 'selected' : ''}>Dense Urban</option>
        <option value="URB" ${f.clutter.code === 'URB' ? 'selected' : ''}>Urban</option>
        <option value="SRB" ${f.clutter.code === 'SRB' ? 'selected' : ''}>Sub Urban</option>
        <option value="UNK" ${f.clutter.code === 'UNK' ? 'selected' : ''}>Tidak diketahui</option>
      </select>
      <button class="fc-remove" data-file="${f.id}" title="Hapus file"><i class="fas fa-xmark"></i></button>
    </div>`).join('');
}

/* ── RENDER: STAT CARDS (scoped to 1 clutter) ─────────────────────── */
function renderStatCards() {
  const wrap = $('statCardsWrap'); if (!wrap) return;
  const groups = buildGroups();
  const group = groups.find(g => g.code === state.currentClutterFilter);
  if (!state.files.length || !group) {
    wrap.innerHTML = `
      <div class="stat-card"><div class="stat-label">Total Titik Data</div><div class="stat-value">—</div><div class="stat-sub">Belum ada data</div></div>
      <div class="stat-card"><div class="stat-label">RMSE Model Murni</div><div class="stat-value">—</div><div class="stat-sub">N Total</div></div>
      <div class="stat-card"><div class="stat-label">RMSE Sebelum (Eval)</div><div class="stat-value">—</div><div class="stat-sub">N Eval</div></div>
      <div class="stat-card sc-after"><div class="stat-label">RMSE Sesudah (Eval)</div><div class="stat-value">—</div><div class="stat-sub">N Eval</div></div>
      <div class="stat-card sc-drop"><div class="stat-label">Penurunan RMSE</div><div class="stat-value">—</div><div class="stat-sub">—</div></div>`;
    return;
  }
  const metric = state.currentMetric, unit = metric === 'rsrp' ? 'dBm' : 'dB';
  const clutterRows = group.files.flatMap(f => f.rows);
  const clutterEvalRows = group.files.flatMap(evalRowsOf);
  const pure = statsForRows(clutterRows, metric, 'before');
  const before = statsForRows(clutterEvalRows, metric, 'before');
  const after = statsForRows(clutterEvalRows, metric, 'after');
  const pct = rmsePct(before.rmse, after.rmse);
  const cls = classify(pct);
  const clsWord = cls === 'imp-good' ? 'good' : cls === 'imp-warn' ? 'warn' : 'bad';
  const diff = (before.rmse != null && after.rmse != null) ? (before.rmse - after.rmse) : null;

  wrap.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total Titik Data — ${group.label}</div>
      <div class="stat-value">${clutterRows.length.toLocaleString()}</div>
      <div class="stat-sub">${group.files.length} file</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">RMSE Model Murni</div>
      <div class="stat-value">${fmtNum(pure.rmse)}<span class="unit">${unit}</span></div>
      <div class="stat-sub">${metric.toUpperCase()} · N Total=${pure.n}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">RMSE Sebelum (Eval)</div>
      <div class="stat-value">${fmtNum(before.rmse)}<span class="unit">${unit}</span></div>
      <div class="stat-sub">${metric.toUpperCase()} · N Eval=${before.n}</div>
    </div>
    <div class="stat-card sc-after">
      <div class="stat-label">RMSE Sesudah (Eval)</div>
      <div class="stat-value good">${fmtNum(after.rmse)}<span class="unit">${unit}</span></div>
      <div class="stat-sub">${metric.toUpperCase()} · N Eval=${after.n}</div>
    </div>
    <div class="stat-card sc-drop">
      <div class="stat-label">Penurunan RMSE (Eval)</div>
      <div class="stat-value ${clsWord}">${pct != null ? pct.toFixed(0) + '%' : '—'}</div>
      <div class="stat-sub">${diff != null ? fmtNum(diff) + ' ' + unit + ' lebih kecil' : '—'}</div>
    </div>`;
}

/* ── RENDER: SUMMARY TABLE (scoped to 1 clutter, kolom rapi terpisah) ──
   Tabel utama TETAP RMSE-only (headline, sesuai permintaan penguji:
   "halaman tren RMSE"). ME & SD ditaruh di baris detail yang bisa
   di-expand per site, jadi info pendukung — bukan mengubah fokus utama. */
function renderSummaryTable() {
  const tbody = $('summaryTableBody'); if (!tbody) return;
  const groups = buildGroups();
  const group = groups.find(g => g.code === state.currentClutterFilter);
  const labelEl = $('tableClutterLabel');
  if (labelEl) labelEl.textContent = group ? group.label : 'Site & Skenario';
  if (!group) { tbody.innerHTML = `<tr><td colspan="7" class="td-empty">Upload CSV untuk melihat ringkasan RMSE</td></tr>`; return; }

  const metric = state.currentMetric, unit = metric === 'rsrp' ? 'dBm' : 'dB';
  const rowsHtml = [];

  group.files.forEach((f, idx) => {
    const m = f.metrics[metric];
    const hasEval = m.evalBefore.n > 0 && m.evalAfter.n > 0;
    const pct = hasEval ? rmsePct(m.evalBefore.rmse, m.evalAfter.rmse) : null;
    const rowId = `detail-${group.code}-${idx}`;
    rowsHtml.push(`
      <tr class="row-expandable" data-target="${rowId}">
        <td class="td-left">
          <button class="row-toggle-btn" aria-expanded="false" title="Lihat detail ME &amp; SD">
            <i class="fas fa-chevron-right"></i>
          </button>
          <span class="site-name-wrap">
            <span class="site-name">${f.site}</span>
            <span class="scenario-name">${f.scenario}-${f.condition}</span>
          </span>
        </td>
        <td class="td-num">${m.pure.n}</td>
        <td class="td-num">${fmtNum(m.pure.rmse)}</td>
        <td class="td-num">${hasEval ? m.evalAfter.n : '—'}</td>
        <td class="td-num">${hasEval ? fmtNum(m.evalBefore.rmse) : '—'}</td>
        <td class="td-num td-rmse-after">${hasEval ? fmtNum(m.evalAfter.rmse) : '—'}</td>
        <td class="td-num">${hasEval ? pctBadge(pct) : '<span style="color:#bbb;font-style:italic;font-size:10px;">—</span>'}</td>
      </tr>
      <tr class="row-detail" id="${rowId}" hidden>
        <td colspan="7">
          <div class="detail-panel">
            <div class="detail-panel-title"><i class="fas fa-circle-info"></i> Komponen Error — ${f.site} ${f.scenario}-${f.condition} (${metric.toUpperCase()}, ${unit})</div>
            <table class="detail-table">
              <thead>
                <tr><th class="td-left"></th><th>ME</th><th>RMSE</th><th>SD</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td class="td-left">Model Murni (N Total=${m.pure.n})</td>
                  <td>${fmtSignedNum(m.pure.me)}</td>
                  <td>${fmtNum(m.pure.rmse)}</td>
                  <td>${fmtNum(m.pure.sd)}</td>
                </tr>
                ${hasEval ? `
                <tr>
                  <td class="td-left">Sebelum Kalibrasi (N Eval=${m.evalBefore.n})</td>
                  <td>${fmtSignedNum(m.evalBefore.me)}</td>
                  <td>${fmtNum(m.evalBefore.rmse)}</td>
                  <td>${fmtNum(m.evalBefore.sd)}</td>
                </tr>
                <tr class="detail-row-after">
                  <td class="td-left">Sesudah Kalibrasi (N Eval=${m.evalAfter.n})</td>
                  <td>${fmtSignedNum(m.evalAfter.me)}</td>
                  <td>${fmtNum(m.evalAfter.rmse)}</td>
                  <td>${fmtNum(m.evalAfter.sd)}</td>
                </tr>` : `
                <tr><td class="td-left" colspan="4" style="color:#bbb;font-style:italic;">Tidak ada baris validasi (Split_Kalibrasi='val') untuk file ini.</td></tr>`}
              </tbody>
            </table>
            ${hasEval ? `<div class="detail-note">${detailNote(m.evalBefore, m.evalAfter)}</div>` : ''}
          </div>
        </td>
      </tr>`);
  });

  const clutterRows = group.files.flatMap(f => f.rows);
  const clutterEvalRows = group.files.flatMap(evalRowsOf);
  const tPure = statsForRows(clutterRows, metric, 'before');
  const tBefore = statsForRows(clutterEvalRows, metric, 'before');
  const tAfter = statsForRows(clutterEvalRows, metric, 'after');
  const tPct = rmsePct(tBefore.rmse, tAfter.rmse);
  rowsHtml.push(`
    <tr class="grandtotal-row">
      <td class="td-left">TOTAL — ${group.label}</td>
      <td class="td-num">${tPure.n}</td>
      <td class="td-num">${fmtNum(tPure.rmse)}</td>
      <td class="td-num">${tAfter.n || tBefore.n || 0}</td>
      <td class="td-num">${fmtNum(tBefore.rmse)}</td>
      <td class="td-num td-rmse-after">${fmtNum(tAfter.rmse)}</td>
      <td class="td-num">${pctBadge(tPct)}</td>
    </tr>`);

  tbody.innerHTML = rowsHtml.join('');

  // Bind toggle expand/collapse (di-attach ulang tiap render karena innerHTML diganti)
  tbody.querySelectorAll('.row-expandable').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.target;
      const detail = document.getElementById(id);
      const btn = row.querySelector('.row-toggle-btn');
      const isOpen = !detail.hidden;
      detail.hidden = isOpen;
      btn.setAttribute('aria-expanded', String(!isOpen));
      btn.classList.toggle('open', !isOpen);
      row.classList.toggle('is-open', !isOpen);
    });
  });
}

function fmtSignedNum(v, d = 2) {
  if (v === null || v === undefined) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(d);
}

// Catatan singkat: apakah penurunan RMSE didominasi koreksi bias (ME→0)
// atau reduksi sebaran acak (SD turun)? Membantu narasi analisis di skripsi.
function detailNote(before, after) {
  if (before.me === null || after.me === null) return '';
  const meDrop = Math.abs(before.me) - Math.abs(after.me);
  const sdDrop = (before.sd ?? 0) - (after.sd ?? 0);
  const meDominant = meDrop >= sdDrop;
  return meDominant
    ? `Penurunan RMSE didominasi oleh koreksi bias sistematis (|ME| turun dari ${Math.abs(before.me).toFixed(2)} ke ${Math.abs(after.me).toFixed(2)}), dibanding penurunan sebaran acak (SD turun ${sdDrop.toFixed(2)}).`
    : `Penurunan RMSE didominasi oleh reduksi sebaran acak (SD turun dari ${before.sd.toFixed(2)} ke ${after.sd.toFixed(2)}), dibanding koreksi bias sistematis (|ME| turun ${meDrop.toFixed(2)}).`;
}

/* ── RENDER: CHARTS ────────────────────────────────────────────────── */
function renderCharts() {
  if (state.chartPerFile) { state.chartPerFile.destroy(); state.chartPerFile = null; }
  if (state.chartPerClutter) { state.chartPerClutter.destroy(); state.chartPerClutter = null; }
  const ctx1 = $('chartPerFile'), ctx2 = $('chartPerClutter');
  if (!ctx1 || !ctx2 || !state.files.length) return;

  const metric = state.currentMetric, unit = metric === 'rsrp' ? 'dBm' : 'dB';

  const labels1 = state.files.map(f => `[${f.clutter.short}] ${f.site} ${f.scenario}-${f.condition}`);
  const pure1 = state.files.map(f => f.metrics[metric].pure.rmse);
  const before1 = state.files.map(f => f.metrics[metric].evalBefore.rmse);
  const after1 = state.files.map(f => f.metrics[metric].evalAfter.rmse);

  state.chartPerFile = new Chart(ctx1.getContext('2d'), {
    type: 'bar',
    data: { labels: labels1, datasets: [
      { label: `Murni (N Total)`, data: pure1, backgroundColor: '#0891b2', borderRadius: 4 },
      { label: `Sebelum (N Eval)`, data: before1, backgroundColor: '#94a3b8', borderRadius: 4 },
      { label: `Sesudah (N Eval)`, data: after1, backgroundColor: '#28a745', borderRadius: 4 },
    ] },
    options: chartOpts(unit, true),
  });

  const groups = buildGroups();
  const labels2 = groups.map(g => g.label);
  const pure2 = groups.map(g => statsForRows(g.files.flatMap(f => f.rows), metric, 'before').rmse);
  const before2 = groups.map(g => statsForRows(g.files.flatMap(evalRowsOf), metric, 'before').rmse);
  const after2 = groups.map(g => statsForRows(g.files.flatMap(evalRowsOf), metric, 'after').rmse);

  state.chartPerClutter = new Chart(ctx2.getContext('2d'), {
    type: 'bar',
    data: { labels: labels2, datasets: [
      { label: `Murni (N Total)`, data: pure2, backgroundColor: '#0891b2', borderRadius: 6 },
      { label: `Sebelum (N Eval)`, data: before2, backgroundColor: '#94a3b8', borderRadius: 6 },
      { label: `Sesudah (N Eval)`, data: after2, backgroundColor: '#28a745', borderRadius: 6 },
    ] },
    options: chartOpts(unit, false),
  });
}

function chartOpts(unit, rotateLabels) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 10 } } } },
    scales: {
      x: { ticks: { font: { size: 9 }, maxRotation: rotateLabels ? 60 : 0, minRotation: rotateLabels ? 30 : 0 } },
      y: { title: { display: true, text: `RMSE (${unit})`, font: { size: 10, weight: 'bold' } }, beginAtZero: true },
    },
  };
}

/* ── RENDER: MAP ───────────────────────────────────────────────────── */
function populateMapFilters() {
  const cSel = $('mapClutterFilter'); if (!cSel) return;
  const groups = buildGroups();
  const prevClutter = state.mapFilterClutter;
  cSel.innerHTML = `<option value="all">Semua Clutter</option>` + groups.map(g => `<option value="${g.code}">${g.label}</option>`).join('');
  cSel.value = groups.some(g => g.code === prevClutter) ? prevClutter : 'all';
  state.mapFilterClutter = cSel.value;
  updateFileFilterOptions();
}

function updateFileFilterOptions() {
  const fSel = $('mapFileFilter'); if (!fSel) return;
  const filesForClutter = state.mapFilterClutter === 'all' ? state.files : state.files.filter(f => f.clutter.code === state.mapFilterClutter);
  const prevFile = state.mapFilterFileId;
  fSel.innerHTML = `<option value="all">Semua File</option>` + filesForClutter.map(f => `<option value="${f.id}">${f.site} ${f.scenario}-${f.condition}</option>`).join('');
  fSel.value = filesForClutter.some(f => String(f.id) === String(prevFile)) ? prevFile : 'all';
  state.mapFilterFileId = fSel.value;
}

function errorColor5(delta) {
  if (delta === null || delta === undefined) return '#cccccc';
  if (delta > 10) return '#ff3333';
  if (delta > 3) return '#fffb00';
  if (delta >= -3) return '#70ff66';
  if (delta >= -10) return '#00c1e7';
  return '#0042a5';
}
function errorLabel5(unit) {
  return [
    { label: `Over besar &gt; 10 ${unit}`, color: '#ff3333' },
    { label: `Over kecil 3–10 ${unit}`, color: '#fffb00' },
    { label: `Akurat ±3 ${unit}`, color: '#70ff66' },
    { label: `Under kecil 3–10 ${unit}`, color: '#00c1e7' },
    { label: `Under besar &gt; 10 ${unit}`, color: '#0042a5' },
  ];
}

function renderMap() {
  state.mapLayer.clearLayers();
  const metric = state.currentMetric;
  let files = state.files;
  if (state.mapFilterClutter !== 'all') files = files.filter(f => f.clutter.code === state.mapFilterClutter);
  if (state.mapFilterFileId !== 'all') files = files.filter(f => String(f.id) === String(state.mapFilterFileId));

  const pts = [];
  files.forEach(f => {
    const key = deltaKeyFor(metric, state.mapErrorPhase);
    f.rows.forEach(r => {
      if (r.lat === null || r.lng === null) return;
      const color = state.mapColorMode === 'clutter' ? f.clutter.color : errorColor5(r[key]);
      pts.push([r.lat, r.lng]);
      L.circleMarker([r.lat, r.lng], { radius: 4, fillColor: color, color: 'rgba(0,0,0,0.25)', weight: 0.5, fillOpacity: 0.88 })
        .bindPopup(`<b>${f.site}</b> — ${f.scenario}/${f.condition}<br>Clutter: ${f.clutter.label}<br>Jarak: ${r.dist !== null ? r.dist.toFixed(0) + ' m' : '—'}`)
        .addTo(state.mapLayer);
    });
  });

  $('multiMapPlaceholder')?.classList.toggle('hidden', pts.length > 0);
  if (pts.length) state.map.fitBounds(pts, { maxZoom: 16 });
  updateMapLegend();
}

function updateMapLegend() {
  const el = $('mapLegendBody'); if (!el) return;
  if (state.mapColorMode === 'clutter') {
    $('mapLegendTitle').textContent = 'Clutter';
    const groups = buildGroups();
    el.innerHTML = groups.length
      ? groups.map(g => `<div class="ml-item"><span class="ml-swatch" style="background:${g.color}"></span>${g.label}</div>`).join('')
      : `<div class="ml-item" style="color:#aaa;">Belum ada data</div>`;
  } else {
    const unit = state.currentMetric === 'rsrp' ? 'dBm' : 'dB';
    $('mapLegendTitle').textContent = `Error ${state.currentMetric.toUpperCase()} (${state.mapErrorPhase === 'before' ? 'Sebelum' : 'Sesudah'} Kalibrasi)`;
    el.innerHTML = errorLabel5(unit).map(b => `<div class="ml-item"><span class="ml-swatch" style="background:${b.color}"></span>${b.label}</div>`).join('');
  }
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

console.log('evaluation.js v7 — expand-row ME & SD per site, RMSE tetap headline utama');