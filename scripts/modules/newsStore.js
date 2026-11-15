const scope = new URL('../../', import.meta.url).pathname;
export const NEWS_DATABASE = `mini-app-news:${scope}:v1`;
export const NEWS_SYNC_LOCK = `${NEWS_DATABASE}:sync`;
const blankRecord = () => ({ server_id: '', items: [], feeds: [], queue: [], synced_at: null, updated_at: null, cursors: {}, complete: {} });
const blank = () => ({ endpoint: '', records: {}, preferences: { view: 'home', category: '', feed: '', search: '' } });
let opened;
function database() {
  if (!opened) opened = new Promise((resolve, reject) => {
    const request = indexedDB.open(NEWS_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opened;
}
export async function readNewsState() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('state').objectStore('state').get('current');
    request.onsuccess = () => resolve(request.result || blank());
    request.onerror = () => reject(request.error);
  });
}
export async function changeNewsState(change) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state');
    let state, failure;
    const request = store.get('current');
    request.onsuccess = () => {
      try { state = request.result || blank(); change(state); store.put(state, 'current'); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(structuredClone(state));
    tx.onerror = () => reject(failure || tx.error || new Error('端末に保存できません。空き容量を確認してください。'));
    tx.onabort = () => reject(failure || tx.error || new Error('端末への保存を中断しました。'));
  });
}
export const newsRecord = state => state.records[state.endpoint] || blankRecord();
export function safeNewsURL(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}
function normalItem(value) {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string') return null;
  return {
    ...value, id: value.id, title: value.title.slice(0, 1000),
    url: safeNewsURL(value.url), summary: String(value.summary || '').slice(0, 5000),
    source: String(value.source || value.feed_title || ''),
    categories: Array.isArray(value.categories) ? value.categories.filter(x => typeof x === 'string') : [],
    read: value.read === true, starred: value.starred === true,
    feed_id: String(value.feed_id || ''),
    ids: Array.isArray(value.ids) ? value.ids.filter(x => typeof x === 'string') : [value.id]
  };
}
export function validateNewsSnapshot(data) {
  if (!data || typeof data.server_id !== 'string' || !data.server_id || !Array.isArray(data.items) || !Array.isArray(data.feeds)) {
    throw new Error('ニュースAPIの応答形式を確認できません。');
  }
  return data;
}
export async function saveNewsSnapshot(endpoint, data, { view = 'all', append = false, connect = false } = {}) {
  validateNewsSnapshot(data);
  return changeNewsState(state => {
    if (connect && state.endpoint && state.endpoint !== endpoint && newsRecord(state).queue.length) throw new Error('送信待ちを同期してから接続先を変更してください。');
    const record = state.records[endpoint] ||= blankRecord();
    if (record.server_id && record.server_id !== data.server_id) {
      if (record.queue.length || !connect) throw new Error('NASの識別情報が変わりました。保存済み記事と送信待ちを保持しています。設定を確認して再接続してください。');
      Object.assign(record, blankRecord());
    }
    if (connect) state.endpoint = endpoint;
    const received = data.items.map(normalItem).filter(Boolean);
    const current = new Map(record.items.map(item => [item.id, item]));
    if (view === 'all' && !append) {
      const pendingIds = new Set(record.queue.flatMap(operation => operation.ids));
      for (const [id, item] of current) if (!item.starred && !pendingIds.has(id)) current.delete(id);
    }
    for (const item of received) current.set(item.id, item);
    const nextCursor = typeof data.pagination?.next_cursor === 'string' ? data.pagination.next_cursor : null;
    if (view === 'saved') {
      if (!append) record.saved_seen = [];
      record.saved_seen = [...new Set([...(record.saved_seen || []), ...received.map(item => item.id)])];
      if (!nextCursor) for (const item of current.values()) if (item.starred && !record.saved_seen.includes(item.id)) item.starred = false;
    }
    record.items = [...current.values()];
    const latest = record.items.filter(item => !item.starred).sort((a, b) => itemTime(b) - itemTime(a));
    const keep = new Set(latest.slice(0, 500).map(item => item.id));
    for (const operation of record.queue) for (const id of operation.ids) keep.add(id);
    record.items = record.items.filter(item => item.starred || keep.has(item.id));
    record.feeds = data.feeds.filter(feed => feed && typeof feed.id === 'string').map(feed => ({ ...feed, title: String(feed.title || feed.id), url: safeNewsURL(feed.url) }));
    record.server_id = data.server_id; record.updated_at = data.updated_at || null;
    record.synced_at = new Date().toISOString();
    record.sync = data.sync || null;
    record.cursors[view] = nextCursor;
    record.complete[view] = !record.cursors[view];
  });
}
export function itemTime(item) {
  const date = Date.parse(item.published_at || item.received_at || '');
  return Number.isFinite(date) ? date : 0;
}
export function displayedNews(record) {
  const items = record.items.map(item => ({ ...item }));
  for (const operation of record.queue) for (const item of items) {
    if (operation.ids.includes(item.id)) Object.assign(item, operation.changes);
  }
  return items;
}
export function groupedNews(record) {
  const grouped = new Map();
  for (const item of displayedNews(record).sort((a, b) => itemTime(b) - itemTime(a))) {
    // Keep URL semantics intact: different query parameters may identify different articles.
    let key = item.id;
    if (item.url) { const url = new URL(item.url); url.hash = ''; key = url.href; }
    const group = grouped.get(key);
    if (group) {
      group.ids = [...new Set([...group.ids, item.id, ...item.ids])];
      group.feed_ids = [...new Set([...group.feed_ids, item.feed_id])];
      group.categories = [...new Set([...group.categories, ...item.categories])];
      group.read = group.read && item.read; group.starred = group.starred || item.starred;
    } else grouped.set(key, { ...item, ids: [...new Set([item.id, ...item.ids])], feed_ids: [item.feed_id] });
  }
  return [...grouped.values()];
}
export async function queueNewsChanges(ids, changes, expected) {
  if (!navigator.locks) throw new Error('安全な複数タブ同期には新しいブラウザーが必要です。');
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('記事を確認してください。');
  if (!Object.keys(changes).length || Object.entries(changes).some(([key, value]) => !['read', 'starred'].includes(key) || typeof value !== 'boolean')) throw new Error('未対応の状態変更です。');
  return changeNewsState(state => {
    const record = newsRecord(state);
    if (!expected || state.endpoint !== expected.endpoint || record.server_id !== expected.server_id) throw new Error('表示後に接続先が変わりました。最新の記事を開き直して操作してください。');
    if (!state.endpoint || !record.server_id) throw new Error('初回はNASへ接続して記事を取得してください。');
    if (record.queue.length >= 1000) throw new Error('送信待ちが多いため、NASへ接続して同期してください。');
    record.queue.push({ operation_id: crypto.randomUUID(), server_id: record.server_id, ids: [...new Set(ids)], changes: { ...changes }, created_at: new Date().toISOString() });
  });
}
export async function acknowledgeNewsOperation(endpoint, operationId) {
  return changeNewsState(state => {
    const record = state.records[endpoint]; if (!record) return;
    const operation = record.queue.find(item => item.operation_id === operationId);
    if (operation) for (const item of record.items) if (operation.ids.includes(item.id)) Object.assign(item, operation.changes);
    record.queue = record.queue.filter(item => item.operation_id !== operationId);
  });
}
