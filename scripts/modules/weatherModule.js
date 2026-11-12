import { createWeatherMap } from './weatherMap.js';
import { CITIES, FORECAST_TTL, RADAR_TTL, loadWeatherState, saveWeatherState, normalizeWorker, validCenter, validForecastData, centerKey, parseJmaTime, makeRadarFrames, fetchJSON, fetchRainData, rainRows } from './weatherData.js';

const $ = id => document.getElementById(`weather-${id}`);
const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = String(text); if (cls) value.className = cls; return value; };
const dateText = value => value !== null && value !== undefined && value !== '' && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '不明';
const textValue = value => value === null || value === undefined || value === '' ? '—' : String(value).slice(0, 10000);
const temperature = value => value?.celsius === null || value?.celsius === undefined ? '—' : `${textValue(value.celsius)}℃`;

export function initWeather() {
  const section = document.getElementById('weather-section');
  const state = loadWeatherState();
  let map, frames = [], frameIndex = 0, playback = null;
  let forecastSequence = 0, rainSequence = 0, radarSequence = 0;
  let forecastController, rainController, radarControllers = [];
  let forecastStartedAt = 0, radarFetchedAt = 0, radarAttemptedAt = 0, rainAttemptedAt = 0;
  let radarLoading = false, locating = false, locationAuthorized = false;
  const visible = () => !section.hidden && !document.hidden;
  const persist = () => {
    try { saveWeatherState(state); }
    catch { $('settings-status').textContent = '端末に保存できませんでした。空き容量・ブラウザの保存設定を確認してください。'; }
  };
  $('city').value = state.city;
  $('worker-url').value = state.workerURL;

  function renderCenter() {
    $('center-label').textContent = `中心：${state.center.label}（${state.center.lat.toFixed(4)}, ${state.center.lon.toFixed(4)}）／半径2km`;
  }
  function renderForecast(prefix = '') {
    const container = $('forecast-result'); container.replaceChildren();
    const saved = state.forecasts[state.city];
    if (!saved) {
      $('forecast-status').textContent = `${prefix}${prefix ? ' ' : ''}予報は未取得です。`;
      return;
    }
    const stale = Date.now() - saved.fetchedAt > FORECAST_TTL || Date.now() - new Date(saved.data.publicTime).getTime() > 24 * 60 * 60 * 1000;
    $('forecast-status').textContent = `${prefix}${prefix ? ' ／ ' : ''}${!navigator.onLine ? 'オフライン・前回の予報' : stale ? '前回の予報（更新が必要）' : '保存済みの予報'} ／ 取得：${dateText(saved.fetchedAt)} ／ 発表：${dateText(saved.data.publicTime)}`;
    container.append(node('h4', textValue(saved.data.title)));
    const grid = node('div', undefined, 'weather-forecast-grid');
    for (const forecast of saved.data.forecasts.slice(0, 7)) {
      const card = node('article');
      card.append(node('h4', `${textValue(forecast.dateLabel)} ${textValue(forecast.date)}`), node('p', textValue(forecast.telop)));
      if (forecast.detail?.wind) card.append(node('p', `風：${textValue(forecast.detail.wind)}`));
      card.append(node('p', `最高 ${temperature(forecast.temperature?.max)} ／ 最低 ${temperature(forecast.temperature?.min)}`));
      const chances = node('dl', undefined, 'weather-forecast-metrics');
      for (const [key, label] of [['T00_06', '0〜6時'], ['T06_12', '6〜12時'], ['T12_18', '12〜18時'], ['T18_24', '18〜24時']]) {
        chances.append(node('dt', label), node('dd', textValue(forecast.chanceOfRain?.[key])));
      }
      card.append(chances); grid.append(card);
    }
    container.append(grid);
    if (saved.data.description?.text) {
      const details = node('details'); details.append(node('summary', '天気概況'), node('p', textValue(saved.data.description.text)));
      container.append(details);
    }
  }
  async function refreshForecast(force = false) {
    const city = state.city;
    const saved = state.forecasts[city];
    renderForecast();
    if (!navigator.onLine || (!force && saved && Date.now() - saved.fetchedAt < FORECAST_TTL)) { $('forecast-refresh').disabled = false; return; }
    const sequence = ++forecastSequence;
    forecastController?.abort();
    const controller = new AbortController(); forecastController = controller;
    $('forecast-refresh').disabled = true;
    $('forecast-status').textContent = `予報を取得中…${saved ? ` ／ 前回取得：${dateText(saved.fetchedAt)}` : ''}`;
    // Region switches and refresh clicks still respect the provider's request interval.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 650 - (Date.now() - forecastStartedAt))));
    if (sequence !== forecastSequence || controller.signal.aborted) return;
    forecastStartedAt = Date.now();
    try {
      const data = await fetchJSON(`https://weather.tsukumijima.net/api/forecast?city=${encodeURIComponent(city)}`, controller);
      if (!validForecastData(data)) throw new Error('予報の形式を確認できません。');
      if (sequence !== forecastSequence) return;
      state.forecasts[city] = { data, fetchedAt: Date.now() }; persist();
      renderForecast('予報を更新しました');
    } catch (error) {
      if (sequence !== forecastSequence) return;
      renderForecast(`予報を取得できませんでした${error.name === 'AbortError' ? '（時間切れ・通信中断）' : `（${error.message}）`}`);
    } finally { if (sequence === forecastSequence) $('forecast-refresh').disabled = false; }
  }
  function renderRain(prefix = '') {
    const container = $('rain-result'); container.replaceChildren();
    const saved = state.rain;
    const matches = saved?.centerKey === centerKey(state.center) && saved?.workerURL === state.workerURL;
    if (!state.workerURL) { $('rain-status').textContent = '地点別雨量は無効です。接続先設定で有効にできます。'; return; }
    if (!matches) { $('rain-status').textContent = prefix || (state.center.kind === 'location' ? 'この地点の雨量は未取得です。' : '「現在地を使用」で地点別雨量を取得できます。'); return; }
    let rows;
    try { rows = rainRows(saved.data); } catch { $('rain-status').textContent = '保存済み雨量を読み込めません。再取得してください。'; return; }
    $('rain-status').textContent = `${prefix}${prefix ? ' ／ ' : ''}${!navigator.onLine || Date.now() - saved.fetchedAt > RADAR_TTL ? '前回の雨量' : '保存済みの雨量'} ／ 取得：${dateText(saved.fetchedAt)}`;
    const table = node('table'), head = node('thead'), tr = node('tr');
    for (const label of ['時刻', '区分', '雨量']) { const th = node('th', label); th.scope = 'col'; tr.append(th); }
    head.append(tr); const body = node('tbody');
    for (const row of rows) {
      const line = node('tr');
      const time = /^\d{12}$/.test(row.date) ? `${row.date.slice(4, 6)}/${row.date.slice(6, 8)} ${row.date.slice(8, 10)}:${row.date.slice(10, 12)}` : row.date.slice(0, 40);
      line.append(node('td', time), node('td', row.kind || '—'), node('td', row.rainfall === null ? '不明' : `${row.rainfall} mm/h`)); body.append(line);
    }
    table.append(head, body); container.append(table);
  }
  async function refreshRain(force = false) {
    renderRain();
    if (!state.workerURL || state.center.kind !== 'location' || !locationAuthorized || !navigator.onLine) return;
    const key = centerKey(state.center), endpoint = state.workerURL;
    if (!force && state.rain?.centerKey === key && state.rain?.workerURL === endpoint && Date.now() - state.rain.fetchedAt < RADAR_TTL) return;
    if (!force && Date.now() - rainAttemptedAt < 30000) return;
    rainAttemptedAt = Date.now();
    const sequence = ++rainSequence;
    rainController?.abort(); const controller = new AbortController(); rainController = controller;
    $('rain-status').textContent = '地点別雨量を取得中…';
    try {
      const url = new URL(endpoint); url.searchParams.set('lat', state.center.lat); url.searchParams.set('lon', state.center.lon);
      const data = await fetchRainData(url.href, controller); rainRows(data);
      if (sequence !== rainSequence || key !== centerKey(state.center) || endpoint !== state.workerURL) return;
      state.rain = { centerKey: key, workerURL: endpoint, data, fetchedAt: Date.now() }; persist(); renderRain('雨量を更新しました');
    } catch (error) {
      if (sequence !== rainSequence) return;
      renderRain(`地点別雨量を取得できませんでした（${error.name === 'AbortError' ? '時間切れ・通信中断' : error.message}）`);
    }
  }
  function stopPlayback() {
    clearInterval(playback); playback = null;
    $('play').textContent = '再生'; $('play').setAttribute('aria-pressed', 'false');
  }
  function showFrame(index) {
    const frame = frames[index]; if (!frame || !map || !navigator.onLine) return;
    frameIndex = index;
    $('radar-slider').value = String(index);
    $('radar-time').textContent = `${dateText(parseJmaTime(frame.validtime))}（${frame.kind === 'observation' ? '実況' : '予測'}）`;
    map.showFrame(frame);
  }
  function setRadarUnavailable(message) {
    stopPlayback(); map?.clearRadar();
    $('radar-status').textContent = message;
    $('radar-time').textContent = '雨雲画像は未表示';
    $('radar-slider').disabled = true; $('play').disabled = true;
    $('radar-refresh').disabled = false;
  }
  async function refreshRadar(force = false) {
    if (!navigator.onLine) { setRadarUnavailable('オフラインです。雨雲画像は取得できません。無降雨を示すものではありません。'); return; }
    if (radarLoading || (!force && radarFetchedAt && Date.now() - radarFetchedAt < RADAR_TTL)) return;
    if (!force && Date.now() - radarAttemptedAt < 30000) return;
    radarAttemptedAt = Date.now(); radarLoading = true; $('radar-refresh').disabled = true;
    const sequence = ++radarSequence;
    stopPlayback(); $('radar-status').textContent = '雨雲の時刻一覧を取得中…';
    radarControllers = [new AbortController(), new AbortController()];
    try {
      const results = await Promise.allSettled(['N1', 'N2'].map((type, i) => fetchJSON(`https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_${type}.json`, radarControllers[i])));
      if (sequence !== radarSequence || !navigator.onLine) return;
      const values = results.map(result => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []);
      frames = makeRadarFrames(values[0], values[1]);
      if (!frames.length) throw new Error('表示できる雨雲データがありません。');
      radarFetchedAt = Date.now();
      const observationIndex = frames.findLastIndex(frame => frame.kind === 'observation');
      const slider = $('radar-slider'); slider.min = '0'; slider.max = String(frames.length - 1); slider.disabled = false; $('play').disabled = frames.length < 2;
      const partial = results.some((r, i) => r.status === 'rejected' || !values[i].length);
      const stale = observationIndex >= 0 && Date.now() - parseJmaTime(frames[observationIndex].validtime) > 15 * 60 * 1000;
      $('radar-status').textContent = `${partial ? '一部の時刻一覧を取得できません。取得できた分を表示します。' : '雨雲の時刻一覧を更新しました。'}${stale ? ' 実況が古くなっています。' : ''} 取得：${dateText(radarFetchedAt)}`;
      showFrame(observationIndex < 0 ? 0 : observationIndex);
    } catch (error) {
      if (sequence === radarSequence) setRadarUnavailable(`雨雲を取得できませんでした（${error.message}）。無降雨を示すものではありません。`);
    } finally { if (sequence === radarSequence) { radarLoading = false; $('radar-refresh').disabled = false; } }
  }
  function refreshVisible() {
    if (!visible()) return;
    map?.resize(); refreshForecast(); refreshRadar(); refreshRain();
  }
  $('city').addEventListener('change', () => {
    if (!Object.hasOwn(CITIES, $('city').value)) return;
    ++forecastSequence; forecastController?.abort();
    state.city = $('city').value;
    if (state.center.kind === 'city') { state.center = { ...CITIES[state.city], kind: 'city' }; map?.setCenter(state.center); renderCenter(); }
    persist(); refreshForecast();
  });
  $('forecast-refresh').addEventListener('click', () => refreshForecast(true));
  $('radar-refresh').addEventListener('click', () => { refreshRadar(true); refreshRain(true); });
  $('reset-view').addEventListener('click', () => map?.resetView());
  $('radar-opacity').addEventListener('input', () => map?.setOpacity(Number($('radar-opacity').value)));
  $('radar-slider').addEventListener('input', () => { stopPlayback(); showFrame(Number($('radar-slider').value)); });
  $('play').setAttribute('aria-pressed', 'false');
  $('play').addEventListener('click', () => {
    if (playback) { stopPlayback(); return; }
    if (frames.length < 2 || !navigator.onLine || !visible()) return;
    $('play').textContent = '停止'; $('play').setAttribute('aria-pressed', 'true');
    playback = setInterval(() => { if (!visible() || !navigator.onLine) stopPlayback(); else showFrame((frameIndex + 1) % frames.length); }, 1200);
  });
  $('location').addEventListener('click', () => {
    if (locating) return;
    if (!navigator.geolocation) { $('map-status').textContent = 'このブラウザは位置情報に対応していません。地域の代表地点で表示します。'; return; }
    locating = true; $('location').disabled = true; $('map-status').textContent = '現在地を取得中…';
    navigator.geolocation.getCurrentPosition(position => {
      locating = false; $('location').disabled = false;
      const center = { lat: position.coords.latitude, lon: position.coords.longitude, label: '現在地', kind: 'location' };
      if (!validCenter(center)) { $('map-status').textContent = 'この位置は地図の表示範囲外です。'; return; }
      locationAuthorized = true;
      state.center = center; persist(); renderCenter(); map?.setCenter(center);
      $('map-status').textContent = `現在地を中心に半径2kmを表示します。${Number.isFinite(position.coords.accuracy) ? ` 位置精度：約${Math.round(position.coords.accuracy)}m` : ''}`;
      refreshRadar(); refreshRain(true);
    }, error => {
      locating = false; $('location').disabled = false;
      $('map-status').textContent = `位置情報を取得できませんでした（${error.code === 1 ? '許可されていません' : error.code === 3 ? '時間切れ' : '位置を特定できません'}）。表示中の地点を維持します。`;
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
  $('settings-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const endpoint = normalizeWorker($('worker-url').value);
      ++rainSequence; rainController?.abort();
      if (endpoint !== state.workerURL) state.rain = null;
      state.workerURL = endpoint; $('worker-url').value = endpoint;
      $('settings-status').textContent = endpoint ? '地点別雨量の接続先を保存しました。' : '地点別雨量を無効にしました。';
      persist(); refreshRain(true);
    } catch (error) { $('settings-status').textContent = error.message; }
  });
  const pause = () => { if (!visible()) stopPlayback(); else refreshVisible(); };
  new MutationObserver(pause).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', pause);
  window.addEventListener('pageshow', refreshVisible);
  window.addEventListener('pagehide', stopPlayback);
  window.addEventListener('online', () => { radarFetchedAt = 0; radarAttemptedAt = 0; rainAttemptedAt = 0; refreshVisible(); });
  window.addEventListener('offline', () => {
    ++radarSequence; radarLoading = false; radarControllers.forEach(controller => controller.abort());
    setRadarUnavailable('オフラインです。雨雲画像は取得できません。無降雨を示すものではありません。');
    renderForecast(); renderRain();
  });
  setInterval(refreshVisible, 60000);
  renderCenter(); renderForecast(); renderRain();
  try { map = createWeatherMap($('map'), { center: state.center, onStatus: text => { $('map-status').textContent = text; } }); }
  catch { $('map-status').textContent = '地図を表示できませんでした。予報は引き続き利用できます。'; }
  refreshVisible();
}
