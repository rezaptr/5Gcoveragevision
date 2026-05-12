/* ================================================
   coverage_validation.js  v5
   Komparasi Coverage — DT Real (Gaussian RBF) vs Simulasi
   ================================================ */
'use strict';

const CV_SESSION_KEY = 'coverageExportData';

// ── UNIFIED BUCKETS (5 kategori) ──────────────
function getBuckets(metric) {
  return metric === 'rsrp' ? [
    { label: 'Excellent', range: '-85 ~ 0',     color: '#0042a5', min: -85,       max:  Infinity },
    { label: 'Good',      range: '-95 ~ -85',   color: '#00a955', min: -95,       max: -85       },
    { label: 'Moderate',  range: '-105 ~ -95',  color: '#70ff66', min: -105,      max: -95       },
    { label: 'Poor',      range: '-120 ~ -105', color: '#fffb00', min: -120,      max: -105      },
    { label: 'Very Bad',  range: '-140 ~ -120', color: '#ff3333', min: -Infinity, max: -120      },
  ] : [
    { label: 'Excellent', range: '20 ~ 40',  color: '#0042a5', min:  20,       max:  Infinity },
    { label: 'Good',      range: '10 ~ 20',  color: '#00a955', min:  10,       max:  20       },
    { label: 'Moderate',  range: '0 ~ 10',   color: '#70ff66', min:   0,       max:  10       },
    { label: 'Poor',      range: '-5 ~ 0',   color: '#fffb00', min:  -5,       max:   0       },
    { label: 'Very Bad',  range: '-40 ~ -5', color: '#ff3333', min: -Infinity, max:  -5       },
  ];
}

function getColor(value, metric) {
  for (const b of getBuckets(metric))
    if (value >= b.min && value < b.max) return b.color;
  return '#ccc';
}

// ── STATE ──────────────────────────────────────
const state = {
  dtData: [], simExport: null, activeMetric: 'rsrp',
  dtMap: null, simMap: null, dtLayer: null, simLayer: null,
  dtGridCache: null,
};
const $ = id => document.getElementById(id);

// ──────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMaps(); loadSimExport(); attachEvents();
});

function initMaps() {
  const tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const opt     = { attribution: '© OpenStreetMap', maxZoom: 19 };
  const center  = [-6.2088, 106.8456];
  state.dtMap  = L.map('dtMap').setView(center, 14);
  state.simMap = L.map('simMap').setView(center, 14);
  L.tileLayer(tileUrl, opt).addTo(state.dtMap);
  L.tileLayer(tileUrl, opt).addTo(state.simMap);
  state.dtLayer  = L.layerGroup().addTo(state.dtMap);
  state.simLayer = L.layerGroup().addTo(state.simMap);

  let isSyncing = false;
  function syncMaps(src, dst) {
    src.on('move', () => {
      if (isSyncing) return;
      isSyncing = true;
      dst.setView(src.getCenter(), src.getZoom(), { animate: false });
      isSyncing = false;
    });
  }
  syncMaps(state.dtMap, state.simMap);
  syncMaps(state.simMap, state.dtMap);
}

// ──────────────────────────────────────────────
// LOAD SIMULASI DARI SESSION STORAGE
// ──────────────────────────────────────────────
function loadSimExport() {
  const raw = sessionStorage.getItem(CV_SESSION_KEY);
  if (!raw) { $('simStatus').textContent = 'Sim: belum ada'; return; }
  try {
    const data = JSON.parse(raw);
    if (!data?.grids?.length) throw new Error('Grid kosong');
    state.simExport = data;
    onSimLoaded();
  } catch { $('simStatus').textContent = 'Sim: data tidak valid'; }
}

function onSimLoaded() {
  const d = state.simExport;
  $('simStatus').textContent = `Sim: ${d.grids.length} grid`;
  $('simStatus').classList.add('uploaded');
  $('simSiteLabel').textContent =
    `Site: ${d.siteId || '?'} · ${d.grids.length} grid · ${d.gridSize || '?'}m`;
  $('simSourceLabel').textContent =
    `Simulasi site ${d.siteId || '?'} (${d.grids.length} grid, radius ${d.radius || '?'}m)`;
  $('simMapPlaceholder')?.classList.add('hidden');
  renderSimMap('rsrp');
  checkReady();
}

// ──────────────────────────────────────────────
// EVENTS — process buttons, no metric toggle
// ──────────────────────────────────────────────
function attachEvents() {
  $('uploadDTBtn').addEventListener('click',     () => $('dtFileInput').click());
  $('dtFileInput').addEventListener('change',    handleCSVUpload);
  $('processRSRPBtn').addEventListener('click',  () => onProcess('rsrp'));
  $('processSINRBtn').addEventListener('click',  () => onProcess('sinr'));
}

function onProcess(metric) {
  state.activeMetric = metric;
  showLoading(`Menghitung komparasi ${metric.toUpperCase()}…`);
  setTimeout(() => {
    try   { runComparison(metric); }
    catch (e) { console.error(e); alert('Error: ' + e.message); }
    finally   { hideLoading(); }
  }, 60);
}

// ──────────────────────────────────────────────
// CSV UPLOAD
// ──────────────────────────────────────────────
function handleCSVUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  $('dtStatus').textContent = 'DT: membaca...';
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete(res) { parseDTRows(res.data); e.target.value = ''; },
    error(err)    { alert('Gagal baca CSV: ' + err.message); },
  });
}

function detectCols(headers) {
  const find = cands => {
    for (const h of headers) {
      const hl = h.toLowerCase().replace(/[\s()]/g, '');
      if (cands.some(c => hl === c || hl.startsWith(c))) return h;
    }
    return null;
  };
  return {
    lat:  find(['latitude','lat','lintang','y']),
    lng:  find(['longitude','lon','lng','long','bujur','x']),
    rsrp: find(['rsrpdbm','rsrp','ltersrp','nrrsrp','signal']),
    sinr: find(['sinrdb','sinr','ltsinr','nrsinr','snr']),
  };
}

function parseDTRows(rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const cols    = detectCols(headers);
  if (!cols.lat || !cols.lng) {
    alert(`Kolom Lat/Lng tidak ditemukan.\nHeader: ${headers.slice(0,8).join(', ')}`); return;
  }
  const pn = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const raw = rows.map(r => ({
    lat:  pn(r[cols.lat]), lng: pn(r[cols.lng]),
    rsrp: cols.rsrp ? pn(r[cols.rsrp]) : null,
    sinr: cols.sinr ? pn(r[cols.sinr]) : null,
  })).filter(p =>
    p.lat !== null && p.lng !== null && !isNaN(p.lat) && !isNaN(p.lng) &&
    p.lat !== 0 && p.lng !== 0 && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180
  );
  const cleaned = [];
  raw.forEach((pt, i) => {
    if (i === 0) { cleaned.push(pt); return; }
    if (haversine(cleaned.at(-1).lat, cleaned.at(-1).lng, pt.lat, pt.lng) <= 500)
      cleaned.push(pt);
  });
  state.dtData = cleaned.filter((pt, i) =>
    i === 0 || pt.lat !== cleaned[i-1].lat || pt.lng !== cleaned[i-1].lng
  );
  state.dtGridCache = null;
  if (state.dtData.length < 3) { alert(`Terlalu sedikit titik (${state.dtData.length})`); return; }

  $('dtStatus').textContent = `DT: ${state.dtData.length} titik`;
  $('dtStatus').classList.add('uploaded');
  $('dtPointCount').textContent = `${state.dtData.length} titik`;
  $('dtMapPlaceholder')?.classList.add('hidden');

  showLoading('Membangun coverage dari titik DT...');
  setTimeout(() => {
    try   { buildDTCoverage(); }
    catch (e) { console.error(e); }
    finally   { hideLoading(); }
  }, 60);

  updateInfoPanel();
  checkReady();
}

// ══════════════════════════════════════════════
// BUILD DT COVERAGE — Gaussian RBF + Smoothing
// ══════════════════════════════════════════════
function buildDTCoverage() {
  if (!state.dtData.length) return;
  const GRID_M  = 30, SIGMA_M = 120, MAX_GAP = 180, K_NEAR = 20, SMOOTH = 2;
  const lats    = state.dtData.map(p => p.lat);
  const lngs    = state.dtData.map(p => p.lng);
  const avgLat  = lats.reduce((s,v)=>s+v,0) / lats.length;
  const mpdLat  = 111320;
  const mpdLon  = mpdLat * Math.cos(avgLat * Math.PI / 180);
  const dLat    = GRID_M / mpdLat, dLon = GRID_M / mpdLon;
  const PAD     = MAX_GAP + GRID_M * 2;
  const minLat  = Math.min(...lats) - PAD/mpdLat, maxLat = Math.max(...lats) + PAD/mpdLat;
  const minLng  = Math.min(...lngs) - PAD/mpdLon, maxLng = Math.max(...lngs) + PAD/mpdLon;
  const nLat    = Math.ceil((maxLat-minLat)/dLat) + 1;
  const nLon    = Math.ceil((maxLng-minLng)/dLon) + 1;

  const rsrpGrid = new Float32Array(nLat*nLon).fill(NaN);
  const sinrGrid = new Float32Array(nLat*nLon).fill(NaN);
  const maskGrid = new Uint8Array(nLat*nLon).fill(0);

  const BUCKET_M = 200, bLat = BUCKET_M/mpdLat, bLon = BUCKET_M/mpdLon;
  const buckets  = new Map();
  state.dtData.forEach((pt, idx) => {
    const key = `${Math.floor((pt.lat-minLat)/bLat)},${Math.floor((pt.lng-minLng)/bLon)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(idx);
  });

  function getNearby(lat, lng) {
    const bi = Math.floor((lat-minLat)/bLat), bj = Math.floor((lng-minLng)/bLon);
    const res = [];
    for (let di=-2; di<=2; di++)
      for (let dj=-2; dj<=2; dj++) {
        const k = `${bi+di},${bj+dj}`;
        if (buckets.has(k)) buckets.get(k).forEach(i => res.push(i));
      }
    return res;
  }

  const gaussW = d => Math.exp(-(d*d)/(2*SIGMA_M*SIGMA_M));
  for (let i=0; i<nLat; i++) {
    const lat = minLat + i*dLat;
    for (let j=0; j<nLon; j++) {
      const lng = minLng + j*dLon, idx = i*nLon+j;
      const nearby = getNearby(lat, lng); if (!nearby.length) continue;
      const dists = nearby
        .map(pi => ({ pi, d: haversine(lat, lng, state.dtData[pi].lat, state.dtData[pi].lng) }))
        .sort((a,b)=>a.d-b.d).slice(0,K_NEAR);
      if (!dists.length || dists[0].d > MAX_GAP) continue;
      maskGrid[idx] = 1;
      let wR=0,wvR=0,wS=0,wvS=0;
      dists.forEach(({pi,d})=>{
        const pt=state.dtData[pi], w=gaussW(d);
        if (pt.rsrp!==null&&!isNaN(pt.rsrp)){wvR+=w*pt.rsrp;wR+=w;}
        if (pt.sinr!==null&&!isNaN(pt.sinr)){wvS+=w*pt.sinr;wS+=w;}
      });
      if (wR>0) rsrpGrid[idx]=wvR/wR;
      if (wS>0) sinrGrid[idx]=wvS/wS;
    }
  }

  function smoothGrid(grid) {
    for (let iter=0; iter<SMOOTH; iter++)
      for (let i=1;i<nLat-1;i++) for (let j=1;j<nLon-1;j++) {
        const idx=i*nLon+j;
        if (!maskGrid[idx]||isNaN(grid[idx])) continue;
        let sum=0,cnt=0;
        for (let di=-1;di<=1;di++) for (let dj=-1;dj<=1;dj++) {
          const ni=i+di,nj=j+dj,nIdx=ni*nLon+nj;
          if (ni>=0&&ni<nLat&&nj>=0&&nj<nLon&&maskGrid[nIdx]&&!isNaN(grid[nIdx]))
            {sum+=grid[nIdx];cnt++;}
        }
        if (cnt>0) grid[idx]=sum/cnt;
      }
  }
  smoothGrid(rsrpGrid); smoothGrid(sinrGrid);
  state.dtGridCache = { rsrpGrid, sinrGrid, maskGrid, nLat, nLon, minLat, minLng, dLat, dLon, maxLat, maxLng };
  renderDTMapFromCache('rsrp');
}

// ──────────────────────────────────────────────
// RENDER MAPS
// ──────────────────────────────────────────────
function renderDTMapFromCache(metric) {
  state.dtLayer.clearLayers();
  if (!state.dtGridCache) return;
  const { rsrpGrid, sinrGrid, maskGrid, nLat, nLon,
          minLat, minLng, dLat, dLon, maxLat, maxLng } = state.dtGridCache;
  const grid  = metric==='rsrp'?rsrpGrid:sinrGrid;
  const unit  = metric==='rsrp'?'dBm':'dB';
  const layer = L.layerGroup();
  const vals  = []; let rendered = 0;

  for (let i=0;i<nLat;i++) {
    const lat = minLat+i*dLat;
    for (let j=0;j<nLon;j++) {
      const lng=minLng+j*dLon, idx=i*nLon+j;
      if (!maskGrid[idx]||isNaN(grid[idx])) continue;
      const val=grid[idx]; vals.push(val); rendered++;
      L.rectangle([[lat,lng],[lat+dLat,lng+dLon]],
        {color:getColor(val,metric),fillColor:getColor(val,metric),fillOpacity:0.78,weight:0})
        .bindPopup(`<b>DT Coverage</b><br>${metric.toUpperCase()}: <b>${val.toFixed(1)} ${unit}</b>`)
        .addTo(layer);
    }
  }
  state.dtLayer.addLayer(layer);
  $('dtPointCount').textContent = `${state.dtData.length} titik → ${rendered} grid`;
  renderLegend('dtLegend','dtLegendTitle','dtLegendBody', metric, vals);
  state.dtMap.fitBounds([[minLat,minLng],[maxLat,maxLng]],{padding:[20,20]});
}

function renderSimMap(metric) {
  state.simLayer.clearLayers();
  if (!state.simExport?.grids?.length) return;
  const unit  = metric==='rsrp'?'dBm':'dB';
  const layer = L.layerGroup(); const vals = [];
  state.simExport.grids.forEach(g => {
    const val = metric==='rsrp'?(g.rsrpValue??g.value):(g.sinrValue??g.value);
    if (val==null||isNaN(val)) return;
    vals.push(val);
    L.polygon(g.bounds,{color:getColor(val,metric),fillColor:getColor(val,metric),fillOpacity:0.75,weight:0})
      .bindPopup(`<b>Simulasi — ${g.servingSiteId||'?'}</b><br>
        ${metric.toUpperCase()}: <b>${val.toFixed(1)} ${unit}</b><br>
        <small>Dist: ${Math.round(g.dist||0)}m</small>`)
      .addTo(layer);
  });
  state.simLayer.addLayer(layer);
  $('simCellCount').textContent = `${vals.length} grid`;
  renderLegend('simLegend','simLegendTitle','simLegendBody', metric, vals);
  const grids=state.simExport.grids;
  const lats=grids.map(g=>g.lat), lons=grids.map(g=>g.lon);
  state.simMap.fitBounds([[Math.min(...lats),Math.min(...lons)],[Math.max(...lats),Math.max(...lons)]],{padding:[20,20]});
}

// ──────────────────────────────────────────────
// RUN COMPARISON
// ──────────────────────────────────────────────
function runComparison(metric) {
  renderDTMapFromCache(metric);
  renderSimMap(metric);
  const dtVals  = collectDTVals(metric);
  const simVals = collectSimVals(metric);
  if (!dtVals.length||!simVals.length) { alert('Data tidak cukup untuk komparasi.'); return; }
  const buckets = getBuckets(metric);
  const dtDist  = calcDistribution(dtVals,  buckets);
  const simDist = calcDistribution(simVals, buckets);
  renderComparisonTable(dtDist, simDist, metric);
  const em = calcMetrics(dtDist, simDist);
  renderAnalysis(dtDist, simDist, em, metric);
}

function collectDTVals(metric) {
  if (!state.dtGridCache) return [];
  const { rsrpGrid, sinrGrid, maskGrid } = state.dtGridCache;
  const grid = metric==='rsrp'?rsrpGrid:sinrGrid;
  const vals = [];
  for (let i=0;i<maskGrid.length;i++) if (maskGrid[i]&&!isNaN(grid[i])) vals.push(grid[i]);
  return vals;
}
function collectSimVals(metric) {
  if (!state.simExport?.grids?.length) return [];
  return state.simExport.grids
    .map(g=>metric==='rsrp'?(g.rsrpValue??g.value):(g.sinrValue??g.value))
    .filter(v=>v!=null&&!isNaN(v));
}

// ──────────────────────────────────────────────
// DISTRIBUSI + METRICS
// ──────────────────────────────────────────────
function calcDistribution(values, buckets) {
  const total = values.length||1;
  return buckets.map(b => {
    const count = values.filter(v=>v>=b.min&&v<b.max).length;
    return {...b, pct:(count/total)*100, count};
  });
}
function calcMetrics(dtDist, simDist) {
  const n    = dtDist.length;
  const mae  = dtDist.reduce((s,d,i)=>s+Math.abs(d.pct-simDist[i].pct),0)/n;
  const rmse = Math.sqrt(dtDist.reduce((s,d,i)=>s+(d.pct-simDist[i].pct)**2,0)/n);
  const domDT  = dtDist.reduce((a,b)=>a.pct>b.pct?a:b);
  const domSim = simDist.reduce((a,b)=>a.pct>b.pct?a:b);
  const weights=[3,2,1,1,1]; let wN=0,wD=0;
  dtDist.forEach((d,i)=>{const w=weights[i]||1;wN+=w*Math.min(d.pct,simDist[i].pct);wD+=w*Math.max(d.pct,simDist[i].pct,0.001);});
  return {mae,rmse,domDT,domSim,similarity:wD>0?(wN/wD)*100:0};
}

// ──────────────────────────────────────────────
// RENDER TABEL — no MAE row, tabel saja
// ──────────────────────────────────────────────
function renderComparisonTable(dtDist, simDist, metric) {
  $('compTableTitle').innerHTML =
    `<i class="fas fa-balance-scale"></i> Perbandingan Distribusi ${metric.toUpperCase()}`;
  const tbody = $('compTableBody');
  tbody.innerHTML = '';
  dtDist.forEach((dt,i)=>{
    const sim=simDist[i], delta=sim.pct-dt.pct, abs=Math.abs(delta);
    let pill, dc;
    if (abs<=5)        { pill='<span class="pill-ok">✔ Sesuai</span>';      dc='zero'; }
    else if (abs<=10)  { pill='<span class="pill-warn">⚠ Toleransi</span>'; dc=delta>0?'pos':'neg'; }
    else               { pill='<span class="pill-bad">✗ Deviasi</span>';    dc=delta>0?'pos':'neg'; }
    tbody.insertAdjacentHTML('beforeend',`
      <tr>
        <td><div class="td-cat">
          <span class="cat-swatch" style="background:${dt.color}"></span>
          <div>
            <div class="td-cat-main">${dt.label}</div>
            <div class="td-cat-range">${dt.range} ${metric==='rsrp'?'dBm':'dB'}</div>
          </div>
        </div></td>
        <td class="td-num">${dt.pct.toFixed(1)}%</td>
        <td class="td-num">${sim.pct.toFixed(1)}%</td>
        <td class="td-delta ${dc}">${delta>0?'+':''}${delta.toFixed(1)} pp</td>
        <td class="td-status">${pill}</td>
      </tr>`);
  });
}

// ──────────────────────────────────────────────
// RENDER ANALYSIS — simple visual layout
// ──────────────────────────────────────────────
function renderAnalysis(dtDist, simDist, em, metric) {
  const {mae,rmse,domDT,domSim,similarity} = em;
  const unit = metric==='rsrp'?'dBm':'dB';

  // Verdict
  let vClass, vIcon, vLabel;
  if (mae<=5&&similarity>=75)       {vClass='good'; vIcon='✅'; vLabel='Akurat';}
  else if (mae<=10&&similarity>=55) {vClass='ok';   vIcon='⚠️'; vLabel='Cukup';}
  else                               {vClass='bad';  vIcon='🔴'; vLabel='Perlu Kalibrasi';}

  // Dominant match?
  const domMatch = domDT.label === domSim.label;

  // Max deviation bucket
  let maxDev=0, maxDevLabel='';
  dtDist.forEach((d,i)=>{const v=Math.abs(simDist[i].pct-d.pct);if(v>maxDev){maxDev=v;maxDevLabel=d.label;}});

  // Good coverage % (Excellent + Good)
  const goodDT  = dtDist[0].pct  + dtDist[1].pct;
  const goodSim = simDist[0].pct + simDist[1].pct;
  const goodDiff = goodSim - goodDT;

  // Recommendation text
  let recClass, recText;
  if (mae<=5&&similarity>=75) {
    recClass='good'; recText='✔ Model simulasi representatif — validasi diterima.';
  } else if (mae<=10&&similarity>=55) {
    recClass='warn'; recText='⚠ Model cukup representatif, namun beberapa parameter dapat disesuaikan.';
  } else {
    recClass='danger'; recText='✗ Perlu kalibrasi — periksa path loss model, tinggi antena, atau clutter factor.';
  }

  const sim = state.simExport;

  $('overallAnalysisContent').innerHTML = `
    <div class="analysis-grid">

      <!-- VERDICT CARD -->
      <div class="verdict-card ${vClass}">
        <div class="verdict-icon">${vIcon}</div>
        <div class="verdict-label">Kualitas Validasi</div>
        <div class="verdict-value">${vLabel}</div>
        <div class="verdict-stats">
          <div class="verdict-stat">
            <span class="verdict-stat-label">MAE</span>
            <span class="verdict-stat-value">${mae.toFixed(1)} pp</span>
          </div>
          <div class="verdict-stat">
            <span class="verdict-stat-label">RMSE</span>
            <span class="verdict-stat-value">${rmse.toFixed(1)} pp</span>
          </div>
          <div class="verdict-stat">
            <span class="verdict-stat-label">Similarity</span>
            <span class="verdict-stat-value">${similarity.toFixed(0)}%</span>
          </div>
          <div class="verdict-stat">
            <span class="verdict-stat-label">Metric</span>
            <span class="verdict-stat-value">${metric.toUpperCase()}</span>
          </div>
        </div>
      </div>

      <!-- DETAIL -->
      <div class="analysis-detail">

        <div class="finding-row">
          <div class="finding-item ${domMatch?'match':'warn'}">
            <div class="finding-label">Kategori Dominan DT</div>
            <div class="finding-value">${domDT.label}</div>
            <div class="finding-sub">${domDT.pct.toFixed(1)}% dari total titik</div>
          </div>
          <div class="finding-item ${domMatch?'match':'warn'}">
            <div class="finding-label">Kategori Dominan Simulasi</div>
            <div class="finding-value">${domSim.label}</div>
            <div class="finding-sub">${domSim.pct.toFixed(1)}% dari total grid ${domMatch?'— ✅ Konsisten':'— ⚠ Berbeda'}</div>
          </div>
          <div class="finding-item ${maxDev<=5?'match':maxDev<=10?'warn':'danger'}">
            <div class="finding-label">Deviasi Terbesar</div>
            <div class="finding-value">${maxDevLabel}</div>
            <div class="finding-sub">${maxDev.toFixed(1)} pp ${maxDev<=5?'— dalam toleransi':maxDev<=10?'— batas diterima':'— perlu perhatian'}</div>
          </div>
          <div class="finding-item ${Math.abs(goodDiff)<=8?'match':'warn'}">
            <div class="finding-label">Coverage Baik (Exc+Good)</div>
            <div class="finding-value">DT ${goodDT.toFixed(0)}% vs Sim ${goodSim.toFixed(0)}%</div>
            <div class="finding-sub">Selisih ${goodDiff>0?'+':''}${goodDiff.toFixed(1)} pp</div>
          </div>
        </div>

        <div class="recommendation ${recClass}">${recText}</div>

      </div>
    </div>`;
}

// ──────────────────────────────────────────────
// LEGEND
// ──────────────────────────────────────────────
function renderLegend(legendId, titleId, bodyId, metric, values) {
  const buckets = getBuckets(metric);
  const total   = values.filter(v=>!isNaN(v)).length||1;
  const el      = $(legendId);
  if (!el) return;
  el.style.display = 'block';
  $(titleId).textContent = metric==='rsrp'?'RSRP (dBm)':'SINR (dB)';
  const tbody = $(bodyId); tbody.innerHTML='';
  buckets.forEach(b=>{
    const count=values.filter(v=>!isNaN(v)&&v>=b.min&&v<b.max).length;
    tbody.insertAdjacentHTML('beforeend',`
      <tr>
        <td><span class="legend-color-swatch" style="background:${b.color}"></span></td>
        <td>${b.range}</td>
        <td><b>${((count/total)*100).toFixed(1)}%</b></td>
      </tr>`);
  });
}

// ──────────────────────────────────────────────
// INFO PANEL — with site + neighbours
// ──────────────────────────────────────────────
function updateInfoPanel() {
  const sim = state.simExport;
  const dtN = state.dtData.length;
  const wR  = state.dtData.filter(p=>p.rsrp!==null).length;
  const wS  = state.dtData.filter(p=>p.sinr!==null).length;
  const neighbours = (sim?.neighbours||[]);
  $('infoContent').innerHTML = `
    <table class="info-table">
      <tr><td colspan="2"><span class="info-section-label">Drive Test</span></td></tr>
      <tr><td>Titik</td><td>${dtN}</td></tr>
      <tr><td>Ber-RSRP</td><td>${wR}</td></tr>
      <tr><td>Ber-SINR</td><td>${wS}</td></tr>
      <tr><td>Metode</td><td>Gaussian RBF</td></tr>
      <tr><td colspan="2"><span class="info-section-label">Simulasi</span></td></tr>
      <tr><td>Main Site</td><td><span class="info-tag highlight">★ ${sim?.siteId||'—'}</span></td></tr>
      <tr><td>Grid</td><td>${sim?.grids?.length||0} sel</td></tr>
      <tr><td>Grid Size</td><td>${sim?.gridSize||'—'}m</td></tr>
      <tr><td>Radius</td><td>${sim?.radius||'—'}m</td></tr>
      <tr><td>Neighbour</td><td>${neighbours.length>0?neighbours.map(n=>`<span class="info-tag">${n}</span>`).join(''):'—'}</td></tr>
    </table>`;
}

// ──────────────────────────────────────────────
// UTILITIES
// ──────────────────────────────────────────────
function checkReady() {
  const ok = state.dtData.length>0 && state.simExport!==null;
  ['processRSRPBtn','processSINRBtn'].forEach(id=>{
    const b=$(id); if(b) b.disabled=!ok;
  });
}
function haversine(la1,lo1,la2,lo2){
  const R=6378137,dLa=(la2-la1)*Math.PI/180,dLo=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dLa/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function showLoading(msg) {
  hideLoading();
  const el=document.createElement('div'); el.id='cvOverlay'; el.className='loading-overlay';
  el.innerHTML=`<div class="loading-box"><div class="spinner"></div><p class="loading-txt">${msg||'Memproses...'}</p></div>`;
  document.body.appendChild(el);
}
function hideLoading() { document.getElementById('cvOverlay')?.remove(); }

console.log('coverage_validation.js v5 — process buttons, simplified analysis, unified buckets');