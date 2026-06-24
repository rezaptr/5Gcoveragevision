// ================= SIMULATION DT v20.1 — PCI MODE + UNIFIED TOOLBAR =================
//
// PERUBAHAN v20.0 → v20.1:
//   [UI-5] renderStats() — MAE diganti SD (Standar Deviasi error)
//          SD = √(Σ(dᵢ - ME)² / N), berbeda dari RMSE yang tidak dikurangi mean
//   [UI-6] Export CSV dipindah ke paling bawah panel (HTML)
//
// PERUBAHAN DARI v19.x → v20.0 (UI ONLY — kalkulasi tidak berubah):
//
//   [UI-1] Toolbar diperbarui — tombol baru:
//          btnSimRSRP → trigger runSimulation() (sama persis seperti sebelumnya)
//          btnSimSINR → switch ke SINR display mode
//          btnSimPCI  → simulasi PCI mode (mirror simulation.js)
//
//   [UI-2] onPointClick() — tabel sel sekarang menampilkan:
//          Type | PCI | ARFCN | SS-RSRP | SS-SINR | Cell ID | Cell Name | Distance
//          Data PCI/ARFCN/CellID sudah ada di _serving & cells sejak v19,
//          hanya belum ditampilkan di UI.
//
//   [UI-3] exportCSV() — tambah kolom PCI, ARFCN, Cell_ID, Cell_Name
//          di export (data sudah ada di simResults._serving)
//
//   [UI-4] Fungsi baru ditambahkan (tidak mempengaruhi kalkulasi):
//          runSINROnly(), simulatePCI(), redrawPCIMode(), updatePCILegend()
//
// TIDAK DIUBAH SAMA SEKALI:
//   - runSimulation(), computeSectorRsrp(), computeSINR()
//   - pathLoss(), antennaGain(), spatialNoise()
//   - buildGlobalSectorList(), buildNeighbourPool()
//   - Semua konstanta RF, FIXED_SEED, threshold
//   - Semua logika kalkulasi RSRP & SINR
//
// REFERENSI:
//   - 3GPP TR 38.901 v17  : Channel model §7.6 multi-cell
//   - 3GPP TR 36.942      : §A.1 dominant interferer model
//   - 3GPP TS 38.101-1    : NR UE radio transmission
//   - ITU-R M.2135        : §A.1 shadow fading clamp
// ==============================================================================
(function () {
  'use strict';

  if (!document.getElementById('map-dt-sim')) return;

  // ── State ────────────────────────────────────────────────────────────────
  let dtMap;
  let siteLayer, dtPointLayer, heatmapLayer, cellLineLayer;
  let siteIndex        = {};
  let primarySite      = null;
  let neighbourPool    = [];
  let dtPoints         = [];
  let simPoints        = [];
  let simResults       = [];
  let globalSectorList = [];
  let dtDisplayMode    = 'rsrp';

  let propagasiOverride = { scenario: null, condition: null };

  const SESSION_KEY    = 'siteIndexData';
  const MAX_NEIGHBOURS = 6;
  const FIXED_SEED     = 20250101;

  const DOMINANT_INTERFERER_THRESHOLD_DB = 20;

  const MAIN_SECTOR_COLORS = ['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#42d4f4'];
  const NEIGHBOUR_PALETTE  = [
    '#f032e6','#bfef45','#469990','#dcbeff','#9a6324','#800000',
    '#aaffc3','#808000', '#ffd8b1', '#fffac8', '#000075', '#a9a9a9',
    '#00ffff','#ff00ff', '#ffff00','#ff1493','#00fa9a',
    '#daa520', '#ff8c00', '#9370db', '#20b2aa','#00ced1','#ba55d3', '#adff2f','#ff69b4'
  ];
  const LINE_COLORS   = ['#00c050','#1a6fff','#ff8800','#ffd000','#ff3333','#888888'];
  const SECTOR_COLORS = ['#ff2d55','#00c7be','#ffcc00','#af52de','#ff9500','#34c759'];

  // ══════════════════════════════════════════════════════════════════════════
  // KONSTANTA RF — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  const CAL = {
    TX_POWER  : 46,
    FREQUENCY : 2300,
    BANDWIDTH : 30e6,
    MOBILE_H  : 1.5,
    ANTENNA_Am: 25,
    BEAMWIDTH : 65,
    NF        : 7,
  };

  const RX_SENSITIVITY_FLOOR    = -125.2;
  const INTERFERENCE_MARGIN_DB  = 2.0;
  const INTERFERENCE_MARGIN_FACTOR = Math.pow(10, INTERFERENCE_MARGIN_DB / 10);
  const THERMAL_NOISE_DBM          = -174 + 10 * Math.log10(CAL.BANDWIDTH) + CAL.NF;

  const SHADOW_STD_3GPP = {
    uma_los   : 4.0, uma_nlos  : 6.0, uma_mixed : 5.5,
    umi_los   : 4.0, umi_nlos  : 7.82, umi_mixed : 7.0,
    rma_los   : 4.0, rma_nlos  : 8.0, rma_mixed : 6.5,
  };

  const CLUTTER_LOSS_DB = {
    dense_urban: 0.0, metropolitan: 0.0, urban: 0.0,
    suburban: 1.0, sub_urban: 1.0, rural: 0.5, 'n/a': 0.0,
  };

  // ── Override accessor — tidak diubah ─────────────────────────────────────
  function getSectorScenario(sec) {
    if (propagasiOverride.scenario) return propagasiOverride.scenario;
    return (sec.scenario || 'uma').toLowerCase();
  }
  function getSectorCondition(sec) {
    const raw = propagasiOverride.condition || (sec.condition || 'nlos');
    const cnd = raw.toLowerCase();
    return cnd === 'los_nlos' ? 'mixed' : cnd;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPATIAL NOISE — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  const SPATIAL_GRID_SIZE = 0.0005;

  function hashInt(n) {
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    return ((n >>> 16) ^ n) >>> 0;
  }

  function spatialNoise(lat, lng, std) {
    const cLat = Math.round(lat / SPATIAL_GRID_SIZE);
    const cLng = Math.round(lng / SPATIAL_GRID_SIZE);
    const s1   = hashInt(cLat * 73856093 ^ cLng * 19349663 ^ (FIXED_SEED >>> 0));
    const s2   = hashInt(s1 + 2654435761);
    const u1   = (s1 >>> 0) / 4294967296 + 1e-10;
    const u2   = (s2 >>> 0) / 4294967296 + 1e-10;
    const raw  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std;
    return Math.max(-2 * std, Math.min(2 * std, raw));
  }

  // ── Helpers — tidak diubah ────────────────────────────────────────────────
  const mean  = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const rmseF = arr => Math.sqrt(arr.reduce((s, d) => s + d * d, 0) / arr.length);
  const sdF   = arr => { const m = mean(arr); return Math.sqrt(arr.reduce((s, d) => s + (d - m) ** 2, 0) / arr.length); };

  function dbmToLinear(dbm) { return Math.pow(10, dbm / 10); }
  function linearToDbm(mw)  { return 10 * Math.log10(Math.max(mw, 1e-15)); }
  function applyRxFloor(v)  { return Math.max(RX_SENSITIVITY_FLOOR, v); }

  // ══════════════════════════════════════════════════════════════════════════
  // PATH LOSS — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function pathLoss(scenario, condition, d2D, freq, hBS, hUT) {
    const d   = Math.max(d2D, 10);
    const hU  = hUT || 1.5;
    const fc  = freq / 1000;
    const c   = 3e8;
    const d3D = Math.sqrt(d * d + (hBS - hU) ** 2);

    const pLOS_UMa = d2 => {
      if (d2 <= 18) return 1.0;
      const C = hU <= 13 ? 0 : Math.pow((hU - 13) / 10, 1.5);
      return (18/d2 + Math.exp(-d2/63)*(1-18/d2)) *
             (1 + C*(5/4)*Math.pow(d2/100,3)*Math.exp(-d2/150));
    };
    const pLOS_UMi = d2 =>
      d2 <= 18 ? 1.0 : 18/d2 + Math.exp(-d2/36)*(1-18/d2);

    switch (scenario) {
      case 'uma': {
        const hE  = 1.0;
        const dBP = 4*(hBS-hE)*(hU-hE)*(freq*1e6)/c;
        const pl_los = d <= dBP
          ? 28 + 22*Math.log10(d3D) + 20*Math.log10(fc)
          : 28 + 40*Math.log10(d3D) + 20*Math.log10(fc)
            - 9*Math.log10(dBP**2+(hBS-hU)**2);
        if (condition === 'los') return pl_los;
        const pl_nlos = Math.max(
          13.54 + 39.08*Math.log10(d3D) + 20*Math.log10(fc) - 0.6*(hU-1.5), pl_los
        );
        if (condition === 'nlos') return pl_nlos;
        const p = pLOS_UMa(d);
        return p*pl_los + (1-p)*pl_nlos;
      }
      case 'umi': {
        const hE  = 1.0;
        const dBP = 4*(hBS-hE)*(hU-hE)*(freq*1e6)/c;
        const pl_los = d <= dBP
          ? 32.4 + 21*Math.log10(d3D) + 20*Math.log10(fc)
          : 32.4 + 40*Math.log10(d3D) + 20*Math.log10(fc)
            - 9.5*Math.log10(dBP**2+(hBS-hU)**2);
        if (condition === 'los') return pl_los;
        const pl_nlos = Math.max(
          22.4 + 35.3*Math.log10(d3D) + 21.3*Math.log10(fc) - 0.3*(hU-1.5), pl_los
        );
        if (condition === 'nlos') return pl_nlos;
        const p = pLOS_UMi(d);
        return p*pl_los + (1-p)*pl_nlos;
      }
      case 'rma': {
        const h = 5, W = 20;
        const dBP = 2*Math.PI*hBS*hU*(freq*1e6)/c;
        const A1  = Math.min(0.03*Math.pow(h,1.72),10);
        const A2  = Math.min(0.044*Math.pow(h,1.72),14.77);
        const A3  = 0.002*Math.log10(h);
        let pl_los;
        if (d <= dBP) {
          pl_los = 20*Math.log10(40*Math.PI*d3D*fc/3)+A1*Math.log10(d3D)-A2+A3*d3D;
        } else {
          const d3D_BP = Math.sqrt(dBP**2+(hBS-hU)**2);
          pl_los = 20*Math.log10(40*Math.PI*d3D_BP*fc/3)+A1*Math.log10(d3D_BP)
                 -A2+A3*d3D_BP+40*Math.log10(d3D/d3D_BP);
        }
        if (condition === 'los') return pl_los;
        return Math.max(
          161.04-7.1*Math.log10(W)+7.5*Math.log10(h)
          -(24.37-3.7*(h/hBS)**2)*Math.log10(hBS)
          +(43.42-3.1*Math.log10(hBS))*(Math.log10(d3D)-3)
          +20*Math.log10(fc)-(3.2*(Math.log10(11.75*hU))**2-4.97),
          pl_los
        );
      }
      default:
        return 28 + 22*Math.log10(d3D) + 20*Math.log10(fc);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ANTENNA GAIN — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function antennaGain(angOff) {
    return -Math.min(12*(angOff/(CAL.BEAMWIDTH/2))**2, CAL.ANTENNA_Am);
  }

  function getClutterLoss(clutterName) {
    const key = (clutterName || 'n/a').toLowerCase().replace(/[\s-]+/g,'_');
    if (CLUTTER_LOSS_DB[key] !== undefined) return CLUTTER_LOSS_DB[key];
    for (const [k, v] of Object.entries(CLUTTER_LOSS_DB))
      if (key.includes(k) || k.includes(key)) return v;
    return CLUTTER_LOSS_DB['n/a'];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPUTE RSRP PER SEKTOR — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function computeSectorRsrp(pt, sec) {
    const dist   = haversine(pt.lat, pt.lng, sec.siteLat, sec.siteLng);
    const d      = Math.max(dist, 10);
    const brng   = calcBearing(sec.siteLat, sec.siteLng, pt.lat, pt.lng);
    const offset = Math.abs(((brng - sec.azimuth + 540) % 360) - 180);
    const gainDb = antennaGain(offset);
    const hBS    = sec.siteHeight || 30;
    const sc     = getSectorScenario(sec);
    const cond   = getSectorCondition(sec);
    const pl     = pathLoss(sc, cond, d, CAL.FREQUENCY, hBS, CAL.MOBILE_H);
    const cl     = getClutterLoss(sec.clutter);
    const scenKey = `${sc}_${cond}`;
    const sigma  = SHADOW_STD_3GPP[scenKey] || 6.0;
    const xi     = spatialNoise(pt.lat, pt.lng, sigma);
    const rsrp   = applyRxFloor(CAL.TX_POWER + gainDb - pl - cl + xi);
    return { rsrp, dist, gainDb, pl, cl, sigma, xi, scenario: sc, condition: cond };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SINR — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function computeSINR(servingRsrp_dbm, allNonServingRsrp_dbm) {
    const thresholdDbm = servingRsrp_dbm - DOMINANT_INTERFERER_THRESHOLD_DB;
    const S = dbmToLinear(servingRsrp_dbm);
    const N = dbmToLinear(THERMAL_NOISE_DBM);
    const I_base = N * INTERFERENCE_MARGIN_FACTOR;
    let I = I_base;
    let nDominant = 0;
    allNonServingRsrp_dbm.forEach(r => {
      if (r >= thresholdDbm) { I += dbmToLinear(r); nDominant++; }
    });
    const sinr = Math.max(-3, Math.min(40, linearToDbm(S / I)));
    return { sinr, nDominant };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BUILD GLOBAL SECTOR LIST — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function buildGlobalSectorList() {
    globalSectorList = [];
    if (!primarySite) return;
    const primSite = siteIndex[primarySite.id];

    const primSectors = (primSite.sectorData || []).length > 0
      ? primSite.sectorData
      : (primSite.sectors || []).map((az, i) => ({
          sectorNum: i+1, azimuth: az, pci: null, cellId: null,
          cellName: `${primarySite.id}_Sek${i+1}`, gnbId: null, arfcn: 466850,
        }));

    primSectors.forEach((sec, i) => {
      globalSectorList.push({
        siteId: primarySite.id, siteLat: primSite.lat, siteLng: primSite.lng,
        siteHeight: primSite.height || 30, isMain: true,
        sectorNum: sec.sectorNum || (i+1), azimuth: sec.azimuth,
        pci: sec.pci, cellId: sec.cellId,
        cellName: sec.cellName || `${primarySite.id}_Sek${sec.sectorNum||i+1}`,
        gnbId: sec.gnbId || null, arfcn: sec.arfcn || 466850,
        pciColor: MAIN_SECTOR_COLORS[i % MAIN_SECTOR_COLORS.length],
        scenario: primSite.scenario || 'uma', condition: primSite.condition || 'nlos',
        clutter: primSite.clutter || 'N/A',
      });
    });

    neighbourPool.forEach((nb, nbIdx) => {
      const nbSectors = (nb.sectorData || []).length > 0
        ? nb.sectorData
        : (nb.sectors || []).map((az, i) => ({
            sectorNum: i+1, azimuth: az, pci: null, cellId: null,
            cellName: `${nb.id}_Sek${i+1}`, gnbId: null, arfcn: 466850,
          }));
      nbSectors.forEach((sec, si) => {
        globalSectorList.push({
          siteId: nb.id, siteLat: nb.lat, siteLng: nb.lng,
          siteHeight: nb.height || 30, isMain: false, nbIdx,
          sectorNum: sec.sectorNum || (si+1), azimuth: sec.azimuth,
          pci: sec.pci, cellId: sec.cellId,
          cellName: sec.cellName || `${nb.id}_Sek${sec.sectorNum||si+1}`,
          gnbId: sec.gnbId || null, arfcn: sec.arfcn || 466850,
          pciColor: NEIGHBOUR_PALETTE[(nbIdx*6+si) % NEIGHBOUR_PALETTE.length],
          scenario: nb.scenario || 'uma', condition: nb.condition || 'nlos',
          clutter: nb.clutter || 'N/A',
        });
      });
    });
    console.log(`[v20.0] globalSectorList: ${globalSectorList.length} sektor | ${1+neighbourPool.length} site`);
  }

  function buildNeighbourPool() {
    if (!primarySite) return;
    const primSite = siteIndex[primarySite.id];
    neighbourPool = Object.entries(siteIndex)
      .filter(([id]) => id !== primarySite.id)
      .map(([id, s]) => ({
        id, ...s,
        _dist: haversine(primSite.lat, primSite.lng, s.lat, s.lng),
      }))
      .sort((a, b) => a._dist - b._dist)
      .slice(0, MAX_NEIGHBOURS);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => {
    initMap(); setupEventListeners(); loadSiteIndex();
  });

  function initMap() {
    dtMap = L.map('map-dt-sim').setView([-6.2, 106.82], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(dtMap);
    dtPointLayer = L.layerGroup().addTo(dtMap);
    heatmapLayer = L.layerGroup().addTo(dtMap);
    cellLineLayer= L.layerGroup().addTo(dtMap);
    siteLayer    = L.layerGroup().addTo(dtMap);
  }

  // [v20.0] setupEventListeners — ganti btnRunSimulation → btnSimRSRP,
  // tambah btnSimSINR & btnSimPCI
  function setupEventListeners() {
    byId('dtCsvInput')?.addEventListener('change', handleCsvUpload);
    byId('btnSimRSRP')?.addEventListener('click',  runSimulation);
    byId('btnSimSINR')?.addEventListener('click',  runSINROnly);
    byId('btnSimPCI') ?.addEventListener('click',  simulatePCI);
    byId('btnExportCSV')?.addEventListener('click', exportCSV);
    byId('btnExportDtClean')?.addEventListener('click', exportDtClean);
    byId('btnBackToSim')?.addEventListener('click', () => window.location.href = '/main');
    byId('btnDebugSite')?.addEventListener('click', showDebug);
    byId('overrideScenario')?.addEventListener('change', onOverrideChanged);
    byId('overrideCondition')?.addEventListener('change', onOverrideChanged);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OVERRIDE — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function onOverrideChanged() {
    if (!primarySite) return;
    const site    = siteIndex[primarySite.id];
    const selSc   = byId('overrideScenario')?.value  || 'uma';
    const selCnd  = byId('overrideCondition')?.value || 'nlos';
    const siteSc  = (site.scenario  || 'uma').toLowerCase();
    const siteCnd = (site.condition || 'nlos').toLowerCase();
    const isOvr   = selSc !== siteSc || selCnd !== siteCnd;

    propagasiOverride.scenario  = selSc;
    propagasiOverride.condition = selCnd;

    byId('overrideScenario')?.classList.toggle('is-overridden', selSc  !== siteSc);
    byId('overrideCondition')?.classList.toggle('is-overridden', selCnd !== siteCnd);
    const badge = byId('overrideBadge');
    if (badge) badge.style.display = isOvr ? 'block' : 'none';

    const scenKey = `${selSc}_${selCnd}`;
    const sigma   = SHADOW_STD_3GPP[scenKey] || 6.0;
    setText('dispSiteModel', `${selSc.toUpperCase()} ${selCnd.toUpperCase()}${isOvr?' ⚠️':''}`);
    setStatus('overrideStatus',
      isOvr
        ? `✅ Override: <b>${selSc.toUpperCase()}-${selCnd.toUpperCase()}</b> (site: ${siteSc.toUpperCase()}-${siteCnd.toUpperCase()})<br>σ=${sigma} dB`
        : `✅ Sesuai site index: <b>${selSc.toUpperCase()}-${selCnd.toUpperCase()}</b><br>σ=${sigma} dB`,
      isOvr ? 'warn' : 'ok'
    );
    updateModelStatus();
    if (simResults.length > 0) runSimulation();
  }

  function populateOverrideDropdowns(site) {
    const sc  = (site.scenario  || 'uma').toLowerCase();
    const cnd = (site.condition || 'nlos').toLowerCase();
    const selSc  = byId('overrideScenario');
    const selCnd = byId('overrideCondition');
    if (selSc)  { selSc.value  = sc;  selSc.disabled  = false; }
    if (selCnd) { selCnd.value = cnd; selCnd.disabled = false; }
    propagasiOverride.scenario  = sc;
    propagasiOverride.condition = cnd;
    selSc?.classList.remove('is-overridden');
    selCnd?.classList.remove('is-overridden');
    const badge = byId('overrideBadge');
    if (badge) badge.style.display = 'none';
    const scenKey = `${sc}_${cnd}`;
    const sigma   = SHADOW_STD_3GPP[scenKey] || 6.0;
    setStatus('overrideStatus',
      `✅ Default site index: <b>${sc.toUpperCase()}-${cnd.toUpperCase()}</b><br>σ=${sigma} dB`, 'ok'
    );
  }

  function updateModelStatus() {
    if (!primarySite) return;
    const site  = siteIndex[primarySite.id];
    const sc    = propagasiOverride.scenario  || (site?.scenario  || 'uma').toLowerCase();
    const cnd   = propagasiOverride.condition || (site?.condition || 'nlos').toLowerCase();
    const sigma = SHADOW_STD_3GPP[`${sc}_${cnd}`] || 6.0;
    setStatus('modelStatus',
      `✅ UE-centric | <b>${sc.toUpperCase()}-${cnd.toUpperCase()}</b> (primary)<br>` +
      `σ=${sigma} dB | Shared field | ±2σ clamp | Seed:${FIXED_SEED}<br>` +
      `${globalSectorList.length} sektor RF pool | Dominant interferer ±${DOMINANT_INTERFERER_THRESHOLD_DB}dB`,
      'ok'
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LOAD SITE INDEX — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function loadSiteIndex() {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      try {
        const p = JSON.parse(saved);
        if (p && Object.keys(p).length > 0) { siteIndex = p; onSiteIndexLoaded('sessionStorage'); return; }
      } catch {}
    }
    setStatus('siteStatus', '⏳ Memuat data site...', 'info');
    fetch('/api/get-site')
      .then(r => r.json())
      .then(data => {
        if (!data.has_site || !data.siteIndex) { setStatus('siteStatus','⚠️ Belum ada data site.','warn'); return; }
        siteIndex = data.siteIndex;
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex));
        onSiteIndexLoaded('server');
      })
      .catch(() => setStatus('siteStatus','⚠️ Tidak bisa mengambil data site.','warn'));
  }

  function onSiteIndexLoaded(source) {
    const count = Object.keys(siteIndex).length;
    setStatus('siteStatus', `✅ ${count} site (${source})`, 'ok');
    setText('infoTotalSites', count);
    renderAllSites();
    if (dtPoints.length) autoDetectPrimarySite();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AUTO DETECT PRIMARY SITE — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function autoDetectPrimarySite() {
    if (!Object.keys(siteIndex).length || !dtPoints.length) return;
    const cLat = dtPoints.reduce((s, p) => s + p.lat, 0) / dtPoints.length;
    const cLng = dtPoints.reduce((s, p) => s + p.lng, 0) / dtPoints.length;
    let bestId = null, bestSite = null, minDist = Infinity;
    Object.entries(siteIndex).forEach(([id, s]) => {
      const d = haversine(cLat, cLng, s.lat, s.lng);
      if (d < minDist) { minDist = d; bestId = id; bestSite = s; }
    });
    if (!bestId) return;

    primarySite = { id: bestId, ...bestSite };
    const s = bestSite;

    setStatus('siteMatchStatus',
      `🎯 Site: <b>${bestId}</b> — ${(minDist/1000).toFixed(2)} km dari centroid rute`, 'ok');
    setText('dispSiteId',      bestId);
    setText('dispSiteCoord',   `${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}`);
    setText('dispSiteHeight',  `${s.height || 30} m`);
    const sectors = normalizeSectors(s);
    setText('dispSiteSectors', sectors.length
      ? `${sectors.length} sektor ` : '');
    setText('dispSiteClutter', s.clutter || '—');

    dtMap.setView([s.lat, s.lng], 15);
    buildNeighbourPool();
    buildGlobalSectorList();
    highlightPrimarySiteOnMap(bestId);
    populateOverrideDropdowns(bestSite);
    updateModelStatus();
    enableBtn('btnSimRSRP');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [v20.0] MODE DISPLAY — tambah pci mode
  // ══════════════════════════════════════════════════════════════════════════
  window.setDtDisplayMode = function (mode) {
    dtDisplayMode = mode;
    if (mode === 'sinr')      { redrawSINRMode(); updateSINRLegend(); }
    else if (mode === 'pci')  { redrawPCIMode(); }
    else                      { redrawRSRPMode(); updateRSRPLegend(); }
  };

  function redrawRSRPMode() {
    if (!simResults.length) return;
    heatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    simResults.forEach((r, idx) => {
      const m = L.circleMarker([r.lat, r.lng], {
        radius: 6, fillColor: rsrpColor(parseFloat(r.rsrp_sim)),
        color: '#333', weight: 0.5, fillOpacity: 0.92,
      }).addTo(heatmapLayer);
      m.on('click', () => onPointClick(r, idx+1));
    });
    byId('dtLegend').style.display   = 'block';
    byId('sinrLegend').style.display = 'none';
    byId('pciLegend').style.display  = 'none';
    updateRSRPLegend();
  }

  function redrawSINRMode() {
    if (!simResults.length) return;
    heatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    simResults.forEach((r, idx) => {
      const m = L.circleMarker([r.lat, r.lng], {
        radius: 6, fillColor: sinrColor(parseFloat(r.sinr_sim)),
        color: '#333', weight: 0.5, fillOpacity: 0.92,
      }).addTo(heatmapLayer);
      m.on('click', () => onPointClick(r, idx+1));
    });
    byId('dtLegend').style.display   = 'none';
    byId('sinrLegend').style.display = 'block';
    byId('pciLegend').style.display  = 'none';
    updateSINRLegend();
  }

  // [v20.0] Redraw PCI Mode — mirror dari simulation.js
  function redrawPCIMode() {
    if (!simResults.length) return;
    heatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    const pciDist = {};
    simResults.forEach((r, idx) => {
      const sv  = r._serving;
      const key = `${sv.siteId}|S${sv.sectorNum}`;
      if (!pciDist[key]) pciDist[key] = {
        siteId: sv.siteId, sectorNum: sv.sectorNum,
        pci: sv.pci, color: sv.pciColor,
        cellName: sv.cellName, count: 0,
      };
      pciDist[key].count++;
      const m = L.circleMarker([r.lat, r.lng], {
        radius: 6, fillColor: sv.pciColor || '#888',
        color: '#333', weight: 0.5, fillOpacity: 0.92,
      }).addTo(heatmapLayer);
      m.on('click', () => onPointClick(r, idx+1));
    });
    byId('dtLegend').style.display   = 'none';
    byId('sinrLegend').style.display = 'none';
    updatePCILegend(pciDist);
  }

  // [v20.0] Update PCI Legend
  function updatePCILegend(pciDist) {
    const legend = byId('pciLegend');
    const body   = byId('pciLegendBody');
    if (!legend || !body) return;
    const total  = simResults.length || 1;
    const sorted = Object.values(pciDist).sort((a, b) => b.count - a.count);
    body.innerHTML = sorted.map(d => {
      const pct    = ((d.count / total) * 100).toFixed(1);
      const pciStr = d.pci != null ? d.pci : 'N/A';
      return `<div class="pci-legend-row">
        <div class="pci-dot" style="background:${d.color}"></div>
        <span>${d.siteId} Sek${d.sectorNum} — PCI ${pciStr} (${d.count}, ${pct}%)</span>
      </div>`;
    }).join('');
    legend.style.display = 'block';
  }

  function updateRSRPLegend() {
    const legend = byId('dtLegend'), tbody = byId('dtLegendBody');
    if (!legend || !tbody) return;
    const B = [
      {label:'-85~0 dBm',     color:'#0042a5', fn:v=>v>=-85 &&v<0   },
      {label:'-95~-85 dBm',   color:'#00a955', fn:v=>v>=-95 &&v<-85 },
      {label:'-105~-95 dBm',  color:'#70ff66', fn:v=>v>=-105&&v<-95 },
      {label:'-120~-105 dBm', color:'#fffb00', fn:v=>v>=-120&&v<-105},
      {label:'-125~-120 dBm', color:'#ff3333', fn:v=>v>=-125&&v<-120},
      {label:'< -125 dBm',    color:'#800000', fn:v=>v<-125         },
    ];
    const total = simResults.length || 1;
    tbody.innerHTML = B.map(b => {
      const cnt = simResults.filter(r => b.fn(parseFloat(r.rsrp_sim))).length;
      return `<tr><td><div style="width:13px;height:13px;background:${b.color};border-radius:3px;display:inline-block;"></div></td><td>${b.label}</td><td><b>${((cnt/total)*100).toFixed(1)}%</b></td></tr>`;
    }).join('');
    legend.style.display = 'block';
  }

  function updateSINRLegend() {
    const legend = byId('sinrLegend'), tbody = byId('sinrLegendBody');
    if (!legend || !tbody) return;
    const B = [
      {label:'≥ 20 dB',    color:'#0042a5', fn:v=>v>=20       },
      {label:'10 ~ 20 dB', color:'#00a955', fn:v=>v>=10&&v<20 },
      {label:'0 ~ 10 dB',  color:'#70ff66', fn:v=>v>=0 &&v<10 },
      {label:'-5 ~ 0 dB',  color:'#fffb00', fn:v=>v>=-5&&v<0  },
      {label:'< -5 dB',    color:'#ff3333', fn:v=>v<-5        },
    ];
    const total = simResults.length || 1;
    tbody.innerHTML = B.map(b => {
      const cnt = simResults.filter(r => b.fn(parseFloat(r.sinr_sim))).length;
      return `<tr><td><div style="width:13px;height:13px;background:${b.color};border-radius:3px;display:inline-block;"></div></td><td>${b.label}</td><td><b>${((cnt/total)*100).toFixed(1)}%</b></td></tr>`;
    }).join('');
    legend.style.display = 'block';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RUN SIMULATION — TIDAK DIUBAH (kalkulasi murni)
  // ══════════════════════════════════════════════════════════════════════════
  function runSimulation() {
    if (!dtPoints.length)               return alert('Upload CSV DT terlebih dahulu!');
    if (!Object.keys(siteIndex).length) return alert('Data site belum dimuat!');
    if (!primarySite)                   return alert('Primary site belum terdeteksi!');
    if (!globalSectorList.length)       return alert('Sector pool kosong.');

    heatmapLayer.clearLayers();
    cellLineLayer.clearLayers();
    simResults = [];

    dtPoints.forEach((pt, idx) => {
      const sectorRsrpList = globalSectorList.map(sec => {
        const res = computeSectorRsrp(pt, sec);
        return {
          rsrp: res.rsrp, dist: res.dist, gainDb: res.gainDb,
          pl: res.pl, cl: res.cl, sigma: res.sigma, xi: res.xi,
          scenario: res.scenario, condition: res.condition,
          siteId: sec.siteId, siteLat: sec.siteLat, siteLng: sec.siteLng,
          isMain: sec.isMain, sectorNum: sec.sectorNum, azimuth: sec.azimuth,
          cellName: sec.cellName, pciColor: sec.pciColor,
          pci: sec.pci, cellId: sec.cellId, arfcn: sec.arfcn,
        };
      });

      sectorRsrpList.sort((a, b) => b.rsrp - a.rsrp);
      const serving    = sectorRsrpList[0];
      const nonServing = sectorRsrpList.slice(1);

      const { sinr: sinr_sim, nDominant } = computeSINR(
        serving.rsrp, nonServing.map(s => s.rsrp)
      );

      nonServing.forEach(sec => {
        const deltaRsrp = sec.rsrp - serving.rsrp;
        sec.sinr_est = Math.max(-10, Math.min(40, sinr_sim + deltaRsrp));
      });
      serving.sinr_est = sinr_sim;

      const bestPerSite = {};
      sectorRsrpList.forEach(sec => {
        if (!bestPerSite[sec.siteId] || sec.rsrp > bestPerSite[sec.siteId].rsrp)
          bestPerSite[sec.siteId] = sec;
      });
      const cellsForUI = Object.values(bestPerSite).sort((a, b) => {
        if (a.siteId === serving.siteId) return -1;
        if (b.siteId === serving.siteId) return 1;
        return b.rsrp - a.rsrp;
      });

      const markerColor = dtDisplayMode === 'sinr'
        ? sinrColor(sinr_sim) : rsrpColor(serving.rsrp);

      const m = L.circleMarker([pt.lat, pt.lng], {
        radius: 6, fillColor: markerColor,
        color: '#333', weight: 0.5, fillOpacity: 0.92,
      }).addTo(heatmapLayer);

      const result = {
        index: idx+1, lat: pt.lat, lng: pt.lng,
        distance      : serving.dist.toFixed(1),
        serving_site  : serving.siteId,
        serving_sector: serving.sectorNum,
        scenario_used : serving.scenario.toUpperCase(),
        condition_used: serving.condition.toUpperCase(),
        gainDb        : serving.gainDb.toFixed(1),
        pl            : serving.pl.toFixed(1),
        cl            : serving.cl.toFixed(1),
        sigma         : serving.sigma.toFixed(2),
        xi            : serving.xi.toFixed(2),
        n_dominant    : nDominant,
        rsrp_sim      : serving.rsrp.toFixed(1),
        sinr_sim      : sinr_sim.toFixed(1),
        rsrp_actual   : pt.rsrp,
        sinr_actual   : pt.sinr,
        cells         : cellsForUI,
        _serving      : serving,
      };

      m.on('click', () => onPointClick(result, idx+1));
      simResults.push(result);
    });

    siteLayer.remove();
    siteLayer.addTo(dtMap);

    // Default tampilkan RSRP setelah simulasi
    dtDisplayMode = 'rsrp';
    byId('sinrLegend').style.display = 'none';
    byId('pciLegend').style.display  = 'none';
    updateRSRPLegend();
    renderStats();

    // [v20.0] Enable tombol SINR & PCI setelah simulasi selesai
    enableBtn('btnExportCSV');
    enableBtn('btnSimSINR');
    enableBtn('btnSimPCI');

    const pairedR = simResults.filter(r => r.rsrp_actual != null);
    const pairedS = simResults.filter(r => r.sinr_actual != null);
    const servedByMain = simResults.filter(r => r._serving?.isMain).length;
    const pctMain = ((servedByMain / simResults.length)*100).toFixed(1);
    const avgDom  = simResults.length
      ? (simResults.reduce((s,r)=>s+r.n_dominant,0)/simResults.length).toFixed(1) : 0;

    let msg = `✅ Simulasi SS-RSRP selesai — ${simResults.length} titik\n`;
    msg    += `UE-centric | ${globalSectorList.length} sektor RF pool\n`;
    msg    += `Primary serving: ${pctMain}% | Neighbour: ${(100-parseFloat(pctMain)).toFixed(1)}%\n`;
    msg    += `Rata-rata dominant interferer: ${avgDom}\n\n`;
    if (pairedR.length) {
      const dR = pairedR.map(r => parseFloat(r.rsrp_sim) - r.rsrp_actual);
      msg += `SS-RSRP: ME=${mean(dR).toFixed(2)} | MAE=${maeF(dR).toFixed(2)} | RMSE=${rmseF(dR).toFixed(2)} dB\n`;
    }
    if (pairedS.length) {
      const dS = pairedS.map(r => parseFloat(r.sinr_sim) - r.sinr_actual);
      msg += `SS-SINR: ME=${mean(dS).toFixed(2)} | MAE=${maeF(dS).toFixed(2)} | RMSE=${rmseF(dS).toFixed(2)} dB\n`;
    }
    msg += `\nKlik "Simulasi SS-SINR" atau "Simulasi PCI" di toolbar untuk tampilan lainnya.`;
    alert(msg);
  }

  // [v20.0] Run SINR Only — switch tampilan ke SINR (kalkulasi sudah selesai di runSimulation)
  function runSINROnly() {
    if (!simResults.length) return alert('Jalankan Simulasi SS-RSRP terlebih dahulu!');
    dtDisplayMode = 'sinr';
    redrawSINRMode();
  }

  // [v20.0] Simulasi PCI — switch tampilan ke PCI mode
  function simulatePCI() {
    if (!simResults.length) return alert('Jalankan Simulasi SS-RSRP terlebih dahulu!');
    dtDisplayMode = 'pci';
    redrawPCIMode();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [v20.0] CLICK HANDLER — tambah kolom PCI, ARFCN, Cell ID
  // ══════════════════════════════════════════════════════════════════════════
  function onPointClick(result, ptIdx) {
    cellLineLayer.clearLayers();
    const drawnSites = new Set();
    result.cells.forEach((c, i) => {
      if (drawnSites.has(c.siteId)) return;
      drawnSites.add(c.siteId);
      const col = LINE_COLORS[Math.min(i, LINE_COLORS.length-1)];
      L.polyline([[result.lat, result.lng],[c.siteLat, c.siteLng]], {
        color: col, weight: i===0?3.5:2, opacity:0.9,
        dashArray: i===0?null:'7 4',
      }).addTo(cellLineLayer)
        .bindTooltip(
          `<b>${i===0?'Serving':'Detected'}: ${c.siteId}</b><br>` +
          `PCI: ${c.pci??'N/A'} | SS-RSRP: ${c.rsrp.toFixed(1)} dBm | SS-SINR: ${c.sinr_est!=null?c.sinr_est.toFixed(1):'—'} dB`,
          {sticky:true}
        );
    });

    const wrapper = byId('dtCellTableWrapper');
    const title   = byId('dtCellPanelTitle');
    if (!wrapper) return;

    if (title) {
      const rsrpAkt = result.rsrp_actual != null
        ? `&nbsp;|&nbsp;Aktual:<b>${result.rsrp_actual} dBm</b>` : '';
      const sinrAkt = result.sinr_actual != null
        ? `&nbsp;|&nbsp;Aktual:<b>${result.sinr_actual} dB</b>` : '';
      title.innerHTML =
        `📡 Detail Titik <b>${ptIdx}</b>` +
        `<span style="font-weight:400;font-size:10px;opacity:0.75;margin-left:6px;">` +
        `(${result.lat.toFixed(5)}, ${result.lng.toFixed(5)})</span><br>` +
        `<span style="font-size:10px;opacity:0.85;">` +
        `SS-RSRP sim:<b>${result.rsrp_sim} dBm</b>${rsrpAkt}` +
        `&nbsp;&nbsp;SS-SINR sim:<b>${result.sinr_sim} dB</b>${sinrAkt}` +
        `&nbsp;&nbsp;<span style="opacity:0.6;font-size:9px;">(${result.n_dominant} dominant interferer)</span>` +
        `</span>`;
    }

    // [v20.0] Tabel: Type | PCI | ARFCN | SS-RSRP | SS-SINR | Cell ID | Cell Name | Distance
    let rows = '';
    result.cells.forEach((c, i) => {
      const lc = LINE_COLORS[Math.min(i, LINE_COLORS.length-1)];
      const typeLabel = i === 0
        ? `<span class="cell-type serving" style="border-left-color:${lc}">Serving</span>`
        : `<span class="cell-type detected" style="border-left-color:${lc}">Detected</span>`;
      const cName   = c.cellName || `${c.siteId}_Sek${c.sectorNum}`;
      const sinrVal = c.sinr_est != null ? c.sinr_est.toFixed(2) : '—';
      const pciStr  = c.pci != null ? c.pci : '—';
      const arfcn   = c.arfcn || 466850;
      const cellId  = c.cellId != null ? c.cellId : '—';
      rows += `<tr class="${i===0?'row-serving':'row-detected'}">
        <td>${typeLabel}</td>
        <td>
          <span style="display:inline-block;width:9px;height:9px;border-radius:50%;
            background:${c.pciColor||'#aaa'};margin-right:3px;vertical-align:middle;
            border:1px solid rgba(0,0,0,0.2)"></span>${pciStr}
        </td>
        <td>${arfcn}</td>
        <td>
          <span class="dot" style="background:${dotColorRsrp(c.rsrp)}"></span>
          ${c.rsrp.toFixed(2)}
        </td>
        <td>
          <span class="dot" style="background:${dotColorSinr(c.sinr_est)}"></span>
          ${sinrVal}
        </td>
        <td>${cellId}</td>
        <td title="${cName}">${cName.length>28?cName.slice(0,28)+'…':cName}</td>
        <td>${c.dist.toFixed(0)}</td>
      </tr>`;
    });

    wrapper.innerHTML = `
      <table class="cell-table">
        <thead><tr>
          <th>Type</th><th>PCI</th><th>ARFCN</th>
          <th>SS-RSRP(dBm)</th><th>SS-SINR(dB)</th>
          <th>Cell ID</th><th>Cell Name</th><th>Distance(m)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function dotColorRsrp(v) {
    if (v == null) return '#aaa';
    if (v >= -85)  return '#0042a5';
    if (v >= -95)  return '#00a955';
    if (v >= -105) return '#70ff66';
    if (v >= -120) return '#fffb00';
    return '#ff3333';
  }
  function dotColorSinr(v) {
    if (v == null) return '#aaa';
    if (v >= 20)  return '#0042a5';
    if (v >= 10)  return '#00a955';
    if (v >= 0)   return '#70ff66';
    if (v >= -5)  return '#fffb00';
    return '#ff3333';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER STATS — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function renderStats() {
    const box = byId('resultBox'); if (!box) return;
    const pairedR = simResults.filter(r => r.rsrp_actual != null);
    const pairedS = simResults.filter(r => r.sinr_actual != null);
    const site    = siteIndex[primarySite?.id];
    const sc      = propagasiOverride.scenario  || (site?.scenario  || 'uma').toLowerCase();
    const cnd     = propagasiOverride.condition || (site?.condition || 'nlos').toLowerCase();
    const sigma   = SHADOW_STD_3GPP[`${sc}_${cnd}`] || 6.0;
    const servedByMain = simResults.filter(r => r._serving?.isMain).length;
    const pctMain = simResults.length ? ((servedByMain/simResults.length)*100).toFixed(1) : '0';
    const avgDom  = simResults.length
      ? (simResults.reduce((s,r)=>s+r.n_dominant,0)/simResults.length).toFixed(1) : 0;

    const metricBlock = (pairs, key, actKey, unit) => {
      if (!pairs.length)
        return `<div style="opacity:0.45;font-size:11px;padding:4px 0;">Tidak ada data aktual</div>`;
      const diffs = pairs.map(r => parseFloat(r[key]) - r[actKey]);
      const me=mean(diffs), sd=sdF(diffs), rmse=rmseF(diffs);
      const meSign = me>0?'+':'';
      return `
        <div class="stat-grid" style="margin-bottom:4px;">
          <div class="stat-cell ${Math.abs(me)<=5?'stat-ok':'stat-warn'}">
            <span class="stat-lbl">ME</span>
            <span class="stat-val">${meSign}${me.toFixed(2)} ${unit}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-lbl">SD</span>
            <span class="stat-val">${sd.toFixed(2)} ${unit}</span>
          </div>
          <div class="stat-cell ${rmse<=8?'':'stat-warn'}">
            <span class="stat-lbl">RMSE</span>
            <span class="stat-val">${rmse.toFixed(2)} ${unit}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-lbl">N</span>
            <span class="stat-val">${pairs.length}</span>
          </div>
        </div>`;
    };

    box.innerHTML = `
      <h3>📊 Simulasi Berbasis Data Aktual</h3>
      <p class="result-meta">
        ${simResults.length} titik &nbsp;|&nbsp;
        ${globalSectorList.length} sektor RF pool &nbsp;|&nbsp;
        Seed:${FIXED_SEED}
      </p>
      <div style="background:rgba(0,201,136,0.1);border:1px solid rgba(0,201,136,0.3);
        border-radius:6px;padding:5px 9px;font-size:10px;margin-bottom:6px;color:#ffffff;">
        Primary: <b>${pctMain}%</b> &nbsp;|&nbsp;
        Neighbour: <b>${(100-parseFloat(pctMain)).toFixed(1)}%</b> &nbsp;|&nbsp;
        Avg interferer: <b>${avgDom}</b>
      </div>
      <div class="stat-section-title">Hasil SS-RSRP</div>
      ${metricBlock(pairedR,'rsrp_sim','rsrp_actual','dBm')}
      <div class="stat-section-title" style="margin-top:8px;">Hasil SS-SINR</div>
      ${metricBlock(pairedS,'sinr_sim','sinr_actual','dB')}
      <div class="result-footer" style="margin-top:8px;">Klik marker untuk detail per titik</div>`;
    box.style.display = 'block';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEBUG — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function showDebug() {
    if (!primarySite) { alert('Belum ada primary site.'); return; }
    const site    = siteIndex[primarySite.id];
    const sc      = propagasiOverride.scenario  || (site?.scenario  || 'uma').toLowerCase();
    const cnd     = propagasiOverride.condition || (site?.condition || 'nlos').toLowerCase();
    const sigma   = SHADOW_STD_3GPP[`${sc}_${cnd}`] || 6.0;
    const servedByMain = simResults.filter(r => r._serving?.isMain).length;
    const avgDom  = simResults.length
      ? (simResults.reduce((s,r)=>s+r.n_dominant,0)/simResults.length).toFixed(1) : 0;
    alert([
      `=== DT Simulation v20.0 — UE-Centric + Dominant Interferer ===`,
      ``,
      `=== Arsitektur ===`,
      `  Model: UE-centric multi-cell [TR 38.901 §7.6]`,
      `  globalSectorList: ${globalSectorList.length} sektor`,
      `  Sites: ${1+neighbourPool.length} (1 primary + ${neighbourPool.length} neighbour)`,
      `  servingCell = argmax(RSRP) — kompetisi global`,
      ``,
      `=== SINR [TR 36.942 §A.1] ===`,
      `  Threshold: serving_RSRP - ${DOMINANT_INTERFERER_THRESHOLD_DB} dB`,
      `  Rata-rata dominant interferer: ${avgDom}`,
      `  N = ${THERMAL_NOISE_DBM.toFixed(1)} dBm | IM = ${INTERFERENCE_MARGIN_DB} dB`,
      ``,
      `=== Shadow Fading ===`,
      `  σ_SF = ${sigma} dB [TR 38.901 Table 7.4.4-1]`,
      `  Shared spatial field (seed = ${FIXED_SEED})`,
      `  Clamp: ±${(2*sigma).toFixed(1)} dB [ITU-R M.2135 §A.1]`,
      ``,
      `=== Hasil ===`,
      `  Total: ${simResults.length} | Primary: ${servedByMain} | Neighbour: ${simResults.length-servedByMain}`,
    ].join('\n'));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CSV UPLOAD — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function handleCsvUpload(e) {
    const file = e.target.files[0]; if (!file) return;
    setStatus('csvStatus', '⏳ Membaca CSV...', 'info');
    if (typeof Papa !== 'undefined') {
      Papa.parse(file, {
        header:true, dynamicTyping:false, skipEmptyLines:true,
        complete: r => processCsvData(r.data, r.meta.fields),
        error: () => setStatus('csvStatus','❌ Gagal membaca file','error'),
      });
    } else {
      const reader = new FileReader();
      reader.onload = ev => {
        const lines  = ev.target.result.split('\n').filter(l=>l.trim());
        const delim  = lines[0].includes('\t')?'\t':',';
        const fields = lines[0].split(delim).map(h=>h.trim().replace(/"/g,''));
        const rows   = lines.slice(1).map(line => {
          const vals=line.split(delim).map(v=>v.trim().replace(/"/g,''));
          const obj={}; fields.forEach((h,i)=>obj[h]=vals[i]??''); return obj;
        });
        processCsvData(rows, fields);
      };
      reader.readAsText(file);
    }
  }

  function detectCols(headers) {
    const find = cands => {
      for (const h of headers) {
        const hl = h.toLowerCase().replace(/[\s()]/g,'');
        if (cands.some(c=>hl===c||hl.startsWith(c))) return h;
      }
      return null;
    };
    return {
      lat : find(['latitude','lat','lintang','y']),
      lng : find(['longitude','lon','lng','long','bujur','x']),
      rsrp: find(['rsrpdbm','rsrp','ltersrp','nrrsrp','signal']),
      sinr: find(['sinrdb','sinr','ltsinr','nrsinr','snr']),
    };
  }

  const parseNum = v => {
    if (v===null||v===undefined||v==='') return null;
    const n=parseFloat(v); return isNaN(n)?null:n;
  };

  function processCsvData(rows, headers) {
    const cols = detectCols(headers || Object.keys(rows[0]||{}));
    if (!cols.lat||!cols.lng) {
      setStatus('csvStatus','❌ Kolom Lat/Lng tidak ditemukan.','error'); return;
    }
    const raw = rows.map(r=>({
      lat : parseNum(r[cols.lat]),
      lng : parseNum(r[cols.lng]),
      rsrp: cols.rsrp?parseNum(r[cols.rsrp]):null,
      sinr: cols.sinr?parseNum(r[cols.sinr]):null,
    })).filter(p=>
      p.lat!==null&&p.lng!==null&&!isNaN(p.lat)&&!isNaN(p.lng)&&
      p.lat!==0&&p.lng!==0&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180
    );

    const noGlitch = [];
    raw.forEach((pt, i) => {
      if (i === 0) { noGlitch.push({ ...pt, isGap: false }); return; }
      const dist = haversine(noGlitch.at(-1).lat, noGlitch.at(-1).lng, pt.lat, pt.lng);
      noGlitch.push({ ...pt, isGap: dist > 500, distFromPrev: dist });
    });

    dtPoints  = noGlitch;
    simPoints = dtPoints.filter(p=>p.rsrp!==null);
    if (dtPoints.length<3){setStatus('csvStatus','❌ Terlalu sedikit titik.','error');return;}

    dtPointLayer.clearLayers(); heatmapLayer.clearLayers();
    cellLineLayer.clearLayers(); simResults=[];

    L.polyline(dtPoints.map(p=>[p.lat,p.lng]),{
      color:'#aaa',weight:2,opacity:0.4,dashArray:'4 4'
    }).addTo(dtPointLayer);

    dtPoints.forEach(p=>{
      L.circleMarker([p.lat,p.lng],{
        radius:3, fillColor:p.rsrp!==null?'#00cc88':'#aaaaaa',
        color:'none', fillOpacity:0.6,
      }).addTo(dtPointLayer)
        .bindPopup(`SS-RSRP:${p.rsrp??'—'}${p.sinr!=null?` | SS-SINR:${p.sinr}`:''}`);
    });

    const guide=byId('mapGuide');
    if(guide) guide.style.display='none';

    let totalDist=0;
    for(let i=1;i<dtPoints.length;i++)
      totalDist+=haversine(dtPoints[i-1].lat,dtPoints[i-1].lng,dtPoints[i].lat,dtPoints[i].lng);

    setStatus('csvStatus',
      `✅ ${dtPoints.length} titik | ${simPoints.length} punya RSRP aktual | ~${(totalDist/1000).toFixed(2)} km`,
      'ok'
    );
    if(byId('btnExportDtClean')) byId('btnExportDtClean').disabled=false;

    setText('infoRawPoints', dtPoints.length);
    setText('infoSimPoints', simPoints.length);
    setText('infoNoRsrp',    dtPoints.length-simPoints.length);
    setText('infoFiltered',  rows.length-dtPoints.length);
    setText('infoRouteDist', `${(totalDist/1000).toFixed(2)} km`);
    setText('infoHasRSRP',   simPoints.length>0?`✓ ${simPoints.length}`:'✗');
    const nSinr=dtPoints.filter(p=>p.sinr!==null).length;
    setText('infoHasSINR',   nSinr>0?`✓ ${nSinr}`:'✗');

    if(Object.keys(siteIndex).length) autoDetectPrimarySite();
    else setStatus('siteMatchStatus','⚠️ Menunggu data site...','warn');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [v20.0] EXPORT CSV — tambah kolom PCI, ARFCN, Cell_ID, Cell_Name
  // ══════════════════════════════════════════════════════════════════════════
  function exportCSV() {
    if(!simResults.length) return alert('Jalankan simulasi terlebih dahulu!');
    const hasActR=simResults.some(r=>r.rsrp_actual!=null);
    const hasActS=simResults.some(r=>r.sinr_actual!=null);

    let csv='No,Latitude,Longitude,Serving_Site,Serving_Sector,PCI,ARFCN,Cell_ID,Cell_Name,';
    csv+='Distance_to_Serving(m),Scenario,Condition,N_Dominant_Interferer,';
    csv+='Antenna_Gain(dB),Path_Loss(dB),Clutter_Loss(dB),Sigma_SF(dB),Shadow_xi(dB),';
    csv+='RSRP_Sim(dBm),SINR_Sim(dB)';
    if(hasActR) csv+=',RSRP_Aktual(dBm),Delta_RSRP(dB)';
    if(hasActS) csv+=',SINR_Aktual(dB),Delta_SINR(dB)';
    csv+='\n';

    simResults.forEach(r=>{
      const sv     = r._serving;
      const pci    = sv?.pci    != null ? sv.pci    : '';
      const arfcn  = sv?.arfcn  != null ? sv.arfcn  : 466850;
      const cellId = sv?.cellId != null ? sv.cellId : '';
      const cName  = (sv?.cellName || `${r.serving_site}_Sek${r.serving_sector}`).replace(/"/g,"'");
      csv+=`${r.index},${r.lat},${r.lng},${r.serving_site},${r.serving_sector},`;
      csv+=`${pci},${arfcn},${cellId},"${cName}",`;
      csv+=`${r.distance},${r.scenario_used},${r.condition_used},${r.n_dominant},`;
      csv+=`${r.gainDb},${r.pl},${r.cl},${r.sigma},${r.xi},`;
      csv+=`${r.rsrp_sim},${r.sinr_sim}`;
      if(hasActR){
        const d=r.rsrp_actual!=null?(parseFloat(r.rsrp_sim)-r.rsrp_actual).toFixed(2):'';
        csv+=`,${r.rsrp_actual??''},${d}`;
      }
      if(hasActS){
        const d=r.sinr_actual!=null?(parseFloat(r.sinr_sim)-r.sinr_actual).toFixed(2):'';
        csv+=`,${r.sinr_actual??''},${d}`;
      }
      csv+='\n';
    });

    const blob=new Blob([csv],{type:'text/csv'});
    const ts=new Date().toISOString().slice(0,19).replace(/:/g,'-');
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`Simulasi DT by Data Aktual_${primarySite?.id||'site'}_${ts}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(a.href);
  }

  function exportDtClean() {
    if(!dtPoints?.length){alert('Tidak ada data.');return;}
    const rows=dtPoints.map((p,i)=>({No:i+1,Latitude:p.lat,Longitude:p.lng,RSRP:p.rsrp??'',SINR:p.sinr??''}));
    const csv=typeof Papa!=='undefined'
      ?Papa.unparse(rows)
      :'No,Latitude,Longitude,RSRP,SINR\n'+rows.map(r=>`${r.No},${r.Latitude},${r.Longitude},${r.RSRP},${r.SINR}`).join('\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const ts=new Date().toISOString().replace(/[:.]/g,'-');
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`DT_CLEAN_${ts}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(a.href);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SITE RENDERING — tidak diubah
  // ══════════════════════════════════════════════════════════════════════════
  function renderAllSites() {
    siteLayer.clearLayers();
    Object.entries(siteIndex).forEach(([id,s])=>{
      L.circleMarker([s.lat,s.lng],{
        radius:4,fillColor:'#aab8d8',color:'#556',weight:1,fillOpacity:1.0,
      }).addTo(siteLayer).bindPopup(`<b>${id}</b><br>H:${s.height}m|${s.clutter||'N/A'}`);
    });
  }

  function highlightPrimarySiteOnMap(primaryId) {
    siteLayer.clearLayers();
    const siteMap = {};
    globalSectorList.forEach(sec => {
      if (!siteMap[sec.siteId]) {
        siteMap[sec.siteId] = {
          siteId: sec.siteId, lat: sec.siteLat, lng: sec.siteLng,
          isMain: sec.isMain, sectors: [],
        };
      }
      siteMap[sec.siteId].sectors.push(sec);
    });

    Object.entries(siteIndex).forEach(([id, s]) => {
      const isPrimary   = id === primaryId;
      const isNeighbour = neighbourPool.some(nb => nb.id === id);
      L.circleMarker([s.lat, s.lng], {
        radius     : isPrimary ? 13 : isNeighbour ? 8 : 4,
        fillColor  : isPrimary ? '#ffd000' : isNeighbour ? '#ff8c00' : '#aab8d8',
        color      : isPrimary ? '#000' : '#444',
        weight     : isPrimary ? 3 : isNeighbour ? 2 : 1,
        fillOpacity: 1,
      }).addTo(siteLayer)
        .bindPopup(`${isPrimary?'⭐ ':isNeighbour?'📡 ':''}<b>${id}</b><br>H:${s.height}m|${s.clutter||'N/A'}`);
      if (isPrimary || isNeighbour) {
        L.marker([s.lat, s.lng], {
          icon: L.divIcon({
            className: '',
            html: `<div style="background:${isPrimary?'rgba(255,208,0,0.92)':'rgba(255,140,0,0.85)'};color:#111;font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;white-space:nowrap;margin-top:-20px;margin-left:14px;border:1px solid rgba(0,0,0,0.25);">${id}</div>`,
            iconAnchor: [0, 0],
          }),
          interactive: false, zIndexOffset: 200,
        }).addTo(siteLayer);
      }
    });

    Object.values(siteMap).forEach(site => {
      site.sectors.forEach((sec, i) => {
        drawSectorFan(
          site.lat, site.lng, sec.azimuth, 65,
          site.isMain ? 100 : 100, i,
          site.isMain ? 0.18 : 0.20,
          sec.pciColor
        );
      });
    });
  }

  function drawSectorFan(lat,lng,az,bw,radius,idx,fillOpacity,color) {
    const pts=[[lat,lng]];
    for(let i=0;i<=16;i++){
      const p=destPoint(lat,lng,(az-bw/2)+(i/16)*bw,radius); pts.push([p.lat,p.lng]);
    }
    pts.push([lat,lng]);
    const c=color||SECTOR_COLORS[idx%SECTOR_COLORS.length];
    L.polygon(pts,{color:c,fillColor:c,fillOpacity,weight:2,opacity:0.7})
      .addTo(siteLayer).bindPopup(`<b>Sek${idx+1}</b>|Az:${az}°`);
  }

  // ── Geo utils — tidak diubah ──────────────────────────────────────────────
  function haversine(la1,lo1,la2,lo2){
    const R=6378137,dLa=(la2-la1)*Math.PI/180,dLo=(lo2-lo1)*Math.PI/180;
    const a=Math.sin(dLa/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  function calcBearing(la1,lo1,la2,lo2){
    const p1=la1*Math.PI/180,p2=la2*Math.PI/180,dl=(lo2-lo1)*Math.PI/180;
    return(Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360;
  }
  function destPoint(lat,lng,az,dist){
    const R=6378137,b=az*Math.PI/180,d=dist/R;
    const la1=lat*Math.PI/180,lo1=lng*Math.PI/180;
    const la2=Math.asin(Math.sin(la1)*Math.cos(d)+Math.cos(la1)*Math.sin(d)*Math.cos(b));
    const lo2=lo1+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la1),Math.cos(d)-Math.sin(la1)*Math.sin(la2));
    return{lat:la2*180/Math.PI,lng:lo2*180/Math.PI};
  }
  function normalizeSectors(site){
    if(!Array.isArray(site.sectors)||!site.sectors.length) return [];
    return site.sectors.map(s=>{
      if(typeof s==='object'&&s!==null) return parseFloat(s.azimuth??s.az??0);
      const n=parseFloat(s); return isNaN(n)?0:n;
    });
  }
  function rsrpColor(v){
    if(v>=-85)  return '#0042a5';
    if(v>=-95)  return '#00a955';
    if(v>=-105) return '#70ff66';
    if(v>=-120) return '#fffb00';
    if(v>=-125) return '#ff3333';
    return '#800000';
  }
  function sinrColor(v){
    if(v>=20) return '#0042a5';
    if(v>=10) return '#00a955';
    if(v>=0)  return '#70ff66';
    if(v>=-5) return '#fffb00';
    return '#ff3333';
  }

  function byId(id){return document.getElementById(id);}
  function setText(id,v){const e=byId(id);if(e)e.textContent=v;}
  function enableBtn(id){const e=byId(id);if(e)e.disabled=false;}
  function setStatus(id,msg,type){
    const e=byId(id);if(!e)return;
    e.innerHTML=msg; e.className=`status-msg status-${type}`;
  }

})();

console.log('dtsimulation.js v20.1 — PCI Mode + SD metric + Export CSV di bawah | Kalkulasi identik v19.x');