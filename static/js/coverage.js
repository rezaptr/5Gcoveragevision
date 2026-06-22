'use strict';

let map;
let siteLayer, sectorLayer;
let buildingLayer    = null;
let buildingsVisible = false;
let siteIndex        = {};
let selectedSite     = null;
let coverageLayer    = null;
let gapLayer         = null;
let gapVisible       = true;
let currentCoverageType = 'rsrp';

const SESSION_KEY      = 'siteIndexData';
const GAP_PLANNING_KEY = 'gapPlanningData';
const CV_SESSION_KEY   = 'coverageExportData';
const CV_PLANNING_KEY  = 'coveragePlanningSnapshot'; // [FIX-5] snapshot untuk newsite.js
const PLANNING_PAGE    = '/blankspot';
const CV_PAGE          = '/coveragecom';

const SECTOR_COLORS      = ['#ff2d55','#00c7be','#ffcc00','#af52de','#ff9500','#34c759'];
const SITE_BORDER_COLORS = ['#ffffff','#ff6b6b','#4ecdc4','#ffe66d','#a29bfe','#fd79a8','#00b894'];

// ── Default & konstanta fisik ─────────────────────────────────────────────────
const PARAM_DEFAULTS = {
  TX_POWER  : 46,
  FREQUENCY : 2300,
  BANDWIDTH : 30,
  ANTENNA_Am: 25,
  BEAMWIDTH : 65,
  NF        : 7,
  SCENARIO  : 'uma',
  CONDITION : 'nlos',
  CLUTTER   : 'urban',
};

const MOBILE_H             = 1.5;
const RX_SENSITIVITY_FLOOR = -125.2;
const INTERFERENCE_MARGIN_DB = 2.0;

/**
 * [FIX-3] IM sebagai faktor pengali noise (dimensionless ratio).
 * Noise floor efektif = N_thermal_linear * INTERFERENCE_MARGIN_FACTOR
 * [3GPP TR 36.942 §A.1] — menaikkan noise floor sebesar 2 dB
 * JANGAN dijumlahkan langsung ke I dalam domain linear mW.
 */
const INTERFERENCE_MARGIN_FACTOR = Math.pow(10, INTERFERENCE_MARGIN_DB / 10);

/**
 * [FIX-4] Dominant interferer threshold [3GPP TR 36.942 §A.1]
 * Hanya sektor dengan RSRP > serving_RSRP - threshold yang dihitung
 * sebagai interferensi signifikan.
 * 20 dB: sektor 20 dB di bawah serving berkontribusi < 1% ke total I.
 */
const DOMINANT_INTERFERER_THRESHOLD_DB = 30;

// [FIX-1] Tambah key los_nlos — inline dengan simulation_dt.js v19.4
// Nilai identik dengan 'mixed' di sim_dt (dominan NLOS karena p_LOS
// sangat kecil pada jarak > 100m di dense/urban environment)
const SHADOW_STD_3GPP = {
  uma_los    : 4.0,
  uma_nlos   : 6.0,
  uma_los_nlos: 5.5,   // [FIX-1] ditambahkan — antara LOS dan NLOS, dominan NLOS
  umi_los    : 4.0,
  umi_nlos   : 7.82,
  umi_los_nlos: 7.0,   // [FIX-1] ditambahkan
  rma_los    : 4.0,
  rma_nlos   : 8.0,
  rma_los_nlos: 6.5,   // [FIX-1] ditambahkan
};

  const CLUTTER_LOSS_DB = {
    dense_urban: 0.0,   // dari 8.0 — sudah ter-cover di PL NLOS
    metropolitan: 0.0,  // dari 8.0
    urban: 0.0,         // dari 5.0
    suburban: 1.0,      // dari 2.5 — sedikit masih ok
    rural: 0.5,
    'n/a': 0.0,         // dari 3.0
  };

const GAP_CFG = {
  RSRP_WEAK:-105, RSRP_BLANK:-120,
  MIN_CLUSTER:3, CLUSTER_DIST_M:80, MAX_NEIGHBOURS:6,
};
const ORG = { AZIMUTH_WAVES:7, AZIMUTH_AMP:0.28, CORR_LENGTH_M:120, NOISE_OCTAVES:4 };

// ── Live param reader ─────────────────────────────────────────────────────────
function getParams() {
  const num = (id, def) => { const el = document.getElementById(id); if (!el) return def; const v = parseFloat(el.value); return isFinite(v) ? v : def; };
  const str = (id, def) => { const el = document.getElementById(id); return el?.value || def; };

  const bwMhz = num('rf_bandwidth', PARAM_DEFAULTS.BANDWIDTH);
  const nf    = PARAM_DEFAULTS.NF;
  const bwHz  = bwMhz * 1e6;
  const thermalNoise = -174 + 10 * Math.log10(bwHz) + nf;

  return {
    TX_POWER     : num('rf_txpower',   PARAM_DEFAULTS.TX_POWER),
    FREQUENCY    : num('rf_frequency', PARAM_DEFAULTS.FREQUENCY),
    BANDWIDTH    : bwMhz,
    BANDWIDTH_HZ : bwHz,
    NF           : nf,
    ANTENNA_Am   : PARAM_DEFAULTS.ANTENNA_Am,
    BEAMWIDTH    : PARAM_DEFAULTS.BEAMWIDTH,
    SCENARIO     : str('rf_scenario',  PARAM_DEFAULTS.SCENARIO),
    CONDITION    : str('rf_condition', PARAM_DEFAULTS.CONDITION),
    CLUTTER      : str('rf_clutter',   PARAM_DEFAULTS.CLUTTER),
    THERMAL_NOISE_DBM : thermalNoise,
    THERMAL_NOISE_LIN : Math.pow(10, thermalNoise / 10),  // [FIX-3] eksplisit linear
    SINR_FLOOR   : -10,
    SINR_CEIL    : 40,
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────
function getClutterLoss(name) {
  const key = (name||'n/a').toLowerCase().replace(/[\s-]+/g,'_');
  if (CLUTTER_LOSS_DB[key] !== undefined) return CLUTTER_LOSS_DB[key];
  for (const [k,v] of Object.entries(CLUTTER_LOSS_DB)) if (key.includes(k)||k.includes(key)) return v;
  return CLUTTER_LOSS_DB['n/a'];
}

// [FIX-1] getShadowStd sekarang bisa menemukan key los_nlos dengan benar
function getShadowStd(sc, cond) {
  return SHADOW_STD_3GPP[`${sc}_${cond}`] || 6.0;
}

function dbmToLinear(d) { return Math.pow(10, d/10); }
function linearToDbm(m) { return 10*Math.log10(Math.max(m,1e-15)); }

// ── Path loss TR 38.901 d3D + dBP ────────────────────────────────────────────
function pathLoss(scenario, condition, dist_m, freq_mhz, hBS, hUT) {
  const d=Math.max(dist_m,10), hU=hUT||MOBILE_H, fc=freq_mhz/1000, c=3e8;
  const d3D=Math.sqrt(d*d+(hBS-hU)**2);
  const pLOS_UMa=d2=>{if(d2<=18)return 1;const C=hU<=13?0:Math.pow((hU-13)/10,1.5);return(18/d2+Math.exp(-d2/63)*(1-18/d2))*(1+C*(5/4)*Math.pow(d2/100,3)*Math.exp(-d2/150));};
  const pLOS_UMi=d2=>d2<=18?1:18/d2+Math.exp(-d2/36)*(1-18/d2);
  switch(scenario){
    case 'uma':{
      const hE=1,dBP=4*(hBS-hE)*(hU-hE)*(freq_mhz*1e6)/c;
      const pl_los=d<=dBP?28+22*Math.log10(d3D)+20*Math.log10(fc):28+40*Math.log10(d3D)+20*Math.log10(fc)-9*Math.log10(dBP**2+(hBS-hU)**2);
      if(condition==='los')return pl_los;
      const pl_nlos=Math.max(13.54+39.08*Math.log10(d3D)+20*Math.log10(fc)-0.6*(hU-1.5),pl_los);
      if(condition==='nlos')return pl_nlos;
      // los_nlos: probabilistik p_LOS × PL_LOS + (1-p_LOS) × PL_NLOS
      const p=pLOS_UMa(d);return p*pl_los+(1-p)*pl_nlos;
    }
    case 'umi':{
      const hE=1,dBP=4*(hBS-hE)*(hU-hE)*(freq_mhz*1e6)/c;
      const pl_los=d<=dBP?32.4+21*Math.log10(d3D)+20*Math.log10(fc):32.4+40*Math.log10(d3D)+20*Math.log10(fc)-9.5*Math.log10(dBP**2+(hBS-hU)**2);
      if(condition==='los')return pl_los;
      const pl_nlos=Math.max(22.4+35.3*Math.log10(d3D)+21.3*Math.log10(fc)-0.3*(hU-1.5),pl_los);
      if(condition==='nlos')return pl_nlos;
      const p=pLOS_UMi(d);return p*pl_los+(1-p)*pl_nlos;
    }
    case 'rma':{
      const h=5,W=20,dBP=2*Math.PI*hBS*hU*(freq_mhz*1e6)/c;
      const A1=Math.min(0.03*Math.pow(h,1.72),10),A2=Math.min(0.044*Math.pow(h,1.72),14.77),A3=0.002*Math.log10(h);
      let pl_los;
      if(d<=dBP){pl_los=20*Math.log10(40*Math.PI*d3D*fc/3)+A1*Math.log10(d3D)-A2+A3*d3D;}
      else{const d3D_BP=Math.sqrt(dBP**2+(hBS-hU)**2);pl_los=20*Math.log10(40*Math.PI*d3D_BP*fc/3)+A1*Math.log10(d3D_BP)-A2+A3*d3D_BP+40*Math.log10(d3D/d3D_BP);}
      if(condition==='los')return pl_los;
      return Math.max(161.04-7.1*Math.log10(W)+7.5*Math.log10(h)-(24.37-3.7*(h/hBS)**2)*Math.log10(hBS)+(43.42-3.1*Math.log10(hBS))*(Math.log10(d3D)-3)+20*Math.log10(fc)-(3.2*(Math.log10(11.75*hU))**2-4.97),pl_los);
    }
    default:return 28+22*Math.log10(d3D)+20*Math.log10(fc);
  }
}

// ── Antenna gain TR 36.942 ────────────────────────────────────────────────────
function antennaGain(offset, bw, Am) { return -Math.min(12*(offset/(bw/2))**2, Am); }
function bestSectorGain(brng, sectors, bw, Am) {
  if(!sectors?.length)return{gain:0,sectorIdx:0};
  let best=-Infinity,idx=0;
  sectors.forEach((az,i)=>{const g=antennaGain(Math.abs(((brng-az+540)%360)-180),bw,Am);if(g>best){best=g;idx=i;}});
  return{gain:best,sectorIdx:idx};
}

// ── Shadow fading spatial hash ─────────────────────────────────────────────
const SPATIAL_GRID_SIZE=0.0005;
function hashInt(n){n=((n>>>16)^n)*0x45d9f3b;n=((n>>>16)^n)*0x45d9f3b;return((n>>>16)^n)>>>0;}

/**
 * [FIX-2] Tambah clamp ±2σ [ITU-R M.2135 §A.1]
 * Tanpa clamp, Box-Muller bisa menghasilkan outlier ±4σ atau lebih
 * yang tidak merepresentasikan distribusi log-normal realistis.
 * Seed per-site dipertahankan (berbeda dari sim_dt yang pakai fixed seed)
 * karena coverage adalah visualisasi area, bukan simulasi DT point-by-point.
 */
function spatialNoise(lat,lng,std,siteId){
  let seed=0;for(let i=0;i<siteId.length;i++)seed=(seed*17+siteId.charCodeAt(i))&0xffff;
  const cLat=Math.round(lat/SPATIAL_GRID_SIZE),cLng=Math.round(lng/SPATIAL_GRID_SIZE);
  const s1=hashInt(cLat*73856093^cLng*19349663^seed),s2=hashInt(s1+2654435761);
  const u1=(s1>>>0)/4294967296+1e-10,u2=(s2>>>0)/4294967296+1e-10;
  const raw=Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2)*std;
  // [FIX-2] Clamp ±2σ — inline dengan simulation_dt.js
  return Math.max(-2*std, Math.min(2*std, raw));
}

// ── RSRP ──────────────────────────────────────────────────────────────────────
function computeRSRP(dist,gainDb,hBS,sc,cond,lat,lon,siteId,clutter,P){
  const pl=pathLoss(sc,cond,dist,P.FREQUENCY,hBS,MOBILE_H);
  const cl=getClutterLoss(clutter);
  const xi=spatialNoise(lat,lon,getShadowStd(sc,cond),siteId);
  return P.TX_POWER+gainDb-pl-cl+xi;
}

/**
 * [FIX-3 + FIX-4] computeSINR — Dominant Interferer Filter + IM sebagai noise rise
 *
 * [FIX-3] IM diterapkan sebagai noise rise:
 *   I_base = N_thermal * IM_FACTOR
 *   → bukan power absolut, tapi faktor koreksi noise floor
 *   [3GPP TR 36.942 §A.1]
 *
 * [FIX-4] Hanya interferer dengan RSRP > serving - 20 dB yang masuk I.
 *   Sektor 20 dB di bawah serving berkontribusi < 1% ke total I
 *   → diabaikan, tidak mengubah SINR secara bermakna.
 *   [3GPP TR 36.942 §A.1 dominant interferer assumption]
 */
function computeSINR(rsrp_serving, interferers, P) {
  const thresholdDbm = rsrp_serving - DOMINANT_INTERFERER_THRESHOLD_DB;
  const S = dbmToLinear(rsrp_serving);

  // [FIX-3] Noise rise: I_base = N * IM_FACTOR (bukan N + IM_LIN)
  const I_base = P.THERMAL_NOISE_LIN * INTERFERENCE_MARGIN_FACTOR;

  let I = I_base;
  interferers.forEach(r => {
    // [FIX-4] Filter dominant interferer
    if (r >= thresholdDbm) {
      I += dbmToLinear(r);
    }
  });

  return Math.max(P.SINR_FLOOR, Math.min(P.SINR_CEIL, linearToDbm(S / I)));
}

// ── Color helpers ─────────────────────────────────────────────────────────────
function getRSRPColor(v){if(v>=-85)return'#0042a5';if(v>=-95)return'#00a955';if(v>=-105)return'#70ff66';if(v>=-120)return'#fffb00';if(v>=-140)return'#ff3333';return'#800000';}
function getSINRColor(v){if(v>=20)return'#0042a5';if(v>=10)return'#00a955';if(v>=0)return'#70ff66';if(v>=-5)return'#fffb00';if(v>=-10)return'#ff3333';return'#800000';}
function getRSRPCategory(v){if(v>=-85)return'S1';if(v>=-95)return'S2';if(v>=-105)return'S3';if(v>=-120)return'S4';if(v>=-140)return'S5';return'S6';}
function getSINRCategory(v){if(v>=20)return'S1';if(v>=10)return'S2';if(v>=0)return'S3';if(v>=-5)return'S4';if(v>=-10)return'S5';return'S6';}
function getCategoryName(c){return{S1:'Excellent',S2:'Good',S3:'Moderate',S4:'Poor',S5:'Bad',S6:'Very Bad'}[c]||'Unknown';}

// ── Organic shape ─────────────────────────────────────────────────────────────
function smoothHash(x,y,seed){seed=seed||0;const n=Math.sin(x*127.1+y*311.7+seed*74.3)*43758.5453;return n-Math.floor(n);}
function smoothNoise2D(x,y,seed){const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy);return smoothHash(ix,iy,seed)*(1-ux)*(1-uy)+smoothHash(ix+1,iy,seed)*ux*(1-uy)+smoothHash(ix,iy+1,seed)*(1-ux)*uy+smoothHash(ix+1,iy+1,seed)*ux*uy;}
function fractalNoise2D(x,y,octaves,seed){let v=0,a=0.5,f=1,m=0;for(let o=0;o<octaves;o++){v+=a*(smoothNoise2D(x*f,y*f,seed+o*31)-0.5);m+=a;a*=0.5;f*=2;}return v/m;}
function azimuthRadiusFactor(brng,siteId){let seed=0;for(let i=0;i<siteId.length;i++)seed=(seed*31+siteId.charCodeAt(i))&0x7fffffff;seed/=0x7fffffff;const ang=brng*Math.PI/180;let f=0;for(let k=1;k<=ORG.AZIMUTH_WAVES;k++){const ph=smoothHash(k,seed,k*7.3)*2*Math.PI,amp=(1/k)*smoothHash(seed,k,seed*3.7);f+=amp*Math.sin(k*ang+ph);}f=(f/ORG.AZIMUTH_WAVES)*2*ORG.AZIMUTH_AMP;return 1+Math.max(-ORG.AZIMUTH_AMP,Math.min(ORG.AZIMUTH_AMP,f));}
function getEdgeSurvivalProb(dist,radius,brng,siteId){const er=dist/(radius*azimuthRadiusFactor(brng,siteId));if(er<=0.75)return 1;if(er>1.15)return 0;const t=(er-0.75)/0.40;return 1-t*t*(3-2*t);}

// ── Geo ───────────────────────────────────────────────────────────────────────
function destinationPoint(lat,lng,az,dist){const R=6378137,b=az*Math.PI/180,d=dist/R,la1=lat*Math.PI/180,lo1=lng*Math.PI/180,la2=Math.asin(Math.sin(la1)*Math.cos(d)+Math.cos(la1)*Math.sin(d)*Math.cos(b)),lo2=lo1+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la1),Math.cos(d)-Math.sin(la1)*Math.sin(la2));return{lat:la2*180/Math.PI,lng:lo2*180/Math.PI};}
function calcDistance(a,b){const R=6378137,la1=a.lat*Math.PI/180,la2=b.lat*Math.PI/180,dLa=(b.lat-a.lat)*Math.PI/180,dLo=(b.lng-a.lng)*Math.PI/180,x=Math.sin(dLa/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLo/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
function bearingTo(la1,lo1,la2,lo2){const p1=la1*Math.PI/180,p2=la2*Math.PI/180,dl=(lo2-lo1)*Math.PI/180;return(Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360;}
function convexHull(points){if(points.length<3)return points;const pts=points.map(p=>({x:p[1],y:p[0]}));pts.sort((a,b)=>a.x!==b.x?a.x-b.x:a.y-b.y);const cross=(O,A,B)=>(A.x-O.x)*(B.y-O.y)-(A.y-O.y)*(B.x-O.x),lower=[],upper=[];for(const p of pts){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],p)<=0)lower.pop();lower.push(p);}for(let i=pts.length-1;i>=0;i--){const p=pts[i];while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],p)<=0)upper.pop();upper.push(p);}upper.pop();lower.pop();return[...lower,...upper].map(p=>[p.y,p.x]);}

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  attachListeners();
  restoreSiteIndex();
  updateRFBadge();
});

function initMap(){
  map=L.map('coverageMap').setView([-6.2088,106.8456],16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:19}).addTo(map);
  siteLayer=L.layerGroup().addTo(map);
  sectorLayer=L.layerGroup().addTo(map);
}

// ── Listeners ─────────────────────────────────────────────────────────────────
function attachListeners(){
  document.getElementById('loadShapefileBtn')?.addEventListener('click',()=>document.getElementById('shapefileInput').click());
  document.getElementById('shapefileInput')?.addEventListener('change',processXLSX);
  document.getElementById('sendToCompareBtn')?.addEventListener('click',sendCoverageToCompare);
  document.getElementById('btnClearSite')?.addEventListener('click',clearSiteData);
  document.getElementById('searchSiteBtn')?.addEventListener('click',onSiteSelect);
  document.getElementById('siteSearch')?.addEventListener('keypress',e=>{if(e.key==='Enter')onSiteSelect();});
  document.getElementById('toggleBuildingBtn')?.addEventListener('click',toggleBuildings);
  document.getElementById('visualizeRSRP')?.addEventListener('click',()=>setActiveViz('rsrp'));
  document.getElementById('visualizeSINR')?.addEventListener('click',()=>setActiveViz('sinr'));
  document.getElementById('gridSize')?.addEventListener('change',autoRegenerate);
  ['coverageRadius','antennaHeight'].forEach(id=>{
    const el=document.getElementById(id);
    if(!el)return;
    el.addEventListener('keydown',e=>{ if(e.key==='Enter'){ el.blur(); } });
    el.addEventListener('blur',()=>{
      if(id==='antennaHeight') updateHeightBadge();
      autoRegenerate();
    });
  });
  ['rf_txpower','rf_frequency','rf_bandwidth','rf_scenario','rf_condition','rf_clutter'].forEach(id=>{
    document.getElementById(id)?.addEventListener('change',()=>{
      updateRFBadge();
      autoRegenerate();
    });
  });
  document.getElementById('btnToggleRF')?.addEventListener('click',()=>{
    const body=document.getElementById('rfPanelBody');
    const icon=document.getElementById('rfToggleIcon');
    const open=body.style.display==='none';
    body.style.display=open?'block':'none';
    icon.textContent=open?'▼':'▶';
  });
  document.getElementById('toggleGapBtn')?.addEventListener('click',toggleGapLayer);
}

// ── RF badge ──────────────────────────────────────────────────────────────────
function updateRFBadge(){
  const P=getParams();
  const sc=P.SCENARIO.toUpperCase(), cond=P.CONDITION.toUpperCase().replace('_','/');
  const setT=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  setT('badgeModel',`${sc} ${cond}`);
  setT('badgeClutter',`${P.CLUTTER.replace('_',' ')} · ${getClutterLoss(P.CLUTTER)} dB`);
  setT('badgeFreqBW',`${P.FREQUENCY} / ${P.BANDWIDTH} MHz`);
  setT('badgeTxPower',`${P.TX_POWER} dBm`);
}

function updateHeightBadge(){
  const h=parseInt(document.getElementById('antennaHeight')?.value)||30;
  const badge=document.getElementById('heightBadge');
  if(!badge)return;
  const site=selectedSite?siteIndex[selectedSite]:null;
  if(site?.height){
    if(Math.abs(h-site.height)<2){badge.textContent='Default';badge.style.background='#1F3C88';}
    else if(h>site.height){badge.textContent=`+${h-site.height}m`;badge.style.background='#28a745';}
    else{badge.textContent=`${h-site.height}m`;badge.style.background='#dc3545';}
  }else{badge.textContent=`${h}m`;badge.style.background='#6c757d';}
}

// ── Restore session ───────────────────────────────────────────────────────────
function restoreSiteIndex(){
  const saved=sessionStorage.getItem(SESSION_KEY);
  if(!saved){showUploadPrompt();return;}
  try{
    const parsed=JSON.parse(saved);
    if(!parsed||!Object.keys(parsed).length){showUploadPrompt();return;}
    siteIndex=parsed;
    renderSitesOnMap();
    populateSiteSearch();
    setSourceBadge(`✅ ${Object.keys(siteIndex).length} site`);
    showClearBtn(true);
  }catch{sessionStorage.removeItem(SESSION_KEY);showUploadPrompt();}
}

function renderSitesOnMap(){
  siteLayer.clearLayers();sectorLayer.clearLayers();
  const cg=L.markerClusterGroup({chunkedLoading:true,maxClusterRadius:60,disableClusteringAtZoom:15,spiderfyOnMaxZoom:true});
  const bounds=[];
  Object.entries(siteIndex).forEach(([id,s])=>{
    bounds.push([s.lat,s.lng]);
    const m=L.circleMarker([s.lat,s.lng],{radius:7,fillColor:'#ffd000',color:'#000',weight:1.5,fillOpacity:1});
    m.bindTooltip(id,{permanent:false,direction:'top',offset:[0,-8],className:'site-label'});
    m.bindPopup(`<b>${id}</b><br>Lat: ${s.lat.toFixed(6)}<br>Lng: ${s.lng.toFixed(6)}<br>Height: ${s.height}m<br>Clutter: ${s.clutter||'N/A'}<br>Model: ${(s.scenario||'uma').toUpperCase()} ${(s.condition||'nlos').toUpperCase()}`);
    cg.addLayer(m);
  });
  siteLayer.addLayer(cg);
  if(bounds.length)map.fitBounds(bounds);
}

function getNeighbourSites(mainId){
  const ms=siteIndex[mainId];if(!ms)return[];
  return Object.entries(siteIndex).filter(([id])=>id!==mainId)
    .map(([id,s])=>({id,site:s,dist:calcDistance({lat:ms.lat,lng:ms.lng},{lat:s.lat,lng:s.lng})}))
    .sort((a,b)=>a.dist-b.dist).slice(0,GAP_CFG.MAX_NEIGHBOURS);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setSourceBadge(msg){const e=document.getElementById('sourceBadge');if(e)e.textContent=msg;}
function showUploadPrompt(){setSourceBadge('⚠️ Belum ada data — upload XLSX');showClearBtn(false);}
function showClearBtn(show){const b=document.getElementById('btnClearSite');if(b)b.style.display=show?'inline-flex':'none';}

function clearSiteData(){
  if(!confirm('Hapus data site yang tersimpan?'))return;
  sessionStorage.removeItem(SESSION_KEY);
  siteIndex={};
  siteLayer.clearLayers();sectorLayer.clearLayers();
  if(coverageLayer){map.removeLayer(coverageLayer);coverageLayer=null;}
  clearGapLayer();populateSiteSearch();showUploadPrompt();
  const lg=document.getElementById('mapLegend');if(lg)lg.style.display='none';
  const ar=document.getElementById('analysisResult');
  if(ar)ar.innerHTML='<div class="waiting-state"><i class="fas fa-info-circle"></i><p>Pilih site untuk melihat analisis</p></div>';
  ['totalArea','excellentCoverage','goodCoverage','poorCoverage'].forEach(id=>{
    const e=document.getElementById(id);if(e)e.textContent=id==='totalArea'?'0 km²':'0%';
  });
}

// ── Set RF from site ──────────────────────────────────────────────────────────
function _setRFFromSite(site){
  const setVal=(id,val)=>{
    const el=document.getElementById(id);
    if(!el||val==null)return;
    const opts=Array.from(el.options||[]);
    const match=opts.find(o=>String(o.value)===String(val));
    if(match)el.value=match.value;
  };
  const txRaw=PARAM_DEFAULTS.TX_POWER;
  setVal('rf_txpower', txRaw);
  const freqRaw=site.frequency||PARAM_DEFAULTS.FREQUENCY;
  const freqOpts=[700,2100,2300,2600];
  const freqMatch=freqOpts.reduce((a,b)=>Math.abs(b-freqRaw)<Math.abs(a-freqRaw)?b:a);
  setVal('rf_frequency', freqMatch);
  const bwRaw=site.bandwidth||PARAM_DEFAULTS.BANDWIDTH;
  const bwOpts=[5,10,15,20,25,30,40,50,60,80,90,100];
  const bwMatch=bwOpts.reduce((a,b)=>Math.abs(b-bwRaw)<Math.abs(a-bwRaw)?b:a);
  setVal('rf_bandwidth', bwMatch);
  setVal('rf_scenario', (site.scenario||'uma').toLowerCase());
  setVal('rf_condition', (site.condition||'nlos').toLowerCase());
  const ck=(site.clutter||'urban').toLowerCase().replace(/[\s-]+/g,'_');
  const valid=Object.keys(CLUTTER_LOSS_DB);
  const matched=valid.find(k=>ck.includes(k)||k.includes(ck))||'urban';
  setVal('rf_clutter', matched);
  const hEl=document.getElementById('antennaHeight');
  if(hEl&&site.height)hEl.value=site.height;
  updateRFBadge();
  updateHeightBadge();
}

// ── XLSX upload ───────────────────────────────────────────────────────────────
async function processXLSX(e){
  const file=e.target.files[0];if(!file)return;
  const est=Math.max(2,Math.round(0.5+file.size/(1024*1024)*1.5));
  showLoadingWithProgress('Mengunggah data site...',0,est);
  let iv;const t0=Date.now();
  try{
    iv=setInterval(()=>{const el=(Date.now()-t0)/1000;updateLoadingProgress(Math.min(85,Math.round((el/est)*85)),'Memproses...');},300);
    const fd=new FormData();fd.append('file',file);
    const res=await fetch('/api/upload-site',{method:'POST',body:fd});
    clearInterval(iv);updateLoadingProgress(92,'Menerima data...');
    const json=await res.json();
    if(!res.ok||!json.success)throw new Error(json.error||'Upload gagal');
    updateLoadingProgress(97,'Menyusun peta...');
    await new Promise(r=>setTimeout(r,150));
    siteIndex=json.siteIndex;
    sessionStorage.setItem(SESSION_KEY,JSON.stringify(siteIndex));
    renderSitesOnMap();populateSiteSearch();hideLoading();
    setSourceBadge(`✅ ${json.siteCount} site (${json.filename})`);showClearBtn(true);
    alert(`✅ ${json.siteCount} site dimuat dalam ${((Date.now()-t0)/1000).toFixed(1)}s.`);
  }catch(err){clearInterval(iv);hideLoading();alert('❌ Gagal: '+err.message);}
  e.target.value='';
}

// ── Site select ───────────────────────────────────────────────────────────────
function populateSiteSearch(){
  const list=document.getElementById('siteList');if(!list)return;
  list.innerHTML='';
  Object.keys(siteIndex).sort().forEach(id=>{const o=document.createElement('option');o.value=id;list.appendChild(o);});
}

function onSiteSelect(){
  const id=document.getElementById('siteSearch').value.trim();
  if(!siteIndex[id]){alert('Site tidak ditemukan.');return;}
  selectedSite=id;
  const site=siteIndex[id];
  _setRFFromSite(site);
  sectorLayer.clearLayers();
  if(coverageLayer){map.removeLayer(coverageLayer);coverageLayer=null;}
  clearGapLayer();
  const P=getParams();
  site.sectors.forEach((az,idx)=>drawSectorFan(site.lat,site.lng,az,P.BEAMWIDTH,150,idx,true));
  const nb=getNeighbourSites(id);
  nb.forEach((n,ni)=>{
    sectorLayer.addLayer(L.circleMarker([n.site.lat,n.site.lng],{radius:6,fillColor:SITE_BORDER_COLORS[ni+1]||'#aaa',color:'#000',weight:1.2,fillOpacity:0.85}).bindTooltip(`${n.id} (nb)`,{direction:'top',offset:[0,-8]}));
    n.site.sectors?.forEach((az,si)=>drawSectorFan(n.site.lat,n.site.lng,az,P.BEAMWIDTH,120,si,false));
  });
  const nb_badge=document.getElementById('neighbourBadge');
  if(nb_badge){nb_badge.textContent=`1st Tier: ${nb.length} site`;nb_badge.style.display='inline-block';}
  map.setView([site.lat,site.lng],15);
  generateCoverage();
}

// ── Sector fan ────────────────────────────────────────────────────────────────
function drawSectorFan(lat,lng,az,bw,radius,idx,isMain){
  const pts=[[lat,lng]];
  for(let i=0;i<=16;i++){const ang=(az-bw/2)+(i/16)*bw,p=destinationPoint(lat,lng,ang,radius);pts.push([p.lat,p.lng]);}
  pts.push([lat,lng]);
  const color=SECTOR_COLORS[idx%SECTOR_COLORS.length];
  L.polygon(pts,{color,fillColor:color,fillOpacity:isMain?0.35 : 0.10,weight:isMain?2:1,opacity:isMain?0.6:0.3,dashArray:isMain?null:'4 4'}).addTo(sectorLayer).bindPopup(`<b>Sektor ${idx+1}</b><br>Azimuth: ${az}°`);
}

// ── Building toggle ───────────────────────────────────────────────────────────
function toggleBuildings(){
  if(buildingsVisible){
    if(buildingLayer)map.removeLayer(buildingLayer);
    buildingsVisible=false;
    document.getElementById('buildingBtnText').textContent='Show Buildings';
  }else{
    showBuildings();
    buildingsVisible=true;
    document.getElementById('buildingBtnText').textContent='Hide Buildings';
  }
}

function showBuildings(){
  if(buildingLayer)map.removeLayer(buildingLayer);
  buildingLayer=L.layerGroup();
  const b=map.getBounds();
  showLoadingWithProgress('Memuat building data...',0,null);
  fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:`[out:json][timeout:25];(way["building"](${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()});relation["building"](${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}););out geom;`})
    .then(r=>r.json()).then(data=>{
      data.elements.forEach(el=>{
        if(el.type==='way'&&el.geometry){
          const lvl=parseInt(el.tags?.['building:levels']||3);
          L.polygon(el.geometry.map(n=>[n.lat,n.lon]),{color:'#888',fillColor:'#ccc',fillOpacity:0.6,weight:1})
            .bindPopup(`Building ~${lvl*3}m`).addTo(buildingLayer);
        }
      });
      buildingLayer.addTo(map);hideLoading();
    })
    .catch(()=>{hideLoading();alert('Error loading building data.');});
}

// ── Generate coverage ─────────────────────────────────────────────────────────
function autoRegenerate(){if(selectedSite&&siteIndex[selectedSite])generateCoverage();}

function generateCoverage(){
  if(!selectedSite||!siteIndex[selectedSite])return;
  showLoadingWithProgress('Menghitung coverage...',0,null);
  const gridSize   =parseInt(document.getElementById('gridSize').value);
  const radius     =parseInt(document.getElementById('coverageRadius').value);
  const antHeight  =parseInt(document.getElementById('antennaHeight').value)||30;
  if(coverageLayer){map.removeLayer(coverageLayer);coverageLayer=null;}
  clearGapLayer();

  setTimeout(()=>{
    try{
      const mainSite  =siteIndex[selectedSite];
      const neighbours=getNeighbourSites(selectedSite);
      const allSites  =[{id:selectedSite,site:mainSite,isMain:true,siteColorIdx:0},...neighbours.map((n,i)=>({id:n.id,site:n.site,isMain:false,siteColorIdx:i+1}))];
      const P=getParams();
      const grids=calcCoverage(allSites,gridSize,radius,antHeight,P);
      renderCoverageGrid(grids,currentCoverageType);

      siteLayer.remove();
      siteLayer.addTo(map);
      sectorLayer.remove();
      sectorLayer.addTo(map);

      window._lastCoverageGrids=grids;
      showSendToCompareBtn();
      const gaps=detectGaps(grids,allSites,gridSize);
      renderGapLayer(gaps,allSites);
      updateStats(grids,antHeight,allSites,gaps,P);
      hideLoading();
    }catch(err){console.error(err);alert('Error: '+err.message);hideLoading();}
  },400);
}

function calcCoverage(allSites,gridSize,radius,antHeight,P){
  const mainSite=allSites[0].site;
  const mpdLat=111320,mpdLon=111320*Math.cos(mainSite.lat*Math.PI/180);
  const dLat=gridSize/mpdLat,dLon=gridSize/mpdLon;
  const allLats=allSites.map(s=>s.site.lat),allLngs=allSites.map(s=>s.site.lng);
  const minLat=Math.min(...allLats)-radius/mpdLat,maxLat=Math.max(...allLats)+radius/mpdLat;
  const minLon=Math.min(...allLngs)-radius/mpdLon,maxLon=Math.max(...allLngs)+radius/mpdLon;
  const grids=[];

  for(let lat=minLat;lat<=maxLat;lat+=dLat){
    for(let lon=minLon;lon<=maxLon;lon+=dLon){
      let cov=false;
      for(const{id,site}of allSites){
        const dist=calcDistance({lat:site.lat,lng:site.lng},{lat,lng:lon});
        const brng=bearingTo(site.lat,site.lng,lat,lon);
        if(smoothHash(lat*9973,lon*9973,id.length*17)<getEdgeSurvivalProb(dist,radius,brng,id)){cov=true;break;}
      }
      if(!cov)continue;

      const siteRSRPs=allSites.map(({id,site,isMain})=>{
        const dist=calcDistance({lat:site.lat,lng:site.lng},{lat,lng:lon});
        if(dist<1)return{id,rsrp:P.TX_POWER,dist,sectorIdx:0,isMain,scenario:P.SCENARIO,condition:P.CONDITION};
        const brng=bearingTo(site.lat,site.lng,lat,lon);
        let gainDb=0,sectorIdx=0;
        if(site.sectors?.length){const b=bestSectorGain(brng,site.sectors,P.BEAMWIDTH,P.ANTENNA_Am);gainDb=b.gain;sectorIdx=b.sectorIdx;}
        const rsrp=computeRSRP(dist,gainDb,antHeight,P.SCENARIO,P.CONDITION,lat,lon,id,P.CLUTTER,P);
        return{id,rsrp,dist,sectorIdx,isMain,scenario:P.SCENARIO,condition:P.CONDITION};
      });

      let best=siteRSRPs[0];
      siteRSRPs.forEach(s=>{if(s.rsrp>best.rsrp)best=s;});
      if(calcDistance({lat:mainSite.lat,lng:mainSite.lng},{lat,lng:lon})>radius*2.2)continue;

      const rsrpServing=Math.max(RX_SENSITIVITY_FLOOR,best.rsrp);
      // [FIX-4] interfRSRPs diteruskan ke computeSINR yang sudah ada filter
      const interfRSRPs=siteRSRPs.filter(s=>s.id!==best.id).map(s=>Math.max(RX_SENSITIVITY_FLOOR,s.rsrp));
      const sinrVal=computeSINR(rsrpServing,interfRSRPs,P);

      let value,color,category;
      if(currentCoverageType==='rsrp'){value=Math.round(rsrpServing*10)/10;color=getRSRPColor(value);category=getRSRPCategory(value);}
      else{value=Math.round(sinrVal*10)/10;color=getSINRColor(value);category=getSINRCategory(value);}

      const se=allSites.find(s=>s.id===best.id);
      grids.push({
        lat,lon,dist:best.dist,
        distFromMain:calcDistance({lat:mainSite.lat,lng:mainSite.lng},{lat,lng:lon}),
        value,color,category,
        sectorIdx:best.sectorIdx,servingSiteId:best.id,isMain:best.isMain,
        siteColorIdx:se?se.siteColorIdx:0,
        isVoronoiBorder:siteRSRPs.some(s=>s.id!==best.id&&Math.abs(s.rsrp-best.rsrp)<3),
        scenario:best.scenario,condition:best.condition,
        rsrpValue:rsrpServing,sinrValue:sinrVal,
        allRSRPs:siteRSRPs.map(s=>({id:s.id,rsrp:Math.round(Math.max(RX_SENSITIVITY_FLOOR,s.rsrp)*10)/10})),
        bounds:[[lat,lon],[lat+dLat,lon],[lat+dLat,lon+dLon],[lat,lon+dLon]],
      });
    }
  }
  console.log(`[v6.6] ${grids.length} cells | h=${antHeight}m | ${P.SCENARIO.toUpperCase()} ${P.CONDITION.toUpperCase()} | ${P.FREQUENCY}MHz ${P.BANDWIDTH}MHz BW | TX ${P.TX_POWER}dBm | ${P.CLUTTER} | DomIntf±${DOMINANT_INTERFERER_THRESHOLD_DB}dB`);
  return grids;
}

function renderCoverageGrid(grids,type){
  const lg=L.layerGroup(),unit=type==='rsrp'?'dBm':'dB';
  grids.forEach(g=>{
    const ml=`${g.scenario.toUpperCase()} ${g.condition.toUpperCase().replace('_','/')}`;
    const bCol=g.isVoronoiBorder?SITE_BORDER_COLORS[g.siteColorIdx]:g.color,bW=g.isVoronoiBorder?1.2:0;
    const rows=g.allRSRPs.sort((a,b)=>b.rsrp-a.rsrp).map(s=>{const sv=s.id===g.servingSiteId;return`<tr style="${sv?'font-weight:bold;color:#00c7be':'color:#aaa'}"><td>${sv?'▶':'&nbsp;'} ${s.id}</td><td>${s.rsrp} dBm</td></tr>`;}).join('');
    L.polygon(g.bounds,{color:bCol,fillColor:g.color,fillOpacity:0.72,weight:bW,opacity:bW?0.85:0})
      .bindPopup(`<div style="font-family:Arial,sans-serif;min-width:190px"><h4 style="margin:0 0 6px;color:${g.color}">${type.toUpperCase()}: ${g.value} ${unit}</h4><p style="margin:2px 0"><b>Category:</b> ${getCategoryName(g.category)}</p><p style="margin:2px 0"><b>Serving:</b> <span style="color:#00c7be">${g.servingSiteId}</span>${g.isMain?' ★':''}</p><p style="margin:2px 0"><b>Dist:</b> ${Math.round(g.dist)} m | <b>Model:</b> ${ml}</p><p style="margin:2px 0"><b>RSRP:</b> ${g.rsrpValue} dBm | <b>SINR:</b> ${g.sinrValue.toFixed(1)} dB</p><hr style="border-color:#eee;margin:6px 0"><table style="font-size:0.78rem;width:100%">${rows}</table>${g.isVoronoiBorder?'<p style="font-size:0.72rem;color:#f0b429;margin:4px 0 0">⚡ Zona handover</p>':''}</div>`)
      .addTo(lg);
  });
  coverageLayer=lg.addTo(map);
}

// ── Stats & legend ────────────────────────────────────────────────────────────
function updateStats(grids,antHeight,allSites,gaps,P){
  const gs=parseInt(document.getElementById('gridSize').value),cats={};
  grids.forEach(g=>{cats[g.category]=(cats[g.category]||0)+1;});
  const total=grids.length||1;
  const setT=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  setT('totalArea',`${(grids.length*(gs/1000)**2).toFixed(2)} km²`);
  setT('excellentCoverage',`${((cats.S1||0)/total*100).toFixed(1)}%`);
  setT('goodCoverage',`${((cats.S2||0)/total*100).toFixed(1)}%`);
  setT('poorCoverage',`${(((cats.S4||0)+(cats.S5||0)+(cats.S6||0))/total*100).toFixed(1)}%`);

  const type=currentCoverageType==='rsrp'?'RSRP':'SINR',unit=currentCoverageType==='rsrp'?'dBm':'dB';
  const avg=arr=>arr.length?(arr.reduce((s,g)=>s+g.value,0)/arr.length).toFixed(1):'-';
  const s1Pct=(cats.S1||0)/total*100,s2Pct=(cats.S2||0)/total*100,poorPct=((cats.S4||0)+(cats.S5||0)+(cats.S6||0))/total*100;
  const borderPct=(grids.filter(g=>g.isVoronoiBorder).length/total*100).toFixed(1);
  const mainSite=allSites[0].site;
  const avgISD=allSites.length>1?(allSites.slice(1).reduce((s,x)=>s+calcDistance({lat:mainSite.lat,lng:mainSite.lng},{lat:x.site.lat,lng:x.site.lng}),0)/(allSites.length-1)).toFixed(0):'-';
  const ml=`${P.SCENARIO.toUpperCase()} ${P.CONDITION.toUpperCase().replace('_','/')}`;

  let html='<div class="analysis-text">';
  html+=`<div style="padding:7px 10px;background:#eef3ff;border-left:3px solid #1F3C88;border-radius:5px;font-size:11.5px;margin-bottom:10px;line-height:1.6;">`;
  html+=`📡 <b>${ml}</b> &nbsp;|&nbsp; 🏗️ <b>${antHeight}m</b> &nbsp;|&nbsp; 📶 <b>${P.FREQUENCY}/${P.BANDWIDTH} MHz</b> &nbsp;|&nbsp; ⚡ <b>${P.TX_POWER} dBm</b> &nbsp;|&nbsp; 🗼 <b>${allSites.length} site</b> &nbsp;|&nbsp; ISD <b>${avgISD}m</b></div>`;

  if(s1Pct>50) html+=`<div class="analysis-success"><strong>Coverage Sangat Baik</strong><br>${s1Pct.toFixed(1)}% area excellent.</div>`;
  else if(poorPct>40) html+=`<div class="analysis-warning"><strong>Coverage Perlu Perhatian</strong><br>${poorPct.toFixed(1)}% ${type} buruk.</div>`;
  else html+=`<div class="analysis-highlight"><strong>Coverage Memadai</strong><br>${s2Pct.toFixed(1)}% kategori good.</div>`;

  if(gaps&&gaps.length>0){
    const bC=gaps.filter(c=>c.type==='blank_spot'),wC=gaps.filter(c=>c.type==='weak_coverage');
    if(bC.length)html+=`<div style="padding:8px 10px;background:#fff1f0;border-left:3px solid #e53935;border-radius:5px;margin:8px 0;font-size:12px;"><b style="color:#e53935">🚫 ${bC.length} Blank Spot</b> — ${bC.reduce((s,c)=>s+parseFloat(c.areaSqKm),0).toFixed(3)} km²</div>`;
    if(wC.length)html+=`<div style="padding:8px 10px;background:#fff8ec;border-left:3px solid #f0a500;border-radius:5px;margin:8px 0;font-size:12px;"><b style="color:#f0a500">⚠️ ${wC.length} Weak Coverage</b> — ${wC.reduce((s,c)=>s+parseFloat(c.areaSqKm),0).toFixed(3)} km²</div>`;
  }else{
    html+=`<div style="padding:7px 10px;background:#edfaf3;border-left:3px solid #28a745;border-radius:5px;margin:8px 0;font-size:12px;"><b style="color:#28a745">✅ Tidak ada gap coverage signifikan</b></div>`;
  }

  html+=`<p><strong>Distribusi per Site:</strong></p><ul>`;
  allSites.forEach(({id,isMain})=>{const sg=grids.filter(g=>g.servingSiteId===id);html+=`<li><b>${id}</b>${isMain?' ★':''}: ${(sg.length/total*100).toFixed(1)}%, avg ${avg(sg)} ${unit}</li>`;});
  html+=`</ul>`;
  html+=`<p><strong>Handover zone:</strong> ${borderPct}% grid.</p>`;
  const close=grids.filter(g=>g.dist<=150),med=grids.filter(g=>g.dist>150&&g.dist<=300),far=grids.filter(g=>g.dist>300);
  html+=`<p><strong>Avg ${type} per jarak:</strong></p><ul>`;
  if(close.length)html+=`<li>0–150 m: <b>${avg(close)} ${unit}</b></li>`;
  if(med.length)html+=`<li>150–300 m: <b>${avg(med)} ${unit}</b></li>`;
  if(far.length)html+=`<li>&gt;300 m: <b>${avg(far)} ${unit}</b></li>`;
  html+=`</ul></div>`;

  const ar=document.getElementById('analysisResult');if(ar)ar.innerHTML=html;
  updateLegend(cats,total);
}

function updateLegend(cats,total){
  const legend=document.getElementById('mapLegend'),tbody=document.getElementById('legendTableBody'),title=document.getElementById('legendTitle');
  if(!legend||!tbody)return;
  legend.style.display='block';
  const isRSRP=currentCoverageType==='rsrp';
  if(title)title.textContent=isRSRP?'RSRP (dBm)':'SINR (dB)';
  const rows=isRSRP?[{cat:'S1',color:'#0042a5',range:'-85~0'},{cat:'S2',color:'#00a955',range:'-95~-85'},{cat:'S3',color:'#70ff66',range:'-105~-95'},{cat:'S4',color:'#fffb00',range:'-120~-105'},{cat:'S5',color:'#ff3333',range:'-140~-120'}]:[{cat:'S1',color:'#0042a5',range:'20~40'},{cat:'S2',color:'#00a955',range:'10~20'},{cat:'S3',color:'#70ff66',range:'0~10'},{cat:'S4',color:'#fffb00',range:'-5~0'},{cat:'S5',color:'#ff3333',range:'-10~-5'}];
  tbody.innerHTML='';
  rows.forEach(item=>{const pct=total>0?(((cats[item.cat]||0)/total)*100).toFixed(1):'0.0';const r=document.createElement('tr');r.innerHTML=`<td><div class="color-box" style="background:${item.color}"></div></td><td>${item.range}</td><td><b>${pct}%</b></td>`;tbody.appendChild(r);});
  [['#ff3b30','🚫 Blank'],['#ff9500','⚠️ Weak']].forEach(([c,l])=>{const r=document.createElement('tr');r.innerHTML=`<td><div class="color-box" style="background:${c};opacity:0.6;border:2px dashed ${c}"></div></td><td colspan="2" style="font-size:10px;color:${c}">${l}</td>`;tbody.appendChild(r);});
}

// ── Viz toggle ────────────────────────────────────────────────────────────────
function setActiveViz(type){
  currentCoverageType=type;
  document.getElementById('visualizeRSRP')?.classList.toggle('active',type==='rsrp');
  document.getElementById('visualizeSINR')?.classList.toggle('active',type==='sinr');
  if(selectedSite&&siteIndex[selectedSite])generateCoverage();
}

// ── Gap detector ──────────────────────────────────────────────────────────────
function detectGaps(grids,allSites,gridSize){
  const weakGrids=grids.filter(g=>g.rsrpValue>=GAP_CFG.RSRP_BLANK&&g.rsrpValue<GAP_CFG.RSRP_WEAK);
  const blankGrids=grids.filter(g=>g.rsrpValue<GAP_CFG.RSRP_BLANK);
  const mainSite=allSites[0].site;
  const mpdLat=111320,mpdLon=111320*Math.cos(mainSite.lat*Math.PI/180);
  const radius=parseInt(document.getElementById('coverageRadius').value);
  const dLat=gridSize/mpdLat,dLon=gridSize/mpdLon;
  const covSet=new Set(grids.map(g=>`${Math.round(g.lat/dLat)},${Math.round(g.lon/dLon)}`));
  const clIds=new Set(allSites.map(s=>s.id));
  const allNet=Object.entries(siteIndex).map(([id,s])=>({id,site:s}));
  const spBlanks=[];
  const sMinLat=mainSite.lat-radius/mpdLat,sMaxLat=mainSite.lat+radius/mpdLat;
  const sMinLon=mainSite.lng-radius/mpdLon,sMaxLon=mainSite.lng+radius/mpdLon;
  for(let lat=sMinLat;lat<=sMaxLat;lat+=dLat){
    for(let lon=sMinLon;lon<=sMaxLon;lon+=dLon){
      if(covSet.has(`${Math.round(lat/dLat)},${Math.round(lon/dLon)}`))continue;
      if(calcDistance({lat:mainSite.lat,lng:mainSite.lng},{lat,lng:lon})>radius)continue;
      let cId=null,cD=Infinity;
      for(const{id,site}of allNet){const d=calcDistance({lat:site.lat,lng:site.lng},{lat,lng:lon});if(d<cD){cD=d;cId=id;}}
      if(cId&&!clIds.has(cId))continue;
      spBlanks.push({lat,lon,rsrpValue:-999,bounds:[[lat,lon],[lat+dLat,lon],[lat+dLat,lon+dLon],[lat,lon+dLon]]});
    }
  }
  function cluster(inp){if(!inp.length)return[];const cD=Math.max(GAP_CFG.CLUSTER_DIST_M,gridSize*1.5),clusters=[],asgn=new Array(inp.length).fill(false);for(let i=0;i<inp.length;i++){if(asgn[i])continue;const cl=[inp[i]];asgn[i]=true;for(let j=i+1;j<inp.length;j++){if(asgn[j])continue;if(calcDistance({lat:inp[i].lat,lng:inp[i].lon},{lat:inp[j].lat,lng:inp[j].lon})<=cD){cl.push(inp[j]);asgn[j]=true;}}clusters.push(cl);}return clusters.filter(c=>c.length>=GAP_CFG.MIN_CLUSTER);}
  function meta(cells,type,idx){const aLat=cells.reduce((s,c)=>s+c.lat,0)/cells.length,aLon=cells.reduce((s,c)=>s+c.lon,0)/cells.length,vR=cells.filter(c=>c.rsrpValue>-900),aR=vR.length?vR.reduce((s,c)=>s+c.rsrpValue,0)/vR.length:null,mR=vR.length?Math.min(...vR.map(c=>c.rsrpValue)):null,mD=Math.max(...cells.map(c=>calcDistance({lat:aLat,lng:aLon},{lat:c.lat,lng:c.lon}))),eR=Math.max(mD+gridSize,gridSize*2);let ns=null,nd=Infinity;allSites.forEach(({id,site})=>{const d=calcDistance({lat:aLat,lng:aLon},{lat:site.lat,lng:site.lng});if(d<nd){nd=d;ns=id;}});return{clusterIdx:idx,type,cells,centroidLat:aLat,centroidLon:aLon,avgRSRP:aR!==null?Math.round(aR*10)/10:null,minRSRP:mR!==null?Math.round(mR*10)/10:null,cellCount:cells.length,estimatedRadiusM:Math.round(eR),nearestSiteId:ns,nearestSiteDist:Math.round(nd),areaSqKm:(cells.length*(gridSize/1000)**2).toFixed(3)};}
  const allB=[...spBlanks,...blankGrids];
  const bC=cluster(allB).map((c,i)=>meta(c,'blank_spot',i));
  const wC=cluster(weakGrids).map((c,i)=>meta(c,'weak_coverage',bC.length+i));
  const all=[...bC,...wC].sort((a,b)=>{if(a.type!==b.type)return a.type==='blank_spot'?-1:1;return b.cellCount-a.cellCount;});
  return all;
}

function renderGapLayer(gaps,allSites){
  clearGapLayer();
  const btn=document.getElementById('toggleGapBtn');
  if(!gaps.length){updateGapBadge(0,0);if(btn)btn.style.display='none';return;}
  if(btn)btn.style.display='block';
  gapLayer=L.layerGroup().addTo(map);
  gaps.forEach((cl,idx)=>{
    const isBlank=cl.type==='blank_spot',mc=isBlank?'#ff3b30':'#ff9500';
    const pts=[];cl.cells.forEach(c=>{c.bounds.forEach(p=>pts.push(p));});
    const hull=convexHull(pts);
    if(hull.length>=3)L.polygon(hull,{color:mc,fillColor:mc,fillOpacity:isBlank?0.35 : 0.10,weight:isBlank?1.5:1.2,opacity:0.7,dashArray:'5 4'}).addTo(gapLayer);
    const icon=L.divIcon({className:'',iconSize:[20,20],iconAnchor:[10,10],html:`<div style="width:20px;height:20px;background:${mc};border:1.5px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;cursor:pointer;opacity:0.9;">${isBlank?'🚫':'⚠️'}</div>`});
    const sev=cl.cellCount>20?(isBlank?'Kritis':'Kritis'):cl.cellCount>8?(isBlank?'Sedang':'Sedang'):'Ringan';
    const rRow=cl.avgRSRP!==null?`<tr><td style="color:#888">Avg RSRP</td><td><b style="color:${mc}">${cl.avgRSRP} dBm</b></td></tr><tr><td style="color:#888">Min RSRP</td><td><b>${cl.minRSRP} dBm</b></td></tr>`:`<tr><td colspan="2" style="color:#f66"><b>Tidak ada sinyal</b></td></tr>`;
    L.marker([cl.centroidLat,cl.centroidLon],{icon}).addTo(gapLayer)
      .bindPopup(`<div style="font-family:Arial,sans-serif;min-width:230px"><div style="background:${mc};color:#fff;padding:7px 10px;margin:-14px -14px 10px;border-radius:4px 4px 0 0"><b>${isBlank?'🚫 Blank Spot':'⚠️ Weak Coverage'} #${idx+1}</b><span style="float:right;font-size:0.75rem">${sev}</span></div><table style="font-size:12px;width:100%;border-collapse:collapse">${rRow}<tr><td style="color:#888">Luas</td><td><b>${cl.areaSqKm} km²</b></td></tr><tr><td style="color:#888">Est. Radius</td><td><b>~${cl.estimatedRadiusM} m</b></td></tr><tr><td style="color:#888">Site Terdekat</td><td><b style="color:#00c7be">${cl.nearestSiteId}</b> (${cl.nearestSiteDist} m)</td></tr><tr><td style="color:#888">Koordinat</td><td style="font-size:11px">${cl.centroidLat.toFixed(5)}, ${cl.centroidLon.toFixed(5)}</td></tr></table><div style="margin-top:9px;padding-top:8px;border-top:1px solid #eee"><button onclick="goToPlanning(${cl.clusterIdx})" style="width:100%;padding:7px;background:linear-gradient(135deg,#1F3C88,#00c7be);color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">📍 Rencanakan Site Baru</button></div></div>`,{maxWidth:280});
  });
  const bCnt=gaps.filter(c=>c.type==='blank_spot').length,wCnt=gaps.filter(c=>c.type==='weak_coverage').length;
  updateGapBadge(bCnt,wCnt);
  window._gapClusters=gaps;
}

// ════════════════════════════════════════════════════════════════════════════
// [FIX-5] goToPlanning() — v6.6
// Sekarang menyimpan SNAPSHOT LENGKAP cluster yang sedang aktif di halaman ini
// (main site + neighbour + grid yang sedang tampil + parameter RF) ke
// sessionStorage key CV_PLANNING_KEY, sebelum redirect ke /newsite.
//
// Tujuannya: newsite.js bisa render "Before" SECARA IDENTIK dengan apa yang
// user lihat di halaman coverage ini (bukan rekonstruksi/hitung ulang terpisah),
// dan "After" cukup menjalankan ulang calcCoverage() yang SAMA dengan
// allSites = [...cluster ini, site baru].
// ════════════════════════════════════════════════════════════════════════════
function goToPlanning(idx){
  const cl=window._gapClusters?.[idx];if(!cl)return;
  const site=siteIndex[cl.nearestSiteId];

  // ── [FIX-5] Bangun snapshot cluster + grid + parameter ──────────────────
  const mainSite   = siteIndex[selectedSite];
  const neighbours = getNeighbourSites(selectedSite); // [{id, site, dist}]
  const P          = getParams();

  const planningSnapshot = {
    mainSiteId: selectedSite,
    mainSite: mainSite ? {
      lat: mainSite.lat, lng: mainSite.lng, height: mainSite.height || 30,
      sectors: mainSite.sectors || [], clutter: mainSite.clutter || 'urban',
      scenario: mainSite.scenario || P.SCENARIO, condition: mainSite.condition || P.CONDITION,
    } : null,
    neighbours: neighbours.map(n => ({
      id: n.id,
      lat: n.site.lat, lng: n.site.lng, height: n.site.height || 30,
      sectors: n.site.sectors || [], clutter: n.site.clutter || 'urban',
      scenario: n.site.scenario || P.SCENARIO, condition: n.site.condition || P.CONDITION,
    })),
    params: {
      TX_POWER: P.TX_POWER, FREQUENCY: P.FREQUENCY, BANDWIDTH: P.BANDWIDTH,
      SCENARIO: P.SCENARIO, CONDITION: P.CONDITION, CLUTTER: P.CLUTTER,
    },
    gridSize: parseInt(document.getElementById('gridSize').value),
    radius: parseInt(document.getElementById('coverageRadius').value),
    antennaHeight: parseInt(document.getElementById('antennaHeight').value) || 30,
    metric: currentCoverageType,
    // Grid snapshot "before" — identik dengan apa yang user lihat sekarang di peta ini
    grids: (window._lastCoverageGrids || []).map(g => ({
      lat: g.lat, lon: g.lon, bounds: g.bounds,
      rsrpValue: g.rsrpValue, sinrValue: g.sinrValue,
      value: g.value, color: g.color, category: g.category,
      servingSiteId: g.servingSiteId, isMain: g.isMain,
      dist: g.dist,
    })),
    timestamp: new Date().toISOString(),
  };

  try {
    sessionStorage.setItem(CV_PLANNING_KEY, JSON.stringify(planningSnapshot));
    console.log(`[goToPlanning] Snapshot disimpan: ${planningSnapshot.grids.length} grid, ${planningSnapshot.neighbours.length} neighbour`);
  } catch (e) {
    console.warn('[goToPlanning] Gagal simpan snapshot (mungkin quota exceeded):', e.message);
    // Tetap lanjut — newsite.js akan fallback ke mode standalone tanpa snapshot
  }

  // Data gap (behaviour lama — tidak berubah)
  sessionStorage.setItem(GAP_PLANNING_KEY,JSON.stringify({source:'coverage_gap_detector',timestamp:new Date().toISOString(),mainSiteId:selectedSite,gapType:cl.type,recommendedLat:cl.centroidLat,recommendedLng:cl.centroidLon,gapIndex:idx+1,avgRSRP_dBm:cl.avgRSRP,minRSRP_dBm:cl.minRSRP,estimatedRadius_m:cl.estimatedRadiusM,areaSqKm:parseFloat(cl.areaSqKm),cellCount:cl.cellCount,nearestSiteId:cl.nearestSiteId,nearestSiteDist_m:cl.nearestSiteDist,nearestSiteLat:site?.lat||null,nearestSiteLng:site?.lng||null,nearestSiteHeight:site?.height||null,nearestSiteClutter:site?.clutter||null,severityLabel:cl.cellCount>20?'Kritis':cl.cellCount>8?'Sedang':'Ringan'}));
  window.location.href=PLANNING_PAGE;
}

function toggleGapLayer(){
  if(!gapLayer)return;
  const btn=document.getElementById('toggleGapBtn');
  if(gapVisible){map.removeLayer(gapLayer);gapVisible=false;if(btn)btn.textContent='👁 Tampilkan Gap';}
  else{gapLayer.addTo(map);gapVisible=true;if(btn)btn.textContent='🙈 Sembunyikan Gap';}
}
function clearGapLayer(){if(gapLayer){map.removeLayer(gapLayer);gapLayer=null;}gapVisible=true;window._gapClusters=null;updateGapBadge(0,0);}
function updateGapBadge(b,w){
  const el=document.getElementById('gapBadge');if(!el)return;
  const t=(b||0)+(w||0);
  if(t===0){el.textContent='✅ Tidak ada gap';el.style.background='rgba(26,90,26,0.85)';el.style.color='#6dff9a';el.style.borderColor='#34c759';}
  else{el.innerHTML=`🚫 ${b} blank &nbsp;|&nbsp; ⚠️ ${w} weak`;el.style.background='rgba(60,10,10,0.85)';el.style.color='#ff9500';el.style.borderColor='#ff3b30';}
  el.style.display='inline-block';
}

// ── Loading ───────────────────────────────────────────────────────────────────
function showLoadingWithProgress(text,progress,est){
  hideLoading();
  const o=document.createElement('div');o.className='loading-overlay';o.id='loadingOverlay';
  o.innerHTML=`<div class="loading-content"><div class="spinner"></div><p class="loading-text" id="loadingText">${text}</p>${est!==null?`<p class="loading-est">Estimasi: ~${est}s</p><div class="progress-bar-wrap"><div class="progress-bar-fill" id="progressBarFill" style="width:${progress}%"></div></div><p class="progress-label" id="progressLabel">${progress}%</p>`:''}</div>`;
  document.body.appendChild(o);
}
function updateLoadingProgress(p,text){const f=document.getElementById('progressBarFill'),l=document.getElementById('progressLabel'),t=document.getElementById('loadingText');if(f)f.style.width=`${p}%`;if(l)l.textContent=`${p}%`;if(t&&text)t.textContent=text;}
function hideLoading(){document.getElementById('loadingOverlay')?.remove();}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORT TO COMPARE
// ══════════════════════════════════════════════════════════════════════════════
function showSendToCompareBtn(){
  const btn=document.getElementById('sendToCompareBtn');
  if(btn)btn.style.display='inline-flex';
}

function sendCoverageToCompare(){
  if(!selectedSite||!siteIndex[selectedSite]){
    alert('❌ Pilih site terlebih dahulu sebelum mengirim ke komparasi.');
    return;
  }
  const grids=window._lastCoverageGrids;
  if(!grids||!grids.length){
    alert('❌ Generate coverage terlebih dahulu (pilih site lalu tunggu proses selesai).');
    return;
  }

  console.log(`[sendToCompare] Menyiapkan ${grids.length} grid untuk site ${selectedSite}...`);

  const P    = getParams();
  const site = siteIndex[selectedSite];
  const neighbours = getNeighbourSites(selectedSite).map(n=>n.id);

  const payload = {
    siteId      : selectedSite,
    metric      : currentCoverageType,
    gridSize    : parseInt(document.getElementById('gridSize').value),
    radius      : parseInt(document.getElementById('coverageRadius').value),
    neighbours,
    siteLat     : site.lat,
    siteLng     : site.lng,
    siteHeight  : parseInt(document.getElementById('antennaHeight').value)||site.height||30,
    scenario    : P.SCENARIO,
    condition   : P.CONDITION,
    frequency   : P.FREQUENCY,
    bandwidth   : P.BANDWIDTH,
    txPower     : P.TX_POWER,
    clutter     : P.CLUTTER,
    timestamp   : new Date().toISOString(),
    grids: grids.map(g=>({
      lat           : g.lat,
      lon           : g.lon,
      bounds        : g.bounds,
      rsrpValue     : typeof g.rsrpValue === 'number' ? Math.round(g.rsrpValue*10)/10 : null,
      sinrValue     : typeof g.sinrValue === 'number' ? Math.round(g.sinrValue*10)/10 : null,
      value         : g.value,
      color         : g.color,
      category      : g.category,
      servingSiteId : g.servingSiteId,
      isMain        : g.isMain,
      dist          : Math.round(g.dist),
    })),
  };

  let jsonStr;
  try {
    jsonStr = JSON.stringify(payload);
  } catch(e) {
    alert('❌ Gagal serialisasi data: ' + e.message);
    return;
  }

  const sizeMB = (new Blob([jsonStr]).size / 1024 / 1024).toFixed(2);
  console.log(`[sendToCompare] Ukuran payload: ${sizeMB} MB`);

  if(parseFloat(sizeMB) > 4.0){
    console.warn(`[sendToCompare] Payload besar (${sizeMB} MB), subsampling 1:2`);
    payload.grids = payload.grids.filter((_,i)=>i%2===0);
    payload._subsampled = true;
    payload._subsampleRate = 2;
    jsonStr = JSON.stringify(payload);
  }
  if(parseFloat((new Blob([jsonStr]).size/1024/1024).toFixed(2)) > 4.5){
    console.warn('[sendToCompare] Masih besar, subsampling 1:4');
    payload.grids = payload.grids.filter((_,i)=>i%4===0);
    payload._subsampleRate = 4;
    jsonStr = JSON.stringify(payload);
  }

  try{
    sessionStorage.removeItem(CV_SESSION_KEY);
    sessionStorage.setItem(CV_SESSION_KEY, jsonStr);
    const verify = sessionStorage.getItem(CV_SESSION_KEY);
    if(!verify){
      throw new Error('sessionStorage.setItem berhasil dipanggil tapi data tidak tersimpan.');
    }
    const verifyParsed = JSON.parse(verify);
    if(!verifyParsed?.grids?.length){
      throw new Error('Data tersimpan tapi grids kosong saat dibaca kembali.');
    }
    console.log(`[sendToCompare] ✅ Tersimpan: ${verifyParsed.grids.length} grid, key="${CV_SESSION_KEY}"`);
    window.location.href = CV_PAGE;
  }catch(e){
    console.error('[sendToCompare] ❌ Gagal simpan ke sessionStorage:', e);
    if(e.name === 'QuotaExceededError' || e.toString().includes('quota')){
      try{
        payload.grids = payload.grids.filter((_,i)=>i%8===0);
        payload._subsampleRate = 8;
        sessionStorage.removeItem(CV_SESSION_KEY);
        sessionStorage.setItem(CV_SESSION_KEY, JSON.stringify(payload));
        alert(`⚠️ Data sangat besar — dikirim dengan 1/8 resolusi grid (${payload.grids.length} sel).\nUntuk akurasi lebih baik, perkecil radius atau perbesar grid size.`);
        window.location.href = CV_PAGE;
      }catch(e2){
        alert('❌ sessionStorage penuh dan tidak bisa menyimpan data.\n\nSolusi:\n1. Perbesar Grid Size (misal 100m)\n2. Kurangi Radius Coverage\n3. Hapus cache browser (Ctrl+Shift+Delete)');
      }
    } else {
      alert('❌ Gagal menyimpan data ke memori browser:\n' + e.message);
    }
  }
}

console.log('coverage.js v6.6 — [FIX-5] goToPlanning() simpan snapshot cluster untuk newsite.js | [FIX-1..4] tetap dipertahankan dari v6.5');