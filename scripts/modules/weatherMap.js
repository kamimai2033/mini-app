import '../vendor/leaflet/leaflet.js';

export const RADAR_NATIVE_ZOOM = 10;
export const VIEW_RADIUS_METERS = 2000;
const L = globalThis.L;

export function createWeatherMap(container, { center, onStatus = () => {} }) {
  if (!L) throw new Error('地図ライブラリを読み込めません。');
  let position = { ...center }, fitToRadius = true, adjusting = false, radar = null;
  let activeFrame = '', frameGeneration = 0, baseFailed = false, radarStatus = '';
  let destroyed = false;
  const map = L.map(container, { minZoom: 5, maxZoom: 18, zoomSnap: 0, zoomDelta: 1, attributionControl: true, zoomAnimation: false, fadeAnimation: false });
  const point = () => [position.lat, position.lon];
  map.setView(point(), 13);
  const background = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxNativeZoom: 19, maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
  });
  const publish = () => {
    onStatus([baseFailed ? '背景地図の一部を取得できません。' : '', radarStatus].filter(Boolean).join(' '));
  };
  background.on('loading', () => { baseFailed = false; });
  background.on('tileerror', () => { baseFailed = true; publish(); });
  background.addTo(map);
  const circle = L.circle(point(), { radius: VIEW_RADIUS_METERS, color: '#333', weight: 2, fill: false, interactive: false }).addTo(map);
  const marker = L.circleMarker(point(), { radius: 5, color: '#fff', weight: 2, fillColor: '#174b70', fillOpacity: 1, interactive: false }).addTo(map);
  L.control.scale({ metric: true, imperial: false, maxWidth: 100 }).addTo(map);
  container.dataset.nativeZoom = String(RADAR_NATIVE_ZOOM);
  container.dataset.radiusMeters = String(VIEW_RADIUS_METERS);
  container.dataset.radarState = 'empty';
  function updateMeasurements() {
    if (destroyed || !container.clientWidth || !container.clientHeight) return;
    const bounds = map.getBounds(), c = map.getCenter();
    container.dataset.viewWidthMeters = String(Math.round(map.distance([c.lat, bounds.getWest()], [c.lat, bounds.getEast()])));
    container.dataset.viewHeightMeters = String(Math.round(map.distance([bounds.getSouth(), c.lng], [bounds.getNorth(), c.lng])));
    container.dataset.zoom = String(map.getZoom());
  }
  function resetView() {
    if (destroyed || !container.clientWidth || !container.clientHeight) return;
    adjusting = true; fitToRadius = true;
    map.invalidateSize({ pan: false });
    map.fitBounds(circle.getBounds(), { padding: [8, 8], animate: false });
    adjusting = false; updateMeasurements();
  }
  function userChangedView() { if (!adjusting) fitToRadius = false; }
  map.on('dragstart zoomstart', userChangedView);
  map.on('moveend zoomend', updateMeasurements);
  function resize() {
    if (destroyed || !container.clientWidth || !container.clientHeight) return;
    if (fitToRadius) resetView();
    else { adjusting = true; map.invalidateSize({ pan: false }); adjusting = false; updateMeasurements(); }
  }
  const observer = new ResizeObserver(resize); observer.observe(container);
  function clearRadar() {
    ++frameGeneration;
    // Leaflet's remove event unregisters the layer's map listeners before off().
    if (radar) { map.removeLayer(radar); radar.off(); }
    radar = null; activeFrame = ''; radarStatus = '';
    container.dataset.radarState = 'empty'; publish();
  }
  let opacity = 0.6;
  function showFrame(frame) {
    if (destroyed || !/^\d{14}$/.test(frame?.basetime || '') || !/^\d{14}$/.test(frame?.validtime || '')) return;
    const identity = `${frame.basetime}/${frame.validtime}`;
    if (radar && activeFrame === identity) return;
    clearRadar();
    activeFrame = identity;
    const generation = ++frameGeneration;
    let failed = 0, received = 0;
    const url = `https://www.jma.go.jp/bosai/jmatile/data/nowc/${frame.basetime}/none/${frame.validtime}/surf/hrpns/{z}/{x}/{y}.png`;
    radar = L.tileLayer(url, {
      opacity, maxNativeZoom: RADAR_NATIVE_ZOOM, maxZoom: 18, minZoom: 5, zIndex: 2,
      attribution: '<a href="https://www.jma.go.jp/bosai/nowc/" target="_blank" rel="noopener">気象庁</a>（拡大・重ね合わせ）'
    });
    radar.on('loading', () => {
      if (generation !== frameGeneration) return;
      failed = 0; received = 0; radarStatus = '雨雲画像を取得中…'; container.dataset.radarState = 'loading'; publish();
    });
    radar.on('tileload', () => { if (generation === frameGeneration) received++; });
    radar.on('tileerror', () => {
      if (generation !== frameGeneration) return;
      failed++; radarStatus = '雨雲画像の一部を取得できません。空白は無降雨を示すものではありません。';
      container.dataset.radarState = 'error'; publish();
    });
    radar.on('load', () => {
      if (generation !== frameGeneration) return;
      container.dataset.radarState = failed || !received ? 'error' : 'ready';
      radarStatus = failed || !received ? '雨雲画像を取得できない範囲があります。空白は無降雨を示すものではありません。' : '雨雲画像を表示しています。';
      publish();
    });
    radar.addTo(map);
    circle.bringToFront(); marker.bringToFront();
  }
  resetView();
  return {
    setCenter(value) { position = { ...value }; circle.setLatLng(point()); marker.setLatLng(point()); resetView(); },
    resetView, resize, showFrame, clearRadar,
    setOpacity(value) { if (Number.isFinite(value)) { opacity = Math.min(1, Math.max(0, value)); radar?.setOpacity(opacity); } },
    getBounds: () => map.getBounds(),
    destroy() { if (destroyed) return; clearRadar(); destroyed = true; observer.disconnect(); map.remove(); }
  };
}
