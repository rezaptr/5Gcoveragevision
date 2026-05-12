// ================= SIMULATION ROUTE v4.0 — AKADEMIK EDITION =================
//
// PERUBAHAN DARI Rev 3.2 → v4.0 (justifikasi akademik):
//
//   [HAPUS] SINR_P_GOOD, SINR_GOOD_STD, SINR_BAD_STD, SINR_SLOPE, SINR_RSRP_REF
//      Alasan: parameter ad-hoc tanpa referensi standar.
//      Pengganti: SINR = S/(I+N) berbasis TR 36.942 §A.1
//                 S  = daya signal serving (linear)
//                 I  = jumlah daya interferer dari semua site lain
//                 N  = thermal noise = -174 + 10·log10(BW_Hz) + NF [dBm]
//
//   [HAPUS] CLUTTER_LOSS map dengan string matching ad-hoc
//      Pengganti: CLUTTER_LOSS_DB per kategori konstan
//                 Referensi: ITU-R P.1411, COST 231
//
//   [HAPUS] near-field correction implisit
//      Pengganti: d_min = 10 m sesuai TR 38.901 §7.4.1
//
//   [HAPUS] tailCompression / RSRP floor ad-hoc
//      Pengganti: receiver sensitivity floor = -125.2 dBm [TS 38.101-1]
//
//   [TETAP] Path loss 3GPP TR 38.901 (UMa/UMi/RMa) — referensi utama
//   [TETAP] Antenna gain 3GPP TR 36.942 horizontal pattern
//   [TETAP] Shadow fading log-normal, σ dari TR 38.901 Table 7.4.4
//   [TETAP] Azimuth-based sector assignment
//   [TETAP] PCI dari shapefile sectorData
//   [TETAP] Sampling interval 10 m sepanjang rute
//
// REFERENSI UTAMA:
//   - 3GPP TR 38.901 v17: Channel model 0.5-100 GHz
//   - 3GPP TR 36.942: Radio frequency system scenarios
//   - 3GPP TS 38.101-1: NR UE radio transmission and reception
//   - ITU-R P.1411: Propagation data for short-range outdoor systems
//   - COST 231 Final Report
// =============================================================================
(function () {
  'use strict';

  const mapElement = document.getElementById('map-simulation');
  if (!mapElement) return;

  let simMap;
  let simSiteLayer, simRouteLayer, simSamplingLayer, simHeatmapLayer, cellLineLayer;
  let driveTestData  = null;
  let samplingPoints = [];
  let rsrpResults    = [];
  let allSectors     = [];
  let displayMode    = 'rsrp';

  const MAIN_SECTOR_COLORS = [
    '#e6194b',  // Sektor 1 — merah
    '#3cb44b',  // Sektor 2 — hijau muda
    '#4363d8',  // Sektor 3 — biru
    '#f58231',  // Sektor 4 — oranye
    '#911eb4',  // Sektor 5 — ungu
    '#42d4f4',  // Sektor 6 — cyan
  ];
  const NEIGHBOUR_PALETTE = [
    '#f032e6','#bfef45','#469990','#dcbeff',
    '#9a6324','#800000','#aaffc3','#808000',
    '#ffd8b1','#fffac8','#000075','#a9a9a9',
  ];
  const LINE_COLORS = ['#00c050','#1a6fff','#ff8800','#ffd000','#ff3333','#888888'];

  // ══════════════════════════════════════════════════════════════════════════
  // KONSTANTA — AKADEMIK
  // ══════════════════════════════════════════════════════════════════════════
  const CAL = {
    TX_POWER  : 46,     // dBm — EIRP downlink
    FREQUENCY : 2300,   // MHz — Band n40
    BANDWIDTH : 30e6,   // Hz  — bandwidth kanal (30 MHz)
    MOBILE_H  : 1.5,    // m   — tinggi UE [TR 38.901]
    ANTENNA_Am: 25,     // dB  — max atenuasi [TR 36.942]
    BEAMWIDTH : 65,     // deg — HPBW horizontal [TR 36.942]
    NF        : 7,      // dB  — noise figure UE, tipikal
    HO_MARGIN : 3,      // dB  — handover margin [TR 36.942]
  };

  /**
   * Receiver sensitivity floor — 3GPP TS 38.101-1 Table 7.3.2
   * NR FR1, BW 30 MHz, μ=1: ≈ -125.2 dBm
   */
  const RX_SENSITIVITY_FLOOR = -125.2;

  /**
   * Thermal noise floor [dBm]
   * N = -174 dBm/Hz + 10·log10(BW_Hz) + NF [dB]
   * Referensi: 3GPP TR 36.942 §A.1
   */
  const THERMAL_NOISE_DBM = -174 + 10 * Math.log10(CAL.BANDWIDTH) + CAL.NF;

  /**
   * Clutter loss KONSTAN per kategori.
   * Referensi: ITU-R P.1411-10, COST 231, 3GPP TR 36.942 Table A.2.1.1.2-3
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
   * Shadow fading σ per skenario dan kondisi.
   * Referensi: 3GPP TR 38.901 Table 7.4.4-1
   */
  const SHADOW_STD = {
    uma_los  : 4.0,
    uma_nlos : 6.0,
    umi_los  : 4.0,
    umi_nlos : 7.82,
    rma_los  : 4.0,
    rma_nlos : 8.0,
  };

  // ── RNG deterministik ─────────────────────────────────────────────────────
  let _rng = 0;
  function seedRng(s) { _rng = s >>> 0; }
  function rng() {
    _rng += 0x6D2B79F5; let t = _rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function gaussianRandom(m, s) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  let activeSeed = 0;

  // ══════════════════════════════════════════════════════════════════════════
  // CLUTTER LOSS — Konstan per environment [ITU-R P.1411 / COST 231]
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
  // PATH LOSS — 3GPP TR 38.901
  // ══════════════════════════════════════════════════════════════════════════
  /**
   * @param {string} scenario  - 'uma' | 'umi' | 'rma'
   * @param {string} condition - 'los' | 'nlos' | 'los_nlos'
   * @param {number} d2D_m     - jarak 2D [m], min 10 m (TR 38.901 §7.4.1)
   * @param {number} freq_mhz  - frekuensi [MHz]
   * @param {number} hBS       - tinggi BS [m]
   * @param {number} hUT       - tinggi UE [m]
   * @returns {number}         - path loss [dB]
   */
  function pathLoss(scenario, condition, d2D_m, freq_mhz, hBS, hUT) {
    const d   = Math.max(d2D_m, 10); // TR 38.901 §7.4.1: d ≥ 10 m
    const hU  = hUT || 1.5;
    const fc  = freq_mhz / 1000; // GHz
    const c   = 3e8;
    const d3D = Math.sqrt(d * d + (hBS - hU) ** 2);

    // Probabilitas LOS — TR 38.901 Table 7.4.2-1
    const pLOS_UMa = d2 => {
      if (d2 <= 18) return 1.0;
      const C = hU <= 13 ? 0 : Math.pow((hU - 13) / 10, 1.5);
      return (18 / d2 + Math.exp(-d2 / 63) * (1 - 18 / d2)) *
             (1 + C * (5 / 4) * Math.pow(d2 / 100, 3) * Math.exp(-d2 / 150));
    };
    const pLOS_UMi = d2 =>
      d2 <= 18 ? 1.0 : 18 / d2 + Math.exp(-d2 / 36) * (1 - 18 / d2);

    switch (scenario) {
      case 'uma': {
        // TR 38.901 Table 7.4.1-1: UMa
        const hE  = 1.0;
        const dBP = 4 * (hBS - hE) * (hU - hE) * (freq_mhz * 1e6) / c;
        const pl_los = d <= dBP
          ? 28 + 22 * Math.log10(d3D) + 20 * Math.log10(fc)
          : 28 + 40 * Math.log10(d3D) + 20 * Math.log10(fc)
            - 9 * Math.log10(dBP ** 2 + (hBS - hU) ** 2);
        if (condition === 'los') return pl_los;
        const pl_nlos = Math.max(
          13.54 + 39.08 * Math.log10(d3D) + 20 * Math.log10(fc) - 0.6 * (hU - 1.5),
          pl_los
        );
        if (condition === 'nlos') return pl_nlos;
        const p = pLOS_UMa(d);
        return p * pl_los + (1 - p) * pl_nlos;
      }
      case 'umi': {
        // TR 38.901 Table 7.4.1-1: UMi Street Canyon
        const hE  = 1.0;
        const dBP = 4 * (hBS - hE) * (hU - hE) * (freq_mhz * 1e6) / c;
        const pl_los = d <= dBP
          ? 32.4 + 21 * Math.log10(d3D) + 20 * Math.log10(fc)
          : 32.4 + 40 * Math.log10(d3D) + 20 * Math.log10(fc)
            - 9.5 * Math.log10(dBP ** 2 + (hBS - hU) ** 2);
        if (condition === 'los') return pl_los;
        const pl_nlos = Math.max(
          22.4 + 35.3 * Math.log10(d3D) + 21.3 * Math.log10(fc) - 0.3 * (hU - 1.5),
          pl_los
        );
        if (condition === 'nlos') return pl_nlos;
        const p = pLOS_UMi(d);
        return p * pl_los + (1 - p) * pl_nlos;
      }
      case 'rma': {
        // TR 38.901 Table 7.4.1-1: RMa
        const h  = 5, W = 20;
        const dBP = 2 * Math.PI * hBS * hU * (freq_mhz * 1e6) / c;
        const A1  = Math.min(0.03 * Math.pow(h, 1.72), 10);
        const A2  = Math.min(0.044 * Math.pow(h, 1.72), 14.77);
        const A3  = 0.002 * Math.log10(h);
        let pl_los;
        if (d <= dBP) {
          pl_los = 20 * Math.log10(40 * Math.PI * d3D * fc / 3)
                 + A1 * Math.log10(d3D) - A2 + A3 * d3D;
        } else {
          const d3D_BP = Math.sqrt(dBP ** 2 + (hBS - hU) ** 2);
          pl_los = 20 * Math.log10(40 * Math.PI * d3D_BP * fc / 3)
                 + A1 * Math.log10(d3D_BP) - A2 + A3 * d3D_BP
                 + 40 * Math.log10(d3D / d3D_BP);
        }
        if (condition === 'los') return pl_los;
        return Math.max(
          161.04 - 7.1 * Math.log10(W) + 7.5 * Math.log10(h)
          - (24.37 - 3.7 * (h / hBS) ** 2) * Math.log10(hBS)
          + (43.42 - 3.1 * Math.log10(hBS)) * (Math.log10(d3D) - 3)
          + 20 * Math.log10(fc) - (3.2 * (Math.log10(11.75 * hU)) ** 2 - 4.97),
          pl_los
        );
      }
      default:
        return 28 + 22 * Math.log10(d3D) + 20 * Math.log10(fc);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ANTENNA GAIN — 3GPP TR 36.942
  // G_h(θ) = −min(12·(θ/θ_3dB)², A_m)
  // ══════════════════════════════════════════════════════════════════════════
  function antennaGainFromOffset(angularOffset_deg) {
    const ratio = angularOffset_deg / (CAL.BEAMWIDTH / 2);
    return -Math.min(12 * ratio * ratio, CAL.ANTENNA_Am);
  }

  function pickBestSectorForPoint(brng, sectorList) {
    if (!sectorList?.length) return { bestSec: null, bestGain: 0 };
    let bestGain = -Infinity, bestSec = null;
    sectorList.forEach(sec => {
      const offset = Math.abs(((brng - sec.azimuth + 540) % 360) - 180);
      const g      = antennaGainFromOffset(offset);
      if (g > bestGain) { bestGain = g; bestSec = sec; }
    });
    return { bestSec, bestGain };
  }

  /**
   * Terapkan receiver sensitivity floor.
   * Referensi: 3GPP TS 38.101-1 Table 7.3.2
   */
  function applyRxFloor(rsrp) {
    return Math.max(RX_SENSITIVITY_FLOOR, rsrp);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HITUNG SS-RSRP (AKADEMIK)
  //
  // RSRP = P_TX + G_h(θ) − PL(d, f, h) − L_clutter + ξ   [dBm]
  //
  //   P_TX      : 46 dBm
  //   G_h(θ)    : antenna gain horizontal [TR 36.942]
  //   PL        : path loss [TR 38.901]
  //   L_clutter : clutter loss konstan [ITU-R P.1411]
  //   ξ         : shadow fading ~ N(0, σ²) [TR 38.901 Table 7.4.4]
  // ══════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════
  // HITUNG SS-SINR (AKADEMIK)
  //
  // SINR = S / (I + N)   [linear]   → dB: SINR_dB = 10·log10(S/(I+N))
  //
  //   S  = daya serving [mW, linear dari dBm]
  //   I  = jumlah daya semua interferer [mW]
  //   N  = thermal noise = 10^((−174 + 10·log10(BW) + NF)/10) [mW]
  //
  // Referensi: 3GPP TR 36.942 §A.1
  // ══════════════════════════════════════════════════════════════════════════
  function dbmToLinear(dbm)   { return Math.pow(10, dbm / 10); }
  function linearToDbm(mw)    { return 10 * Math.log10(Math.max(mw, 1e-15)); }

  function estimateRSRQ(rsrp, sinr) {
    // RSRQ = RSRP / RSSI (dalam dB)
    // RSSI ≈ N_RB * (RSRP + interferensi)
    // Pendekatan: RSRQ ≈ RSRP − (RSRP + thermal_noise) + 10·log10(N_RB_ref)
    const N_RB = 66; // RB untuk BW 30 MHz, μ=1
    const th   = THERMAL_NOISE_DBM;
    const intf = th - sinr;
    const rssi = 10 * Math.log10(dbmToLinear(rsrp) + dbmToLinear(intf));
    return Math.max(-19.5, Math.min(-3, rsrp - rssi + 10 * Math.log10(N_RB)));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('map-simulation')) return;
    loadDriveTestData();
    initCellPanelPills();
    initSimulationMap();
    setupEventListeners();
  });

  function loadDriveTestData() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';
    try {
      const raw = sessionStorage.getItem('driveTestData');
      if (!raw)                          throw new Error('Tidak ada data rute.');
      driveTestData = JSON.parse(raw);
      if (!driveTestData.siteId)         throw new Error('siteId tidak ditemukan');
      if (!driveTestData.site?.lat)      throw new Error('Koordinat site tidak lengkap');
      if (!driveTestData.mainRoute?.coords?.length) throw new Error('Rute utama tidak ditemukan');

      buildAllSectors();
      populateSiteInfo();
      populateRouteData();
      setTimeout(() => { if (overlay) overlay.style.display = 'none'; }, 800);
    } catch (e) {
      console.error('Error loading data:', e);
      if (overlay) overlay.innerHTML =
        `<div><div class="spinner"></div><h2 style="color:#e74c3c;">Error</h2><p>${e.message}</p></div>`;
      setTimeout(() => { window.location.href = '/route'; }, 3000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BUILD ALL SECTORS
  // PCI dibaca dari sectorData (shapefile), bukan di-generate.
  // Warna sektor: MAIN_SECTOR_COLORS untuk serving, NEIGHBOUR_PALETTE untuk nb.
  // ══════════════════════════════════════════════════════════════════════════
  function buildAllSectors() {
    allSectors = [];
    const s = driveTestData.site;
    const servSectorData = s.sectorData || [];

    const servSectors = servSectorData.length > 0
      ? servSectorData
      : (s.sectors || []).map((az, i) => ({
          sectorNum: i+1, azimuth: az, pci: null,
          cellId: null, cellName: `${driveTestData.siteId}_Sek${i+1}`,
          gnbId: s.gnbId || null, arfcn: 466850,
        }));

    servSectors.forEach((sec, i) => {
      allSectors.push({
        siteId    : driveTestData.siteId,
        siteLat   : s.lat, siteLng: s.lng,
        siteHeight: s.height || 30,
        isMain    : true, nbIdx: -1,
        sectorNum : sec.sectorNum || (i+1),
        azimuth   : sec.azimuth,
        pci       : sec.pci,       // dari shapefile
        cellId    : sec.cellId,
        cellName  : sec.cellName || `${driveTestData.siteId}_Sek${sec.sectorNum||i+1}`,
        gnbId     : sec.gnbId || s.gnbId || null,
        arfcn     : sec.arfcn || 466850,
        pciColor  : MAIN_SECTOR_COLORS[i % MAIN_SECTOR_COLORS.length],
        scenario  : s.scenario || 'uma',
        condition : s.condition || 'nlos',
        clutter   : s.clutter   || 'N/A',
      });
    });

    (driveTestData.neighbours || []).forEach((nb, nbIdx) => {
      const nbSectors = (nb.sectorData || []).length > 0
        ? nb.sectorData
        : (nb.sectors || []).map((az, i) => ({
            sectorNum: i+1, azimuth: az, pci: null,
            cellId: null, cellName: `${nb.siteId}_Sek${i+1}`,
            gnbId: nb.gnbId || null, arfcn: 466850,
          }));
      nbSectors.forEach((sec, secIdx) => {
        const colorIdx = (nbIdx * 6 + secIdx) % NEIGHBOUR_PALETTE.length;
        allSectors.push({
          siteId    : nb.siteId,
          siteLat   : nb.lat, siteLng: nb.lng,
          siteHeight: nb.height || 30,
          isMain    : false, nbIdx,
          sectorNum : sec.sectorNum || (secIdx+1),
          azimuth   : sec.azimuth,
          pci       : sec.pci,
          cellId    : sec.cellId,
          cellName  : sec.cellName || `${nb.siteId}_Sek${sec.sectorNum||secIdx+1}`,
          gnbId     : sec.gnbId || nb.gnbId || null,
          arfcn     : sec.arfcn || 466850,
          pciColor  : NEIGHBOUR_PALETTE[colorIdx],
          scenario  : nb.scenario || 'uma',
          condition : nb.condition || 'nlos',
          clutter   : nb.clutter   || 'N/A',
        });
      });
    });

    console.log(`[buildAllSectors] ${allSectors.length} sektor | PCI ok: ${allSectors.filter(s=>s.pci!==null).length}`);
  }

  function populateSiteInfo() {
    const h   = driveTestData.site.height || 30;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('infoSiteId', driveTestData.siteId);
    set('infoLat',    driveTestData.site.lat.toFixed(6));
    set('infoLng',    driveTestData.site.lng.toFixed(6));
    set('infoSectors',driveTestData.site.sectors.length);
    set('infoHeight', `${h} m`);
    set('paramHeight',`${h} m`);
    set('paramFreq',  `${CAL.FREQUENCY} MHz`);
    set('paramBW',    `${CAL.BANDWIDTH / 1e6} MHz`);
    set('paramTxPower',`${CAL.TX_POWER} dBm`);
  }

  function populateRouteData() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('routeDistance', `${(driveTestData.mainRoute.distance / 1000).toFixed(2)} km`);
    set('routeTime',     `${Math.round(driveTestData.mainRoute.duration / 60)} menit`);
  }

  // ── Map ───────────────────────────────────────────────────────────────────
  function initSimulationMap() {
    if (!driveTestData) return;
    simMap = L.map('map-simulation').setView([driveTestData.site.lat, driveTestData.site.lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(simMap);
    simSiteLayer     = L.layerGroup().addTo(simMap);
    simRouteLayer    = L.layerGroup().addTo(simMap);
    simSamplingLayer = L.layerGroup().addTo(simMap);
    simHeatmapLayer  = L.layerGroup().addTo(simMap);
    cellLineLayer    = L.layerGroup().addTo(simMap);

    const siteMap = {};
    allSectors.forEach(sec => {
      if (!siteMap[sec.siteId]) siteMap[sec.siteId] = {
        siteId: sec.siteId, lat: sec.siteLat, lng: sec.siteLng,
        isMain: sec.isMain, sectors: [],
      };
      siteMap[sec.siteId].sectors.push(sec);
    });

    Object.values(siteMap).forEach(site => {
      L.circleMarker([site.lat, site.lng], {
        radius: site.isMain ? 10 : 8,
        fillColor: site.isMain ? '#ffd000' : '#ff8c00',
        color: '#000', weight: site.isMain ? 3 : 2, fillOpacity: 1,
      }).addTo(simSiteLayer)
        .bindPopup(`<b>${site.isMain ? '⭐ SERVING' : '📡 NEIGHBOUR'}: ${site.siteId}</b><br>${site.sectors.length} sektor`);

      L.marker([site.lat, site.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:rgba(255,220,0,0.92);color:#111;font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;white-space:nowrap;margin-top:-22px;margin-left:12px;border:1px solid rgba(0,0,0,0.25);">${site.siteId}</div>`,
          iconAnchor: [0, 0],
        }),
        interactive: false, zIndexOffset: 100,
      }).addTo(simSiteLayer);

      site.sectors.forEach((sec, i) => {
        drawSectorFan(site.lat, site.lng, sec.azimuth, CAL.BEAMWIDTH,
          site.isMain ? 130 : 90, i, site.isMain ? 0.18 : 0.07, sec.pciColor);
      });
    });

    const coords = driveTestData.activeRouteData.coords.map(p => [p.lat, p.lng]);
    const mainLine = L.polyline(coords, { color: '#0066ff', weight: 5, opacity: 0.7 }).addTo(simRouteLayer);
    if (driveTestData.altRoute?.coords)
      L.polyline(driveTestData.altRoute.coords.map(p => [p.lat, p.lng]),
        { color: '#ff8800', weight: 4, opacity: 0.5 }).addTo(simRouteLayer);
    try { simMap.fitBounds(mainLine.getBounds(), { padding: [40, 40] }); }
    catch { simMap.setView([driveTestData.site.lat, driveTestData.site.lng], 15); }
  }

  function drawSectorFan(lat, lng, az, bw, radius, idx, fillOpacity, color) {
    const pts = [[lat, lng]];
    for (let i = 0; i <= 16; i++) {
      const p = destPoint(lat, lng, (az - bw / 2) + (i / 16) * bw, radius);
      pts.push([p.lat, p.lng]);
    }
    pts.push([lat, lng]);
    L.polygon(pts, { color, fillColor: color, fillOpacity, weight: 2, opacity: 0.7 })
      .addTo(simSiteLayer).bindPopup(`<b>Sektor ${idx+1}</b><br>Azimuth: ${az}°`);
  }

  // ── Event listeners ───────────────────────────────────────────────────────
  function setupEventListeners() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('btnBackToRoute',      () => window.location.href = '/route');
    on('btnGenerateSampling', generateSamplingPoints);
    on('btnCalculateRSRP',    calculateRSRP);
    on('btnCalculateSINR',    calculateSINR);
    on('btnSimulatePCI',      simulatePCI);
    on('btnExportCSV',        exportToCSV);
  }

  window.setDisplayMode = function (mode) {
    displayMode = mode;
    document.getElementById('btnModeRSRP')?.classList.toggle('active', mode === 'rsrp');
    document.getElementById('btnModePCI')?.classList.toggle('active',  mode === 'pci');
    document.getElementById('rsrpLegend').style.display = mode === 'rsrp' ? 'block' : 'none';
    document.getElementById('pciLegend').style.display  = mode === 'pci'  ? 'block' : 'none';
    if (mode === 'pci') redrawPCIMode(); else redrawRSRPSINRMode();
  };

  // ── Sampling 10 m ─────────────────────────────────────────────────────────
  const SAMPLING_INTERVAL_M = 10;
  function generateSamplingPoints() {
    if (!driveTestData?.mainRoute) return alert('Data rute tidak ditemukan!');
    simSamplingLayer.clearLayers(); samplingPoints = [];
    activeSeed = Math.floor(Date.now() % 2147483647);
    const coords = driveTestData.activeRouteData.coords;
    if (coords.length < 2) return alert('Rute terlalu pendek!');
    let acc = 0, nxt = 0;
    samplingPoints.push({ lat: coords[0].lat, lng: coords[0].lng });
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i-1], curr = coords[i];
      const segLen = haversineDistance(prev.lat, prev.lng, curr.lat, curr.lng);
      if (segLen === 0) continue;
      while (acc + segLen >= nxt + SAMPLING_INTERVAL_M) {
        nxt += SAMPLING_INTERVAL_M;
        const ratio = (nxt - acc) / segLen;
        samplingPoints.push({
          lat: prev.lat + ratio * (curr.lat - prev.lat),
          lng: prev.lng + ratio * (curr.lng - prev.lng),
        });
        L.circleMarker([samplingPoints.at(-1).lat, samplingPoints.at(-1).lng], {
          radius: 3, fillColor: '#00ff00', color: '#000', weight: 1, fillOpacity: 0.8,
        }).addTo(simSamplingLayer);
      }
      acc += segLen;
    }
    const el = document.getElementById('samplingCount'); if (el) el.textContent = samplingPoints.length;
    alert(`${samplingPoints.length} titik sampling | Interval: ${SAMPLING_INTERVAL_M} m`);
    ['btnCalculateRSRP','btnCalculateSINR'].forEach(id => {
      const b = document.getElementById(id); if (b) b.disabled = false;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // KALKULASI RSRP
  //
  // Untuk setiap titik sampling:
  //   1. Dari setiap site, pilih sektor terbaik (azimuth terkecil ke titik)
  //   2. Hitung RSRP = P_TX + G_h(θ) − PL − L_clutter + ξ
  //   3. Serving = sektor dengan RSRP tertinggi + HO_MARGIN
  //   4. Apply receiver sensitivity floor [TS 38.101-1]
  // ══════════════════════════════════════════════════════════════════════════
  function calculateRSRP() {
    if (!samplingPoints.length) return alert('Generate titik sampling terlebih dahulu!');
    seedRng(activeSeed);
    simHeatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    rsrpResults = [];

    const mainSite   = driveTestData.site;
    const scenario   = mainSite.scenario  || 'uma';
    const condition  = mainSite.condition || 'nlos';
    const shadowKey  = `${scenario}_${condition === 'los_nlos' ? 'nlos' : condition}`;
    const shadowStd  = SHADOW_STD[shadowKey] || 6.0;
    const modelLabel = `${scenario.toUpperCase()} ${condition.toUpperCase()}`;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('paramModel',     modelLabel);
    set('paramModelInfo', modelLabel);
    set('paramClutter',   mainSite.clutter || 'N/A');

    // Group sektor per site
    const siteMap = {};
    allSectors.forEach(sec => {
      if (!siteMap[sec.siteId]) siteMap[sec.siteId] = [];
      siteMap[sec.siteId].push(sec);
    });

    samplingPoints.forEach((point, idx) => {
      const cellResults = [];

      Object.entries(siteMap).forEach(([siteId, sectors]) => {
        const firstSec = sectors[0];
        const dist     = haversineDistance(firstSec.siteLat, firstSec.siteLng, point.lat, point.lng);
        const d        = Math.max(dist, 10); // TR 38.901 §7.4.1
        const brng     = bearingCalc(firstSec.siteLat, firstSec.siteLng, point.lat, point.lng);
        const { bestSec, bestGain } = pickBestSectorForPoint(brng, sectors);
        if (!bestSec) return;

        const sc       = (bestSec.scenario  || scenario).toLowerCase();
        const cond     = (bestSec.condition || condition).toLowerCase();
        const pl       = pathLoss(sc, cond, d, CAL.FREQUENCY, bestSec.siteHeight, CAL.MOBILE_H);
        const cLoss    = getClutterLoss(bestSec.clutter || mainSite.clutter);

        // Shadow fading log-normal [TR 38.901 Table 7.4.4]
        const sKey  = `${sc}_${cond === 'los_nlos' ? 'nlos' : cond}`;
        const sStd  = SHADOW_STD[sKey] || 6.0;
        const xi    = gaussianRandom(0, sStd); // ξ ~ N(0, σ²)

        const rsrpRaw = CAL.TX_POWER + bestGain - pl - cLoss + xi;
        const rsrp    = applyRxFloor(rsrpRaw); // floor [TS 38.101-1]

        cellResults.push({
          siteId, siteLat: firstSec.siteLat, siteLng: firstSec.siteLng,
          isMain    : firstSec.isMain,
          sectorNum : bestSec.sectorNum, azimuth: bestSec.azimuth,
          pci       : bestSec.pci, cellId: bestSec.cellId,
          cellName  : bestSec.cellName, gnbId: bestSec.gnbId,
          pciColor  : bestSec.pciColor, arfcn: bestSec.arfcn,
          dist, bearing: brng, antennaGain: bestGain,
          pathLoss: pl, clutterLoss: cLoss, shadowStd: sStd,
          rsrp, scenario: modelLabel, clutter: bestSec.clutter || mainSite.clutter,
        });
      });

      if (!cellResults.length) return;

      // Serving: RSRP tertinggi + HO margin [TR 36.942]
      let serving = cellResults[0];
      cellResults.forEach(c => { if (c.rsrp > serving.rsrp + CAL.HO_MARGIN) serving = c; });
      const sorted = [serving, ...cellResults.filter(c => c !== serving).sort((a, b) => b.rsrp - a.rsrp)];

      const marker = L.circleMarker([point.lat, point.lng], {
        radius: 5, fillColor: rsrpColor(serving.rsrp), color: '#000', weight: 1, fillOpacity: 0.9,
      }).addTo(simHeatmapLayer);
      marker.on('click', () => onPointClick(point, idx + 1, sorted));

      rsrpResults.push({ index: idx + 1, lat: point.lat, lng: point.lng, cells: sorted, serving });
    });

    document.getElementById('btnSimulatePCI').disabled = false;
    updateLegend('RSRP'); showResultBox('RSRP');
    document.getElementById('btnExportCSV').disabled = false;

    const avg    = (rsrpResults.reduce((s, r) => s + r.serving.rsrp, 0) / rsrpResults.length).toFixed(1);
    const pciSet = new Set(rsrpResults.map(r => r.serving.pci).filter(p => p !== null));
    alert(
      `Kalkulasi RSRP selesai — ${rsrpResults.length} titik\n` +
      `Model: ${modelLabel} [3GPP TR 38.901]\n` +
      `Shadow fading σ: ${shadowStd} dB [TR 38.901 Table 7.4.4]\n` +
      `Rx floor: ${RX_SENSITIVITY_FLOOR} dBm [TS 38.101-1]\n` +
      `Avg Serving RSRP: ${avg} dBm\n` +
      `PCI unik: ${pciSet.size}`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // KALKULASI SINR — 3GPP TR 36.942 §A.1
  //
  // SINR = S / (I + N)   [linear]
  //
  //   S = daya serving cell [linear dari dBm]
  //   I = jumlah daya semua interferer [linear]
  //   N = thermal noise = 10^((−174 + 10·log10(BW) + NF)/10) [mW]
  //
  // Referensi: 3GPP TR 36.942 §A.1
  // ══════════════════════════════════════════════════════════════════════════
  function calculateSINR() {
    if (!rsrpResults.length) return alert('Hitung RSRP terlebih dahulu!');
    seedRng(activeSeed + 1);

    const N_linear = dbmToLinear(THERMAL_NOISE_DBM); // thermal noise [mW]

    rsrpResults.forEach((result, idx) => {
      const S_linear = dbmToLinear(result.serving.rsrp);

      // I = jumlah daya semua sel lain (interferer)
      let I_linear = N_linear; // noise floor sebagai batas bawah
      result.cells.forEach((c, ci) => {
        if (ci === 0) return; // skip serving
        I_linear += dbmToLinear(c.rsrp);
      });

      // SINR serving
      const sinr_linear = S_linear / I_linear;
      const sinr        = Math.max(-10, Math.min(40, linearToDbm(sinr_linear)));
      const rsrq        = estimateRSRQ(result.serving.rsrp, sinr);

      rsrpResults[idx].sinr = sinr;
      rsrpResults[idx].rsrq = rsrq;
      rsrpResults[idx].serving.sinr = sinr;
      rsrpResults[idx].serving.rsrq = rsrq;

      // SINR per neighbour cell
      result.cells.forEach((c, ci) => {
        if (ci === 0) return;
        const S_nb = dbmToLinear(c.rsrp);
        // Interferensi = semua sel kecuali sel ini
        let I_nb = N_linear;
        result.cells.forEach((cc, cci) => { if (cci !== ci) I_nb += dbmToLinear(cc.rsrp); });
        c.sinr = Math.max(-10, Math.min(40, linearToDbm(S_nb / I_nb)));
        c.rsrq = estimateRSRQ(c.rsrp, c.sinr);
      });
    });

    simHeatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    rsrpResults.forEach((result, idx) => {
      const marker = L.circleMarker([result.lat, result.lng], {
        radius: 5, fillColor: sinrColor(result.sinr), color: '#000', weight: 1, fillOpacity: 0.9,
      }).addTo(simHeatmapLayer);
      marker.on('click', () => onPointClick(result, idx + 1, result.cells));
    });

    updateLegend('SINR'); showResultBox('SINR');

    const total   = rsrpResults.length;
    const avgSINR = (rsrpResults.reduce((s, r) => s + r.sinr, 0) / total).toFixed(1);
    const p20 = ((rsrpResults.filter(r => r.sinr >= 20).length / total) * 100).toFixed(1);
    const p10 = ((rsrpResults.filter(r => r.sinr >= 10 && r.sinr < 20).length / total) * 100).toFixed(1);
    const p0  = ((rsrpResults.filter(r => r.sinr >= 0  && r.sinr < 10).length / total) * 100).toFixed(1);
    alert(
      `Kalkulasi SINR selesai [3GPP TR 36.942]\n` +
      `Thermal noise: ${THERMAL_NOISE_DBM.toFixed(1)} dBm\n` +
      `Avg SINR: ${avgSINR} dB\n\n` +
      `≥20 dB: ${p20}% | 10~20 dB: ${p10}% | 0~10 dB: ${p0}%`
    );
  }

  // ── PCI mode ─────────────────────────────────────────────────────────────
  function simulatePCI() {
    if (!rsrpResults.length) return alert('Hitung RSRP terlebih dahulu!');
    setDisplayMode('pci');
  }

  function redrawPCIMode() {
    if (!rsrpResults.length) return;
    simHeatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    const pciDist = {};
    rsrpResults.forEach(r => {
      const key = `${r.serving.siteId}|S${r.serving.sectorNum}`;
      if (!pciDist[key]) pciDist[key] = {
        siteId: r.serving.siteId, sectorNum: r.serving.sectorNum,
        pci: r.serving.pci, color: r.serving.pciColor,
        cellName: r.serving.cellName, isMain: r.serving.isMain, count: 0,
      };
      pciDist[key].count++;
      const marker = L.circleMarker([r.lat, r.lng], {
        radius: 5, fillColor: r.serving.pciColor || '#888',
        color: '#000', weight: 1, fillOpacity: 0.9,
      }).addTo(simHeatmapLayer);
      marker.on('click', () => onPointClick(r, r.index, r.cells));
    });
    updatePCILegend(pciDist); showResultBox('PCI');
  }

  function redrawRSRPSINRMode() {
    if (!rsrpResults.length) return;
    simHeatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    const hasSINR = rsrpResults[0]?.sinr !== undefined;
    rsrpResults.forEach((result, idx) => {
      const color  = hasSINR ? sinrColor(result.sinr) : rsrpColor(result.serving.rsrp);
      const marker = L.circleMarker([result.lat, result.lng], {
        radius: 5, fillColor: color, color: '#000', weight: 1, fillOpacity: 0.9,
      }).addTo(simHeatmapLayer);
      marker.on('click', () => onPointClick(result, idx + 1, result.cells));
    });
    document.getElementById('rsrpLegend').style.display = 'block';
    document.getElementById('pciLegend').style.display  = 'none';
    updateLegend(hasSINR ? 'SINR' : 'RSRP');
  }

  function updatePCILegend(pciDist) {
    const legend = document.getElementById('pciLegend');
    const body   = document.getElementById('pciLegendBody');
    if (!legend || !body) return;
    const total  = rsrpResults.length || 1;
    const sorted = Object.values(pciDist).sort((a, b) => b.count - a.count);
    body.innerHTML = sorted.map(d => {
      const pct    = ((d.count / total) * 100).toFixed(1);
      const pciStr = d.pci !== null ? d.pci : 'N/A';
      return `<div class="pci-legend-row">
        <div class="pci-dot" style="background:${d.color}"></div>
        <span>${d.siteId} Sek${d.sectorNum} — PCI ${pciStr} (${d.count}, ${pct}%)</span>
      </div>`;
    }).join('');
    legend.style.display = 'block';
  }

  // ── Klik titik ────────────────────────────────────────────────────────────
  function onPointClick(point, ptIdx, cells) {
    cellLineLayer.clearLayers();
    const drawnSites = new Set();
    cells.forEach((c, i) => {
      if (drawnSites.has(c.siteId)) return;
      drawnSites.add(c.siteId);
      const col = LINE_COLORS[Math.min(i, LINE_COLORS.length - 1)];
      L.polyline([[point.lat, point.lng], [c.siteLat, c.siteLng]], {
        color: col, weight: i === 0 ? 3.5 : 2, opacity: 0.9, dashArray: i === 0 ? null : '7 4',
      }).addTo(cellLineLayer)
        .bindTooltip(
          `<b>${i === 0 ? '⭐ Serving' : 'Detected'}: ${c.siteId}</b><br>` +
          `Sek${c.sectorNum} | ${c.dist.toFixed(0)} m | RSRP: ${c.rsrp.toFixed(1)} | PCI: ${c.pci ?? 'N/A'}`,
          { sticky: true }
        );
    });
    updateCellTable(point, ptIdx, cells);
  }

  function initCellPanelPills() {
    const pills = document.getElementById('cellLegendPills'); if (!pills) return;
    const labels = ['⭐ Serving','Det-1','Det-2','Det-3','Det-4','Det-5+'];
    pills.innerHTML = LINE_COLORS.map((c, i) =>
      `<span class="line-pill" style="background:${c}">${labels[i] || 'Det'}</span>`
    ).join('');
  }

  function updateCellTable(point, ptIdx, cells) {
    const wrapper = document.getElementById('cellTableWrapper');
    const title   = document.getElementById('cellPanelTitle');
    if (!wrapper) return;
    if (title) {
      title.innerHTML = `📡 NR Serving and Neighbor Cells — <b>Point ${ptIdx}</b>` +
        `<span style="font-weight:400;font-size:10px;opacity:0.75;margin-left:8px;">` +
        `(${point.lat.toFixed(5)}, ${point.lng.toFixed(5)})</span>`;
    }
    const hasSINR  = cells[0]?.sinr !== undefined;
    const dotColor = (val, type) => {
      if (val == null) return '#aaa';
      if (type === 'rsrp') { if (val >= -85) return '#0042a5'; if (val >= -95) return '#00a955'; if (val >= -105) return '#ffd000'; return '#ff3333'; }
      if (type === 'sinr') { if (val >= 10) return '#00a955'; if (val >= 0) return '#ffd000'; return '#ff3333'; }
      return '#aaa';
    };
    const drawnSitesMap = {}; let lineIdx = 0;
    cells.forEach(c => { if (drawnSitesMap[c.siteId] === undefined) drawnSitesMap[c.siteId] = lineIdx++; });
    let rows = '';
    cells.forEach((c, i) => {
      const li       = drawnSitesMap[c.siteId];
      const lc       = LINE_COLORS[Math.min(li, LINE_COLORS.length - 1)];
      const isFirst  = i === 0;
      const typeLabel = isFirst
        ? `<span class="cell-type serving"  style="border-left-color:${lc}">Serving</span>`
        : `<span class="cell-type detected" style="border-left-color:${lc}">Detected</span>`;
      const pciStr  = c.pci !== null && c.pci !== undefined ? c.pci : 'N/A';
      const sinrStr = hasSINR && c.sinr != null ? c.sinr.toFixed(2) : '—';
      const cName   = c.cellName || `${c.siteId}_Sek${c.sectorNum}`;
      rows += `<tr class="${isFirst ? 'row-serving' : 'row-detected'}">
        <td>${typeLabel}</td>
        <td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c.pciColor||'#aaa'};margin-right:3px;vertical-align:middle;border:1px solid rgba(0,0,0,0.2)"></span>${pciStr}</td>
        <td>${c.arfcn || 466850}</td>
        <td><span class="dot" style="background:${dotColor(c.rsrp,'rsrp')}"></span>${c.rsrp.toFixed(2)}</td>
        <td><span class="dot" style="background:${dotColor(c.sinr,'sinr')}"></span>${sinrStr}</td>
        <td>${c.cellId ?? '—'}</td>
        <td title="${cName}">${cName.length > 28 ? cName.slice(0, 28) + '…' : cName}</td>
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

  // ── Legend & Result box ───────────────────────────────────────────────────
  function updateLegend(type) {
    const legend = document.getElementById('rsrpLegend');
    const tbody  = document.getElementById('legendTableBody');
    const title  = document.getElementById('legendTitle');
    if (!legend || !tbody) return;
    if (title) title.textContent = type === 'RSRP' ? 'RSRP (dBm)' : 'SINR (dB)';
    const buckets = type === 'RSRP' ? [
      { label: '≥ -85',      color: '#0042a5', fn: v => v >= -85  },
      { label: '-95 ~ -85',  color: '#00a955', fn: v => v >= -95  && v < -85  },
      { label: '-105 ~ -95', color: '#70ff66', fn: v => v >= -105 && v < -95  },
      { label: '-120 ~ -105',color: '#fffb00', fn: v => v >= -120 && v < -105 },
      { label: '-125 ~ -120',color: '#ff3333', fn: v => v >= -125 && v < -120 },
      { label: '< -125',     color: '#800000', fn: v => v < -125              },
    ] : [
      { label: '≥ 20 dB',  color: '#0042a5', fn: v => v >= 20 },
      { label: '10~20 dB', color: '#00a955', fn: v => v >= 10 && v < 20 },
      { label: '0~10 dB',  color: '#70ff66', fn: v => v >= 0  && v < 10 },
      { label: '-5~0 dB',  color: '#fffb00', fn: v => v >= -5 && v < 0  },
      { label: '-10~-5 dB',color: '#ff3333', fn: v => v >= -10&& v < -5 },
      { label: '< -10 dB', color: '#800000', fn: v => v < -10 },
    ];
    const total = rsrpResults.length || 1;
    tbody.innerHTML = buckets.map(b => {
      const cnt = rsrpResults.filter(r =>
        b.fn(parseFloat((type === 'RSRP' ? r.serving?.rsrp : r.sinr) ?? 0))
      ).length;
      return `<tr>
        <td><div style="width:14px;height:14px;background:${b.color};border-radius:3px;border:1px solid #ccc;display:inline-block;"></div></td>
        <td>${b.label}</td><td><b>${((cnt / total) * 100).toFixed(1)}%</b></td>
      </tr>`;
    }).join('');
    legend.style.display = 'block';
    document.getElementById('pciLegend').style.display = 'none';
  }

  function showResultBox(type) {
    const box = document.getElementById('resultBox'); if (!box) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    if (type === 'RSRP') {
      set('resultTitle',   'Kalkulasi RSRP Selesai');
      set('resultStats',   `${rsrpResults.length} titik | 3GPP TR 38.901 | Rx floor ${RX_SENSITIVITY_FLOOR} dBm`);
      set('resultMessage', 'Klik titik di peta → detail sel & garis ke site');
    } else if (type === 'SINR') {
      set('resultTitle',   'Kalkulasi SINR Selesai');
      set('resultStats',   `${rsrpResults.length} titik | SINR = S/(I+N) [TR 36.942]`);
      set('resultMessage', `Thermal noise: ${THERMAL_NOISE_DBM.toFixed(1)} dBm`);
    } else {
      set('resultTitle',   'Simulasi PCI Aktif');
      const ps = new Set(rsrpResults.map(r => r.serving.pci).filter(p => p !== null));
      set('resultStats',   `${ps.size} PCI unik — dari shapefile`);
      set('resultMessage', 'Warna per sektor, azimuth-based coverage');
    }
    box.style.display = 'block';
  }

  // ── Export CSV ────────────────────────────────────────────────────────────
  function exportToCSV() {
    if (!rsrpResults.length) return alert('Belum ada data!');
    const hasSINR = rsrpResults[0]?.sinr !== undefined;
    let csv = 'Point,Lat,Lng,ServingSite,ServingSector,Distance(m),Bearing(deg),' +
              'AntennaGain(dB),PathLoss(dB),ClutterLoss(dB),ShadowSTD(dB),Clutter,Model,' +
              'RSRP(dBm),RSRQ(dB),PCI,ARFCN,gNBID,CellID,CellName';
    if (hasSINR) csv += ',SINR(dB)';
    csv += '\n';
    rsrpResults.forEach(r => {
      const s     = r.serving;
      const cName = s.cellName || `${s.siteId}_Sek${s.sectorNum}`;
      csv += `${r.index},${r.lat.toFixed(6)},${r.lng.toFixed(6)},${s.siteId},${s.sectorNum},` +
             `${s.dist.toFixed(1)},${s.bearing.toFixed(1)},${s.antennaGain.toFixed(1)},` +
             `${s.pathLoss.toFixed(1)},${s.clutterLoss.toFixed(1)},${s.shadowStd||'6.0'},` +
             `${s.clutter},${s.scenario},` +
             `${s.rsrp.toFixed(1)},${s.rsrq != null ? s.rsrq.toFixed(1) : ''},` +
             `${s.pci ?? ''},${s.arfcn || 466850},${s.gnbId || ''},${s.cellId || ''},"${cName}"`;
      if (hasSINR) csv += `,${r.sinr.toFixed(1)}`;
      csv += '\n';
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const ts   = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const a    = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `DriveTest_v40_${driveTestData.siteId}_${ts}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // ── Geo utils ─────────────────────────────────────────────────────────────
  function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6378137, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  function bearingCalc(lat1, lng1, lat2, lng2) {
    const p1 = lat1*Math.PI/180, p2 = lat2*Math.PI/180, dl = (lng2-lng1)*Math.PI/180;
    return (Math.atan2(Math.sin(dl)*Math.cos(p2), Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360;
  }
  function destPoint(lat, lng, az, dist) {
    const R = 6378137, brng = az*Math.PI/180, d = dist/R;
    const lat1 = lat*Math.PI/180, lng1 = lng*Math.PI/180;
    const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d)+Math.cos(lat1)*Math.sin(d)*Math.cos(brng));
    const lng2 = lng1+Math.atan2(Math.sin(brng)*Math.sin(d)*Math.cos(lat1), Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
    return { lat: lat2*180/Math.PI, lng: lng2*180/Math.PI };
  }
  function rsrpColor(v) {
    if (v >= -85)  return '#0042a5';
    if (v >= -95)  return '#00a955';
    if (v >= -105) return '#70ff66';
    if (v >= -120) return '#fffb00';
    if (v >= -125) return '#ff3333';
    return '#800000';
  }
  function sinrColor(v) {
    if (v >= 20)  return '#0042a5';
    if (v >= 10)  return '#00a955';
    if (v >= 0)   return '#70ff66';
    if (v >= -5)  return '#fffb00';
    if (v >= -10) return '#ff3333';
    return '#800000';
  }

  window.generateSamplingPoints = generateSamplingPoints;
  window.calculateRSRP          = calculateRSRP;
  window.calculateSINR          = calculateSINR;
  window.simulatePCI            = simulatePCI;
  window.exportToCSV            = exportToCSV;

})();

console.log('simulation_route_v40_akademik.js — 3GPP TR 38.901 + TR 36.942 | SINR=S/(I+N) | Clutter konstan | Rx floor TS 38.101-1');