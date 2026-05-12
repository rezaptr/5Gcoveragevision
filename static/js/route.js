// ================= GLOBAL =================
let map;
let siteLayer, sectorLayer;
let ringLayer, mainRouteLayer, altRouteLayer, samplingLayer;

let siteIndex = {};
let selectedSite = null;
let ringPoints = [];
let mainRouteData = null;
let altRouteData = null;

let activeRoute = 'main';

const SESSION_KEY = 'siteIndexData';

const SECTOR_COLORS = ['#ff2d55','#00c7be','#ffcc00','#af52de','#ff9500','#34c759'];

// ================= INIT MAP =================
document.addEventListener("DOMContentLoaded", () => {
  const mapElement = document.getElementById("map");
  if (!mapElement) { console.log('⏭️ No map element'); return; }

  map = L.map("map").setView([-6.2, 106.816], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);

  siteLayer   = L.layerGroup().addTo(map);
  sectorLayer = L.layerGroup().addTo(map);
  samplingLayer = L.layerGroup().addTo(map);

  createSiteBadge();
  setupEventListeners();
  restoreSiteIndex();
});

// ================= RESTORE =================
function restoreSiteIndex() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    if (!parsed || Object.keys(parsed).length === 0) return;
    siteIndex = parsed;
    renderSitesOnMap();
    populateSiteSearch();
    updateUploadStatus(`✅ ${Object.keys(siteIndex).length} site`);
  } catch (e) {
    console.warn('Gagal restore sessionStorage:', e);
    sessionStorage.removeItem(SESSION_KEY);
  }
}

function renderSitesOnMap() {
  siteLayer.clearLayers();
  sectorLayer.clearLayers();
  const cg = L.markerClusterGroup({
    chunkedLoading: true, chunkInterval: 100, chunkDelay: 50,
    maxClusterRadius: 60, disableClusteringAtZoom: 15, spiderfyOnMaxZoom: true
  });
  const bounds = [];
  Object.entries(siteIndex).forEach(([id, s]) => {
    bounds.push([s.lat, s.lng]);
    const m = L.circleMarker([s.lat, s.lng], {
      radius: 7, fillColor: "#ffd000", color: "#000", weight: 1.5, fillOpacity: 1
    });
    m.bindTooltip(id, { permanent: false, direction: "top", offset: [0,-8], className: 'site-label' });
    m.bindPopup(`<b>SITE: ${id}</b><br>Lat:${s.lat.toFixed(6)}<br>Lng:${s.lng.toFixed(6)}<br>Height:${s.height}m`);
    cg.addLayer(m);
  });
  siteLayer.addLayer(cg);
  if (bounds.length > 0) map.fitBounds(bounds);
}

// ================= EVENTS =================
function setupEventListeners() {
  const on = (id, fn) => { const el=document.getElementById(id); if(el) el.addEventListener('click', fn); };
  const fi = document.getElementById("fileInput");
  const ss = document.getElementById("siteSearch");
  if (fi) fi.addEventListener("change", processXLSX);
  if (ss) ss.addEventListener("input", onSiteSelect);
  on('btnGenerateRing', () => generateRing(150));
  on('btnMainRoute',    generateMainRoute);
  on('btnAltRoute',     generateAltRoute);
  on('btnSampling',     generateSampling);
  on('btnReset',        resetAll);
  on('btnExportKML',    exportToKML);
  on('btnSimulate',     goToSimulation);
  on('btnClearSite', () => {
    if (!confirm("Hapus data site? Harus upload XLSX lagi.")) return;
    sessionStorage.removeItem(SESSION_KEY);
    siteIndex = {};
    siteLayer.clearLayers(); sectorLayer.clearLayers();
    populateSiteSearch(); updateUploadStatus('');
  });
}

function updateUploadStatus(msg) {
  const el = document.getElementById("uploadStatus"); if (el) el.textContent = msg;
}

// ================= UI BADGE =================
function createSiteBadge() {
  const badge = L.control({ position: "topright" });
  badge.onAdd = () => {
    const div = L.DomUtil.create("div", "site-badge");
    div.id = "siteBadge";
    div.style.cssText = "background:linear-gradient(135deg,#1f3c88,#2850b0);color:#fff;padding:12px 18px;border-radius:10px;font-weight:bold;display:none;box-shadow:0 4px 12px rgba(31,60,136,0.3);border:2px solid rgba(255,255,255,0.2)";
    return div;
  };
  badge.addTo(map);
}

function updateSiteBadge(id) {
  const b = document.getElementById("siteBadge");
  if (b) { b.style.display="block"; b.innerHTML=`SITE ID: <span style="font-size:18px;letter-spacing:1px">${id}</span>`; }
}

// ================= GEO UTILS =================
function destinationPoint(lat, lng, az, dist) {
  const R=6378137, brng=az*Math.PI/180, d=dist/R;
  const lat1=lat*Math.PI/180, lng1=lng*Math.PI/180;
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(d)+Math.cos(lat1)*Math.sin(d)*Math.cos(brng));
  const lng2=lng1+Math.atan2(Math.sin(brng)*Math.sin(d)*Math.cos(lat1),Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
  return {lat:lat2*180/Math.PI, lng:lng2*180/Math.PI};
}

function bearingBetween(a, b) {
  const y=Math.sin((b.lng-a.lng)*Math.PI/180)*Math.cos(b.lat*Math.PI/180);
  const x=Math.cos(a.lat*Math.PI/180)*Math.sin(b.lat*Math.PI/180)-Math.sin(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.cos((b.lng-a.lng)*Math.PI/180);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

function haversineM(a, b) {
  const R=6378137, dLat=(b.lat-a.lat)*Math.PI/180, dLng=(b.lng-a.lng)*Math.PI/180;
  const aa=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(aa),Math.sqrt(1-aa));
}

// ================= NEIGHBOUR BUILDER =================
const MAX_NEIGHBOURS = 6;

function buildNeighbourList(servingSiteId) {
  const serving = siteIndex[servingSiteId];
  if (!serving) return [];

  const nb = Object.entries(siteIndex)
    .filter(([id]) => id !== servingSiteId)
    .map(([id, s]) => ({
      siteId    : id,
      lat       : s.lat,
      lng       : s.lng,
      height    : s.height    || 30,
      sectors   : s.sectors   || [],
      // ✅ sectorData dengan PCI asli per sektor dari shapefile
      sectorData: s.sectorData || [],
      gnbId     : s.gnbId     || null,
      clutter   : s.clutter   || 'N/A',
      scenario  : s.scenario  || 'uma',
      condition : s.condition || 'nlos',
      _dist     : haversineM(serving, s),
    }))
    .sort((a, b) => a._dist - b._dist)
    .slice(0, MAX_NEIGHBOURS);

  // Debug: cek apakah sectorData ada di neighbours
  nb.forEach(n => {
    const hasPCI = n.sectorData?.length > 0 && n.sectorData[0].pci !== null;
    console.log(`[Neighbour] ${n.siteId}: sectorData=${n.sectorData?.length} sektor, PCI ok=${hasPCI}`);
  });

  return nb.map(({ _dist, ...rest }) => rest);
}

// ================= XLSX PROCESSING =================
async function processXLSX(e) {
  const file = e.target.files[0];
  if (!file) return;
  const fileSizeMB = file.size/(1024*1024);
  const estimatedSeconds = Math.max(5, Math.round(2+fileSizeMB*30));
  showLoadingWithProgress('Mengunggah dan memproses data site...', 0, estimatedSeconds);
  const startTime = Date.now();
  let progressInterval;
  try {
    let fakeProgress = 0;
    progressInterval = setInterval(() => {
      const elapsed=(Date.now()-startTime)/1000;
      fakeProgress=Math.min(85,Math.round((elapsed/estimatedSeconds)*85));
      updateLoadingProgress(fakeProgress, `Memproses file... (~${Math.max(0,estimatedSeconds-Math.round(elapsed))}s)`);
    }, 300);
    const formData = new FormData();
    formData.append('file', file);
    const res  = await fetch('/api/upload-site', { method:'POST', body:formData });
    clearInterval(progressInterval);
    updateLoadingProgress(92, 'Menerima data dari server...');
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Upload gagal');
    updateLoadingProgress(97, 'Menyusun tampilan peta...');
    await new Promise(r => setTimeout(r, 150));

    siteIndex = json.siteIndex;

    // ✅ Validasi: cek apakah sectorData sudah ada di response backend
    const sampleId = Object.keys(siteIndex)[0];
    if (sampleId) {
      const sample = siteIndex[sampleId];
      const hasSectorData = sample.sectorData && sample.sectorData.length > 0;
      const hasPCI = hasSectorData && sample.sectorData[0].pci !== null;
      console.log(`[Upload] Sample ${sampleId}: sectorData=${hasSectorData}, PCI ok=${hasPCI}`);
      if (!hasSectorData) {
        console.warn(
          `[Upload] PERINGATAN: sectorData TIDAK ADA di response backend!\n` +
          `Pastikan Flask mengirim field 'sectorData' per site.\n` +
          `Lihat flask_patch.py untuk cara memperbaiki backend.`
        );
      } else if (!hasPCI) {
        console.warn(
          `[Upload] PERINGATAN: sectorData ada tapi PCI null!\n` +
          `Pastikan kolom PCI di XLSX terbaca dan dimasukkan ke sectorData.`
        );
      } else {
        console.log(`[Upload] ✅ sectorData & PCI OK! Sample PCI: ${sample.sectorData.map(s=>s.pci).join(', ')}`);
      }
    }

    sessionStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex));
    renderSitesOnMap();
    populateSiteSearch();
    hideLoading();
    const elapsed = ((Date.now()-startTime)/1000).toFixed(1);
    updateUploadStatus(`✅ ${json.siteCount} site`);
    alert(`✅ Berhasil load ${json.siteCount} site dari "${json.filename}" dalam ${elapsed} detik.`);
  } catch (err) {
    if (progressInterval) clearInterval(progressInterval);
    hideLoading();
    alert('❌ Gagal: ' + err.message);
  }
  e.target.value = '';
}

// ================= SEARCH =================
function populateSiteSearch() {
  const list = document.getElementById("siteList");
  if (!list) return;
  list.innerHTML = "";
  Object.keys(siteIndex).sort().forEach(id => {
    const o = document.createElement("option"); o.value = id; list.appendChild(o);
  });
}

function onSiteSelect() {
  const id = document.getElementById("siteSearch").value.trim();
  if (!siteIndex[id]) return;
  selectedSite = id;
  updateSiteBadge(id);
  const el = document.getElementById("currentSite"); if (el) el.textContent = id;
  sectorLayer.clearLayers();
  const s = siteIndex[id];
  s.sectors.forEach((az, idx) => drawSectorFan(s.lat, s.lng, az, 65, 150, idx));
  map.setView([s.lat, s.lng], 16);
}

// ================= SECTOR FAN =================
function drawSectorFan(lat, lng, az, beamwidth, radius, sectorIdx) {
  const start=az-beamwidth/2, end=az+beamwidth/2;
  const pts=[[lat,lng]];
  for (let i=0;i<=16;i++) {
    const ang=start+(i/16)*(end-start);
    const p=destinationPoint(lat,lng,ang,radius);
    pts.push([p.lat,p.lng]);
  }
  pts.push([lat,lng]);
  const color=SECTOR_COLORS[sectorIdx%SECTOR_COLORS.length];
  L.polygon(pts,{color,fillColor:color,fillOpacity:0.15,weight:2,opacity:0.6})
    .addTo(sectorLayer)
    .bindPopup(`<b>Sektor ${sectorIdx+1}</b><br>Azimuth: ${az}°`);
}

// ================= RING =================
function generateRing(radius=150) {
  if (!selectedSite) return alert("⚠️ Pilih site dulu");
  if (ringLayer) map.removeLayer(ringLayer);
  ringPoints = [];
  const s=siteIndex[selectedSite];
  for (let d=0;d<=360;d+=10) ringPoints.push(destinationPoint(s.lat,s.lng,d,radius));
  ringLayer=L.polyline(ringPoints.map(p=>[p.lat,p.lng]),{color:"#00ffff",dashArray:"6 6",weight:2}).addTo(map);
  alert(`✅ Ring radius ${radius}m`);
}

// ================= ROUTE =================
async function generateMainRoute() { if (!selectedSite) return alert("⚠️ Pilih site dulu"); await buildRoute(150,false); }
async function generateAltRoute()  { if (!selectedSite) return alert("⚠️ Pilih site dulu"); await buildRoute(250,true);  }

function showRouteSelector() {
  const el=document.getElementById("routeSelector"); if(el) el.style.display="block";
  updateRouteSelectorUI();
}
function updateRouteSelectorUI() {
  const bM=document.getElementById("btnSelectMain"), bA=document.getElementById("btnSelectAlt");
  if(bM) bM.className="route-select-btn"+(activeRoute==='main'?" active-main":"");
  if(bA) bA.className="route-select-btn"+(activeRoute==='alt'?" active-alt":"");
}
function setActiveRoute(type) { activeRoute=type; updateRouteSelectorUI(); }

function generateSampling() {
  if (!mainRouteLayer||!selectedSite) return alert("⚠️ Generate rute utama dulu");
  samplingLayer.clearLayers();
  const s=siteIndex[selectedSite], pts=mainRouteLayer.getLatLngs(), sp={};
  s.sectors.forEach((az,idx) => {
    let best=null, minDiff=Infinity;
    pts.forEach((p,i) => {
      if(i===0) return;
      const dir=bearingBetween({lat:s.lat,lng:s.lng},{lat:p.lat,lng:p.lng});
      let diff=Math.abs(dir-az); if(diff>180) diff=360-diff;
      if(diff<30&&diff<minDiff){minDiff=diff;best=p;}
    });
    if(best){
      sp[idx]=best;
      L.circleMarker(best,{radius:6,fillColor:SECTOR_COLORS[idx%SECTOR_COLORS.length],color:'#000',weight:2,fillOpacity:1})
        .addTo(samplingLayer).bindPopup(`<b>📍 Sektor ${idx+1}</b><br>Azimuth:${az}°`);
    }
  });
  const found=Object.values(sp).filter(p=>p!==null).length;
  const el=document.getElementById("samplingCount"); if(el) el.textContent=`${found} dari ${s.sectors.length} sektor`;
  alert(`✅ ${found} titik sampling dari ${s.sectors.length} sektor`);
}

async function buildRoute(radius, isAlt) {
  if (!selectedSite) return;
  updateRouteInfo({loading:true,type:isAlt?"alternatif":"utama"});
  generateRing(radius);
  const coords=ringPoints.map(p=>`${p.lng},${p.lat}`).join(";");
  const url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
  try {
    const res=await fetch(url), json=await res.json();
    if (!json.routes?.length) throw new Error("Tidak ada rute");
    const route=json.routes[0], pts=route.geometry.coordinates.map(c=>[c[1],c[0]]);
    if(isAlt&&altRouteLayer) map.removeLayer(altRouteLayer);
    if(!isAlt&&mainRouteLayer) map.removeLayer(mainRouteLayer);
    const layer=L.polyline(pts,{color:isAlt?"#ff8800":"#0066ff",weight:5,opacity:0.7}).addTo(map);
    if(isAlt){altRouteLayer=layer;altRouteData=route;activeRoute='alt';showRouteSelector();}
    else{mainRouteLayer=layer;mainRouteData=route;if(altRouteLayer) showRouteSelector();}
    map.fitBounds(layer.getBounds());
    updateRouteInfo(route,isAlt);
    const btn=document.getElementById("btnSimulate");
    if(btn){btn.disabled=false;btn.style.opacity="1";btn.style.cursor="pointer";}
  } catch(e) { updateRouteInfo({error:true,message:e.message||"Route error"}); }
}

function updateRouteInfo(route, isAlt=false) {
  const div=document.getElementById("infoText"); if(!div) return;
  if(route.loading){div.textContent=`⏳ Generating rute ${route.type}...`;div.classList.add("show");return;}
  if(route.error){div.textContent=`❌ ${route.message}`;div.classList.add("show");return;}
  const dist=(route.distance/1000).toFixed(2), dur=Math.round(route.duration/60), spd=Math.round((route.distance/route.duration)*3.6);
  div.innerHTML=`${isAlt?"🟠 ALT":"🔵 MAIN"} ROUTE OK | ${dist} km | ${dur} menit | ${spd} km/jam`;
  div.classList.add("show");
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  if(isAlt){set("altDistance",`${dist} km`);set("altTime",`${dur} menit`);set("altSpeed",`${spd} km/jam`);set("altStatus","✅ Aktif");}
  else{set("totalDistance",`${dist} km`);set("estTime",`${dur} menit`);set("avgSpeed",`${spd} km/jam`);}
}

function resetAll() {
  if(!confirm("Reset semua rute? Site data tetap.")) return;
  if(ringLayer) map.removeLayer(ringLayer);
  if(mainRouteLayer) map.removeLayer(mainRouteLayer);
  if(altRouteLayer) map.removeLayer(altRouteLayer);
  sectorLayer.clearLayers(); samplingLayer.clearLayers();
  ringLayer=mainRouteLayer=altRouteLayer=mainRouteData=altRouteData=null;
  ringPoints=[]; activeRoute='main';
  const sel=document.getElementById("routeSelector"); if(sel) sel.style.display="none";
  const btn=document.getElementById("btnSimulate");
  if(btn){btn.disabled=true;btn.style.opacity="0.5";btn.style.cursor="not-allowed";}
  if(selectedSite&&siteIndex[selectedSite]){
    const s=siteIndex[selectedSite];
    map.setView([s.lat,s.lng],16);
    s.sectors.forEach((az,idx)=>drawSectorFan(s.lat,s.lng,az,65,150,idx));
  }
  alert("✅ Reset berhasil!");
}

function exportToKML() {
  if(!mainRouteLayer&&!altRouteLayer) return alert("⚠️ Belum ada rute!");
  const siteInfo=selectedSite?siteIndex[selectedSite]:null, siteName=selectedSite||"Site";
  const esc=str=>String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let kml=`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n<name>Route ${esc(siteName)}</name>\n`;
  kml+=`<Style id="mr"><LineStyle><color>ffff6600</color><width>4</width></LineStyle></Style>\n`;
  kml+=`<Style id="ar"><LineStyle><color>ff0088ff</color><width>4</width></LineStyle></Style>\n`;
  if(siteInfo) kml+=`<Placemark><name>${esc(siteName)}</name><Point><coordinates>${siteInfo.lng},${siteInfo.lat},0</coordinates></Point></Placemark>\n`;
  if(mainRouteLayer){const c=mainRouteLayer.getLatLngs().map(p=>`${p.lng},${p.lat},0`).join(' ');kml+=`<Placemark><name>Main Route</name><styleUrl>#mr</styleUrl><LineString><coordinates>${c}</coordinates></LineString></Placemark>\n`;}
  if(altRouteLayer){const c=altRouteLayer.getLatLngs().map(p=>`${p.lng},${p.lat},0`).join(' ');kml+=`<Placemark><name>Alt Route</name><styleUrl>#ar</styleUrl><LineString><coordinates>${c}</coordinates></LineString></Placemark>\n`;}
  kml+=`</Document></kml>`;
  const ts=new Date().toISOString().slice(0,19).replace(/:/g,'-');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([kml],{type:'application/vnd.google-earth.kml+xml'}));
  a.download=`Route_${siteName}_${ts}.kml`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ================= GO TO SIMULATION =================
function goToSimulation() {
  if(!selectedSite||!mainRouteLayer||!mainRouteData) return alert("⚠️ Generate rute utama terlebih dahulu!");
  if(activeRoute==='alt'&&(!altRouteLayer||!altRouteData)) return alert("⚠️ Rute alternatif belum di-generate!");

  const siteData=siteIndex[selectedSite];
  const chosenLayer=activeRoute==='alt'?altRouteLayer:mainRouteLayer;
  const chosenData=activeRoute==='alt'?altRouteData:mainRouteData;

  const neighbours=buildNeighbourList(selectedSite);

  // ✅ Debug — pastikan sectorData ada sebelum kirim
  console.log(`[goToSimulation] Site: ${selectedSite}`);
  console.log(`[goToSimulation] sectorData serving:`, siteData.sectorData);
  if (!siteData.sectorData?.length) {
    console.error(
      `❌ sectorData KOSONG untuk serving site ${selectedSite}!\n` +
      `Kemungkinan Flask belum mengirim field sectorData.\n` +
      `Lihat flask_patch.py untuk perbaikan.`
    );
  }

  const driveTestData = {
    siteId     : selectedSite,
    activeRoute: activeRoute==='alt'?'alt':'main',
    site: {
      lat       : siteData.lat,
      lng       : siteData.lng,
      height    : siteData.height    || 30,
      sectors   : siteData.sectors   || [],
      // ✅ sectorData: [{sectorNum, azimuth, pci, cellId, cellName, gnbId, arfcn}, ...]
      sectorData: siteData.sectorData || [],
      gnbId     : siteData.gnbId     || null,
      clutter   : siteData.clutter   || 'N/A',
      scenario  : siteData.scenario  || 'uma',
      condition : siteData.condition || 'nlos',
    },
    neighbours,
    mainRoute: {
      coords  : mainRouteLayer.getLatLngs().map(p=>({lat:p.lat,lng:p.lng})),
      distance: mainRouteData.distance,
      duration: mainRouteData.duration,
    },
    altRoute: altRouteData?{
      coords  : altRouteLayer.getLatLngs().map(p=>({lat:p.lat,lng:p.lng})),
      distance: altRouteData.distance,
      duration: altRouteData.duration,
    }:null,
    activeRouteData: {
      coords  : chosenLayer.getLatLngs().map(p=>({lat:p.lat,lng:p.lng})),
      distance: chosenData.distance,
      duration: chosenData.duration,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    sessionStorage.setItem('driveTestData', JSON.stringify(driveTestData));
    window.location.href = '/drivetest';
  } catch(e) {
    alert("❌ Error menyimpan data: " + e.message);
  }
}

// ================= LOADING =================
function showLoadingWithProgress(text, progress, estimatedSeconds) {
  hideLoading();
  const overlay=document.createElement('div');
  overlay.className='loading-overlay'; overlay.id='loadingOverlay';
  overlay.innerHTML=`
    <div class="loading-content">
      <div class="spinner"></div>
      <p class="loading-text" id="loadingText">${text}</p>
      ${estimatedSeconds!==null?`
        <p class="loading-est">Estimasi: ~${estimatedSeconds} detik</p>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" id="progressBarFill" style="width:${progress}%"></div>
        </div>
        <p class="progress-label" id="progressLabel">${progress}%</p>`:''}
    </div>`;
  document.body.appendChild(overlay);
}
function updateLoadingProgress(progress, text) {
  const fill=document.getElementById('progressBarFill'), label=document.getElementById('progressLabel'), txt=document.getElementById('loadingText');
  if(fill) fill.style.width=`${progress}%`; if(label) label.textContent=`${progress}%`; if(txt&&text) txt.textContent=text;
}
function hideLoading() { document.getElementById('loadingOverlay')?.remove(); }

console.log('✅ script.js — sectorData (PCI asli per sektor) dikirim ke simulation');