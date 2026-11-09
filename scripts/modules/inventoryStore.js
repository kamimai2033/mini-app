// One origin-scoped IndexedDB document. Transactions serialize writes across tabs.
const databaseName = `mini-app-inventory:${new URL('../../', import.meta.url).pathname}`;
const initial = () => ({ endpoint: '', snapshot: null, queue: [], drafts: {}, mappings: {}, lastSync: null, lease: null });
let opened;
function database() {
  if (!opened) opened = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opened;
}
export async function changeState(change) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite');
    const store = tx.objectStore('state');
    let state;
    const request = store.get('current');
    request.onsuccess = () => {
      try { state = request.result || initial(); change(state); store.put(state, 'current'); }
      catch (error) { reject(error); tx.abort(); }
    };
    tx.oncomplete = () => resolve(structuredClone(state));
    tx.onerror = () => reject(tx.error || new Error('端末に保存できません。空き容量を確認してください。'));
    tx.onabort = () => reject(tx.error || new Error('端末への保存を中断しました。'));
  });
}
export async function readState() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('state').objectStore('state').get('current');
    request.onsuccess = () => resolve(request.result || initial());
    request.onerror = () => reject(request.error);
  });
}
export function normalizeEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('接続先には認証情報・クエリを含めないでください。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('信頼できるHTTPSのAPI接続先を指定してください。');
  return url.href.replace(/\/$/, '');
}
export async function api(endpoint, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit',
      signal: controller.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(result.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
    return result;
  } finally { clearTimeout(timer); }
}
export const commandGroup = op => op.startsWith('type.') ? 'type' : /^(item|individual)\./.test(op) ? 'item' : 'product';
function mapped(state, id) { return state.mappings[id] ?? id; }
export async function enqueue(op, target, data, label, editBase, draftPanel) {
  return changeState(state => {
    if (!state.endpoint || !state.snapshot) throw new Error('共通設定で接続先を設定し、初回の同期を行ってください。');
    const id = crypto.randomUUID(), group = commandGroup(op);
    const created = ['product.create', 'type.create', 'item.create'].includes(op);
    const canonicalTarget = mapped(state, target);
    const prev = [...state.queue].reverse().find(q => commandGroup(q.body.op) === group && mapped(state, q.localTarget) === canonicalTarget);
    if (prev && ['conflict', 'error'].includes(prev.status)) throw new Error('この対象には未解決の待機操作があります。共通設定で確認してください。');
    // Forms keep the revision captured when opened; refreshing the list must not rebase edits.
    const base = editBase ?? state.snapshot.revisions[`${group}:${canonicalTarget}`];
    const body = { id, epoch: state.snapshot.epoch, op, target: created ? null : target, data,
      base_revision: base || null, after: !created && prev ? prev.body.id : null };
    state.queue.push({ body, localTarget: created ? `@${id}` : target, label, status: 'pending',
      confirmed: !op.endsWith('.delete'), attempted: false, createdAt: new Date().toISOString() });
    if (draftPanel) delete state.drafts[draftPanel];
  });
}
export async function cancelCommand(id) {
  return changeState(state => {
    const item = state.queue.find(q => q.body.id === id);
    if (!item) return;
    if (item.attempted && !['conflict', 'error'].includes(item.status)) throw new Error('送信結果が未確認です。再同期して結果を確認してください。');
    const dependants = state.queue.filter(q => q.body.after === id || JSON.stringify(q.body).includes(`@${id}`));
    if (dependants.length) throw new Error('この操作に依存する待機操作を先に取り消してください。');
    state.queue = state.queue.filter(q => q.body.id !== id);
  });
}
export async function setEndpoint(endpoint) {
  return changeState(state => {
    if (state.endpoint === endpoint) return;
    if (state.queue.length || (state.lease && state.lease.until > Date.now())) throw new Error('送信待ち・同期中は接続先を変更できません。');
    Object.assign(state, initial(), { endpoint });
  });
}
export function localView(state) {
  const s = structuredClone(state.snapshot || { products: [], types: [], items: [], notifications: [], revisions: {} });
  // New parents remain selectable offline. Established records show the last NAS snapshot.
  for (const q of state.queue) {
    const op = q.body.op;
    if (!['product.create', 'type.create', 'item.create'].includes(op)) continue;
    const key = op === 'product.create' ? 'products' : op === 'type.create' ? 'types' : 'items';
    s[key].push({ ...q.body.data, id: q.localTarget, pending: true, purchases: [], individuals: [] });
  }
  return s;
}
export class InventorySync extends EventTarget {
  constructor() { super(); this.owner = crypto.randomUUID(); this.running = false; this.message = '未接続'; this.online = false; }
  notify() { this.dispatchEvent(new Event('change')); }
  async run() {
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    let acquired = false;
    try {
      let state = await changeState(s => {
        if (!s.lease || s.lease.until < Date.now()) { s.lease = { owner: this.owner, until: Date.now() + 45000 }; acquired = true; }
      });
      if (!acquired || !state.endpoint) return;
      this.message = 'NASに接続中…'; this.notify();
      const snapshot = await api(state.endpoint, '/api/mobile/snapshot');
      if (snapshot.protocol !== 1 || !snapshot.epoch || !snapshot.revisions) throw new Error('NAS側のモバイル連携APIを更新してください。');
      this.online = true;
      await changeState(s => {
        s.snapshot = snapshot; s.lastSync = new Date().toISOString();
        for (const q of s.queue) if (q.body.epoch !== snapshot.epoch) { q.status = 'conflict'; q.error = 'サーバーが復元・交換されています。内容を控えて取り消し、再入力してください。'; }
      });
      if (snapshot.maintenance) { this.message = `保守中：${snapshot.maintenance}（書込み待機）`; return; }
      // Preserve queue order. A conflict never silently rebases subsequent edits.
      while (true) {
        state = await readState();
        const q = state.queue[0];
        if (!q) break;
        if (['conflict', 'error'].includes(q.status)) { this.message = '送信待ちの確認が必要です（共通設定）'; return; }
        if (!q.confirmed) { this.message = '削除の送信確認が必要です（共通設定）'; return; }
        let allowed = false;
        await changeState(s => {
          if (s.lease?.owner !== this.owner) return;
          s.lease.until = Date.now() + 45000;
          const stored = s.queue.find(x => x.body.id === q.body.id);
          if (stored && stored.confirmed && !['conflict', 'error'].includes(stored.status)) {
            stored.status = 'sending'; stored.attempted = true; allowed = true;
          }
        });
        if (!allowed) return;
        try {
          const result = await api(state.endpoint, '/api/mobile/commands', q.body);
          if (result.id !== q.body.id) throw new Error('NASの応答を確認できませんでした。');
          await changeState(s => {
            if (result.created) s.mappings[`@${q.body.id}`] = result.target;
            s.queue = s.queue.filter(x => x.body.id !== q.body.id);
            // Preserve dependency IDs for still-pending bodies; the server resolves receipts.
          });
        } catch (error) {
          await changeState(s => {
            const stored = s.queue.find(x => x.body.id === q.body.id);
            if (!stored) return;
            stored.status = error.status === 409 ? 'conflict' : error.status >= 400 && error.status < 500 ? 'error' : 'uncertain';
            stored.error = error.message;
            if (stored.body.op.endsWith('.delete')) stored.confirmed = false;
          });
          if (error.status === 409) {
            // A concurrent write may have happened after the initial snapshot.
            // Refresh the display only; never change the queued command's base.
            try {
              const latest = await api(state.endpoint, '/api/mobile/snapshot');
              if (latest.protocol === 1) await changeState(s => { s.snapshot = latest; s.lastSync = new Date().toISOString(); });
            } catch { /* Keep the conflict and the last successfully fetched snapshot. */ }
          }
          throw error;
        }
        this.notify();
      }
      const fresh = await api(state.endpoint, '/api/mobile/snapshot');
      await changeState(s => { s.snapshot = fresh; s.lastSync = new Date().toISOString(); });
      this.message = 'NASと同期済み';
    } catch (error) {
      this.online = !!error.status;
      this.message = error.status ? `同期停止：${error.message}` : `NASに接続できません。前回の表示と送信待ちを保持しています。${error.message.includes('更新') ? error.message : ''}`;
    } finally {
      if (acquired) await changeState(s => { if (s.lease?.owner === this.owner) s.lease = null; }).catch(() => { this.message = '端末に保存できません。空き容量を確認してください。'; });
      this.running = false; this.notify();
      if (this.rerun) { this.rerun = false; queueMicrotask(() => this.run()); }
    }
  }
}
