/* ================================================
   analysis.js  v3
   Komparasi Drive Test vs Simulasi (file upload)
   ================================================ */
'use strict';

// ── UNIFIED BUCKETS ────────────────────────────
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
  for (const b of getBuckets(metric)) if (value>=b.min&&value<b.max) return b.color;
  return '#ccc';
}

// ── STATE ──────────────────────────────────────
let dtMap, simMap, dtLayer, simLayer;
let dtData  = null;
let simData = null;
let isSyncing = false;
let currentDTMetric  = 'rsrp';
let currentSimMetric = 'rsrp';
const $ = id => document.getElementById(id);

// ──────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMaps(); attachEvents();
});

function initMaps() {
  const tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const opt     = { attribution: '© OpenStreetMap', maxZoom: 19 };
  const center  = [-6.2088, 106.8456];
  dtMap  = L.map('dtMap').setView(center, 14);
  simMap = L.map('simMap').setView(center, 14);
  L.tileLayer(tileUrl, opt).addTo(dtMap);
  L.tileLayer(tileUrl, opt).addTo(simMap);
  dtLayer  = L.layerGroup().addTo(dtMap);
  simLayer = L.layerGroup().addTo(simMap);

  function syncMaps(src, dst) {
    src.on('move', () => {
      if (isSyncing) return;
      isSyncing = true;
      dst.setView(src.getCenter(), src.getZoom(), { animate: false });
      isSyncing = false;
    });
  }
  syncMaps(dtMap, simMap);
  syncMaps(simMap, dtMap);
}

// ──────────────────────────────────────────────
// EVENTS
// ──────────────────────────────────────────────
function attachEvents() {
  $('uploadDTBtn')?.addEventListener('click',  () => $('dtFileInput').click());
  $('uploadSimBtn')?.addEventListener('click', () => $('simFileInput').click());
  $('dtFileInput')?.addEventListener('change',  handleDTUpload);
  $('simFileInput')?.addEventListener('change', handleSimUpload);
  $('processRSRPBtn')?.addEventListener('click', () => processAnalysis('rsrp'));
  $('processSINRBtn')?.addEventListener('click',  () => processAnalysis('sinr'));
  $('dtMetric')?.addEventListener('change',  e => { currentDTMetric  = e.target.value; if (dtData)  displayDTData();  });
  $('simMetric')?.addEventListener('change', e => { currentSimMetric = e.target.value; if (simData) displaySimData(); });
}

// ──────────────────────────────────────────────
// FILE UPLOAD
// ──────────────────────────────────────────────
function handleDTUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  showLoading('Memuat data Drive Test...');
  Papa.parse(file, {
    header: true, dynamicTyping: true, skipEmptyLines: true,
    complete(res) {
      try {
        dtData = parsePoints(res.data);
        displayDTData();
        $('dtStatus').textContent = `DT: ${dtData.length} titik`;
        $('dtStatus').classList.add('uploaded');
        $('dtMapPlaceholder')?.classList.add('hidden');
        updateInfoPanel();
        checkReady();
      } catch (err) { console.error(err); alert('❌ Error memproses data Drive Test'); }
      finally { hideLoading(); }
    },
    error() { alert('❌ Error membaca file Drive Test'); hideLoading(); }
  });
  e.target.value = '';
}

function handleSimUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  showLoading('Memuat data Simulasi...');
  const ext = file.name.split('.').pop().toLowerCase();

  const onRows = rows => {
    try {
      simData = parsePoints(rows);
      displaySimData();
      $('simStatus').textContent = `Sim: ${simData.length} titik`;
      $('simStatus').classList.add('uploaded');
      $('simMapPlaceholder')?.classList.add('hidden');
      updateInfoPanel();
      checkReady();
    } catch (err) { console.error(err); alert('❌ Error memproses data Simulasi'); }
    finally { hideLoading(); }
  };

  if (ext==='xlsx'||ext==='xls') {
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const wb   = XLSX.read(new Uint8Array(evt.target.result),{type:'array'});
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        onRows(rows);
      } catch { alert('❌ Error membaca file Excel'); hideLoading(); }
    };
    reader.readAsArrayBuffer(file);
  } else {
    Papa.parse(file,{header:true,dynamicTyping:true,skipEmptyLines:true,
      complete(res){onRows(res.data);},
      error(){alert('❌ Error membaca file CSV');hideLoading();}
    });
  }
  e.target.value = '';
}

// ──────────────────────────────────────────────
// PARSE POINTS
// ──────────────────────────────────────────────
function parsePoints(rows) {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);
  const find = cands => {
    for (const h of headers) {
      const hl = h.toLowerCase().replace(/[\s()]/g,'');
      if (cands.some(c=>hl===c||hl.startsWith(c))) return h;
    }
    return null;
  };
  const colLat  = find(['latitude','lat','lintang','y']);
  const colLng  = find(['longitude','lon','lng','long','bujur','x']);
  const colRsrp = find(['rsrpdbm','rsrp','ltersrp','nrrsrp','signal','rsrp_sim']);
  const colSinr = find(['sinrdb','sinr','ltsinr','nrsinr','snr','sinr_sim']);
  if (!colLat||!colLng) {
    alert(`Kolom Lat/Lng tidak ditemukan.\nHeader: ${headers.slice(0,8).join(', ')}`);
    throw new Error('Missing lat/lng');
  }
  const pn = v => { const n=parseFloat(v); return isNaN(n)?null:n; };
  return rows.map(r=>({
    lat:  pn(r[colLat]), lng: pn(r[colLng]),
    rsrp: colRsrp?pn(r[colRsrp]):null,
    sinr: colSinr?pn(r[colSinr]):null,
  })).filter(p=>
    p.lat!==null&&p.lng!==null&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180&&p.lat!==0&&p.lng!==0
  );
}

// ──────────────────────────────────────────────
// DISPLAY MAPS
// ──────────────────────────────────────────────
function displayDTData() {
  dtLayer.clearLayers();
  if (!dtData?.length) return;
  const metric=currentDTMetric, unit=metric==='rsrp'?'dBm':'dB';
  const vals=[];
  dtData.forEach(pt=>{
    const val=metric==='rsrp'?pt.rsrp:pt.sinr;
    if (val===null||isNaN(val)) return;
    vals.push(val);
    L.circleMarker([pt.lat,pt.lng],{
      radius:5,fillColor:getColor(val,metric),
      color:'rgba(0,0,0,0.2)',weight:0.5,fillOpacity:0.88
    }).bindPopup(`<b>Drive Test</b><br>${metric.toUpperCase()}: ${val.toFixed(1)} ${unit}`)
      .addTo(dtLayer);
  });
  renderLegend('dtLegend','dtLegendTitle','dtLegendBody',metric,vals);
  $('dtPointCount').textContent=`${dtData.length} titik`;
  if (vals.length) dtMap.fitBounds(dtData.filter(p=>(metric==='rsrp'?p.rsrp:p.sinr)!==null).map(p=>[p.lat,p.lng]));
}

function displaySimData() {
  simLayer.clearLayers();
  if (!simData?.length) return;
  const metric=currentSimMetric, unit=metric==='rsrp'?'dBm':'dB';
  const vals=[];
  simData.forEach(pt=>{
    const val=metric==='rsrp'?pt.rsrp:pt.sinr;
    if (val===null||isNaN(val)) return;
    vals.push(val);
    L.circleMarker([pt.lat,pt.lng],{
      radius:5,fillColor:getColor(val,metric),
      color:'rgba(0,0,0,0.2)',weight:0.5,fillOpacity:0.88
    }).bindPopup(`<b>Simulasi</b><br>${metric.toUpperCase()}: ${val.toFixed(1)} ${unit}`)
      .addTo(simLayer);
  });
  renderLegend('simLegend','simLegendTitle','simLegendBody',metric,vals);
  $('simCellCount').textContent=`${simData.length} titik`;
  if (vals.length) simMap.fitBounds(simData.filter(p=>(metric==='rsrp'?p.rsrp:p.sinr)!==null).map(p=>[p.lat,p.lng]));
}

// ──────────────────────────────────────────────
// PROCESS ANALYSIS
// ──────────────────────────────────────────────
function processAnalysis(metric) {
  if (!dtData?.length||!simData?.length) { alert('⚠️ Upload kedua file terlebih dahulu'); return; }
  showLoading(`Memproses analisis ${metric.toUpperCase()}...`);
  setTimeout(()=>{
    try {
      currentDTMetric  = metric;
      currentSimMetric = metric;
      $('dtMetric').value  = metric;
      $('simMetric').value = metric;
      displayDTData();
      displaySimData();

      const buckets = getBuckets(metric);
      const dtVals  = dtData.map(p=>metric==='rsrp'?p.rsrp:p.sinr).filter(v=>v!==null&&!isNaN(v));
      const simVals = simData.map(p=>metric==='rsrp'?p.rsrp:p.sinr).filter(v=>v!==null&&!isNaN(v));
      if (!dtVals.length||!simVals.length) {
        alert(`Tidak ada data ${metric.toUpperCase()} yang valid.`);
        hideLoading(); return;
      }
      const dtDist  = calcDistribution(dtVals,  buckets);
      const simDist = calcDistribution(simVals, buckets);
      const em      = calcMetrics(dtDist, simDist);

      $('compTableTitle').innerHTML =
        `<i class="fas fa-balance-scale"></i> Perbandingan Distribusi ${metric.toUpperCase()}`;
      renderComparisonTable(dtDist, simDist, metric);
      renderAnalysis(dtDist, simDist, em, metric);
    } catch (err) { console.error(err); alert('❌ Error: ' + err.message); }
    finally { hideLoading(); }
  }, 80);
}

// ──────────────────────────────────────────────
// DISTRIBUSI + METRICS
// ──────────────────────────────────────────────
function calcDistribution(values, buckets) {
  const total=values.length||1;
  return buckets.map(b=>{
    const count=values.filter(v=>v>=b.min&&v<b.max).length;
    return {...b,pct:(count/total)*100,count};
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
// RENDER TABLE
// ──────────────────────────────────────────────
function renderComparisonTable(dtDist, simDist, metric) {
  const tbody = $('compTableBody'); tbody.innerHTML='';
  dtDist.forEach((dt,i)=>{
    const sim=simDist[i], delta=sim.pct-dt.pct, abs=Math.abs(delta);
    let pill,dc;
    if (abs<=5)       {pill='<span class="pill-ok">✔ Sesuai</span>';      dc='zero';}
    else if (abs<=10) {pill='<span class="pill-warn">⚠ Toleransi</span>'; dc=delta>0?'pos':'neg';}
    else              {pill='<span class="pill-bad">✗ Deviasi</span>';    dc=delta>0?'pos':'neg';}
    const note = generateBucketNote(delta, i);
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
        <td class="td-analysis">${note}</td>
      </tr>`);
  });
}

function generateBucketNote(delta, idx) {
  const abs=Math.abs(delta).toFixed(1);
  if (Math.abs(delta)<5) return 'Sesuai';
  const isGood=idx<=1;
  if (delta>0) return isGood?`Sim overestimate +${abs}%`:`Sim prediksi lebih buruk +${abs}%`;
  return isGood?`Sim underestimate -${abs}%`:`Sim prediksi lebih baik -${abs}%`;
}

// ──────────────────────────────────────────────
// RENDER ANALYSIS — same layout as coveragecom
// ──────────────────────────────────────────────
function renderAnalysis(dtDist, simDist, em, metric) {
  const {mae,rmse,domDT,domSim,similarity} = em;

  let vClass,vIcon,vLabel;
  if (mae<=5&&similarity>=75)       {vClass='good';vIcon='✅';vLabel='Akurat';}
  else if (mae<=10&&similarity>=55) {vClass='ok';  vIcon='⚠️';vLabel='Cukup';}
  else                               {vClass='bad'; vIcon='🔴';vLabel='Perlu Kalibrasi';}

  const domMatch=domDT.label===domSim.label;
  let maxDev=0,maxDevLabel='';
  dtDist.forEach((d,i)=>{const v=Math.abs(simDist[i].pct-d.pct);if(v>maxDev){maxDev=v;maxDevLabel=d.label;}});
  const goodDT =dtDist[0].pct+dtDist[1].pct;
  const goodSim=simDist[0].pct+simDist[1].pct;
  const goodDiff=goodSim-goodDT;

  let recClass,recText;
  if (mae<=5&&similarity>=75) {
    recClass='good'; recText='✔ Model simulasi representatif — validasi diterima.';
  } else if (mae<=10&&similarity>=55) {
    recClass='warn'; recText='⚠ Model cukup representatif, namun beberapa parameter dapat disesuaikan.';
  } else {
    recClass='danger'; recText='✗ Perlu kalibrasi — periksa path loss model, tinggi antena, atau clutter factor.';
  }

  $('overallAnalysisContent').innerHTML = `
    <div class="analysis-grid">

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
            <div class="finding-sub">${domSim.pct.toFixed(1)}% dari total titik ${domMatch?'— ✅ Konsisten':'— ⚠ Berbeda'}</div>
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
function renderLegend(legendId,titleId,bodyId,metric,values) {
  const buckets=getBuckets(metric);
  const total=values.filter(v=>!isNaN(v)).length||1;
  const el=$(legendId); if(!el) return;
  el.style.display='block';
  $(titleId).textContent=metric==='rsrp'?'RSRP (dBm)':'SINR (dB)';
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

// ──────────────────────────────────────────────
// INFO PANEL — with main site + neighbour rows
// ──────────────────────────────────────────────
function updateInfoPanel() {
  const dtN  = dtData?.length  || 0;
  const simN = simData?.length || 0;
  const dtR  = dtData?.filter(p=>p.rsrp!==null).length  || 0;
  const dtS  = dtData?.filter(p=>p.sinr!==null).length  || 0;
  const simR = simData?.filter(p=>p.rsrp!==null).length || 0;
  const simS = simData?.filter(p=>p.sinr!==null).length || 0;
  $('infoContent').innerHTML = `
    <table class="info-table">
      <tr><td colspan="2"><span class="info-section-label">Drive Test</span></td></tr>
      <tr><td>Titik</td><td>${dtN}</td></tr>
      <tr><td>Ber-RSRP</td><td>${dtR}</td></tr>
      <tr><td>Ber-SINR</td><td>${dtS}</td></tr>
      <tr><td colspan="2"><span class="info-section-label">Simulasi</span></td></tr>
      <tr><td>Main Site</td><td><span class="info-tag highlight">★ —</span></td></tr>
      <tr><td>Titik</td><td>${simN}</td></tr>
      <tr><td>Ber-RSRP</td><td>${simR}</td></tr>
      <tr><td>Ber-SINR</td><td>${simS}</td></tr>
      <tr><td>Neighbour</td><td>—</td></tr>
      <tr><td>Metode</td><td>File Upload</td></tr>
    </table>`;
}

// ──────────────────────────────────────────────
// UTILITIES
// ──────────────────────────────────────────────
function checkReady() {
  const ok=dtData?.length>0&&simData?.length>0;
  ['processRSRPBtn','processSINRBtn'].forEach(id=>{
    const b=$(id); if(b) b.disabled=!ok;
  });
}
function showLoading(msg) {
  hideLoading();
  const el=document.createElement('div'); el.id='anlOverlay'; el.className='loading-overlay';
  el.innerHTML=`<div class="loading-box"><div class="spinner"></div><p class="loading-txt">${msg||'Memproses...'}</p></div>`;
  document.body.appendChild(el);
}
function hideLoading() { document.getElementById('anlOverlay')?.remove(); }

console.log('analysis.js v3 — unified buckets, matching layout, simplified analysis');