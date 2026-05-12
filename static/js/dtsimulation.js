// ================= SIMULATION DT v17.0 =================
//
// PERUBAHAN DARI v16.0 → v17.0:
//
//   [BARU] σ_SF empiris dari residual data aktual
//      - Sebelumnya: σ langsung dari tabel TR 38.901 (nilai generik)
//      - Sekarang  : σ_empiris = std(RSRP_aktual − RSRP_3GPP)
//        → mencerminkan variabilitas nyata kondisi jaringan lokal
//        → lebih representatif dari σ generik TR 38.901
//      - Jika σ_empiris < 1 dB atau > 15 dB → fallback ke TR 38.901
//      - Justifikasi: Goldsmith (2005) Ch.2 — σ dikalibrasi dari
//        pengukuran lapangan adalah pendekatan standar
//
//   [BARU] Interference margin (IM) pada perhitungan SINR
//      - Sebelumnya: SINR = S / (I + N)
//      - Sekarang  : SINR = S / (I + N + I_IM)
//        I_IM = 10^(IM_dB/10) mW
//        IM_dB = 2 dB (default, range 2–7 dB di TR 36.942)
//      - Tujuan: memodelkan interferensi yang tidak termodelkan
//        (site di luar 6 neighbour, interferensi antar-sel lain)
//      - Referensi: 3GPP TR 36.942 §A.1, konsep interference margin
//        juga digunakan dalam link budget standar
//
//   [FIX] Hapus referensi COST 231 dari komentar clutter loss
//      - COST 231 valid 150–2000 MHz, tidak cocok untuk 2300 MHz
//      - Referensi yang benar: ITU-R P.1411-10 (300 MHz–100 GHz)
//        dan 3GPP TR 36.942 Table A.2.1.1.2-3
//
//   [TETAP] Semua komponen v16.0 lainnya tidak berubah
//
// REFERENSI UTAMA:
//   - 3GPP TR 38.901 v17   : Channel model 0.5–100 GHz
//   - 3GPP TR 36.942        : Radio frequency system scenarios
//   - 3GPP TS 38.101-1      : NR UE radio transmission and reception
//   - ITU-R P.1411-10       : Propagation data, short-range outdoor
//   - Goldsmith (2005)       : Wireless Communications, Ch.2
// =========================================================
(function () {
  'use strict';

  if (!document.getElementById('map-dt-sim')) return;

  // ── State ─────────────────────────────────────────────────────────────
  let dtMap;
  let siteLayer, dtPointLayer, heatmapLayer, cellLineLayer;
  let siteIndex = {};
  let primarySite = null;
  let neighbourPool = [];
  let dtPoints = [];
  let simPoints = [];
  let simResults = [];
  let calibration = null;
  let allSiteSectors = [];
  let pciMatchMap = {};
  let dtDisplayMode = 'rsrp';

  const SESSION_KEY    = 'siteIndexData';
  const MAX_NEIGHBOURS = 6;

  const MAIN_SECTOR_COLORS = ['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#42d4f4'];
  const NEIGHBOUR_PALETTE  = [
    '#f032e6','#bfef45','#469990','#dcbeff','#9a6324','#800000',
    '#aaffc3','#808000','#ffd8b1','#fffac8','#000075','#a9a9a9',
    '#e6beff','#ffe119','#fabebe','#ffb6c1',
  ];
  const LINE_COLORS = ['#00c050','#1a6fff','#ff8800','#ffd000','#ff3333','#888888'];
  const SECTOR_COLORS = ['#ff2d55','#00c7be','#ffcc00','#af52de','#ff9500','#34c759'];

  // ══════════════════════════════════════════════════════════════════════════
  // KONSTANTA AKADEMIK
  // ══════════════════════════════════════════════════════════════════════════
  const CAL = {
    TX_POWER  : 46,    // dBm  — EIRP downlink [3GPP TS 38.104 §6.2]
    FREQUENCY : 2300,  // MHz  — Band n40
    BANDWIDTH : 30e6,  // Hz   — BW kanal 30 MHz [TS 38.101-1 §5.3]
    MOBILE_H  : 1.5,   // m    — tinggi UE [TR 38.901 §7.4.1]
    ANTENNA_Am: 25,    // dB   — max atenuasi horizontal [TR 36.942 §A.2.1]
    BEAMWIDTH : 65,    // deg  — HPBW horizontal [TR 36.942 §A.2.1]
    NF        : 7,     // dB   — noise figure UE [TS 38.101-1 §7.3]
  };

  /**
   * Receiver sensitivity floor [3GPP TS 38.101-1 Table 7.3.2]
   * NR FR1, BW 30 MHz, μ=1: ≈ −125.2 dBm
   */
  const RX_SENSITIVITY_FLOOR = -125.2;

  /**
   * Thermal noise [dBm]
   * N = −174 + 10·log10(BW_Hz) + NF
   * [3GPP TR 36.942 §A.1]
   */
  const THERMAL_NOISE_DBM = -174 + 10 * Math.log10(CAL.BANDWIDTH) + CAL.NF;

  /**
   * Interference margin [dB]
   * Memodelkan interferensi yang tidak termodelkan secara eksplisit
   * (site di luar pool neighbour, interferensi antar-sel lain).
   * Range tipikal: 2–7 dB [3GPP TR 36.942 §A.1, link budget standar].
   * Default: 2 dB (konservatif — jaringan yang sudah teroptimasi).
   */
  const INTERFERENCE_MARGIN_DB = 2.0;
  const INTERFERENCE_MARGIN_LIN = Math.pow(10, INTERFERENCE_MARGIN_DB / 10); // [mW]

  /**
   * Clutter loss KONSTAN per kategori environment.
   * Referensi: ITU-R P.1411-10 (valid 300 MHz–100 GHz, mencakup 2300 MHz)
   *            3GPP TR 36.942 Table A.2.1.1.2-3
   * [BUKAN COST 231 — COST 231 hanya valid 150–2000 MHz]
   */
  const CLUTTER_LOSS_DB = {
    dense_urban : 8.0,
    metropolitan: 8.0,
    urban       : 5.0,
    suburban    : 2.5,
    sub_urban   : 2.5,
    rural       : 0.5,
    open        : 0.0,
    industrial  : 6.0,
    forest      : 9.0,
    water       : -1.0,
    highway     : -1.5,
    'n/a'       : 3.0,
  };

  /**
   * Shadow fading σ_SF — nilai STANDAR per skenario & kondisi.
   * Digunakan sebagai FALLBACK jika σ empiris tidak valid.
   * Referensi: 3GPP TR 38.901 Table 7.4.4-1
   */
  const SHADOW_STD_3GPP = {
    uma_los  : 4.0,
    uma_nlos : 6.0,
    umi_los  : 4.0,
    umi_nlos : 7.82,
    rma_los  : 4.0,
    rma_nlos : 8.0,
  };

  const DISTANCE_SEGMENTS = [
    { ta: 0, min: 0,    max: 39    },
    { ta: 1, min: 39,   max: 117   },
    { ta: 2, min: 117,  max: 273   },
    { ta: 3, min: 273,  max: 507   },
    { ta: 4, min: 507,  max: 975   },
    { ta: 5, min: 975,  max: 1755  },
    { ta: 6, min: 1755, max: 3315  },
    { ta: 7, min: 3315, max: 7215  },
    { ta: 8, min: 7215, max: 15015 },
  ];

  const BIAS_BLEND_K = 10;

  // ── RNG deterministik ─────────────────────────────────────────────────
  let _rng = 0;
  const seedRng = s => { _rng = s >>> 0; };
  const rng = () => {
    _rng += 0x6D2B79F5; let t = _rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let activeSeed = 0;

  function computeDataHash(points) {
    let h = 0x12345678;
    points.forEach((p, i) => {
      const lat  = Math.round((p.lat  || 0) * 1e5) | 0;
      const lng  = Math.round((p.lng  || 0) * 1e5) | 0;
      const rsrp = Math.round((p.rsrp || 0) * 10)  | 0;
      h = (Math.imul(h ^ lat,  0x45d9f3b)  >>> 0);
      h = (Math.imul(h ^ lng,  0x9e3779b9) >>> 0);
      h = (Math.imul(h ^ rsrp, 0x6D2B79F5) >>> 0);
      h = (h ^ (i * 31)) >>> 0;
    });
    return h >>> 0;
  }

  const SPATIAL_GRID_SIZE = 0.0005;
  function hashInt(n) {
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    return ((n >>> 16) ^ n) >>> 0;
  }
  function spatialNoise(lat, lng, std, globalSeed) {
    const cLat = Math.round(lat / SPATIAL_GRID_SIZE);
    const cLng = Math.round(lng / SPATIAL_GRID_SIZE);
    const s1 = hashInt(cLat * 73856093 ^ cLng * 19349663 ^ globalSeed);
    const s2 = hashInt(s1 + 2654435761);
    const u1 = (s1 >>> 0) / 4294967296 + 1e-10;
    const u2 = (s2 >>> 0) / 4294967296 + 1e-10;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std;
  }

  const mean      = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const rmseF     = arr => Math.sqrt(arr.reduce((s, d) => s + d * d, 0) / arr.length);
  const medianArr = arr => { const s = [...arr].sort((a,b)=>a-b), m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
  function stdDev(arr) {
    if (arr.length < 2) return 3.0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
  }

  function dbmToLinear(dbm) { return Math.pow(10, dbm / 10); }
  function linearToDbm(mw)  { return 10 * Math.log10(Math.max(mw, 1e-15)); }

  // ══════════════════════════════════════════════════════════════════════════
  // CLUTTER LOSS [ITU-R P.1411-10 / TR 36.942]
  // ══════════════════════════════════════════════════════════════════════════
  function getClutterLoss(clutterName) {
    const key = (clutterName || 'n/a').toLowerCase().replace(/[\s-]+/g, '_');
    if (CLUTTER_LOSS_DB[key] !== undefined) return CLUTTER_LOSS_DB[key];
    for (const [k, v] of Object.entries(CLUTTER_LOSS_DB)) {
      if (key.includes(k) || k.includes(key)) return v;
    }
    return CLUTTER_LOSS_DB['n/a'];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PATH LOSS — 3GPP TR 38.901 Table 7.4.1-1
  // ══════════════════════════════════════════════════════════════════════════
  function pathLoss(sc, cond, d2D, freq, hBS, hUT) {
    const d   = Math.max(d2D, 10);
    const hU  = hUT || 1.5;
    const fc  = freq / 1000; // GHz
    const c   = 3e8;
    const d3D = Math.sqrt(d * d + (hBS - hU) ** 2);

    const pLOS_UMa = d2 => {
      if (d2 <= 18) return 1.0;
      const C = hU <= 13 ? 0 : Math.pow((hU - 13) / 10, 1.5);
      return (18/d2 + Math.exp(-d2/63)*(1-18/d2)) *
             (1 + C*(5/4)*Math.pow(d2/100,3)*Math.exp(-d2/150));
    };
    const pLOS_UMi = d2 => d2 <= 18 ? 1.0 : 18/d2 + Math.exp(-d2/36)*(1-18/d2);

    switch (sc) {
      case 'uma': {
        const hE = 1.0, dBP = 4*(hBS-hE)*(hU-hE)*(freq*1e6)/c;
        const pl_los = d <= dBP
          ? 28 + 22*Math.log10(d3D) + 20*Math.log10(fc)
          : 28 + 40*Math.log10(d3D) + 20*Math.log10(fc) - 9*Math.log10(dBP**2+(hBS-hU)**2);
        if (cond === 'los') return pl_los;
        const pl_nlos = Math.max(13.54+39.08*Math.log10(d3D)+20*Math.log10(fc)-0.6*(hU-1.5), pl_los);
        if (cond === 'nlos') return pl_nlos;
        const p = pLOS_UMa(d); return p*pl_los + (1-p)*pl_nlos;
      }
      case 'umi': {
        const hE = 1.0, dBP = 4*(hBS-hE)*(hU-hE)*(freq*1e6)/c;
        const pl_los = d <= dBP
          ? 32.4 + 21*Math.log10(d3D) + 20*Math.log10(fc)
          : 32.4 + 40*Math.log10(d3D) + 20*Math.log10(fc) - 9.5*Math.log10(dBP**2+(hBS-hU)**2);
        if (cond === 'los') return pl_los;
        const pl_nlos = Math.max(22.4+35.3*Math.log10(d3D)+21.3*Math.log10(fc)-0.3*(hU-1.5), pl_los);
        if (cond === 'nlos') return pl_nlos;
        const p = pLOS_UMi(d); return p*pl_los + (1-p)*pl_nlos;
      }
      case 'rma': {
        const h=5, W=20, dBP=2*Math.PI*hBS*hU*(freq*1e6)/c;
        const A1=Math.min(0.03*Math.pow(h,1.72),10), A2=Math.min(0.044*Math.pow(h,1.72),14.77), A3=0.002*Math.log10(h);
        let pl_los;
        if (d <= dBP) { pl_los = 20*Math.log10(40*Math.PI*d3D*fc/3)+A1*Math.log10(d3D)-A2+A3*d3D; }
        else { const d3D_BP=Math.sqrt(dBP**2+(hBS-hU)**2); pl_los=20*Math.log10(40*Math.PI*d3D_BP*fc/3)+A1*Math.log10(d3D_BP)-A2+A3*d3D_BP+40*Math.log10(d3D/d3D_BP); }
        if (cond === 'los') return pl_los;
        return Math.max(161.04-7.1*Math.log10(W)+7.5*Math.log10(h)-(24.37-3.7*(h/hBS)**2)*Math.log10(hBS)+(43.42-3.1*Math.log10(hBS))*(Math.log10(d3D)-3)+20*Math.log10(fc)-(3.2*(Math.log10(11.75*hU))**2-4.97), pl_los);
      }
      default: return 28 + 22*Math.log10(d3D) + 20*Math.log10(fc);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ANTENNA GAIN — 3GPP TR 36.942 §A.2.1
  // G_h(θ) = −min(12·(θ/θ_3dB)², A_m)
  // ══════════════════════════════════════════════════════════════════════════
  function antennaGain(angOff) {
    return -Math.min(12 * (angOff / (CAL.BEAMWIDTH / 2)) ** 2, CAL.ANTENNA_Am);
  }
  function bestSectorGain(brng, sectors) {
    if (!sectors?.length) return { gain: 0, idx: 0 };
    let best = -Infinity, idx = 0;
    sectors.forEach((az, i) => { const g = antennaGain(Math.abs(((brng-az+540)%360)-180)); if (g > best) { best = g; idx = i; } });
    return { gain: best, idx };
  }
  function pickBestSector(brng, sectorsOfSite) {
    if (!sectorsOfSite?.length) return { bestSec: null, bestGain: 0 };
    let bestGain = -Infinity, bestSec = null;
    sectorsOfSite.forEach(sec => { const g = antennaGain(Math.abs(((brng-sec.azimuth+540)%360)-180)); if (g > bestGain) { bestGain = g; bestSec = sec; } });
    return { bestSec, bestGain };
  }

  function applyRxFloor(rsrp) { return Math.max(RX_SENSITIVITY_FLOOR, rsrp); }
  function getSegmentIndex(distM) {
    for (let i = 0; i < DISTANCE_SEGMENTS.length; i++) if (distM >= DISTANCE_SEGMENTS[i].min && distM < DISTANCE_SEGMENTS[i].max) return i;
    return DISTANCE_SEGMENTS.length - 1;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPUTE RSRP (3GPP — tanpa noise, untuk kalibrasi)
  // ══════════════════════════════════════════════════════════════════════════
  function computeRsrp3gpp(pt, site) {
    const dist = haversine(pt.lat, pt.lng, site.lat, site.lng);
    const d    = Math.max(dist, 10);
    const brng = calcBearing(site.lat, site.lng, pt.lat, pt.lng);
    const sectors   = normalizeSectors(site);
    const scenario  = (site.scenario  || 'uma').toLowerCase();
    const condition = (site.condition || 'nlos').toLowerCase();
    const gainDb = sectors.length ? bestSectorGain(brng, sectors).gain : 0;
    const pl     = pathLoss(scenario, condition, d, CAL.FREQUENCY, site.height || 30, CAL.MOBILE_H);
    const cl     = getClutterLoss(site.clutter);
    return { rsrp3gpp: CAL.TX_POWER + gainDb - pl - cl, dist, gainDb, pl, cl };
  }

  function computeSectorRSRP(pt, sec, cal) {
    const dist   = haversine(pt.lat, pt.lng, sec.siteLat, sec.siteLng);
    const d      = Math.max(dist, 10);
    const brng   = calcBearing(sec.siteLat, sec.siteLng, pt.lat, pt.lng);
    const offset = Math.abs(((brng - sec.azimuth + 540) % 360) - 180);
    const gainDb = antennaGain(offset);
    const sc     = (sec.scenario  || 'uma').toLowerCase();
    const cond   = (sec.condition || 'nlos').toLowerCase();
    const pl     = pathLoss(sc, cond, d, CAL.FREQUENCY, sec.siteHeight, CAL.MOBILE_H);
    const cl     = getClutterLoss(sec.clutter);
    const rsrp3gpp = CAL.TX_POWER + gainDb - pl - cl;
    let rsrpSim = rsrp3gpp;
    if (cal) {
      const seg     = cal.segments[getSegmentIndex(dist)];
      const biasSeg = seg?.bias ?? cal.globalBias;
      const noise   = spatialNoise(pt.lat, pt.lng, cal.sigmaEff,
                                   activeSeed + (sec.sectorNum || 1) * 7919);
      rsrpSim = applyRxFloor(rsrp3gpp + biasSeg + (cal.globalGain ?? 0) + noise);
    }
    return { dist, brng, gainDb, pl, cl, rsrp3gpp, rsrpSim };
  }

  function blendedBias(localBias, globalBias, n) {
    const alpha = n / (n + BIAS_BLEND_K);
    return { bias: alpha * localBias + (1 - alpha) * globalBias, alpha: +alpha.toFixed(3) };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // KALIBRASI EMPIRIS — termasuk estimasi σ dari data aktual
  //
  // Langkah:
  //   1. Hitung RSRP_3GPP per titik (tanpa noise)
  //   2. Δ_i = RSRP_aktual − RSRP_3GPP
  //   3. bias_global = mean(Δ)
  //   4. σ_empiris = std(Δ) — ini adalah σ efektif dari data lapangan
  //      - Lebih representatif dari σ tabel TR 38.901 yang bersifat generik
  //      - Referensi: Goldsmith (2005) Ch.2
  //   5. Validasi: jika σ_empiris < 1 dB atau > 15 dB → fallback ke TR 38.901
  //   6. bias per segmen jarak (Bayesian shrinkage)
  //   7. Global gain G (koreksi median)
  // ══════════════════════════════════════════════════════════════════════════
  function calibrateSegmentBased(site) {
    const buckets = DISTANCE_SEGMENTS.map(() => ({ deltas: [], sinrPairs: [] }));
    simPoints.forEach(pt => {
      if (pt.rsrp === null) return;
      const { rsrp3gpp, dist } = computeRsrp3gpp(pt, site);
      const segIdx = getSegmentIndex(dist);
      buckets[segIdx].deltas.push(pt.rsrp - rsrp3gpp);
      if (pt.sinr !== null) buckets[segIdx].sinrPairs.push({ rsrp: pt.rsrp, dist, sinr: pt.sinr });
    });

    const allDeltas = buckets.flatMap(b => b.deltas);
    if (allDeltas.length < 5) return null;

    const globalBias = mean(allDeltas);

    // σ empiris dari residual — Goldsmith (2005) Ch.2
    const sigmaEmpiricalRaw = stdDev(allDeltas);

    // Validasi range fisik: 1–15 dB
    const scenKey  = `${(site.scenario||'uma').toLowerCase()}_${(site.condition||'nlos').toLowerCase()}`;
    const sigma3gpp = SHADOW_STD_3GPP[scenKey] || 6.0;
    let sigmaEff, sigmaSource;
    if (sigmaEmpiricalRaw >= 1.0 && sigmaEmpiricalRaw <= 15.0) {
      sigmaEff    = sigmaEmpiricalRaw;
      sigmaSource = 'empiris';
    } else {
      sigmaEff    = sigma3gpp;
      sigmaSource = 'TR38901_fallback';
      console.warn(`[Cal] σ empiris ${sigmaEmpiricalRaw.toFixed(2)} dB di luar range [1,15] → fallback σ_3GPP=${sigma3gpp} dB`);
    }

    const globalStd = sigmaEff;

    // Bias per segmen jarak dengan Bayesian shrinkage
    const segments = buckets.map((b, i) => {
      const seg = DISTANCE_SEGMENTS[i];
      if (!b.deltas.length) return { ...seg, bias: null, std: null, count: 0, alpha: 0, localBias: null };
      const localBias = mean(b.deltas);
      const localStd  = Math.max(0.5, stdDev(b.deltas));
      const { bias, alpha } = blendedBias(localBias, globalBias, b.deltas.length);
      return { ta: seg.ta, min: seg.min, max: seg.max, bias, std: alpha*localStd+(1-alpha)*globalStd, count: b.deltas.length, alpha, localBias: +localBias.toFixed(2) };
    });

    // Isi segmen kosong dengan interpolasi
    let lv = null;
    for (let i = 0; i < segments.length; i++) { if (segments[i].bias!==null) lv=segments[i]; else if (lv) { segments[i].bias=lv.bias; segments[i].std=lv.std; } }
    lv = null;
    for (let i = segments.length-1; i >= 0; i--) { if (segments[i].bias!==null) lv=segments[i]; else if (lv) { segments[i].bias=lv.bias; segments[i].std=lv.std; } }
    segments.forEach(s => { if (s.bias===null) { s.bias=globalBias; s.std=globalStd; } });

    const G = computeGlobalGainCorrection(site, segments, globalBias);

    const allSinrPairs = buckets.flatMap(b => b.sinrPairs);
    const sinrModel = allSinrPairs.length >= 8 ? fitSINRModel(allSinrPairs) : null;
    const rmseAfter = rmseF(allDeltas.map(d => d - globalBias));

    console.log(`[Cal] σ efektif: ${sigmaEff.toFixed(2)} dB (${sigmaSource}) | bias: ${globalBias.toFixed(2)} dB | G: ${G.toFixed(2)} dB`);

    return {
      globalBias, globalStd, sigmaEff, sigmaSource, sigma3gpp,
      rmse3gpp: rmseF(allDeltas), rmseAfter,
      segments, sinrModel, globalGain: G,
      nPaired: allDeltas.length, nSinr: allSinrPairs.length,
    };
  }

  function computeGlobalGainCorrection(site, segments, globalBias) {
    const pp = simPoints.filter(p => p.rsrp !== null);
    if (pp.length < 5) return 0;
    const rsrpSimList = pp.map(pt => {
      const { rsrp3gpp, dist } = computeRsrp3gpp(pt, site);
      return rsrp3gpp + (segments[getSegmentIndex(dist)]?.bias ?? globalBias);
    });
    return Math.max(-10, Math.min(10, medianArr(pp.map(p => p.rsrp)) - medianArr(rsrpSimList)));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SINR — S / (I + N + I_IM)  [3GPP TR 36.942 §A.1]
  //
  // I_IM = interference margin = 10^(IM_dB/10) mW
  // Memodelkan interferensi yang tidak termodelkan secara eksplisit.
  // ══════════════════════════════════════════════════════════════════════════
  function computeSINR(servingRsrp_dbm, interfererRsrp_dbm_list) {
    const S = dbmToLinear(servingRsrp_dbm);
    const N = dbmToLinear(THERMAL_NOISE_DBM);
    let I = N; // noise floor minimum
    interfererRsrp_dbm_list.forEach(r => { I += dbmToLinear(r); });
    // Tambahkan interference margin
    I += INTERFERENCE_MARGIN_LIN;
    return Math.max(-10, Math.min(40, linearToDbm(S / I)));
  }

  // Model SINR empiris dari data aktual (jika tersedia)
  function fitSINRModel(pairs) {
    const n = pairs.length;
    if (n < 5) return null;
    const X  = pairs.map(p => [p.rsrp, Math.log10(Math.max(p.dist, 10)), 1]);
    const y  = pairs.map(p => p.sinr);
    const XtX = [[0,0,0],[0,0,0],[0,0,0]], Xty = [0,0,0];
    for (let i = 0; i < n; i++) {
      for (let r = 0; r < 3; r++) { Xty[r] += X[i][r]*y[i]; for (let c = 0; c < 3; c++) XtX[r][c] += X[i][r]*X[i][c]; }
    }
    const beta = gaussElim3(XtX, Xty);
    if (!beta) {
      const lr = linReg(pairs.map(p => ({ x: p.rsrp, y: p.sinr })));
      return { a: lr.slope, b: 0, c: lr.intercept, r2: lr.r2, noiseStd: 3.0, type: 'linear_1var' };
    }
    const [a, b, c] = beta;
    const yPred = pairs.map(p => a*p.rsrp + b*Math.log10(Math.max(p.dist,10)) + c);
    const yMean = mean(y), ssTot = y.reduce((s,yi)=>s+(yi-yMean)**2,0), ssRes = y.reduce((s,yi,i)=>s+(yi-yPred[i])**2,0);
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes/ssTot) : 0;
    return { a, b, c, r2, noiseStd: Math.max(1.0, Math.sqrt(ssRes/Math.max(n-3,1))), type: '3var' };
  }

  function computeSinrSim(rsrpSim, dist, sinrModel, globalSeed, lat, lng) {
    if (!sinrModel) return Math.max(-10, Math.min(30, rsrpSim + 90));
    const base = sinrModel.a*rsrpSim + sinrModel.b*Math.log10(Math.max(dist,10)) + sinrModel.c;
    return Math.max(-10, Math.min(40, base + spatialNoise(lat, lng, sinrModel.noiseStd, globalSeed+31337)));
  }

  function gaussElim3(A, b) {
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < 3; col++) {
      let mr = col;
      for (let row=col+1; row<3; row++) if (Math.abs(M[row][col])>Math.abs(M[mr][col])) mr=row;
      [M[col],M[mr]]=[M[mr],M[col]];
      if (Math.abs(M[col][col])<1e-12) return null;
      for (let row=col+1; row<3; row++) { const f=M[row][col]/M[col][col]; for (let k=col;k<=3;k++) M[row][k]-=f*M[col][k]; }
    }
    const x=[0,0,0]; for (let row=2;row>=0;row--) { x[row]=M[row][3]; for (let k=row+1;k<3;k++) x[row]-=M[row][k]*x[k]; x[row]/=M[row][row]; } return x;
  }
  function linReg(pairs) {
    const n=pairs.length; let sX=0,sY=0,sXX=0,sXY=0,sYY=0;
    pairs.forEach(p=>{sX+=p.x;sY+=p.y;sXX+=p.x*p.x;sXY+=p.x*p.y;sYY+=p.y*p.y;});
    const denom=n*sXX-sX*sX, slope=denom?(n*sXY-sX*sY)/denom:0, intercept=(sY-slope*sX)/n;
    const yMean=sY/n, ssTot=sYY-n*yMean*yMean, ssRes=pairs.reduce((s,p)=>{const r=p.y-(slope*p.x+intercept);return s+r*r;},0);
    return {slope,intercept,r2:ssTot>0?Math.max(0,1-ssRes/ssTot):0};
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NEIGHBOUR POOL & PCI
  // ══════════════════════════════════════════════════════════════════════════
  function buildNeighbourPool() {
    if (!primarySite) return;
    const primSite = siteIndex[primarySite.id];
    neighbourPool = Object.entries(siteIndex)
      .filter(([id]) => id !== primarySite.id)
      .map(([id, s]) => ({ id, ...s, _dist: haversine(primSite.lat, primSite.lng, s.lat, s.lng) }))
      .sort((a, b) => a._dist - b._dist).slice(0, MAX_NEIGHBOURS);
  }

  function buildPCIMatchMap() {
    pciMatchMap = {};
    if (!primarySite) return 0;
    const primSite = siteIndex[primarySite.id];
    neighbourPool.forEach((nb, nbIdx) => {
      const sectors = (nb.sectorData||[]).length > 0 ? nb.sectorData
        : (nb.sectors||[]).map((az,i)=>({sectorNum:i+1,azimuth:az,pci:null,cellId:null,cellName:`${nb.id}_Sek${i+1}`,gnbId:null,arfcn:466850}));
      sectors.forEach((sec, secIdx) => {
        if (sec.pci===null||sec.pci===undefined) return;
        pciMatchMap[sec.pci] = { siteId:nb.id, sectorNum:sec.sectorNum||(secIdx+1), azimuth:sec.azimuth, cellId:sec.cellId,
          cellName:sec.cellName||`${nb.id}_Sek${sec.sectorNum||secIdx+1}`, gnbId:sec.gnbId||null, arfcn:sec.arfcn||466850,
          pciColor:NEIGHBOUR_PALETTE[(nbIdx*6+secIdx)%NEIGHBOUR_PALETTE.length], isPrimary:false, dist:nb._dist };
      });
    });
    const primSectors = (primSite.sectorData||[]).length > 0 ? primSite.sectorData
      : (primSite.sectors||[]).map((az,i)=>({sectorNum:i+1,azimuth:az,pci:null,cellId:null,cellName:`${primarySite.id}_Sek${i+1}`,gnbId:null,arfcn:466850}));
    primSectors.forEach((sec, i) => {
      if (sec.pci===null||sec.pci===undefined) return;
      pciMatchMap[sec.pci] = { siteId:primarySite.id, sectorNum:sec.sectorNum||(i+1), azimuth:sec.azimuth, cellId:sec.cellId,
        cellName:sec.cellName||`${primarySite.id}_Sek${sec.sectorNum||i+1}`, gnbId:sec.gnbId||primSite.gnbId||null, arfcn:sec.arfcn||466850,
        pciColor:MAIN_SECTOR_COLORS[i%MAIN_SECTOR_COLORS.length], isPrimary:true, dist:0 };
    });
    const total=Object.keys(pciMatchMap).length, primary=Object.values(pciMatchMap).filter(v=>v.isPrimary).length;
    setText('infoPCIMatched', `${total} PCI (${primary} primary + ${total-primary} nb)`);
    return total;
  }

  function getPCIInfo(pci) { return (pci===null||pci===undefined) ? null : (pciMatchMap[pci]||null); }

  function buildAllSiteSectors() {
    allSiteSectors = [];
    if (!primarySite) return;
    const primSite = siteIndex[primarySite.id];
    const primSectors = (primSite.sectorData||[]).length>0 ? primSite.sectorData
      : (primSite.sectors||[]).map((az,i)=>({sectorNum:i+1,azimuth:az,pci:null,cellId:null,cellName:`${primarySite.id}_Sek${i+1}`,gnbId:null,arfcn:466850}));
    primSectors.forEach((sec,i) => {
      allSiteSectors.push({ siteId:primarySite.id, siteLat:primSite.lat, siteLng:primSite.lng, siteHeight:primSite.height||30, isMain:true, nbIdx:-1,
        sectorNum:sec.sectorNum||(i+1), azimuth:sec.azimuth, pci:sec.pci, cellId:sec.cellId, cellName:sec.cellName||`${primarySite.id}_Sek${sec.sectorNum||i+1}`,
        gnbId:sec.gnbId||null, arfcn:sec.arfcn||466850, pciColor:MAIN_SECTOR_COLORS[i%MAIN_SECTOR_COLORS.length],
        scenario:primSite.scenario||'uma', condition:primSite.condition||'nlos', clutter:primSite.clutter||'N/A' });
    });
    neighbourPool.forEach((nb, nbIdx) => {
      const nbSectors = (nb.sectorData||[]).length>0 ? nb.sectorData
        : (nb.sectors||[]).map((az,i)=>({sectorNum:i+1,azimuth:az,pci:null,cellId:null,cellName:`${nb.id}_Sek${i+1}`,gnbId:null,arfcn:466850}));
      nbSectors.forEach((sec, secIdx) => {
        allSiteSectors.push({ siteId:nb.id, siteLat:nb.lat, siteLng:nb.lng, siteHeight:nb.height||30, isMain:false, nbIdx,
          sectorNum:sec.sectorNum||(secIdx+1), azimuth:sec.azimuth, pci:sec.pci, cellId:sec.cellId, cellName:sec.cellName||`${nb.id}_Sek${sec.sectorNum||secIdx+1}`,
          gnbId:sec.gnbId||null, arfcn:sec.arfcn||466850, pciColor:NEIGHBOUR_PALETTE[(nbIdx*6+secIdx)%NEIGHBOUR_PALETTE.length],
          scenario:nb.scenario||'uma', condition:nb.condition||'nlos', clutter:nb.clutter||'N/A' });
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INIT & MAP
  // ══════════════════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => { initMap(); setupEventListeners(); loadSiteIndex(); initCellPanelPills(); });

  function initMap() {
    dtMap = L.map('map-dt-sim').setView([-6.2, 106.82], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OpenStreetMap' }).addTo(dtMap);
    siteLayer=L.layerGroup().addTo(dtMap); dtPointLayer=L.layerGroup().addTo(dtMap);
    heatmapLayer=L.layerGroup().addTo(dtMap); cellLineLayer=L.layerGroup().addTo(dtMap);
  }

  function setupEventListeners() {
    byId('dtCsvInput')?.addEventListener('change', handleCsvUpload);
    byId('btnRunSimulation')?.addEventListener('click', runSimulation);
    byId('btnExportCSV')?.addEventListener('click', exportCSV);
    byId('btnBackToSim')?.addEventListener('click', () => window.location.href = '/simulation');
    byId('btnDebugSite')?.addEventListener('click', showDebug);
  }

  function initCellPanelPills() {
    const pills = byId('dtCellLegendPills'); if (!pills) return;
    const labels = ['⭐ Serving','Det-1','Det-2','Det-3','Det-4','Det-5+'];
    pills.innerHTML = LINE_COLORS.map((c,i)=>`<span class="line-pill" style="background:${c}">${labels[i]||'Det'}</span>`).join('');
  }

  window.setDtDisplayMode = function (mode) {
    dtDisplayMode = mode;
    byId('btnModeRSRP')?.classList.toggle('active', mode==='rsrp');
    byId('btnModePCI')?.classList.toggle('active', mode==='pci');
    byId('dtLegend').style.display  = mode==='rsrp'?'block':'none';
    byId('pciLegend').style.display = mode==='pci'?'block':'none';
    if (mode==='pci') redrawPCIMode(); else redrawRSRPMode();
  };

  function redrawRSRPMode() {
    if (!simResults.length) return;
    heatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    simResults.forEach((r,idx) => {
      const m = L.circleMarker([r.lat,r.lng],{radius:6,fillColor:rsrpColor(parseFloat(r.rsrp)),color:'#333',weight:0.5,fillOpacity:0.92}).addTo(heatmapLayer);
      m.on('click',()=>onPointClick(r,idx+1));
    });
    updateLegend();
  }

  function redrawPCIMode() {
    if (!simResults.length) return;
    heatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    const pciDist = {};
    simResults.forEach((r,idx) => {
      const pciInfo=r.pci!=null?getPCIInfo(r.pci):null, color=pciInfo?pciInfo.pciColor:'#888888';
      const key=pciInfo?`${pciInfo.siteId}|S${pciInfo.sectorNum}`:`PCI_${r.pci??'unknown'}`;
      if (!pciDist[key]) pciDist[key]={pci:r.pci,color,siteId:pciInfo?.siteId||'Unknown',sectorNum:pciInfo?.sectorNum||0,cellName:pciInfo?.cellName||`PCI_${r.pci}`,matched:!!pciInfo,isPrimary:pciInfo?.isPrimary||false,count:0};
      pciDist[key].count++;
      const m=L.circleMarker([r.lat,r.lng],{radius:6,fillColor:color,color:'#333',weight:0.5,fillOpacity:0.92}).addTo(heatmapLayer);
      m.on('click',()=>onPointClick(r,idx+1));
    });
    updatePCILegend(pciDist);
  }

  function updatePCILegend(pciDist) {
    const legend=byId('pciLegend'),body=byId('pciLegendBody'); if(!legend||!body)return;
    const total=simResults.length||1;
    const sorted=Object.values(pciDist).sort((a,b)=>{if(a.isPrimary!==b.isPrimary)return a.isPrimary?-1:1;return b.count-a.count;});
    body.innerHTML=sorted.map(d=>{
      const pct=((d.count/total)*100).toFixed(1),pciStr=d.pci!=null?d.pci:'N/A';
      const badge=d.isPrimary?'<span style="font-size:9px;color:#ffd700">★</span>':d.matched?'':'<span style="font-size:9px;color:#ff8800">?</span>';
      return `<div class="pci-legend-row"><div class="pci-dot" style="background:${d.color}"></div><span style="font-size:10px">${badge}${d.siteId}${d.sectorNum?` Sek${d.sectorNum}`:''} — PCI ${pciStr} (${d.count}, ${pct}%)</span></div>`;
    }).join('');
    legend.style.display='block';
  }

  // ── Load site index ───────────────────────────────────────────────────────
  function loadSiteIndex() {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) { try { const p=JSON.parse(saved); if(p&&Object.keys(p).length>0){siteIndex=p;onSiteIndexLoaded('sessionStorage');return;}} catch{} }
    setStatus('siteStatus','⏳ Memuat data site...','info');
    fetch('/api/get-site').then(r=>r.json()).then(data=>{
      if(!data.has_site||!data.siteIndex){setStatus('siteStatus','⚠️ Belum ada data site.','warn');return;}
      siteIndex=data.siteIndex; sessionStorage.setItem(SESSION_KEY,JSON.stringify(siteIndex)); onSiteIndexLoaded('server');
    }).catch(()=>setStatus('siteStatus','⚠️ Tidak bisa mengambil data site.','warn'));
  }

  function onSiteIndexLoaded(source) {
    const count=Object.keys(siteIndex).length;
    setStatus('siteStatus',`✅ ${count} site (${source})`,'ok');
    setText('infoTotalSites',count); renderAllSites();
    if (simPoints.length) autoDetectAndCalibrate();
  }

  // ── Auto detect primary site & kalibrasi ─────────────────────────────────
  function autoDetectAndCalibrate() {
    if(!Object.keys(siteIndex).length||!dtPoints.length) return;
    const cLat=dtPoints.reduce((s,p)=>s+p.lat,0)/dtPoints.length;
    const cLng=dtPoints.reduce((s,p)=>s+p.lng,0)/dtPoints.length;
    let bestId=null,bestSite=null,minDist=Infinity;
    Object.entries(siteIndex).forEach(([id,s])=>{const d=haversine(cLat,cLng,s.lat,s.lng);if(d<minDist){minDist=d;bestId=id;bestSite=s;}});
    if(!bestId) return;
    primarySite={id:bestId,...bestSite};

    setStatus('siteMatchStatus',`🎯 Site: <b>${bestId}</b> — ${(minDist/1000).toFixed(2)} km`,'ok');
    const s=bestSite;
    setText('dispSiteId',bestId); setText('dispSiteCoord',`${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}`);
    setText('dispSiteHeight',`${s.height||30} m`);
    const sectors=normalizeSectors(s);
    setText('dispSiteSectors',sectors.length?`${sectors.length} sektor (${sectors.map(a=>a+'°').join(', ')})`: 'Omni');
    setText('dispSiteModel',`${(s.scenario||'uma').toUpperCase()} ${(s.condition||'nlos').toUpperCase()}`);
    setText('dispSiteClutter',s.clutter||'—');
    highlightPrimarySiteOnMap(bestId);
    buildNeighbourPool(); buildPCIMatchMap(); buildAllSiteSectors();
    if (simPoints.length) {
      calibration=calibrateSegmentBased(bestSite);
      displayCalibrationInfo();
      if (calibration) enableBtn('btnRunSimulation');
    }
  }

  function displayCalibrationInfo() {
    if(!calibration){setStatus('modelStatus','⚠️ Tidak cukup data.','warn');return;}
    const c=calibration;
    const sigmaLabel = c.sigmaSource==='empiris'
      ? `σ_empiris=${c.sigmaEff.toFixed(2)} dB (dari data)`
      : `σ_3GPP=${c.sigmaEff.toFixed(2)} dB (fallback TR 38.901)`;
    setStatus('modelStatus',
      `✅ Kalibrasi dari <b>${c.nPaired} titik</b><br>`+
      `Bias: ${c.globalBias>0?'+':''}${c.globalBias.toFixed(1)} dB | G: ${c.globalGain>0?'+':''}${c.globalGain.toFixed(2)} dB<br>`+
      `${sigmaLabel}<br>`+
      `RMSE: ${c.rmse3gpp.toFixed(1)} → <b>${c.rmseAfter.toFixed(1)} dB</b>`+
      (c.sinrModel?`<br>SINR [${c.sinrModel.type}]: R²=${c.sinrModel.r2.toFixed(3)}`:''),
      c.rmseAfter<5?'ok':c.rmseAfter<10?'warn':'error'
    );
    setText('infoCalibN',c.nPaired);
    setText('infoCalibBias',`${c.globalBias>0?'+':''}${c.globalBias.toFixed(2)} dB`);
    setText('infoCalibStd',`σ=${c.sigmaEff.toFixed(2)} dB (${c.sigmaSource})`);
    setText('infoCalibRmse',`${c.rmse3gpp.toFixed(1)} → ${c.rmseAfter.toFixed(1)} dB`);
    setText('infoSinrR2',c.sinrModel?c.sinrModel.r2.toFixed(3):'N/A');
    setText('infoGlobalGain',`${c.globalGain>0?'+':''}${c.globalGain.toFixed(2)} dB`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RUN SIMULATION
  // ══════════════════════════════════════════════════════════════════════════
  function runSimulation() {
    if(!simPoints.length) return alert('Upload CSV DT aktual terlebih dahulu!');
    if(!Object.keys(siteIndex).length) return alert('Data site belum dimuat!');
    if(!primarySite) return alert('Primary site belum terdeteksi!');
    if(!calibration) return alert('Kalibrasi gagal.');

    activeSeed=computeDataHash(simPoints);
    setText('infoSeedValue',`0x${activeSeed.toString(16).toUpperCase().padStart(8,'0')}`);
    seedRng(activeSeed);
    heatmapLayer.clearLayers(); cellLineLayer.clearLayers(); simResults=[];

    const site=siteIndex[primarySite.id], cal=calibration, G=cal.globalGain??0;
    const sectorBySite={};
    allSiteSectors.forEach(sec=>{ if(!sectorBySite[sec.siteId])sectorBySite[sec.siteId]=[]; sectorBySite[sec.siteId].push(sec); });

    simPoints.forEach((pt, idx) => {
      const {rsrp3gpp,dist,gainDb,pl,cl}=computeRsrp3gpp(pt,site);
      const seg=cal.segments[getSegmentIndex(dist)];
      const biasSeg=seg.bias??cal.globalBias;

      // Gunakan σ efektif dari kalibrasi (empiris atau fallback TR 38.901)
      const noise=spatialNoise(pt.lat,pt.lng,cal.sigmaEff,activeSeed);
      const rsrpSim=applyRxFloor(rsrp3gpp+biasSeg+G+noise);

      // Hitung RSRP semua sektor untuk tabel neighbour
      const cellResults=[];
      Object.entries(sectorBySite).forEach(([siteId,sectors])=>{
        const firstSec=sectors[0];
        const brng=calcBearing(firstSec.siteLat,firstSec.siteLng,pt.lat,pt.lng);
        const {bestSec}=pickBestSector(brng,sectors);
        if(!bestSec) return;
        const {dist:d2,rsrpSim:rSim}=computeSectorRSRP(pt,bestSec,cal);
        cellResults.push({
          siteId,siteLat:firstSec.siteLat,siteLng:firstSec.siteLng,isMain:firstSec.isMain,
          sectorNum:bestSec.sectorNum,azimuth:bestSec.azimuth,pci:bestSec.pci,cellId:bestSec.cellId,
          cellName:bestSec.cellName||`${siteId}_Sek${bestSec.sectorNum}`,gnbId:bestSec.gnbId,
          pciColor:bestSec.pciColor,arfcn:bestSec.arfcn,dist:d2,rsrp:rSim,
        });
      });
      cellResults.sort((a,b)=>b.rsrp-a.rsrp);

      // SINR dengan interference margin [TR 36.942]
      const interferers = cellResults.filter((_,i)=>i>0).map(c=>c.rsrp);
      const sinrSim = cal.sinrModel
        ? computeSinrSim(rsrpSim, dist, cal.sinrModel, activeSeed, pt.lat, pt.lng)
        : computeSINR(rsrpSim, interferers);

      // Hitung SINR per sel di tabel
      cellResults.forEach((c,i)=>{
        const otherRsrp = cellResults.filter((_,j)=>j!==i).map(cc=>cc.rsrp);
        c.sinr = computeSINR(c.rsrp, otherRsrp);
      });

      const pciInfo=pt.pci!=null?getPCIInfo(pt.pci):null;
      const pciColor=pciInfo?pciInfo.pciColor:'#888888';

      simResults.push({
        index:idx+1,lat:pt.lat,lng:pt.lng,distance:dist.toFixed(1),ta_seg:seg.ta,
        rsrp3gpp:rsrp3gpp.toFixed(1),clutter_loss:cl.toFixed(1),
        bias_seg:biasSeg.toFixed(2),gain_g:G.toFixed(2),sigma_eff:cal.sigmaEff.toFixed(2),
        rsrp:rsrpSim.toFixed(1),sinr:sinrSim.toFixed(1),
        rsrp_actual:pt.rsrp,sinr_actual:pt.sinr,
        pci:pt.pci??'—',pciInfo:{...pciInfo,pciColor,matched:!!pciInfo},
        siteId:primarySite.id,cells:cellResults,gainDb:gainDb.toFixed(1),pl:pl.toFixed(1),
      });

      const markerColor=dtDisplayMode==='pci'?pciColor:rsrpColor(rsrpSim);
      const m=L.circleMarker([pt.lat,pt.lng],{radius:6,fillColor:markerColor,color:'#333',weight:0.5,fillOpacity:0.92}).addTo(heatmapLayer);
      m.on('click',()=>onPointClick(simResults[simResults.length-1],idx+1));
    });

    if(dtDisplayMode==='pci') redrawPCIMode(); else updateLegend();
    renderStats(); enableBtn('btnExportCSV');

    const evalResult=evaluateModel(simResults);
    const pciMatchedCount=simResults.filter(r=>r.pciInfo?.matched).length;
    if(evalResult) {
      const r=evalResult.rsrp;
      alert(
        `✅ Simulasi v17.0 selesai! ${simResults.length} titik\n\n`+
        `📶 RSRP: ME=${r.me>0?'+':''}${r.me} | RMSE=${r.rmse} dB\n`+
        (evalResult.sinr?`📡 SINR: ME=${evalResult.sinr.me} | RMSE=${evalResult.sinr.rmse} dB\n`:'')+
        `🎨 PCI: ${pciMatchedCount} matched\n\n`+
        `σ_SF: ${calibration.sigmaEff.toFixed(2)} dB (${calibration.sigmaSource})\n`+
        `Interference margin: ${INTERFERENCE_MARGIN_DB} dB [TR 36.942]\n`+
        `Rx floor: ${RX_SENSITIVITY_FLOOR} dBm [TS 38.101-1]`
      );
    } else alert(`✅ Selesai — ${simResults.length} titik.`);
  }

  // ── Click handler & tabel ─────────────────────────────────────────────────
  function onPointClick(result, ptIdx) {
    cellLineLayer.clearLayers();
    const cells=result.cells||[], point={lat:result.lat,lng:result.lng};
    const drawnSites=new Set();
    cells.forEach((c,i)=>{
      if(drawnSites.has(c.siteId)) return; drawnSites.add(c.siteId);
      const col=LINE_COLORS[Math.min(i,LINE_COLORS.length-1)];
      L.polyline([[point.lat,point.lng],[c.siteLat,c.siteLng]],{color:col,weight:i===0?3.5:2,opacity:0.9,dashArray:i===0?null:'7 4'})
        .addTo(cellLineLayer)
        .bindTooltip(`<b>${i===0?'⭐ Serving':'Detected'}: ${c.siteId}</b><br>${c.dist.toFixed(0)} m | RSRP: ${c.rsrp.toFixed(1)} | PCI: ${c.pci??'N/A'}`,{sticky:true});
    });
    const wrapper=byId('dtCellTableWrapper'),title=byId('dtCellPanelTitle'); if(!wrapper) return;
    if(title) title.innerHTML=`📡 NR Serving and Neighbor Cells — <b>Point ${ptIdx}</b><span style="font-weight:400;font-size:10px;opacity:0.75;margin-left:8px;">(${result.lat.toFixed(5)}, ${result.lng.toFixed(5)})</span>`;
    const dotColor=(val,type)=>{if(val==null)return'#aaa';if(type==='rsrp'){if(val>=-85)return'#0042a5';if(val>=-95)return'#00a955';if(val>=-105)return'#ffd000';return'#ff3333';}if(type==='sinr'){if(val>=10)return'#00a955';if(val>=0)return'#ffd000';return'#ff3333';}return'#aaa';};
    const drawnSitesTable={};let lineIdx=0;
    cells.forEach(c=>{if(drawnSitesTable[c.siteId]===undefined)drawnSitesTable[c.siteId]=lineIdx++;});
    let rows='';
    cells.forEach((c,i)=>{
      const li=drawnSitesTable[c.siteId],lc=LINE_COLORS[Math.min(li,LINE_COLORS.length-1)],isFirst=i===0;
      const typeLabel=isFirst?`<span class="cell-type serving" style="border-left-color:${lc}">Serving</span>`:`<span class="cell-type detected" style="border-left-color:${lc}">Detected</span>`;
      const pciStr=c.pci!=null?c.pci:'N/A',sinrStr=c.sinr!=null?c.sinr.toFixed(2):'—',cName=c.cellName||`${c.siteId}_Sek${c.sectorNum}`;
      rows+=`<tr class="${isFirst?'row-serving':'row-detected'}"><td>${typeLabel}</td><td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c.pciColor||'#aaa'};margin-right:3px;vertical-align:middle;border:1px solid rgba(0,0,0,0.2)"></span>${pciStr}</td><td>${c.arfcn||466850}</td><td><span class="dot" style="background:${dotColor(c.rsrp,'rsrp')}"></span>${c.rsrp.toFixed(2)}</td><td><span class="dot" style="background:${dotColor(c.sinr,'sinr')}"></span>${sinrStr}</td><td>${c.cellId??'—'}</td><td title="${cName}">${cName.length>30?cName.slice(0,30)+'…':cName}</td><td>${c.dist.toFixed(0)}</td></tr>`;
    });
    wrapper.innerHTML=`<table class="cell-table"><thead><tr><th>Type</th><th>PCI</th><th>ARFCN</th><th>SS-RSRP(dBm)</th><th>SS-SINR(dB)</th><th>Cell ID</th><th>Cell Name</th><th>Distance(m)</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function updateLegend() {
    const legend=byId('dtLegend'),tbody=byId('dtLegendBody'); if(!legend||!tbody)return;
    const B=[
      {label:'-85~0 dBm',color:'#0042a5',fn:v=>v>=-85&&v<0},{label:'-95~-85 dBm',color:'#00a955',fn:v=>v>=-95&&v<-85},
      {label:'-105~-95 dBm',color:'#70ff66',fn:v=>v>=-105&&v<-95},{label:'-120~-105 dBm',color:'#fffb00',fn:v=>v>=-120&&v<-105},
      {label:'-125~-120 dBm',color:'#ff3333',fn:v=>v>=-125&&v<-120},{label:'< -125 dBm',color:'#800000',fn:v=>v<-125},
    ];
    const total=simResults.length||1;
    tbody.innerHTML=B.map(b=>{const cnt=simResults.filter(r=>b.fn(parseFloat(r.rsrp))).length;return`<tr><td><div style="width:13px;height:13px;background:${b.color};border-radius:3px;display:inline-block;"></div></td><td>${b.label}</td><td><b>${((cnt/total)*100).toFixed(1)}%</b></td></tr>`;}).join('');
    legend.style.display='block'; byId('pciLegend').style.display='none';
  }

  function evaluateModel(results) {
    const paired=results.filter(r=>r.rsrp_actual!=null),pairedS=results.filter(r=>r.sinr_actual!=null);
    if(!paired.length) return null;
    const cs=diffs=>{const n=diffs.length,me=mean(diffs),ma=diffs.reduce((s,d)=>s+Math.abs(d),0)/n;return{me:+me.toFixed(3),mae:+ma.toFixed(3),rmse:+rmseF(diffs).toFixed(3),n};};
    return{rsrp:cs(paired.map(r=>parseFloat(r.rsrp)-r.rsrp_actual)),sinr:pairedS.length?cs(pairedS.map(r=>parseFloat(r.sinr)-r.sinr_actual)):null,nPaired:paired.length};
  }

  function renderStats() {
    const box=byId('resultBox'); if(!box)return;
    const total=simResults.length,pairedR=simResults.filter(r=>r.rsrp_actual!=null),pairedS=simResults.filter(r=>r.sinr_actual!=null);
    const pciMatchedCount=simResults.filter(r=>r.pciInfo?.matched).length,cal=calibration;
    const statBlock=(pairs,key,actKey,unit,okRmse,warnRmse)=>{
      if(!pairs.length)return'<p style="color:rgba(255,255,255,0.5);font-size:11px;">Tidak ada data paired</p>';
      const diffs=pairs.map(r=>parseFloat(r[key])-r[actKey]),n=diffs.length,me=+(mean(diffs).toFixed(3));
      const ma=+(diffs.reduce((s,d)=>s+Math.abs(d),0)/n).toFixed(3),rm=+(Math.sqrt(diffs.reduce((s,d)=>s+d*d,0)/n)).toFixed(3);
      const avgSim=(simResults.reduce((s,r)=>s+parseFloat(r[key]),0)/total).toFixed(1);
      const avgAct=(pairs.reduce((s,r)=>s+r[actKey],0)/pairs.length).toFixed(1);
      return`<div class="stat-grid"><div class="stat-cell"><span class="stat-lbl">Avg Sim</span><span class="stat-val">${avgSim} ${unit}</span></div><div class="stat-cell"><span class="stat-lbl">Avg Aktual</span><span class="stat-val">${avgAct} ${unit}</span></div><div class="stat-cell ${Math.abs(me)<=2?'stat-ok':Math.abs(me)<=5?'':'stat-warn'}"><span class="stat-lbl">Mean Error</span><span class="stat-val">${me>0?'+':''}${me} dB</span></div><div class="stat-cell ${rm<=okRmse?'stat-ok':rm<=warnRmse?'':'stat-warn'}"><span class="stat-lbl">RMSE</span><span class="stat-val">${rm} dB</span></div><div class="stat-cell"><span class="stat-lbl">MAE</span><span class="stat-val">${ma} dB</span></div><div class="stat-cell"><span class="stat-lbl">n paired</span><span class="stat-val">${pairs.length}</span></div></div>`;
    };
    box.innerHTML=`<h3>📶 Hasil Simulasi v17.0</h3><p class="result-meta">${total} titik | σ=${cal.sigmaEff.toFixed(2)} dB (${cal.sigmaSource})<br>IM=${INTERFERENCE_MARGIN_DB} dB [TR 36.942] | Rx floor ${RX_SENSITIVITY_FLOOR} dBm [TS 38.101-1]<br>PCI matched: ${pciMatchedCount}/${total}</p><div class="stat-section-title" style="margin-top:8px;">📶 RSRP</div>${statBlock(pairedR,'rsrp','rsrp_actual','dBm',5,10)}<div class="stat-section-title" style="margin-top:8px;">📡 SINR</div>${statBlock(pairedS,'sinr','sinr_actual','dB',3,6)}<div class="result-footer">✅ Klik titik di peta → tabel sel</div>`;
    box.style.display='block';
  }

  // ── CSV upload ────────────────────────────────────────────────────────────
  function handleCsvUpload(e) {
    const file=e.target.files[0]; if(!file)return;
    setStatus('csvStatus','⏳ Membaca CSV...','info');
    if(typeof Papa!=='undefined'){Papa.parse(file,{header:true,dynamicTyping:false,skipEmptyLines:true,complete:r=>processCsvData(r.data,r.meta.fields),error:()=>setStatus('csvStatus','❌ Gagal membaca file','error')});}
    else{const reader=new FileReader();reader.onload=ev=>{const lines=ev.target.result.split('\n').filter(l=>l.trim()),delim=lines[0].includes('\t')?'\t':',',fields=lines[0].split(delim).map(h=>h.trim().replace(/"/g,'')),rows=lines.slice(1).map(line=>{const vals=line.split(delim).map(v=>v.trim().replace(/"/g,''));const obj={};fields.forEach((h,i)=>obj[h]=vals[i]??'');return obj;});processCsvData(rows,fields);};reader.readAsText(file);}
  }

  function detectCols(headers) {
    const find=cands=>{for(const h of headers){const hl=h.toLowerCase().replace(/[\s()]/g,'');if(cands.some(c=>hl===c||hl.startsWith(c)))return h;}return null;};
    return{lat:find(['latitude','lat','lintang','y']),lng:find(['longitude','lon','lng','long','bujur','x']),rsrp:find(['rsrpdbm','rsrp','ltersrp','nrrsrp','signal']),sinr:find(['sinrdb','sinr','ltsinr','nrsinr','snr']),pci:find(['pci','physicalcellid','physicalcell','pcid','nrpci','ltepci','cellid'])};
  }

  const parseNum  = v=>{if(v===null||v===undefined||v==='')return null;const n=parseFloat(v);return isNaN(n)?null:n;};
  const parseInt2 = v=>{if(v===null||v===undefined||v==='')return null;const n=parseInt(v,10);return isNaN(n)?null:n;};

  function processCsvData(rows, headers) {
    const cols=detectCols(headers||Object.keys(rows[0]||{}));
    if(!cols.lat||!cols.lng){setStatus('csvStatus','❌ Kolom Lat/Lng tidak ditemukan.','error');return;}
    const raw=rows.map(r=>({lat:parseNum(r[cols.lat]),lng:parseNum(r[cols.lng]),rsrp:cols.rsrp?parseNum(r[cols.rsrp]):null,sinr:cols.sinr?parseNum(r[cols.sinr]):null,pci:cols.pci?parseInt2(r[cols.pci]):null})).filter(p=>p.lat!==null&&p.lng!==null&&!isNaN(p.lat)&&!isNaN(p.lng)&&p.lat!==0&&p.lng!==0&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180);
    const noGlitch=[];raw.forEach((pt,i)=>{if(i===0){noGlitch.push(pt);return;}if(haversine(noGlitch.at(-1).lat,noGlitch.at(-1).lng,pt.lat,pt.lng)<=500)noGlitch.push(pt);});
    dtPoints=noGlitch.filter((pt,i)=>i===0||pt.lat!==noGlitch[i-1].lat||pt.lng!==noGlitch[i-1].lng);
    simPoints=dtPoints.filter(p=>p.rsrp!==null);
    if(dtPoints.length<3){setStatus('csvStatus','❌ Terlalu sedikit titik.','error');return;}
    if(simPoints.length<5){setStatus('csvStatus','⚠️ Minimal 5 titik RSRP.','warn');return;}
    let totalDist=0;for(let i=1;i<dtPoints.length;i++)totalDist+=haversine(dtPoints[i-1].lat,dtPoints[i-1].lng,dtPoints[i].lat,dtPoints[i].lng);
    dtPointLayer.clearLayers();heatmapLayer.clearLayers();cellLineLayer.clearLayers();simResults=[];calibration=null;
    L.polyline(dtPoints.map(p=>[p.lat,p.lng]),{color:'#aaa',weight:2,opacity:0.4,dashArray:'4 4'}).addTo(dtPointLayer);
    simPoints.forEach(p=>{L.circleMarker([p.lat,p.lng],{radius:3,fillColor:'#00cc88',color:'none',fillOpacity:0.55}).addTo(dtPointLayer).bindPopup(`RSRP:${p.rsrp}${p.sinr!=null?` | SINR:${p.sinr}`:''}${p.pci!=null?` | PCI:${p.pci}`:''}`);});
    const guide=byId('mapGuide');if(guide)guide.style.display='none';
    const hasPCI=simPoints.filter(p=>p.pci!==null).length;
    setStatus('csvStatus',`✅ ${dtPoints.length} GPS | ${simPoints.length} ber-RSRP | ~${(totalDist/1000).toFixed(2)} km`,'ok');
    setText('infoRawPoints',dtPoints.length);setText('infoSimPoints',simPoints.length);setText('infoNoRsrp',dtPoints.length-simPoints.length);setText('infoFiltered',rows.length-dtPoints.length);setText('infoRouteDist',`${(totalDist/1000).toFixed(2)} km`);setText('infoHasRSRP',`✓ ${simPoints.length}`);setText('infoHasSINR',simPoints.filter(p=>p.sinr!==null).length>0?`✓ ${simPoints.filter(p=>p.sinr!==null).length}`:'✗');setText('infoHasPCI',hasPCI>0?`✓ ${hasPCI}`:'✗');
    if(Object.keys(siteIndex).length)autoDetectAndCalibrate();else setStatus('siteMatchStatus','⚠️ Menunggu data site...','warn');
  }

  // ── Debug ─────────────────────────────────────────────────────────────────
  function showDebug() {
    if(!calibration){alert('Kalibrasi belum tersedia.');return;}
    const c=calibration,site=siteIndex[primarySite?.id];
    alert([
      `=== DT Simulation v17.0: ${primarySite?.id||'?'} ===`,``,
      `=== Model Propagasi ===`,
      `  3GPP TR 38.901: ${(site?.scenario||'uma').toUpperCase()} ${(site?.condition||'nlos').toUpperCase()}`,
      `  f_c=${CAL.FREQUENCY} MHz | h_BS=${site?.height||30} m | h_UT=${CAL.MOBILE_H} m`,
      `  Clutter loss: ${getClutterLoss(site?.clutter).toFixed(1)} dB [ITU-R P.1411-10]`,
      `  Antenna: θ_3dB=${CAL.BEAMWIDTH}° A_m=${CAL.ANTENNA_Am} dB [TR 36.942]`,
      `  Rx floor: ${RX_SENSITIVITY_FLOOR} dBm [TS 38.101-1]`,``,
      `=== Kalibrasi Empiris (${c.nPaired} titik) ===`,
      `  σ_empiris = ${c.sigmaEff.toFixed(2)} dB (${c.sigmaSource})`,
      `  σ_3GPP fallback = ${c.sigma3gpp.toFixed(2)} dB [TR 38.901 Table 7.4.4]`,
      `  Global bias: ${c.globalBias>0?'+':''}${c.globalBias.toFixed(2)} dB`,
      `  Global gain G: ${c.globalGain>0?'+':''}${c.globalGain.toFixed(2)} dB`,
      `  RMSE sebelum: ${c.rmse3gpp.toFixed(2)} dB → sesudah: ${c.rmseAfter.toFixed(2)} dB`,``,
      `=== SINR ===`,
      `  Formula: SINR = S / (I + N + I_IM) [TR 36.942 §A.1]`,
      `  Thermal noise N = ${THERMAL_NOISE_DBM.toFixed(1)} dBm`,
      `  Interference margin IM = ${INTERFERENCE_MARGIN_DB} dB [TR 36.942]`,
    ].join('\n'));
  }

  function exportCSV() {
    if(!simResults.length)return alert('Jalankan simulasi terlebih dahulu!');
    const hasActR=simResults.some(r=>r.rsrp_actual!=null),hasActS=simResults.some(r=>r.sinr_actual!=null);
    let csv='Point,Lat,Lng,Distance(m),TA_Seg,PCI_CSV,PCI_Matched,SiteID,SectorNum,CellName,RSRP_3GPP(dBm),Clutter_Loss(dB),Bias_Seg(dB),Gain_G(dB),Sigma_Eff(dB),RSRP_Sim(dBm),SINR_Sim(dB)';
    if(hasActR)csv+=',RSRP_Aktual(dBm),Delta_RSRP(dB)';if(hasActS)csv+=',SINR_Aktual(dB),Delta_SINR(dB)';csv+='\n';
    simResults.forEach(r=>{
      const pi=r.pciInfo;
      csv+=`${r.index},${r.lat},${r.lng},${r.distance},${r.ta_seg},${r.pci},${pi?.matched?'yes':'no'},${r.siteId},${pi?.sectorNum||''},${pi?.cellName||''},${r.rsrp3gpp},${r.clutter_loss},${r.bias_seg},${r.gain_g},${r.sigma_eff},${r.rsrp},${r.sinr}`;
      if(hasActR){const d=r.rsrp_actual!=null?(parseFloat(r.rsrp)-r.rsrp_actual).toFixed(2):'';csv+=`,${r.rsrp_actual??''},${d}`;}
      if(hasActS){const d=r.sinr_actual!=null?(parseFloat(r.sinr)-r.sinr_actual).toFixed(2):'';csv+=`,${r.sinr_actual??''},${d}`;}
      csv+='\n';
    });
    const blob=new Blob([csv],{type:'text/csv'}),ts=new Date().toISOString().slice(0,19).replace(/:/g,'-');
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`SimDT_v170_${ts}.csv`;
    document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href);
  }

  // ── Site rendering ────────────────────────────────────────────────────────
  function renderAllSites() {
    siteLayer.clearLayers();
    Object.entries(siteIndex).forEach(([id,s])=>{L.circleMarker([s.lat,s.lng],{radius:4,fillColor:'#aab8d8',color:'#556',weight:1,fillOpacity:0.9}).addTo(siteLayer).bindPopup(`<b>${id}</b><br>H:${s.height}m | ${s.clutter||'N/A'}`);});
  }

  function highlightPrimarySiteOnMap(primaryId) {
    siteLayer.clearLayers();
    Object.entries(siteIndex).forEach(([id,s])=>{
      const isPrimary=id===primaryId,isNeighbour=neighbourPool.some(nb=>nb.id===id);
      L.circleMarker([s.lat,s.lng],{radius:isPrimary?13:isNeighbour?6:4,fillColor:isPrimary?'#ffd000':isNeighbour?'#ff8c00':'#aab8d8',color:isPrimary?'#000':'#556',weight:isPrimary?3:isNeighbour?2:1,fillOpacity:1})
        .addTo(siteLayer).bindPopup(`${isPrimary?'⭐ ':isNeighbour?'📡 ':''}<b>${id}</b><br>H:${s.height}m | ${s.clutter||'N/A'}`);
      if(isPrimary){(s.sectorData||[]).length>0?s.sectorData.forEach((sec,i)=>drawSectorFan(s.lat,s.lng,sec.azimuth,65,200,i,0.18,MAIN_SECTOR_COLORS[i%MAIN_SECTOR_COLORS.length])):normalizeSectors(s).forEach((az,i)=>drawSectorFan(s.lat,s.lng,az,65,200,i,0.18,MAIN_SECTOR_COLORS[i%MAIN_SECTOR_COLORS.length]));}
      else if(isNeighbour){const nbData=neighbourPool.find(nb=>nb.id===id),nbIdx=neighbourPool.findIndex(nb=>nb.id===id),nbSD=nbData?.sectorData||[];nbSD.length>0?nbSD.forEach((sec,si)=>{const ci=(nbIdx*6+si)%NEIGHBOUR_PALETTE.length;drawSectorFan(s.lat,s.lng,sec.azimuth,65,150,si,0.08,NEIGHBOUR_PALETTE[ci]);}):(normalizeSectors(s).forEach((az,si)=>{const ci=(nbIdx*6+si)%NEIGHBOUR_PALETTE.length;drawSectorFan(s.lat,s.lng,az,65,150,si,0.08,NEIGHBOUR_PALETTE[ci]);}));}
    });
  }

  function drawSectorFan(lat,lng,az,bw,radius,idx,fillOpacity,color) {
    const pts=[[lat,lng]];
    for(let i=0;i<=16;i++){const ang=(az-bw/2)+(i/16)*bw,p=destPoint(lat,lng,ang,radius);pts.push([p.lat,p.lng]);}
    pts.push([lat,lng]);
    const c=color||SECTOR_COLORS[idx%SECTOR_COLORS.length];
    L.polygon(pts,{color:c,fillColor:c,fillOpacity,weight:2,opacity:0.7}).addTo(siteLayer).bindPopup(`<b>Sektor ${idx+1}</b> | Az:${az}°`);
  }

  // ── Geo utils ─────────────────────────────────────────────────────────────
  function haversine(la1,lo1,la2,lo2){const R=6378137,dLa=(la2-la1)*Math.PI/180,dLo=(lo2-lo1)*Math.PI/180,a=Math.sin(dLa/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
  function calcBearing(la1,lo1,la2,lo2){const p1=la1*Math.PI/180,p2=la2*Math.PI/180,dl=(lo2-lo1)*Math.PI/180;return(Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360;}
  function destPoint(lat,lng,az,dist){const R=6378137,b=az*Math.PI/180,d=dist/R,la1=lat*Math.PI/180,lo1=lng*Math.PI/180,la2=Math.asin(Math.sin(la1)*Math.cos(d)+Math.cos(la1)*Math.sin(d)*Math.cos(b)),lo2=lo1+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la1),Math.cos(d)-Math.sin(la1)*Math.sin(la2));return{lat:la2*180/Math.PI,lng:lo2*180/Math.PI};}
  function normalizeSectors(site){if(!Array.isArray(site.sectors)||!site.sectors.length)return[];return site.sectors.map(s=>{if(typeof s==='object'&&s!==null)return parseFloat(s.azimuth??s.az??0);const n=parseFloat(s);return isNaN(n)?0:n;});}
  function rsrpColor(v){if(v>=-85)return'#0042a5';if(v>=-95)return'#00a955';if(v>=-105)return'#70ff66';if(v>=-120)return'#fffb00';if(v>=-125)return'#ff3333';return'#800000';}

  function byId(id){return document.getElementById(id);}
  function setText(id,v){const e=byId(id);if(e)e.textContent=v;}
  function enableBtn(id){const e=byId(id);if(e)e.disabled=false;}
  function setStatus(id,msg,type){const e=byId(id);if(!e)return;e.innerHTML=msg;e.className=`status-msg status-${type}`;}

})();

console.log('simulation_dt_v17.js — σ empiris dari data | IM=2dB [TR 36.942] | ITU-R P.1411-10 (bukan COST 231)');