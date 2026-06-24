'use strict';
// ================================================
// BLANK SPOT OPTIMIZER v2.1 — FIXED
// Perbaikan:
// 1. SINR dihitung dengan interferensi dari semua site (existing + baru)
// 2. overlayGrids update sinrValue dengan benar
// 3. Denominator before/after konsisten (hanya grid overlap)
// ================================================

let mapBefore, mapAfter;
let siteMarkerAfter = null;
let currentSiteLocation = null;
let currentCoverageType = 'rsrp';
let sectorCount = 3;
let azimuths    = [];
let gapData     = null;
let clusterSnapshot = null;
let gapGridsBefore  = [];
let gapGridsAfter   = [];
let gapRadiusM  = 300;
let gapCenterLat = null, gapCenterLng = null;
let beforeLayerGroup = null;

const GAP_PLANNING_KEY = 'gapPlanningData';
const CV_PLANNING_KEY  = 'coveragePlanningSnapshot';
const SECTOR_COLORS    = ['#ff2d55','#00c7be','#ffcc00','#af52de','#ff9500','#34c759'];

// ── Konstanta 3GPP TR 38.901 ──────────────────────
const MOBILE_H = 1.5, RX_FLOOR = -125.2;
const IM_DB = 2.0, IM_FACTOR = Math.pow(10, IM_DB / 10);
const DOMINANT_THRESHOLD_DB = 30;
const SHADOW_STD = { uma_los:4, uma_nlos:6, uma_los_nlos:5.5, umi_los:4, umi_nlos:7.82, umi_los_nlos:7, rma_los:4, rma_nlos:8, rma_los_nlos:6.5 };
const CLUTTER_DB = { dense_urban:0, metropolitan:0, urban:0, suburban:1, sub_urban:1, rural:0.5, open:0, industrial:2, forest:3, water:-1, highway:-1.5, 'n/a':0 };

function getP() {
  const n = (id, d) => { const e = document.getElementById(id); if (!e) return d; const v = parseFloat(e.value); return isFinite(v) ? v : d; };
  const s = (id, d) => document.getElementById(id)?.value || d;
  const bw = n('bsoGap', 20), bwHz = bw * 1e6, nf = 7, tn = -174 + 10 * Math.log10(bwHz) + nf;
  return {
    TX_POWER: n('txGap', 46), FREQUENCY: n('freqGap', 2300),
    BANDWIDTH: bw, NF: nf, ANTENNA_Am: 25, BEAMWIDTH: 35,
    SCENARIO: s('scenarioGap','uma'), CONDITION: s('conditionGap','nlos'), CLUTTER: s('clutterGap','urban'),
    THERMAL_NOISE_LIN: Math.pow(10, tn / 10), SINR_FLOOR: -10, SINR_CEIL: 40,
  };
}
function getClutterLoss(n) {
  const k = (n||'n/a').toLowerCase().replace(/[\s-]+/g,'_');
  if (CLUTTER_DB[k] !== undefined) return CLUTTER_DB[k];
  for (const [key, v] of Object.entries(CLUTTER_DB)) if (k.includes(key)||key.includes(k)) return v;
  return 0;
}
function getShadowStd(sc, cond) { return SHADOW_STD[`${sc}_${cond}`] || 6; }
function dbm2lin(d) { return Math.pow(10, d/10); }
function lin2dbm(m) { return 10 * Math.log10(Math.max(m, 1e-15)); }

// ── Path loss TR 38.901 ───────────────────────────
function pathLoss(sc, cond, dist_m, fMhz, hBS, hUT) {
  const d = Math.max(dist_m,10), hU = hUT||MOBILE_H, fc = fMhz/1000, c = 3e8;
  const d3D = Math.sqrt(d*d+(hBS-hU)**2);
  switch(sc) {
    case 'uma': { const hE=1, dBP=4*(hBS-hE)*(hU-hE)*fMhz*1e6/c;
      const plos = d<=dBP ? 28+22*Math.log10(d3D)+20*Math.log10(fc) : 28+40*Math.log10(d3D)+20*Math.log10(fc)-9*Math.log10(dBP**2+(hBS-hU)**2);
      if(cond==='los') return plos;
      const pnlos = Math.max(13.54+39.08*Math.log10(d3D)+20*Math.log10(fc)-0.6*(hU-1.5), plos);
      if(cond==='nlos') return pnlos;
      const p=(d<=18?1:(18/d+Math.exp(-d/63)*(1-18/d))*(1+(hU>13?Math.pow((hU-13)/10,1.5):0)*(5/4)*Math.pow(d/100,3)*Math.exp(-d/150)));
      return p*plos+(1-p)*pnlos; }
    case 'umi': { const hE=1, dBP=4*(hBS-hE)*(hU-hE)*fMhz*1e6/c;
      const plos = d<=dBP ? 32.4+21*Math.log10(d3D)+20*Math.log10(fc) : 32.4+40*Math.log10(d3D)+20*Math.log10(fc)-9.5*Math.log10(dBP**2+(hBS-hU)**2);
      if(cond==='los') return plos;
      const pnlos = Math.max(22.4+35.3*Math.log10(d3D)+21.3*Math.log10(fc)-0.3*(hU-1.5), plos);
      if(cond==='nlos') return pnlos;
      const p=(d<=18?1:18/d+Math.exp(-d/36)*(1-18/d)); return p*plos+(1-p)*pnlos; }
    case 'rma': { const h=5, W=20, dBP=2*Math.PI*hBS*hU*fMhz*1e6/c;
      const A1=Math.min(0.03*Math.pow(h,1.72),10), A2=Math.min(0.044*Math.pow(h,1.72),14.77), A3=0.002*Math.log10(h);
      const plos = d<=dBP ? 20*Math.log10(40*Math.PI*d3D*fc/3)+A1*Math.log10(d3D)-A2+A3*d3D
        : (()=>{ const d3DBP=Math.sqrt(dBP**2+(hBS-hU)**2); return 20*Math.log10(40*Math.PI*d3DBP*fc/3)+A1*Math.log10(d3DBP)-A2+A3*d3DBP+40*Math.log10(d3D/d3DBP); })();
      if(cond==='los') return plos;
      return Math.max(161.04-7.1*Math.log10(W)+7.5*Math.log10(h)-(24.37-3.7*(h/hBS)**2)*Math.log10(hBS)+(43.42-3.1*Math.log10(hBS))*(Math.log10(d3D)-3)+20*Math.log10(fc)-(3.2*(Math.log10(11.75*hU))**2-4.97), plos); }
    default: return 28+22*Math.log10(d3D)+20*Math.log10(fc);
  }
}
function antennaGain(off, bw, Am) { return -Math.min(12*(off/(bw/2))**2, Am); }
function bestGain(brng, sectors, bw, Am) {
  if (!sectors?.length) return 0;
  let best = -Infinity;
  sectors.forEach(az => { const g = antennaGain(Math.abs(((brng-az+540)%360)-180), bw, Am); if (g>best) best=g; });
  return best;
}
const SGSIZE = 0.0005;
function hashInt(n) { n=((n>>>16)^n)*0x45d9f3b; n=((n>>>16)^n)*0x45d9f3b; return ((n>>>16)^n)>>>0; }
function spatialNoise(lat, lng, std, sid) {
  let seed=0; for(let i=0;i<sid.length;i++) seed=(seed*17+sid.charCodeAt(i))&0xffff;
  const cL=Math.round(lat/SGSIZE), cG=Math.round(lng/SGSIZE);
  const s1=hashInt(cL*73856093^cG*19349663^seed), s2=hashInt(s1+2654435761);
  const u1=(s1>>>0)/4294967296+1e-10, u2=(s2>>>0)/4294967296+1e-10;
  return Math.max(-2*std, Math.min(2*std, Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2)*std));
}
function computeRSRP(dist, gainDb, hBS, sc, cond, lat, lon, sid, clutter, P) {
  return P.TX_POWER + gainDb - pathLoss(sc, cond, dist, P.FREQUENCY, hBS, MOBILE_H) - getClutterLoss(clutter) + spatialNoise(lat, lon, getShadowStd(sc, cond), sid);
}

// ─────────────────────────────────────────────────
// FIX #1: Hitung SINR yang benar dengan interferensi
// SINR = S / (I_existing + I_new + N)
// S    = daya serving cell (site dengan RSRP tertinggi)
// I    = jumlah daya semua interferer (selain serving)
// N    = thermal noise
// ─────────────────────────────────────────────────
function computeSINR(servingRSRP_dbm, allRSRP_dbm_list, P) {
  const serving_lin = dbm2lin(servingRSRP_dbm);

  // Kumpulkan semua interferer (selain serving cell)
  let interference_lin = 0;
  allRSRP_dbm_list.forEach(rsrp => {
    if (rsrp === servingRSRP_dbm) return; // skip serving
    // Hanya hitung interferer yang tidak terlalu lemah (dominance threshold)
    if (servingRSRP_dbm - rsrp < DOMINANT_THRESHOLD_DB) {
      interference_lin += dbm2lin(rsrp) * IM_FACTOR;
    }
  });

  const sinr_lin = serving_lin / (interference_lin + P.THERMAL_NOISE_LIN);
  return Math.max(P.SINR_FLOOR, Math.min(P.SINR_CEIL, lin2dbm(sinr_lin)));
}

// ── Color & category ──────────────────────────────
function getRSRPColor(v) { if(v>=-85)return'#0042a5';if(v>=-95)return'#00a955';if(v>=-105)return'#70ff66';if(v>=-120)return'#fffb00';if(v>=-140)return'#ff3333';return'#800000'; }
function getSINRColor(v) { if(v>=20)return'#0042a5';if(v>=10)return'#00a955';if(v>=0)return'#70ff66';if(v>=-5)return'#fffb00';if(v>=-10)return'#ff3333';return'#800000'; }
function getRSRPC(v)  { if(v>=-85)return'S1';if(v>=-95)return'S2';if(v>=-105)return'S3';if(v>=-120)return'S4';if(v>=-140)return'S5';return'S6'; }
function getSINRC(v)  { if(v>=20)return'S1';if(v>=10)return'S2';if(v>=0)return'S3';if(v>=-5)return'S4';if(v>=-10)return'S5';return'S6'; }
function catName(c)   { return {S1:'Excellent',S2:'Good',S3:'Moderate',S4:'Poor',S5:'Bad',S6:'Very Bad'}[c]||'Unknown'; }
const getColor = (metric, v) => metric==='rsrp' ? getRSRPColor(v) : getSINRColor(v);
const getCat   = (metric, v) => metric==='rsrp' ? getRSRPC(v)     : getSINRC(v);

// ── Geo utils ─────────────────────────────────────
function destPt(lat, lng, az, dist) {
  const R=6378137, b=az*Math.PI/180, d=dist/R;
  const la1=lat*Math.PI/180, lo1=lng*Math.PI/180;
  const la2=Math.asin(Math.sin(la1)*Math.cos(d)+Math.cos(la1)*Math.sin(d)*Math.cos(b));
  const lo2=lo1+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la1),Math.cos(d)-Math.sin(la1)*Math.sin(la2));
  return { lat:la2*180/Math.PI, lng:lo2*180/Math.PI };
}
function calcDist(a, b) {
  const R=6378137, dLa=(b.lat-a.lat)*Math.PI/180, dLo=(b.lng-a.lng)*Math.PI/180;
  const x=Math.sin(dLa/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLo/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function bearing(la1, lo1, la2, lo2) {
  const p1=la1*Math.PI/180, p2=la2*Math.PI/180, dl=(lo2-lo1)*Math.PI/180;
  return (Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360;
}

// ── INIT ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMaps();
  attachEvents();
  generateAzimuthInputs();
  loadSessionData();
  updateBadges();
});

function initMaps() {
  const tile = { attribution:'© OpenStreetMap', maxZoom:19 };
  const ctr  = [-6.2088, 106.8456];
  mapBefore  = L.map('bsoMapBefore').setView(ctr, 14);
  mapAfter   = L.map('bsoMapAfter').setView(ctr, 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', tile).addTo(mapBefore);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', tile).addTo(mapAfter);
  let syncing = false;
  const sync = (src, dst) => src.on('move', () => { if(syncing) return; syncing=true; dst.setView(src.getCenter(),src.getZoom(),{animate:false}); syncing=false; });
  sync(mapBefore, mapAfter); sync(mapAfter, mapBefore);
  mapAfter.on('click', e => {
    document.getElementById('latSite').value = e.latlng.lat.toFixed(6);
    document.getElementById('lngSite').value = e.latlng.lng.toFixed(6);
    currentSiteLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
    placeSiteMarker(e.latlng.lat, e.latlng.lng);
  });
}

function attachEvents() {
  document.getElementById('btnSetSiteLoc')?.addEventListener('click', setSiteFromInput);
  document.getElementById('btnClearBSO')?.addEventListener('click', () => { if(confirm('Reset halaman?')) location.reload(); });
  document.getElementById('btnRunBSO')?.addEventListener('click', runOptimization);
  document.getElementById('sectorCountGap')?.addEventListener('change', function() { sectorCount=parseInt(this.value); generateAzimuthInputs(); updateBadges(); });
  document.getElementById('btnRSRPGap')?.addEventListener('click', () => setViz('rsrp'));
  document.getElementById('btnSINRGap')?.addEventListener('click', () => setViz('sinr'));
  ['txGap','freqGap','bsoGap','gridGap','radiusGap','antennaGap','scenarioGap','conditionGap','clutterGap'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => updateBadges());
  });
  document.getElementById('antennaGap')?.addEventListener('input', () => updateBadges());
}

function updateBadges() {
  const set = (id, v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  const P = getP();
  set('bBadgeSector', (document.getElementById('sectorCountGap')?.value||3) + ' Sek');
  set('bBadgeH',      (document.getElementById('antennaGap')?.value||30) + 'm');
  set('bBadgeGrid',   (document.getElementById('gridGap')?.value||50) + 'm');
  set('bBadgeRadius', (document.getElementById('radiusGap')?.value||300) + 'm');
  set('bBadgeSc',     P.SCENARIO.toUpperCase() + ' ' + P.CONDITION.toUpperCase());
  set('bBadgeClutter', P.CLUTTER.charAt(0).toUpperCase()+P.CLUTTER.slice(1));
  set('bBadgeTx',     P.TX_POWER + ' dBm');
  set('bBadgeFreq',   P.FREQUENCY + ' MHz');
}

// ── Session ────────────────────────────────────────
function loadSessionData() {
  const savedGap  = sessionStorage.getItem(GAP_PLANNING_KEY);
  const savedSnap = sessionStorage.getItem(CV_PLANNING_KEY);
  if (!savedGap || !savedSnap) { showNoSessionState(); return; }
  try {
    gapData         = JSON.parse(savedGap);
    clusterSnapshot = JSON.parse(savedSnap);
    prefillFromSession();
    renderExistingMarkers();
    renderBeforeMap();
    showGapInfo();
  } catch(e) { console.error('[BSO]', e); showNoSessionState(); }
}

function showNoSessionState() {
  const el = document.getElementById('bsoGapInfo');
  if (el) el.innerHTML = `<div class="bso-alert warn"><i class="fas fa-exclamation-triangle"></i><div><b>Tidak ada data gap dari halaman coverage.</b><br>Kembali ke halaman coverage dan klik blank spot untuk memulai.</div></div>`;
}

function prefillFromSession() {
  if (!gapData) return;
  const set = (id, v) => { const e=document.getElementById(id); if(e&&v!=null) e.value=v; };
  set('latSite', gapData.recommendedLat?.toFixed(6));
  set('lngSite', gapData.recommendedLng?.toFixed(6));
  set('antennaGap', gapData.nearestSiteHeight || 30);
  set('radiusGap', Math.min(Math.max(Math.round((gapData.estimatedRadius_m||300)*1.2/50)*50, 100), 600));
  gapCenterLat = gapData.recommendedLat;
  gapCenterLng = gapData.recommendedLng;
  gapRadiusM   = gapData.estimatedRadius_m || 300;
  if (clusterSnapshot?.params) {
    const p = clusterSnapshot.params;
    set('txGap', p.TX_POWER); set('freqGap', p.FREQUENCY); set('bsoGap', p.BANDWIDTH);
    set('scenarioGap', p.SCENARIO); set('conditionGap', p.CONDITION); set('clutterGap', p.CLUTTER);
    if (clusterSnapshot.gridSize) set('gridGap', clusterSnapshot.gridSize);
  }
  if (gapData.recommendedLat && gapData.recommendedLng) {
    currentSiteLocation = { lat: gapData.recommendedLat, lng: gapData.recommendedLng };
    placeSiteMarker(gapData.recommendedLat, gapData.recommendedLng);
  }
}

function showGapInfo() {
  if (!gapData) return;
  const el = document.getElementById('bsoGapInfo');
  if (!el) return;
  const isBlank = gapData.gapType === 'blank_spot';
  const tc = isBlank ? '#c0392b' : '#d68910';
  el.innerHTML = `
    <div class="bso-gap-card" style="border-left-color:${tc}">
      <div class="bso-gap-header">
        <span style="color:${tc};font-weight:700;">${isBlank ? '🚫 Blank Spot' : '⚠️ Weak Coverage'} #${gapData.gapIndex||1}</span>
        <span class="bso-severity-badge">${gapData.severityLabel||'Kritis'}</span>
      </div>
      <div class="bso-gap-meta">
        <div><span class="bso-meta-label">Avg SS-RSRP</span><span class="bso-meta-val" style="color:${tc}">${gapData.avgRSRP_dBm!=null?gapData.avgRSRP_dBm+' dBm':'No signal'}</span></div>
        <div><span class="bso-meta-label">Luas</span><span class="bso-meta-val">${gapData.areaSqKm||'?'} km²</span></div>
        <div><span class="bso-meta-label">Radius</span><span class="bso-meta-val">~${gapData.estimatedRadius_m||'?'} m</span></div>
        <div><span class="bso-meta-label">Site Terdekat</span><span class="bso-meta-val" style="color:#1F3C88;font-weight:700">${gapData.nearestSiteId||'?'}</span></div>
      </div>
      <p class="bso-gap-note">📍 Perbandingan Before/After pada grid yang sama (denominator konsisten).</p>
    </div>`;
}

function renderExistingMarkers() {
  if (!clusterSnapshot) return;
  [mapBefore, mapAfter].forEach(m => {
    if (clusterSnapshot.mainSite) {
      L.circleMarker([clusterSnapshot.mainSite.lat, clusterSnapshot.mainSite.lng],
        { radius:7, fillColor:'#ffd000', color:'#000', weight:1.5, fillOpacity:1 })
        .bindTooltip((clusterSnapshot.mainSiteId||'Main') + ' (main)').addTo(m);
    }
    (clusterSnapshot.neighbours||[]).forEach(n => {
      L.circleMarker([n.lat, n.lng], { radius:5, fillColor:'#aab8d8', color:'#556', weight:1, fillOpacity:0.85 })
        .bindTooltip(n.id).addTo(m);
    });
  });
  if (gapCenterLat && gapCenterLng) {
    [mapBefore, mapAfter].forEach(m => {
      L.circleMarker([gapCenterLat, gapCenterLng], { radius:10, fillColor:'#ff3b30', color:'#fff', weight:2.5, fillOpacity:0.7 })
        .bindTooltip('📍 Target Gap').addTo(m);
      L.circle([gapCenterLat, gapCenterLng], { radius:gapRadiusM, color:'#ff3b30', fillColor:'#ff3b30', fillOpacity:0.05, weight:2, dashArray:'6 4' }).addTo(m);
    });
    mapBefore.setView([gapCenterLat, gapCenterLng], 15);
  }
}

function renderBeforeMap() {
  if (!clusterSnapshot?.grids?.length) return;
  if (beforeLayerGroup) { mapBefore.removeLayer(beforeLayerGroup); }
  beforeLayerGroup = L.layerGroup().addTo(mapBefore);
  const metric = currentCoverageType;
  gapGridsBefore = clusterSnapshot.grids;
  gapGridsBefore.forEach(g => {
    const val = metric==='rsrp' ? g.rsrpValue : (g.sinrValue ?? g.rsrpValue);
    const v   = Math.round(val*10)/10;
    const color = getColor(metric, v);
    L.polygon(g.bounds, { color, fillColor:color, fillOpacity:0.72, weight:0 })
      .bindPopup(`<b>${metric.toUpperCase()}: ${v} ${metric==='rsrp'?'dBm':'dB'}</b><br>SS-RSRP: ${g.rsrpValue.toFixed(1)} dBm`)
      .addTo(beforeLayerGroup);
  });
  updateLegend('before', gapGridsBefore);
  updateMiniStats('before', gapGridsBefore);
}

function setSiteFromInput() {
  const lat = parseFloat(document.getElementById('latSite').value);
  const lng = parseFloat(document.getElementById('lngSite').value);
  if (!isFinite(lat)||!isFinite(lng)) { alert('Koordinat tidak valid'); return; }
  currentSiteLocation = { lat, lng };
  placeSiteMarker(lat, lng);
}

function placeSiteMarker(lat, lng) {
  if (siteMarkerAfter) mapAfter.removeLayer(siteMarkerAfter);
  const icon = L.divIcon({ className:'', html:'<div class="bso-site-pin"></div>', iconSize:[24,24], iconAnchor:[12,24] });
  siteMarkerAfter = L.marker([lat, lng], { icon, draggable:true }).addTo(mapAfter);
  siteMarkerAfter.bindPopup(`<b>📡 Site Baru</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}`).openPopup();
  siteMarkerAfter.on('dragend', e => {
    const p = e.target.getLatLng();
    document.getElementById('latSite').value = p.lat.toFixed(6);
    document.getElementById('lngSite').value = p.lng.toFixed(6);
    currentSiteLocation = { lat:p.lat, lng:p.lng };
  });
  document.getElementById('bsoSiteLocInfo').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function generateAzimuthInputs() {
  const container = document.getElementById('azimuthsGap');
  if (!container) return;
  container.innerHTML = '';
  const step = 360 / sectorCount;
  for (let i = 0; i < sectorCount; i++) {
    const defaultAz = Math.round(i * step);
    const color = SECTOR_COLORS[i % SECTOR_COLORS.length];
    const grp = document.createElement('div');
    grp.className = 'bso-az-group';
    grp.innerHTML = `<label><span class="bso-dot" style="background:${color}"></span>Sek ${i+1}</label><input type="number" id="gaz${i}" value="${defaultAz}" min="0" max="359" step="1">`;
    container.appendChild(grp);
  }
  if (gapCenterLat && gapCenterLng && currentSiteLocation) {
    const brng = bearing(currentSiteLocation.lat, currentSiteLocation.lng, gapCenterLat, gapCenterLng);
    for (let i = 0; i < sectorCount; i++) {
      const el = document.getElementById('gaz'+i);
      if (el) el.value = Math.round((brng + (360/sectorCount)*i) % 360);
    }
  }
}
function getAzimuths() { return Array.from({length:sectorCount},(_,i)=>{ const v=parseFloat(document.getElementById('gaz'+i)?.value); return isFinite(v)?v:0; }); }

function setViz(type) {
  currentCoverageType = type;
  document.getElementById('btnRSRPGap')?.classList.toggle('active', type==='rsrp');
  document.getElementById('btnSINRGap')?.classList.toggle('active', type==='sinr');
  renderBeforeMap();
  if (gapGridsAfter.length) renderAfterMap(gapGridsAfter);
}

// ── RUN OPTIMIZATION ──────────────────────────────
function runOptimization() {
  if (!currentSiteLocation) { alert('Tentukan lokasi site baru terlebih dahulu!'); return; }
  showLoading('Menghitung optimalisasi coverage...');
  setTimeout(() => {
    try {
      const P        = getP();
      const gridSize = parseInt(document.getElementById('gridGap')?.value) || 50;
      const radius   = parseInt(document.getElementById('radiusGap')?.value) || 300;
      const antennaH = parseInt(document.getElementById('antennaGap')?.value) || 30;
      azimuths = getAzimuths();

      // Step 1: Hitung RSRP site baru per grid
      const newSiteRSRP = computeNewSiteRSRP(P, gridSize, radius, antennaH);

      // FIX #2: Step 2: Overlay dan hitung ulang SINR dengan benar
      gapGridsAfter = overlayGridsWithSINR(gapGridsBefore, newSiteRSRP, P);

      renderAfterMap(gapGridsAfter);
      renderSectorFans();

      // FIX #3: Delta panel pakai denominator konsisten (hanya grid overlap)
      renderDeltaPanel(gapGridsBefore, gapGridsAfter);
      hideLoading();
    } catch(err) { console.error('[BSO]', err); hideLoading(); alert('Error: '+err.message); }
  }, 200);
}

// ─────────────────────────────────────────────────
// FIX #1: Hitung RSRP site baru, return sebagai Map
// key = "lat_lon" rounded ke gridSize
// ─────────────────────────────────────────────────
function computeNewSiteRSRP(P, gridSize, radius, antennaH) {
  const lat0 = currentSiteLocation.lat, lng0 = currentSiteLocation.lng;
  const mpdLat = 111320;
  const mpdLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  const dLat = gridSize / mpdLat;
  const dLon = gridSize / mpdLon;
  const minLat = lat0 - radius / mpdLat, maxLat = lat0 + radius / mpdLat;
  const minLon = lng0 - radius / mpdLon, maxLon = lng0 + radius / mpdLon;
  const rsrpMap = new Map();

  for (let lat = minLat; lat <= maxLat; lat += dLat) {
    for (let lon = minLon; lon <= maxLon; lon += dLon) {
      const dist = calcDist({ lat: lat0, lng: lng0 }, { lat, lng: lon });
      if (dist > radius) continue;
      const brng   = bearing(lat0, lng0, lat, lon);
      const gainDb = bestGain(brng, azimuths, P.BEAMWIDTH, P.ANTENNA_Am);
      const rsrp   = computeRSRP(dist, gainDb, antennaH, P.SCENARIO, P.CONDITION, lat, lon, 'SITE_BARU', P.CLUTTER, P);
      const rsrpC  = Math.max(RX_FLOOR, rsrp);

      // KEY: gunakan index integer dari lat dan lon masing-masing
      const iLat = Math.round(lat / dLat);
      const iLon = Math.round(lon / dLon);
      const key  = `${iLat},${iLon}`;

      // Simpan juga bounds grid untuk render
      const half_lat = dLat / 2;
      const half_lon = dLon / 2;
      rsrpMap.set(key, {
        rsrp: rsrpC,
        lat, lon,
        bounds: [
          [lat - half_lat, lon - half_lon],
          [lat - half_lat, lon + half_lon],
          [lat + half_lat, lon + half_lon],
          [lat + half_lat, lon - half_lon],
        ]
      });
    }
  }

  console.log('[BSO] newSiteRSRP size:', rsrpMap.size);
  return rsrpMap;
}

// ─────────────────────────────────────────────────
// FIX #2: Overlay grid + hitung ulang SINR yang benar
// Alur per grid:
//   1. Cek apakah site baru punya sinyal di grid ini
//   2. Tentukan serving cell = site dengan RSRP tertinggi
//   3. Hitung SINR = serving / (semua interferer + noise)
//   4. Hanya update grid yang sudah ada di before (denominator konsisten)
// ─────────────────────────────────────────────────
function overlayGridsWithSINR(beforeGrids, newSiteRSRP, P) {
  const gridSize = parseInt(document.getElementById('gridGap')?.value) || 50;
  const mpdLat   = 111320;
  const mpdLon   = 111320 * Math.cos(currentSiteLocation.lat * Math.PI / 180);
  const dLat     = gridSize / mpdLat;
  const dLon     = gridSize / mpdLon;

  const beforeKeys = new Set();

  // Update grid existing
  const updatedGrids = beforeGrids.map(g => {
    const gridCopy = { ...g };
    const gLat = g.lat;
    const gLon = g.lon ?? g.lng;
    const iLat = Math.round(gLat / dLat);
    const iLon = Math.round(gLon / dLon);
    const key  = `${iLat},${iLon}`;
    beforeKeys.add(key);

    const entry   = newSiteRSRP.get(key);
    const newRSRP = entry?.rsrp;

    const allSignals = [];
    allSignals.push(g.rsrpValue);
    if (g.sinrValue !== undefined) {
      const serving_lin      = dbm2lin(g.rsrpValue);
      const sinr_lin         = Math.pow(10, g.sinrValue / 10);
      const interference_lin = Math.max(0, serving_lin / sinr_lin - P.THERMAL_NOISE_LIN);
      if (interference_lin > 0) allSignals.push(lin2dbm(interference_lin / IM_FACTOR));
    }

    if (newRSRP !== undefined) {
      allSignals.push(newRSRP);
      if (newRSRP > g.rsrpValue) {
        gridCopy.rsrpValue    = newRSRP;
        gridCopy.servingSiteId = 'SITE_BARU';
      }
      gridCopy.sinrValue = computeSINR(gridCopy.rsrpValue, allSignals, P);
    } else {
      if (g.sinrValue === undefined) {
        gridCopy.sinrValue = computeSINR(g.rsrpValue, allSignals, P);
      }
    }

    return gridCopy;
  });

  // Tambah grid BARU dari site baru yang tidak overlap dengan before
  let newGridCount = 0;
  newSiteRSRP.forEach((entry, key) => {
    if (beforeKeys.has(key)) return;
    const sinrValue = computeSINR(entry.rsrp, [entry.rsrp], P);
    updatedGrids.push({
      lat: entry.lat,
      lon: entry.lon,
      lng: entry.lon,
      bounds: entry.bounds,
      rsrpValue: entry.rsrp,
      sinrValue,
      servingSiteId: 'SITE_BARU',
      _isNew: true,
    });
    newGridCount++;
  });

  console.log('[BSO] before grids:', beforeGrids.length, '| new grids added:', newGridCount, '| total after:', updatedGrids.length);
  return updatedGrids;
}

function renderAfterMap(grids) {
  mapAfter.eachLayer(l => { if(l._bsoAfter) mapAfter.removeLayer(l); });
  const metric=currentCoverageType;
  grids.forEach(g => {
    const val=metric==='rsrp'?g.rsrpValue:(g.sinrValue??g.rsrpValue);
    const v=Math.round(val*10)/10;
    const color=getColor(metric,v);
    const poly=L.polygon(g.bounds,{color,fillColor:color,fillOpacity:0.72,weight:0})
      .bindPopup(`<b>${metric.toUpperCase()}: ${v} ${metric==='rsrp'?'dBm':'dB'}</b><br>${g.servingSiteId==='SITE_BARU'?'📡 Site Baru':'🗼 Existing'}`)
      .addTo(mapAfter);
    poly._bsoAfter=true;
  });
  updateLegend('after', grids);
  updateMiniStats('after', grids);
}

function renderSectorFans() {
  const P=getP();
  mapAfter.eachLayer(l => { if(l._bsoFan) mapAfter.removeLayer(l); });
  azimuths.forEach((az,idx) => {
    const pts=[[currentSiteLocation.lat,currentSiteLocation.lng]];
    for(let i=0;i<=20;i++) { const a=(az-P.BEAMWIDTH/2)+(i/20)*P.BEAMWIDTH; const p=destPt(currentSiteLocation.lat,currentSiteLocation.lng,a,200); pts.push([p.lat,p.lng]); }
    pts.push([currentSiteLocation.lat,currentSiteLocation.lng]);
    const color=SECTOR_COLORS[idx%SECTOR_COLORS.length];
    const fan=L.polygon(pts,{color,fillColor:color,fillOpacity:0.15,weight:2,opacity:0.7}).addTo(mapAfter);
    fan._bsoFan=true;
  });
}

// ─────────────────────────────────────────────────
// FIX #3: Delta panel — denominator KONSISTEN
// before.length === after.length karena after hanya
// update grid existing, tidak tambah grid baru
// ─────────────────────────────────────────────────
function renderDeltaPanel(before, after) {
  const gridSize = parseInt(document.getElementById('gridGap')?.value) || 50;
  const afterForStats = after.filter(g => !g._isNew); // denominator konsisten
  const bStats = calcStats(before);
  const aStats = calcStats(afterForStats);
  const gridKm2 = (gridSize / 1000) ** 2;
  const total = before.length || 1;

  const verdict = calcVerdict(bStats, aStats, total);

  const blankBefore = ((bStats.cats.S5||0) + (bStats.cats.S6||0)) * gridKm2;
  const blankAfter  = ((aStats.cats.S5||0) + (aStats.cats.S6||0)) * gridKm2;
  const blankDelta  = blankBefore - blankAfter;

  // S1+S2+S3 untuk perbandingan utama
  const s123B = ((bStats.cats.S1||0) + (bStats.cats.S2||0) + (bStats.cats.S3||0)) / total * 100;
  const s123A = ((aStats.cats.S1||0) + (aStats.cats.S2||0) + (aStats.cats.S3||0)) / total * 100;
  const s123D = s123A - s123B;
  const sign = d => d >= 0 ? '+' : '';

  let verdictHtml;
  if (verdict.anyImprovement && s123D > 20) {
    verdictHtml = `<div class="bso-verdict good">✅ <b>Optimalisasi Berhasil</b> — Coverage layak naik <b>${sign(s123D)}${s123D.toFixed(1)}%</b></div>`;
  } else if (verdict.anyImprovement) {
    verdictHtml = `<div class="bso-verdict ok">⚠️ <b>Ada Peningkatan</b> — Coverage membaik. Coba geser lokasi atau naikkan tinggi antena untuk hasil lebih optimal.</div>`;
  } else {
    verdictHtml = `<div class="bso-verdict bad">🔴 <b>Tidak Ada Peningkatan</b> — Pertimbangkan lokasi atau parameter berbeda.</div>`;
  }

  const el = document.getElementById('bsoDeltaPanel');
  if (!el) return;
  el.innerHTML = `
    ${verdictHtml}
    <div class="bso-delta-grid">
      <div class="bso-delta-box gain">
        <span class="bso-dv">${sign(s123D)}${s123D.toFixed(1)}%</span>
        <span class="bso-dl">Δ Coverage Layak (S1+S2+S3)</span>
      </div>
      <div class="bso-delta-box blank">
        <span class="bso-dv">${blankDelta >= 0 ? '-' : '+'}${Math.abs(blankDelta).toFixed(3)} km²</span>
        <span class="bso-dl">Blank Spot Berkurang</span>
      </div>
    </div>
    <div class="bso-compare-table">
      <table>
        <thead><tr><th>Kategori</th><th>Before</th><th>After</th><th>Δ</th></tr></thead>
        <tbody>
          ${['S1','S2','S3','S4','S5'].map(cat => {
            const b = ((bStats.cats[cat]||0) / total * 100).toFixed(1);
            const a = ((aStats.cats[cat]||0) / total * 100).toFixed(1);
            const d = (parseFloat(a) - parseFloat(b)).toFixed(1);
            const cls = parseFloat(d) > 0.5 ? 'pos' : parseFloat(d) < -0.5 ? 'neg' : 'neu';
            const labels = { S1:'Excellent (≥-85)', S2:'Good (-95~-85)', S3:'Moderate (-105~-95)', S4:'Poor (-120~-105)', S5:'Bad/Blank (<-120)' };
            return `<tr><td>${labels[cat]}</td><td>${b}%</td><td class="col-after">${a}%</td><td class="${cls}">${parseFloat(d)>0?'+':''}${d}%</td></tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p style="font-size:10.5px;color:#888;margin:8px 0 0;">📊 Denominator: <b>${total} grid (konsisten before & after)</b></p>`;
  el.style.display = 'block';
}

function calcVerdict(bStats, aStats, total) {
  const goodCats = ['S1', 'S2', 'S3']; // S3 = Moderate = layak
  const badCats  = ['S4', 'S5', 'S6'];
  let totalGoodImprovement = 0, totalBadReduction = 0, anyImprovement = false;
  goodCats.forEach(c => {
    const b = (bStats.cats[c]||0) / total * 100;
    const a = (aStats.cats[c]||0) / total * 100;
    if (a - b > 0.5) { totalGoodImprovement += (a - b); anyImprovement = true; }
  });
  badCats.forEach(c => {
    const b = (bStats.cats[c]||0) / total * 100;
    const a = (aStats.cats[c]||0) / total * 100;
    if (b - a > 0.5) { totalBadReduction += (b - a); anyImprovement = true; }
  });
  const s123Delta = (
    ((aStats.cats.S1||0) + (aStats.cats.S2||0) + (aStats.cats.S3||0)) -
    ((bStats.cats.S1||0) + (bStats.cats.S2||0) + (bStats.cats.S3||0))
  ) / total * 100;
  return { anyImprovement, totalGoodImprovement, totalBadReduction, s1Delta: s123Delta };
}

function calcStats(grids) {
  const cats={}, metric=currentCoverageType;
  grids.forEach(g => {
    const val=metric==='rsrp'?g.rsrpValue:(g.sinrValue??g.rsrpValue);
    const cat=getCat(metric,val);
    cats[cat]=(cats[cat]||0)+1;
  });
  return { cats, total:grids.length };
}
function updateMiniStats(which, grids) {
  const el=document.getElementById(which==='before'?'bsoBeforeStats':'bsoAfterStats');
  if (!el) return;
  const stats=calcStats(grids);
  const color=which==='before'?'#ff6b6b':'#34c759';
  el.innerHTML=renderMiniStatHTML(stats, which==='before'?'Before':'After', color);
}
function renderMiniStatHTML(stats, label, color) {
  const total = stats.total || 1;
  const s123 = ((stats.cats.S1||0) + (stats.cats.S2||0) + (stats.cats.S3||0)) / total * 100;
  return `<div class="bso-mini-stat" style="border-left-color:${color}"><span class="bso-ms-label">${label}</span><span class="bso-ms-val">${s123.toFixed(1)}%</span><span class="bso-ms-sub">S1+S2+S3 (${stats.total} grid)</span></div>`;
}

function updateLegend(which, grids) {
  const elId  = which === 'before' ? 'bsoLegendBefore' : 'bsoLegendAfter';
  const el    = document.getElementById(elId);
  const tbody = document.getElementById(elId + 'Body');
  if (!el || !tbody) return;
  el.style.display = 'block';
  el.querySelector('.bso-legend-title').textContent = currentCoverageType === 'rsrp' ? 'SS-RSRP (dBm)' : 'SS-SINR (dB)';
  const metric = currentCoverageType;
  const rows = metric === 'rsrp'
    ? [
        { cat:'S1', color:'#0042a5', range:'-85 ~ 0' },
        { cat:'S2', color:'#00a955', range:'-95 ~ -85' },
        { cat:'S3', color:'#70ff66', range:'-105 ~ -95' },
        { cat:'S4', color:'#fffb00', range:'-120 ~ -105' },
        { cat:'S5', color:'#ff3333', range:'-140 ~ -120' },   // fix: was "< -120"
      ]
    : [
        { cat:'S1', color:'#0042a5', range:'≥ 20 dB' },
        { cat:'S2', color:'#00a955', range:'10 ~ 20 dB' },
        { cat:'S3', color:'#70ff66', range:'0 ~ 10 dB' },
        { cat:'S4', color:'#fffb00', range:'-5 ~ 0 dB' },
        { cat:'S5', color:'#ff3333', range:'-10 ~ -5 dB' },   // fix: was "< -5"
      ];
  const total = grids.length || 1;
  tbody.innerHTML = rows.map(r => {
    const v = grids.filter(g => getCat(metric, metric==='rsrp' ? g.rsrpValue : (g.sinrValue ?? g.rsrpValue)) === r.cat).length;
    return `<tr><td><div style="width:12px;height:12px;background:${r.color};border-radius:2px;display:inline-block;"></div></td><td>${r.range}</td><td><b>${(v/total*100).toFixed(1)}%</b></td></tr>`;
  }).join('');
}

function showLoading(text) {
  hideLoading();
  const el=document.createElement('div');
  el.id='bsoLoading'; el.className='bso-loading-overlay';
  el.innerHTML=`<div class="bso-loading-box"><div class="bso-spinner"></div><p>${text}</p></div>`;
  document.body.appendChild(el);
}
function hideLoading() { document.getElementById('bsoLoading')?.remove(); }

console.log('blankspot.js v2.1 — SINR fix | Denominator konsisten | Interferensi proper');