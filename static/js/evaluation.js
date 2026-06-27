'use strict';
/* ================================================
   evaluation.js v4.1
   Fix:
   - getTrend(): hapus icon property, render hanya text
   - buildMetricTable(): hapus ${trend.icon} dari template
   - Tombol "Reset & Import CSV Baru" ditambahkan
   - handleCsvUpload: e.target.value = '' untuk allow re-upload
   ================================================ */

let dtMap, simMap;
let dtLayer, simLayer, siteLayerDt, siteLayerSim;
let evalData   = [];
let siteIndex  = {};
let dbpPerSite = {};
let lineChartR = null;
let lineChartS = null;
let currentMode = 'rsrp';

const SESSION_KEY = 'siteIndexData';
const C    = 3e8;
const FREQ = 2300e6;
const H_UT = 1.5;
const H_E  = 1.0;

const DIST_RANGES = [
  { label: '< 200 m',     min: 0,   max: 200,     short: '<200'    },
  { label: '200 – 400 m', min: 200, max: 400,     short: '200-400' },
  { label: '400 – 600 m', min: 400, max: 600,     short: '400-600' },
  { label: '600 – 800 m', min: 600, max: 800,     short: '600-800' },
  { label: '> 800 m',     min: 800, max: Infinity, short: '>800'    },
];

// ── 5-range error scale ───────────────────────────────────────────────────────
function errorColor5(delta) {
  if (delta === null) return '#cccccc';
  if (delta >  10) return '#ff3333';
  if (delta >   3) return '#fffb00';
  if (delta >= -3) return '#70ff66';
  if (delta >= -10) return '#00c1e7';
  return '#0042a5';
}

function errorLabel5(unit) {
  return [
    { label: `Over besar  > 10 ${unit}`,  color: '#ff3333' },
    { label: `Over kecil  3–10 ${unit}`,  color: '#fffb00' },
    { label: `Akurat  ±3 ${unit}`,         color: '#70ff66' },
    { label: `Under kecil 3–10 ${unit}`,  color: '#00c1e7' },
    { label: `Under besar > 10 ${unit}`,  color: '#0042a5' },
  ];
}

const SITE_PALETTE = [
  '#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#42d4f4',
  '#f032e6','#bfef45','#469990','#9a6324','#800000','#aaffc3',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const calcDbp  = hBS => 4 * (hBS - H_E) * (H_UT - H_E) * FREQ / C;
const mean     = arr => arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : null;
const rmseCalc = arr => arr.length ? Math.sqrt(arr.reduce((s,v)=>s+v*v,0)/arr.length) : null;
const sdCalc   = (rmse, me) => (rmse !== null && me !== null) ? Math.sqrt(Math.max(0, rmse*rmse - me*me)) : null;
const fmt2     = v => (v !== null && v !== undefined) ? v.toFixed(2) : '—';
const fmtSign  = v => (v !== null && v !== undefined) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '—';
const byId     = id => document.getElementById(id);

function rsrpColor(v) {
  if (v === null) return '#ccc';
  if (v >= -85)  return '#0042a5';
  if (v >= -95)  return '#00a955';
  if (v >= -105) return '#70ff66';
  if (v >= -120) return '#fffb00';
  return '#ff3333';
}
function sinrColor(v) {
  if (v === null) return '#ccc';
  if (v >= 20) return '#0042a5';
  if (v >= 10) return '#00a955';
  if (v >=  0) return '#70ff66';
  if (v >= -5) return '#fffb00';
  return '#ff3333';
}

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMaps();
  loadSiteIndex();
  attachListeners();
});

function initMaps() {
  const tile = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const opt  = { attribution: '© OpenStreetMap', maxZoom: 19 };
  const ctr  = [-6.2088, 106.8456];

  dtMap  = L.map('dtEvalMap').setView(ctr, 13);
  simMap = L.map('simEvalMap').setView(ctr, 13);
  L.tileLayer(tile, opt).addTo(dtMap);
  L.tileLayer(tile, opt).addTo(simMap);

  dtLayer      = L.layerGroup().addTo(dtMap);
  simLayer     = L.layerGroup().addTo(simMap);
  siteLayerDt  = L.layerGroup().addTo(dtMap);
  siteLayerSim = L.layerGroup().addTo(simMap);

  let syncing = false;
  dtMap.on('move', () => {
    if (syncing) return; syncing = true;
    simMap.setView(dtMap.getCenter(), dtMap.getZoom(), { animate: false });
    syncing = false;
  });
  simMap.on('move', () => {
    if (syncing) return; syncing = true;
    dtMap.setView(simMap.getCenter(), simMap.getZoom(), { animate: false });
    syncing = false;
  });
}

function loadSiteIndex() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (saved) {
    try {
      const p = JSON.parse(saved);
      if (p && Object.keys(p).length) {
        siteIndex = p; computeAllDbp();
        setStatus('siteStatus', `✅ ${Object.keys(siteIndex).length} site`, 'ok'); return;
      }
    } catch {}
  }
  setStatus('siteStatus', '⏳ Memuat site...', 'info');
  fetch('/api/get-site').then(r=>r.json()).then(data => {
    if (!data.has_site || !data.siteIndex) { setStatus('siteStatus','⚠️ Data site belum ada','warn'); return; }
    siteIndex = data.siteIndex;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex));
    computeAllDbp();
    setStatus('siteStatus', `✅ ${Object.keys(siteIndex).length} site`, 'ok');
  }).catch(() => setStatus('siteStatus','⚠️ Gagal memuat site','warn'));
}

function computeAllDbp() {
  dbpPerSite = {};
  Object.entries(siteIndex).forEach(([id,s]) => {
    dbpPerSite[id] = calcDbp(parseFloat(s.height) || 30);
  });
}

function attachListeners() {
  byId('uploadBtn')?.addEventListener('click', () => byId('csvInput').click());
  byId('csvInput')?.addEventListener('change', handleCsvUpload);

  // Tombol Reset — kembali ke state awal tanpa reload halaman
  byId('resetEvalBtn')?.addEventListener('click', resetEvaluation);

  byId('analyzeRsrpBtn')?.addEventListener('click', () => {
    currentMode = 'rsrp';
    runAnalysis();
  });
  byId('analyzeSinrBtn')?.addEventListener('click', () => {
    currentMode = 'sinr';
    runAnalysis();
  });
}

// ── [NEW] RESET EVALUATION ────────────────────────────────────────────────────
// Bersihkan semua state dan UI tanpa reload halaman penuh.
// Identik dengan processCsv() reset block, tapi tidak perlu file baru.
function resetEvaluation() {
  evalData = [];

  dtLayer.clearLayers();
  simLayer.clearLayers();
  siteLayerDt.clearLayers();
  siteLayerSim.clearLayers();

  const dtPh  = byId('dtMapPlaceholder');
  const simPh = byId('simMapPlaceholder');
  if (dtPh)  dtPh.style.display  = 'flex';
  if (simPh) simPh.style.display = 'flex';

  const resSection = byId('resultsSection');
  if (resSection) resSection.style.display = 'none';

  const concEl = byId('conclusionContent');
  if (concEl) concEl.innerHTML = `
    <div class="waiting-notice">
      <i class="fas fa-satellite-dish"></i>
      Klik Analisis untuk melihat kesimpulan
    </div>`;

  const tblEl = byId('metricTableBody');
  if (tblEl) tblEl.innerHTML = `
    <tr><td colspan="9" class="td-empty">Klik Analisis untuk melihat hasil</td></tr>`;

  if (lineChartR) { lineChartR.destroy(); lineChartR = null; }
  if (lineChartS) { lineChartS.destroy(); lineChartS = null; }

  const dtLgnd  = byId('dtLegendBox');
  const simLgnd = byId('simLegendBox');
  if (dtLgnd)  dtLgnd.style.display  = 'none';
  if (simLgnd) simLgnd.style.display = 'none';

  const btnR = byId('analyzeRsrpBtn');
  const btnS = byId('analyzeSinrBtn');
  if (btnR) btnR.disabled = true;
  if (btnS) btnS.disabled = true;

  // Reset input file agar file yang sama bisa diupload ulang
  const csvInput = byId('csvInput');
  if (csvInput) csvInput.value = '';

  setStatus('csvStatus', 'CSV: —', '');

  // Tampilkan konfirmasi singkat di status
  setStatus('csvStatus', '✅ Reset. Silakan import CSV baru.', 'ok');
}

// ── MODE SWITCH ───────────────────────────────────────────────────────────────
function switchMode(mode) {
  currentMode = mode;
  byId('mapModeRsrp')?.classList.toggle('active', mode === 'rsrp');
  byId('mapModeSinr')?.classList.toggle('active', mode === 'sinr');
  if (!evalData.length) return;
  renderDtMap(mode);
  updateDtLegend(mode);
  renderSimErrorMap(mode);
  updateSimLegend(mode);
  if (byId('resultsSection').style.display !== 'none') {
    const mR = calcRangeMetrics('rsrp');
    const mS = calcRangeMetrics('sinr');
    buildConclusion(mR, mS, mode);
  }
}

// ── CSV UPLOAD ────────────────────────────────────────────────────────────────
function handleCsvUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  // [FIX] Reset value SEBELUM parse agar file yang sama bisa diupload ulang
  e.target.value = '';
  showLoading('Membaca CSV...');
  Papa.parse(file, {
    header: true, dynamicTyping: true, skipEmptyLines: true,
    complete: r => processCsv(r.data),
    error:    err => { alert('❌ Gagal baca CSV: ' + err.message); hideLoading(); }
  });
}

function processCsv(rows) {
  // ── RESET STATE ──────────────────────────────
  evalData = [];
  dtLayer.clearLayers();
  simLayer.clearLayers();
  siteLayerDt.clearLayers();
  siteLayerSim.clearLayers();

  const dtPh  = byId('dtMapPlaceholder');
  const simPh = byId('simMapPlaceholder');
  if (dtPh)  dtPh.style.display  = 'flex';
  if (simPh) simPh.style.display = 'flex';

  const resSection = byId('resultsSection');
  if (resSection) resSection.style.display = 'none';

  const concEl = byId('conclusionContent');
  if (concEl) concEl.innerHTML = `
    <div class="waiting-notice">
      <i class="fas fa-satellite-dish"></i>
      Klik Analisis untuk melihat kesimpulan
    </div>`;

  const tblEl = byId('metricTableBody');
  if (tblEl) tblEl.innerHTML = `
    <tr><td colspan="9" class="td-empty">Klik Analisis untuk melihat hasil</td></tr>`;

  if (lineChartR) { lineChartR.destroy(); lineChartR = null; }
  if (lineChartS) { lineChartS.destroy(); lineChartS = null; }

  const dtLgnd  = byId('dtLegendBox');
  const simLgnd = byId('simLegendBox');
  if (dtLgnd)  dtLgnd.style.display  = 'none';
  if (simLgnd) simLgnd.style.display = 'none';

  const btnR = byId('analyzeRsrpBtn');
  const btnS = byId('analyzeSinrBtn');
  if (btnR) btnR.disabled = true;
  if (btnS) btnS.disabled = true;

  setStatus('csvStatus', 'CSV: —', '');

  // ── PROSES ROWS ──────────────────────────────
  const siteColorMap = {};
  let colorIdx = 0;

  rows.forEach((row, idx) => {
    const lat     = parseFloat(row.Latitude  || row.lat || row.LAT);
    const lng     = parseFloat(row.Longitude || row.lng || row.LON || row.LONG);
    const site    = String(row.Serving_Site  || row.serving_site || '').trim();
    const dist    = parseFloat(row['Distance_to_Serving(m)'] || row.Distance_to_Serving || row.Distance || 0);
    const rsrpSim = parseFloat(row['RSRP_Sim(dBm)']    || row.RSRP_Sim    || row.rsrp_sim);
    const sinrSim = parseFloat(row['SINR_Sim(dB)']     || row.SINR_Sim    || row.sinr_sim);
    const rsrpAkt = parseFloat(row['RSRP_Aktual(dBm)'] || row.RSRP_Aktual || row.rsrp_actual);
    const sinrAkt = parseFloat(row['SINR_Aktual(dB)']  || row.SINR_Aktual || row.sinr_actual);

    const deltaRsrp = isFinite(parseFloat(row['Delta_RSRP(dB)'] || row.Delta_RSRP))
      ? parseFloat(row['Delta_RSRP(dB)'] || row.Delta_RSRP)
      : (isFinite(rsrpSim) && isFinite(rsrpAkt) ? rsrpSim - rsrpAkt : null);
    const deltaSinr = isFinite(parseFloat(row['Delta_SINR(dB)'] || row.Delta_SINR))
      ? parseFloat(row['Delta_SINR(dB)'] || row.Delta_SINR)
      : (isFinite(sinrSim) && isFinite(sinrAkt) ? sinrSim - sinrAkt : null);

    if (!isFinite(lat) || !isFinite(lng)) return;
    if (!siteColorMap[site])
      siteColorMap[site] = SITE_PALETTE[colorIdx++ % SITE_PALETTE.length];

    evalData.push({
      idx: idx + 1, lat, lng, site,
      siteColor : siteColorMap[site] || '#888',
      dist      : isFinite(dist) ? dist : 0,
      rsrpSim   : isFinite(rsrpSim) ? rsrpSim : null,
      sinrSim   : isFinite(sinrSim) ? sinrSim : null,
      rsrpAkt   : isFinite(rsrpAkt) ? rsrpAkt : null,
      sinrAkt   : isFinite(sinrAkt) ? sinrAkt : null,
      deltaRsrp, deltaSinr,
      dBP: site && dbpPerSite[site] ? dbpPerSite[site] : null,
    });
  });

  if (!evalData.length) {
    hideLoading();
    alert('❌ Tidak ada data valid. Pastikan file adalah hasil export SimDT.');
    return;
  }

  const nR = evalData.filter(p => p.deltaRsrp !== null).length;
  const nS = evalData.filter(p => p.deltaSinr !== null).length;
  setStatus('csvStatus', `✅ ${evalData.length} titik | ${nR} RSRP | ${nS} SINR`, 'ok');

  renderDtMap(currentMode);
  renderSimErrorMap(currentMode);
  renderSiteMarkers();
  updateDtLegend(currentMode);
  updateSimLegend(currentMode);

  if (dtPh)  dtPh.style.display  = 'none';
  if (simPh) simPh.style.display = 'none';

  hideLoading();
  if (btnR) btnR.disabled = false;
  if (btnS) btnS.disabled = false;
}

// ── MAP RENDER ────────────────────────────────────────────────────────────────
function renderDtMap(mode) {
  dtLayer.clearLayers();
  if (!evalData.length) return;
  evalData.forEach(p => {
    const val   = mode === 'sinr' ? p.sinrAkt : p.rsrpAkt;
    const color = mode === 'sinr' ? sinrColor(val) : rsrpColor(val);
    if (val === null) return;
    const unit  = mode === 'sinr' ? 'dB' : 'dBm';
    L.circleMarker([p.lat, p.lng], {
      radius: 4, fillColor: color,
      color: 'rgba(0,0,0,0.2)', weight: 0.5, fillOpacity: 0.92,
    }).addTo(dtLayer)
      .bindPopup(`<b>Drive Test #${p.idx}</b><br>
        ${mode.toUpperCase()}: <b>${val.toFixed(1)} ${unit}</b><br>
        Jarak: <b>${p.dist.toFixed(0)} m</b>`);
  });
  const bounds = evalData.map(p => [p.lat, p.lng]);
  if (bounds.length) dtMap.fitBounds(bounds);
}

function renderSimErrorMap(mode) {
  simLayer.clearLayers();
  if (!evalData.length) return;
  evalData.forEach(p => {
    const delta = mode === 'sinr' ? p.deltaSinr : p.deltaRsrp;
    const color = errorColor5(delta);
    const unit  = mode === 'sinr' ? 'dB' : 'dBm';
    L.circleMarker([p.lat, p.lng], {
      radius: 4, fillColor: color,
      color: 'rgba(0,0,0,0.2)', weight: 0.5, fillOpacity: 0.92,
    }).addTo(simLayer)
      .bindPopup(`<b>Simulasi #${p.idx}</b><br>
        Δ${mode.toUpperCase()}: <b>${fmtSign(delta)} ${unit}</b><br>
        Sim: <b>${(mode==='sinr'?p.sinrSim:p.rsrpSim)?.toFixed(1) ?? '—'} ${unit}</b><br>
        Aktual: <b>${(mode==='sinr'?p.sinrAkt:p.rsrpAkt)?.toFixed(1) ?? '—'} ${unit}</b><br>
        Jarak: <b>${p.dist.toFixed(0)} m</b>`);
  });
}

function renderSiteMarkers() {
  siteLayerDt.clearLayers();
  siteLayerSim.clearLayers();
  const sites = [...new Set(evalData.map(p => p.site).filter(Boolean))];
  sites.forEach(id => {
    const s = siteIndex[id]; if (!s) return;
    const mkr = () => L.circleMarker([s.lat, s.lng], {
      radius: 9, fillColor: '#ffd000', color: '#000', weight: 2, fillOpacity: 1,
    }).bindPopup(`<b>📡 ${id}</b><br>H: ${s.height}m<br>dBP: ${dbpPerSite[id]?.toFixed(0) ?? '?'}m`);
    mkr().addTo(siteLayerDt);
    mkr().addTo(siteLayerSim);
    const lbl = L.marker([s.lat, s.lng], {
      icon: L.divIcon({
        className:'',
        html:`<div style="background:rgba(255,208,0,0.9);color:#111;font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;white-space:nowrap;margin-top:-20px;margin-left:13px;border:1px solid rgba(0,0,0,0.2)">${id}</div>`,
        iconAnchor:[0,0]
      }), interactive:false
    });
    lbl.addTo(siteLayerDt);
    lbl.addTo(siteLayerSim);
  });
}

function updateDtLegend(mode) {
  const tbody = byId('dtLegendBody'); if (!tbody) return;
  byId('dtLegendTitle').textContent = mode === 'sinr' ? 'SS-SINR Aktual (dB)' : 'SS-RSRP Aktual (dBm)';
  const buckets = mode === 'sinr' ? [
    { label:'≥ 20 dB',      color:'#0042a5', fn: v => v >= 20  },
    { label:'10 – 20 dB',   color:'#00a955', fn: v => v >= 10 && v < 20 },
    { label:'0 – 10 dB',    color:'#70ff66', fn: v => v >= 0  && v < 10 },
    { label:'-5 – 0 dB',    color:'#fffb00', fn: v => v >= -5 && v < 0  },
    { label:'< -5 dB',      color:'#ff3333', fn: v => v < -5  },
  ] : [
    { label:'-85 ~ 0 dBm',     color:'#0042a5', fn: v => v >= -85  },
    { label:'-95 ~ -85 dBm',   color:'#00a955', fn: v => v >= -95  && v < -85  },
    { label:'-105 ~ -95 dBm',  color:'#70ff66', fn: v => v >= -105 && v < -95  },
    { label:'-120 ~ -105 dBm', color:'#fffb00', fn: v => v >= -120 && v < -105 },
    { label:'< -120 dBm',      color:'#ff3333', fn: v => v < -120  },
  ];
  const vals  = evalData.map(p => mode === 'sinr' ? p.sinrAkt : p.rsrpAkt).filter(v => v !== null);
  const total = vals.length || 1;
  tbody.innerHTML = buckets.map(b => {
    const cnt = vals.filter(b.fn).length;
    return `<tr>
      <td><span class="legend-swatch" style="background:${b.color}"></span></td>
      <td>${b.label}</td>
      <td><b>${((cnt/total)*100).toFixed(1)}%</b></td>
    </tr>`;
  }).join('');
  byId('dtLegendBox').style.display = 'block';
}

function updateSimLegend(mode) {
  const tbody = byId('simLegendBody'); if (!tbody) return;
  const unit = mode === 'sinr' ? 'dB' : 'dBm';
  byId('simLegendTitle').textContent = `Error ${mode.toUpperCase()} (Sim−DT)`;
  tbody.innerHTML = errorLabel5(unit).map(b =>
    `<tr>
      <td><span class="legend-swatch" style="background:${b.color}"></span></td>
      <td colspan="2">${b.label}</td>
    </tr>`).join('');
  byId('simLegendBox').style.display = 'block';
}

// ── ANALYSIS ──────────────────────────────────────────────────────────────────
function runAnalysis() {
  if (!evalData.length) return;
  renderDtMap(currentMode);
  updateDtLegend(currentMode);
  renderSimErrorMap(currentMode);
  updateSimLegend(currentMode);

  showLoading('Menganalisis...');
  setTimeout(() => {
    try {
      const mR = calcRangeMetrics('rsrp');
      const mS = calcRangeMetrics('sinr');
      buildLineCharts(mR, mS);
      buildMetricTable(mR, mS);
      buildConclusion(mR, mS, currentMode);
      byId('resultsSection').style.display = 'flex';
      byId('resultsSection')?.scrollIntoView({ behavior: 'smooth' });
      hideLoading();
    } catch (err) { console.error(err); alert('❌ ' + err.message); hideLoading(); }
  }, 300);
}

function calcRangeMetrics(key) {
  return DIST_RANGES.map(r => {
    const pts   = evalData.filter(p => p.dist >= r.min && p.dist < r.max);
    const diffs = pts.map(p => key==='rsrp' ? p.deltaRsrp : p.deltaSinr).filter(v => v !== null);
    const me   = mean(diffs);
    const rmse = rmseCalc(diffs);
    const sd   = sdCalc(rmse, me);
    return { label: r.label, short: r.short, n: diffs.length, me, rmse, sd };
  });
}

function calcGlobalMetrics(key) {
  const diffs = evalData.map(p => key==='rsrp' ? p.deltaRsrp : p.deltaSinr).filter(v => v !== null);
  const me = mean(diffs), rmse = rmseCalc(diffs), sd = sdCalc(rmse, me);
  return { me, rmse, sd, n: diffs.length };
}

// ── LINE CHARTS ───────────────────────────────────────────────────────────────
function buildLineCharts(mR, mS) {
  if (lineChartR) { lineChartR.destroy(); lineChartR = null; }
  if (lineChartS) { lineChartS.destroy(); lineChartS = null; }
  lineChartR = makeLineChart('lineChartRsrp', mR, 'dBm');
  lineChartS = makeLineChart('lineChartSinr', mS, 'dB');
}

function makeLineChart(ctxId, metrics, unit) {
  const ctx = byId(ctxId); if (!ctx) return null;
  return new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: metrics.map(m => m.label),
      datasets: [
        { label:`ME (${unit})`,   data: metrics.map(m => m.me   !== null ? +m.me.toFixed(2)   : null),
          borderColor:'#1F3C88', backgroundColor:'rgba(31,60,136,0.08)',
          borderWidth:2.5, pointRadius:5, pointBackgroundColor:'#1F3C88', tension:0.3, fill:false },
        { label:`RMSE (${unit})`, data: metrics.map(m => m.rmse !== null ? +m.rmse.toFixed(2) : null),
          borderColor:'#e34a33', backgroundColor:'rgba(227,74,51,0.06)',
          borderWidth:2.5, pointRadius:5, pointBackgroundColor:'#e34a33', borderDash:[6,3], tension:0.3, fill:false },
        { label:`SD (${unit})`,   data: metrics.map(m => m.sd   !== null ? +m.sd.toFixed(2)   : null),
          borderColor:'#28a745', backgroundColor:'rgba(40,167,69,0.06)',
          borderWidth:2, pointRadius:4, pointBackgroundColor:'#28a745', borderDash:[3,3], tension:0.3, fill:false },
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      plugins: {
        legend:{ display:true, position:'top', labels:{ boxWidth:14, font:{ size:11 }, padding:14 }},
        tooltip:{ callbacks:{ label: item => `${item.dataset.label}: ${item.parsed.y !== null ? (item.parsed.y>=0?'+':'')+item.parsed.y.toFixed(2) : '—'} ${unit}` }}
      },
      scales: {
        x:{ title:{ display:true, text:'Rentang Jarak dari Site', font:{ weight:'bold', size:11 }},
            grid:{ color:'rgba(0,0,0,0.05)' }, ticks:{ font:{ size:10 }}},
        y:{ title:{ display:true, text:`Nilai (${unit})`, font:{ weight:'bold', size:11 }},
            grid:{ color:'rgba(0,0,0,0.07)' },
            ticks:{ callback: v => (v>=0?'+':'')+v.toFixed(1), font:{ size:10 }}}
      }
    }
  });
}

// ── METRIC TABLE ──────────────────────────────────────────────────────────────
function buildMetricTable(mR, mS) {
  const tbody = byId('metricTableBody'); if (!tbody) return;
  tbody.innerHTML = '';
  const gR = calcGlobalMetrics('rsrp'), gS = calcGlobalMetrics('sinr');

  DIST_RANGES.forEach((r, i) => {
    const mr = mR[i], ms = mS[i];
    const trend = getTrend(mr.me);
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td class="td-range"><b>${r.label}</b></td>
        <td class="td-n">${mr.n || '—'}</td>
        <td class="${meClass(mr.me)}">${fmtSign(mr.me)}</td>
        <td>${fmt2(mr.rmse)}</td>
        <td>${fmt2(mr.sd)}</td>
        <td class="${meClass(ms.me)}">${fmtSign(ms.me)}</td>
        <td>${fmt2(ms.rmse)}</td>
        <td>${fmt2(ms.sd)}</td>
        <td><span class="trend-badge ${trend.cls}">${trend.text}</span></td>
      </tr>`);
  });
  tbody.insertAdjacentHTML('beforeend', `
    <tr class="total-row">
      <td><b>Keseluruhan</b></td>
      <td class="td-n"><b>${evalData.length}</b></td>
      <td class="${meClass(gR.me)}"><b>${fmtSign(gR.me)}</b></td>
      <td><b>${fmt2(gR.rmse)}</b></td>
      <td><b>${fmt2(gR.sd)}</b></td>
      <td class="${meClass(gS.me)}"><b>${fmtSign(gS.me)}</b></td>
      <td><b>${fmt2(gS.rmse)}</b></td>
      <td><b>${fmt2(gS.sd)}</b></td>
      <td>—</td>
    </tr>`);
}

// ── [FIX] getTrend — hapus property icon, hanya text + cls ───────────────────
function getTrend(me) {
  if (me === null) return { text: '—',              cls: ''            };
  if (me >  10)   return { text: 'Bias tinggi (+)', cls: 'trend-over'  };
  if (me >   3)   return { text: 'Bias sedang (+)', cls: 'trend-over'  };
  if (me >= -3)   return { text: 'Bias rendah',     cls: 'trend-ok'   };
  if (me >= -10)  return { text: 'Bias sedang (−)', cls: 'trend-under' };
  return                 { text: 'Bias tinggi (−)', cls: 'trend-under' };
}

function meClass(me) {
  if (me === null) return '';
  if (Math.abs(me) > 10) return 'val-bad';
  if (Math.abs(me) >  5) return 'val-warn';
  return 'val-ok';
}

// ── CONCLUSION ────────────────────────────────────────────────────────────────
function buildConclusion(mR, mS, mode) {
  const el = byId('conclusionContent'); if (!el) return;
  const metrics  = mode === 'sinr' ? mS : mR;
  const gMetric  = calcGlobalMetrics(mode);
  const unit     = mode === 'sinr' ? 'dB' : 'dBm';
  const label    = mode.toUpperCase();

  const zonaOver   = metrics.filter(m => m.me !== null && m.me >  3).map(m => m.label);
  const zonaUnder  = metrics.filter(m => m.me !== null && m.me < -3).map(m => m.label);
  const zonaAkurat = metrics.filter(m => m.me !== null && Math.abs(m.me) <= 3).map(m => m.label);

  const sitesInData = [...new Set(evalData.map(p=>p.site).filter(Boolean))];
  const dbpVals = sitesInData.map(id=>dbpPerSite[id]).filter(v=>v&&isFinite(v)).sort((a,b)=>a-b);

  const statusClass = Math.abs(gMetric.me||0) <= 5 ? 'verdict-ok' : Math.abs(gMetric.me||0) <= 10 ? 'verdict-warn' : 'verdict-bad';
  const statusIcon  = Math.abs(gMetric.me||0) <= 5 ? '✅' : '⚠️';

  el.innerHTML = `
    <div class="verdict-block ${statusClass}">
      <span class="verdict-icon">${statusIcon}</span>
      <div>
        <div class="verdict-title">Akurasi Model ${label}</div>
        <div class="verdict-sub">
          ME = <b>${fmtSign(gMetric.me)} ${unit}</b> &nbsp;|&nbsp;
          RMSE = <b>${fmt2(gMetric.rmse)} ${unit}</b> &nbsp;|&nbsp;
          SD = <b>${fmt2(gMetric.sd)} ${unit}</b>
        </div>
      </div>
    </div>

    <div class="conclusion-findings">
      <div class="finding-item">
        <div class="finding-num">1</div>
        <div class="finding-body">
          <div class="finding-title">Pola Error per Jarak — ${label}</div>
          <div class="finding-text">
            ${zonaOver.length  ? `Simulasi <b>over-predict</b> di zona <b>${zonaOver.join(', ')}</b> — model terlalu optimis di jarak tersebut.` : ''}
            ${zonaAkurat.length? ` Zona <b>${zonaAkurat.join(', ')}</b> menunjukkan akurasi terbaik.` : ''}
            ${zonaUnder.length ? ` Simulasi <b>under-predict</b> di zona <b>${zonaUnder.join(', ')}</b> — model terlalu konservatif di jarak tersebut.` : ''}
          </div>
        </div>
      </div>

      <div class="finding-item">
        <div class="finding-num">2</div>
        <div class="finding-body">
          <div class="finding-title">Pola Bias Sistematis per Jarak</div>
          <div class="finding-text">
            ${zonaOver.length
            ? `Model menunjukkan <b>over-predict</b> (bias positif) di zona <b>${zonaOver.join(', ')}</b> — 
                kondisi aktual lebih banyak halangan dibanding asumsi model stokastik.`
            : ''}
            ${zonaUnder.length
            ? ` Over-predict berkurang dan bergeser ke <b>under-predict</b> di zona <b>${zonaUnder.join(', ')}</b> — 
                model TR 38.901 tidak memperhitungkan kondisi lingkungan spesifik lokasi.`
            : ''}
            ${zonaAkurat.length
            ? ` Bias paling rendah terjadi di zona <b>${zonaAkurat.join(', ')}</b>.`
            : ''}
            Pola ini konsisten dengan karakteristik model propagasi stokastik tanpa kalibrasi lokasi spesifik.
          </div>
        </div>
      </div>

      <div class="finding-item">
        <div class="finding-num">3</div>
        <div class="finding-body">
          <div class="finding-title">Rekomendasi</div>
          <div class="finding-text">
            ${gMetric.me !== null && gMetric.me > 5
              ? `Model cenderung <b>over-predict</b> ${label} — pertimbangkan kalibrasi clutter loss atau penambahan NLOS correction factor.`
              : gMetric.me !== null && gMetric.me < -5
              ? `Model cenderung <b>under-predict</b> ${label} — pertimbangkan review tinggi antena efektif atau shadow fading margin.`
              : `Akurasi model ${label} dalam batas wajar untuk model empiris stokastik tanpa kalibrasi lokasi <b>[ITU-R M.2135]</b>.`}
          </div>
        </div>
      </div>
    </div>`;
}

// ── UTILITY ───────────────────────────────────────────────────────────────────
function showLoading(text='Memproses...') {
  hideLoading();
  const el = document.createElement('div');
  el.id='scOverlay'; el.className='loading-overlay';
  el.innerHTML=`<div class="loading-box"><div class="spinner"></div><p class="loading-txt">${text}</p></div>`;
  document.body.appendChild(el);
}
function hideLoading() { byId('scOverlay')?.remove(); }
function setStatus(id, msg, type) {
  const el = byId(id); if (!el) return;
  el.textContent = msg;
  el.className = `status-badge${type==='ok'?' uploaded':''}`;
}

console.log('evaluation.js v4.1 — getTrend icon fix | Reset button | re-upload CSV fix');