// IndexedDB state for 「本棚・図書館」. Separate from inventory, ledger, news and OCR storage.
const scope = new URL('../../', import.meta.url).pathname;
export const LIBRARY_DATABASE = `mini-app-library:${scope}:v1`;
export const LIBRARY_SYNC_LOCK = `${LIBRARY_DATABASE}:sync`;
const TABLES = ['places', 'series', 'bibs', 'copies', 'loans'];
export const blankRecord = () => ({ server_id: '', cursor: 0, places: {}, series: {}, bibs: {}, copies: {}, loans: {}, queue: [], synced_at: null, pending_lookups: 0 });
const blank = () => ({
  endpoint: '', records: {}, drafts: {},
  preferences: { tab: 'copies', covers: false, dueSoonDays: 3, grouping: 'series', reading: '', place: '', format: '', disposed: false, search: '', showReturned: false, periods: {} }
});
let opened;
function database() {
  if (!opened) opened = new Promise((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opened;
}
function upgrade(state) {
  const base = blank();
  return { ...base, ...state, preferences: { ...base.preferences, ...(state?.preferences || {}) }, drafts: state?.drafts || {}, records: state?.records || {} };
}
export async function readLibraryState() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('state').objectStore('state').get('current');
    request.onsuccess = () => resolve(upgrade(request.result));
    request.onerror = () => reject(request.error);
  });
}
export async function changeLibraryState(change) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state');
    let state, failure;
    const request = store.get('current');
    request.onsuccess = () => {
      try { state = upgrade(request.result); change(state); store.put(state, 'current'); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(structuredClone(state));
    tx.onerror = () => reject(failure || tx.error || new Error('端末に保存できません。空き容量を確認してください。'));
    tx.onabort = () => reject(failure || tx.error || new Error('端末への保存を中断しました。'));
  });
}
export const libraryRecord = state => state.records[state.endpoint] || blankRecord();
const pendingCount = record => record.queue.filter(item => ['pending', 'sending'].includes(item.status)).length;

/** Select an endpoint. A different NAS database (server_id) is only accepted when nothing is waiting to be sent. */
export function selectEndpoint(endpoint, serverId) {
  return changeLibraryState(state => {
    const currentRecord = state.records[state.endpoint];
    if (state.endpoint && state.endpoint !== endpoint && currentRecord && pendingCount(currentRecord)) throw new Error('送信待ちを同期してから接続先を変更してください。');
    const record = state.records[endpoint] ||= blankRecord();
    if (record.server_id && record.server_id !== serverId) {
      if (record.queue.length) throw new Error('NASのデータベースが入れ替わっています（識別情報が変わりました）。送信待ちを保持しています。端末データを書き出してから対応してください。');
      state.records[endpoint] = blankRecord();
    }
    state.endpoint = endpoint;
  });
}
export function validateSnapshot(data) {
  if (!data || typeof data.server_id !== 'string' || !Number.isInteger(data.cursor) || TABLES.some(table => !Array.isArray(data[table]))) {
    throw new Error('ライブラリAPIの応答形式を確認できません。');
  }
  return data;
}
export function applySnapshot(endpoint, data) {
  validateSnapshot(data);
  return changeLibraryState(state => {
    const record = state.records[endpoint];
    if (!record || state.endpoint !== endpoint) throw new Error('接続先が変更されました。再接続してください。');
    if (record.server_id && record.server_id !== data.server_id) throw new Error('NASの識別情報が変わりました。再接続してください。');
    record.server_id = data.server_id;
    for (const table of TABLES) {
      if (data.full) record[table] = {};
      for (const row of data[table]) {
        if (!row || typeof row.id !== 'string') continue;
        if (row.deleted) delete record[table][row.id];
        else record[table][row.id] = row;
      }
    }
    record.cursor = data.cursor;
    record.pending_lookups = Number(data.pending_lookups) || 0;
    record.synced_at = new Date().toISOString();
  });
}
/** Queue operations atomically. Each entry: { op, data, base_revision?, label }. */
export function enqueueOperations(entries, expected) {
  if (!navigator.locks) return Promise.reject(new Error('安全な複数タブ同期には新しいブラウザーが必要です。'));
  return changeLibraryState(state => {
    const record = libraryRecord(state);
    if (!state.endpoint || !record.server_id) throw new Error('初回は共通設定でNASへ接続してください。');
    if (expected && (expected.endpoint !== state.endpoint || expected.server_id !== record.server_id)) throw new Error('表示後に接続先が変わりました。開き直して操作してください。');
    if (record.queue.length + entries.length > 2000) throw new Error('送信待ちが多すぎます。NASへ接続して同期してください。');
    state.records[state.endpoint] = record;
    for (const entry of entries) {
      record.queue.push({ operation_id: crypto.randomUUID(), op: entry.op, data: structuredClone(entry.data), base_revision: entry.base_revision ?? null,
        label: String(entry.label || entry.op).slice(0, 200), status: 'pending', created_at: new Date().toISOString() });
    }
  });
}
const TABLE_OF = { place: 'places', series: 'series', copy: 'copies', loan: 'loans', bib: 'bibs' };
/** Store the per-operation results returned by POST /commands. */
export function recordResults(endpoint, results) {
  return changeLibraryState(state => {
    const record = state.records[endpoint]; if (!record) return;
    for (const result of results) {
      const item = record.queue.find(entry => entry.operation_id === result.operation_id);
      if (!item) continue;
      if (result.status === 'applied') { record.queue = record.queue.filter(entry => entry !== item); continue; }
      item.status = result.status === 'conflict' ? 'conflict' : 'rejected';
      item.code = String(result.code || ''); item.message = String(result.message || '').slice(0, 300);
      if (result.current && typeof result.current.id === 'string') {
        const table = TABLE_OF[item.op.split('.')[0]];
        if (table) record[table][result.current.id] = result.current;
        item.current_revision = result.current.revision;
      }
    }
  });
}
export function cancelOperation(operationId) {
  return changeLibraryState(state => {
    const record = libraryRecord(state);
    record.queue = record.queue.filter(item => item.operation_id !== operationId);
  });
}
/** Re-send a conflicting edit on top of the latest NAS revision (a new operation ID). */
export function overrideConflict(operationId) {
  return changeLibraryState(state => {
    const record = libraryRecord(state);
    const item = record.queue.find(entry => entry.operation_id === operationId);
    if (!item || item.status !== 'conflict' || !Number.isInteger(item.current_revision)) throw new Error('上書きできる競合ではありません。');
    Object.assign(item, { operation_id: crypto.randomUUID(), base_revision: item.current_revision, status: 'pending', code: '', message: '' });
    delete item.current_revision;
  });
}
export function saveDraft(name, value) {
  return changeLibraryState(state => { if (value === null) delete state.drafts[name]; else state.drafts[name] = structuredClone(value); });
}
export function savePreferences(changes) {
  return changeLibraryState(state => { Object.assign(state.preferences, changes); });
}
