export const CITIES = Object.freeze({
  '130010': { label: '東京', lat: 35.6812, lon: 139.7671 },
  '140010': { label: '横浜', lat: 35.4437, lon: 139.6380 },
  '120010': { label: '千葉', lat: 35.6074, lon: 140.1063 },
  '110010': { label: 'さいたま', lat: 35.8617, lon: 139.6455 },
  '270000': { label: '大阪', lat: 34.6937, lon: 135.5023 },
  '016010': { label: '札幌', lat: 43.0618, lon: 141.3545 },
  '400010': { label: '福岡', lat: 33.5902, lon: 130.4017 }
});
export const DEFAULT_WORKER = 'https://flat-bush-0140.kamimai2033.workers.dev/';
export const STORAGE_KEY = `mini-app-weather:${new URL('../../', import.meta.url).pathname}:v1`;
export const FORECAST_TTL = 15 * 60 * 1000;
export const RADAR_TTL = 5 * 60 * 1000;
export function validForecastData(data) {
  return data && typeof data === 'object' && Array.isArray(data.forecasts) && data.forecasts.length > 0 &&
    data.forecasts.length <= 7 && data.forecasts.every(value => value && typeof value === 'object' && !Array.isArray(value));
}
export function validCenter(value) {
  return value && Number.isFinite(value.lat) && Number.isFinite(value.lon) &&
    Math.abs(value.lat) < 85 && Math.abs(value.lon) <= 180;
}
export function normalizeWorker(value) {
  if (!value.trim()) return '';
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('接続先にはHTTPSのURLを指定してください。認証情報・クエリは含めません。');
  }
  return url.href;
}
export function loadWeatherState() {
  const fallback = { version: 1, city: '130010', center: { ...CITIES['130010'], kind: 'city' }, workerURL: DEFAULT_WORKER, forecasts: {}, rain: null };
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!value || value.version !== 1) return fallback;
    const city = Object.hasOwn(CITIES, value.city) ? value.city : fallback.city;
    const center = validCenter(value.center) ? { lat: value.center.lat, lon: value.center.lon, label: value.center.kind === 'location' ? '前回の現在地' : String(value.center.label || '保存した地点').slice(0, 80), kind: value.center.kind === 'location' ? 'location' : 'city' } : { ...CITIES[city], kind: 'city' };
    const forecasts = {};
    for (const key of Object.keys(CITIES)) {
      const saved = value.forecasts?.[key];
      if (saved && Number.isFinite(saved.fetchedAt) && validForecastData(saved.data)) forecasts[key] = saved;
    }
    return { version: 1, city, center, workerURL: normalizeWorker(typeof value.workerURL === 'string' ? value.workerURL : DEFAULT_WORKER), forecasts, rain: value.rain || null };
  } catch { return fallback; }
}
export function saveWeatherState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
export function centerKey(center) { return `${center.lat.toFixed(5)},${center.lon.toFixed(5)}`; }
export function parseJmaTime(value) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return NaN;
  return Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8), +value.slice(8, 10), +value.slice(10, 12), +value.slice(12, 14));
}
export function makeRadarFrames(observations, forecasts, now = Date.now()) {
  const valid = values => Array.isArray(values) ? values.filter(f => f && Number.isFinite(parseJmaTime(f.basetime)) && Number.isFinite(parseJmaTime(f.validtime)) && (!f.elements || (Array.isArray(f.elements) && f.elements.includes('hrpns')))) : [];
  const past = valid(observations).sort((a, b) => a.validtime.localeCompare(b.validtime));
  let recent = past.filter(f => parseJmaTime(f.validtime) >= now - 30 * 60 * 1000 && parseJmaTime(f.validtime) <= now + 5 * 60 * 1000);
  if (!recent.length && past.length) recent = past.slice(-1);
  const latest = recent.length ? parseJmaTime(recent.at(-1).validtime) : now;
  const future = valid(forecasts).filter(f => parseJmaTime(f.validtime) > latest && parseJmaTime(f.validtime) <= now + 65 * 60 * 1000);
  const unique = new Map();
  for (const [kind, values] of [['observation', recent], ['forecast', future]]) {
    for (const f of values) if (!unique.has(f.validtime)) unique.set(f.validtime, { basetime: f.basetime, validtime: f.validtime, kind });
  }
  return [...unique.values()].sort((a, b) => a.validtime.localeCompare(b.validtime));
}
export async function fetchJSON(url, controller = new AbortController()) {
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}
export async function fetchRainData(url, controller = new AbortController()) {
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    // The existing Worker forwards Yahoo's XML while declaring application/json.
    // Inspect the actual payload; support both it and the documented JSON form.
    if (!body.trimStart().startsWith('<')) return JSON.parse(body);
    if (/<!DOCTYPE/i.test(body)) throw new Error('地点別雨量のXML形式を確認できません。');
    const xml = new DOMParser().parseFromString(body, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('地点別雨量のXML形式を確認できません。');
    const value = (parent, name) => parent.getElementsByTagNameNS('*', name)[0]?.textContent;
    const Weather = [...xml.getElementsByTagNameNS('*', 'Weather')].slice(0, 100).map(item => ({ Date: value(item, 'Date'), Rainfall: value(item, 'Rainfall'), Type: value(item, 'Type') }));
    if (!Weather.length) throw new Error('地点別雨量のXMLに雨量データがありません。');
    return { Feature: [{ Property: { WeatherList: { Weather } } }] };
  } finally { clearTimeout(timeout); }
}
export function rainRows(data) {
  const values = data?.Feature?.[0]?.Property?.WeatherList?.Weather;
  if (!Array.isArray(values) || !values.length) throw new Error('地点別雨量の形式を確認できません。');
  const records = values.filter(item => item && typeof item === 'object');
  if (!records.length) throw new Error('地点別雨量に有効なデータがありません。');
  return records.slice(0, 100).map(item => ({
    date: String(item.Date ?? ''),
    rainfall: (typeof item.Rainfall === 'number' || (typeof item.Rainfall === 'string' && item.Rainfall.trim() !== '')) && Number.isFinite(Number(item.Rainfall)) && Number(item.Rainfall) >= 0 ? Number(item.Rainfall) : null,
    kind: item.Type === 'observation' ? '実況' : item.Type === 'forecast' ? '予測' : ''
  }));
}
