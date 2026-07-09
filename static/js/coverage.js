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
  ANTENNA_GAIN: 8,   // [ALIGN] G_E,max — 3GPP TR 38.901 Table 7.3-1, disamakan dengan dtsimulation.js
  CABLE_LOSS  : 0.5, // [ALIGN] disamakan dengan dtsimulation.js
  FREQUENCY : 2300,
  BANDWIDTH : 30,
  ANTENNA_Am: 30,    // [ALIGN] 25 → 30 dB, 3GPP TR 38.901 Table 7.3-1
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
 */
const DOMINANT_INTERFERER_THRESHOLD_DB = 30;

// [FIX-1] Tambah key los_nlos — inline dengan simulation_dt.js v19.4
// Nilai identik dengan 'mixed' di sim_dt (dominan NLOS karena p_LOS
// sangat kecil pada jarak > 100m di dense/urban environment)
const SHADOW_STD_3GPP = {
  uma_los    : 4.0,
  uma_nlos   : 6.0,
  uma_los_nlos: 5.5,   
  umi_los    : 4.0,
  umi_nlos   : 7.82,
  umi_los_nlos: 7.0,  
  rma_los    : 4.0,
  rma_nlos   : 8.0,
  rma_los_nlos: 6.5,   
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
  // [FIX-17b] SINR_POOR: dipakai untuk MEMPERLUAS definisi weak_coverage
  // yang SUDAH ADA — bukan kategori baru terpisah. Kasus nyata: cluster
  // site padat/overlap → RSRP hampir selalu bagus (minimal ada 1 site yang
  // jangkau), sehingga blank/weak berbasis RSRP jarang muncul — TAPI SINR
  // bisa tetap jelek karena interferensi antar site. Sel begini SEKARANG
  // ikut dihitung sebagai weak_coverage (dapat marker ⚠️, ikut notifikasi,
  // ikut tombol "Rencanakan Site Baru" — sama seperti weak_coverage biasa),
  // supaya tetap masuk alur Blank Spot Optimizer yang SAMA seperti sebelumnya
  // (tidak menambah kategori/tipe baru yang belum ada di rancangan awal).
  SINR_POOR: -5,
};
// [ALIGN3] CATATAN: constant COVERAGE_THRESHOLD_DBM yang dulu dipakai untuk
// MEMOTONG grid (skip titik dengan RSRP di bawah -120) sudah DIHAPUS —
// itu ternyata membuat bin terlemah di legend (-140~-120) mustahil pernah
// muncul, kontradiksi dengan desain legend yang sudah ada. Sekarang semua
// titik yang terhitung tetap ditampilkan apa adanya (termasuk yang sangat
// lemah, S5/S6) — sesuai definisi legend asli. Batas AREA PENCARIAN (bukan
// batas warna) sekarang dihitung otomatis dari fisika, lihat
// solveMaxDistanceForThreshold() di bawah.
const ORG = { AZIMUTH_WAVES:7, AZIMUTH_AMP:0.28, CORR_LENGTH_M:120, NOISE_OCTAVES:4 };

/**
 * [ALIGN3] Menghitung jarak MAKSIMUM (boresight, arah terkuat sektor) di
 * mana RSRP baru menembus ambang tertentu — dipakai untuk menentukan
 * SEBERAPA LUAS area yang perlu dihitung, BUKAN untuk memotong bentuk
 * coverage. Ini menggantikan pendekatan lama (radius manual × konstanta
 * tetap) yang selalu menghasilkan lingkaran, karena bentuk lingkaran itu
 * datang dari batas pencarian itu sendiri, bukan dari perhitungan sinyal.
 * Dengan batas pencarian yang cukup luas (dihitung dari fisika riil),
 * bentuk akhir yang muncul murni ditentukan oleh RSRP asli (pola antena,
 * path loss, clutter) — organik, bukan geometris.
 */
function solveMaxDistanceForThreshold(sc,cond,freqMhz,hBS,hUT,eirpDbm,thresholdDbm){
  const rsrpAt = d => eirpDbm - pathLoss(sc,cond,d,freqMhz,hBS,hUT);
  let lo=10, hi=2000;
  while(rsrpAt(hi) > thresholdDbm && hi < 200000) hi *= 1.6;
  for(let i=0;i<50;i++){
    const mid=(lo+hi)/2;
    if(rsrpAt(mid) > thresholdDbm) lo=mid; else hi=mid;
  }
  return hi;
}

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
    ANTENNA_GAIN : PARAM_DEFAULTS.ANTENNA_GAIN,
    CABLE_LOSS   : PARAM_DEFAULTS.CABLE_LOSS,
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
// [FIX-6] BUG FIX: offset/(bw/2) → offset/bw
// Definisi 3GPP TR 36.942 §4.2: A(θ) = -min[12·(θ/θ_3dB)^2, Am], di mana
// θ_3dB ADALAH beamwidth penuh (full 3dB beamwidth), BUKAN setengahnya.
// Sanity check: pada θ = beamwidth/2 (tepi 3dB beamwidth), formula yang
// benar harus menghasilkan tepat -3dB — itulah definisi "3dB beamwidth".
//   Salah (offset/(bw/2)): di θ=bw/2 → -12·(1)^2 = -12dB   ✗ (harusnya -3dB)
//   Benar (offset/bw)    : di θ=bw/2 → -12·(0.5)^2 = -3dB  ✓
// Konsisten dengan dtsimulation.js: antennaGain(angOff){ return -Math.min(12*(angOff/CAL.BEAMWIDTH)**2, CAL.ANTENNA_Am); }
function antennaGain(offset, bw, Am) { return -Math.min(12*(offset/bw)**2, Am); }
function bestSectorGain(brng, sectors, bw, Am) {
  if(!sectors?.length)return{gain:0,sectorIdx:0};
  let best=-Infinity,idx=0;
  sectors.forEach((az,i)=>{const g=antennaGain(Math.abs(((brng-az+540)%360)-180),bw,Am);if(g>best){best=g;idx=i;}});
  return{gain:best,sectorIdx:idx};
}

// ── Shadow fading spatial hash ─────────────────────────────────────────────
// [ALIGN] D_COR per skenario/kondisi (3GPP TR 38.901 Table 7.5-6), disamakan
// persis dengan dtsimulation.js — menggantikan grid tetap 0.0005° yang
// sebelumnya dipakai untuk SEMUA skenario tanpa membedakan decorrelation
// distance UMa/UMi/RMa yang sebenarnya jauh berbeda.
const D_COR_DEG = {
  uma_los  : 37  / 111320,
  uma_nlos : 50  / 111320,
  uma_los_nlos: 50 / 111320,
  umi_los  : 10  / 111320,
  umi_nlos : 13  / 111320,
  umi_los_nlos: 13 / 111320,
  rma_los  : 37  / 111320,
  rma_nlos : 120 / 111320,
  rma_los_nlos: 120 / 111320,
};
const D_COR_DEFAULT = 50 / 111320;

function hashInt(n){n=((n>>>16)^n)*0x45d9f3b;n=((n>>>16)^n)*0x45d9f3b;return((n>>>16)^n)>>>0;}

/**
 * [FIX-2] Tambah clamp ±2σ [ITU-R M.2135 §A.1]
 * Tanpa clamp, Box-Muller bisa menghasilkan outlier ±4σ atau lebih
 * yang tidak merepresentasikan distribusi log-normal realistis.
 * Seed per-site dipertahankan (berbeda dari sim_dt yang pakai fixed seed)
 * karena coverage adalah visualisasi area, bukan simulasi DT point-by-point.
 * [ALIGN] Sekarang menerima scenKey untuk memilih grid decorrelation
 * distance yang sesuai skenario (bukan grid tetap untuk semua kondisi).
 */
/**
 * [FIX-9] Ganti dari HARD NEAREST-BUCKET → INTERPOLASI BILINEAR + smoothstep.
 *
 * Root cause "noise kayak statis TV/salt-pepper": versi lama pakai
 * Math.round(lat/gridSize) — begitu titik geser dan lompat ke bucket
 * sebelah, nilai noise LOMPAT TOTAL (independen), bukan menyambung. Kalau
 * ukuran cell render (gridSize input user / hasil auto-coarsen PERF-2)
 * berada di skala yang mirip dengan D_COR (decorrelation distance,
 * 37-120m), efeknya HAMPIR SETIAP cell dapet noise acak sendiri-sendiri
 * → keliatan seperti statis TV, bukan blob/patch halus seperti coverage
 * map asli (bandingkan referensi OpenSignal/nPerf yang jauh lebih smooth).
 *
 * Fix: hitung noise Gaussian di 4 titik sudut bucket terdekat (bukan cuma
 * 1 titik terdekat), lalu interpolasi bilinear+smoothstep di antaranya.
 * Hasilnya: transisi menyambung mulus sepanjang ruang, blob shadow-fading
 * berukuran ~D_COR seperti seharusnya secara fisik — bukan noise
 * per-pixel acak. Statistik tetap sama (Box-Muller + clamp ±2σ), cuma
 * caranya "disebar" antar titik yang berubah.
 */
function cornerGaussian(cx,cy,seed){
  const s1=hashInt(cx*73856093^cy*19349663^seed),s2=hashInt(s1+2654435761);
  const u1=(s1>>>0)/4294967296+1e-10,u2=(s2>>>0)/4294967296+1e-10;
  return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
}
function smoothStep(t){ return t*t*(3-2*t); }

function spatialNoise(lat,lng,std,siteId,scenKey){
  let seed=0;for(let i=0;i<siteId.length;i++)seed=(seed*17+siteId.charCodeAt(i))&0xffff;
  const gridSize=D_COR_DEG[scenKey]||D_COR_DEFAULT;

  const fx=lat/gridSize, fy=lng/gridSize;
  const ix=Math.floor(fx), iy=Math.floor(fy);
  const tx=smoothStep(fx-ix), ty=smoothStep(fy-iy);

  const n00=cornerGaussian(ix,   iy,   seed);
  const n10=cornerGaussian(ix+1, iy,   seed);
  const n01=cornerGaussian(ix,   iy+1, seed);
  const n11=cornerGaussian(ix+1, iy+1, seed);

  const nx0 = n00*(1-tx) + n10*tx;
  const nx1 = n01*(1-tx) + n11*tx;
  const raw = (nx0*(1-ty) + nx1*ty) * std;

  // [FIX-2] Clamp ±2σ tetap dipertahankan — inline dengan simulation_dt.js
  return Math.max(-2*std, Math.min(2*std, raw));
}

// ── RSRP ──────────────────────────────────────────────────────────────────────
// [ALIGN] Formula disamakan persis dengan dtsimulation.js:
// RSRP = TX + G_E,max - CableLoss + G_h(θ) - PL - Lc + xi
// Sebelumnya G_E,max dan CableLoss tidak disertakan sama sekali, menyebabkan
// RSRP under-estimate ~7.5 dB dibanding dtsimulation.js untuk param RF yang sama.
function computeRSRP(dist,gainDb,hBS,sc,cond,lat,lon,siteId,clutter,P){
  const pl=pathLoss(sc,cond,dist,P.FREQUENCY,hBS,MOBILE_H);
  const cl=getClutterLoss(clutter);
  const scenKey=`${sc}_${cond}`;
  const xi=spatialNoise(lat,lon,getShadowStd(sc,cond),siteId,scenKey);
  return P.TX_POWER+P.ANTENNA_GAIN-P.CABLE_LOSS+gainDb-pl-cl+xi;
}

/**
 * [FIX-13] Varian DETERMINISTIK — sama persis dengan computeRSRP() tapi
 * TANPA suku shadow fading (xi). Dipakai KHUSUS untuk matrix visual/kontur.
 *
 * Alasan: tool RF planning nyata (Atoll, dsb) menampilkan prediksi RSRP
 * sebagai nilai deterministik (jarak + pola antena sektor + path loss +
 * clutter loss) — shadow fading di tool tersebut dipakai untuk perhitungan
 * probabilitas terpisah ("cell edge coverage probability"), BUKAN dirender
 * sebagai variasi warna acak per piksel. Itulah sebabnya plot Atoll terlihat
 * rapi & pola "kelopak" per sektor jelas — bukan soal grid/heatmap/kontur,
 * tapi soal APA yang digambar.
 *
 * `grids[]` (dipakai detectGaps/statistik/klik-detail) TETAP pakai
 * computeRSRP() dengan shadow fading seperti sebelumnya — tidak diubah,
 * supaya penilaian gap/blank-spot tetap mempertimbangkan variasi realistis.
 * Yang berubah HANYA matrix yang dipakai untuk kontur visual.
 */
function computeRSRPDeterministic(dist,gainDb,hBS,sc,cond,clutter,P){
  const pl=pathLoss(sc,cond,dist,P.FREQUENCY,hBS,MOBILE_H);
  const cl=getClutterLoss(clutter);
  return P.TX_POWER+P.ANTENNA_GAIN-P.CABLE_LOSS+gainDb-pl-cl;
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
// [ALIGN2] Fungsi-fungsi di bawah ini TIDAK LAGI dipakai untuk menentukan
// bentuk coverage (lihat calcCoverage — sekarang berbasis ambang RSRP riil,
// bukan radius+noise organik). Dipertahankan (tidak dihapus) untuk berjaga
// kalau ada bagian lain yang masih bergantung padanya, tapi tidak lagi
// berperan aktif di alur utama generateCoverage/calcCoverage.
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
  setT('badgeClutter',`${P.CLUTTER.replace('_',' ')}`);
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
  if(_coverageClickHandler){map.off('click',_coverageClickHandler);_coverageClickHandler=null;}
  clearGapLayer();populateSiteSearch();showUploadPrompt();
  removeBlankSpotNotification();
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
      const { grids, cellSizeM, gridMeta } = calcCoverage(allSites,gridSize,radius,antHeight,P);
      renderCoverageGrid(grids,currentCoverageType,gridMeta);

      siteLayer.remove();
      siteLayer.addTo(map);
      sectorLayer.remove();
      sectorLayer.addTo(map);

      window._lastCoverageGrids=grids;
      window._lastCellSizeM=cellSizeM; // [PERF-2] dipakai goToPlanning/sendCoverageToCompare supaya metadata konsisten dengan grid sebenarnya
      showSendToCompareBtn();
      const gaps=detectGaps(grids,allSites,cellSizeM);
      // [GAP-Z] renderGapLayer WAJIB dipanggil SETELAH renderCoverageGrid —
      // gapLayer selalu di-addTo(map) belakangan sehingga z-index-nya di
      // ATAS coverageLayer (grid). detectGaps() membaca g.rsrpValue MENTAH
      // dari grids[] (bukan warna/kategori cell), dan grids[] itu SENDIRI
      // tidak difilter oleh cutoff render di renderCoverageGrid (cutoff
      // di situ cuma menentukan digambar/tidak, bukan menghapus data) —
      // jadi akurasi deteksi blank-spot/weak-coverage tetap presisi 100%.
      renderGapLayer(gaps,allSites);
      showBlankSpotNotification(gaps);
      updateStats(grids,antHeight,allSites,gaps,P,cellSizeM);
      hideLoading();
    }catch(err){console.error(err);alert('Error: '+err.message);hideLoading();}
  },400);
}

function calcCoverage(allSites,gridSize,radius,antHeight,P){
  const mainSite=allSites[0].site;
  const mpdLat=111320,mpdLon=111320*Math.cos(mainSite.lat*Math.PI/180);
  const allLats=allSites.map(s=>s.site.lat),allLngs=allSites.map(s=>s.site.lng);

  // [ALIGN3] Bounding box pencarian dihitung dari FISIKA, bukan cuma angka
  // 'radius' manual. Kita hitung jarak boresight (arah terkuat) sampai
  // sinyal benar-benar menembus ambang terlemah (-145 dBm, sedikit di
  // bawah bin terlemah legend -140~-120), lalu pakai jarak itu (atau
  // 'radius' input user, mana yang lebih besar) sebagai luas pencarian.
  // [FIX-11] MAX_AUTO_RADIUS_M dinaikkan lagi 2000m → 5000m. Alasan
  // sebelumnya (PERF-1) diturunkan ke 2000m adalah supaya browser gak
  // macet render RIBUAN L.polygon per cell. Sekarang rendering utama
  // sudah CONTOUR (segelintir polygon per band, bukan per-cell), jadi
  // risiko itu sudah jauh berkurang — batas sekarang lebih ke soal waktu
  // KOMPUTASI (loop RSRP per site per cell) dan itu tetap dijaga aman oleh
  // PERF-2 (auto-coarsen grid, lihat MAX_CELLS di bawah).
  //
  // Kenapa ini penting: dengan cluster site yang rapat (banyak overlap),
  // gabungan sinyal dari 7 site bisa saja masih "hidup" (> RSRP_BLANK)
  // sampai ke tepi 2000m — sehingga kontur yang dihasilkan SELALU terlihat
  // memenuhi kotak pencarian, bukan karena bug, tapi karena area yang
  // dihitung belum cukup luas untuk sampai ke titik sinyal BENAR-BENAR
  // habis (bandingkan referensi Atoll: falloff kelihatan karena area yang
  // di-plot jauh lebih luas dari jangkauan gabungan site). Dengan radius
  // lebih luas, falloff natural (dan potensi blank spot beneran, kalau
  // ada) akan ikut ter-render, bukan terpotong batas komputasi.
  //
  // [SCOPE] Catatan penting: pencarian TETAP dibatasi ke bounding box
  // main site + hingga 6 neighbour (allSites) — bukan seluruh peta.
  // "Coverage tanpa batas warna/bentuk" di sini artinya bentuk akhirnya
  // organik (tidak dipaksa lingkaran/kotak), BUKAN berarti area
  // perhitungannya jadi tak terbatas — cakupan komputasi tetap terkontrol
  // sesuai cluster site yang sedang dipilih & parameter fisika mereka.
  // [FIX-14] BUG: sebelumnya searchRadius = Math.max(radius, physicsMaxDist)
  // — ini bikin radius yang lo SET DI UI TERABAIKAN kalau physicsMaxDist
  // (jarak ke ambang -145dBm, sengaja dibikin generous) lebih besar dari
  // radius input. Akibatnya set 500m tetap jadi luas beberapa km kalau TX
  // power/antenna gain cukup besar. Radius dari input UI sekarang jadi
  // KONTROL UTAMA (sesuai ekspektasi user) — physics cuma nambah MARGIN
  // KECIL (20%) di luar radius biar tepi kontur sempat fade natural,
  // bukan terpotong tegas persis di angka radius, dan TIDAK PERNAH
  // membesarkan area jauh melebihi yang diminta.
  const MAX_AUTO_RADIUS_M = 5000; // batas pengaman mutlak, jarang tersentuh sekarang
  const eirpBoresight = P.TX_POWER + P.ANTENNA_GAIN - P.CABLE_LOSS;
  const physicsMaxDist = solveMaxDistanceForThreshold(
    P.SCENARIO, P.CONDITION, P.FREQUENCY, antHeight, MOBILE_H, eirpBoresight, -145
  );
  // [FIX-15] Margin dinaikkan 1.2 → 1.6 (selaras dengan newsite.js) supaya
  // radius yang lo MINTA di UI tetap tampil full-strength, taper (lihat
  // FIX-15 di calcCoverage bagian bawah) baru mulai di ring buffer setelah
  // radius itu, bukan memakan area yang diminta.
  const FADE_MARGIN_FACTOR = 1.6;
  const searchRadius = Math.min(radius * FADE_MARGIN_FACTOR, MAX_AUTO_RADIUS_M);
  if (physicsMaxDist > searchRadius) {
    console.warn(`[calcCoverage] Radius input (${radius}m) lebih kecil dari jarak fisik ke ambang terlemah (~${Math.round(physicsMaxDist)}m) — beberapa titik di tepi bin terlemah legend mungkin belum sepenuhnya tercapai dalam radius ini. Perbesar radius kalau ingin melihat sebaran penuh sampai sinyal benar-benar habis.`);
  }

  const minLat=Math.min(...allLats)-searchRadius/mpdLat,maxLat=Math.max(...allLats)+searchRadius/mpdLat;
  const minLon=Math.min(...allLngs)-searchRadius/mpdLon,maxLon=Math.max(...allLngs)+searchRadius/mpdLon;

  // [PERF-2] Auto-coarsen grid: perkirakan dulu jumlah sel yang akan
  // dihitung dengan gridSize pilihan user. Kalau melebihi MAX_CELLS,
  // perbesar ukuran sel (dalam meter) secukupnya supaya total sel tetap
  // di bawah batas aman — mencegah browser macet tanpa membatalkan
  // perhitungan sama sekali. gridSize asli TIDAK PERNAH diperkecil
  // otomatis (hanya diperbesar/coarsen kalau memang perlu).
  // [FIX-11] Dinaikkan 20.000 → 45.000 sejalan dengan MAX_AUTO_RADIUS_M.
  // Batas lama itu dirancang waktu rendering masih 1 L.polygon per cell
  // (ribuan elemen DOM Leaflet = berat). Sekarang rendering utama pakai
  // CONTOUR (segelintir polygon per band threshold, bukan per-cell), jadi
  // beban render sudah jauh lebih ringan — sisa beban cuma di loop hitung
  // RSRP per site per cell (JS murni, jauh lebih murah daripada DOM).
  const MAX_CELLS = 45000;
  const areaWidthM  = (maxLon - minLon) * mpdLon;
  const areaHeightM = (maxLat - minLat) * mpdLat;
  const estCells = (areaWidthM / gridSize) * (areaHeightM / gridSize);
  let cellSizeM = gridSize;
  if (estCells > MAX_CELLS) {
    cellSizeM = Math.sqrt((areaWidthM * areaHeightM) / MAX_CELLS);
    console.warn(`[calcCoverage] Estimasi ${Math.round(estCells)} sel melebihi batas aman (${MAX_CELLS}) — grid otomatis diperkasar dari ${gridSize}m ke ~${Math.round(cellSizeM)}m untuk menjaga performa.`);
  }
  const dLat=cellSizeM/mpdLat, dLon=cellSizeM/mpdLon;

  // [CONTOUR] Loop berbasis INDEX INTEGER (bukan akumulasi float lat+=dLat)
  // supaya jumlah baris/kolom matrix PERSIS konsisten (tidak ada drift
  // pembulatan floating point yang bisa bikin matrix miss-align dengan
  // grids[]). numRows/numCols ini juga yang dipakai d3-contour untuk tau
  // bentuk (lebar x tinggi) data scalar field-nya.
  const numRows = Math.floor((maxLat-minLat)/dLat + 1e-9) + 1;
  const numCols = Math.floor((maxLon-minLon)/dLon + 1e-9) + 1;

  const grids=[];
  // [CONTOUR] Matrix paralel row-major (ri*numCols+ci), dipakai d3.contours().
  // Diisi bersamaan dengan grids[] supaya SATU sumber perhitungan fisika,
  // tidak ada duplikasi/inkonsistensi antara data untuk statistik (grids[])
  // dan data untuk visual (matrix).
  const rsrpMatrix = new Float64Array(numRows*numCols);
  const sinrMatrix = new Float64Array(numRows*numCols);

  for(let ri=0; ri<numRows; ri++){
    const lat = minLat + ri*dLat;
    for(let ci=0; ci<numCols; ci++){
      const lon = minLon + ci*dLon;
      // [ALIGN3] TIDAK ADA LAGI pembatas jarak melingkar di sini. Setiap
      // titik dalam bounding box (yang sudah dihitung cukup luas dari
      // fisika di atas) dihitung apa adanya — bentuk akhir yang muncul
      // murni dari kombinasi pola antena tiap sektor + path loss + clutter
      // riil, bukan dipotong paksa jadi lingkaran.
      const siteRSRPs=allSites.map(({id,site,isMain})=>{
        const dist=calcDistance({lat:site.lat,lng:site.lng},{lat,lng:lon});
        if(dist<1)return{id,rsrp:P.TX_POWER,gainDb:0,dist,sectorIdx:0,isMain,scenario:P.SCENARIO,condition:P.CONDITION};
        const brng=bearingTo(site.lat,site.lng,lat,lon);
        let gainDb=0,sectorIdx=0;
        if(site.sectors?.length){const b=bestSectorGain(brng,site.sectors,P.BEAMWIDTH,P.ANTENNA_Am);gainDb=b.gain;sectorIdx=b.sectorIdx;}
        const rsrp=computeRSRP(dist,gainDb,antHeight,P.SCENARIO,P.CONDITION,lat,lon,id,P.CLUTTER,P);
        return{id,rsrp,gainDb,dist,sectorIdx,isMain,scenario:P.SCENARIO,condition:P.CONDITION};
      });

      let best=siteRSRPs[0];
      siteRSRPs.forEach(s=>{if(s.rsrp>best.rsrp)best=s;});

      // [ALIGN3] TIDAK ADA LAGI pemotongan berdasar ambang RSRP di sini.
      // Semua titik dalam bounding box tetap ditampilkan APA ADANYA
      // (termasuk yang sangat lemah, jatuh ke kategori S5/S6/merah tua) —
      // ini sesuai desain legend asli yang memang mencakup bin -140~-120.
      // Klasifikasi "blank spot" tetap ditangani terpisah oleh
      // detectGaps() (yang punya definisi & tujuan analisis sendiri),
      // bukan dengan menyembunyikan titik lemah dari visualisasi utama.

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

      // [FIX-13] Nilai DETERMINISTIK (tanpa shadow fading) khusus untuk
      // matrix visual/kontur. Serving site TETAP mengikuti keputusan
      // kompetisi multi-site yang sama (best.id, dari nilai ber-noise) —
      // supaya "site mana yang melayani titik ini" tetap satu sumber
      // kebenaran dengan grids[]/handover-zone. Yang dibersihkan dari
      // noise HANYA besaran (magnitude) RSRP/SINR yang digambar.
      const rsrpDetRaw = computeRSRPDeterministic(best.dist, best.gainDb, antHeight, P.SCENARIO, P.CONDITION, P.CLUTTER, P);
      const rsrpServingDet = Math.max(RX_SENSITIVITY_FLOOR, rsrpDetRaw);
      const interfRSRPsDet = siteRSRPs.filter(s=>s.id!==best.id).map(s=>
        Math.max(RX_SENSITIVITY_FLOOR, computeRSRPDeterministic(s.dist, s.gainDb, antHeight, P.SCENARIO, P.CONDITION, P.CLUTTER, P))
      );
      const sinrValDet = computeSINR(rsrpServingDet, interfRSRPsDet, P);

      const mi = ri*numCols+ci;

      // [FIX-15] EDGE TAPER — murni kosmetik, HANYA untuk matrix visual
      // (rsrpMatrix/sinrMatrix), TIDAK menyentuh grids[]/detectGaps()/
      // statistik sama sekali. Sama konsep dengan newsite.js: box pencarian
      // itu PERSEGI (jarak searchRadius sama ke 4 sisi dari bounding box
      // cluster), sementara pola sinyal gabungan multi-site + multi-sektor
      // itu gak seragam ke segala arah — di "lembah" antar sektor (atau di
      // titik yang dekat ke site paling pinggir cluster), sinyal cuma
      // diredam sampai Am, bukan nol, jadi bisa "hidup" tepat sampai SISI
      // kotak (titik terdekat), walau di SUDUT kotak (lebih jauh) sudah
      // pudar duluan. Fix: makin dekat ke sisi kotak MANAPUN, makin
      // diredam paksa — dijamin habis sebelum tepi dari arah manapun.
      const distToEdgeM = Math.min(
        (lat - minLat) * mpdLat, (maxLat - lat) * mpdLat,
        (lon - minLon) * mpdLon, (maxLon - lon) * mpdLon
      );
      const taperZoneM = searchRadius * 0.35; // 35% terluar mulai diredam
      const taperT = Math.max(0, Math.min(1, 1 - distToEdgeM / taperZoneM));
      const taperSmooth = taperT * taperT * (3 - 2 * taperT); // smoothstep
      const taperDb = taperSmooth * 45; // sampai -45dB tepat di tepi kotak

      // [FIX-16] Sinkronkan definisi "blank" antara VISUAL kontur dan
      // ANALISIS detectGaps(): sebelumnya rsrpMatrix (kontur) murni pakai
      // nilai deterministik, sehingga titik yang secara nilai BER-NOISE
      // (grids[].rsrpValue) sudah dianggap blank oleh detectGaps() —
      // bisa saja tetap tampil "biru/aman" di kontur (karena deterministik
      // membuang noise negatif yang bikin titik itu jatuh di bawah ambang).
      // Akibatnya: notifikasi/marker 🚫 tetap benar muncul di titik itu,
      // TAPI visual kontur gak nunjukin lubang di lokasi yang sama —
      // membingungkan karena dua sumber (visual vs analitik) kelihatan
      // gak sinkron. Sekarang: kalau grids[] (rsrpServing, ber-noise) SUDAH
      // dianggap blank, paksa rsrpMatrix ikut jadi sangat rendah juga
      // (bikin lubang di kontur persis di situ) — di luar titik itu, tetap
      // pakai nilai deterministik seperti biasa (petal tetap mulus).
      rsrpMatrix[mi] = rsrpServing < GAP_CFG.RSRP_BLANK
        ? (GAP_CFG.RSRP_BLANK - 15) // pasti di bawah band kontur terlemah manapun
        : (rsrpServingDet - taperDb);
      // [BLANK-UNIFIED] Keputusan "area ini blank atau tidak" TETAP pakai
      // rsrpServing (nilai ber-noise, sama seperti detectGaps()) — satu
      // sumber kebenaran untuk "coverage exist". Hanya BESARAN SINR yang
      // ditampilkan (kalau area lolos) yang dibersihkan dari noise dan
      // kena taper yang sama biar kontur SINR juga fade konsisten di tepi.
      sinrMatrix[mi] = rsrpServing < GAP_CFG.RSRP_BLANK ? (P.SINR_FLOOR-1) : (sinrValDet - taperSmooth*20);
    }
  }
  console.log(`[v10.3] ${grids.length} cells (${numRows}x${numCols}, cellSize=${Math.round(cellSizeM)}m, searchRadius=${Math.round(searchRadius)}m) | h=${antHeight}m | ${P.SCENARIO.toUpperCase()} ${P.CONDITION.toUpperCase()} | ${P.FREQUENCY}MHz ${P.BANDWIDTH}MHz BW | TX ${P.TX_POWER}dBm | ${P.CLUTTER} | DomIntf±${DOMINANT_INTERFERER_THRESHOLD_DB}dB`);
  return {
    grids, cellSizeM,
    gridMeta: { numRows, numCols, minLat, minLon, dLat, dLon, rsrpMatrix, sinrMatrix }
  };
}

// ══════════════════════════════════════════════════════════════════════════
// [CONTOUR v9 — ISOBAND] Visualisasi coverage pakai CONTOUR/ISOBAND (marching
// squares via d3-contour, lisensi BSD-3-Clause — bukan MarchingSquares.js yang
// AGPL-3.0, supaya aman dipakai komersial). Ini opsi ke-3 dari 3 yang dibahas
// (grid kotak / heatmap blur / contour) — dipilih karena satu-satunya yang
// sekaligus (a) bentuknya organik murni dari data asli (bukan ditebak/blur),
// (b) presisi datanya gak hilang, dan (c) blank spot muncul otomatis sebagai
// LUBANG di dalam kontur — gak perlu hack cutoff manual kayak sebelumnya.
//
// PENTING: butuh <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
// ditambahkan di HTML SEBELUM <script src="coverage.js">. Kalau d3 belum ada,
// otomatis fallback ke grid per-cell (v8.1) — halaman tetap jalan, cuma
// visualnya balik kotak-kotak sampai script d3 ditambahkan.
//
// CARA KERJA (painter's algorithm, bukan boolean subtract):
// d3.contours() menghitung "semua area dengan value ≥ threshold" (termasuk
// lubang di dalamnya kalau ada area lemah di tengah area kuat). Kalau kita
// gambar dari threshold TERLEMAH (base, warna S4) → makin KUAT (S1) secara
// berurutan, tiap layer yang lebih kuat otomatis LEBIH KECIL & digambar DI
// ATAS layer sebelumnya (Leaflet: layer yang ditambah belakangan tampil di
// atas) — hasil visualnya persis isoband, tanpa perlu hitung selisih polygon
// secara eksplisit.
//
// [BLANK-UNIFIED] Base layer (threshold TERLEMAH) = GAP_CFG.RSRP_BLANK
// persis. Area di bawah itu TIDAK PERNAH digambar sama sekali (bukan hole
// buatan, tapi memang gak masuk kriteria threshold manapun) — jadi definisi
// "coverage exist" tetap SATU SUMBER, sama persis dengan yang dipakai
// detectGaps(). Kalau di tengah cluster ada titik yang secara fisik gak
// tercover site manapun (RSRP semua site < -120 di situ), d3.contours()
// otomatis menghasilkan LUBANG geometris di kontur — itulah "blank spot"
// yang muncul natural di tengah, sesuai yang lo maksud.
// ══════════════════════════════════════════════════════════════════════════

// [FIX-12] Anchor kategori tetap sama persis dengan legend (S1-S5) — supaya
// statistik/legend/persentase yang ditampilkan tetap konsisten dengan warna
// yang dilihat. TAPI untuk kontur, anchor ini "dipecah" jadi banyak
// sub-threshold (tiap STEP_DB) dengan warna hasil interpolasi linear antar
// anchor — inilah yang bikin gradasi terlihat halus & granular gaya Atoll
// (bukan cuma 4-5 blok besar), sekaligus memperjelas "benturan" sinyal antar
// sektor/site karena transisi kekuatan sinyal jadi lebih presisi divisualkan.
const CONTOUR_ANCHORS = {
  rsrp: [
    { min: GAP_CFG.RSRP_BLANK, color: '#fffb00' }, // S4 basis (di bawah ini = blank, tidak digambar)
    { min: -105,               color: '#70ff66' }, // S3
    { min: -95,                color: '#00a955' }, // S2
    { min: -85,                color: '#0042a5' }, // S1
    { min: -75,                color: '#00286b' }, // ekor atas S1 (super kuat, dekat site) — sedikit lebih gelap
  ],
  sinr: [
    { min: -10, color: '#ff3333' }, // S5 basis
    { min: -5,  color: '#fffb00' }, // S4
    { min: 0,   color: '#70ff66' }, // S3
    { min: 10,  color: '#00a955' }, // S2
    { min: 20,  color: '#0042a5' }, // S1
    { min: 30,  color: '#00286b' },
  ],
};
const STEP_DB = 3; // resolusi sub-threshold — makin kecil, makin halus gradasinya

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
    for(let s=0;s<steps;s++){
      const t = s/steps;
      out.push({ min: a.min + span*t, color: lerpColor(a.color, b.color, t) });
    }
  }
  out.push(anchors[anchors.length-1]);
  return out; // ascending, terlemah → terkuat
}
const CONTOUR_THRESHOLDS = { rsrp: buildFineThresholds('rsrp'), sinr: buildFineThresholds('sinr') };

let _coverageClickHandler = null; // dipakai untuk lepas-pasang listener klik detail-titik

function renderCoverageGrid(grids, type, gridMeta){
  if (coverageLayer) { map.removeLayer(coverageLayer); coverageLayer = null; }
  if (_coverageClickHandler) { map.off('click', _coverageClickHandler); _coverageClickHandler = null; }
  if (!grids.length) return;

  if (typeof d3 === 'undefined' || !d3.contours || !gridMeta) {
    console.warn('[CONTOUR] d3-contour tidak terdeteksi — fallback ke grid per-cell. Tambahkan <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"> sebelum coverage.js untuk mengaktifkan contour.');
    return renderCoverageGridFallback(grids, type);
  }

  const { numRows, numCols, minLat, minLon, dLat, dLon, rsrpMatrix, sinrMatrix } = gridMeta;
  const matrix = type==='rsrp' ? rsrpMatrix : sinrMatrix;
  const bands  = CONTOUR_THRESHOLDS[type];

  // d3.contours bekerja di ruang index (x=kolom 0..numCols-1, y=baris 0..numRows-1).
  // Konversi balik ke lat/lon pakai posisi grid asli.
  function idxToLatLng([x,y]){ return [minLat + y*dLat, minLon + x*dLon]; }
  function polygonToLatLngRings(polygon){ return polygon.map(ring => ring.map(idxToLatLng)); }

  const contourGen = d3.contours().size([numCols, numRows]);
  const lg = L.layerGroup();
  let _polyCount = 0;

  bands.forEach(band => {
    let multiPolygon;
    try {
      // [FIX-10] API d3-contour yang BENAR untuk single-threshold adalah
      // contours.contour(values, threshold) — BUKAN .threshold(x)(values)
      // (itu method yang gak ada). Kesalahan ini kemarin bikin semua band
      // diam-diam gagal/kosong, sehingga tidak ada apa pun yang tergambar
      // di peta walau grids[]/statistik tetap benar (dihitung terpisah).
      multiPolygon = contourGen.contour(matrix, band.min); // GeoJSON MultiPolygon {type,coordinates,value}
    } catch(e){ console.warn('[CONTOUR] gagal hitung threshold', band.min, e); return; }
    if (!multiPolygon?.coordinates?.length) return;

    multiPolygon.coordinates.forEach(polygonRings => {
      const latlngRings = polygonToLatLngRings(polygonRings); // [outerRing, holeRing1, ...]
      L.polygon(latlngRings, {
        stroke: false, fillColor: band.color, fillOpacity: 0.68,
      }).addTo(lg);
      _polyCount++;
    });
  });

  console.log(`[CONTOUR] ${_polyCount} polygon digambar dari ${bands.length} band threshold (${type})`);
  coverageLayer = lg.addTo(map);

  // [PROBE] Karena kontur adalah polygon besar (bukan per-cell lagi), detail
  // presisi per-titik dikasih lewat klik peta: cari cell terdekat dari data
  // MENTAH (grids[], tidak berubah sama sekali) lalu tampilkan popup — jadi
  // presisi data TIDAK hilang, cuma cara aksesnya lewat klik, bukan hover
  // per-kotak seperti grid.
  _coverageClickHandler = function(e){
    if (!window._lastCoverageGrids?.length) return;
    const clat=e.latlng.lat, clon=e.latlng.lng;
    let nearest=null, nd=Infinity;
    for (const g of window._lastCoverageGrids){
      const dd=(g.lat-clat)**2+(g.lon-clon)**2;
      if (dd<nd){ nd=dd; nearest=g; }
    }
    if (!nearest) return;

    // [FIX-19] BUG: pencarian "cell terdekat" di atas TIDAK PUNYA batas
    // jarak maksimum — jadi klik di mana pun di peta (bahkan jauh di luar
    // area yang benar-benar dihitung) selalu menemukan "cell terdekat" dan
    // menampilkannya seolah itu nilai di titik yang diklik. Itu keliru:
    // titik di luar area simulasi memang TIDAK PERNAH dihitung sama sekali.
    // Fix: hitung jarak METER asli (bukan cuma selisih derajat) dari titik
    // klik ke cell terdekat, dan tolak kalau jaraknya melebihi ~1.5x ukuran
    // cell — itu artinya klik jatuh di luar grid yang dihitung, bukan
    // representasi titik itu.
    const distToNearestM = calcDistance({lat: nearest.lat, lng: nearest.lon}, {lat: clat, lng: clon});
    const maxAllowedM = (window._lastCellSizeM || 50) * 1.5;
    if (distToNearestM > maxAllowedM) {
      L.popup({maxWidth:240})
        .setLatLng(e.latlng)
        .setContent(`<div style="font-family:Arial,sans-serif;font-size:12.5px;color:#888;text-align:center;padding:4px 2px;">📍 Di luar area simulasi<br><span style="font-size:11px;">Titik ini belum pernah dihitung</span></div>`)
        .openOn(map);
      return;
    }

    const unit = currentCoverageType==='rsrp' ? 'dBm' : 'dB';
    const val  = currentCoverageType==='rsrp' ? nearest.rsrpValue : nearest.sinrValue;
    const cat  = currentCoverageType==='rsrp' ? getRSRPCategory(nearest.rsrpValue) : getSINRCategory(nearest.sinrValue);
    const ml   = `${nearest.scenario.toUpperCase()} ${nearest.condition.toUpperCase().replace('_','/')}`;
    const rows = nearest.allRSRPs.slice().sort((a,b)=>b.rsrp-a.rsrp).map(s=>{
      const sv = s.id===nearest.servingSiteId;
      return `<tr style="${sv?'font-weight:bold;color:#00c7be':'color:#aaa'}"><td>${sv?'▶':'&nbsp;'} ${s.id}</td><td>${s.rsrp} dBm</td></tr>`;
    }).join('');
    L.popup({maxWidth:280})
      .setLatLng(e.latlng)
      .setContent(`<div style="font-family:Arial,sans-serif;min-width:190px"><h4 style="margin:0 0 6px;">${currentCoverageType.toUpperCase()}: ${val.toFixed(1)} ${unit}</h4><p style="margin:2px 0"><b>Category:</b> ${getCategoryName(cat)}</p><p style="margin:2px 0"><b>Serving:</b> <span style="color:#00c7be">${nearest.servingSiteId}</span>${nearest.isMain?' ★':''}</p><p style="margin:2px 0"><b>Dist:</b> ${Math.round(nearest.dist)} m | <b>Model:</b> ${ml}</p><p style="margin:2px 0"><b>RSRP:</b> ${nearest.rsrpValue} dBm | <b>SINR:</b> ${nearest.sinrValue.toFixed(1)} dB</p><hr style="border-color:#eee;margin:6px 0"><table style="font-size:0.78rem;width:100%">${rows}</table></div>`)
      .openOn(map);
  };
  map.on('click', _coverageClickHandler);
}

// [FALLBACK] Grid per-cell v8.1 (dipertahankan) — dipakai otomatis kalau
// script d3 belum di-include di HTML, supaya halaman tetap fungsional.
function renderCoverageGridFallback(grids,type){
  const lg = L.layerGroup();
  const unit = type==='rsrp' ? 'dBm' : 'dB';

  grids.forEach(g => {
    if (g.rsrpValue < GAP_CFG.RSRP_BLANK) return; // [FIX-8] tetap sama: skip blank spot

    const ml = `${g.scenario.toUpperCase()} ${g.condition.toUpperCase().replace('_','/')}`;
    const bCol = g.isVoronoiBorder ? SITE_BORDER_COLORS[g.siteColorIdx] : g.color;
    const bW   = g.isVoronoiBorder ? 1.2 : 0;
    const rows = g.allRSRPs.slice().sort((a,b)=>b.rsrp-a.rsrp).map(s=>{
      const sv = s.id===g.servingSiteId;
      return `<tr style="${sv?'font-weight:bold;color:#00c7be':'color:#aaa'}"><td>${sv?'▶':'&nbsp;'} ${s.id}</td><td>${s.rsrp} dBm</td></tr>`;
    }).join('');

    L.polygon(g.bounds, {
      color: bCol, fillColor: g.color, fillOpacity: 0.72,
      weight: bW, opacity: bW ? 0.85 : 0,
    })
    .bindPopup(`<div style="font-family:Arial,sans-serif;min-width:190px"><h4 style="margin:0 0 6px;color:${g.color}">${type.toUpperCase()}: ${g.value} ${unit}</h4><p style="margin:2px 0"><b>Category:</b> ${getCategoryName(g.category)}</p><p style="margin:2px 0"><b>Serving:</b> <span style="color:#00c7be">${g.servingSiteId}</span>${g.isMain?' ★':''}</p><p style="margin:2px 0"><b>Dist:</b> ${Math.round(g.dist)} m | <b>Model:</b> ${ml}</p><p style="margin:2px 0"><b>RSRP:</b> ${g.rsrpValue} dBm | <b>SINR:</b> ${g.sinrValue.toFixed(1)} dB</p><hr style="border-color:#eee;margin:6px 0"><table style="font-size:0.78rem;width:100%">${rows}</table></div>`)
    .addTo(lg);
  });

  coverageLayer = lg.addTo(map);
}

// ── Stats & legend ────────────────────────────────────────────────────────────
function updateStats(grids,antHeight,allSites,gaps,P,cellSizeM){
  const gs=cellSizeM||parseInt(document.getElementById('gridSize').value),cats={};
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
// [GAP-INDEP] detectGaps() SEPENUHNYA independen dari cara heatmap
// digambar. Fungsi ini membaca g.rsrpValue MENTAH (angka dBm hasil
// computeRSRP), bukan g.color / g.category / hasil blur apapun. Jadi
// walau visualisasi berubah total dari grid-kotak → heatmap halus,
// akurasi deteksi blank-spot/weak-coverage di bawah ini TIDAK berubah
// sama sekali — termasuk kasus "area di tengah antar-site" yang secara
// visual heatmap terlihat menyatu/hijau, tapi kalau rsrpValue aktualnya
// di bawah ambang GAP_CFG.RSRP_BLANK/RSRP_WEAK, tetap akan terdeteksi
// dan muncul sebagai marker 🚫/⚠️ (lihat renderGapLayer).
function detectGaps(grids,allSites,gridSize){
  // [FIX-17b] weak_coverage sekarang DIPERLUAS: sel dianggap weak kalau
  // RSRP-nya di rentang lemah (seperti sebelumnya) ATAU RSRP-nya OK tapi
  // SINR-nya jelek (interferensi antar site). Ini BUKAN kategori baru —
  // tetap masuk 'weak_coverage', tetap dapat marker ⚠️, tetap ikut alur
  // notifikasi & tombol "Rencanakan Site Baru" yang SUDAH ADA sejak awal.
  // Alasan: di cluster site padat/overlap, RSRP hampir selalu bagus
  // (minimal 1 site jangkau), jadi blank/weak berbasis RSRP saja jarang
  // trigger — padahal SINR bisa tetap jelek karena saling interferensi.
  // Menggabungnya ke weak_coverage (bukan bikin tipe terpisah) memastikan
  // kasus ini tetap terdeteksi & tetap bisa dioptimasi lewat Blank Spot
  // Optimizer yang sudah dirancang, tanpa menambah kompleksitas baru.
  const weakGrids=grids.filter(g=>
    (g.rsrpValue>=GAP_CFG.RSRP_BLANK&&g.rsrpValue<GAP_CFG.RSRP_WEAK) ||
    (g.sinrValue<GAP_CFG.SINR_POOR&&g.rsrpValue>=GAP_CFG.RSRP_WEAK)
  );
  const blankGrids=grids.filter(g=>g.rsrpValue<GAP_CFG.RSRP_BLANK);
  const mainSite=allSites[0].site;
  const mpdLat=111320,mpdLon=111320*Math.cos(mainSite.lat*Math.PI/180);
  const radius=parseInt(document.getElementById('coverageRadius').value);
  const dLat=gridSize/mpdLat,dLon=gridSize/mpdLon;
  const covSet=new Set(grids.map(g=>`${Math.round(g.lat/dLat)},${Math.round(g.lon/dLon)}`));
  const clIds=new Set(allSites.map(s=>s.id));
  const allNet = allSites.map(({id, site}) => ({id, site}));
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
  function meta(cells,type,idx){
    const aLat=cells.reduce((s,c)=>s+c.lat,0)/cells.length,aLon=cells.reduce((s,c)=>s+c.lon,0)/cells.length;
    const vR=cells.filter(c=>c.rsrpValue>-900),aR=vR.length?vR.reduce((s,c)=>s+c.rsrpValue,0)/vR.length:null,mR=vR.length?Math.min(...vR.map(c=>c.rsrpValue)):null;
    // [FIX-17b] Statistik SINR ikut dihitung (berguna buat weak_coverage
    // yang trigger-nya dari SINR jelek, biar popup tetap informatif).
    const vS=cells.filter(c=>c.sinrValue!==undefined),aS=vS.length?vS.reduce((s,c)=>s+c.sinrValue,0)/vS.length:null,mS=vS.length?Math.min(...vS.map(c=>c.sinrValue)):null;
    const mD=Math.max(...cells.map(c=>calcDistance({lat:aLat,lng:aLon},{lat:c.lat,lng:c.lon}))),eR=Math.max(mD+gridSize,gridSize*2);
    let ns=null,nd=Infinity;allSites.forEach(({id,site})=>{const d=calcDistance({lat:aLat,lng:aLon},{lat:site.lat,lng:site.lng});if(d<nd){nd=d;ns=id;}});
    return{clusterIdx:idx,type,cells,centroidLat:aLat,centroidLon:aLon,
      avgRSRP:aR!==null?Math.round(aR*10)/10:null,minRSRP:mR!==null?Math.round(mR*10)/10:null,
      avgSINR:aS!==null?Math.round(aS*10)/10:null,minSINR:mS!==null?Math.round(mS*10)/10:null,
      cellCount:cells.length,estimatedRadiusM:Math.round(eR),nearestSiteId:ns,nearestSiteDist:Math.round(nd),areaSqKm:(cells.length*(gridSize/1000)**2).toFixed(3)};
  }
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
  // [GAP-Z] gapLayer di-addTo(map) di sini, SETELAH coverageLayer sudah
  // ditambahkan di renderCoverageGrid (dipanggil lebih dulu di
  // generateCoverage). Leaflet menumpuk layer sesuai urutan add — jadi
  // gapLayer (polygon + marker 🚫/⚠️) selalu tampil DI ATAS kontur,
  // tidak akan "ketelen" warna di baliknya.
  gapLayer=L.layerGroup().addTo(map);
  gaps.forEach((cl,idx)=>{
    const isBlank=cl.type==='blank_spot',mc=isBlank?'#ff3b30':'#ff9500';
    const pts=[];cl.cells.forEach(c=>{c.bounds.forEach(p=>pts.push(p));});
    const hull=convexHull(pts);
    if(hull.length>=3)L.polygon(hull,{color:mc,fillColor:mc,fillOpacity:isBlank?0.35 : 0.10,weight:isBlank?2:1.5,opacity:0.9,dashArray:'5 4'}).addTo(gapLayer);
    const icon=L.divIcon({className:'',iconSize:[20,20],iconAnchor:[10,10],html:`<div style="width:20px;height:20px;background:${mc};border:1.5px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;cursor:pointer;opacity:0.9;">${isBlank?'🚫':'⚠️'}</div>`});
    const sev=cl.cellCount>20?'Kritis':cl.cellCount>8?'Sedang':'Ringan';
    // [FIX-17b] Kalau cluster weak_coverage ini SINR-driven (RSRP-nya
    // sebenarnya sudah OK), tampilkan info SINR juga di popup — biar jelas
    // kenapa area ini dianggap weak (bukan cuma dari RSRP).
    const sinrDriven = cl.avgRSRP!==null && cl.avgRSRP>=GAP_CFG.RSRP_WEAK && cl.avgSINR!==null;
    const rRow = cl.avgRSRP!==null
      ? `<tr><td style="color:#888">Avg RSRP</td><td><b style="color:${mc}">${cl.avgRSRP} dBm</b></td></tr><tr><td style="color:#888">Min RSRP</td><td><b>${cl.minRSRP} dBm</b></td></tr>${sinrDriven?`<tr><td style="color:#888">Avg SINR</td><td><b style="color:#9b59b6">${cl.avgSINR} dB</b></td></tr><tr><td style="color:#888">Min SINR</td><td><b>${cl.minSINR} dB</b></td></tr>`:''}`
      : `<tr><td colspan="2" style="color:#f66"><b>Tidak ada sinyal</b></td></tr>`;
    const noteHtml = sinrDriven ? `<p style="font-size:0.72rem;color:#9b59b6;margin:4px 0 0">📡 Terdeteksi dari SINR jelek (interferensi antar site), RSRP di area ini sebenarnya cukup</p>` : '';
    L.marker([cl.centroidLat,cl.centroidLon],{icon}).addTo(gapLayer)
      .bindPopup(`<div style="font-family:Arial,sans-serif;min-width:230px"><div style="background:${mc};color:#fff;padding:7px 10px;margin:-14px -14px 10px;border-radius:4px 4px 0 0"><b>${isBlank?'🚫 Blank Spot':'⚠️ Weak Coverage'} #${idx+1}</b><span style="float:right;font-size:0.75rem">${sev}</span></div><table style="font-size:12px;width:100%;border-collapse:collapse">${rRow}<tr><td style="color:#888">Luas</td><td><b>${cl.areaSqKm} km²</b></td></tr><tr><td style="color:#888">Est. Radius</td><td><b>~${cl.estimatedRadiusM} m</b></td></tr><tr><td style="color:#888">Site Terdekat</td><td><b style="color:#00c7be">${cl.nearestSiteId}</b> (${cl.nearestSiteDist} m)</td></tr><tr><td style="color:#888">Koordinat</td><td style="font-size:11px">${cl.centroidLat.toFixed(5)}, ${cl.centroidLon.toFixed(5)}</td></tr></table>${noteHtml}<div style="margin-top:9px;padding-top:8px;border-top:1px solid #eee"><button data-cl='${JSON.stringify({clusterIdx:cl.clusterIdx,type:cl.type,centroidLat:cl.centroidLat,centroidLon:cl.centroidLon,avgRSRP:cl.avgRSRP,minRSRP:cl.minRSRP,estimatedRadiusM:cl.estimatedRadiusM,areaSqKm:cl.areaSqKm,cellCount:cl.cellCount,nearestSiteId:cl.nearestSiteId,nearestSiteDist:cl.nearestSiteDist}).replace(/'/g,'&#39;')}' onclick="goToPlanning(this.dataset.cl)" style="width:100%;padding:7px;background:linear-gradient(135deg,#1F3C88,#00c7be);color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">📍 Rencanakan Site Baru</button></div></div>`,{maxWidth:280});
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
// [FIX-20] BUG diperbaiki: sebelumnya goToPlanning(idx) cuma nerima INDEX,
// lalu di dalam fungsi baru re-lookup `window._gapClusters[idx]`. Masalahnya:
// popup di-bind sebagai HTML STATIS sekali waktu render (bindPopup), tapi
// `onclick` di dalamnya baru DIEKSEKUSI saat tombol benar-benar diklik —
// bisa jadi lama setelah popup dibuka. Kalau di rentang waktu itu
// `window._gapClusters` sempat berubah isi/urutan (misalnya autoRegenerate()
// keplincut jalan karena ada input yang somehow ke-trigger, atau user
// generate ulang di tab/site lain), maka idx yang sama akan menunjuk ke
// CLUSTER YANG BEDA dari yang popup-nya sedang dibaca user — persis kasus
// "klik cluster A, kedirect data cluster B".
//
// Fix: cluster diteruskan sebagai DATA LENGKAP (JSON di-escape ke atribut),
// bukan index — jadi apa pun yang terjadi pada window._gapClusters setelah
// popup dibuka, tombol tetap merujuk ke cluster yang PERSIS sama dengan
// yang lagi ditampilkan di popup itu (snapshot at bind-time, bukan
// lookup-at-click-time).
function goToPlanning(clusterData){
  const cl = typeof clusterData === 'string' ? JSON.parse(clusterData) : clusterData;
  if (!cl) return;
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
    // [PERF-2] Pakai cellSizeM AKTUAL (bisa jadi sudah di-auto-coarsen),
    // bukan angka input mentah — supaya newsite.js merekonstruksi grid
    // dengan ukuran sel yang sama persis dengan yang sedang ditampilkan.
    gridSize: window._lastCellSizeM || parseInt(document.getElementById('gridSize').value),
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

  // Data gap (behaviour lama — tidak berubah, cuma sumber cl-nya yang dibetulkan)
  sessionStorage.setItem(GAP_PLANNING_KEY,JSON.stringify({source:'coverage_gap_detector',timestamp:new Date().toISOString(),mainSiteId:selectedSite,gapType:cl.type,recommendedLat:cl.centroidLat,recommendedLng:cl.centroidLon,gapIndex:(cl.clusterIdx??0)+1,avgRSRP_dBm:cl.avgRSRP,minRSRP_dBm:cl.minRSRP,estimatedRadius_m:cl.estimatedRadiusM,areaSqKm:parseFloat(cl.areaSqKm),cellCount:cl.cellCount,nearestSiteId:cl.nearestSiteId,nearestSiteDist_m:cl.nearestSiteDist,nearestSiteLat:site?.lat||null,nearestSiteLng:site?.lng||null,nearestSiteHeight:site?.height||null,nearestSiteClutter:site?.clutter||null,severityLabel:cl.cellCount>20?'Kritis':cl.cellCount>8?'Sedang':'Ringan'}));
  window.location.href=PLANNING_PAGE;
}

function toggleGapLayer(){
  if(!gapLayer)return;
  const btn=document.getElementById('toggleGapBtn');
  if(gapVisible){map.removeLayer(gapLayer);gapVisible=false;if(btn)btn.textContent='👁 Tampilkan Gap';}
  else{gapLayer.addTo(map);gapVisible=true;if(btn)btn.textContent='🙈 Sembunyikan Gap';}
}
function clearGapLayer(){if(gapLayer){map.removeLayer(gapLayer);gapLayer=null;}gapVisible=true;window._gapClusters=null;updateGapBadge(0,0);removeBlankSpotNotification();}
function updateGapBadge(b,w){
  const el=document.getElementById('gapBadge');if(!el)return;
  const t=(b||0)+(w||0);
  if(t===0){el.textContent='✅ Tidak ada gap';el.style.background='rgba(26,90,26,0.85)';el.style.color='#6dff9a';el.style.borderColor='#34c759';}
  else{el.innerHTML=`🚫 ${b} blank &nbsp;|&nbsp; ⚠️ ${w} weak`;el.style.background='rgba(60,10,10,0.85)';el.style.color='#ff9500';el.style.borderColor='#ff3b30';}
  el.style.display='inline-block';
}

// ══════════════════════════════════════════════════════════════════════════
// [NOTIF] Notifikasi blank spot — banner mengambang di atas peta, terpisah
// dari marker gap yang sudah ada (marker tetap dipertahankan untuk detail
// per-cluster). Banner ini memberi ringkasan langsung ("N blank spot
// terdeteksi") dan tombol yang mengarahkan ke halaman Blank Spot Optimizer
// (cluster blank spot terbesar — gaps sudah terurut prioritas: blank_spot
// dulu, lalu diurutkan cellCount menurun, jadi gaps[0] adalah kandidat
// paling signifikan untuk ditindaklanjuti).
// ══════════════════════════════════════════════════════════════════════════
function showBlankSpotNotification(gaps){
  removeBlankSpotNotification();
  if(!gaps||!gaps.length)return;

  const bC=gaps.filter(g=>g.type==='blank_spot');
  const wC=gaps.filter(g=>g.type==='weak_coverage');
  const totalArea=gaps.reduce((s,g)=>s+parseFloat(g.areaSqKm),0).toFixed(2);
  const primary=gaps[0]; // sudah terurut: blank_spot dulu, cellCount terbesar
  const primaryIdx=primary.clusterIdx;
  const isBlankPrimary=primary.type==='blank_spot';

  const mapContainer=document.getElementById('coverageMap');
  const host=mapContainer?.parentElement||document.body;
  if(host&&getComputedStyle(host).position==='static')host.style.position='relative';

  const el=document.createElement('div');
  el.id='blankSpotNotif';
  el.style.cssText=`
    position:absolute; top:14px; left:50%; transform:translateX(-50%);
    z-index:1000; background:${isBlankPrimary?'linear-gradient(135deg,#7a1f1f,#4a1010)':'linear-gradient(135deg,#8a5a10,#5a3a08)'};
    color:#fff; padding:10px 14px; border-radius:10px; box-shadow:0 4px 14px rgba(0,0,0,0.35);
    display:flex; align-items:center; gap:10px; font-family:Arial,sans-serif; font-size:13px;
    max-width:92%; border:1px solid rgba(255,255,255,0.2); animation:blankSpotFadeIn 0.25s ease-out;
  `;
  el.innerHTML=`
    <span style="font-size:18px;flex-shrink:0;">${isBlankPrimary?'🚫':'⚠️'}</span>
    <span style="line-height:1.4;">
      ${bC.length?`<b>${bC.length} Blank Spot</b>`:''}${bC.length&&wC.length?' &amp; ':''}${wC.length?`<b>${wC.length} Weak Coverage</b>`:''} terdeteksi
      <span style="opacity:0.75;"> (~${totalArea} km²)</span>
    </span>
    <button id="btnBlankSpotDetail" style="background:#fff;color:${isBlankPrimary?'#7a1f1f':'#8a5a10'};border:none;padding:6px 12px;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;white-space:nowrap;flex-shrink:0;">
      📍 Buka Blank Spot Optimizer
    </button>
    <button id="btnBlankSpotDismiss" style="background:transparent;color:#fff;border:none;font-size:16px;cursor:pointer;opacity:0.7;flex-shrink:0;line-height:1;">✕</button>
  `;
  if(!document.getElementById('blankSpotNotifStyle')){
    const style=document.createElement('style');
    style.id='blankSpotNotifStyle';
    style.textContent=`@keyframes blankSpotFadeIn{from{opacity:0;transform:translate(-50%,-8px);}to{opacity:1;transform:translate(-50%,0);}}`;
    document.head.appendChild(style);
  }
  host.appendChild(el);
  document.getElementById('btnBlankSpotDetail')?.addEventListener('click',()=>goToPlanning(primary));
  document.getElementById('btnBlankSpotDismiss').addEventListener('click',removeBlankSpotNotification);
}

function removeBlankSpotNotification(){
  document.getElementById('blankSpotNotif')?.remove();
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
    // [PERF-2] cellSizeM aktual (bisa auto-coarsen), bukan input mentah
    gridSize    : window._lastCellSizeM || parseInt(document.getElementById('gridSize').value),
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

console.log(
  'coverage.js v10.3 — probe klik dibatasi jarak (FIX-19), zona handover dicabut\n' +
  '  ✅ [FIX-19] BUG diperbaiki: probe klik-detail dulu nyari "cell terdekat"\n' +
  '     TANPA batas jarak maksimum — jadi klik di mana pun di peta (bahkan\n' +
  '     jauh di luar area yang benar-benar dihitung) selalu balikin data,\n' +
  '     seolah titik itu memang dihitung — padahal enggak. Sekarang jarak\n' +
  '     asli (meter, bukan cuma selisih derajat) ke cell terdekat dicek;\n' +
  '     kalau melebihi ~1.5x ukuran cell, popup nampilin "di luar area\n' +
  '     simulasi" alih-alih data yang salah.\n' +
  '  ℹ️  [REVERT] Zona handover (outline putus-putus + note di popup) yang\n' +
  '     ditambahkan sebelumnya DICABUT sesuai keputusan — fitur ini tidak\n' +
  '     dipakai. Data isVoronoiBorder tetap dihitung (dipakai teks "Handover\n' +
  '     zone: X%" di panel analisis), cuma tidak lagi divisualisasikan.\n' +
  '  ✅ [FIX-17b] weak_coverage DIPERLUAS (bukan kategori baru!): sel dengan\n' +
  '     RSRP OK (>= RSRP_WEAK) tapi SINR jelek (< GAP_CFG.SINR_POOR=-5dB)\n' +
  '     SEKARANG ikut dihitung sebagai weak_coverage — dapat marker ⚠️,\n' +
  '     ikut notifikasi, ikut tombol "Rencanakan Site Baru" SAMA seperti\n' +
  '     weak_coverage biasa. Ini nutup kasus dense/overlapping cluster di\n' +
  '     mana RSRP nyaris selalu bagus (minimal 1 site jangkau) sehingga\n' +
  '     blank/weak berbasis RSRP jarang trigger — padahal SINR bisa tetap\n' +
  '     jelek akibat interferensi antar site. (Revisi dari percobaan\n' +
  '     sebelumnya yang sempat bikin kategori terpisah "interference_zone"\n' +
  '     — ternyata kebanyakan kompleksitas & gak nyambung ke alur Blank\n' +
  '     Spot Optimizer yang sudah dirancang; sekarang disederhanakan jadi\n' +
  '     cuma memperluas definisi weak_coverage yang SUDAH ADA.)\n' +
  '  ✅ [FIX-16] Sinkronisasi definisi blank visual (kontur) vs analitik\n' +
  '     (detectGaps) — titik yang grids[] (ber-noise) anggap blank, kontur\n' +
  '     RSRP dipaksa ikut "berlubang" di lokasi sama, biar notifikasi &\n' +
  '     visual selalu senada, gak ada dua sumber kebenaran berbeda.\n' +
  '  ✅ [FIX-16] Root cause temuan "area blank di grid tapi tampak aman di\n' +
  '     kontur": rsrpMatrix (visual) pakai nilai deterministik (tanpa noise),\n' +
  '     sementara detectGaps() pakai grids[] ber-noise — titik yang jatuh\n' +
  '     blank AKIBAT noise negatif bisa tampil "biru/aman" di kontur padahal\n' +
  '     tetap terdeteksi & muncul marker 🚫 (dua sumber kebenaran gak sinkron\n' +
  '     secara visual). Sekarang: kalau grids[].rsrpValue (ber-noise) sudah\n' +
  '     dianggap blank oleh GAP_CFG.RSRP_BLANK, rsrpMatrix DIPAKSA ikut\n' +
  '     rendah juga (bikin lubang kontur persis di lokasi yang sama) — di\n' +
  '     luar titik itu tetap deterministik seperti biasa (petal tetap mulus).\n' +
  '  ✅ [FIX-15] Edge taper — root cause border kotak masih kelihatan tegas\n' +
  '     di beberapa sisi walau kontur sudah organik: box pencarian PERSEGI,\n' +
  '     tapi sinyal gabungan multi-site + multi-sektor gak seragam segala\n' +
  '     arah (lembah antar sektor / titik dekat site pinggir cluster cuma\n' +
  '     diredam sampai Am, bukan nol) — bisa "hidup" pas nyentuh SISI kotak\n' +
  '     (titik terdekat) walau SUDUT kotak (lebih jauh) sudah pudar duluan.\n' +
  '     Sekarang matrix visual (BUKAN grids[]/detectGaps()/statistik)\n' +
  '     diredam progresif makin dekat ke sisi kotak manapun. Margin\n' +
  '     dinaikkan 1.2×→1.6× (FADE_MARGIN_FACTOR) supaya radius yang\n' +
  '     diminta user tetap full-strength, taper cuma di ring buffer\n' +
  '     tambahan setelahnya.\n' +
  '  ✅ [FIX-14] Radius input = kontrol utama (searchRadius = Math.min(radius\n' +
  '     * FADE_MARGIN_FACTOR, MAX_AUTO_RADIUS_M), TIDAK lagi kalah sama\n' +
  '     physicsMaxDist yang generous)\n' +
  '  ✅ [FIX-14] BUG diperbaiki: searchRadius dulu = Math.max(radius, physicsMaxDist)\n' +
  '     — artinya radius yg lo SET DI UI bisa keimpa jarak fisika (-145dBm)\n' +
  '     yang sengaja generous, bikin area jadi jauh lebih luas dari yang\n' +
  '     diminta (mis. set 500m tp jadi ribuan meter). Sekarang radius input\n' +
  '     = kontrol utama, physics cuma nambah margin +20% biar tepi kontur\n' +
  '     sempat fade natural, TIDAK PERNAH membesarkan jauh dari permintaan.\n' +
  '  ⚠️  BUTUH <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js">\n' +
  '     ditambahkan SEBELUM <script src="coverage.js"> di HTML.\n' +
  '  ✅ [FIX-13] ROOT CAUSE "gak serapih Atoll" ketemu: bukan soal jenis\n' +
  '     visualisasi (grid/heatmap/kontur), tapi karena RSRP yang digambar\n' +
  '     SELAMA INI sudah termasuk shadow fading (noise acak per titik).\n' +
  '     Tool RF planning nyata (Atoll dkk) menggambar RSRP DETERMINISTIK\n' +
  '     (jarak+antena sektor+PL+clutter saja); shadow fading dipakai utk\n' +
  '     probabilitas terpisah, bukan warna piksel. Sekarang matrix visual\n' +
  '     (rsrpMatrix/sinrMatrix → kontur) pakai computeRSRPDeterministic()\n' +
  '     (tanpa noise) → pola "kelopak" per sektor jadi mulus & jelas.\n' +
  '     grids[] (dipakai detectGaps/statistik/klik-detail) TIDAK berubah,\n' +
  '     tetap pakai nilai ber-noise seperti sebelumnya — cuma matrix visual\n' +
  '     yang dibersihkan.\n' +
  '  ✅ [FIX-6] antennaGain() dibetulkan: offset/(bw/2) → offset/bw\n' +
  '  ✅ [FIX-10] API d3-contour dibetulkan: contours.contour(values,threshold)\n' +
  '  ✅ [FIX-11] MAX_AUTO_RADIUS_M 2000m→5000m & MAX_CELLS 20k→45k\n' +
  '  ✅ [FIX-12] Gradasi warna kontur interpolasi tiap 3dB gaya Atoll\n' +
  '  ✅ [CONTOUR v9] Isoband via d3-contour (BSD-3-Clause, aman komersial)\n' +
  '  ✅ [PROBE] Klik peta cari cell terdekat dari grids[] mentah utk popup detail\n' +
  '  ✅ [BLANK-UNIFIED] Definisi "coverage exist" tetap berbasis grids[]\n' +
  '     (ber-noise, sama dgn detectGaps()) — konsisten di semua mode\n' +
  '  ✅ [SCOPE] Area komputasi tetap terbatas ke main site + hingga 6 neighbour\n' +
  '  ✅ [GAP-INDEP] detectGaps()/renderGapLayer()/showBlankSpotNotification()\n' +
  '     TIDAK diubah — tetap baca grids[] mentah, notifikasi blank spot tetap\n' +
  '     jalan otomatis kapan pun ada cluster titik di bawah ambang RSRP_BLANK,\n' +
  '     baik di pinggir maupun DI TENGAH cluster site manapun.\n' +
  '  [PERF-1/2][ALIGN/ALIGN2/ALIGN3][FIX-1..5][NOTIF] tetap dipertahankan'
);