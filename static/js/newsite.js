// ================================================
// NEW SITE PLANNING JAVASCRIPT v3.0
// Model propagasi: 3GPP TR 38.901 (UMa/UMi/RMa LOS/NLOS)
//
// PERUBAHAN v3.0:
//   - Parameter RF (TX_POWER, FREQUENCY, MOBILE_H, ANTENNA_Am,
//     SINR calibration, CLUTTER params) dibaca dari DOM, bukan hardcoded.
//   - CAL_DEFAULTS hanya dipakai sebagai nilai awal input HTML.
//   - getCAL() membaca nilai live dari form setiap kali render.
//   - toggleAdvancedRF() untuk collapse/expand panel lanjutan.
// ================================================

let map;
let sectorLayer, coverageLayer;
let newSiteMarker       = null;
let currentSiteLocation = null;
let currentCoverageType = 'rsrp';
let sectorCount         = 3;
let azimuths            = [];

let planningMode  = 'manual';
let activeGapData = null;

const BEAMWIDTH = 35;

const SECTOR_COLORS = [
  '#ff2d55', '#00c7be', '#ffcc00',
  '#af52de', '#ff9500', '#34c759'
];

// ================================================
// DEFAULT CALIBRATION CONSTANTS
// ================================================
const CAL_DEFAULTS = {
  TX_POWER      : 46,
  FREQUENCY     : 2300,
  MOBILE_H      : 1.5,
  ANTENNA_Am    : 15,
  SINR_P_GOOD   : 0.60,
  SINR_GOOD_BASE: 20,
  SINR_GOOD_STD : 5.5,
  SINR_BAD_BASE : 6,
  SINR_BAD_STD  : 4.5,
  SINR_SLOPE    : 0.2,
  SINR_RSRP_REF : -90,
  SINR_FLOOR    : -10,
  SINR_CEIL     : 30,
  CLUTTER_REF_M : 100,
  CLUTTER_COEF  : 3.5,
  SHADOW_STD_MAP: {
    uma_los: 4.0, uma_nlos: 6.0,
    umi_los: 4.0, umi_nlos: 7.82,
    rma_los: 4.0, rma_nlos: 8.0,
  },
};

// ================================================
// getCAL() — baca parameter RF live dari DOM
// ================================================
function getCAL() {
  function num(id, def) {
    const el = document.getElementById(id);
    if (!el) return def;
    const v = parseFloat(el.value);
    return isFinite(v) ? v : def;
  }
  return {
    TX_POWER      : num("txPower",   CAL_DEFAULTS.TX_POWER),
    FREQUENCY     : num("frequency", CAL_DEFAULTS.FREQUENCY),
    BANDWIDTH     : num("bandwidth", 20),
    MOBILE_H      : num("mobileH",   CAL_DEFAULTS.MOBILE_H),
    ANTENNA_Am    : num("antennaAm",    CAL_DEFAULTS.ANTENNA_Am),
    SINR_P_GOOD   : CAL_DEFAULTS.SINR_P_GOOD,
    SINR_GOOD_BASE: num("sinrGoodBase", CAL_DEFAULTS.SINR_GOOD_BASE),
    SINR_GOOD_STD : num("sinrGoodStd",  CAL_DEFAULTS.SINR_GOOD_STD),
    SINR_BAD_BASE : num("sinrBadBase",  CAL_DEFAULTS.SINR_BAD_BASE),
    SINR_BAD_STD  : num("sinrBadStd",   CAL_DEFAULTS.SINR_BAD_STD),
    SINR_SLOPE    : CAL_DEFAULTS.SINR_SLOPE,
    SINR_RSRP_REF : CAL_DEFAULTS.SINR_RSRP_REF,
    SINR_FLOOR    : CAL_DEFAULTS.SINR_FLOOR,
    SINR_CEIL     : CAL_DEFAULTS.SINR_CEIL,
    CLUTTER_REF_M : num("clutterRefM", CAL_DEFAULTS.CLUTTER_REF_M),
    CLUTTER_COEF  : num("clutterCoef", CAL_DEFAULTS.CLUTTER_COEF),
    SHADOW_STD_MAP: CAL_DEFAULTS.SHADOW_STD_MAP,
  };
}

// ================================================
// CLUTTER MAP
// ================================================
const CLUTTER_MAP = {
  'dense_urban' : { scenario: 'umi', condition: 'nlos',     label: 'Dense Urban'  },
  'metropolitan': { scenario: 'umi', condition: 'nlos',     label: 'Metropolitan' },
  'urban'       : { scenario: 'uma', condition: 'nlos',     label: 'Urban'        },
  'sub_urban'   : { scenario: 'uma', condition: 'los_nlos', label: 'Sub Urban'    },
  'rural'       : { scenario: 'rma', condition: 'los',      label: 'Rural'        },
};

const CLUTTER_LABEL_TO_KEY = {
  'dense urban' : 'dense_urban',
  'metropolitan': 'metropolitan',
  'urban'       : 'urban',
  'sub urban'   : 'sub_urban',
  'suburban'    : 'sub_urban',
  'rural'       : 'rural',
  'open'        : 'rural',
};

function resolveClutter(key) {
  return CLUTTER_MAP[key] || { scenario: 'uma', condition: 'nlos', label: 'Urban' };
}

function clutterLabelToKey(label) {
  if (!label) return 'urban';
  const n = label.toLowerCase().trim();
  if (CLUTTER_MAP[n]) return n;
  if (CLUTTER_LABEL_TO_KEY[n]) return CLUTTER_LABEL_TO_KEY[n];
  for (const [k, v] of Object.entries(CLUTTER_MAP)) {
    if (n.includes(k.replace('_',' ')) || v.label.toLowerCase().includes(n)) return k;
  }
  return 'urban';
}

// ================================================
// PATH LOSS — 3GPP TR 38.901
// ================================================
function pathLoss(scenario, condition, dist_m, freq_mhz, hBS, hUT) {
  const d = Math.max(dist_m, 10);
  const f = freq_mhz / 1000;
  const hUT_ = hUT || 1.5;

  switch (scenario) {
    case 'uma': {
      const pl_los  = 28.0 + 22*Math.log10(d) + 20*Math.log10(f);
      const pl_nlos = 13.54 + 39.08*Math.log10(d) + 20*Math.log10(f) - 0.6*(hUT_-1.5);
      if (condition === 'los')      return pl_los;
      if (condition === 'nlos')     return Math.max(pl_nlos, pl_los);
      if (condition === 'los_nlos') {
        const p = Math.exp(-d/200);
        return p*pl_los + (1-p)*Math.max(pl_nlos, pl_los);
      }
      return Math.max(pl_nlos, pl_los);
    }
    case 'umi': {
      const pl_los  = 32.4 + 21*Math.log10(d) + 20*Math.log10(f);
      const pl_nlos = 22.4 + 35.3*Math.log10(d) + 21.3*Math.log10(f) - 0.3*(hUT_-1.5);
      if (condition === 'los')      return pl_los;
      if (condition === 'nlos')     return Math.max(pl_nlos, pl_los);
      if (condition === 'los_nlos') {
        const p = Math.exp(-d/100);
        return p*pl_los + (1-p)*Math.max(pl_nlos, pl_los);
      }
      return Math.max(pl_nlos, pl_los);
    }
    case 'rma': {
      const h=5, W=20;
      const d_BP = 2*Math.PI*hBS*hUT_*(freq_mhz*1e6)/3e8;
      let pl_los;
      if (d <= d_BP) {
        pl_los = 20*Math.log10(40*Math.PI*d*f/3)
          + Math.min(0.03*Math.pow(h,1.72),10)*Math.log10(d)
          - Math.min(0.044*Math.pow(h,1.72),14.77)
          + 0.002*Math.log10(h)*d;
      } else {
        pl_los = 20*Math.log10(40*Math.PI*d_BP*f/3)
          + Math.min(0.03*Math.pow(h,1.72),10)*Math.log10(d_BP)
          - Math.min(0.044*Math.pow(h,1.72),14.77)
          + 0.002*Math.log10(h)*d_BP
          + 40*Math.log10(d/d_BP);
      }
      if (condition === 'los') return pl_los;
      const pl_nlos = 161.04 - 7.1*Math.log10(W) + 7.5*Math.log10(h)
        - (24.37 - 3.7*Math.pow(h/hBS,2))*Math.log10(hBS)
        + (43.42 - 3.1*Math.log10(hBS))*(Math.log10(d)-3)
        + 20*Math.log10(f)
        - (3.2*Math.pow(Math.log10(11.75*hUT_),2) - 4.97);
      return Math.max(pl_nlos, pl_los);
    }
    default:
      return 28.0 + 22*Math.log10(d) + 20*Math.log10(f);
  }
}

// ================================================
// RSRP & SINR
// ================================================
function computeRSRP(dist, antennaHeight, gainDb, scenario, condition) {
  const CAL = getCAL();
  const pl  = pathLoss(scenario, condition, Math.max(dist,10), CAL.FREQUENCY, antennaHeight, CAL.MOBILE_H);
  const clutterLoss = dist > CAL.CLUTTER_REF_M
    ? CAL.CLUTTER_COEF * Math.log10(dist / CAL.CLUTTER_REF_M) : 0;
  const shadowKey = scenario + '_' + (condition === 'los_nlos' ? 'nlos' : condition);
  const shadowStd = CAL.SHADOW_STD_MAP[shadowKey] || 6.0;
  return CAL.TX_POWER + gainDb - pl - clutterLoss + gaussianRandom(0, shadowStd);
}

function computeSINR(dist, rsrp) {
  const CAL       = getCAL();
  const rawOffset = CAL.SINR_SLOPE * (rsrp - CAL.SINR_RSRP_REF);
  const rsrpOff   = Math.max(-4, Math.min(4, rawOffset));
  const distFact  = Math.max(0, (dist-100)/200);
  const dynPGood  = Math.max(0.15, CAL.SINR_P_GOOD - distFact*0.45);
  let sinr = Math.random() < dynPGood
    ? gaussianRandom(CAL.SINR_GOOD_BASE + rsrpOff, CAL.SINR_GOOD_STD)
    : gaussianRandom(CAL.SINR_BAD_BASE  + rsrpOff, CAL.SINR_BAD_STD);
  return Math.max(CAL.SINR_FLOOR, Math.min(CAL.SINR_CEIL, sinr));
}

// ================================================
// COLOR & CATEGORY
// ================================================
function getRSRPColor(v) {
  if (v >= -85)  return '#0042a5';
  if (v >= -95)  return '#00a955';
  if (v >= -105) return '#70ff66';
  if (v >= -120) return '#fffb00';
  if (v >= -140) return '#ff3333';
  return '#800000';
}
function getSINRColor(v) {
  if (v >= 20)  return '#0042a5';
  if (v >= 10)  return '#00a955';
  if (v >= 0)   return '#70ff66';
  if (v >= -5)  return '#fffb00';
  if (v >= -40) return '#ff3333';
  return '#800000';
}
function getRSRPCategory(v) {
  if (v >= -85)  return 'S1';
  if (v >= -95)  return 'S2';
  if (v >= -105) return 'S3';
  if (v >= -120) return 'S4';
  if (v >= -140) return 'S5';
  return 'S6';
}
function getSINRCategory(v) {
  if (v >= 20)  return 'S1';
  if (v >= 10)  return 'S2';
  if (v >= 0)   return 'S3';
  if (v >= -5)  return 'S4';
  if (v >= -40) return 'S5';
  return 'S6';
}
function getCategoryName(cat) {
  return {S1:'Excellent',S2:'Good',S3:'Moderate',S4:'Poor',S5:'Bad',S6:'Very Bad'}[cat]||'Unknown';
}

// ================================================
// INITIALIZATION
// ================================================
document.addEventListener('DOMContentLoaded', function () {
  initializeMap();
  attachEventListeners();
  generateAzimuthInputs();
  updateClutterBadge();
  restoreGapPlanningData();
});

function initializeMap() {
  map = L.map('newsiteMap').setView([-6.2088, 106.8456], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19
  }).addTo(map);
  sectorLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
}

function attachEventListeners() {
  document.getElementById('setSiteLocationBtn')?.addEventListener('click', setSiteFromInput);
  document.getElementById('clearSiteBtn')?.addEventListener('click', clearSite);

  document.getElementById('sectorCount')?.addEventListener('change', function () {
    sectorCount = parseInt(this.value);
    generateAzimuthInputs();
    if (planningMode === 'gap_guided' && activeGapData && currentSiteLocation)
      _applySuggestedAzimuth(currentSiteLocation.lat, currentSiteLocation.lng, activeGapData);
    if (currentSiteLocation) updateSite();
  });

  document.getElementById('antennaHeight')?.addEventListener('input', function () {
    updateHeightBadge();
    if (currentSiteLocation) autoRegenerate();
  });

  document.getElementById('clutterSelect')?.addEventListener('change', function () {
    updateClutterBadge();
    if (currentSiteLocation) autoRegenerate();
  });

  document.getElementById('visualizeRSRP')?.addEventListener('click', () => setActiveVisualization('rsrp'));
  document.getElementById('visualizeSINR')?.addEventListener('click', () => setActiveVisualization('sinr'));
  document.getElementById('gridSize')?.addEventListener('change', autoRegenerate);
  document.getElementById('coverageRadius')?.addEventListener('change', autoRegenerate);


  ['txPower','frequency','mobileH','antennaAm',
   'sinrGoodBase','sinrGoodStd','sinrBadBase','sinrBadStd',
   'clutterRefM','clutterCoef'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (currentSiteLocation) autoRegenerate();
    });
  });

  document.getElementById('btnSuggestAzimuth')?.addEventListener('click', onSuggestAzimuthClick);
  document.getElementById('btnResetManual')?.addEventListener('click', resetToManualMode);
}

// ================================================
// CLUTTER & HEIGHT
// ================================================
function getSelectedClutter() {
  return resolveClutter(document.getElementById('clutterSelect')?.value || 'urban');
}

function updateClutterBadge() {
  const c = getSelectedClutter();
  const el = document.getElementById('paramModel');
  if (el) el.textContent = c.scenario.toUpperCase() + ' ' + c.condition.toUpperCase().replace('_','/');
}

function updateHeightBadge() {
  const h = parseInt(document.getElementById('antennaHeight').value) || 30;
  const el = document.getElementById('heightBadge');
  if (el) el.textContent = h + 'm';
}

// ================================================
// AZIMUTH INPUTS
// ================================================
function generateAzimuthInputs() {
  const container = document.getElementById('azimuthInputs');
  if (!container) return;
  container.innerHTML = '';
  const step = 360 / sectorCount;
  for (let i = 0; i < sectorCount; i++) {
    const defaultAz = Math.round(i * step);
    const color = SECTOR_COLORS[i % SECTOR_COLORS.length];
    const grp = document.createElement('div');
    grp.className = 'azimuth-group';
    grp.innerHTML = `
      <label><span class="sector-dot" style="background:${color}"></span>Sektor ${i+1}</label>
      <input type="number" id="azimuth${i}" value="${defaultAz}" min="0" max="359" step="1">`;
    container.appendChild(grp);
    document.getElementById('azimuth'+i)?.addEventListener('input', () => {
      if (currentSiteLocation) updateSite();
    });
  }
}

function getAzimuths() {
  return Array.from({length: sectorCount}, (_,i) => {
    const v = parseFloat(document.getElementById('azimuth'+i)?.value);
    return isFinite(v) ? v : 0;
  });
}

// ================================================
// MAP INTERACTION
// ================================================
function onMapClick(e) {
  document.getElementById('siteLatitude').value  = e.latlng.lat.toFixed(6);
  document.getElementById('siteLongitude').value = e.latlng.lng.toFixed(6);
  placeSite(e.latlng.lat, e.latlng.lng);
}

function setSiteFromInput() {
  const lat = parseFloat(document.getElementById('siteLatitude').value);
  const lng = parseFloat(document.getElementById('siteLongitude').value);
  if (!isFinite(lat)||!isFinite(lng)) { alert('Masukkan koordinat yang valid'); return; }
  if (lat<-90||lat>90)  { alert('Latitude harus antara -90 dan 90'); return; }
  if (lng<-180||lng>180){ alert('Longitude harus antara -180 dan 180'); return; }
  placeSite(lat, lng);
}

function placeSite(lat, lng) {
  currentSiteLocation = { lat, lng };
  const instr = document.getElementById('mapInstructions');
  if (instr) instr.style.display = 'none';
  const clearBtn = document.getElementById('clearSiteBtn');
  if (clearBtn) clearBtn.style.display = 'flex';

  if (newSiteMarker) map.removeLayer(newSiteMarker);
  const markerIcon = L.divIcon({
    className: '', html: '<div class="new-site-pin"></div>',
    iconSize: [24,24], iconAnchor: [12,24]
  });
  newSiteMarker = L.marker([lat,lng], {icon:markerIcon, draggable:true}).addTo(map);
  newSiteMarker.bindPopup(
    '<b>' + (planningMode==='gap_guided'?'📡 Candidate Site (Gap-Guided)':'📡 Site Baru') + '</b>' +
    '<br>Lat: '+lat.toFixed(6)+'<br>Lng: '+lng.toFixed(6)
  ).openPopup();

  newSiteMarker.on('dragend', function(e) {
    const p = e.target.getLatLng();
    document.getElementById('siteLatitude').value  = p.lat.toFixed(6);
    document.getElementById('siteLongitude').value = p.lng.toFixed(6);
    currentSiteLocation = {lat: p.lat, lng: p.lng};
    if (planningMode==='gap_guided' && activeGapData) {
      _applySuggestedAzimuth(p.lat, p.lng, activeGapData);
      _updateAzimuthSuggestionBadge(p.lat, p.lng, activeGapData);
    }
    updateSite();
  });

  const locEl = document.getElementById('currentLocation');
  const locTx = document.getElementById('locationText');
  if (locEl) locEl.style.display = 'flex';
  if (locTx) locTx.textContent = lat.toFixed(6) + ', ' + lng.toFixed(6);

  map.setView([lat,lng], 16);
  updateSite();
}

function updateSite() {
  if (!currentSiteLocation) return;
  sectorLayer.clearLayers();
  azimuths = getAzimuths();
  azimuths.forEach((az,idx) =>
    drawSectorFan(currentSiteLocation.lat, currentSiteLocation.lng, az, BEAMWIDTH, 200, idx));
  if (planningMode==='gap_guided' && activeGapData) _drawGapCentroidMarker(activeGapData);
  generateCoverage();
}

function clearSite() {
  if (newSiteMarker) { map.removeLayer(newSiteMarker); newSiteMarker=null; }
  sectorLayer.clearLayers();
  if (coverageLayer) { map.removeLayer(coverageLayer); coverageLayer=null; }
  currentSiteLocation = null;
  document.getElementById('siteLatitude').value  = '';
  document.getElementById('siteLongitude').value = '';
  const locEl   = document.getElementById('currentLocation');
  const clearBtn= document.getElementById('clearSiteBtn');
  const instr   = document.getElementById('mapInstructions');
  const legend  = document.getElementById('mapLegend');
  if (locEl)    locEl.style.display    = 'none';
  if (clearBtn) clearBtn.style.display = 'none';
  if (instr)    instr.style.display    = 'block';
  if (legend)   legend.style.display   = 'none';
  document.getElementById('analysisResult').innerHTML =
    '<div class="waiting-state"><i class="fas fa-hand-pointer"></i><p>' +
    (planningMode==='gap_guided'
      ? 'Geser marker ke lokasi kandidat atau klik peta'
      : 'Klik peta atau masukkan koordinat untuk memulai prediksi') +
    '</p></div>';
  ['totalArea','excellentCoverage','goodCoverage','poorCoverage'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = id==='totalArea' ? '0 km²' : '0%';
  });
}

// ================================================
// SECTOR FAN
// ================================================
function drawSectorFan(lat, lng, az, beamwidth, radius, idx) {
  const start = az - beamwidth/2, end = az + beamwidth/2;
  const pts = [[lat,lng]];
  for (let i=0; i<=20; i++) {
    const ang = start + (i/20)*(end-start);
    const p   = destinationPoint(lat, lng, ang, radius);
    pts.push([p.lat, p.lng]);
  }
  pts.push([lat,lng]);
  const color = SECTOR_COLORS[idx % SECTOR_COLORS.length];
  L.polygon(pts, {color, fillColor:color, fillOpacity:0.18, weight:2, opacity:0.7})
    .addTo(sectorLayer)
    .bindPopup('<b>Sektor '+(idx+1)+'</b><br>Azimuth: '+az+'°<br>Beamwidth: '+beamwidth+'°');
}

// ================================================
// GEO UTILITIES
// ================================================
function destinationPoint(lat,lng,az,dist) {
  const R=6378137, brng=az*Math.PI/180, d=dist/R;
  const lat1=lat*Math.PI/180, lng1=lng*Math.PI/180;
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(d)+Math.cos(lat1)*Math.sin(d)*Math.cos(brng));
  const lng2=lng1+Math.atan2(Math.sin(brng)*Math.sin(d)*Math.cos(lat1),Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
  return {lat:lat2*180/Math.PI, lng:lng2*180/Math.PI};
}
function calcDistance(a,b) {
  const R=6378137;
  const lat1=a.lat*Math.PI/180, lat2=b.lat*Math.PI/180;
  const dLat=(b.lat-a.lat)*Math.PI/180, dLng=(b.lng-a.lng)*Math.PI/180;
  const s=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));
}
function bearingTo(lat1,lng1,lat2,lng2) {
  const p1=lat1*Math.PI/180, p2=lat2*Math.PI/180, dl=(lng2-lng1)*Math.PI/180;
  return (Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360;
}
function antennaGainPattern(angOffset) {
  const CAL = getCAL();
  return -Math.min(12*(angOffset/(BEAMWIDTH/2))**2, CAL.ANTENNA_Am);
}
function bestSectorGain(brng, sectors) {
  if (!sectors?.length) return {gain:0, sectorIdx:0};
  let bestGain=-Infinity, bestIdx=0, totalLinear=0;
  sectors.forEach((az,i) => {
    const offset = Math.abs(((brng-az+540)%360)-180);
    const g = antennaGainPattern(offset);
    totalLinear += Math.pow(10, g/10);
    if (g > bestGain) { bestGain=g; bestIdx=i; }
  });
  const bestLinear  = Math.pow(10, bestGain/10);
  const interLinear = Math.max(totalLinear-bestLinear, 1e-9);
  return {gain:bestGain, sectorIdx:bestIdx, interferenceDb:10*Math.log10(interLinear/bestLinear)};
}
function gaussianRandom(mean, std) {
  let u=0,v=0;
  while(!u) u=Math.random(); while(!v) v=Math.random();
  return mean+std*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}

// ================================================
// AZIMUTH SUGGESTION ENGINE
// ================================================
function computeSuggestedAzimuths(siteLat, siteLng, gapData) {
  const brng = bearingTo(siteLat, siteLng, gapData.recommendedLat, gapData.recommendedLng);
  const step = 360 / sectorCount;
  return Array.from({length:sectorCount}, (_,i) => Math.round((brng + step*i) % 360));
}

function _applySuggestedAzimuth(siteLat, siteLng, gapData) {
  computeSuggestedAzimuths(siteLat, siteLng, gapData).forEach((az,i) => {
    const input = document.getElementById('azimuth'+i);
    if (input) input.value = az;
  });
  azimuths = getAzimuths();
}

function _updateAzimuthSuggestionBadge(siteLat, siteLng, gapData) {
  const brng = bearingTo(siteLat, siteLng, gapData.recommendedLat, gapData.recommendedLng);
  const dist = calcDistance({lat:siteLat,lng:siteLng},{lat:gapData.recommendedLat,lng:gapData.recommendedLng});
  const el = document.getElementById('azimuthSuggestionInfo');
  if (el) el.innerHTML = 'Bearing ke gap: <b>'+brng.toFixed(1)+'°</b> &nbsp;|&nbsp; Jarak: <b>'+Math.round(dist)+' m</b>';
}

function onSuggestAzimuthClick() {
  if (!currentSiteLocation) { alert('Tempatkan site di peta terlebih dahulu.'); return; }
  if (!activeGapData) return;
  const suggested = computeSuggestedAzimuths(currentSiteLocation.lat, currentSiteLocation.lng, activeGapData);
  const preview   = suggested.map((az,i) => 'Sektor '+(i+1)+': '+az+'°').join('\n');
  const brng      = bearingTo(currentSiteLocation.lat, currentSiteLocation.lng, activeGapData.recommendedLat, activeGapData.recommendedLng);
  const confirmed = confirm(
    '💡 Saran Azimuth (berbasis arah ke centroid gap)\n\n' +
    'Bearing ke gap: '+brng.toFixed(1)+'°\n\n'+preview+'\n\n' +
    'Sektor 1 diarahkan langsung ke blank spot.\n' +
    'Sektor lain dibagi merata ke arah lain.\n\nTerapkan saran ini?'
  );
  if (confirmed) {
    _applySuggestedAzimuth(currentSiteLocation.lat, currentSiteLocation.lng, activeGapData);
    _updateAzimuthSuggestionBadge(currentSiteLocation.lat, currentSiteLocation.lng, activeGapData);
    updateSite();
    const btn = document.getElementById('btnSuggestAzimuth');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✅ Diterapkan';
      btn.style.cssText += 'background:rgba(52,199,89,0.12);border-color:#34c759;color:#1a7a32;';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = '';
      }, 2500);
    }
  }
}

// ================================================
// GAP CENTROID MARKER
// ================================================
let _gapCentroidMarker = null;

function _drawGapCentroidMarker(gapData) {
  if (_gapCentroidMarker) map.removeLayer(_gapCentroidMarker);
  const isBlank = gapData.gapType === 'blank_spot';
  const color   = isBlank ? '#ff3b30' : '#ff9500';
  _gapCentroidMarker = L.circleMarker(
    [gapData.recommendedLat, gapData.recommendedLng],
    {radius:10, fillColor:color, color:'#fff', weight:2, fillOpacity:0.7}
  ).addTo(sectorLayer)
   .bindTooltip(
    (isBlank?'🚫':'⚠️')+' Centroid Gap #'+gapData.gapIndex+'<br>Avg RSRP: '+gapData.avgRSRP_dBm+' dBm',
    {permanent:false, direction:'top'}
  );
  if (currentSiteLocation) {
    L.polyline(
      [[currentSiteLocation.lat,currentSiteLocation.lng],[gapData.recommendedLat,gapData.recommendedLng]],
      {color, weight:1.5, opacity:0.5, dashArray:'6 4'}
    ).addTo(sectorLayer);
  }
}

// ================================================
// RESTORE GAP PLANNING DATA
// ================================================
const GAP_PLANNING_KEY = 'gapPlanningData';
let _pendingAzimuthSuggest = false;

function restoreGapPlanningData() {
  const saved = sessionStorage.getItem(GAP_PLANNING_KEY);
  if (!saved) { planningMode='manual'; activeGapData=null; _renderModeUI('manual'); return; }

  let data;
  try { data = JSON.parse(saved); }
  catch(e) { sessionStorage.removeItem(GAP_PLANNING_KEY); planningMode='manual'; _renderModeUI('manual'); return; }

  if (!data.recommendedLat || !data.recommendedLng) {
    planningMode='manual'; _renderModeUI('manual'); return;
  }

  planningMode  = 'gap_guided';
  activeGapData = data;

  const latInput = document.getElementById('siteLatitude');
  const lngInput = document.getElementById('siteLongitude');
  if (latInput) latInput.value = data.recommendedLat.toFixed(6);
  if (lngInput) lngInput.value = data.recommendedLng.toFixed(6);

  if (data.nearestSiteHeight) {
    const h = document.getElementById('antennaHeight');
    if (h) { h.value = data.nearestSiteHeight; updateHeightBadge(); }
  }
  if (data.estimatedRadius_m) {
    const suggested = Math.min(Math.max(Math.round(data.estimatedRadius_m*1.2/50)*50, 200), 800);
    const r = document.getElementById('coverageRadius');
    if (r) r.value = suggested;
  }
  if (data.nearestSiteClutter) {
    const key = clutterLabelToKey(data.nearestSiteClutter);
    const sel = document.getElementById('clutterSelect');
    if (sel && CLUTTER_MAP[key]) { sel.value = key; updateClutterBadge(); }
  }

  _renderModeUI('gap_guided', data);
  _pendingAzimuthSuggest = true;
  setTimeout(() => {
    placeSite(data.recommendedLat, data.recommendedLng);
    if (_pendingAzimuthSuggest) {
      _applySuggestedAzimuth(data.recommendedLat, data.recommendedLng, data);
      _updateAzimuthSuggestionBadge(data.recommendedLat, data.recommendedLng, data);
      _pendingAzimuthSuggest = false;
      updateSite();
    }
  }, 200);
}

// ================================================
// RESET KE MANUAL MODE
// ================================================
function resetToManualMode() {
  if (!confirm('Reset ke mode manual?\n\nData gap dari halaman coverage akan dihapus.\nAnda bisa memilih koordinat bebas di peta.')) return;
  sessionStorage.removeItem(GAP_PLANNING_KEY);
  planningMode  = 'manual';
  activeGapData = null;
  if (_gapCentroidMarker) { map.removeLayer(_gapCentroidMarker); _gapCentroidMarker=null; }

  const h = document.getElementById('antennaHeight');
  if (h) { h.value=30; updateHeightBadge(); }
  const r = document.getElementById('coverageRadius');
  if (r) r.value = 400;
  const s = document.getElementById('clutterSelect');
  if (s) { s.value='urban'; updateClutterBadge(); }

  // Reset advanced RF ke defaults
  const defs = {
    txPower:46, frequency:2300, bandwidth:20, mobileH:1.5
  };
  Object.entries(defs).forEach(([id,val]) => {
    const el = document.getElementById(id); if (el) el.value = val;
  });

  for (let i=0; i<sectorCount; i++) {
    const input = document.getElementById('azimuth'+i);
    if (input) input.value = Math.round((360/sectorCount)*i);
  }
  _renderModeUI('manual');
  clearSite();
}

// ================================================
// RENDER MODE UI
// ================================================
function _renderModeUI(mode, gapData) {
  const gapPanel   = document.getElementById('gapContextPanel');
  const manualHint = document.getElementById('manualModeHint');
  const suggestBtn = document.getElementById('btnSuggestAzimuth');
  const resetBtn   = document.getElementById('btnResetManual');
  const modeBadge  = document.getElementById('planningModeBadge');

  if (mode === 'gap_guided' && gapData) {
    const isBlank   = gapData.gapType === 'blank_spot';
    const typeColor = isBlank ? '#c0392b' : '#d68910';
    const typeIcon  = isBlank ? '🚫' : '⚠️';
    const typeLabel = isBlank ? 'Blank Spot' : 'Weak Coverage';

    if (gapPanel) {
      gapPanel.style.display = 'block';
      gapPanel.innerHTML =
        '<div style="background:#fef9f9;border:1px solid #f5c6cb;border-left:3px solid '+typeColor+';border-radius:8px;padding:12px 14px;margin-bottom:12px;font-size:0.82rem;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
            '<span style="color:'+typeColor+';font-weight:700;font-size:0.84rem;">'+typeIcon+' '+typeLabel+' #'+gapData.gapIndex+'</span>' +
            '<span style="background:#fdecea;color:'+typeColor+';font-size:0.70rem;padding:2px 7px;border-radius:4px;border:1px solid #f5c6cb;font-weight:700;">'+gapData.severityLabel+'</span>' +
          '</div>' +
          '<table style="width:100%;border-collapse:collapse;font-size:0.79rem;">' +
            '<tr><td style="color:#888;padding:3px 0;width:48%">Avg RSRP</td><td style="color:'+typeColor+';font-weight:700;">'+(gapData.avgRSRP_dBm!=null?gapData.avgRSRP_dBm+' dBm':'No signal')+'</td></tr>' +
            '<tr><td style="color:#888;padding:3px 0">Min RSRP</td><td style="color:#c0392b;">'+(gapData.minRSRP_dBm!=null?gapData.minRSRP_dBm+' dBm':'—')+'</td></tr>' +
            '<tr><td style="color:#888;padding:3px 0">Luas Area</td><td style="color:#333;">'+gapData.areaSqKm+' km²</td></tr>' +
            '<tr><td style="color:#888;padding:3px 0">Est. Radius</td><td style="color:#333;">~'+gapData.estimatedRadius_m+' m</td></tr>' +
            '<tr><td style="color:#888;padding:3px 0">Site Terdekat</td><td style="color:#1F3C88;font-weight:700;">'+gapData.nearestSiteId+'</td></tr>' +
            '<tr><td style="color:#888;padding:3px 0">Jarak ke Site</td><td style="color:#333;">'+gapData.nearestSiteDist_m+' m</td></tr>' +
            '<tr><td style="color:#888;padding:3px 0">Main Site Ref</td><td style="color:#b7770d;font-weight:700;">'+gapData.mainSiteId+'</td></tr>' +
          '</table>' +
          '<div style="margin-top:9px;padding-top:8px;border-top:1px solid #f0d0d0;">' +
            '<div style="color:#aaa;font-size:0.74rem;margin-bottom:3px;">🧭 Azimuth Suggestion</div>' +
            '<div id="azimuthSuggestionInfo" style="color:#555;font-size:0.78rem;">Tempatkan site untuk melihat bearing ke gap</div>' +
          '</div>' +
          '<div style="margin-top:9px;padding:7px 9px;background:#fdf6e3;border:1px solid #fde68a;border-radius:5px;font-size:0.74rem;color:#92610a;">' +
            'ℹ️ <b>Parameter prefill otomatis:</b> Height dari '+gapData.nearestSiteId+' · Clutter: '+(gapData.nearestSiteClutter||'N/A')+' · Radius ~'+gapData.estimatedRadius_m+'m × 1.2' +
          '</div>' +
        '</div>';
    }

    if (suggestBtn) suggestBtn.style.display = 'inline-flex';
    if (resetBtn)   resetBtn.style.display   = 'inline-flex';
    if (manualHint) manualHint.style.display = 'none';
    if (modeBadge) {
      modeBadge.textContent      = '🎯 Gap-Guided Mode';
      modeBadge.style.background = '#fff3f3';
      modeBadge.style.borderColor= '#f5c6cb';
      modeBadge.style.color      = '#c0392b';
      modeBadge.style.display    = 'inline-block';
    }

  } else {
    if (gapPanel)   gapPanel.style.display   = 'none';
    if (suggestBtn) suggestBtn.style.display  = 'none';
    if (resetBtn)   resetBtn.style.display    = 'none';
    if (manualHint) manualHint.style.display  = 'block';
    if (modeBadge) {
      modeBadge.textContent      = '✏️ Manual Mode';
      modeBadge.style.background = '';
      modeBadge.style.borderColor= '';
      modeBadge.style.color      = '';
      modeBadge.style.display    = 'inline-block';
    }
  }
}

// ================================================
// COVERAGE GENERATION
// ================================================
function autoRegenerate() { if (currentSiteLocation) generateCoverage(); }

function setActiveVisualization(type) {
  currentCoverageType = type;
  document.getElementById('visualizeRSRP')?.classList.toggle('active', type==='rsrp');
  document.getElementById('visualizeSINR')?.classList.toggle('active', type==='sinr');
  if (currentSiteLocation) generateCoverage();
}

function generateCoverage() {
  if (!currentSiteLocation) return;
  showLoading('Menghitung prediksi coverage...');
  const gridSize      = parseInt(document.getElementById('gridSize').value);
  const radius        = parseInt(document.getElementById('coverageRadius').value);
  const antennaHeight = parseInt(document.getElementById('antennaHeight').value);
  const clutter       = getSelectedClutter();
  if (coverageLayer) { map.removeLayer(coverageLayer); coverageLayer=null; }
  setTimeout(() => {
    try {
      const grids = calculateCoverage(currentSiteLocation, gridSize, radius, antennaHeight, clutter);
      displayCoverageGrid(grids);
      updateStatistics(grids, antennaHeight, clutter);
      hideLoading();
    } catch(err) {
      console.error('Error generating coverage:', err);
      alert('Error saat generate coverage prediction');
      hideLoading();
    }
  }, 300);
}

function calculateCoverage(site, gridSize, radius, antennaHeight, clutter) {
  const grids  = [];
  const mpdLat = 111320;
  const mpdLon = 111320 * Math.cos(site.lat * Math.PI / 180);
  const dLat   = gridSize / mpdLat;
  const dLon   = gridSize / mpdLon;
  const rLat   = radius / mpdLat;
  const rLon   = radius / mpdLon;
  const { scenario, condition } = clutter;
  const isOmni = !azimuths || azimuths.length === 0;

  for (let lat=site.lat-rLat; lat<=site.lat+rLat; lat+=dLat) {
    for (let lon=site.lng-rLon; lon<=site.lng+rLon; lon+=dLon) {
      const dist = calcDistance({lat:site.lat, lng:site.lng}, {lat, lng:lon});
      if (dist < 1) continue;
      const edgeRatio = dist / radius;
      if (edgeRatio > 1.06) continue;
      if (edgeRatio > 0.80) {
        const dropProb = Math.pow((edgeRatio-0.80)/0.26, 2.0);
        if (Math.random() < dropProb) continue;
      }
      let gainDb=0, sectorIdx=0;
      if (!isOmni) {
        const brg  = bearingTo(site.lat, site.lng, lat, lon);
        const best = bestSectorGain(brg, azimuths);
        gainDb=best.gain; sectorIdx=best.sectorIdx;
      }
      const rsrp = computeRSRP(dist, antennaHeight, gainDb, scenario, condition);
      let value, color, category;
      if (currentCoverageType === 'rsrp') {
        value=Math.round(rsrp*10)/10; color=getRSRPColor(value); category=getRSRPCategory(value);
      } else {
        const sinr=computeSINR(dist, rsrp);
        value=Math.round(sinr*10)/10; color=getSINRColor(value); category=getSINRCategory(value);
      }
      grids.push({lat, lon, dist, value, color, category, sectorIdx, scenario, condition,
        bounds:[[lat,lon],[lat+dLat,lon],[lat+dLat,lon+dLon],[lat,lon+dLon]]});
    }
  }
  return grids;
}

// ================================================
// DISPLAY COVERAGE GRID
// ================================================
function displayCoverageGrid(grids) {
  const lg   = L.layerGroup();
  const unit = currentCoverageType==='rsrp' ? 'dBm' : 'dB';
  const type = currentCoverageType.toUpperCase();
  const CAL  = getCAL();
  grids.forEach(grid => {
    const modelLabel = grid.scenario.toUpperCase()+' '+grid.condition.toUpperCase().replace('_','/');
    L.polygon(grid.bounds, {color:grid.color, fillColor:grid.color, fillOpacity:0.72, weight:0})
      .bindPopup(
        '<div style="font-family:sans-serif;">' +
        '<h4 style="margin:0 0 6px;color:'+grid.color+'">'+type+': '+grid.value+' '+unit+'</h4>' +
        '<p style="margin:3px 0"><b>Kategori:</b> '+getCategoryName(grid.category)+'</p>' +
        '<p style="margin:3px 0"><b>Jarak:</b> '+Math.round(grid.dist)+' m</p>' +
        '<p style="margin:3px 0"><b>Sektor:</b> '+(grid.sectorIdx+1)+'</p>' +
        '<p style="margin:3px 0"><b>Model:</b> '+modelLabel+'</p>' +
        '<p style="margin:3px 0"><b>TX Power:</b> '+CAL.TX_POWER+' dBm</p>' +
        '<p style="margin:3px 0"><b>Frekuensi:</b> '+CAL.FREQUENCY+' MHz</p>' +
        '</div>'
      ).addTo(lg);
  });
  coverageLayer = lg.addTo(map);
}

// ================================================
// STATISTICS & ANALYSIS
// ================================================
function updateStatistics(grids, antennaHeight, clutter) {
  const gridArea  = (parseInt(document.getElementById('gridSize').value) / 1000) ** 2;
  const totalArea = (grids.length * gridArea).toFixed(2);
  const cats = {};
  grids.forEach(g => { cats[g.category] = (cats[g.category]||0)+1; });
  const total = grids.length || 1;

  const set = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  set('totalArea',         totalArea+' km²');
  set('excellentCoverage', ((cats.S1||0)/total*100).toFixed(1)+'%');
  set('goodCoverage',      ((cats.S2||0)/total*100).toFixed(1)+'%');
  set('poorCoverage',      (((cats.S4||0)+(cats.S5||0)+(cats.S6||0))/total*100).toFixed(1)+'%');

  const result = document.getElementById('analysisResult');
  if (result) result.innerHTML = buildAnalysisHTML(grids, cats, total, antennaHeight, clutter);
  updateMapLegend(cats, total);
}

function buildAnalysisHTML(grids, cats, total, antennaHeight, clutter) {
  const CAL        = getCAL();
  const type       = currentCoverageType==='rsrp' ? 'RSRP' : 'SINR';
  const unit       = currentCoverageType==='rsrp' ? 'dBm' : 'dB';
  const modelLabel = clutter.scenario.toUpperCase()+' '+clutter.condition.toUpperCase().replace('_','/');
  const close      = grids.filter(g => g.dist <= 150);
  const medium     = grids.filter(g => g.dist > 150 && g.dist <= 300);
  const far        = grids.filter(g => g.dist > 300);
  const avg        = arr => arr.length ? (arr.reduce((s,g)=>s+g.value,0)/arr.length).toFixed(1) : '-';
  const s1Pct      = (cats.S1||0)/total*100;
  const s2Pct      = (cats.S2||0)/total*100;
  const poorPct    = ((cats.S4||0)+(cats.S5||0)+(cats.S6||0))/total*100;

  let html = '<div class="analysis-text">';

  // Parameter chips
  html +=
    '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:11px;">' +
      '<span style="font-size:10.5px;padding:3px 8px;background:#edf4ff;color:#1F3C88;border-radius:4px;border:1px solid #c8daf7;font-weight:700;">📡 '+modelLabel+'</span>' +
      '<span style="font-size:10.5px;padding:3px 8px;background:#fef9eb;color:#92610a;border-radius:4px;border:1px solid #fde68a;font-weight:700;">🏗️ '+antennaHeight+'m</span>' +
      '<span style="font-size:10.5px;padding:3px 8px;background:#edfaf3;color:#1a5e30;border-radius:4px;border:1px solid #b7e4c7;font-weight:700;">📶 '+CAL.TX_POWER+' dBm</span>' +
      '<span style="font-size:10.5px;padding:3px 8px;background:#f3eeff;color:#5e35b1;border-radius:4px;border:1px solid #d1c4f4;font-weight:700;">📻 '+CAL.FREQUENCY+' MHz</span>' +
      '<span style="font-size:10.5px;padding:3px 8px;background:#edf9ff;color:#0369a1;border-radius:4px;border:1px solid #bae6fd;font-weight:700;">📡 BW '+CAL.BANDWIDTH+' MHz</span>' +
      '<span style="font-size:10.5px;padding:3px 8px;background:#f5f0ff;color:#6d28d9;border-radius:4px;border:1px solid #ddd6fe;font-weight:700;">👤 UE '+CAL.MOBILE_H+'m</span>' +
    '</div>';

  // Gap-guided check
  if (planningMode==='gap_guided' && activeGapData) {
    const isBlank   = activeGapData.gapType === 'blank_spot';
    const typeColor = isBlank ? '#c0392b' : '#d68910';
    const avgRSRP   = activeGapData.avgRSRP_dBm;
    const avgNew    = avg(grids);
    const improved  = avgNew!=='-' && parseFloat(avgNew) > -95;
    html +=
      '<div style="margin:0 0 9px;padding:9px 11px;background:#fffdf5;border-left:3px solid '+typeColor+';border-radius:0 6px 6px 0;font-size:11.5px;">' +
        '<b style="color:'+typeColor+'">🎯 Gap Coverage Check</b><br>' +
        'Existing avg RSRP: <b style="color:'+typeColor+'">'+(avgRSRP!=null?avgRSRP+' dBm':'No signal')+'</b><br>' +
        'Prediksi site baru: <b style="color:'+(improved?'#1a7a32':'#d68910')+'">'+avgNew+' '+unit+'</b>' +
        (improved
          ? '<br><span style="color:#1a7a32">✅ Gap dapat tercover dengan konfigurasi ini</span>'
          : '<br><span style="color:#d68910">⚠️ Pertimbangkan naikkan tinggi antena atau geser lokasi</span>') +
      '</div>';
  }

  // Verdict
  if (s1Pct > 50) {
    html += '<div class="analysis-success"><strong>✅ Coverage Sangat Baik</strong><br>'+s1Pct.toFixed(1)+'% area excellent.</div>';
  } else if (poorPct > 40) {
    html += '<div class="analysis-warning"><strong>⚠️ Coverage Kurang Optimal</strong><br>'+poorPct.toFixed(1)+'% area buruk. Naikkan tinggi antena atau pindahkan lokasi.</div>';
  } else {
    html += '<div class="analysis-highlight"><strong>📊 Coverage Memadai</strong><br>'+s2Pct.toFixed(1)+'% area dalam kategori Good.</div>';
  }

  // Per-distance breakdown
  html += '<p><strong>Prediksi per Jarak:</strong></p><ul>';
  if (close.length)  html += '<li><strong>0–150m:</strong> rata-rata '+avg(close)+' '+unit+'</li>';
  if (medium.length) html += '<li><strong>150–300m:</strong> rata-rata '+avg(medium)+' '+unit+'</li>';
  if (far.length)    html += '<li><strong>&gt;300m:</strong> rata-rata '+avg(far)+' '+unit+'</li>';
  html += '</ul>';

  const ac=avg(close), af=avg(far);
  if (ac!=='-' && af!=='-') {
    const deg = Math.abs(parseFloat(ac)-parseFloat(af)).toFixed(1);
    html += '<p><strong>Degradasi:</strong> Penurunan '+deg+' '+unit+' dari dekat ke jauh.';
    if (parseFloat(deg) > 25) html += ' Pertimbangkan penguat sinyal atau repeater.';
    html += '</p>';
  }

  // Rekomendasi
  html += '<p><strong>💡 Rekomendasi:</strong><br>';
  if (clutter.scenario==='umi') {
    html += 'Area '+clutter.label+' (UMi NLOS) — path loss tinggi. ';
    html += antennaHeight<25 ? 'Naikkan tinggi antena minimal 25–30m.' : 'Tinggi antena sudah memadai.';
  } else if (clutter.scenario==='rma') {
    html += 'Area Rural (RMa LOS) — jangkauan lebih luas. ';
    html += antennaHeight>=30 ? 'Konfigurasi optimal.' : 'Tinggi bisa diturunkan untuk efisiensi biaya.';
  } else {
    if (poorPct>30) html += 'Naikkan tinggi antena untuk memperluas coverage. ';
    else if (s1Pct<20 && antennaHeight<40) html += 'Tinggi antena masih bisa ditingkatkan. ';
    else html += 'Konfigurasi site sudah optimal. ';
  }
  if (sectorCount < 3) html += 'Pertimbangkan menambah jumlah sektor.';
  html += '</p></div>';
  return html;
}

// ================================================
// LEGEND
// ================================================
function updateMapLegend(cats, total) {
  const legend = document.getElementById('mapLegend');
  const tbody  = document.getElementById('legendTableBody');
  const title  = document.getElementById('legendTitle');
  if (!legend || !tbody) return;
  legend.style.display = 'block';
  const isRSRP = currentCoverageType === 'rsrp';
  if (title) title.textContent = isRSRP ? 'RSRP (dBm)' : 'SINR (dB)';
  const rows = isRSRP ? [
    {cat:'S1', color:'#0042a5', range:'-85 ~ 0',     label:'Excellent'},
    {cat:'S2', color:'#00a955', range:'-95 ~ -85',   label:'Good'},
    {cat:'S3', color:'#70ff66', range:'-105 ~ -95',  label:'Moderate'},
    {cat:'S4', color:'#fffb00', range:'-120 ~ -105', label:'Poor'},
    {cat:'S5', color:'#ff3333', range:'-140 ~ -120', label:'Very Bad'},
  ] : [
    {cat:'S1', color:'#0042a5', range:'20 ~ 40',  label:'Excellent'},
    {cat:'S2', color:'#00a955', range:'10 ~ 20',  label:'Good'},
    {cat:'S3', color:'#70ff66', range:'0 ~ 10',   label:'Moderate'},
    {cat:'S4', color:'#fffb00', range:'-5 ~ 0',   label:'Poor'},
    {cat:'S5', color:'#ff3333', range:'-40 ~ -5', label:'Very Bad'},
  ];
  tbody.innerHTML = '';
  rows.forEach(item => {
    const pct = total > 0 ? (((cats[item.cat]||0)/total)*100).toFixed(1) : '0.0';
    const row = document.createElement('tr');
    row.innerHTML =
      '<td><div class="color-box" style="background:'+item.color+'"></div></td>' +
      '<td>'+item.range+'</td>' +
      '<td style="color:#888;font-size:10px;">'+item.label+'</td>' +
      '<td><b>'+pct+'%</b></td>';
    tbody.appendChild(row);
  });
}

// ================================================
// LOADING
// ================================================
function showLoading(text) {
  hideLoading();
  const overlay = document.createElement('div');
  overlay.className = 'loading-overlay';
  overlay.id        = 'loadingOverlay';
  overlay.innerHTML =
    '<div class="loading-content">' +
      '<div class="spinner"></div>' +
      '<p class="loading-text">'+(text||'Memproses...')+'</p>' +
    '</div>';
  document.body.appendChild(overlay);
}
function hideLoading() { document.getElementById('loadingOverlay')?.remove(); }

console.log('newsite.js v3.0 — All RF params controllable from frontend | Gap-Guided + Manual Mode');