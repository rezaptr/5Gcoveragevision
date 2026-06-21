'use strict';
/* ================================================
   simulationcom.js  v7
   Komparasi Drive Test vs File Simulasi
   v7: 3 metrik utama (ME, RMSE, SD) — MAE per titik
       diganti SD (dianggap kurang kuat untuk validasi);
       tanpa warna semantik, layout fokus, panel
       tambahan collapsible
   ================================================ */

function getBuckets(metric) {
  return metric === 'rsrp' ? [
    { label:'Excellent', range:'-85 ~ 0',     color:'#0042a5', min:-85,       max:Infinity  },
    { label:'Good',      range:'-95 ~ -85',   color:'#00a955', min:-95,       max:-85       },
    { label:'Moderate',  range:'-105 ~ -95',  color:'#70ff66', min:-105,      max:-95       },
    { label:'Poor',      range:'-120 ~ -105', color:'#fffb00', min:-120,      max:-105      },
    { label:'Very Bad',  range:'-140 ~ -120', color:'#ff3333', min:-Infinity, max:-120      },
  ] : [
    { label:'Excellent', range:'20 ~ 40',  color:'#0042a5', min:20,        max:Infinity },
    { label:'Good',      range:'10 ~ 20',  color:'#00a955', min:10,        max:20       },
    { label:'Moderate',  range:'0 ~ 10',   color:'#70ff66', min:0,         max:10       },
    { label:'Poor',      range:'-5 ~ 0',   color:'#fffb00', min:-5,        max:0        },
    { label:'Very Bad',  range:'-40 ~ -5', color:'#ff3333', min:-Infinity, max:-5       },
  ];
}

function getColor(v, metric) {
  for (const b of getBuckets(metric)) if (v >= b.min && v < b.max) return b.color;
  return '#ccc';
}

const state = {
  dtMap: null, simMap: null,
  dtLayer: null, simLayer: null,
  dtData: null, simData: null,
  simDistData: null,
  activeMetric: 'rsrp',
  lastMetrics: {},
  lastDist: {},
  processedMetrics: [],
};
const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  initMaps();
  attachEvents();
});

function initMaps() {
  const tile = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const opt  = { attribution:'© OpenStreetMap', maxZoom:19 };
  const ctr  = [-6.2088, 106.8456];
  state.dtMap  = L.map('dtMap').setView(ctr, 14);
  state.simMap = L.map('simMap').setView(ctr, 14);
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
  $('uploadDTBtn')?.addEventListener('click',  () => $('dtFileInput').click());
  $('uploadSimBtn')?.addEventListener('click', () => $('simFileInput').click());
  $('dtFileInput')?.addEventListener('change',  handleDTUpload);
  $('simFileInput')?.addEventListener('change', handleSimUpload);
  $('processRSRPBtn')?.addEventListener('click', () => runProcess('rsrp'));
  $('processSINRBtn')?.addEventListener('click',  () => runProcess('sinr'));
  $('processBothBtn')?.addEventListener('click',  () => runProcess('both'));
}

function handleDTUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  showLoading('Memuat data Drive Test...');
  Papa.parse(file, {
    header: true, dynamicTyping: true, skipEmptyLines: true,
    complete(res) {
      try {
        state.dtData = parsePoints(res.data, 'DT');
        renderDTMap();
        $('dtStatus').textContent = `DT: ${state.dtData.length} titik`;
        $('dtStatus').classList.add('uploaded');
        $('dtMapPlaceholder')?.classList.add('hidden');
        updateInfoPanel(); checkReady();
      } catch(err) { alert('❌ ' + err.message); }
      finally { hideLoading(); }
    },
    error: () => { alert('❌ Gagal membaca file CSV DT'); hideLoading(); }
  });
  e.target.value = '';
}

function handleSimUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  showLoading('Memuat data Simulasi...');
  const ext = file.name.split('.').pop().toLowerCase();
  const onRows = rows => {
    try {
      state.simData = parsePoints(rows, 'Simulasi');
      state.simDistData = parseSimDistData(rows);
      renderSimMap();
      $('simStatus').textContent = `Sim: ${state.simData.length} titik`;
      $('simStatus').classList.add('uploaded');
      $('simMapPlaceholder')?.classList.add('hidden');
      updateInfoPanel(); checkReady();
    } catch(err) { alert('❌ ' + err.message); }
    finally { hideLoading(); }
  };
  if (ext === 'xlsx' || ext === 'xls') {
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const wb = XLSX.read(new Uint8Array(evt.target.result), { type:'array' });
        onRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]));
      } catch { alert('❌ Gagal membaca file Excel'); hideLoading(); }
    };
    reader.readAsArrayBuffer(file);
  } else {
    Papa.parse(file, {
      header: true, dynamicTyping: true, skipEmptyLines: true,
      complete(res) { onRows(res.data); },
      error: () => { alert('❌ Gagal membaca CSV Simulasi'); hideLoading(); }
    });
  }
  e.target.value = '';
}

function parsePoints(rows, label) {
  if (!rows.length) throw new Error(`File ${label} kosong`);
  const headers = Object.keys(rows[0]);
  const find = cands => {
    for (const c of cands)
      for (const h of headers)
        if (h.toLowerCase().replace(/[\s()_]/g,'') === c) return h;
    for (const h of headers)
      if (cands.some(c => h.toLowerCase().replace(/[\s()_]/g,'').startsWith(c))) return h;
    return null;
  };
  const colLat  = find(['latitude','lat','lintang','y']);
  const colLng  = find(['longitude','lon','lng','long','bujur','x']);
  const colRsrp = find(['rsrpsimdbm','rsrpsim','rsrpdbm','rsrp','ltersrp','nrrsrp','signal']);
  const colSinr = find(['sinrsimdb','sinrsim','sinrdb','sinr','ltsinr','nrsinr','snr']);
  if (!colLat || !colLng)
    throw new Error(`Kolom Lat/Lng tidak ditemukan di file ${label}.\nHeader: ${headers.slice(0,8).join(', ')}`);
  const pn = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const pts = rows.map(r => ({
    lat: pn(r[colLat]), lng: pn(r[colLng]),
    rsrp: colRsrp ? pn(r[colRsrp]) : null,
    sinr: colSinr ? pn(r[colSinr]) : null,
  })).filter(p => p.lat !== null && p.lng !== null &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && p.lat !== 0 && p.lng !== 0);
  if (!pts.length) throw new Error(`Tidak ada titik valid di file ${label}`);
  return pts;
}

function renderDTMap() {
  state.dtLayer.clearLayers();
  if (!state.dtData?.length) return;
  const metric = state.activeMetric, unit = metric === 'rsrp' ? 'dBm' : 'dB', vals = [];
  state.dtData.forEach(pt => {
    const val = metric === 'rsrp' ? pt.rsrp : pt.sinr;
    if (val === null || isNaN(val)) return;
    vals.push(val);
    L.circleMarker([pt.lat, pt.lng], { radius:4, fillColor:getColor(val,metric), color:'rgba(0,0,0,0.25)', weight:0.5, fillOpacity:0.90 })
      .bindPopup(`<b>Drive Test</b><br>${metric.toUpperCase()}: <b>${val.toFixed(1)} ${unit}</b>`).addTo(state.dtLayer);
  });
  renderLegend('dtLegend','dtLegendTitle','dtLegendBody',metric,vals);
  const valid = state.dtData.filter(p => (metric==='rsrp'?p.rsrp:p.sinr) !== null);
  if (valid.length) state.dtMap.fitBounds(valid.map(p=>[p.lat,p.lng]));
  $('dtPointCount').textContent = `${state.dtData.length} titik`;
}

function renderSimMap() {
  state.simLayer.clearLayers();
  if (!state.simData?.length) return;
  const metric = state.activeMetric, unit = metric === 'rsrp' ? 'dBm' : 'dB', vals = [];
  state.simData.forEach(pt => {
    const val = metric === 'rsrp' ? pt.rsrp : pt.sinr;
    if (val === null || isNaN(val)) return;
    vals.push(val);
    L.circleMarker([pt.lat, pt.lng], { radius:4, fillColor:getColor(val,metric), color:'rgba(0,0,0,0.25)', weight:0.5, fillOpacity:0.85 })
      .bindPopup(`<b>Simulasi</b><br>${metric.toUpperCase()}: <b>${val.toFixed(1)} ${unit}</b>`).addTo(state.simLayer);
  });
  renderLegend('simLegend','simLegendTitle','simLegendBody',metric,vals);
  const valid = state.simData.filter(p => (metric==='rsrp'?p.rsrp:p.sinr) !== null);
  if (valid.length) state.simMap.fitBounds(valid.map(p=>[p.lat,p.lng]));
  $('simCellCount').textContent = `${state.simData.length} titik`;
}

function parseSimDistData(rows) {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);
  const find = cands => {
    for (const h of headers)
      if (cands.some(c => h.toLowerCase().replace(/[\s()_]/g,'').includes(c))) return h;
    return null;
  };

  const colDist    = find(['distancetoservingm','distance']);
  const colRsrpSim = find(['rsrpsimdbm','rsrpsim']);
  const colSinrSim = find(['sinrsimdb','sinrsim']);
  const colRsrpAkt = find(['rsrpaktualdbm']);
  const colSinrAkt = find(['sinraktualdb']);

  if (!colDist) {
    console.warn('[parseSimDistData] Kolom Distance tidak ditemukan');
    return [];
  }

  console.log('[parseSimDistData] Kolom terdeteksi:', {
    dist: colDist, rsrp_sim: colRsrpSim, sinr_sim: colSinrSim,
    rsrp_akt: colRsrpAkt, sinr_akt: colSinrAkt
  });

  const pn = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

  return rows.map(r => ({
    dist    : pn(r[colDist]),
    rsrp_sim: colRsrpSim ? pn(r[colRsrpSim]) : null,
    sinr_sim: colSinrSim ? pn(r[colSinrSim]) : null,
    rsrp_akt: colRsrpAkt ? pn(r[colRsrpAkt]) : null,
    sinr_akt: colSinrAkt ? pn(r[colSinrAkt]) : null,
  })).filter(p => p.dist !== null && p.dist > 0);
}

function runProcess(mode) {
  if (!state.dtData?.length || !state.simData?.length) { alert('⚠️ Upload kedua file terlebih dahulu.'); return; }
  const metrics = mode === 'both' ? ['rsrp','sinr'] : [mode];
  showLoading(`Memproses evaluasi ${mode === 'both' ? 'RSRP + SINR' : mode.toUpperCase()}...`);
  setTimeout(() => {
    try {
      state.activeMetric = metrics[0];
      renderDTMap(); renderSimMap();
      const hasAll = { rsrp: false, sinr: false };
      metrics.forEach(m => {
        const pairs = [], len = Math.min(state.dtData.length, state.simData.length);
        for (let i = 0; i < len; i++) {
          const dv = m==='rsrp' ? state.dtData[i].rsrp  : state.dtData[i].sinr;
          const sv = m==='rsrp' ? state.simData[i].rsrp : state.simData[i].sinr;
          if (dv != null && !isNaN(dv) && sv != null && !isNaN(sv)) pairs.push({ dt:dv, sim:sv });
        }
        if (!pairs.length) return;
        hasAll[m] = true;
        const dtVals = pairs.map(p=>p.dt), simVals = pairs.map(p=>p.sim);
        const buckets = getBuckets(m);
        const dtDist = calcDistribution(dtVals, buckets);
        const simDist = calcDistribution(simVals, buckets);
        state.lastDist[m]    = { dt:dtDist, sim:simDist, dtVals, simVals };
        state.lastMetrics[m] = calcAllMetrics(pairs, dtDist, simDist);
      });
      state.processedMetrics = metrics.filter(m => hasAll[m]);
      if (!state.processedMetrics.length) { alert('Tidak ada data yang valid.'); hideLoading(); return; }

      // Tampilkan section utama
      renderMetricsSection();
      renderAnalysis();
      renderDistanceAnalysis();

      // Update panel tambahan (tersembunyi, collapsible)
      const fm = state.processedMetrics[0];
      $('compTableTitle').innerHTML = `<i class="fas fa-balance-scale"></i> Perbandingan Distribusi ${fm.toUpperCase()}`;
      renderCompTable(state.lastDist[fm].dt, state.lastDist[fm].sim, fm);
      if (state.processedMetrics.length === 2) renderDistribTabSwitcher();

      // Tampilkan panel tambahan (collapsible container)
      const extraPanel = $('extraPanelsContainer');
      if (extraPanel) extraPanel.style.display = 'block';

    } catch(err) { console.error(err); alert('❌ ' + err.message); }
    finally { hideLoading(); }
  }, 80);
}

function calcAllMetrics(pairs, dtDist, simDist) {
  const n = pairs.length;
  const dtVals = pairs.map(p=>p.dt), simVals = pairs.map(p=>p.sim);
  const diffs  = pairs.map(p=>p.sim - p.dt);
  const mean   = arr => arr.reduce((s,v)=>s+v,0)/arr.length;
  const rmse   = +(Math.sqrt(mean(diffs.map(d=>d*d)))).toFixed(3);
  const bias   = +(mean(diffs)).toFixed(3);
  // [REV] SD — komponen sebaran error di sekitar bias (ME), identitas:
  // RMSE² = ME² + SD² → SD = √(RMSE² − ME²). Valid karena ME dan RMSE
  // dihitung dari himpunan diffs yang sama (n identik).
  const sdRaw  = Math.sqrt(Math.max(0, rmse*rmse - bias*bias));
  const sd     = +sdRaw.toFixed(3);
  const r2     = calcR2(dtVals, simVals);
  const corr   = pearsonCDF(dtVals, simVals);
  const domDT  = dtDist.reduce((a,b)=>a.pct>b.pct?a:b);
  const domSim = simDist.reduce((a,b)=>a.pct>b.pct?a:b);
  // maeDist: MAE pada persentase distribusi area (bukan MAE per titik) —
  // konsep berbeda, dipakai khusus untuk skor similarity di Perbandingan
  // Distribusi, tidak terkait dengan revisi ME/RMSE/SD per titik.
  const maeDist = +(dtDist.reduce((s,d,i)=>s+Math.abs(d.pct-simDist[i].pct),0)/dtDist.length).toFixed(2);
  const weights = [3,2,1,1,1]; let wN=0,wD=0;
  dtDist.forEach((d,i)=>{ const w=weights[i]||1; wN+=w*Math.min(d.pct,simDist[i].pct); wD+=w*Math.max(d.pct,simDist[i].pct,0.001); });
  return {
    rmse, bias, sd,
    r2: +r2.toFixed(4), corrR: corr.r, corrR2: corr.r2,
    dtMean: +(dtVals.reduce((s,v)=>s+v,0)/n).toFixed(2),
    simMean: +(simVals.reduce((s,v)=>s+v,0)/n).toFixed(2),
    maeDist, similarity: wD>0?+((wN/wD)*100).toFixed(1):0,
    domDT, domSim, nPairs: n,
  };
}

function calcR2(actual, predicted) {
  const m = actual.reduce((s,v)=>s+v,0)/actual.length;
  const ssTot = actual.reduce((s,v)=>s+(v-m)**2,0);
  const ssRes = actual.reduce((s,v,i)=>s+(v-predicted[i])**2,0);
  return ssTot > 0 ? 1 - ssRes/ssTot : 1;
}

function pearsonCDF(a1, a2) {
  const BINS=80, all=[...a1,...a2];
  const mn=Math.min(...all), mx=Math.max(...all);
  if (mx===mn) return {r:1,r2:1};
  const step=(mx-mn)/BINS, xs=[], ys=[];
  for (let i=0;i<=BINS;i++) {
    const v=mn+i*step;
    xs.push(a1.filter(x=>x<=v).length/a1.length);
    ys.push(a2.filter(x=>x<=v).length/a2.length);
  }
  const xm=xs.reduce((s,v)=>s+v,0)/(BINS+1), ym=ys.reduce((s,v)=>s+v,0)/(BINS+1);
  let num=0,dx2=0,dy2=0;
  for (let i=0;i<=BINS;i++) { num+=(xs[i]-xm)*(ys[i]-ym); dx2+=(xs[i]-xm)**2; dy2+=(ys[i]-ym)**2; }
  const r=(dx2&&dy2)?num/Math.sqrt(dx2*dy2):0;
  return {r:+r.toFixed(4), r2:+(r*r).toFixed(4)};
}

function calcDistribution(values, buckets) {
  const total = values.length || 1;
  return buckets.map(b => {
    const count = values.filter(v=>v>=b.min&&v<b.max).length;
    return {...b, pct:(count/total)*100, count};
  });
}

// ──────────────────────────────────────────────
// RENDER METRIK  (v6 — 3 kartu, tanpa warna semantik)
// ──────────────────────────────────────────────
function renderMetricsSection() {
  const sec = $('metricsSection'); if (!sec) return;
  sec.style.display = 'block';
  const wrap = $('metricsCardsWrap'); wrap.innerHTML = '';

  state.processedMetrics.forEach(m => {
    const em   = state.lastMetrics[m];
    const unit = m === 'rsrp' ? 'dBm' : 'dB';
    const label= m.toUpperCase();
    const meAbs   = Math.abs(em.bias).toFixed(3);
    const meSign  = em.bias > 0 ? '+' : em.bias < 0 ? '-' : '';
    const meDir   = em.bias > 0.05 ? 'over-predict' : em.bias < -0.05 ? 'under-predict' : 'tidak ada bias sistematis';
    // [REV] Dominasi bias vs variasi acak — pengganti rasio RMSE/MAE.
    // SD < |ME|  → error didominasi bias sistematis (konsisten, terkait kalibrasi)
    // SD > |ME|  → error didominasi variasi acak (sebaran tak terduga)
    const domNote = em.sd > Math.abs(em.bias)
      ? 'Variasi acak lebih dominan dari bias'
      : 'Bias sistematis lebih dominan dari variasi acak';

    const groupHtml = `
    <div class="metric-group">

      <!-- Header ringkas -->
      <div class="metric-group-header mgh-${m}">
        <div class="mgh-left">
          <span class="mgh-badge">${label}</span>
          <div class="mgh-facts">
            <span class="mgh-fact-item">
              <span class="mgh-fact-label">Pasangan titik:</span>
              <span class="mgh-fact-val">${em.nPairs.toLocaleString()} koordinat identik</span>
            </span>
            <span class="mgh-fact-sep">|</span>
            <span class="mgh-fact-item">
              <span class="mgh-fact-label">Rata-rata DT:</span>
              <span class="mgh-fact-val">${em.dtMean} ${unit}</span>
            </span>
            <span class="mgh-fact-sep">|</span>
            <span class="mgh-fact-item">
              <span class="mgh-fact-label">Rata-rata Sim:</span>
              <span class="mgh-fact-val">${em.simMean} ${unit}</span>
            </span>
          </div>
        </div>
      </div>

      <!-- 3 Cards — tanpa warna semantik -->
      <div class="metric-cards-row metric-cards-3">

        <!-- Mean Error (ME) -->
        <div class="metric-card mc-neutral">
          <div class="mc-top">
            <span class="mc-key">Mean Error</span>
            <span class="mc-type-badge mcb-pt">Per Titik</span>
          </div>
          <div class="mc-val">${meSign}${meAbs}<span class="mc-unit">${unit}</span></div>
          <div class="mc-label">Bias Sistematis Simulasi</div>
          <div class="mc-desc">Rata-rata arah kesalahan. Positif = simulasi cenderung over-predict. Nilai kecil bukan berarti akurasi per titik tinggi dan error bisa saling cancel.</div>
          <div class="mc-subdesc">${em.bias > 0.05 ? 'Simulasi over-predict' : em.bias < -0.05 ? 'Simulasi under-predict' : 'Tidak ada kecenderungan sistematis'} terhadap Drive Test.</div>
          <div class="mc-formula">ME = mean(Sim<sub>i</sub> − DT<sub>i</sub>)</div>
        </div>

        <!-- RMSE -->
        <div class="metric-card mc-neutral">
          <div class="mc-top">
            <span class="mc-key">RMSE</span>
            <span class="mc-type-badge mcb-pt">Per Titik</span>
          </div>
          <div class="mc-val">${em.rmse}<span class="mc-unit">${unit}</span></div>
          <div class="mc-label">Root Mean Square Error</div>
          <div class="mc-desc">Lebih sensitif terhadap error besar, titik dengan deviasi ekstrem lebih berpengaruh. Menggabungkan bias (ME) dan sebaran (SD) secara kuadratik.</div>
          <div class="mc-subdesc">Nilai tinggi adalah karakteristik model empiris.</div>
          <div class="mc-formula">RMSE = √mean(Sim<sub>i</sub> − DT<sub>i</sub>)²</div>
        </div>

        <!-- SD -->
        <div class="metric-card mc-neutral">
          <div class="mc-top">
            <span class="mc-key">SD</span>
            <span class="mc-type-badge mcb-pt">Per Titik</span>
          </div>
          <div class="mc-val">${em.sd}<span class="mc-unit">${unit}</span></div>
          <div class="mc-label">Standar Deviasi Error</div>
          <div class="mc-desc">Sebaran error di sekitar bias rata-rata (ME). Melengkapi ME. RMSE² = ME² + SD², sehingga SD mengisolasi komponen acak dari komponen sistematis.</div>
          <div class="mc-subdesc">Pada data ini, ${domNote}.</div>
          <div class="mc-formula">SD = √(RMSE² − ME²)</div>
        </div>

      </div><!-- /metric-cards-row -->
    </div><!-- /metric-group -->`;

    wrap.insertAdjacentHTML('beforeend', groupHtml);
  });

  renderMetricsInterpretation();
}

// ──────────────────────────────────────────────
// INTERPRETASI METRIK  (v6 — tanpa r CDF di card)
// ──────────────────────────────────────────────
function renderMetricsInterpretation() {
  const el = $('metricsInterpretation'); if (!el) return;
  const rows = [];

  state.processedMetrics.forEach(m => {
    const em   = state.lastMetrics[m];
    const unit = m === 'rsrp' ? 'dBm' : 'dB';
    const label= m.toUpperCase();
    const meAbs = Math.abs(em.bias).toFixed(3);
    const domNote = em.sd > Math.abs(em.bias) ? 'variasi acak lebih dominan dari bias' : 'bias sistematis lebih dominan dari variasi acak';

    const meText = Math.abs(em.bias) < 0.3
      ? `ME ≈ 0 — tidak ada kecenderungan over/under-predict.`
      : `ME = <b>${em.bias > 0 ? '+' : ''}${em.bias} ${unit}</b> (Simulasi ${em.bias > 0 ? 'over' : 'under'}-predict. Nilai ini wajar pada model empiris tanpa kalibrasi clutter lokasi.)`;

    const ptText = `RMSE = <b>${em.rmse} ${unit}</b>, SD = <b>${em.sd} ${unit}</b> (${domNote}. SD mengisolasi komponen sebaran acak dari bias sistematis) (RMSE² = ME² + SD²).`;

    rows.push(`
      <div class="mi-block">
        <div class="mi-label">${label}</div>
        <div class="mi-content">
          <div class="mi-row"><span class="mi-tag mi-tag-pt">Per Titik</span><span>${meText}</span></div>
          <div class="mi-row"><span class="mi-tag mi-tag-pt">Per Titik</span><span>${ptText}</span></div>
        </div>
      </div>`);
  });

  el.innerHTML = `
    <div class="mi-wrap">
      <div class="mi-title"><i class="fas fa-lightbulb"></i> Interpretasi Metrik</div>
      ${rows.join('')}
      <div class="mi-note">
        <b>Metodologi:</b> Ketiga metrik dihitung <b>point-to-point</b> — DT[i] ↔ Sim[i] pada koordinat identik.
        Mean Error mengukur arah bias sistematis; RMSE menggabungkan bias dan sebaran secara kuadratik; SD mengisolasi komponen sebaran acak di sekitar bias.
        Nilai RMSE/SD tinggi adalah karakteristik expected model empiris stokastik (ITU-R M.2135) — evaluasi coverage area dilakukan terpisah via distribusi.
      </div>
    </div>`;
}

// ──────────────────────────────────────────────
// TAB SWITCHER
// ──────────────────────────────────────────────
function renderDistribTabSwitcher() {
  const title = $('compTableTitle'); if (!title) return;
  const compPanel = title.closest('.comp-panel') || title.parentElement;
  let tabRow = compPanel.querySelector('.distrib-tabs');
  if (!tabRow) {
    tabRow = document.createElement('div');
    tabRow.className = 'distrib-tabs';
    compPanel.insertBefore(tabRow, compPanel.querySelector('.comp-table-wrap'));
  }
  tabRow.innerHTML = `
    <button class="dtab active" data-m="rsrp">RSRP</button>
    <button class="dtab" data-m="sinr">SINR</button>`;
  tabRow.querySelectorAll('.dtab').forEach(btn => {
    btn.addEventListener('click', () => {
      tabRow.querySelectorAll('.dtab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const m = btn.dataset.m;
      $('compTableTitle').innerHTML = `<i class="fas fa-balance-scale"></i> Perbandingan Distribusi ${m.toUpperCase()}`;
      renderCompTable(state.lastDist[m].dt, state.lastDist[m].sim, m);
    });
  });
}

// ──────────────────────────────────────────────
// RENDER TABEL DISTRIBUSI
// ──────────────────────────────────────────────
function renderCompTable(dtDist, simDist, metric) {
  const tbody = $('compTableBody'); if (!tbody) return;
  tbody.innerHTML = '';
  const unit = metric === 'rsrp' ? 'dBm' : 'dB';

  dtDist.forEach((dt, i) => {
    const sim      = simDist[i];
    const delta    = sim.pct - dt.pct;
    const sign     = delta > 0 ? '+' : '';
    const deltaAbs = Math.abs(delta);
    const deltaColor = deltaAbs <= 3 ? '#16a34a' : deltaAbs <= 8 ? '#b45309' : '#dc2626';

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>
          <div class="td-cat">
            <span class="cat-swatch" style="background:${dt.color}"></span>
            <div>
              <div class="td-cat-main">${dt.label}</div>
              <div class="td-cat-range">${dt.range} ${unit}</div>
            </div>
          </div>
        </td>
        <td class="td-num">${dt.pct.toFixed(1)}%</td>
        <td class="td-num">${sim.pct.toFixed(1)}%</td>
        <td class="td-num td-delta" style="color:${deltaColor};font-weight:600;">${sign}${delta.toFixed(1)}%</td>
      </tr>`);
  });
}

// ──────────────────────────────────────────────
// ANALISIS VALIDASI  (v6 — ringkas, tanpa detail table)
// ──────────────────────────────────────────────
function renderAnalysis() {
  const el = $('overallAnalysisContent'); if (!el) return;
  const parts = [];

  state.processedMetrics.forEach(m => {
    const em   = state.lastMetrics[m];
    const unit = m === 'rsrp' ? 'dBm' : 'dB';
    const label= m.toUpperCase();
    const meAbs  = Math.abs(em.bias).toFixed(3);
    const domNote = em.sd > Math.abs(em.bias) ? 'Variasi acak lebih dominan dari bias' : 'bias sistematis lebih dominan dari variasi acak';

    // Temuan 1 — Mean Error
    const f1Body = Math.abs(em.bias) < 0.5
      ? `ME ≈ 0 — tidak ada kecenderungan sistematis. Model terkalibrasi baik secara rata-rata.`
      : `Simulasi ${em.bias > 0 ? 'over' : 'under'}-predict sebesar <b>${meAbs} ${unit}</b> secara rata-rata. ${Math.abs(em.bias) < 3 ? 'Masih dalam batas wajar untuk model propagasi empiris.' : 'Pertimbangkan kalibrasi clutter loss atau parameter NLOS.'}`;

    // Temuan 2 — RMSE
    const f2Body = `RMSE = <b>${em.rmse} ${unit}</b> menggabungkan bias dan sebaran error secara kuadratik. Ini adalah besaran error khas yang diharapkan saat model diterapkan di area pengukuran ini.`;

    // Temuan 3 — SD
    const f3Body = `SD = <b>${em.sd} ${unit}</b> — ${domNote}. SD mengisolasi komponen sebaran acak dari bias sistematis (RMSE² = ME² + SD²); nilai SD tinggi adalah karakteristik expected model empiris stokastik (ITU-R M.2135).`;

    // Rekomendasi
    let recIcon, recClass, recText;
    if (Math.abs(em.bias) <= 3 && em.corrR >= 0.90) {
      recIcon='✅'; recClass='rec-ok';
      recText=`Model terkalibrasi baik — ME = ${em.bias > 0 ? '+' : ''}${em.bias} ${unit} dalam batas wajar. SD = ${em.sd} ${unit} menunjukkan ${domNote}. Simulasi dapat digunakan sebagai acuan RF planning. Lihat Perbandingan Distribusi untuk validasi coverage area.`;
    } else if (Math.abs(em.bias) > 3) {
      recIcon='🔧'; recClass='rec-warn';
      recText=`ME = ${em.bias > 0 ? '+' : ''}${em.bias} ${unit} relatif besar — pertimbangkan kalibrasi clutter loss, koreksi ketinggian antena efektif, atau penyesuaian parameter NLOS pada model propagasi.`;
    } else {
      recIcon='🔧'; recClass='rec-warn';
      recText=`SD = ${em.sd} ${unit} menunjukkan sebaran error per titik yang cukup besar. Evaluasi resolusi grid simulasi, tinggi antena efektif, dan kesesuaian model propagasi (UMa/UMi) dengan karakteristik area.`;
    }

    parts.push(`
    <div class="simple-analysis sa-sep">
      <div class="sa-findings">
        <div class="sa-finding-title"><i class="fas fa-search"></i> Temuan — ${label}</div>

        <div class="sa-finding sf-neutral">
          <div class="sf-num">1</div>
          <div class="sf-content">
            <div class="sf-head"><span class="sf-badge sf-badge-pt">Per Titik</span> Mean Error (Bias Sistematis)</div>
            <div class="sf-body">${f1Body}</div>
          </div>
        </div>

        <div class="sa-finding sf-neutral">
          <div class="sf-num">2</div>
          <div class="sf-content">
            <div class="sf-head"><span class="sf-badge sf-badge-pt">Per Titik</span> RMSE (Sensitivitas terhadap Error Besar)</div>
            <div class="sf-body">${f2Body}</div>
          </div>
        </div>

        <div class="sa-finding sf-neutral">
          <div class="sf-num">3</div>
          <div class="sf-content">
            <div class="sf-head"><span class="sf-badge sf-badge-pt">Per Titik</span> SD (Sebaran Error di Sekitar Bias)</div>
            <div class="sf-body">${f3Body}</div>
          </div>
        </div>
      </div>

      <div class="sa-rec ${recClass}">
        <div class="sa-rec-icon">${recIcon}</div>
        <div class="sa-rec-body">
          <div class="sa-rec-title">Rekomendasi — ${label}</div>
          <div class="sa-rec-text">${recText}</div>
        </div>
      </div>

    </div>`);
  });

  el.innerHTML = parts.join('');
}

// ══════════════════════════════════════════════
// ANALISIS PER RENTANG JARAK
// ══════════════════════════════════════════════
function renderDistanceAnalysis() {
  const el = $('distanceAnalysisContent');
  if (!el) return;

  // Ambil data dari simData yang punya kolom Distance
  // CSV export simulasi punya kolom Distance_to_Serving(m)
  // Kita perlu re-parse CSV yang diupload user
  // Tapi simData hanya punya lat/lng/rsrp/sinr
  // Solusi: simpan distance saat parse CSV simulasi
  if (!state.simDistData || !state.simDistData.length) {
    el.innerHTML = `<div class="waiting-notice">
      <i class="fas fa-route"></i>
      Upload file CSV hasil ekspor simulasi (yang memiliki kolom Distance_to_Serving)
      untuk melihat analisis per rentang jarak.
    </div>`;
    return;
  }

  const RANGES = [
    { label: '< 200 m',      min: 0,    max: 200,  desc: 'Jarak dekat' },
    { label: '200 – 400 m',  min: 200,  max: 400,  desc: 'Jarak sedang' },
    { label: '400 – 600 m',  min: 400,  max: 600,  desc: 'Jarak menengah' },
    { label: '600 – 800 m',  min: 600,  max: 800,  desc: 'Jarak jauh' },
    { label: '> 800 m',      min: 800,  max: Infinity, desc: 'Jarak sangat jauh' },
  ];

  const metrics = state.processedMetrics;

  let html = `<div class="dist-analysis-wrap">`;

  metrics.forEach(m => {
    const unit = m === 'rsrp' ? 'dBm' : 'dB';
    const label = m.toUpperCase();

    html += `
    <div class="dist-metric-block">
      <div class="dist-metric-title">
        <span class="mgh-badge">${label}</span>
        Akurasi per Rentang Jarak
      </div>
      <div class="dist-table-wrap">
        <table class="dist-table">
          <thead>
            <tr>
              <th>Rentang Jarak</th>
              <th>Jumlah Titik</th>
              <th>ME (${unit})</th>
              <th>RMSE (${unit})</th>
              <th>SD (${unit})</th>
              <th>Kecenderungan</th>
            </tr>
          </thead>
          <tbody>`;

    RANGES.forEach(range => {
      const pts = state.simDistData.filter(p => {
        const d = p.dist;
        const v_sim = m === 'rsrp' ? p.rsrp_sim : p.sinr_sim;
        const v_akt = m === 'rsrp' ? p.rsrp_akt : p.sinr_akt;
        return d >= range.min && d < range.max
          && v_sim != null && v_akt != null
          && !isNaN(v_sim) && !isNaN(v_akt);
      });

      if (!pts.length) {
        html += `<tr>
          <td><b>${range.label}</b><br><span style="font-size:9px;color:#999">${range.desc}</span></td>
          <td colspan="5" style="text-align:center;color:#bbb;font-style:italic">Tidak ada data</td>
        </tr>`;
        return;
      }

      const diffs = pts.map(p => {
        const sim = m === 'rsrp' ? p.rsrp_sim : p.sinr_sim;
        const akt = m === 'rsrp' ? p.rsrp_akt : p.sinr_akt;
        return sim - akt;
      });

      const n    = diffs.length;
      const me   = diffs.reduce((s,v)=>s+v,0) / n;
      const rmse = Math.sqrt(diffs.reduce((s,v)=>s+v*v,0) / n);
      // [REV] SD per rentang jarak, identitas RMSE² = ME² + SD²
      const sd   = Math.sqrt(Math.max(0, rmse*rmse - me*me));

      const meSign = me >= 0 ? '+' : '';
      const trend = Math.abs(me) < 2
        ? { icon: '✅', text: 'Akurat', cls: 'trend-good' }
        : me > 0
          ? { icon: '🔼', text: 'Over-predict', cls: 'trend-over' }
          : { icon: '🔽', text: 'Under-predict', cls: 'trend-under' };

      html += `<tr>
        <td><b>${range.label}</b><br><span style="font-size:9px;color:#999">${range.desc}</span></td>
        <td style="text-align:center;font-weight:700;color:#1F3C88">${n}</td>
        <td style="text-align:center;font-weight:700">${meSign}${me.toFixed(2)}</td>
        <td style="text-align:center;font-weight:700">${rmse.toFixed(2)}</td>
        <td style="text-align:center;font-weight:700">${sd.toFixed(2)}</td>
        <td style="text-align:center"><span class="dist-trend ${trend.cls}">${trend.icon} ${trend.text}</span></td>
      </tr>`;
    });

    html += `</tbody></table></div></div>`;
  });
  el.innerHTML = html;
}

// ──────────────────────────────────────────────
// LEGEND
// ──────────────────────────────────────────────
function renderLegend(legendId, titleId, bodyId, metric, values) {
  const buckets = getBuckets(metric), total = values.filter(v=>!isNaN(v)).length||1;
  const el=$(legendId); if(!el) return;
  el.style.display='block';
  $(titleId).textContent = metric==='rsrp'?'RSRP (dBm)':'SINR (dB)';
  const tbody=$(bodyId); tbody.innerHTML='';
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

function updateInfoPanel() {
  const dtN=state.dtData?.length||0, simN=state.simData?.length||0;
  const dtR=state.dtData?.filter(p=>p.rsrp!==null).length||0;
  const dtS=state.dtData?.filter(p=>p.sinr!==null).length||0;
  const simR=state.simData?.filter(p=>p.rsrp!==null).length||0;
  const simS=state.simData?.filter(p=>p.sinr!==null).length||0;
  $('infoContent').innerHTML=`
    <table class="info-table">
      <tr><td colspan="2"><span class="info-section-label">Drive Test</span></td></tr>
      <tr><td>Total titik</td><td>${dtN.toLocaleString()}</td></tr>
      <tr><td>Ada RSRP</td><td>${dtR.toLocaleString()}</td></tr>
      <tr><td>Ada SINR</td><td>${dtS.toLocaleString()}</td></tr>
      <tr><td colspan="2"><span class="info-section-label">Simulasi</span></td></tr>
      <tr><td>Total titik</td><td>${simN.toLocaleString()}</td></tr>
      <tr><td>Ada RSRP</td><td>${simR.toLocaleString()}</td></tr>
      <tr><td>Ada SINR</td><td>${simS.toLocaleString()}</td></tr>
    </table>`;
}

function checkReady() {
  const ok=state.dtData?.length>0&&state.simData?.length>0;
  const hasBoth=ok&&state.dtData.some(p=>p.rsrp!==null)&&state.dtData.some(p=>p.sinr!==null)
    &&state.simData.some(p=>p.rsrp!==null)&&state.simData.some(p=>p.sinr!==null);
  ['processRSRPBtn','processSINRBtn'].forEach(id=>{const b=$(id);if(b)b.disabled=!ok;});
  const bb=$('processBothBtn');if(bb)bb.disabled=!hasBoth;
}

function showLoading(msg) {
  hideLoading();
  const el=document.createElement('div'); el.id='scOverlay'; el.className='loading-overlay';
  el.innerHTML=`<div class="loading-box"><div class="spinner"></div><p class="loading-txt">${msg||'Memproses...'}</p></div>`;
  document.body.appendChild(el);
}
function hideLoading() { document.getElementById('scOverlay')?.remove(); }

console.log('simulationcom.js v7 — 3 metrik (ME, RMSE, SD), tanpa warna semantik, panel tambahan collapsible');