// ================= SIMULATION ROUTE v4.5 — DETERMINISTIK EDITION =================
//
// PERUBAHAN DARI v4.4 → v4.5:
//
//   [FIX-1] DETERMINISTIK PENUH — Seed tetap FIXED_SEED = 20250101
//           Seed tidak lagi pakai Date.now() sehingga hasil RSRP/SINR
//           identik di sesi manapun selama parameter RF tidak diubah.
//
//   [FIX-2] SNAPSHOT TITIK SAMPLING — disimpan ke localStorage
//           Key: samplingSnapshot_<siteId>_<routeHash>
//           Setiap buka halaman → load snapshot → titik IDENTIK.
//           Hanya di-generate ulang jika: (a) belum ada snapshot,
//           atau (b) rute berubah (hash berbeda).
//
//   [FIX-3] SAMPLING INTERVAL 10m DIPERBAIKI
//           Bug lama: ratio bisa overflow jika segmen coords < 1m
//           (coords routing API kadang sangat rapat).
//           Fix: coords di-resample dulu menjadi polyline kasar,
//           lalu walker berjalan sepanjang polyline dengan step tepat 10m.
//           Hasilnya: jarak antar titik SELALU 10m ± epsilon floating point.
//
//   [FIX-4] RECOVERY DATA JURNAL — konstanta JOURNAL_SNAPSHOT
//           Berisi titik sampling persis yang dipakai saat penulisan jurnal.
//           Jika lu set USE_JOURNAL_SNAPSHOT = true, sistem pakai data itu.
//           Berguna untuk demo seminar agar hasil = persis jurnal.
//
// REFERENSI UTAMA:
//   - 3GPP TR 38.901 v17: Channel model 0.5-100 GHz
//   - 3GPP TR 36.942:     Radio frequency system scenarios
//   - 3GPP TS 38.101-1:   NR UE radio transmission and reception
//   - 3GPP TS 38.331:     NR RRC — measurement & reporting
//   - 3GPP TS 38.133:     NR requirements for RRM
// =================================================================================
(function () {
  'use strict';

  const mapElement = document.getElementById('map-simulation');
  if (!mapElement) return;

  // ══════════════════════════════════════════════════════════════════════════
  // [v4.5] KONFIGURASI DETERMINISTIK
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * FIXED_SEED — seed utama untuk shadow fading.
   * JANGAN UBAH nilai ini setelah jurnal ditulis.
   * Nilai ini yang memastikan RSRP/SINR identik di semua sesi.
   */
  const FIXED_SEED = 20250101;

  /**
   * USE_JOURNAL_SNAPSHOT — set true untuk DEMO SEMINAR.
   * Jika true, sistem akan memuat titik sampling dari JOURNAL_SNAPSHOT
   * di bawah, mengabaikan snapshot localStorage maupun generate baru.
   * Hasilnya dijamin = persis jurnal.
   *
   * Cara mendapatkan nilai JOURNAL_SNAPSHOT:
   *   1. Jalankan simulasi sekali dengan USE_JOURNAL_SNAPSHOT = false
   *   2. Buka console browser → ketik: getJournalSnapshot()
   *   3. Copy output → paste ke JOURNAL_SNAPSHOT di bawah
   *   4. Set USE_JOURNAL_SNAPSHOT = true
   */
  const USE_JOURNAL_SNAPSHOT = false;

  /**
   * JOURNAL_SNAPSHOT — isi dengan output getJournalSnapshot() dari sesi jurnal.
   * Format: array of {lat, lng}
   * Biarkan kosong ([]) jika belum punya.
   */
  const JOURNAL_SNAPSHOT = [
    // Contoh (isi dengan data asli lu):
    // { lat: -6.27450, lng: 106.83200 },
    // { lat: -6.27459, lng: 106.83209 },
    // ... dst
  ];

  // ── Konstanta sampling ────────────────────────────────────────────────────
  const SAMPLING_INTERVAL_M = 10;

  // ── Key localStorage ──────────────────────────────────────────────────────
  // Key dibuat unik per siteId + hash rute agar tidak konflik antar proyek
  function getSnapshotKey(siteId, routeHash) {
    return `samplingSnapshot_${siteId}_${routeHash}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════════════════════════════════
  let simMap;
  let simSiteLayer, simRouteLayer, simSamplingLayer, simHeatmapLayer, cellLineLayer;
  let driveTestData  = null;
  let samplingPoints = [];
  let rsrpResults    = [];
  let allSectors     = [];
  let displayMode    = 'rsrp';

  let calcState       = 'none';
  let autoRecalcTimer = null;
  const AUTO_RECALC_DEBOUNCE_MS = 650;

  // activeSeed sekarang SELALU = FIXED_SEED, tidak pernah berubah
  const activeSeed = FIXED_SEED;

  // ══════════════════════════════════════════════════════════════════════════
  // WARNA
  // ══════════════════════════════════════════════════════════════════════════
  const MAIN_SECTOR_COLORS = [
    '#e6194b', '#3cb44b', '#4363d8',
    '#f58231', '#911eb4', '#42d4f4',
  ];
  const NEIGHBOUR_PALETTE = [
    '#f032e6','#bfef45','#469990','#dcbeff',
    '#9a6324','#800000','#aaffc3','#808000',
    '#ffd8b1','#fffac8','#000075','#a9a9a9',
  ];
  const LINE_COLORS = ['#00c050','#1a6fff','#ff8800','#ffd000','#ff3333','#888888'];

  // ══════════════════════════════════════════════════════════════════════════
  // KONSTANTA RF DEFAULT
  // ══════════════════════════════════════════════════════════════════════════
  const CAL_DEFAULT = {
    TX_POWER   : 46,
    FREQUENCY  : 2300,
    BANDWIDTH  : 30e6,
    MOBILE_H   : 1.5,
    ANTENNA_Am : 25,
    BEAMWIDTH  : 65,
    NF         : 7,
    ANT_HEIGHT : 30,
    NUM_SECTORS: 3,
    AZIMUTHS   : [0, 120, 240],
    // [v4.5] Clutter bukan parameter yang diatur pengguna — diisi otomatis
    // dari data site (shapefile) dan disimpan sebagai state di sini,
    // bukan dibaca dari dropdown (dropdown rf_clutter sudah dihapus dari UI).
    CLUTTER    : 'n/a',
  };

  let CAL = { ...CAL_DEFAULT };

  const RX_SENSITIVITY_FLOOR   = -125.2;
  const INTERFERENCE_MARGIN_DB = 2.0;

  /**
   * [SYNC v19.1] Dominant interferer threshold, identik dengan
   * DOMINANT_INTERFERER_THRESHOLD_DB di simulation_dt_v19.5.js.
   * Hanya sel non-serving dengan RSRP > serving_RSRP - 30 dB yang
   * dihitung sebagai interferensi signifikan [3GPP TR 36.942 §A.1].
   */
  const DOMINANT_INTERFERER_THRESHOLD_DB = 30;

  function getThermalNoise() {
    return -174 + 10 * Math.log10(CAL.BANDWIDTH) + CAL.NF;
  }
  function getNEffLinear() {
    return Math.pow(10, (getThermalNoise() + INTERFERENCE_MARGIN_DB) / 10);
  }

  // ── Threshold kategori sel ────────────────────────────────────────────────
  const RSRP_DETECTED_THRESH = -105;
  const SINR_DETECTED_THRESH = -3;

  function getCellCategory(rsrp, sinr, isServing) {
    if (isServing) return 'serving';
    if (rsrp >= RSRP_DETECTED_THRESH && (sinr == null || sinr >= SINR_DETECTED_THRESH))
      return 'detected';
    return 'listed';
  }

  // ── Clutter loss ──────────────────────────────────────────────────────────
  // [SYNC v19.4] Disamakan dengan simulation_dt_v19.5.js (CSV-based).
  // Nilai dense_urban/metropolitan/urban/n_a diturunkan ke 0.0 karena efeknya
  // sudah ter-cover di path loss NLOS TR 38.901. suburban/sub_urban 1.0 (dari 2.5).
  // Key non-standar (open, industrial, forest, water, highway) dihapus agar
  // rumus inline dengan modul CSV.
  const CLUTTER_LOSS_DB = {
    dense_urban : 0.0, metropolitan: 0.0, urban: 0.0,
    suburban    : 1.0, sub_urban: 1.0, rural: 0.5,
    'n/a'       : 0.0,
  };

  // [SYNC v19.4] Ditambahkan kategori '_mixed' per skenario, identik dengan
  // SHADOW_STD_3GPP di simulation_dt_v19.5.js [3GPP TR 38.901 Table 7.4.4-1]
  const SHADOW_STD = {
    uma_los: 4.0, uma_nlos: 6.0, uma_mixed: 5.5,
    umi_los: 4.0, umi_nlos: 7.82, umi_mixed: 7.0,
    rma_los: 4.0, rma_nlos: 8.0, rma_mixed: 6.5,
  };

  // ══════════════════════════════════════════════════════════════════════════
  // [SYNC v19] SPATIAL NOISE — shadow fading berbasis lokasi geografis
  //
  // Diganti dari sequential RNG (v4.5) ke spatial hashing, identik dengan
  // simulation_dt_v19.5.js (CSV-based, sudah terverifikasi).
  //
  // Root cause masalah RNG sequential lama: noise ditentukan oleh urutan
  // titik diproses dalam loop, BUKAN oleh lokasi fisiknya. Akibatnya, dua
  // titik yang berdekatan secara fisik (misalnya jalur masuk dan jalur
  // balik pada gang buntu) bisa mendapat nilai shadow fading yang sangat
  // berbeda, padahal secara fisik shadow fading harus berkorelasi spasial
  // (lokasi berdekatan melewati obstacle/lingkungan yang sama).
  //
  // spatialNoise() men-snap koordinat ke grid ~55m (SPATIAL_GRID_SIZE),
  // lalu noise dihitung dari hash koordinat grid tersebut — sehingga titik
  // yang berdekatan secara fisik mendapat noise yang serupa/identik,
  // menghasilkan transisi RSRP/SINR yang smooth sepanjang rute, bukan
  // pola acak ("patchwork").
  //
  // Clamp ±2σ mengikuti [ITU-R M.2135 §A.1], sama seperti CSV.
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

  // [DEPRECATED v4.6] seedRng/rng/gaussianRandom dipertahankan sebagai no-op
  // aman karena masih dipanggil di beberapa titik (mis. awal _doCalculateRSRP,
  // _doCalculateSINR) untuk konsistensi pemanggilan, namun tidak lagi
  // menentukan nilai shadow fading — itu sekarang murni dari spatialNoise().
  let _rng = 0;
  function seedRng(s) { _rng = s >>> 0; }
  function rng() {
    _rng += 0x6D2B79F5;
    let t = _rng;
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

  // ══════════════════════════════════════════════════════════════════════════
  // [v4.5] HASH RUTE — untuk key snapshot yang unik per rute
  // ══════════════════════════════════════════════════════════════════════════
  function hashRoute(coords) {
    // Hash ringan: XOR lat/lng dari setiap titik ke-10
    let h = 0;
    for (let i = 0; i < coords.length; i += 10) {
      const c  = coords[i];
      const lv = Math.round(c.lat * 1e5);
      const nv = Math.round(c.lng * 1e5);
      h = (Math.imul(h, 31) + lv + nv) | 0;
    }
    // Tambah panjang array supaya rute beda tidak tabrakan
    h = (Math.imul(h, 31) + coords.length) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [v4.5 FIX-3] SAMPLING INTERVAL 10m YANG BENAR
  //
  // Algoritma lama bermasalah karena:
  //   - coords dari routing API bisa sangat rapat (< 1m per pasang coords)
  //   - ratio = (nxt - acc) / segLen bisa > 1 menghasilkan titik di luar segmen
  //
  // Algoritma baru:
  //   1. Bangun "cumulative distance array" sepanjang polyline
  //   2. Walker berjalan dari 0 sampai totalLen dengan step TEPAT 10m
  //   3. Untuk setiap target jarak D, cari segmen yang mengandung D
  //      dengan binary search → interpolasi linear
  //   Hasilnya: jarak antar titik SELALU tepat 10m ± floating point epsilon
  // ══════════════════════════════════════════════════════════════════════════
  function generateFixedIntervalPoints(coords, intervalM) {
    if (coords.length < 2) return [{ lat: coords[0].lat, lng: coords[0].lng }];

    // Langkah 1: Hitung cumulative distance di setiap vertex
    const cumDist = [0];
    for (let i = 1; i < coords.length; i++) {
      const d = haversineDistance(
        coords[i - 1].lat, coords[i - 1].lng,
        coords[i].lat,     coords[i].lng
      );
      cumDist.push(cumDist[i - 1] + d);
    }
    const totalLen = cumDist[cumDist.length - 1];

    // Langkah 2: Interpolasi titik di jarak target
    function interpolateAt(targetDist) {
      // Binary search segmen
      let lo = 0, hi = cumDist.length - 2;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumDist[mid + 1] < targetDist) lo = mid + 1;
        else hi = mid;
      }
      const seg     = lo;
      const segLen  = cumDist[seg + 1] - cumDist[seg];
      const ratio   = segLen < 1e-9 ? 0 : (targetDist - cumDist[seg]) / segLen;
      return {
        lat: coords[seg].lat + ratio * (coords[seg + 1].lat - coords[seg].lat),
        lng: coords[seg].lng + ratio * (coords[seg + 1].lng - coords[seg].lng),
      };
    }

    // Langkah 3: Walk setiap intervalM
    const points = [];
    // Titik pertama = awal rute
    points.push({ lat: coords[0].lat, lng: coords[0].lng });

    let d = intervalM;
    while (d <= totalLen - intervalM * 0.5) {
      points.push(interpolateAt(d));
      d += intervalM;
    }

    // Titik terakhir = akhir rute (jika belum masuk)
    const lastPt = { lat: coords[coords.length - 1].lat, lng: coords[coords.length - 1].lng };
    const distToLast = haversineDistance(
      points[points.length - 1].lat, points[points.length - 1].lng,
      lastPt.lat, lastPt.lng
    );
    if (distToLast > intervalM * 0.3) {
      points.push(lastPt);
    }

    return points;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [v4.5 FIX-2] SNAPSHOT MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  function saveSnapshot(siteId, routeHash, points) {
    try {
      const key  = getSnapshotKey(siteId, routeHash);
      const data = {
        version   : '4.5',
        seed      : FIXED_SEED,
        siteId,
        routeHash,
        createdAt : new Date().toISOString(),
        count     : points.length,
        points,
      };
      localStorage.setItem(key, JSON.stringify(data));
      console.log(`[Snapshot] 💾 Disimpan: ${points.length} titik | key: ${key}`);
      return true;
    } catch (e) {
      console.warn('[Snapshot] Gagal simpan ke localStorage:', e.message);
      return false;
    }
  }

  function loadSnapshot(siteId, routeHash) {
    try {
      const key  = getSnapshotKey(siteId, routeHash);
      const raw  = localStorage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data.points?.length) return null;
      console.log(`[Snapshot] ✅ Loaded: ${data.points.length} titik | dibuat: ${data.createdAt}`);
      return data.points;
    } catch (e) {
      console.warn('[Snapshot] Gagal load:', e.message);
      return null;
    }
  }

  function clearSnapshot(siteId, routeHash) {
    const key = getSnapshotKey(siteId, routeHash);
    localStorage.removeItem(key);
    console.log(`[Snapshot] 🗑 Dihapus: ${key}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CLUTTER & PATH LOSS
  // ══════════════════════════════════════════════════════════════════════════
  function getClutterLoss(clutterName) {
    const key = (clutterName || 'n/a').toLowerCase().replace(/[\s-]+/g, '_');
    if (CLUTTER_LOSS_DB[key] !== undefined) return CLUTTER_LOSS_DB[key];
    for (const [k, v] of Object.entries(CLUTTER_LOSS_DB)) {
      if (key.includes(k) || k.includes(key)) return v;
    }
    return CLUTTER_LOSS_DB['n/a'];
  }

  function pathLoss(scenario, condition, d2D_m, freq_mhz, hBS, hUT) {
    const d   = Math.max(d2D_m, 10);
    const hU  = hUT || 1.5;
    const fc  = freq_mhz / 1000;
    const c   = 3e8;
    const d3D = Math.sqrt(d * d + (hBS - hU) ** 2);

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
        const h = 5, W = 20;
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
  // ANTENNA GAIN
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

  function applyRxFloor(rsrp) { return Math.max(RX_SENSITIVITY_FLOOR, rsrp); }
  function dbmToLinear(dbm)   { return Math.pow(10, dbm / 10); }
  function linearToDbm(mw)    { return 10 * Math.log10(Math.max(mw, 1e-15)); }

  function estimateRSRQ(rsrp, sinr) {
    const N_RB = 66;
    const th   = getThermalNoise();
    const intf = th - sinr;
    const rssi = 10 * Math.log10(dbmToLinear(rsrp) + dbmToLinear(intf));
    return Math.max(-19.5, Math.min(-3, rsrp - rssi + 10 * Math.log10(N_RB)));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PANEL RF
  // ══════════════════════════════════════════════════════════════════════════
  function readRFPanel() {
    const get = id => { const el = document.getElementById(id); return el ? el.value : null; };
    const txPower   = parseFloat(get('rf_txpower'))   || CAL_DEFAULT.TX_POWER;
    const freq      = parseFloat(get('rf_frequency')) || CAL_DEFAULT.FREQUENCY;
    const bwMhz     = parseFloat(get('rf_bandwidth')) || (CAL_DEFAULT.BANDWIDTH / 1e6);
    const scenario  = get('rf_scenario')  || 'uma';
    const condition = get('rf_condition') || 'nlos';
    // [v4.5] Clutter dibaca dari state CAL.CLUTTER (diisi otomatis dari
    // shapefile saat data site dimuat), bukan dari dropdown — dropdown
    // rf_clutter sudah dihapus karena clutter bukan parameter yang
    // diatur pengguna.
    const clutter   = CAL.CLUTTER || 'n/a';
    const antHeight = parseFloat(get('rf_ant_height')) || CAL.ANT_HEIGHT || 30;
    const beamwidth = parseFloat(get('rf_beamwidth'))  || CAL_DEFAULT.BEAMWIDTH;
    const numSectors= parseInt(get('rf_num_sectors'))  || 3;
    const azimuths  = [];
    for (let i = 0; i < numSectors; i++) {
      const el = document.getElementById(`az_sec_${i}`);
      azimuths.push(el ? (parseFloat(el.value) || 0) : Math.round(i * (360 / numSectors)));
    }
    CAL.TX_POWER    = txPower;
    CAL.FREQUENCY   = freq;
    CAL.BANDWIDTH   = bwMhz * 1e6;
    CAL.ANT_HEIGHT  = antHeight;
    CAL.BEAMWIDTH   = beamwidth;
    CAL.NUM_SECTORS = numSectors;
    CAL.AZIMUTHS    = azimuths;
    return { txPower, freq, bwMhz, scenario, condition, clutter, antHeight, beamwidth, numSectors, azimuths };
  }

  // [v4.5] updateRFBadges() dikosongkan — badge ringkasan RF (Model, Clutter,
  // FreqBW, TxPower, AntHeight, Sectors) dihapus dari UI sesuai keputusan
  // bahwa Panel RF tidak lagi menampilkan info ringkas saat collapsed;
  // pengguna melihat nilai aktif lewat dropdown saat panel di-expand atau
  // lewat panel "PARAMETER AKTIF" yang sudah ada. Fungsi dipertahankan
  // sebagai no-op aman karena masih dipanggil dari beberapa event handler.
  function updateRFBadges() {
    // no-op
  }

  function initAzimuthInputs(numSectors, defaultAzimuths) {
    const container = document.getElementById('azimuthInputs');
    const labelRow  = document.getElementById('azimuthLabels');
    if (!container) return;
    container.innerHTML = '';
    if (labelRow) labelRow.innerHTML = '';
    for (let i = 0; i < numSectors; i++) {
      const defAz = defaultAzimuths?.[i] ?? Math.round(i * (360 / numSectors));
      const inp   = document.createElement('input');
      inp.type    = 'number';
      inp.id      = `az_sec_${i}`;
      inp.min     = '0'; inp.max = '359'; inp.step = '1';
      inp.value   = defAz;
      inp.title   = `Azimuth Sektor ${i + 1}`;
      inp.addEventListener('change', () => { updateRFBadges(); autoRecalcOnRFChange(); });
      container.appendChild(inp);
      if (labelRow) {
        const lbl       = document.createElement('span');
        lbl.textContent = `Sek-${i + 1}`;
        labelRow.appendChild(lbl);
      }
    }
  }

  function syncRFToInfoPanel(rfParams) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const modelLabel = `${rfParams.scenario.toUpperCase()} ${rfParams.condition.toUpperCase()}`;
    set('paramModel',      modelLabel);
    set('paramModelInfo',  modelLabel);
    set('paramClutter',    rfParams.clutter);
    set('paramFreq',       `${rfParams.freq} MHz`);
    set('paramBW',         `${rfParams.bwMhz} MHz`);
    set('paramTxPower',    `${rfParams.txPower} dBm`);
    set('paramHeight',     `${rfParams.antHeight} m`);
    set('infoHeight',      `${rfParams.antHeight} m`);
    set('paramNumSectors', `${rfParams.numSectors} sektor`);
    set('paramAzimuths',   rfParams.azimuths.map((a, i) => `S${i+1}:${a}°`).join(' | '));
  }

  function syncRFFromShapefile() {
    if (!driveTestData?.site) return;
    const s = driveTestData.site;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (!el || val == null) return;
      const valStr = String(val);
      for (const opt of el.options) {
        if (opt.value === valStr) { el.value = valStr; break; }
      }
    };
    if (s.scenario)  setVal('rf_scenario',  s.scenario);
    if (s.condition) setVal('rf_condition', s.condition);
    // [v4.5] Clutter disimpan ke state CAL.CLUTTER, bukan ke dropdown
    // (dropdown rf_clutter sudah dihapus — clutter murni hasil pembacaan
    // shapefile, bukan parameter yang diatur pengguna).
    CAL.CLUTTER = s.clutter
      ? s.clutter.toLowerCase().replace(/[\s-]+/g, '_')
      : 'n/a';
    const antH  = s.height || 30;
    const antEl = document.getElementById('rf_ant_height');
    if (antEl) antEl.value = antH;
    CAL.ANT_HEIGHT = antH;
    const sectorAzimuths = s.sectors || [];
    const numSectors     = sectorAzimuths.length || 3;
    setVal('rf_num_sectors', String(numSectors));
    CAL.NUM_SECTORS = numSectors;
    CAL.AZIMUTHS    = sectorAzimuths;
    initAzimuthInputs(numSectors, sectorAzimuths);
    updateRFBadges();
  }

  function rebuildSectorsFromRF(rfParams) {
    if (!driveTestData?.site) return;
    const s = driveTestData.site;
    const newServingSectors = [];
    for (let i = 0; i < rfParams.numSectors; i++) {
      const az      = rfParams.azimuths[i] ?? Math.round(i * (360 / rfParams.numSectors));
      const origSec = s.sectorData?.[i] || {};
      newServingSectors.push({
        siteId    : driveTestData.siteId,
        siteLat   : s.lat,
        siteLng   : s.lng,
        siteHeight: rfParams.antHeight,
        isMain    : true,
        nbIdx     : -1,
        sectorNum : i + 1,
        azimuth   : az,
        pci       : origSec.pci    ?? null,
        cellId    : origSec.cellId ?? null,
        cellName  : origSec.cellName ?? `${driveTestData.siteId}_Sek${i + 1}`,
        gnbId     : origSec.gnbId  ?? s.gnbId ?? null,
        arfcn     : origSec.arfcn  ?? 466850,
        pciColor  : MAIN_SECTOR_COLORS[i % MAIN_SECTOR_COLORS.length],
        scenario  : rfParams.scenario,
        condition : rfParams.condition,
        clutter   : rfParams.clutter,
      });
    }
    const nbSectors = allSectors.filter(sec => !sec.isMain);
    allSectors = [...newServingSectors, ...nbSectors];
    redrawSiteLayer();
    console.log(`[rebuildSectors] ${rfParams.numSectors} sek | az:[${rfParams.azimuths}] | h:${rfParams.antHeight}m`);
  }

  function redrawSiteLayer() {
    simSiteLayer.clearLayers();
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
        drawSectorFan(
          site.lat, site.lng, sec.azimuth, CAL.BEAMWIDTH,
          site.isMain ? 80 : 90, i,
          site.isMain ? 0.18 : 0.07,
          sec.pciColor
        );
      });
    });
  }

  function initRFPanel() {
    const btn  = document.getElementById('btnToggleRF');
    const body = document.getElementById('rfPanelBody');
    const icon = document.getElementById('rfToggleIcon');
    if (btn && body) {
      btn.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        if (icon) icon.textContent = open ? '▶ Ubah' : '▼ Tutup';
      });
    }
    [
      'rf_txpower','rf_frequency','rf_bandwidth',
      'rf_scenario','rf_condition',
      'rf_ant_height','rf_beamwidth',
    ].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => { updateRFBadges(); autoRecalcOnRFChange(); });
    });
    const numSecEl = document.getElementById('rf_num_sectors');
    if (numSecEl) {
      numSecEl.addEventListener('change', () => {
        const n    = parseInt(numSecEl.value) || 3;
        const defAz = Array.from({ length: n }, (_, i) => Math.round(i * (360 / n)));
        initAzimuthInputs(n, defAz);
        updateRFBadges();
        autoRecalcOnRFChange();
      });
    }
    updateRFBadges();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AUTO-RECALC
  // ══════════════════════════════════════════════════════════════════════════
  function setRecalcIndicator(status) {
    const el = document.getElementById('recalcIndicator');
    if (!el) return;
    if (status === 'calculating') {
      el.textContent = '🔄 Menghitung ulang...';
      el.className   = 'recalc-indicator recalc-running';
      el.style.display = 'inline-flex';
    } else if (status === 'done') {
      el.textContent = '✅ Diperbarui';
      el.className   = 'recalc-indicator recalc-done';
      el.style.display = 'inline-flex';
      setTimeout(() => { el.style.display = 'none'; }, 2000);
    } else {
      el.style.display = 'none';
    }
  }

  function autoRecalcOnRFChange() {
    const rfParamsNow = readRFPanel();
    rebuildSectorsFromRF(rfParamsNow);
    syncRFToInfoPanel(rfParamsNow);
    if (calcState === 'none' || !samplingPoints.length) return;
    clearTimeout(autoRecalcTimer);
    setRecalcIndicator('calculating');
    autoRecalcTimer = setTimeout(() => {
      try {
        if (calcState === 'sinr') {
          _doCalculateRSRP(true);
          _doCalculateSINR(true);
        } else {
          _doCalculateRSRP(true);
        }
        setRecalcIndicator('done');
      } catch (e) {
        console.error('[autoRecalc]', e);
        setRecalcIndicator('idle');
      }
    }, AUTO_RECALC_DEBOUNCE_MS);
  }

  window.applyRFManual = function () {
    const rfParams = readRFPanel();
    updateRFBadges();
    rebuildSectorsFromRF(rfParams);
    syncRFToInfoPanel(rfParams);
    if (calcState !== 'none' && samplingPoints.length) autoRecalcOnRFChange();
  };

  // ══════════════════════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('map-simulation')) return;
    loadDriveTestData();
    initCellPanelPills();
    initSimulationMap();
    setupEventListeners();
    initRFPanel();
  });

  function loadDriveTestData() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';
    try {
      const raw = sessionStorage.getItem('driveTestData');
      if (!raw) throw new Error('Tidak ada data rute.');
      driveTestData = JSON.parse(raw);
      if (!driveTestData.siteId)                    throw new Error('siteId tidak ditemukan');
      if (!driveTestData.site?.lat)                 throw new Error('Koordinat site tidak lengkap');
      if (!driveTestData.mainRoute?.coords?.length) throw new Error('Rute utama tidak ditemukan');
      buildAllSectors();
      populateSiteInfo();
      populateRouteData();
      syncRFFromShapefile();
      setTimeout(() => { if (overlay) overlay.style.display = 'none'; }, 800);
    } catch (e) {
      console.error('Error loading data:', e);
      if (overlay) overlay.innerHTML =
        `<div><div class="spinner"></div><h2 style="color:#e74c3c;">Error</h2><p>${e.message}</p></div>`;
      setTimeout(() => { window.location.href = '/route'; }, 3000);
    }
  }

  function buildAllSectors() {
    allSectors = [];
    const s = driveTestData.site;
    const servSectorData = s.sectorData || [];
    const servSectors = servSectorData.length > 0
      ? servSectorData
      : (s.sectors || []).map((az, i) => ({
          sectorNum: i + 1, azimuth: az, pci: null,
          cellId: null, cellName: `${driveTestData.siteId}_Sek${i + 1}`,
          gnbId: s.gnbId || null, arfcn: 466850,
        }));
    servSectors.forEach((sec, i) => {
      allSectors.push({
        siteId    : driveTestData.siteId,
        siteLat   : s.lat, siteLng: s.lng,
        siteHeight: s.height || 30,
        isMain    : true, nbIdx: -1,
        sectorNum : sec.sectorNum || (i + 1),
        azimuth   : sec.azimuth,
        pci       : sec.pci, cellId: sec.cellId,
        cellName  : sec.cellName || `${driveTestData.siteId}_Sek${sec.sectorNum || i + 1}`,
        gnbId     : sec.gnbId || s.gnbId || null,
        arfcn     : sec.arfcn || 466850,
        pciColor  : MAIN_SECTOR_COLORS[i % MAIN_SECTOR_COLORS.length],
        scenario  : s.scenario  || 'uma',
        condition : s.condition || 'nlos',
        clutter   : s.clutter   || 'N/A',
      });
    });
    (driveTestData.neighbours || []).forEach((nb, nbIdx) => {
      const nbSectors = (nb.sectorData || []).length > 0
        ? nb.sectorData
        : (nb.sectors || []).map((az, i) => ({
            sectorNum: i + 1, azimuth: az, pci: null,
            cellId: null, cellName: `${nb.siteId}_Sek${i + 1}`,
            gnbId: nb.gnbId || null, arfcn: 466850,
          }));
      nbSectors.forEach((sec, secIdx) => {
        const colorIdx = (nbIdx * 6 + secIdx) % NEIGHBOUR_PALETTE.length;
        allSectors.push({
          siteId    : nb.siteId,
          siteLat   : nb.lat, siteLng: nb.lng,
          siteHeight: nb.height || 30,
          isMain    : false, nbIdx,
          sectorNum : sec.sectorNum || (secIdx + 1),
          azimuth   : sec.azimuth,
          pci       : sec.pci, cellId: sec.cellId,
          cellName  : sec.cellName || `${nb.siteId}_Sek${sec.sectorNum || secIdx + 1}`,
          gnbId     : sec.gnbId || nb.gnbId || null,
          arfcn     : sec.arfcn || 466850,
          pciColor  : NEIGHBOUR_PALETTE[colorIdx],
          scenario  : nb.scenario  || 'uma',
          condition : nb.condition || 'nlos',
          clutter   : nb.clutter   || 'N/A',
        });
      });
    });
    console.log(`[buildAllSectors] ${allSectors.length} sektor`);
  }

  function populateSiteInfo() {
    const h   = driveTestData.site.height || 30;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('infoSiteId',   driveTestData.siteId);
    set('infoLat',      driveTestData.site.lat.toFixed(6));
    set('infoLng',      driveTestData.site.lng.toFixed(6));
    set('infoSectors',  driveTestData.site.sectors.length);
    set('infoHeight',   `${h} m`);
    set('paramHeight',  `${h} m`);
    set('paramFreq',    `${CAL.FREQUENCY} MHz`);
    set('paramBW',      `${CAL.BANDWIDTH / 1e6} MHz`);
    set('paramTxPower', `${CAL.TX_POWER} dBm`);
  }

  function populateRouteData() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('routeDistance', `${(driveTestData.mainRoute.distance / 1000).toFixed(2)} km`);
    set('routeTime',     `${Math.round(driveTestData.mainRoute.duration / 60)} menit`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MAP
  // ══════════════════════════════════════════════════════════════════════════
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
    redrawSiteLayer();
    const coords   = driveTestData.activeRouteData.coords.map(p => [p.lat, p.lng]);
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
      .addTo(simSiteLayer)
      .bindPopup(`<b>Sektor ${idx + 1}</b><br>Azimuth: ${az}°`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ══════════════════════════════════════════════════════════════════════════
  function setupEventListeners() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('btnBackToRoute',      () => window.location.href = '/route');
    on('btnGenerateSampling', generateSamplingPoints);
    on('btnCalculateRSRP',    calculateRSRP);
    on('btnCalculateSINR',    calculateSINR);
    on('btnSimulatePCI',      simulatePCI);
    on('btnExportCSV',        exportToCSV);
    on('btnClearSnapshot',    clearCurrentSnapshot);
  }

  window.setDisplayMode = function (mode) {
    displayMode = mode;
    document.getElementById('btnModeRSRP')?.classList.toggle('active', mode === 'rsrp');
    document.getElementById('btnModePCI')?.classList.toggle('active',  mode === 'pci');
    document.getElementById('rsrpLegend').style.display = mode === 'rsrp' ? 'block' : 'none';
    document.getElementById('pciLegend').style.display  = mode === 'pci'  ? 'block' : 'none';
    if (mode === 'pci') redrawPCIMode(); else redrawRSRPSINRMode();
  };

  // ══════════════════════════════════════════════════════════════════════════
  // [v4.5 FIX-1+2+3] GENERATE SAMPLING POINTS — DETERMINISTIK
  // ══════════════════════════════════════════════════════════════════════════
  function generateSamplingPoints() {
    if (!driveTestData?.mainRoute) return alert('Data rute tidak ditemukan!');

    simSamplingLayer.clearLayers();
    samplingPoints = [];
    calcState = 'none';
    clearTimeout(autoRecalcTimer);
    setRecalcIndicator('idle');

    const coords    = driveTestData.activeRouteData.coords;
    if (coords.length < 2) return alert('Rute terlalu pendek!');

    const routeHash = hashRoute(coords);
    const siteId    = driveTestData.siteId;

    // ── Prioritas 1: USE_JOURNAL_SNAPSHOT (untuk demo seminar) ────────────
    if (USE_JOURNAL_SNAPSHOT && JOURNAL_SNAPSHOT.length > 0) {
      samplingPoints = JOURNAL_SNAPSHOT.map(p => ({ lat: p.lat, lng: p.lng }));
      console.log(`[Sampling] 📖 Journal snapshot aktif: ${samplingPoints.length} titik`);
      _drawSamplingMarkers();
      _finalizeSampling('JOURNAL_SNAPSHOT (demo seminar)');
      return;
    }

    // ── Prioritas 2: Load dari localStorage snapshot ──────────────────────
    const cached = loadSnapshot(siteId, routeHash);
    if (cached) {
      samplingPoints = cached;
      _drawSamplingMarkers();
      _finalizeSampling(`snapshot tersimpan (seed: ${FIXED_SEED}, hash: ${routeHash})`);
      return;
    }

    // ── Prioritas 3: Generate baru dengan algoritma benar ─────────────────
    console.log(`[Sampling] ⚙ Generate baru | seed: ${FIXED_SEED} | hash: ${routeHash}`);
    samplingPoints = generateFixedIntervalPoints(coords, SAMPLING_INTERVAL_M);

    // Verifikasi jarak antar titik (debug)
    _verifySamplingInterval();

    // Simpan snapshot untuk sesi berikutnya
    saveSnapshot(siteId, routeHash, samplingPoints);

    _drawSamplingMarkers();
    _finalizeSampling(`baru (seed: ${FIXED_SEED}, hash: ${routeHash})`);
  }

  function _drawSamplingMarkers() {
    samplingPoints.forEach(p => {
      L.circleMarker([p.lat, p.lng], {
        radius: 3, fillColor: '#00ff00', color: '#000', weight: 1, fillOpacity: 0.8,
      }).addTo(simSamplingLayer);
    });
  }

  function _finalizeSampling(source) {
    const el = document.getElementById('samplingCount');
    if (el) el.textContent = samplingPoints.length;
    ['btnCalculateRSRP', 'btnCalculateSINR'].forEach(id => {
      const b = document.getElementById(id); if (b) b.disabled = false;
    });
    alert(
      `✅ ${samplingPoints.length} titik sampling\n` +
      `Interval: ${SAMPLING_INTERVAL_M} m (fixed)\n` +
      `Sumber: ${source}\n` +
      `Seed shadow fading: ${FIXED_SEED} (terkunci)`
    );
  }

  /** Verifikasi jarak antar titik sampling — cetak ke console */
  function _verifySamplingInterval() {
    if (samplingPoints.length < 2) return;
    let minD = Infinity, maxD = 0, sumD = 0;
    for (let i = 1; i < samplingPoints.length - 1; i++) {
      const d = haversineDistance(
        samplingPoints[i - 1].lat, samplingPoints[i - 1].lng,
        samplingPoints[i].lat,     samplingPoints[i].lng
      );
      minD = Math.min(minD, d);
      maxD = Math.max(maxD, d);
      sumD += d;
    }
    const avg = sumD / (samplingPoints.length - 2);
    console.log(
      `[SamplingVerify] n=${samplingPoints.length} | ` +
      `min=${minD.toFixed(2)}m | max=${maxD.toFixed(2)}m | avg=${avg.toFixed(2)}m`
    );
    if (maxD > SAMPLING_INTERVAL_M * 1.5) {
      console.warn(`[SamplingVerify] ⚠ Ada titik berjarak > ${SAMPLING_INTERVAL_M * 1.5}m!`);
    }
  }

  /** Hapus snapshot saat ini (untuk force re-generate) */
  function clearCurrentSnapshot() {
    if (!driveTestData) return;
    const coords    = driveTestData.activeRouteData.coords;
    const routeHash = hashRoute(coords);
    clearSnapshot(driveTestData.siteId, routeHash);
    alert('Snapshot dihapus. Klik "Generate Sampling" untuk membuat titik baru.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // KALKULASI RSRP
  // ══════════════════════════════════════════════════════════════════════════
  function calculateRSRP() {
    if (!samplingPoints.length) return alert('Generate titik sampling terlebih dahulu!');
    _doCalculateRSRP(false);
  }

  function _doCalculateRSRP(silent) {
    const rfParams = readRFPanel();
    syncRFToInfoPanel(rfParams);
    const overrideScenario  = rfParams.scenario;
    const overrideCondition = rfParams.condition;
    const overrideClutter   = rfParams.clutter;

    // [v4.5] Seed SELALU FIXED_SEED — tidak pernah berubah
    seedRng(FIXED_SEED);

    simHeatmapLayer.clearLayers();
    cellLineLayer.clearLayers();
    rsrpResults = [];

    const shadowKey  = `${overrideScenario}_${overrideCondition === 'los_nlos' ? 'nlos' : overrideCondition}`;
    const shadowStd  = SHADOW_STD[shadowKey] || 6.0;
    const modelLabel = `${overrideScenario.toUpperCase()} ${overrideCondition.toUpperCase()}`;

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
        const d        = Math.max(dist, 10);
        const brng     = bearingCalc(firstSec.siteLat, firstSec.siteLng, point.lat, point.lng);
        const { bestSec, bestGain } = pickBestSectorForPoint(brng, sectors);
        if (!bestSec) return;

        // [SYNC v19.3] Override berlaku ke SEMUA sektor (primary + neighbour),
        // bukan cuma primary. Override merepresentasikan kondisi environment
        // secara keseluruhan, bukan properti satu site — sebelumnya neighbour
        // tetap memakai scenario/condition asli sehingga kompetisi serving
        // cell tidak fair terhadap primary yang mendapat boost dari override.
        const sc   = (overrideScenario  || bestSec.scenario  || 'uma').toLowerCase();
        const cond = (overrideCondition || bestSec.condition || 'nlos').toLowerCase();
        const cl   = firstSec.isMain ? overrideClutter   : (bestSec.clutter   || 'N/A');
        const hBS  = firstSec.isMain ? CAL.ANT_HEIGHT    : bestSec.siteHeight;

        const pl      = pathLoss(sc, cond, d, CAL.FREQUENCY, hBS, CAL.MOBILE_H);
        const cLoss   = getClutterLoss(cl);
        const sKey    = `${sc}_${cond === 'los_nlos' ? 'nlos' : cond}`;
        const sStd    = SHADOW_STD[sKey] || 6.0;
        // [SYNC v19] Shadow fading noise sekarang berbasis lokasi spasial
        // (spatialNoise), bukan urutan loop (gaussianRandom lama). Ini
        // memastikan titik yang berdekatan secara fisik — termasuk titik
        // pada jalur masuk dan jalur balik di gang buntu — mendapat nilai
        // shadow fading yang konsisten/berkorelasi, sesuai sifat fisik
        // shadow fading yang sebenarnya.
        const xi      = spatialNoise(point.lat, point.lng, sStd);
        const rsrpRaw = CAL.TX_POWER + bestGain - pl - cLoss + xi;
        const rsrp    = applyRxFloor(rsrpRaw);

        cellResults.push({
          siteId, siteLat: firstSec.siteLat, siteLng: firstSec.siteLng,
          isMain    : firstSec.isMain,
          sectorNum : bestSec.sectorNum,
          azimuth   : bestSec.azimuth,
          pci       : bestSec.pci,
          cellId    : bestSec.cellId,
          cellName  : bestSec.cellName,
          gnbId     : bestSec.gnbId,
          pciColor  : bestSec.pciColor,
          arfcn     : bestSec.arfcn,
          dist, bearing: brng,
          antennaGain: bestGain,
          pathLoss: pl, clutterLoss: cLoss, shadowStd: sStd,
          rsrp, scenario: modelLabel, clutter: cl,
          category: null,
        });
      });

      if (!cellResults.length) return;

      // [SYNC] Serving cell = pure argmax(RSRP), disamakan dengan CSV.
      // HO_MARGIN dihapus dari logic seleksi serving — sebelumnya ada
      // hysteresis 3 dB yang tidak ada pada modul CSV.
      cellResults.sort((a, b) => b.rsrp - a.rsrp);
      const serving = cellResults[0];
      const sorted  = cellResults;

      sorted[0].category = 'serving';
      sorted.slice(1).forEach(c => {
        c.category = c.rsrp >= RSRP_DETECTED_THRESH ? 'detected' : 'listed';
      });

      const marker = L.circleMarker([point.lat, point.lng], {
        radius: 5, fillColor: rsrpColor(serving.rsrp), color: '#000', weight: 1, fillOpacity: 0.9,
      }).addTo(simHeatmapLayer);
      marker.on('click', () => onPointClick(point, idx + 1, sorted));

      rsrpResults.push({ index: idx + 1, lat: point.lat, lng: point.lng, cells: sorted, serving });
    });

    calcState = 'rsrp';
    document.getElementById('btnSimulatePCI').disabled = false;
    updateLegend('RSRP');
    showResultBox('RSRP');
    document.getElementById('btnExportCSV').disabled = false;

    if (!silent) {
      const avg    = (rsrpResults.reduce((s, r) => s + r.serving.rsrp, 0) / rsrpResults.length).toFixed(1);
      const pciSet = new Set(rsrpResults.map(r => r.serving.pci).filter(p => p !== null));
      alert(
        `Kalkulasi RSRP selesai — ${rsrpResults.length} titik\n` +
        `Model: ${modelLabel} [3GPP TR 38.901]\n` +
        `Shadow fading σ: ${shadowStd} dB [TR 38.901 Table 7.4.4]\n` +
        `Rx floor: ${RX_SENSITIVITY_FLOOR} dBm [TS 38.101-1]\n` +
        `Avg Serving RSRP: ${avg} dBm\n` +
        `Seed deterministik: ${FIXED_SEED}\n` +
        `TX Power: ${CAL.TX_POWER} dBm | Frekuensi: ${CAL.FREQUENCY} MHz\n` +
        `Antenna Height: ${CAL.ANT_HEIGHT} m | Beamwidth: ${CAL.BEAMWIDTH}°\n` +
        `PCI unik: ${pciSet.size}`
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // KALKULASI SINR
  // ══════════════════════════════════════════════════════════════════════════
  function calculateSINR() {
    if (!rsrpResults.length) return alert('Hitung RSRP terlebih dahulu!');
    _doCalculateSINR(false);
  }

  function _doCalculateSINR(silent) {
    if (!rsrpResults.length) return;

    // [v4.5] Seed SINR = FIXED_SEED + 1, selalu konsisten
    seedRng(FIXED_SEED + 1);
    const N_linear = getNEffLinear();

    rsrpResults.forEach((result, idx) => {
      const S_linear   = dbmToLinear(result.serving.rsrp);
      const thresholdDbm = result.serving.rsrp - DOMINANT_INTERFERER_THRESHOLD_DB;
      // [SYNC v19.1] Dominant interferer filter — hanya sel dengan
      // RSRP > serving_RSRP - 30 dB yang dihitung sebagai interferensi.
      let I_linear_all = 0;
      result.cells.forEach((c, ci) => {
        if (ci === 0) return;
        if (c.rsrp >= thresholdDbm) I_linear_all += dbmToLinear(c.rsrp);
      });
      // [SYNC v19.2] Clamp disamakan dengan CSV: [-3, 40] dB
      const sinr_s = Math.max(-3, Math.min(40, linearToDbm(S_linear / (I_linear_all + N_linear))));
      const rsrq   = estimateRSRQ(result.serving.rsrp, sinr_s);

      rsrpResults[idx].sinr             = sinr_s;
      rsrpResults[idx].rsrq             = rsrq;
      rsrpResults[idx].serving.sinr     = sinr_s;
      rsrpResults[idx].serving.rsrq     = rsrq;
      rsrpResults[idx].serving.category = 'serving';

      result.cells.forEach((c, ci) => {
        if (ci === 0) return;
        const S_nb = dbmToLinear(c.rsrp);
        const thresholdNb = c.rsrp - DOMINANT_INTERFERER_THRESHOLD_DB;
        let I_nb   = 0;
        result.cells.forEach((cc, cci) => {
          if (cci === 0 || cci === ci) return;
          if (cc.rsrp >= thresholdNb) I_nb += dbmToLinear(cc.rsrp);
        });
        const sinr_nb = Math.max(-3, Math.min(40, linearToDbm(S_nb / (I_nb + N_linear))));
        c.sinr     = sinr_nb;
        c.rsrq     = estimateRSRQ(c.rsrp, sinr_nb);
        c.category = getCellCategory(c.rsrp, c.sinr, false);
      });
    });

    calcState = 'sinr';
    simHeatmapLayer.clearLayers();
    cellLineLayer.clearLayers();

    rsrpResults.forEach((result, idx) => {
      const marker = L.circleMarker([result.lat, result.lng], {
        radius: 5, fillColor: sinrColor(result.sinr), color: '#000', weight: 1, fillOpacity: 0.9,
      }).addTo(simHeatmapLayer);
      marker.on('click', () => onPointClick(result, idx + 1, result.cells));
    });

    updateLegend('SINR');
    showResultBox('SINR');

    if (!silent) {
      const total   = rsrpResults.length;
      const avgSINR = (rsrpResults.reduce((s, r) => s + r.sinr, 0) / total).toFixed(1);
      const p20 = ((rsrpResults.filter(r => r.sinr >= 20).length / total) * 100).toFixed(1);
      const p10 = ((rsrpResults.filter(r => r.sinr >= 10 && r.sinr < 20).length / total) * 100).toFixed(1);
      const p0  = ((rsrpResults.filter(r => r.sinr >= 0  && r.sinr < 10).length / total) * 100).toFixed(1);
      alert(
        `Kalkulasi SINR selesai` +
        `Formula serving  : SINR = S / (I + N + I_IM)\n` +
        `Formula neighbour: SINR_nb = S_nb / (I_partial + N_eff)\n` +
        `Thermal noise N: ${getThermalNoise().toFixed(1)} dBm\n` +
        `Interference margin: ${INTERFERENCE_MARGIN_DB} dB\n` +
        `Seed deterministik: ${FIXED_SEED}\n` +
        `Avg SINR: ${avgSINR} dB\n\n` +
        `≥20 dB: ${p20}% | 10~20 dB: ${p10}% | 0~10 dB: ${p0}%`
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PCI MODE
  // ══════════════════════════════════════════════════════════════════════════
  function simulatePCI() {
    if (!rsrpResults.length) return alert('Hitung RSRP terlebih dahulu!');
    setDisplayMode('pci');
  }

  function redrawPCIMode() {
    if (!rsrpResults.length) return;
    simHeatmapLayer.clearLayers();
    cellLineLayer.clearLayers();
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
    updatePCILegend(pciDist);
    showResultBox('PCI');
  }

  function redrawRSRPSINRMode() {
    if (!rsrpResults.length) return;
    simHeatmapLayer.clearLayers();
    cellLineLayer.clearLayers();
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

  // ══════════════════════════════════════════════════════════════════════════
  // TABEL SEL
  // ══════════════════════════════════════════════════════════════════════════
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
          `<b>${i === 0 ? '⭐ Serving' : c.category === 'listed' ? '📋 Listed' : '🔍 Detected'}: ${c.siteId}</b><br>` +
          `Sek${c.sectorNum} | ${c.dist.toFixed(0)} m | RSRP: ${c.rsrp.toFixed(1)} | PCI: ${c.pci ?? 'N/A'}`,
          { sticky: true }
        );
    });
    updateCellTable(point, ptIdx, cells);
  }

  function initCellPanelPills() {
    const pills = document.getElementById('cellLegendPills'); if (!pills) return;
    const labels = ['⭐ Serving', '🔍 Detected', '📋 Listed'];
    const colors = ['#00c050', '#1a6fff', '#888888'];
    pills.innerHTML = labels.map((l, i) =>
      `<span class="line-pill" style="background:${colors[i]}">${l}</span>`
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

      if (type === 'rsrp') {
        if (val >= -85) return '#0042a5';
        if (val >= -95) return '#00a955';
        if (val >= -105) return '#70ff66';
        if (val >= -120) return '#fffb00';
        if (val >= -140) return '#ff3333';
        return '#800000';
      }

      if (type === 'sinr') {
        if (val >= 20) return '#0042a5';
        if (val >= 10) return '#00a955';
        if (val >= 0) return '#70ff66';
        if (val >= -5) return '#fffb00';
        if (val >= -10) return '#ff3333';
        return '#800000';
      }

      return '#aaa';
    };
    const categoryStyle = {
      serving : { label: '⭐ Serving',  cls: 'cat-serving'  },
      detected: { label: '🔍 Detected', cls: 'cat-detected' },
      listed  : { label: '📋 Listed',   cls: 'cat-listed'   },
    };
    let rows = '';
    cells.forEach((c, i) => {
      const cat      = c.category || (i === 0 ? 'serving' : (c.rsrp >= RSRP_DETECTED_THRESH ? 'detected' : 'listed'));
      const catStyle = categoryStyle[cat] || categoryStyle.listed;
      const pciStr   = c.pci !== null && c.pci !== undefined ? c.pci : 'N/A';
      const sinrStr  = hasSINR && c.sinr != null ? c.sinr.toFixed(2) : '—';
      const cName    = c.cellName || `${c.siteId}_Sek${c.sectorNum}`;
      rows += `<tr class="row-${cat}">
        <td><span class="cell-type ${catStyle.cls}">${catStyle.label}</span></td>
        <td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c.pciColor||'#aaa'};margin-right:3px;vertical-align:middle;border:1px solid rgba(0,0,0,0.2)"></span>${pciStr}</td>
        <td>${c.arfcn || 466850}</td>
        <td><span class="dot" style="background:${dotColor(c.rsrp,'rsrp')}"></span>${c.rsrp.toFixed(2)}</td>
        <td><span class="dot" style="background:${dotColor(c.sinr,'sinr')}"></span>${sinrStr}</td>
        <td>${c.cellId ?? '—'}</td>
        <td title="${cName}">${cName.length > 28 ? cName.slice(0,28)+'…' : cName}</td>
        <td>${c.dist.toFixed(0)}</td>
      </tr>`;
    });
    wrapper.innerHTML = `
      <table class="cell-table">
        <thead><tr>
          <th>Category</th><th>PCI</th><th>ARFCN</th>
          <th>SS-RSRP(dBm)</th><th>SS-SINR(dB)</th>
          <th>Cell ID</th><th>Cell Name</th><th>Distance(m)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function updateLegend(type) {
    const legend = document.getElementById('rsrpLegend');
    const tbody  = document.getElementById('legendTableBody');
    const title  = document.getElementById('legendTitle');
    if (!legend || !tbody) return;
    if (title) title.textContent = type === 'RSRP' ? 'SS-RSRP (dBm)' : 'SS-SINR (dB)';
    const buckets = type === 'RSRP' ? [
      { label:'≥ -85',       color:'#0042a5', fn: v => v >= -85  },
      { label:'-95 ~ -85',   color:'#00a955', fn: v => v >= -95  && v < -85  },
      { label:'-105 ~ -95',  color:'#70ff66', fn: v => v >= -105 && v < -95  },
      { label:'-120 ~ -105', color:'#fffb00', fn: v => v >= -120 && v < -105 },
      { label:'-140 ~ -120', color:'#ff3333', fn: v => v >= -140 && v < -120 },
      { label:'< -140',      color:'#800000', fn: v => v <  -140             },
    ] : [
      { label:'≥ 20 dB',   color:'#0042a5', fn: v => v >= 20 },
      { label:'10~20 dB',  color:'#00a955', fn: v => v >= 10 && v < 20 },
      { label:'0~10 dB',   color:'#70ff66', fn: v => v >= 0  && v < 10 },
      { label:'-5~0 dB',   color:'#fffb00', fn: v => v >= -5 && v < 0  },
      { label:'-10~-5 dB', color:'#ff3333', fn: v => v >= -10 && v < -5 },
      { label:'< -10 dB',  color:'#800000', fn: v => v < -10 },
    ];
    const total = rsrpResults.length || 1;
    tbody.innerHTML = buckets.map(b => {
      const cnt = rsrpResults.filter(r =>
        b.fn(parseFloat((type === 'RSRP' ? r.serving?.rsrp : r.sinr) ?? 0))
      ).length;
      return `<tr>
        <td><div style="width:14px;height:14px;background:${b.color};border-radius:3px;border:1px solid #ccc;display:inline-block;"></div></td>
        <td>${b.label}</td>
        <td><b>${((cnt / total) * 100).toFixed(1)}%</b></td>
      </tr>`;
    }).join('');
    legend.style.display = 'block';
    document.getElementById('pciLegend').style.display = 'none';
  }

  function showResultBox(type) {
    const box = document.getElementById('resultBox'); if (!box) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    if (type === 'RSRP') {
      set('resultTitle',   'Kalkulasi SS-RSRP Selesai');
      set('resultStats',   `${rsrpResults.length} titik | Seed: ${FIXED_SEED} | 3GPP TR 38.901`);
      set('resultMessage', 'Klik titik di peta → detail sel & garis ke site');
    } else if (type === 'SINR') {
      set('resultTitle',   'Kalkulasi SS-SINR Selesai');
      set('resultStats',   `${rsrpResults.length} titik | SINR = S/(I+N+I_IM) [TR 36.942]`);
      set('resultMessage', `Thermal: ${getThermalNoise().toFixed(1)} dBm | IM: ${INTERFERENCE_MARGIN_DB} dB`);
    } else {
      set('resultTitle',   'Simulasi PCI Aktif');
      const ps = new Set(rsrpResults.map(r => r.serving.pci).filter(p => p !== null));
      set('resultStats',   `${ps.size} PCI unik — dari shapefile`);
      set('resultMessage', 'Warna per sektor, azimuth-based coverage');
    }
    box.style.display = 'block';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXPORT CSV
  // ══════════════════════════════════════════════════════════════════════════
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
             `${s.rsrp.toFixed(1)},${s.rsrq!=null?s.rsrq.toFixed(1):''},` +
             `${s.pci??''},${s.arfcn||466850},${s.gnbId||''},${s.cellId||''},"${cName}"`;
      if (hasSINR) csv += `,${r.sinr.toFixed(1)}`;
      csv += '\n';
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const ts   = new Date().toISOString().slice(0,19).replace(/:/g,'-');
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `Simulasi DT by Route_${driveTestData.siteId}_${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [v4.5] HELPER UNTUK RECOVERY DATA JURNAL
  //
  // Jalankan getJournalSnapshot() di console browser setelah simulasi berjalan.
  // Copy hasilnya → paste ke konstanta JOURNAL_SNAPSHOT di atas.
  // Set USE_JOURNAL_SNAPSHOT = true untuk demo seminar.
  // ══════════════════════════════════════════════════════════════════════════
  window.getJournalSnapshot = function () {
    if (!samplingPoints.length) {
      console.warn('Belum ada titik sampling. Generate dulu!');
      return null;
    }
    const snapshot = JSON.stringify(samplingPoints, null, 2);
    console.log('=== JOURNAL SNAPSHOT — copy semua ini ke JOURNAL_SNAPSHOT ===');
    console.log(snapshot);
    console.log(`=== Total: ${samplingPoints.length} titik | Seed: ${FIXED_SEED} ===`);
    return samplingPoints;
  };

  window.getSimulationSummary = function () {
    if (!rsrpResults.length) { console.warn('Belum ada hasil RSRP.'); return; }
    const total   = rsrpResults.length;
    const hasSINR = rsrpResults[0]?.sinr !== undefined;
    console.log(`=== SIMULATION SUMMARY v4.5 | Seed: ${FIXED_SEED} ===`);
    console.log(`Total titik: ${total}`);
    const avgRSRP = (rsrpResults.reduce((s,r) => s + r.serving.rsrp, 0) / total).toFixed(2);
    console.log(`Avg RSRP: ${avgRSRP} dBm`);
    if (hasSINR) {
      const avgSINR = (rsrpResults.reduce((s,r) => s + r.sinr, 0) / total).toFixed(2);
      console.log(`Avg SS-SINR: ${avgSINR} dB`);
    }
    // Distribusi RSRP
    const rsrpBuckets = [
      { label:'≥ -85',       fn: v => v >= -85  },
      { label:'-95 ~ -85',   fn: v => v >= -95  && v < -85  },
      { label:'-105 ~ -95',  fn: v => v >= -105 && v < -95  },
      { label:'-120 ~ -105', fn: v => v >= -120 && v < -105 },
      { label:'< -120',      fn: v => v < -120              },
    ];
    console.log('--- Distribusi RSRP ---');
    rsrpBuckets.forEach(b => {
      const cnt = rsrpResults.filter(r => b.fn(r.serving.rsrp)).length;
      console.log(`  ${b.label}: ${cnt} (${((cnt/total)*100).toFixed(1)}%)`);
    });
    if (hasSINR) {
      console.log('--- Distribusi SINR ---');
      [
        { label:'≥ 20 dB',   fn: v => v >= 20 },
        { label:'10~20 dB',  fn: v => v >= 10 && v < 20 },
        { label:'0~10 dB',   fn: v => v >= 0  && v < 10 },
        { label:'-5~0 dB',   fn: v => v >= -5 && v < 0  },
        { label:'< -5 dB',   fn: v => v < -5  },
      ].forEach(b => {
        const cnt = rsrpResults.filter(r => b.fn(r.sinr)).length;
        console.log(`  ${b.label}: ${cnt} (${((cnt/total)*100).toFixed(1)}%)`);
      });
    }
    // Cek titik spesifik
    console.log('--- Titik 645 ---');
    const pt645 = rsrpResults.find(r => r.index === 645);
    if (pt645) {
      console.log(`  Lat: ${pt645.lat.toFixed(5)}, Lng: ${pt645.lng.toFixed(5)}`);
      console.log(`  Serving: ${pt645.serving.cellName} | RSRP: ${pt645.serving.rsrp.toFixed(2)} | SINR: ${hasSINR ? pt645.serving.sinr?.toFixed(2) : '—'}`);
    } else {
      console.log('  Titik 645 tidak ditemukan');
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS GEO
  // ══════════════════════════════════════════════════════════════════════════
  function haversineDistance(lat1, lng1, lat2, lng2) {
    const R    = 6378137;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat/2)**2
               + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function bearingCalc(lat1, lng1, lat2, lng2) {
    const p1 = lat1*Math.PI/180, p2 = lat2*Math.PI/180;
    const dl  = (lng2-lng1)*Math.PI/180;
    return (Math.atan2(
      Math.sin(dl)*Math.cos(p2),
      Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl)
    ) * 180/Math.PI + 360) % 360;
  }

  function destPoint(lat, lng, az, dist) {
    const R    = 6378137, brng = az*Math.PI/180, d = dist/R;
    const lat1 = lat*Math.PI/180, lng1 = lng*Math.PI/180;
    const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(brng));
    const lng2 = lng1 + Math.atan2(Math.sin(brng)*Math.sin(d)*Math.cos(lat1), Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
    return { lat: lat2*180/Math.PI, lng: lng2*180/Math.PI };
  }

  function rsrpColor(v) {
    if (v >= -85)  return '#0042a5';
    if (v >= -95)  return '#00a955';
    if (v >= -105) return '#70ff66';
    if (v >= -120) return '#fffb00';
    if (v >= -140) return '#ff3333';
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

  // ── Export ke window ──────────────────────────────────────────────────────
  window.generateSamplingPoints = generateSamplingPoints;
  window.calculateRSRP          = calculateRSRP;
  window.calculateSINR          = calculateSINR;
  window.simulatePCI            = simulatePCI;
  window.exportToCSV            = exportToCSV;

})();

console.log(
  'simulation.js v4.5 — DETERMINISTIK EDITION\n' +
  '  ✅ Fixed seed: 20250101\n' +
  '  ✅ Sampling snapshot: localStorage per siteId+routeHash\n' +
  '  ✅ Interval 10m: cumulative-distance walker (binary search)\n' +
  '  ✅ Journal recovery: set USE_JOURNAL_SNAPSHOT = true untuk seminar\n' +
  '  ✅ Helper: getJournalSnapshot() & getSimulationSummary() di console'
);