// ================= SIMULATION DT v21.0 — PARAMETER UPDATE =================
//
// PERUBAHAN v20.1 → v21.0 (PARAMETER RF):
//
//   [RF-1] Tambah ANTENNA_GAIN = 8 dBi
//          Referensi: 3GPP TR 38.901 Table 7.3-1
//          "Maximum directional gain of an antenna element G_E,max = 8 dBi"
//          Sebelumnya tidak dimodelkan → menyebabkan under-estimate EIRP
//
//   [RF-2] Tambah CABLE_LOSS = 0.5 dB
//          Referensi: Link budget NR 2300 MHz (JURITEK 2025, paper dosen PNJ)
//          Merepresentasikan loss pada jalur transmisi internal AAU
//          Meskipun AAU aktif meminimalkan feeder loss, nilai 0.5 dB
//          dipertahankan sebagai margin konservatif
//
//   [RF-3] ANTENNA_Am diubah dari 25 dB → 30 dB
//          Referensi: 3GPP TR 38.901 Table 7.3-1
//          "A_max = 30 dB" untuk horizontal cut radiation power pattern
//          Nilai 25 dB sebelumnya tidak memiliki referensi standar eksplisit
//
//   [RF-4] D_COR per skenario (grid size spatial noise)
//          Referensi: 3GPP TR 38.901 Table 7.5-6
//          Sebelumnya fixed 0.0005° (≈55m) untuk semua skenario
//          Sekarang mengikuti decorrelation distance per skenario:
//            UMa LOS  : 37m  → 0.000332°
//            UMa NLOS : 50m  → 0.000449°
//            UMi LOS  : 10m  → 0.0000898°
//            UMi NLOS : 13m  → 0.000117°
//            RMa LOS  : 37m  → 0.000332°
//            RMa NLOS : 120m → 0.001078°
//
//   [RF-5] Formula RSRP diperbarui:
//          RSRP = TX + G_E,max - CableLoss + G_h(θ) - PL - Lc + ξ
//               = 46  + 8      - 0.5       + G_h(θ) - PL - Lc + ξ
//          Net EIRP correction: +7.5 dB dari kondisi sebelumnya
//
// ===========================================================================
//
// PATCH v22.0 — KALIBRASI MULTI-SKENARIO (UMa & UMi terpisah) + BUGFIX
//
//   [CAL-1] Kalibrasi sekarang dipecah per skenario (UMa & UMi dihitung
//           terpisah, masing-masing pakai titik DT aktual miliknya sendiri).
//           Sebelumnya satu koefisien tunggal dipakai untuk SEMUA titik,
//           padahal PL UMa & UMi punya karakteristik jarak/tinggi berbeda.
//   [CAL-2] Fix ReferenceError: variabel `calibCoef` dipakai tanpa deklarasi
//           di bawah 'use strict' → kalibrasi selalu crash saat tombol
//           diklik. Sekarang pakai calibCoefUMa / calibCoefUMi yang sudah
//           dideklarasikan di state.
//   [CAL-3] Tombol "Kalibrasi Model" tidak pernah ke-enable karena
//           runSimulation() tidak memanggil enableBtn('btnKalibrasi').
//   [CAL-4] exportCSVWithKalib() tidak pernah terpasang ke tombol manapun
//           (listener memanggil exportCSV yang tidak pernah didefinisikan
//           → addEventListener diam-diam no-op). Sekarang disatukan
//           menjadi exportCSV().
//   [CAL-5] Titik dengan skenario yang TIDAK berhasil dikalibrasi (data
//           kurang dari minimum) tetap ditampilkan dengan nilai simulasi
//           asli (fallback), bukan crash / NaN.
//
// ===========================================================================
//
// PATCH v23.0–v29.0 — TRAIN-VAL SPLIT + DROP KOLINEAR log(fc) & log(hBS) + SINR RECOMPUTED
//
//   [FIX-1] Model kalibrasi TIDAK LAGI menyertakan term K·log10(fc).
//           Alasan: frekuensi (CAL.FREQUENCY) konstan untuk SEMUA titik DT
//           dalam satu sesi kalibrasi (operator sama, band sama), sehingga
//           log10(fc) adalah kolom konstan di matriks regresi → collinear
//           sempurna dengan intercept (K1). Akibatnya sebelum fix ini,
//           K1 dan K3(coef fc) tidak identifiable secara terpisah (nilai
//           keduanya arbitrer tergantung urutan numerik solver, walau
//           PREDIKSI akhir tetap benar karena K1+K3·log(fc) konsisten
//           dipakai). Referensi: paper acuan (Popoola et al. 2017) Eq.31-32
//           juga TIDAK menyertakan term frekuensi pada model tuned SPM
//           final, dengan alasan yang identik (studi single-frequency).
//           Model sekarang: PL = K1 + K2·log10(d3D)
//           (3 parameter, bukan 4 — K3 sekarang berarti koefisien hBS,
//           BUKAN koefisien fc seperti sebelumnya. Penomoran digeser).
//           Frekuensi (2300 MHz) TETAP dipertahankan sebagai parameter
//           tetap di seluruh sistem (path loss 3GPP, link budget, noise
//           floor, dsb) — yang dihapus HANYA perannya sebagai variabel
//           bebas di regresi kalibrasi, bukan dari model RF secara umum.
//
//   [FIX-3] SINR KALIBRASI TIDAK LAGI PAKAI HEURISTIK "delta_rsrp × 0,3".
//           Faktor 0,3 sebelumnya tidak punya dasar fisik/referensi apapun
//           — murni tebakan. SINR adalah besaran TURUNAN (S/I), bukan
//           besaran yang punya model empiris sendiri untuk di-tuning:
//               SINR = RSRP_serving / (Noise + Σ RSRP_interferer)
//           Karena override skenario (dropdown) berlaku GLOBAL ke seluruh
//           sektor (primary maupun neighbour — lihat getSectorScenario()),
//           serving cell dan seluruh interferer pada satu titik pengujian
//           SELALU berada di skenario yang sama saat override aktif.
//           Sekarang: RSRP setiap entry di r.cells (serving + interferer,
//           masing-masing sudah "best-sector-per-site" hasil collapse di
//           SINR-1) dikalibrasi ulang satu per satu pakai pathLossCalibrated,
//           lalu computeSINR() DIPANGGIL ULANG dari definisi aslinya dengan
//           RSRP-RSRP yang sudah dikalibrasi itu sebagai input. Tidak ada
//           lagi faktor skala sembarang — SINR kalibrasi sekarang konsisten
//           secara matematis dengan cara SINR simulasi awal dihitung.
//
//   [FIX-4] TERM log(hBS) DIKELUARKAN JUGA dari regresi kalibrasi (model
//           sekarang: PL = K1 + K2·log10(d3D) — 2 parameter, bukan 3).
//           Alasan: tinggi BTS (hBS) adalah properti PER SITE, bukan per
//           titik. Karena mayoritas titik pengujian serving ke SATU site
//           yang sama (primary site — biasanya >50-80% titik), nilai hBS
//           di data training PRAKTIS NYARIS KONSTAN (didominasi satu
//           angka), dengan variasi cuma datang dari sedikit titik yang
//           serving ke neighbour. Sama seperti kasus log(fc) di [FIX-1],
//           ini membuat koefisien K3 (dulu untuk hBS) tidak identifiable
//           secara andal — dibuktikan empiris: K3 melompat dari -3,51 di
//           satu site ke +55,44 di site lain dengan clutter yang SAMA,
//           bahkan berbalik tanda. Efeknya PALING terasa merusak SS-SINR
//           (bukan SS-RSRP), karena SINR butuh RSRP interferer dari
//           neighbour site yang tingginya BEDA dari primary — begitu K3
//           yang goyah itu dikalikan ke hBS neighbour (nilai yang jarang
//           "dikenal" model), koreksi PL yang dihasilkan meledak dan
//           tidak proporsional, merusak keseimbangan S/I.
//           Efek tinggi BTS TIDAK hilang dari sistem — tetap tertangani
//           lewat geometri d3D = √(jarak² + (hBS-hUT)²) yang tetap dipakai
//           di pathLossCalibrated(), dan lewat model dasar 3GPP (yang
//           sudah memodelkan hBS lewat breakpoint distance & d3D). Yang
//           dihapus HANYA koefisien tambahan yang mencoba mengoreksi
//           ULANG efek hBS dari data lokal yang variasinya tidak cukup.
//
//   [FIX-2] Kalibrasi sekarang memakai TRAIN/VALIDATION SPLIT (70:30),
//           bukan in-sample fitting. Sebelumnya, koefisien K1..K4 di-fit
//           dari SEMUA titik aktual (setelah filter outlier), lalu RMSE
//           "after kalibrasi" dihitung dari titik YANG SAMA — ini in-sample
//           error, secara matematis dijamin turun oleh least-squares dan
//           TIDAK membuktikan generalisasi model ke titik baru. Sekarang:
//             1. Titik per skenario displit train (70%) / val (30%) dengan
//                seed tetap (reproducible, deterministic shuffle).
//             2. Fitting koefisien HANYA dari train set (lihat [FIX-4]:
//                model final 2 parameter, K1 & K2 saja).
//             3. RMSE/ME/SD "before" DAN "after" untuk panel kalibrasi
//                DIHITUNG DARI VALIDATION SET SAJA — supaya perbandingan
//                before-after adil (bukan before=semua titik, after=in-
//                sample titik training).
//           Koefisien hasil fit tetap diterapkan ke SEMUA titik simulasi
//           untuk keperluan visualisasi peta (before/after toggle) dan
//           export CSV — split train/val HANYA memengaruhi bagaimana
//           metrik evaluasi di panel kalibrasi dihitung, bukan cakupan
//           titik yang menerima koreksi kalibrasi.
//
// ===========================================================================
//
// PATCH v30.0 — SATU PARTISI TRAIN/VAL (RSRP+SINR) + FIX N BEFORE≠AFTER + EXPORT SPLIT
//
//   [SPLIT-1] Train/val split RSRP dan SINR SEKARANG SATU PARTISI per
//             skenario (seed tunggal), bukan dua seed independen (1 vs 101)
//             seperti versi sebelumnya. Alasan akademik: satu titik drive
//             test adalah SATU event pengukuran — RSRP dan SINR diukur
//             bersamaan, di titik dan waktu yang sama — jadi status
//             train/val-nya harus konsisten untuk kedua metrik. Memakai
//             seed berbeda per metrik membuka pertanyaan "kenapa validation
//             set RSRP dan SINR beda titik?" yang sulit dijustifikasi ke
//             penguji walau jawabannya jujur (seed acak beda). Populasi yang
//             displit per skenario = semua titik yang punya RSRP_aktual
//             dan/atau SINR_aktual; assignment train/val itu lalu dipakai
//             bersama oleh calibrateScenario() (RSRP) dan
//             calibrateScenarioSINR() (SINR).
//
//   [SPLIT-2] Kolom baru di export CSV: Split_Kalibrasi (train/val/n_a).
//             n_a = titik yang tidak ikut proses kalibrasi sama sekali
//             (skenario selain UMa/UMi, atau tidak punya data aktual).
//             Kolom ini dibaca oleh halaman Evaluasi (multisite) supaya
//             bisa menghitung metrik "Model Murni" (N total, semua baris)
//             terpisah dari "Evaluasi Kalibrasi" (N eval, cuma baris
//             Split_Kalibrasi='val') — dua klaim berbeda yang sebelumnya
//             tidak bisa dibedakan dari CSV export.
//
//   [SPLIT-3] FIX bug di buildMetricPair(): sebelumnya RMSE "before"
//             dihitung dari SEMUA titik validation (valWithKalib), sementara
//             RMSE "after" dihitung dari subset yang sudah difilter guard
//             rail ekstrapolasi jarak (afterRows) — kalau ada titik val di
//             luar rentang jarak training, n before dan n after diam-diam
//             beda walau tabel cuma menampilkan SATU angka N. Sekarang:
//             filter DULU ke titik yang benar-benar menerima kalibrasi,
//             baru hitung before DAN after dari subset yang identik —
//             menjamin before-after benar-benar apple-to-apple.
//
// ===========================================================================

(function () {
  'use strict';

  if (!document.getElementById('map-dt-sim')) return;

  // ── State ─────────────────────────────────────────────────────────────────
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

  // [CAL-1] Kalibrasi per-skenario — dua slot terpisah, bukan satu global
  let calibDone    = false;
  let calibCoefUMa = null;   // { K1, K2, nTrain, nVal, nTotal } untuk UMa (path loss/RSRP)
  let calibCoefUMi = null;   // { K1, K2, nTrain, nVal, nTotal } untuk UMi (path loss/RSRP)
  // [FIX-7] Koefisien kalibrasi SINR LANGSUNG (bukan turunan dari RSRP
  // interferer) — di-fit langsung terhadap sinr_actual, karena alat ukur
  // drive test modern (chipset LTE/5G) memang mengukur SINR secara langsung
  // di tiap titik (bukan cuma RSRP serving seperti asumsi metode drive test
  // lama/single-BCCH-lock). Lihat header patch [FIX-7] untuk detail.
  let calibCoefSinrUMa = null;
  let calibCoefSinrUMi = null;
  let calibResults = [];     // simResults setelah kalibrasi (semua titik)
  // [CAL-6] Mode visualisasi peta: 'before' (simResults, hasil simulasi murni)
  // atau 'after' (calibResults, hasil setelah PL dikalibrasi). Toggle ini
  // TIDAK memicu re-simulasi — hanya menukar field mana yang digambar,
  // karena serving cell & geometri titik tidak berubah oleh kalibrasi.
  let calibViewMode = 'before';

  const SESSION_KEY    = 'siteIndexData';
  const MAX_NEIGHBOURS = 6;
  const FIXED_SEED     = 20250101;

  const DOMINANT_INTERFERER_THRESHOLD_DB = 30;
  const MIN_CALIB_POINTS = 10;   // minimum titik aktual per skenario sebelum dianggap valid
  const MIN_CALIB_AFTER_FILTER = 8;
  // [FIX-2] proporsi split train/val & minimum ukuran tiap subset supaya
  // evaluasi tidak dilakukan pada validation set yang terlalu kecil.
  const CALIB_TRAIN_RATIO = 0.7;
  const MIN_VAL_POINTS    = 5;
  // [FIX-5] Margin toleransi di luar rentang jarak training sebelum sebuah
  // cell dianggap "ekstrapolasi" dan di-fallback ke RSRP simulasi asli
  // (bukan hasil regresi kalibrasi). 0.2 = boleh melebar 20% dari batas
  // min/max jarak training sebelum guard rail aktif — mengurangi artefak
  // "cutoff kaku" tepat di ujung rentang, tanpa membuka ekstrapolasi jauh.
  const EXTRAP_MARGIN = 0.2;
  // [FIX-6] Batas bawah K2 (koefisien log(d3D)) yang dianggap masuk akal
  // secara fisik. Path loss HARUS naik seiring jarak — K2 negatif berarti
  // sinyal makin kuat makin jauh (kebalikan hukum fisika), dan K2 mendekati
  // 0 berarti model menganggap jarak nyaris tidak berpengaruh (juga tidak
  // masuk akal). 2.0 dipilih sebagai ambang longgar (jauh di bawah nilai
  // teoritis 3GPP ~20-40) — sekadar penyaring kasus yang jelas-jelas rusak,
  // bukan filter ketat yang menolak variasi alami antar lingkungan.
  const MIN_PLAUSIBLE_K2 = 2.0;
  // [FIX-7] Untuk model SINR LANGSUNG (target = sinr_actual, bukan PL):
  // SINR wajar MENURUN seiring jarak dari serving cell bertambah (makin
  // jauh dari BTS, makin dekat ke cell-edge, makin banyak sel tetangga
  // yang sinyalnya sebanding → makin banyak interferensi). Jadi K2_sinr
  // harus NEGATIF dan cukup besar magnitudonya. -0.5 dipilih sebagai
  // ambang longgar (SINR biasa turun beberapa dB per dekade jarak).
  const MAX_PLAUSIBLE_K2_SINR = -0.5;

  const MAIN_SECTOR_COLORS = ['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#42d4f4'];
  const NEIGHBOUR_PALETTE  = [
    '#f032e6','#bfef45','#469990','#dcbeff','#9a6324','#800000',
    '#aaffc3','#808000', '#ffd8b1', '#fffac8', '#000075', '#a9a9a9',
    '#00ffff','#ff00ff', '#ffff00','#ff1493','#00fa9a',
    '#daa520', '#ff8c00', '#9370db', '#20b2aa','#00ced1','#ba55d3', '#adff2f','#ff69b4'
  ];
  const LINE_COLORS   = ['#00c050','#1a6fff','#ff8800','#ffd000','#ff3333','#888888'];
  const SECTOR_COLORS = ['#ff2d55','#00c7be','#ffcc00','#af52de','#ff9500','#34c759'];

  // ═════════════════════════════════════════════════════════════════════════
  // KONSTANTA RF — v21.0
  // ═════════════════════════════════════════════════════════════════════════
  const CAL = {
    TX_POWER     : 46,
    ANTENNA_GAIN : 8,
    CABLE_LOSS   : 0.5,
    FREQUENCY    : 2300,
    BANDWIDTH    : 30e6,
    MOBILE_H     : 1.5,
    ANTENNA_Am   : 30,
    BEAMWIDTH    : 65,
    NF           : 7,
  };

  const D_COR_DEG = {
    uma_los  : 37  / 111320,
    uma_nlos : 50  / 111320,
    uma_mixed: 50  / 111320,
    umi_los  : 10  / 111320,
    umi_nlos : 13  / 111320,
    umi_mixed: 13  / 111320,
    rma_los  : 37  / 111320,
    rma_nlos : 120 / 111320,
    rma_mixed: 120 / 111320,
  };
  const D_COR_DEFAULT = 50 / 111320;

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

  // ── Override accessor ─────────────────────────────────────────────────────
  function getSectorScenario(sec) {
    if (propagasiOverride.scenario) return propagasiOverride.scenario;
    return (sec.scenario || 'uma').toLowerCase();
  }
  function getSectorCondition(sec) {
    const raw = propagasiOverride.condition || (sec.condition || 'nlos');
    const cnd = raw.toLowerCase();
    return cnd === 'los_nlos' ? 'mixed' : cnd;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SPATIAL NOISE — v21.0 dengan D_COR per skenario [RF-4]
  // ═════════════════════════════════════════════════════════════════════════
  function hashInt(n) {
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    return ((n >>> 16) ^ n) >>> 0;
  }

  function spatialNoise(lat, lng, std, scenKey) {
    const gridSize = D_COR_DEG[scenKey] || D_COR_DEFAULT;

    const cLat = Math.round(lat / gridSize);
    const cLng = Math.round(lng / gridSize);
    const s1   = hashInt(cLat * 73856093 ^ cLng * 19349663 ^ (FIXED_SEED >>> 0));
    const s2   = hashInt(s1 + 2654435761);
    const u1   = (s1 >>> 0) / 4294967296 + 1e-10;
    const u2   = (s2 >>> 0) / 4294967296 + 1e-10;
    const raw  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std;

    return Math.max(-2 * std, Math.min(2 * std, raw));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const mean  = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const rmseF = arr => Math.sqrt(arr.reduce((s, d) => s + d * d, 0) / arr.length);
  const sdF   = arr => { const m = mean(arr); return Math.sqrt(arr.reduce((s, d) => s + (d - m) ** 2, 0) / arr.length); };

  function dbmToLinear(dbm) { return Math.pow(10, dbm / 10); }
  function linearToDbm(mw)  { return 10 * Math.log10(Math.max(mw, 1e-15)); }
  function applyRxFloor(v)  { return Math.max(RX_SENSITIVITY_FLOOR, v); }

  // [FIX-2] Deterministic pseudo-random shuffle untuk train/val split.
  // Memakai hashInt yang sama dengan spatialNoise supaya split reproducible
  // (seed tetap) tanpa bergantung pada Math.random().
  function seededShuffleIndices(n, seedOffset) {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const h = hashInt((i + 1) * 2654435761 ^ (seedOffset + FIXED_SEED));
      const j = h % (i + 1);
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx;
  }

  // [FIX-2] Split array jadi { train, val } dengan rasio tetap, deterministic.
  function trainValSplit(arr, seedOffset) {
    const order = seededShuffleIndices(arr.length, seedOffset);
    const nTrain = Math.round(arr.length * CALIB_TRAIN_RATIO);
    const trainIdx = new Set(order.slice(0, nTrain));
    const train = [], val = [];
    arr.forEach((item, i) => (trainIdx.has(i) ? train : val).push(item));
    return { train, val };
  }

  // ── [CAL-6] Before/After dataset helpers ────────────────────────────────
  // isAfterActive() = true kalau kalibrasi sudah jalan DAN user memilih
  // toggle "After Kalibrasi". calibResults berisi SEMUA titik simResults
  // (bukan cuma yang berpasangan RSRP aktual), jadi aman dipakai untuk
  // visualisasi peta secara utuh.
  function isAfterActive() { return calibDone && calibViewMode === 'after'; }
  function currentDataset() { return isAfterActive() ? calibResults : simResults; }
  function valRSRP(r) { return parseFloat(isAfterActive() ? r.rsrp_kalib : r.rsrp_sim); }
  function valSINR(r) { return parseFloat(isAfterActive() ? r.sinr_kalib : r.sinr_sim); }

  // ═════════════════════════════════════════════════════════════════════════
  // PATH LOSS — tidak diubah dari v20.1
  // ═════════════════════════════════════════════════════════════════════════
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

  // ═════════════════════════════════════════════════════════════════════════
  // ANTENNA GAIN — [FIX-8] Formula dikoreksi: denominator seharusnya
  // BEAMWIDTH (θ_3dB) polos, BUKAN BEAMWIDTH/2. Rumus resmi 3GPP TR 38.901
  // Table 7.3-1 dan TR 36.942: A(θ) = -min[12·(θ/θ_3dB)², Am], dengan
  // θ_3dB = 65°. Bukti: di θ = θ_3dB/2 = 32,5°, gain HARUS tepat -3dB
  // (itu definisi "3dB beamwidth"). Dengan rumus lama (÷32,5), di titik
  // itu hasilnya -12dB (salah, 9dB meleset) — beam jadi separuh lebih
  // sempit dari spesifikasi 65° yang dimaksudkan. Bug ini ada sejak awal
  // (bukan regresi dari patch manapun), ditemukan setelah membandingkan
  // langsung ke rumus asli 3GPP (TR 36.942 §4.2.1.1, TR 38.901 Table 7.3-1).
  // ═════════════════════════════════════════════════════════════════════════
  function antennaGain(angOff) {
    return -Math.min(12*(angOff/CAL.BEAMWIDTH)**2, CAL.ANTENNA_Am);
  }

  function getClutterLoss(clutterName) {
    const key = (clutterName || 'n/a').toLowerCase().replace(/[\s-]+/g,'_');
    if (CLUTTER_LOSS_DB[key] !== undefined) return CLUTTER_LOSS_DB[key];
    for (const [k, v] of Object.entries(CLUTTER_LOSS_DB))
      if (key.includes(k) || k.includes(key)) return v;
    return CLUTTER_LOSS_DB['n/a'];
  }

  // ═════════════════════════════════════════════════════════════════════════
  // COMPUTE RSRP PER SEKTOR — v21.0
  // ═════════════════════════════════════════════════════════════════════════
  function computeSectorRsrp(pt, sec) {
    const dist    = haversine(pt.lat, pt.lng, sec.siteLat, sec.siteLng);
    const d       = Math.max(dist, 10);
    const brng    = calcBearing(sec.siteLat, sec.siteLng, pt.lat, pt.lng);
    const offset  = Math.abs(((brng - sec.azimuth + 540) % 360) - 180);
    const gainDb  = antennaGain(offset);
    const hBS     = sec.siteHeight || 30;
    const sc      = getSectorScenario(sec);
    const cond    = getSectorCondition(sec);
    const pl      = pathLoss(sc, cond, d, CAL.FREQUENCY, hBS, CAL.MOBILE_H);
    const cl      = getClutterLoss(sec.clutter);
    const scenKey = `${sc}_${cond}`;
    const sigma   = SHADOW_STD_3GPP[scenKey] || 6.0;

    const xi      = spatialNoise(pt.lat, pt.lng, sigma, scenKey);

    const rsrp = applyRxFloor(
      CAL.TX_POWER + CAL.ANTENNA_GAIN - CAL.CABLE_LOSS + gainDb - pl - cl + xi
    );

    return { rsrp, dist, gainDb, pl, cl, sigma, xi, scenario: sc, condition: cond };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SINR — tidak diubah dari v20.1
  // ═════════════════════════════════════════════════════════════════════════
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

  // ═════════════════════════════════════════════════════════════════════════
  // BUILD GLOBAL SECTOR LIST — tidak diubah
  // ═════════════════════════════════════════════════════════════════════════
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
    console.log(`[v29.0] globalSectorList: ${globalSectorList.length} sektor | ${1+neighbourPool.length} site`);
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

  // ═════════════════════════════════════════════════════════════════════════
  // INIT
  // ═════════════════════════════════════════════════════════════════════════
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
    byId('btnKalibrasi')?.addEventListener('click', runKalibrasi);
    byId('btnViewBefore')?.addEventListener('click', () => setCalibView('before'));
    byId('btnViewAfter')?.addEventListener('click', () => setCalibView('after'));
  }

  // [CAL-6] Toggle before/after kalibrasi — redraw memakai data yang sama
  // (calibResults sudah dihitung sekali saat Kalibrasi diklik), jadi instan.
  function setCalibView(mode) {
    if (!calibDone) return;
    calibViewMode = mode;
    byId('btnViewBefore')?.classList.toggle('active', mode === 'before');
    byId('btnViewAfter')?.classList.toggle('active', mode === 'after');
    if (dtDisplayMode === 'sinr')      { redrawSINRMode(); updateSINRLegend(); }
    else if (dtDisplayMode === 'pci')  { redrawPCIMode(); }
    else                                { redrawRSRPMode(); updateRSRPLegend(); }
  }

  function showCalibViewToggle(show) {
    const grp = byId('calibViewToggle');
    const div = byId('calibViewDivider');
    if (grp) grp.style.display = show ? 'flex' : 'none';
    if (div) div.style.display = show ? 'block' : 'none';
  }

  // ── Override ──────────────────────────────────────────────────────────────
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
    const dCorM   = Math.round((D_COR_DEG[scenKey] || D_COR_DEFAULT) * 111320);
    setText('dispSiteModel', `${selSc.toUpperCase()} ${selCnd.toUpperCase()}${isOvr?' ⚠️':''}`);
    setStatus('overrideStatus',
      isOvr
        ? `✅ Override: <b>${selSc.toUpperCase()}-${selCnd.toUpperCase()}</b> (site: ${siteSc.toUpperCase()}-${siteCnd.toUpperCase()})<br>σ=${sigma} dB | d_cor=${dCorM}m`
        : `✅ Sesuai site index: <b>${selSc.toUpperCase()}-${selCnd.toUpperCase()}</b><br>σ=${sigma} dB | d_cor=${dCorM}m`,
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
    const dCorM   = Math.round((D_COR_DEG[scenKey] || D_COR_DEFAULT) * 111320);
    setStatus('overrideStatus',
      `✅ Default site index: <b>${sc.toUpperCase()}-${cnd.toUpperCase()}</b><br>σ=${sigma} dB | d_cor=${dCorM}m`, 'ok'
    );
  }

  function updateModelStatus() {
    if (!primarySite) return;
    const site  = siteIndex[primarySite.id];
    const sc    = propagasiOverride.scenario  || (site?.scenario  || 'uma').toLowerCase();
    const cnd   = propagasiOverride.condition || (site?.condition || 'nlos').toLowerCase();
    const sigma = SHADOW_STD_3GPP[`${sc}_${cnd}`] || 6.0;
    const dCorM = Math.round((D_COR_DEG[`${sc}_${cnd}`] || D_COR_DEFAULT) * 111320);
    setStatus('modelStatus',
      `✅ UE-centric | <b>${sc.toUpperCase()}-${cnd.toUpperCase()}</b> (primary)<br>` +
      `σ=${sigma} dB | d_cor=${dCorM}m | ±2σ clamp | Seed:${FIXED_SEED}<br>` +
      `TX=${CAL.TX_POWER}dBm | G_E=+${CAL.ANTENNA_GAIN}dBi | Cable=-${CAL.CABLE_LOSS}dB | Am=${CAL.ANTENNA_Am}dB<br>` +
      `${globalSectorList.length} sektor RF pool | DomIntf±${DOMINANT_INTERFERER_THRESHOLD_DB}dB`,
      'ok'
    );
  }

  // ── Load Site Index ───────────────────────────────────────────────────────
  // [SITE-1] Sekarang cek sessionStorage → localStorage (cross-tab) → server,
  // dan TIDAK menelan error secara diam-diam (supaya mudah didiagnosis lewat
  // console kalau site index tetap tidak muncul).
  function loadSiteIndex() {
    // Sumber 1: sessionStorage (tab yang sama dipakai upload)
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) {
        const p = JSON.parse(saved);
        if (p && Object.keys(p).length > 0) {
          siteIndex = p;
          // mirror ke localStorage supaya tab lain juga bisa pakai
          try { localStorage.setItem(SESSION_KEY, saved); } catch (e) {}
          onSiteIndexLoaded('sessionStorage');
          return;
        }
      }
    } catch (e) {
      console.error('[loadSiteIndex] Gagal baca sessionStorage:', e);
    }

    // Sumber 2: localStorage (site diupload dari tab/halaman lain)
    try {
      const savedLocal = localStorage.getItem(SESSION_KEY);
      if (savedLocal) {
        const p = JSON.parse(savedLocal);
        if (p && Object.keys(p).length > 0) {
          siteIndex = p;
          try { sessionStorage.setItem(SESSION_KEY, savedLocal); } catch (e) {}
          onSiteIndexLoaded('localStorage');
          return;
        }
      }
    } catch (e) {
      console.error('[loadSiteIndex] Gagal baca localStorage:', e);
    }

    // Sumber 3: server (fallback terakhir, tidak selalu tersedia)
    setStatus('siteStatus', '⏳ Memuat data site dari server...', 'info');
    fetch('/api/get-site')
      .then(r => r.json())
      .then(data => {
        if (!data.has_site || !data.siteIndex) {
          setStatus('siteStatus',
            '⚠️ Belum ada data site. Silakan upload site (XLSX) di halaman Perencanaan Rute / Coverage terlebih dahulu, lalu buka halaman ini di tab yang sama.',
            'warn');
          return;
        }
        siteIndex = data.siteIndex;
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex)); } catch (e) {}
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex)); } catch (e) {}
        onSiteIndexLoaded('server');
      })
      .catch(err => {
        console.error('[loadSiteIndex] Fetch /api/get-site gagal:', err);
        setStatus('siteStatus', '⚠️ Tidak bisa mengambil data site dari server.', 'warn');
      });
  }

  function onSiteIndexLoaded(source) {
    const count = Object.keys(siteIndex).length;
    setStatus('siteStatus', `✅ ${count} site (${source})`, 'ok');
    setText('infoTotalSites', count);
    try {
      renderAllSites();
    } catch (e) {
      console.error('[onSiteIndexLoaded] renderAllSites() error:', e);
    }
    if (dtPoints.length) {
      try {
        autoDetectPrimarySite();
      } catch (e) {
        console.error('[onSiteIndexLoaded] autoDetectPrimarySite() error:', e);
      }
    }
  }

  // ── Auto Detect Primary Site ──────────────────────────────────────────────
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
    setText('dispSiteSectors', sectors.length ? `${sectors.length} sektor ` : '');
    setText('dispSiteClutter', s.clutter || '—');

    dtMap.setView([s.lat, s.lng], 15);
    buildNeighbourPool();
    buildGlobalSectorList();
    highlightPrimarySiteOnMap(bestId);
    populateOverrideDropdowns(bestSite);
    updateModelStatus();
    enableBtn('btnSimRSRP');
  }

  // ── Mode Display ──────────────────────────────────────────────────────────
  window.setDtDisplayMode = function (mode) {
    dtDisplayMode = mode;
    if (mode === 'sinr')      { redrawSINRMode(); updateSINRLegend(); }
    else if (mode === 'pci')  { redrawPCIMode(); }
    else                      { redrawRSRPMode(); updateRSRPLegend(); }
  };

  // [CAL-6] label kecil dipakai di judul legend supaya jelas mode mana yang aktif
  function calibViewLabel() {
    return isAfterActive() ? ' — After Kalibrasi' : (calibDone ? ' — Before Kalibrasi' : '');
  }

  function redrawRSRPMode() {
    const dataset = currentDataset();
    if (!dataset.length) return;
    heatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    dataset.forEach((r, idx) => {
      const m = L.circleMarker([r.lat, r.lng], {
        radius: 6, fillColor: rsrpColor(valRSRP(r)),
        color: '#333', weight: 0.5, fillOpacity: 0.92,
      }).addTo(heatmapLayer);
      m.on('click', () => onPointClick(r, idx+1));
    });
    byId('dtLegend').style.display   = 'block';
    byId('sinrLegend').style.display = 'none';
    byId('pciLegend').style.display  = 'none';
    const t = byId('dtLegendTitle');
    if (t) t.textContent = `SS-RSRP Simulasi (dBm)${calibViewLabel()}`;
    updateRSRPLegend();
  }

  function redrawSINRMode() {
    const dataset = currentDataset();
    if (!dataset.length) return;
    heatmapLayer.clearLayers(); cellLineLayer.clearLayers();
    dataset.forEach((r, idx) => {
      const m = L.circleMarker([r.lat, r.lng], {
        radius: 6, fillColor: sinrColor(valSINR(r)),
        color: '#333', weight: 0.5, fillOpacity: 0.92,
      }).addTo(heatmapLayer);
      m.on('click', () => onPointClick(r, idx+1));
    });
    byId('dtLegend').style.display   = 'none';
    byId('sinrLegend').style.display = 'block';
    byId('pciLegend').style.display  = 'none';
    const t = byId('sinrLegendTitle');
    if (t) t.textContent = `SS-SINR Simulasi (dB)${calibViewLabel()}`;
    updateSINRLegend();
  }

  function redrawPCIMode() {
    // Kalibrasi hanya menggeser PL/RSRP absolut, bukan pemilihan serving cell
    // (itu ditentukan sekali saat runSimulation()). Jadi distribusi PCI
    // before/after SELALU identik — tidak perlu ikut toggle, cukup pakai
    // simResults seperti semula.
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
      {label:'-140~-120 dBm', color:'#ff3333', fn:v=>v>=-125&&v<-120},
    ];
    const dataset = currentDataset();
    const total = dataset.length || 1;
    tbody.innerHTML = B.map(b => {
      const cnt = dataset.filter(r => b.fn(valRSRP(r))).length;
      return `<tr><td><div style="width:13px;height:13px;background:${b.color};border-radius:3px;display:inline-block;"></div></td><td>${b.label}</td><td><b>${((cnt/total)*100).toFixed(1)}%</b></td></tr>`;
    }).join('');
    legend.style.display = 'block';
  }

  function updateSINRLegend() {
    const legend = byId('sinrLegend'), tbody = byId('sinrLegendBody');
    if (!legend || !tbody) return;
    const B = [
      {label:'20 ~ 40 dB',  color:'#0042a5', fn:v=>v>=20       },
      {label:'10 ~ 20 dB',  color:'#00a955', fn:v=>v>=10&&v<20 },
      {label:'0 ~ 10 dB',   color:'#70ff66', fn:v=>v>=0 &&v<10 },
      {label:'-5 ~ 0 dB',   color:'#fffb00', fn:v=>v>=-5&&v<0  },
      {label:'-40 ~ -5 dB', color:'#ff3333', fn:v=>v<-5        },
    ];
    const dataset = currentDataset();
    const total = dataset.length || 1;
    tbody.innerHTML = B.map(b => {
      const cnt = dataset.filter(r => b.fn(valSINR(r))).length;
      return `<tr><td><div style="width:13px;height:13px;background:${b.color};border-radius:3px;display:inline-block;"></div></td><td>${b.label}</td><td><b>${((cnt/total)*100).toFixed(1)}%</b></td></tr>`;
    }).join('');
    legend.style.display = 'block';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // RUN SIMULATION — tidak diubah dari v20.1, tambah enableBtn('btnKalibrasi')
  // ═════════════════════════════════════════════════════════════════════════
  function runSimulation() {
    if (!dtPoints.length)               return alert('Upload CSV DT terlebih dahulu!');
    if (!Object.keys(siteIndex).length) return alert('Data site belum dimuat!');
    if (!primarySite)                   return alert('Primary site belum terdeteksi!');
    if (!globalSectorList.length)       return alert('Sector pool kosong.');

    heatmapLayer.clearLayers();
    cellLineLayer.clearLayers();
    simResults = [];
    calibDone = false;
    calibCoefUMa = null;
    calibCoefUMi = null;
    calibCoefSinrUMa = null;
    calibCoefSinrUMi = null;
    calibResults = [];
    calibViewMode = 'before';
    byId('kalibPanel')?.remove();
    showCalibViewToggle(false); // simulasi baru = kalibrasi lama tidak berlaku lagi

    dtPoints.forEach((pt, idx) => {
      const sectorRsrpList = globalSectorList.map(sec => {
        const res = computeSectorRsrp(pt, sec);
        return {
          rsrp: res.rsrp, dist: res.dist, gainDb: res.gainDb,
          pl: res.pl, cl: res.cl, sigma: res.sigma, xi: res.xi,
          scenario: res.scenario, condition: res.condition,
          siteId: sec.siteId, siteLat: sec.siteLat, siteLng: sec.siteLng,
          siteHeight: sec.siteHeight,
          isMain: sec.isMain, sectorNum: sec.sectorNum, azimuth: sec.azimuth,
          cellName: sec.cellName, pciColor: sec.pciColor,
          pci: sec.pci, cellId: sec.cellId, arfcn: sec.arfcn,
        };
      });

      sectorRsrpList.sort((a, b) => b.rsrp - a.rsrp);
      const serving = sectorRsrpList[0];

      // [SINR-1] Best-per-site collapse — SATU entry RSRP tertinggi per site,
      // dipakai konsisten baik untuk tabel "Detected Cells" di UI maupun
      // sebagai daftar interferer SINR.
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
      const interferers = cellsForUI.filter(c => c.siteId !== serving.siteId);

      const { sinr: sinr_sim, nDominant } = computeSINR(
        serving.rsrp, interferers.map(s => s.rsrp)
      );

      interferers.forEach(sec => {
        const deltaRsrp = sec.rsrp - serving.rsrp;
        sec.sinr_est = Math.max(-10, Math.min(40, sinr_sim + deltaRsrp));
      });
      serving.sinr_est = sinr_sim;

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
        // [SPLIT-1] Default 'n_a' — dioverride jadi 'train'/'val' di
        // runKalibrasi() untuk titik yang ikut proses kalibrasi.
        _splitKalib   : 'n_a',
      };

      m.on('click', () => onPointClick(result, idx+1));
      simResults.push(result);
    });

    siteLayer.remove();
    siteLayer.addTo(dtMap);

    dtDisplayMode = 'rsrp';
    byId('sinrLegend').style.display = 'none';
    byId('pciLegend').style.display  = 'none';
    updateRSRPLegend();
    renderStats();

    enableBtn('btnExportCSV');
    enableBtn('btnSimSINR');
    enableBtn('btnSimPCI');
    enableBtn('btnKalibrasi'); // [CAL-3] fix: tombol kalibrasi sekarang ke-enable

    const pairedR = simResults.filter(r => r.rsrp_actual != null);
    const pairedS = simResults.filter(r => r.sinr_actual != null);
    const servedByMain = simResults.filter(r => r._serving?.isMain).length;
    const pctMain = ((servedByMain / simResults.length)*100).toFixed(1);
    const avgDom  = simResults.length
      ? (simResults.reduce((s,r)=>s+r.n_dominant,0)/simResults.length).toFixed(1) : 0;

    let msg = `✅ Simulasi SS-RSRP selesai [v29.0] — ${simResults.length} titik\n`;
    msg    += `UE-centric | ${globalSectorList.length} sektor RF pool\n`;
    msg    += `TX=${CAL.TX_POWER}dBm | G_E=+${CAL.ANTENNA_GAIN}dBi | Cable=-${CAL.CABLE_LOSS}dB | Net=+${CAL.ANTENNA_GAIN-CAL.CABLE_LOSS}dB\n`;
    msg    += `Primary: ${pctMain}% | Neighbour: ${(100-parseFloat(pctMain)).toFixed(1)}%\n`;
    msg    += `Avg dominant interferer: ${avgDom}\n\n`;
    if (pairedR.length) {
      const dR = pairedR.map(r => parseFloat(r.rsrp_sim) - r.rsrp_actual);
      msg += `SS-RSRP: ME=${mean(dR).toFixed(2)} | RMSE=${rmseF(dR).toFixed(2)} | SD=${sdF(dR).toFixed(2)} dB\n`;
    }
    if (pairedS.length) {
      const dS = pairedS.map(r => parseFloat(r.sinr_sim) - r.sinr_actual);
      msg += `SS-SINR: ME=${mean(dS).toFixed(2)} | RMSE=${rmseF(dS).toFixed(2)} | SD=${sdF(dS).toFixed(2)} dB\n`;
    }
    msg += `\nKlik "Kalibrasi" untuk melihat analisis before-after per skenario (UMa/UMi), dievaluasi pada validation set (data yang tidak dipakai fitting).`;
    alert(msg);
  }

  function runSINROnly() {
    if (!simResults.length) return alert('Jalankan Simulasi SS-RSRP terlebih dahulu!');
    dtDisplayMode = 'sinr';
    redrawSINRMode();
  }

  function simulatePCI() {
    if (!simResults.length) return alert('Jalankan Simulasi SS-RSRP terlebih dahulu!');
    dtDisplayMode = 'pci';
    redrawPCIMode();
  }

  // ── Click Handler ─────────────────────────────────────────────────────────
  function onPointClick(result, ptIdx) {
    cellLineLayer.clearLayers();
    // [FIX-3] Kalau mode "After Kalibrasi" aktif dan titik ini punya
    // cells_kalib, tabel detail pakai RSRP kalibrasi per-cell (konsisten
    // dengan RSRP/SINR yang digambar di peta), bukan selalu nilai simulasi.
    const useCalibCells = isAfterActive() && Array.isArray(result.cells_kalib) && result.cells_kalib.length;
    const displayCells = useCalibCells
      ? result.cells_kalib.map(c => ({ ...c, rsrp: c.rsrp_kalib ?? c.rsrp }))
      : result.cells;
    // sinr_est per-cell perlu dihitung ulang relatif terhadap serving yang
    // ditampilkan supaya panel "Detected Cells" tetap konsisten secara internal
    if (useCalibCells) {
      const servingRsrp = displayCells.find(c => c.siteId === result.serving_site)?.rsrp
                         ?? parseFloat(result.rsrp_kalib);
      displayCells.forEach(c => {
        c.sinr_est = c.siteId === result.serving_site
          ? parseFloat(result.sinr_kalib)
          : Math.max(-10, Math.min(40, parseFloat(result.sinr_kalib) + (c.rsrp - servingRsrp)));
      });
    }
    result = { ...result, cells: displayCells };
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
      // [CAL-6] Kalau titik ini sudah punya hasil kalibrasi, tampilkan
      // sim vs kalib berdampingan supaya kelihatan jelas pergeserannya,
      // tanpa perlu klik ulang.
      const rsrpKalib = result.rsrp_kalib != null
        ? `&nbsp;→&nbsp;Kalib:<b style="color:#69f0ae">${result.rsrp_kalib} dBm</b>` : '';
      const sinrKalib = result.sinr_kalib != null
        ? `&nbsp;→&nbsp;Kalib:<b style="color:#69f0ae">${result.sinr_kalib} dB</b>` : '';
      title.innerHTML =
        `📡 Detail Titik <b>${ptIdx}</b>` +
        `<span style="font-weight:400;font-size:10px;opacity:0.75;margin-left:6px;">` +
        `(${result.lat.toFixed(5)}, ${result.lng.toFixed(5)})</span><br>` +
        `<span style="font-size:10px;opacity:0.85;">` +
        `SS-RSRP sim:<b>${result.rsrp_sim} dBm</b>${rsrpKalib}${rsrpAkt}` +
        `&nbsp;&nbsp;SS-SINR sim:<b>${result.sinr_sim} dB</b>${sinrKalib}${sinrAkt}` +
        `&nbsp;&nbsp;<span style="opacity:0.6;font-size:9px;">(${result.n_dominant} dominant interferer)</span>` +
        `</span>`;
    }

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
        <td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;
          background:${c.pciColor||'#aaa'};margin-right:3px;vertical-align:middle;
          border:1px solid rgba(0,0,0,0.2)"></span>${pciStr}</td>
        <td>${arfcn}</td>
        <td><span class="dot" style="background:${dotColorRsrp(c.rsrp)}"></span>${c.rsrp.toFixed(2)}</td>
        <td><span class="dot" style="background:${dotColorSinr(c.sinr_est)}"></span>${sinrVal}</td>
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

  // ── Render Stats ──────────────────────────────────────────────────────────
  function renderStats() {
    const box = byId('resultBox'); if (!box) return;
    const pairedR = simResults.filter(r => r.rsrp_actual != null);
    const pairedS = simResults.filter(r => r.sinr_actual != null);
    const site    = siteIndex[primarySite?.id];
    const sc      = propagasiOverride.scenario  || (site?.scenario  || 'uma').toLowerCase();
    const cnd     = propagasiOverride.condition || (site?.condition || 'nlos').toLowerCase();
    const sigma   = SHADOW_STD_3GPP[`${sc}_${cnd}`] || 6.0;
    const dCorM   = Math.round((D_COR_DEG[`${sc}_${cnd}`] || D_COR_DEFAULT) * 111320);
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
      <h3>📊 Simulasi v29.0 — Kalibrasi Multi-Skenario (Train/Val Split)</h3>
      <p class="result-meta">
        ${simResults.length} titik &nbsp;|&nbsp;
        ${globalSectorList.length} sektor RF pool &nbsp;|&nbsp;
        Seed:${FIXED_SEED}
      </p>
      <div style="background:rgba(0,201,136,0.1);border:1px solid rgba(0,201,136,0.3);
        border-radius:6px;padding:5px 9px;font-size:10px;margin-bottom:6px;color:#ffffff;">
        TX=${CAL.TX_POWER}dBm | G_E=+${CAL.ANTENNA_GAIN}dBi | Cable=-${CAL.CABLE_LOSS}dB | Net=+${CAL.ANTENNA_GAIN-CAL.CABLE_LOSS}dB<br>
        Am=${CAL.ANTENNA_Am}dB | d_cor=${dCorM}m | σ=${sigma}dB<br>
        Primary: <b>${pctMain}%</b> &nbsp;|&nbsp; Avg interferer: <b>${avgDom}</b>
      </div>
      <div class="stat-section-title">Hasil SS-RSRP</div>
      ${metricBlock(pairedR,'rsrp_sim','rsrp_actual','dBm')}
      <div class="stat-section-title" style="margin-top:8px;">Hasil SS-SINR</div>
      ${metricBlock(pairedS,'sinr_sim','sinr_actual','dB')}
      <div class="result-footer" style="margin-top:8px;">Klik marker untuk detail | Klik "Kalibrasi" untuk analisis before-after (dievaluasi pada validation set)</div>`;
    box.style.display = 'block';
  }

  // ── Debug ─────────────────────────────────────────────────────────────────
  function showDebug() {
    if (!primarySite) { alert('Belum ada primary site.'); return; }
    const site    = siteIndex[primarySite.id];
    const sc      = propagasiOverride.scenario  || (site?.scenario  || 'uma').toLowerCase();
    const cnd     = propagasiOverride.condition || (site?.condition || 'nlos').toLowerCase();
    const sigma   = SHADOW_STD_3GPP[`${sc}_${cnd}`] || 6.0;
    const dCorM   = Math.round((D_COR_DEG[`${sc}_${cnd}`] || D_COR_DEFAULT) * 111320);
    const servedByMain = simResults.filter(r => r._serving?.isMain).length;
    const avgDom  = simResults.length
      ? (simResults.reduce((s,r)=>s+r.n_dominant,0)/simResults.length).toFixed(1) : 0;
    alert([
      `=== DT Simulation v29.0 — Kalibrasi Multi-Skenario (Train/Val Split) ===`,
      ``,
      `=== RF Parameters ===`,
      `  TX Power    : ${CAL.TX_POWER} dBm`,
      `  G_E,max     : +${CAL.ANTENNA_GAIN} dBi [TR 38.901 Table 7.3-1]`,
      `  Cable Loss  : -${CAL.CABLE_LOSS} dB`,
      `  Am (pattern): ${CAL.ANTENNA_Am} dB [TR 38.901 Table 7.3-1]`,
      `  Beamwidth   : ${CAL.BEAMWIDTH}° [AAU5336 spec]`,
      `  NF          : ${CAL.NF} dB [TR 36.942 Table 4.5a]`,
      `  Frekuensi   : ${CAL.FREQUENCY} MHz (tetap — parameter operator, dipakai di model RF, TIDAK dipakai sebagai variabel regresi kalibrasi karena konstan di seluruh data)`,
      ``,
      `=== Shadow Fading ===`,
      `  σ_SF   = ${sigma} dB [TR 38.901 Table 7.4.4-1]`,
      `  d_cor  = ${dCorM} m [TR 38.901 Table 7.5-6]`,
      `  Seed   : ${FIXED_SEED}`,
      ``,
      `=== Kalibrasi RSRP (model: PL = K1 + K2·log(d3D)) ===`,
      `  Status     : ${calibDone ? 'Sudah dijalankan' : 'Belum dijalankan'}`,
      `  Train/Val  : ${Math.round(CALIB_TRAIN_RATIO*100)}% / ${Math.round((1-CALIB_TRAIN_RATIO)*100)}% (1 partisi per skenario, dipakai bersama RSRP & SINR, seed tetap)`,
      `  UMa coef   : ${calibCoefUMa ? `K1=${calibCoefUMa.K1.toFixed(2)} K2=${calibCoefUMa.K2.toFixed(2)} (train=${calibCoefUMa.nTrain}, val=${calibCoefUMa.nVal})` : '—'}`,
      `  UMi coef   : ${calibCoefUMi ? `K1=${calibCoefUMi.K1.toFixed(2)} K2=${calibCoefUMi.K2.toFixed(2)} (train=${calibCoefUMi.nTrain}, val=${calibCoefUMi.nVal})` : '—'}`,
      ``,
      `=== Kalibrasi SINR LANGSUNG (model: SINR = K1 + K2·log(d3D_serving)) ===`,
      `  Status     : ${(calibCoefSinrUMa || calibCoefSinrUMi) ? 'Sudah dijalankan (independen dari RSRP)' : 'Belum dijalankan / gagal semua skenario'}`,
      `  UMa coef   : ${calibCoefSinrUMa ? `K1=${calibCoefSinrUMa.K1.toFixed(2)} K2=${calibCoefSinrUMa.K2.toFixed(2)} (train=${calibCoefSinrUMa.nTrain}, val=${calibCoefSinrUMa.nVal})` : '—'}`,
      `  UMi coef   : ${calibCoefSinrUMi ? `K1=${calibCoefSinrUMi.K1.toFixed(2)} K2=${calibCoefSinrUMi.K2.toFixed(2)} (train=${calibCoefSinrUMi.nTrain}, val=${calibCoefSinrUMi.nVal})` : '—'}`,
      ``,
      `=== Hasil ===`,
      `  Total: ${simResults.length} | Primary: ${servedByMain} | Neighbour: ${simResults.length-servedByMain}`,
    ].join('\n'));
  }

// ═══════════════════════════════════════════════════════════════════════
// PATCH — handleCsvUpload() dengan alert() saat file gagal dibaca sama
// sekali (misal bukan file CSV, atau corrupt). Cari fungsi
// handleCsvUpload(e) yang sudah ada, lalu GANTI SELURUH ISINYA.
// ═══════════════════════════════════════════════════════════════════════

function handleCsvUpload(e) {
  const file = e.target.files[0]; if (!file) return;

  // Cek ekstensi SEBELUM parsing — mencegah file .xlsx/.xls (atau biner
  // lain) diproses sebagai teks CSV, yang menghasilkan header gibberish
  // dan pesan error yang membingungkan (lihat kasus nyata: upload .xlsx
  // menghasilkan "Kolom Lat/Lng tidak ditemukan" padahal akar masalahnya
  // jenis file yang salah).
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') {
    setStatus('csvStatus', '❌ File Excel tidak didukung', 'error');
    alert(
      `❌ Upload gagal.\n\n` +
      `File "${file.name}" berformat Excel (.${ext}), sedangkan halaman ini hanya ` +
      `menerima file CSV (.csv).\n\n` +
      `Solusi: buka file di Excel/Google Sheets, lalu "Save As" / "Export" sebagai ` +
      `CSV (Comma delimited), baru upload file .csv hasilnya.`
    );
    e.target.value = '';
    return;
  }

  setStatus('csvStatus', '⏳ Membaca CSV...', 'info');
  if (typeof Papa !== 'undefined') {
    Papa.parse(file, {
      header:true, dynamicTyping:false, skipEmptyLines:true,
      complete: r => processCsvData(r.data, r.meta.fields),
      error: (err) => {
        setStatus('csvStatus','❌ Gagal membaca file','error');
        alert(`❌ Upload gagal.\n\nFile "${file.name}" tidak bisa dibaca sebagai CSV.\n${err?.message ? 'Detail: ' + err.message : 'Pastikan file berformat CSV yang valid.'}`);
      },
    });
  } else {
    const reader = new FileReader();
    reader.onload = ev => {
      const lines  = ev.target.result.split('\n').filter(l=>l.trim());
      if (!lines.length) {
        setStatus('csvStatus','❌ File kosong','error');
        alert(`❌ Upload gagal.\n\nFile "${file.name}" kosong atau tidak terbaca.`);
        return;
      }
      const delim  = lines[0].includes('\t')?'\t':',';
      const fields = lines[0].split(delim).map(h=>h.trim().replace(/"/g,''));
      const rows   = lines.slice(1).map(line => {
        const vals=line.split(delim).map(v=>v.trim().replace(/"/g,''));
        const obj={}; fields.forEach((h,i)=>obj[h]=vals[i]??''); return obj;
      });
      processCsvData(rows, fields);
    };
    reader.onerror = () => {
      setStatus('csvStatus','❌ Gagal membaca file','error');
      alert(`❌ Upload gagal.\n\nFile "${file.name}" tidak bisa dibaca oleh browser.`);
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

// ═══════════════════════════════════════════════════════════════════════
// PATCH — processCsvData() dengan alert() popup untuk upload CSV DT.
// Cari fungsi processCsvData(rows, headers) yang sudah ada di
// dtsimulation.js, lalu GANTI SELURUH ISINYA dengan versi di bawah ini.
// Semua logika lama tetap sama persis — hanya ditambahkan alert() di
// akhir, mengikuti gaya yang sudah dipakai di runSimulation().
// ═══════════════════════════════════════════════════════════════════════

function processCsvData(rows, headers) {
  const cols = detectCols(headers || Object.keys(rows[0]||{}));
  if (!cols.lat||!cols.lng) {
    setStatus('csvStatus','❌ Kolom Lat/Lng tidak ditemukan.','error');

    // Deteksi kasus umum: file .xlsx/.xls (atau file biner lain) diupload
    // padahal parser di sini cuma baca CSV mentah. Signature ZIP (PK..) atau
    // banyak karakter kontrol/non-printable di header adalah tanda file
    // biner, bukan CSV — kasih pesan yang jelas alih-alih bilang "kolom
    // tidak ditemukan" (menyesatkan, karena bukan itu akar masalahnya).
    const headerSample = (headers || Object.keys(rows[0]||{})).join('');
    const looksBinary = /^PK/.test(headerSample) || /[\x00-\x08\x0E-\x1F]/.test(headerSample);

    if (looksBinary) {
      alert(
        `❌ Upload gagal.\n\n` +
        `File yang diupload sepertinya file Excel (.xlsx/.xls) atau file biner lain, ` +
        `bukan CSV teks biasa. Halaman ini hanya bisa membaca file .csv.\n\n` +
        `Solusi: buka file di Excel/Google Sheets, lalu simpan/export ulang sebagai ` +
        `"CSV (Comma delimited)" (.csv), baru upload file hasil export itu.`
      );
    } else {
      alert(
        `❌ Upload gagal.\n\n` +
        `Kolom Latitude/Longitude tidak ditemukan di file CSV.\n` +
        `Header terbaca: ${(headers||Object.keys(rows[0]||{})).slice(0,8).join(', ')}`
      );
    }
    return;
  }

  const totalRawRows = rows.length;

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

  if (dtPoints.length<3){
    setStatus('csvStatus','❌ Terlalu sedikit titik.','error');
    alert(`❌ Upload gagal.\n\nHanya ${dtPoints.length} titik valid ditemukan (minimal 3 dibutuhkan).\nCek format Lat/Lng di file — mungkin memakai koma sebagai desimal, atau banyak baris kosong/rusak.`);
    return;
  }

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

  // ═══════════════════════════════════════════════════════════════════
  // ALERT POPUP — ringkas hasil upload: berhasil / kurang lengkap / gagal
  // ═══════════════════════════════════════════════════════════════════
  const droppedRows = totalRawRows - dtPoints.length;
  const pctDropped  = totalRawRows > 0 ? (droppedRows / totalRawRows) * 100 : 0;
  const warnings = [];

  if (!cols.rsrp) warnings.push('kolom RSRP tidak ditemukan — simulasi tetap bisa jalan, tapi tidak ada pembanding data aktual untuk SS-RSRP');
  if (!cols.sinr) warnings.push('kolom SINR tidak ditemukan — tidak ada pembanding data aktual untuk SS-SINR');
  if (droppedRows > 0 && pctDropped >= 5) {
    warnings.push(`${droppedRows.toLocaleString()} baris (${pctDropped.toFixed(1)}%) dibuang karena Lat/Lng tidak valid (kosong, 0, atau di luar rentang)`);
  }

  let msg = `✅ Upload CSV berhasil — ${dtPoints.length.toLocaleString()} titik valid dari ${totalRawRows.toLocaleString()} baris.\n`;
  msg    += `RSRP aktual: ${simPoints.length.toLocaleString()} titik | SINR aktual: ${nSinr.toLocaleString()} titik\n`;
  msg    += `Panjang rute: ~${(totalDist/1000).toFixed(2)} km\n`;

  if (warnings.length) {
    msg += `\n⚠️ Perlu diperhatikan:\n`;
    warnings.forEach(w => { msg += `   • ${w}\n`; });
  }

  alert(msg);
}

  // ═════════════════════════════════════════════════════════════════════════
  // LEAST SQUARES — cari koefisien PL optimal dari data aktual
  // ═════════════════════════════════════════════════════════════════════════
  function leastSquares(X, y) {
    const n = X.length, p = X[0].length;

    const XtX = Array.from({length:p}, () => Array(p).fill(0));
    for (let i=0;i<p;i++)
      for (let j=0;j<p;j++)
        for (let k=0;k<n;k++)
          XtX[i][j] += X[k][i]*X[k][j];

    const Xty = Array(p).fill(0);
    for (let i=0;i<p;i++)
      for (let k=0;k<n;k++)
        Xty[i] += X[k][i]*y[k];

    const aug = XtX.map((row,i)=>[
      ...row, ...Array(p).fill(0).map((_,j)=>i===j?1:0)
    ]);
    for (let col=0;col<p;col++) {
      let maxRow=col;
      for (let row=col+1;row<p;row++)
        if (Math.abs(aug[row][col])>Math.abs(aug[maxRow][col])) maxRow=row;
      [aug[col],aug[maxRow]]=[aug[maxRow],aug[col]];
      const piv=aug[col][col];
      if (Math.abs(piv)<1e-12) continue;
      for (let j=0;j<2*p;j++) aug[col][j]/=piv;
      for (let row=0;row<p;row++){
        if(row===col) continue;
        const f=aug[row][col];
        for (let j=0;j<2*p;j++) aug[row][j]-=f*aug[col][j];
      }
    }
    const inv=aug.map(row=>row.slice(p));
    const beta=Array(p).fill(0);
    for (let i=0;i<p;i++)
      for (let j=0;j<p;j++)
        beta[i]+=inv[i][j]*Xty[j];
    return beta;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // [FIX-1][FIX-4] PATH LOSS TERKALIBRASI — TANPA term log(fc) DAN TANPA
  // term log(hBS). Frekuensi konstan di seluruh data (collinear dengan
  // intercept K1). hBS nyaris konstan di training set karena didominasi
  // serving ke satu primary site (lihat [FIX-4] di header) — koefisiennya
  // terbukti tidak stabil antar site. Efek tinggi BTS TETAP masuk lewat
  // geometri d3D (parameter hBS masih dipakai untuk menghitung d3D di sini,
  // hanya tidak lagi punya koefisien regresi terpisah).
  // Model: PL = K1 + K2·log10(d3D)
  // ═════════════════════════════════════════════════════════════════════════
  function pathLossCalibrated(coef, d2D, hBS) {
    const d   = Math.max(d2D, 10);
    const hUT = CAL.MOBILE_H;
    const d3D = Math.sqrt(d*d + (hBS-hUT)**2);
    return coef.K1
         + coef.K2 * Math.log10(d3D);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // [FIX-3][FIX-5] Kalibrasi RSRP untuk SATU cell (serving ATAU interferer).
  // Dipakai untuk membangun ulang SINR kalibrasi dari definisi aslinya
  // (bukan heuristik delta×0.3). Menerima koefisien sesuai skenario cell
  // itu sendiri (cell.scenario) — bukan skenario serving — supaya tetap
  // benar walau suatu saat dijalankan tanpa override global (tiap site
  // pakai skenario dari site index masing-masing).
  //
  // [FIX-5] GUARD RAIL RENTANG JARAK: drive test hanya mengukur RSRP dari
  // BTS yang sedang di-lock (serving) — TIDAK PERNAH dari BTS lain (lihat
  // metodologi single-BCCH-lock di paper acuan). Akibatnya K1/K2 di-fit
  // HANYA memakai jarak-jarak yang muncul di data serving cell (biasanya
  // dekat), sementara interferer (BTS tetangga) sistematis lebih jauh —
  // menerapkan K1/K2 itu ke jarak interferer berarti MENGEKSTRAPOLASI
  // formula ke luar rentang yang pernah divalidasi, dan terbukti empiris
  // ini merusak SS-SINR (bias ME besar, RMSE naik) meski SS-RSRP tetap
  // membaik. Sekarang: kalau jarak (d2D) suatu cell berada DI LUAR rentang
  // [minD2D, maxD2D] data training (dengan toleransi ±EXTRAP_MARGIN),
  // cell itu di-fallback ke RSRP simulasi asli (TIDAK dikalibrasi) —
  // supaya kalibrasi hanya diterapkan pada rentang jarak yang benar-benar
  // terwakili di data, bukan diekstrapolasi secara membabi buta.
  // ═════════════════════════════════════════════════════════════════════════
  function calibrateCellRsrp(cell) {
    const scLower = (cell.scenario || '').toLowerCase();
    const coef = scLower === 'uma' ? calibCoefUMa
               : scLower === 'umi' ? calibCoefUMi
               : null;
    if (!coef) return { rsrpKalib: cell.rsrp, applied: false, reason: 'no_coef' };

    // [FIX-5] Cek apakah jarak cell ini berada dalam rentang yang terwakili
    // di data training (dengan margin toleransi), sebelum menerapkan formula.
    const lo = coef.minD2D * (1 - EXTRAP_MARGIN);
    const hi = coef.maxD2D * (1 + EXTRAP_MARGIN);
    if (cell.dist < lo || cell.dist > hi) {
      return { rsrpKalib: cell.rsrp, applied: false, reason: 'extrapolated' };
    }

    const hBS      = cell.siteHeight || 30;
    const PL_kalib = pathLossCalibrated(coef, cell.dist, hBS);
    const xi       = parseFloat(cell.xi) || 0;
    const cl       = parseFloat(cell.cl) || 0;
    const rsrp_k   = applyRxFloor(
      CAL.TX_POWER + CAL.ANTENNA_GAIN - CAL.CABLE_LOSS
      + cell.gainDb - PL_kalib - cl + xi
    );
    // Nama field sengaja DIBEDAKAN dari 'rsrp' (nilai asli/simulasi) supaya
    // tidak ada ambiguitas saat digabung dengan objek cell asli via spread.
    return { rsrpKalib: rsrp_k, pl: PL_kalib, applied: true, reason: 'ok' };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // [CAL-1][FIX-1][FIX-2] Kalibrasi 1 skenario — dipanggil terpisah untuk
  // 'uma' dan 'umi'. Sekarang dengan train/val split: koefisien di-fit
  // HANYA dari train set; val set dikembalikan terpisah untuk evaluasi
  // "after kalibrasi" yang jujur (out-of-sample), dibandingkan dengan
  // "before kalibrasi" yang DIHITUNG DARI VAL SET YANG SAMA (bukan dari
  // seluruh data), supaya perbandingan before-after adil (apple-to-apple).
  // ═════════════════════════════════════════════════════════════════════════
  function calibrateScenario(trainPoints, valPoints, scenarioLabel) {
    // [SPLIT-1] Train/val SEKARANG SUDAH displit di runKalibrasi() — SATU
    // partisi per skenario, dipakai bersama oleh RSRP dan SINR. Fungsi ini
    // cuma memvalidasi ukurannya, tidak lagi split sendiri.
    if (trainPoints.length < MIN_CALIB_POINTS || valPoints.length < MIN_VAL_POINTS) {
      console.warn(`[Kalibrasi] ${scenarioLabel}: train=${trainPoints.length} val=${valPoints.length} tidak cukup (min train ${MIN_CALIB_POINTS}, min val ${MIN_VAL_POINTS}), dilewati.`);
      return null;
    }

    // PL_actual = TX + G_E - CableLoss + G_h(θ) - RSRP_aktual
    const toCalibRow = r => {
      const d2D = parseFloat(r.distance);
      const hBS = r._serving?.siteHeight || 30;
      const PL_actual = CAL.TX_POWER
                      + CAL.ANTENNA_GAIN
                      - CAL.CABLE_LOSS
                      + parseFloat(r.gainDb)
                      - r.rsrp_actual;
      const d3D = Math.sqrt(d2D*d2D + (hBS-CAL.MOBILE_H)**2);
      // [FIX-4] hBS TIDAK dipakai sebagai kolom regresi terpisah lagi —
      // cukup dipakai untuk menghitung d3D (efek tinggi BTS sudah masuk
      // lewat geometri, tidak lagi punya koefisien regresi sendiri).
      return {
        r, d2D, hBS, PL_actual,
        log_d3D: Math.log10(Math.max(d3D, 1)),
      };
    };

    const trainCalib = trainPoints.map(toCalibRow);

    // Filter outlier ±2.5σ — HANYA berdasarkan statistik train set.
    const plVals = trainCalib.map(d=>d.PL_actual);
    const plMean = plVals.reduce((s,v)=>s+v,0)/plVals.length;
    const plStd  = Math.sqrt(plVals.reduce((s,v)=>s+(v-plMean)**2,0)/plVals.length);
    const filt   = trainCalib.filter(d=>Math.abs(d.PL_actual-plMean)<=2.5*plStd);

    if (filt.length < MIN_CALIB_AFTER_FILTER) {
      console.warn(`[Kalibrasi] ${scenarioLabel}: tersisa ${filt.length} titik training setelah filter outlier (min ${MIN_CALIB_AFTER_FILTER}), dilewati.`);
      return null;
    }

    // [FIX-1][FIX-4] Matriks regresi TANPA kolom log(fc) DAN TANPA log(hBS)
    // — hanya intercept dan log(d3D). 2 parameter, bukan 3/4.
    const X = filt.map(d=>[1, d.log_d3D]);
    const y = filt.map(d=>d.PL_actual);
    const [K1,K2] = leastSquares(X, y);

    // [FIX-6] Sanity check FISIK: path loss harus naik seiring jarak, jadi
    // K2 harus positif dan cukup besar untuk masuk akal. Kalau tidak —
    // biasanya gejala jarak (d3D) kurang bervariasi/informatif di data
    // training site ini (mirip kasus hBS di [FIX-4]) — regresi berhasil
    // "fitting" secara matematis tapi hasilnya tidak valid secara fisik,
    // dan terbukti empiris menghasilkan bias SINR yang konsisten (ME
    // membengkak) meski SD mengecil. Kalibrasi untuk skenario ini DIBATALKAN
    // total (fallback ke simulasi asli), bukan diterapkan dengan koefisien
    // yang salah arah.
    if (K2 < MIN_PLAUSIBLE_K2) {
      console.warn(`[Kalibrasi] ${scenarioLabel}: K2=${K2.toFixed(2)} di bawah ambang fisik masuk akal (min ${MIN_PLAUSIBLE_K2}) — kemungkinan jarak kurang bervariasi di data training. Kalibrasi dibatalkan untuk skenario ini.`);
      return null;
    }

    // [FIX-5] Rentang jarak (d2D, meter) yang benar-benar terwakili di data
    // training — dipakai sebagai guard rail supaya koreksi kalibrasi TIDAK
    // diekstrapolasi ke jarak yang jauh di luar apa yang pernah "dilihat"
    // model saat fitting (lihat calibrateCellRsrp).
    const trainDistances = filt.map(d => d.d2D);
    const minD2D = Math.min(...trainDistances);
    const maxD2D = Math.max(...trainDistances);

    return {
      K1, K2, minD2D, maxD2D,
      nTrain: filt.length, nTrainRaw: trainPoints.length,
      nVal: valPoints.length,
      nTotal: trainPoints.length + valPoints.length,
      valPoints, // dikembalikan untuk evaluasi "before/after" out-of-sample
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // [FIX-7] KALIBRASI SINR LANGSUNG — independen dari kalibrasi RSRP/PL.
  //
  // Berbeda dari pendekatan sebelumnya (menghitung ulang RSRP tiap interferer
  // lalu memanggil ulang computeSINR), pendekatan ini men-fit model regresi
  // LANGSUNG terhadap sinr_actual — persis seperti SPM tuning terhadap PL,
  // tapi targetnya SINR. Ini valid karena drive test modern (chipset LTE/5G)
  // mengukur SINR secara langsung di tiap titik (kolom SINR di CSV), bukan
  // cuma RSRP serving — beda dari asumsi metode drive test lama yang
  // mendasari [FIX-3]/[FIX-4]/[FIX-5]. Jadi SINR punya ground truth sendiri,
  // sama absahnya dengan RSRP, dan tidak perlu bergantung pada tebakan RSRP
  // interferer yang memang tidak pernah tervalidasi.
  //
  // Model: SINR = K1 + K2·log10(d3D_serving)
  // (d3D dihitung dari jarak+tinggi BTS SERVING saja — bukan interferer,
  // karena target regresi ini SINR titik itu sendiri, bukan PL per-cell.)
  //
  // Sanity check: K2 harus NEGATIF (SINR menurun seiring jarak dari serving
  // bertambah — masuk akal karena makin jauh dari BTS, makin dekat ke
  // cell-edge, makin banyak sel tetangga yang sinyalnya kompetitif).
  // ═════════════════════════════════════════════════════════════════════════
  function calibrateScenarioSINR(trainPoints, valPoints, scenarioLabel) {
    // [SPLIT-1] Sama seperti calibrateScenario() — train/val sekarang SATU
    // partisi bersama dengan RSRP (dari runKalibrasi()), bukan seed
    // independen (dulu 101/102). Fungsi ini cuma validasi ukuran.
    if (trainPoints.length < MIN_CALIB_POINTS || valPoints.length < MIN_VAL_POINTS) {
      console.warn(`[Kalibrasi SINR] ${scenarioLabel}: train=${trainPoints.length} val=${valPoints.length} tidak cukup, dilewati.`);
      return null;
    }

    const toRow = r => {
      const d2D = parseFloat(r.distance);
      const hBS = r._serving?.siteHeight || 30;
      const d3D = Math.sqrt(d2D*d2D + (hBS-CAL.MOBILE_H)**2);
      return { r, d2D, sinr_actual: r.sinr_actual, log_d3D: Math.log10(Math.max(d3D, 1)) };
    };
    const trainRows = trainPoints.map(toRow);

    // Filter outlier ±2.5σ berdasarkan distribusi SINR aktual di train set.
    const sinrVals = trainRows.map(d => d.sinr_actual);
    const sMean = mean(sinrVals);
    const sStd  = sdF(sinrVals);
    const filt  = trainRows.filter(d => Math.abs(d.sinr_actual - sMean) <= 2.5*sStd);

    if (filt.length < MIN_CALIB_AFTER_FILTER) {
      console.warn(`[Kalibrasi SINR] ${scenarioLabel}: tersisa ${filt.length} titik training setelah filter outlier, dilewati.`);
      return null;
    }

    const X = filt.map(d => [1, d.log_d3D]);
    const y = filt.map(d => d.sinr_actual);
    const [K1, K2] = leastSquares(X, y);

    // Sanity check fisik: K2 harus cukup negatif.
    if (K2 > MAX_PLAUSIBLE_K2_SINR) {
      console.warn(`[Kalibrasi SINR] ${scenarioLabel}: K2=${K2.toFixed(2)} tidak cukup negatif (maks ${MAX_PLAUSIBLE_K2_SINR}) — SINR tidak menunjukkan pola menurun terhadap jarak yang masuk akal. Kalibrasi SINR dibatalkan untuk skenario ini.`);
      return null;
    }

    const trainDistances = filt.map(d => d.d2D);
    const minD2D = Math.min(...trainDistances);
    const maxD2D = Math.max(...trainDistances);

    return {
      K1, K2, minD2D, maxD2D,
      nTrain: filt.length, nTrainRaw: trainPoints.length,
      nVal: valPoints.length,
      nTotal: trainPoints.length + valPoints.length,
      valPoints,
    };
  }

  // Hitung SINR terkalibrasi langsung dari model regresi di atas.
  function sinrCalibratedDirect(coef, d2D, hBS) {
    const d   = Math.max(d2D, 10);
    const d3D = Math.sqrt(d*d + (hBS-CAL.MOBILE_H)**2);
    return coef.K1 + coef.K2 * Math.log10(d3D);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // [CAL-1][FIX-2] RUN KALIBRASI — UMa & UMi dihitung terpisah, masing-masing
  // pakai titik DT aktual miliknya sendiri, dengan train/val split.
  // ═════════════════════════════════════════════════════════════════════════
  function runKalibrasi() {
    if (!simResults.length) { alert('Jalankan Simulasi SS-RSRP terlebih dahulu!'); return; }

    const pairedR = simResults.filter(r => r.rsrp_actual != null);
    if (pairedR.length < MIN_CALIB_POINTS) {
      alert(`Data aktual RSRP terlalu sedikit (minimal ${MIN_CALIB_POINTS} titik).`);
      return;
    }

    // [SPLIT-1] Reset tag split ke default 'n_a' dulu di SEMUA titik —
    // dipakai sebagai kolom Split_Kalibrasi di export CSV. Titik yang tidak
    // masuk skenario UMa/UMi manapun, atau tidak punya data aktual sama
    // sekali, tetap 'n_a' (tidak pernah ikut proses kalibrasi).
    simResults.forEach(r => { r._splitKalib = 'n_a'; });

    const pairedOther = simResults.filter(r => {
      const s = (r.scenario_used || '').toLowerCase();
      const hasActual = r.rsrp_actual != null || r.sinr_actual != null;
      return hasActual && s !== 'uma' && s !== 'umi';
    });

    // [SPLIT-1] SATU partisi train/val per skenario (bukan seed terpisah
    // RSRP vs SINR seperti sebelumnya) — dipakai BERSAMA oleh kalibrasi
    // RSRP dan SINR. Populasi yang displit = semua titik skenario itu yang
    // punya RSRP_aktual DAN/ATAU SINR_aktual, supaya status train/val satu
    // titik konsisten untuk kedua metrik (satu titik DT = satu event
    // pengukuran, bukan dua populasi independen).
    const scenarioSplits = {};
    ['UMa', 'UMi'].forEach(label => {
      const scLower = label.toLowerCase();
      const scenPoints = simResults.filter(r =>
        (r.scenario_used || '').toLowerCase() === scLower &&
        (r.rsrp_actual != null || r.sinr_actual != null)
      );
      if (!scenPoints.length) { scenarioSplits[label] = null; return; }

      const seedOffset = label === 'UMa' ? 1 : 2;
      const { train, val } = trainValSplit(scenPoints, seedOffset);
      train.forEach(r => { r._splitKalib = 'train'; });
      val.forEach(r => { r._splitKalib = 'val'; });

      scenarioSplits[label] = {
        trainR: train.filter(r => r.rsrp_actual != null),
        valR: val.filter(r => r.rsrp_actual != null),
        trainS: train.filter(r => r.sinr_actual != null),
        valS: val.filter(r => r.sinr_actual != null),
      };
    });

    const pairedUMa     = scenarioSplits.UMa ? [...scenarioSplits.UMa.trainR, ...scenarioSplits.UMa.valR] : [];
    const pairedUMi     = scenarioSplits.UMi ? [...scenarioSplits.UMi.trainR, ...scenarioSplits.UMi.valR] : [];
    const pairedSinrUMa = scenarioSplits.UMa ? [...scenarioSplits.UMa.trainS, ...scenarioSplits.UMa.valS] : [];
    const pairedSinrUMi = scenarioSplits.UMi ? [...scenarioSplits.UMi.trainS, ...scenarioSplits.UMi.valS] : [];

    calibCoefUMa = scenarioSplits.UMa ? calibrateScenario(scenarioSplits.UMa.trainR, scenarioSplits.UMa.valR, 'UMa') : null;
    calibCoefUMi = scenarioSplits.UMi ? calibrateScenario(scenarioSplits.UMi.trainR, scenarioSplits.UMi.valR, 'UMi') : null;

    // [FIX-7] Kalibrasi SINR LANGSUNG — model regresinya independen dari
    // RSRP (target sinr_actual, bukan turunan RSRP interferer), TAPI
    // sekarang partisi train/val-nya SAMA dengan RSRP (lihat [SPLIT-1]).
    calibCoefSinrUMa = scenarioSplits.UMa ? calibrateScenarioSINR(scenarioSplits.UMa.trainS, scenarioSplits.UMa.valS, 'UMa') : null;
    calibCoefSinrUMi = scenarioSplits.UMi ? calibrateScenarioSINR(scenarioSplits.UMi.trainS, scenarioSplits.UMi.valS, 'UMi') : null;

    if (!calibCoefUMa && !calibCoefUMi && !calibCoefSinrUMa && !calibCoefSinrUMi) {
      alert(
        'Kalibrasi gagal total untuk RSRP maupun SINR di semua skenario — kemungkinan penyebab: ' +
        'data aktual per skenario tidak cukup untuk train/val split yang valid, ATAU koefisien hasil ' +
        'fitting tidak masuk akal secara fisik. Cek console log untuk detail per skenario.'
      );
      return;
    }

    // Terapkan ke SEMUA titik simulasi. RSRP dan SINR dikalibrasi SECARA
    // TERPISAH dan INDEPENDEN — satu bisa berhasil sementara yang lain gagal
    // untuk skenario yang sama, direfleksikan lewat dua flag terpisah
    // (kalib_applied untuk RSRP/PL, kalib_applied_sinr untuk SINR).
    calibResults = simResults.map(r => {
      const scLower = (r.scenario_used || '').toLowerCase();

      // ---- RSRP / Path Loss (SPM tuning, seperti sebelumnya) ----
      const rsrpCoef = scLower === 'uma' ? calibCoefUMa : scLower === 'umi' ? calibCoefUMi : null;
      const cellsKalib = (r.cells || []).map(c => {
        const cc = calibrateCellRsrp(c);
        return { ...c, rsrp_kalib: cc.rsrpKalib, pl_kalib: cc.pl, kalib_applied_cell: cc.applied };
      });
      const servingKalib = cellsKalib.find(c => c.siteId === r.serving_site) || cellsKalib[0];
      const rsrpApplied = !!(rsrpCoef && servingKalib && servingKalib.kalib_applied_cell);
      const rsrp_k = rsrpApplied ? servingKalib.rsrp_kalib : parseFloat(r.rsrp_sim);
      const pl_k   = rsrpApplied ? servingKalib.pl_kalib   : parseFloat(r.pl);

      // ---- SINR LANGSUNG (independen, [FIX-7]) ----
      const sinrCoef = scLower === 'uma' ? calibCoefSinrUMa : scLower === 'umi' ? calibCoefSinrUMi : null;
      let sinr_k = parseFloat(r.sinr_sim);
      let sinrApplied = false;
      if (sinrCoef) {
        const d2D = parseFloat(r.distance);
        const hBS = r._serving?.siteHeight || 30;
        const lo  = sinrCoef.minD2D * (1 - EXTRAP_MARGIN);
        const hi  = sinrCoef.maxD2D * (1 + EXTRAP_MARGIN);
        if (d2D >= lo && d2D <= hi) {
          sinr_k = sinrCalibratedDirect(sinrCoef, d2D, hBS);
          sinrApplied = true;
        }
      }

      return {
        ...r,
        rsrp_kalib: rsrp_k.toFixed(1),
        sinr_kalib: sinr_k.toFixed(1),
        pl_kalib  : pl_k.toFixed(1),
        kalib_applied     : rsrpApplied ? scLower.toUpperCase() : 'no',
        kalib_applied_sinr: sinrApplied ? scLower.toUpperCase() : 'no',
        cells_kalib: cellsKalib,
      };
    });

    calibDone = true;
    calibViewMode = 'before'; // biarkan user bandingkan manual lewat toggle

    // [FIX-2][FIX-7] buildMetricPair generik — menerima nama field "applied"
    // supaya bisa dipakai untuk RSRP (kalib_applied) maupun SINR
    // (kalib_applied_sinr) secara independen, masing-masing dengan
    // validation set-nya sendiri (tidak lagi dipaksa berbagi val set RSRP).
    const buildMetricPair = (valSet, simKey, actualKey, kalibKey, appliedField) => {
      if (!valSet.length) return null;
      const valIdxSet = new Set(valSet.map(r => r.index));
      const valWithKalib = calibResults.filter(cr => valIdxSet.has(cr.index) && cr[actualKey] != null);
      if (!valWithKalib.length) return null;

      // [SPLIT-3] FIX: before dan after HARUS dihitung dari titik yang
      // IDENTIK. Sebelumnya diffsB dihitung dari valWithKalib (belum
      // difilter guard-rail ekstrapolasi) sementara diffsA dari afterRows
      // (sudah difilter) — kalau ada titik val di luar rentang jarak
      // training, n before dan n after diam-diam beda walau tabel cuma
      // menampilkan SATU angka N. Sekarang: filter DULU ke titik yang
      // benar-benar menerima kalibrasi, baru hitung diffsB & diffsA dari
      // subset yang sama persis — before vs after dijamin apple-to-apple.
      const appliedRows = valWithKalib.filter(r => r[appliedField] !== 'no');
      if (!appliedRows.length) return null;

      const diffsB = appliedRows.map(r => parseFloat(r[simKey]) - r[actualKey]);
      const diffsA = appliedRows.map(r => parseFloat(r[kalibKey]) - r[actualKey]);
      return {
        meB: mean(diffsB), sdB: sdF(diffsB), rmseB: rmseF(diffsB),
        meA: mean(diffsA), sdA: sdF(diffsA), rmseA: rmseF(diffsA),
        n: appliedRows.length,
        nDroppedExtrapolated: valWithKalib.length - appliedRows.length,
      };
    };

    const groups = [];
    ['UMa', 'UMi'].forEach(label => {
      const rsrpCoef = label === 'UMa' ? calibCoefUMa : calibCoefUMi;
      const sinrCoef = label === 'UMa' ? calibCoefSinrUMa : calibCoefSinrUMi;
      if (!rsrpCoef && !sinrCoef) return;

      const rsrp = rsrpCoef
        ? buildMetricPair(rsrpCoef.valPoints, 'rsrp_sim', 'rsrp_actual', 'rsrp_kalib', 'kalib_applied')
        : null;
      const sinr = sinrCoef
        ? buildMetricPair(sinrCoef.valPoints, 'sinr_sim', 'sinr_actual', 'sinr_kalib', 'kalib_applied_sinr')
        : null;

      groups.push({ label, rsrpCoef, sinrCoef, rsrp, sinr });
    });

    // Overall = gabungan val set RSRP dan SINR masing-masing dari skenario
    // yang berhasil dikalibrasi (independen satu sama lain).
    const overallValRsrp = [];
    const overallValSinr = [];
    if (calibCoefUMa) overallValRsrp.push(...calibCoefUMa.valPoints);
    if (calibCoefUMi) overallValRsrp.push(...calibCoefUMi.valPoints);
    if (calibCoefSinrUMa) overallValSinr.push(...calibCoefSinrUMa.valPoints);
    if (calibCoefSinrUMi) overallValSinr.push(...calibCoefSinrUMi.valPoints);
    const overallRsrp = buildMetricPair(overallValRsrp, 'rsrp_sim', 'rsrp_actual', 'rsrp_kalib', 'kalib_applied');
    const overallSinr = buildMetricPair(overallValSinr, 'sinr_sim', 'sinr_actual', 'sinr_kalib', 'kalib_applied_sinr');

    renderKalibrasiPanel({
      groups,
      overall: (overallRsrp || overallSinr) ? { rsrp: overallRsrp, sinr: overallSinr } : null,
      nSkippedOther: pairedOther.length,
      nUMaSkipped: !calibCoefUMa && pairedUMa.length > 0,
      nUMiSkipped: !calibCoefUMi && pairedUMi.length > 0,
      nSinrUMaSkipped: !calibCoefSinrUMa && pairedSinrUMa.length > 0,
      nSinrUMiSkipped: !calibCoefSinrUMi && pairedSinrUMi.length > 0,
    });

    enableBtn('btnExportCSV');
    showCalibViewToggle(true);
    setCalibView('before'); // pastikan tombol & peta konsisten, user tinggal klik "After Kalibrasi"
  }

  // ═════════════════════════════════════════════════════════════════════════
  // [CAL-1][FIX-2][FIX-7] RENDER PANEL KALIBRASI — satu blok per skenario
  // (UMa/UMi), masing-masing menampilkan kalibrasi RSRP (SPM tuning) dan
  // kalibrasi SINR (regresi langsung) sebagai dua bagian TERPISAH, karena
  // keduanya sekarang independen (bisa berhasil/gagal sendiri-sendiri).
  // ═════════════════════════════════════════════════════════════════════════
  function renderKalibrasiPanel({ groups, overall, nSkippedOther, nUMaSkipped, nUMiSkipped, nSinrUMaSkipped, nSinrUMiSkipped }) {
    const old = byId('kalibPanel');
    if (old) old.remove();

    const box = byId('resultBox');
    if (!box) return;

    const sign = v => v>=0?'+':'';
    const deltaCell = (b,a) => {
      const d = a-b;
      const cls = d<0 ? 'td-delta-good' : 'td-delta-warn';
      return `<span class="${cls}">${d>0?'+':''}${d.toFixed(2)}</span>`;
    };

    const renderMetricTable = (m) => `
      <table class="kalib-table">
        <thead><tr><th>Metrik</th><th>Before</th><th>After</th><th>Δ</th></tr></thead>
        <tbody>
          <tr>
            <td>ME (dB)</td>
            <td class="td-before">${sign(m.meB)}${m.meB.toFixed(2)}</td>
            <td class="td-after">${sign(m.meA)}${m.meA.toFixed(2)}</td>
            <td>${deltaCell(m.meB,m.meA)}</td>
          </tr>
          <tr>
            <td>SD (dB)</td>
            <td class="td-before">${m.sdB.toFixed(2)}</td>
            <td class="td-after">${m.sdA.toFixed(2)}</td>
            <td>${deltaCell(m.sdB,m.sdA)}</td>
          </tr>
          <tr>
            <td><b>RMSE (dB)</b></td>
            <td class="td-before"><b>${m.rmseB.toFixed(2)}</b></td>
            <td class="td-after"><b>${m.rmseA.toFixed(2)}</b></td>
            <td><b>${deltaCell(m.rmseB,m.rmseA)}</b></td>
          </tr>
        </tbody>
      </table>`;

    // [CAL-7][FIX-7] blok metrik + improvement note, dipakai untuk RSRP maupun SINR
    const renderMetricBlock = (m, metricLabel, unit, scLabel) => {
      if (!m) {
        return `<div style="font-size:10px;opacity:0.5;margin-top:6px;">Tidak ada data ${metricLabel} aktual (validation set) untuk ${scLabel}.</div>`;
      }
      const rmseImprove = (m.rmseB - m.rmseA).toFixed(2);
      const pctImprove  = m.rmseB !== 0 ? (((m.rmseB - m.rmseA)/m.rmseB)*100).toFixed(1) : '0.0';
      return `
        <div style="font-size:10px;color:rgba(255,255,255,0.55);margin:8px 0 4px;">
          ${metricLabel} ${scLabel} — Before vs After Kalibrasi <b>(validation set, n=${m.n}, tidak dipakai fitting)</b>
        </div>
        ${renderMetricTable(m)}
        <div class="kalib-improve">
          ${pctImprove >= 0 ? '✅' : '⚠️'} RMSE ${metricLabel} ${scLabel} ${rmseImprove >= 0 ? 'turun' : 'naik'} ${Math.abs(rmseImprove)} ${unit} (${pctImprove}% ${pctImprove >= 0 ? 'improvement' : 'memburuk'}) — out-of-sample
        </div>
        ${m.nDroppedExtrapolated > 0 ? `<div style="font-size:9px;color:#ffcc80;margin-top:5px;">⚠️ ${m.nDroppedExtrapolated} titik validation di luar rentang jarak training (guard rail ekstrapolasi) — dikeluarkan dari before &amp; after supaya n tetap identik di kedua sisi.</div>` : ''}`;
    };

    // [FIX-7] Kotak koefisien RSRP (SPM tuning) — hanya tampil kalau rsrpCoef ada
    const renderRsrpCoefBox = (coef, label) => !coef ? '' : `
          <div class="kalib-coef-box">
            <b>📐 Kalibrasi RSRP (SPM Tuning)</b><br>
            PL = K1 + K2·log(d3D)
            <span style="opacity:0.55;font-size:9px;"> (fc &amp; hBS tidak disertakan sebagai variabel regresi — lihat catatan di bawah)</span><br>
            K1=${coef.K1.toFixed(2)} | K2=${coef.K2.toFixed(2)}<br>
            <span style="opacity:0.6;font-size:9px;">
              Training: ${coef.nTrain}/${coef.nTrainRaw} |
              Validation: ${coef.nVal} titik (tidak dipakai fitting) | Total data aktual RSRP ${label}: ${coef.nTotal}<br>
            </span>
          </div>`;

    // [FIX-7] Kotak koefisien SINR (regresi langsung) — independen dari RSRP,
    // hanya tampil kalau sinrCoef ada. Catatan: SINR = K1 + K2·log(d3D_serving),
    // K2 diharapkan NEGATIF (SINR menurun seiring jarak dari serving).
    const renderSinrCoefBox = (coef, label) => !coef ? '' : `
          <div class="kalib-coef-box" style="border-color:rgba(105,240,174,0.35);">
            <b>📶 Kalibrasi SINR (Regresi Langsung)</b>
            <span style="opacity:0.55;font-size:9px;"> — di-fit langsung dari sinr_actual, independen dari RSRP interferer</span><br>
            SINR = K1 + K2·log(d3D_serving)<br>
            K1=${coef.K1.toFixed(2)} | K2=${coef.K2.toFixed(2)}<br>
            <span style="opacity:0.6;font-size:9px;">
              Training: ${coef.nTrain}/${coef.nTrainRaw} |
              Validation: ${coef.nVal} titik (tidak dipakai fitting) | Total data aktual SINR ${label}: ${coef.nTotal}<br>
            </span>
          </div>`;

    const groupHtml = groups.map(g => `
        <div class="kalib-group">
          <div class="kalib-title">📊 Skenario — ${g.label}</div>
          ${renderRsrpCoefBox(g.rsrpCoef, g.label)}
          ${renderMetricBlock(g.rsrp, 'SS-RSRP', 'dB', g.label)}
          ${renderSinrCoefBox(g.sinrCoef, g.label)}
          ${renderMetricBlock(g.sinr, 'SS-SINR', 'dB', g.label)}
        </div>`).join('');

    const overallHtml = (overall && groups.length > 1) ? `
        <div class="kalib-group">
          <div class="kalib-title">📊 Gabungan (UMa + UMi, validation set)</div>
          ${renderMetricBlock(overall.rsrp, 'SS-RSRP', 'dB', 'gabungan')}
          ${renderMetricBlock(overall.sinr, 'SS-SINR', 'dB', 'gabungan')}
        </div>` : '';

    const warnParts = [];
    if (nUMaSkipped) warnParts.push('RSRP UMa dilewati (data kurang atau K2 tidak masuk akal secara fisik)');
    if (nUMiSkipped) warnParts.push('RSRP UMi dilewati (data kurang atau K2 tidak masuk akal secara fisik)');
    if (nSinrUMaSkipped) warnParts.push('SINR UMa dilewati (data kurang atau K2 tidak menunjukkan pola menurun terhadap jarak)');
    if (nSinrUMiSkipped) warnParts.push('SINR UMi dilewati (data kurang atau K2 tidak menunjukkan pola menurun terhadap jarak)');
    if (nSkippedOther) warnParts.push(`${nSkippedOther} titik skenario lain (mis. RMa) tidak dikalibrasi`);
    const warnHtml = warnParts.length
      ? `<div style="font-size:10px;color:#ffcc80;background:rgba(255,152,0,0.08);border:1px solid rgba(255,152,0,0.25);border-radius:6px;padding:6px 9px;margin-bottom:8px;">⚠️ ${warnParts.join(' | ')}</div>`
      : '';

    const panel = document.createElement('div');
    panel.id        = 'kalibPanel';
    panel.className = 'kalib-panel';
    panel.innerHTML = `
      ${warnHtml}
      ${groupHtml}
      ${overallHtml}
      <div style="margin-top:8px;font-size:9px;color:rgba(255,255,255,0.35);line-height:1.6;">
        Ref: SPM tuning methodology | 3GPP TR 38.901 §7.4<br>
        <b>Satu partisi train/val per skenario</b> (${Math.round(CALIB_TRAIN_RATIO*100)}% / ${Math.round((1-CALIB_TRAIN_RATIO)*100)}%,
        seed tetap) dipakai BERSAMA oleh kalibrasi RSRP dan SINR — satu titik drive test adalah satu event pengukuran,
        jadi status train/val-nya konsisten untuk kedua metrik, bukan diacak independen.
      </div>`;

    box.insertAdjacentElement('afterend', panel);
    panel.scrollIntoView({behavior:'smooth', block:'nearest'});
  }


  // ═════════════════════════════════════════════════════════════════════════
  // [CAL-4] EXPORT CSV — nama disatukan jadi exportCSV() (dipanggil oleh
  // listener tombol #btnExportCSV). Menambahkan kolom kalibrasi bila ada.
  // ═════════════════════════════════════════════════════════════════════════
  function exportCSV() {
    const data = calibDone ? calibResults : simResults;
    if (!data.length) return alert('Jalankan simulasi terlebih dahulu!');

    const hasActR  = data.some(r=>r.rsrp_actual!=null);
    const hasActS  = data.some(r=>r.sinr_actual!=null);

    let csv = 'No,Latitude,Longitude,Serving_Site,Serving_Sector,PCI,ARFCN,Cell_ID,Cell_Name,';
    csv += 'Distance_to_Serving(m),Scenario,Condition,N_Dominant_Interferer,';
    csv += 'Antenna_Pattern_Gain(dB),Path_Loss(dB),Clutter_Loss(dB),Sigma_SF(dB),Shadow_xi(dB),';
    csv += 'G_E_max(dBi),Cable_Loss(dB),RSRP_Sim(dBm),SINR_Sim(dB)';

    // [SPLIT-2] Split_Kalibrasi (train/val/n_a) ditambahkan di sini supaya
    // konsumen CSV (mis. halaman Evaluasi multisite) bisa membedakan
    // metrik "Model Murni" (semua baris) dari "Evaluasi Kalibrasi"
    // (cuma baris Split_Kalibrasi='val') tanpa perlu menebak.
    if (calibDone) csv += ',Kalibrasi_Diterapkan,PL_Kalibrasi(dB),RSRP_Kalibrasi(dBm),SINR_Kalibrasi(dB),Split_Kalibrasi';
    if (hasActR)   csv += ',RSRP_Aktual(dBm),Delta_RSRP_Sim(dB)';
    if (hasActR && calibDone) csv += ',Delta_RSRP_Kalib(dB)';
    if (hasActS)   csv += ',SINR_Aktual(dB),Delta_SINR_Sim(dB)';
    if (hasActS && calibDone) csv += ',Delta_SINR_Kalib(dB)';
    csv += '\n';

    data.forEach(r => {
      const sv    = r._serving;
      const pci   = sv?.pci    != null ? sv.pci    : '';
      const arfcn = sv?.arfcn  != null ? sv.arfcn  : 466850;
      const cId   = sv?.cellId != null ? sv.cellId : '';
      const cName = (sv?.cellName||`${r.serving_site}_Sek${r.serving_sector}`).replace(/"/g,"'");

      csv += `${r.index},${r.lat},${r.lng},${r.serving_site},${r.serving_sector},`;
      csv += `${pci},${arfcn},${cId},"${cName}",`;
      csv += `${r.distance},${r.scenario_used},${r.condition_used},${r.n_dominant},`;
      csv += `${r.gainDb},${r.pl},${r.cl},${r.sigma},${r.xi},`;
      csv += `${CAL.ANTENNA_GAIN},${CAL.CABLE_LOSS},${r.rsrp_sim},${r.sinr_sim}`;

      if (calibDone) {
        csv += `,${r.kalib_applied??'no'},${r.pl_kalib??''},${r.rsrp_kalib??''},${r.sinr_kalib??''},${r._splitKalib||'n_a'}`;
      }
      if (hasActR) {
        const dSim = r.rsrp_actual!=null
          ? (parseFloat(r.rsrp_sim)-r.rsrp_actual).toFixed(2) : '';
        csv += `,${r.rsrp_actual??''},${dSim}`;
        if (calibDone) {
          const dKal = r.rsrp_actual!=null && r.rsrp_kalib!=null
            ? (parseFloat(r.rsrp_kalib)-r.rsrp_actual).toFixed(2) : '';
          csv += `,${dKal}`;
        }
      }
      if (hasActS) {
        const dSim = r.sinr_actual!=null
          ? (parseFloat(r.sinr_sim)-r.sinr_actual).toFixed(2) : '';
        csv += `,${r.sinr_actual??''},${dSim}`;
        if (calibDone) {
          const dKalS = r.sinr_actual!=null && r.sinr_kalib!=null
            ? (parseFloat(r.sinr_kalib)-r.sinr_actual).toFixed(2) : '';
          csv += `,${dKalS}`;
        }
      }
      csv += '\n';
    });

    const blob = new Blob([csv],{type:'text/csv'});
    const ts   = new Date().toISOString().slice(0,19).replace(/:/g,'-');
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `Simulasi_DT${calibDone?'_KALIB':''}_${primarySite?.id||'site'}_${ts}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(a.href);
  }

  function exportDtClean() {
    if(!dtPoints?.length){alert('Tidak ada data.');return;}
    const rows=dtPoints.map((p,i)=>({No:i+1,Latitude:p.lat,Longitude:p.lng,RSRP:p.rsrp??'',SINR:p.sinr??''}));
    const csv=typeof Papa!=='undefined'
      ?Papa.unparse(rows)
      :'No,Latitude,Longitude,RSRP,SINR\n'+rows.map(r=>`${r.No},${r.Latitude},${r.Longitude},${r.RSRP},${r.SINR}`).join('\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}),ts=new Date().toISOString().replace(/[:.]/g,'-');
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`DT_CLEAN_${ts}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(a.href);
  }

  // ── Site Rendering ────────────────────────────────────────────────────────
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
        siteMap[sec.siteId] = { siteId: sec.siteId, lat: sec.siteLat, lng: sec.siteLng, isMain: sec.isMain, sectors: [] };
      }
      siteMap[sec.siteId].sectors.push(sec);
    });

    Object.entries(siteIndex).forEach(([id, s]) => {
      const isPrimary   = id === primaryId;
      const isNeighbour = neighbourPool.some(nb => nb.id === id);
      L.circleMarker([s.lat, s.lng], {
        radius: isPrimary ? 13 : isNeighbour ? 8 : 4,
        fillColor: isPrimary ? '#ffd000' : isNeighbour ? '#ff8c00' : '#aab8d8',
        color: isPrimary ? '#000' : '#444',
        weight: isPrimary ? 3 : isNeighbour ? 2 : 1,
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
        drawSectorFan(site.lat, site.lng, sec.azimuth, 65,
          site.isMain ? 100 : 100, i,
          site.isMain ? 0.18 : 0.20,
          sec.pciColor);
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

  // ── Geo Utils ─────────────────────────────────────────────────────────────
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
    if(v>=-85) return '#0042a5'; if(v>=-95) return '#00a955';
    if(v>=-105) return '#70ff66'; if(v>=-120) return '#fffb00';
    if(v>=-125) return '#ff3333'; return '#800000';
  }
  function sinrColor(v){
    if(v>=20) return '#0042a5'; if(v>=10) return '#00a955';
    if(v>=0)  return '#70ff66'; if(v>=-5) return '#fffb00';
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

console.log('dtsimulation.js v30.0 — 1 partisi train/val (RSRP+SINR), fix konsistensi N before vs after, export Split_Kalibrasi');