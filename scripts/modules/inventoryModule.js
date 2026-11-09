import { readState, changeState, normalizeEndpoint, api, enqueue, cancelCommand, setEndpoint, localView, InventorySync } from './inventoryStore.js';
import { startScan, stopScan, scanImage } from './janScanner.js';

const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const stamp = value => value ? new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '未同期';
const display = value => value ?? '—';
const statuses = [['active', '使用中'], ['checked', '確認済'], ['postponed', '延期中'], ['discarded', '廃棄済']];
const productFields = [['name', '商品名', 'text', true], ['jan', 'JANコード', 'text'], ['storage_location', '保管場所', 'text'], ['pieces_per_box', '1箱の個数', 'number', true, 1], ['usage_days_per_piece', '1個の使用日数', 'number', true, 1]];
const purchaseFields = [['purchase_date', '購入日', 'date', true, today], ['store', '購入店舗', 'text'], ['boxes', '箱数', 'number', true, 1], ['pieces_per_box', '購入時の1箱の個数', 'number', true, 1], ['price', '価格（円・任意）', 'number'], ['counted', '棚卸しへの計上', 'select', false, '', [['', '日付から自動判定'], ['0', '未計上（在庫に加算）'], ['1', '計上済（棚卸しに含む）']]]];
const inventoryFields = [['checked_at', '棚卸し日', 'date', true, today], ['sealed_boxes', '未開封の箱数', 'number', true, 0], ['opened_unused_pieces', '開封済みの未使用個数', 'number', true, 0], ['in_use_remaining_days', '使用中の残日数', 'number', true, 0]];
const typeFields = [['name', '種類名', 'text', true], ['renewal_period_days', '更新周期（日・空欄で対象外）', 'number']];
const formDefinitions = op => op.startsWith('product.') ? productFields : op.startsWith('purchase.') ? purchaseFields : op.startsWith('inventory.') ? inventoryFields : op.startsWith('expected.') ? [['date', '使い切り予定日（空欄で自動計算）', 'date']] : op.startsWith('type.') ? typeFields : null;
let sync, state, rendering = Promise.resolve();
function message(text) { $('inventory-message').textContent = text; }
function action(text, callback) {
  const button = el('button', text); button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await callback(); } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });
  return button;
}
function buttons(...items) { const row = el('div', undefined, 'button-row'); row.append(...items); return row; }
async function editForm(panel, op, target, values = {}, label = '', fields = formDefinitions(op), base) {
  const current = await readState();
  if (current.drafts[panel] && !confirm('入力中の下書きを置き換えますか？残す場合はキャンセルして、先に保存してください。')) return;
  const group = op.startsWith('type.') ? 'type' : /^(item|individual)\./.test(op) ? 'item' : 'product';
  const draft = { op, target, values, label, fields, base: base ?? state.snapshot?.revisions[`${group}:${state.mappings[target] ?? target}`] ?? null };
  // Functions cannot be structured-cloned into IndexedDB.
  draft.fields = fields.map(f => f.map(x => typeof x === 'function' ? x() : x));
  return changeState(s => { s.drafts[panel] = draft; }).then(() => drawForm(panel, draft));
}
function drawForm(panel, draft) {
  const container = $(`inventory-${panel}-editor`); container.replaceChildren();
  if (!draft) return;
  const heading = el('h4', draft.label), form = el('form', undefined, 'inventory-form');
  const fields = el('div', undefined, 'inventory-fields');
  for (const [key, labelText, type, required, fallback, options] of draft.fields) {
    const label = el('label', labelText);
    const input = el(type === 'select' ? 'select' : 'input');
    input.name = key;
    if (type === 'select') {
      for (const [value, text] of options) { const option = el('option', text); option.value = value; input.append(option); }
    } else {
      input.type = type;
      if (type === 'number') {
        input.min = ['pieces_per_box', 'usage_days_per_piece', 'quantity', 'renewal_period_days', 'postpone_days'].includes(key) ? '1' : '0';
        input.step = ['price', 'usage_days_per_piece', 'in_use_remaining_days'].includes(key) ? 'any' : '1';
        input.max = key === 'quantity' ? '1000' : '1000000';
      }
      if (type === 'text') input.maxLength = 10000;
    }
    input.required = !!required;
    input.value = draft.values[key] ?? fallback ?? '';
    label.append(input); fields.append(label);
  }
  const values = () => {
    const data = {};
    for (const [key, , type] of draft.fields) {
      const value = form.elements[key].value;
      if (key === 'counted' && value === '') continue;
      data[key] = type === 'number' ? value === '' ? null : Number(value) : key === 'type_id' ? value === '' ? null : value.startsWith('@') ? value : Number(value) : key === 'counted' ? Number(value) : value;
    }
    for (const key of ['purchase_id', 'individual_id']) if (key in draft.values) data[key] = draft.values[key];
    return data;
  };
  form.append(fields);
  if (draft.op.startsWith('product.')) {
    const video = el('video'); video.playsInline = true; video.muted = true; video.hidden = true;
    const scanStatus = el('p', '', 'hint');
    const found = code => { form.elements.jan.value = code; form.dispatchEvent(new Event('input')); scanStatus.textContent = `読取り：${code}`; stopScan(); video.hidden = true; };
    const fileLabel = el('label', 'JANコードの写真から読取');
    const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.setAttribute('capture', 'environment');
    file.addEventListener('change', async () => {
      try { if (file.files[0]) { scanStatus.textContent = '読取り中…'; found(await scanImage(file.files[0])); } }
      catch (error) { scanStatus.textContent = error.message; }
    });
    fileLabel.append(file);
    form.append(buttons(action('JANカメラ', async () => {
      video.hidden = false; scanStatus.textContent = 'バーコードを横向きに映してください。';
      try { await startScan(video, found); } catch (error) { video.hidden = true; scanStatus.textContent = error.message; }
    }), action('読取停止', () => { stopScan(); video.hidden = true; })), video, scanStatus, fileLabel);
  }
  if (draft.op === 'inventory.update') form.append(el('p', '棚卸し確定時は、既存の購入履歴を計上済みにします。', 'hint'));
  if (draft.op.startsWith('purchase.')) form.append(el('p', '棚卸しと同じ日の購入は自動判定では未計上になります。棚卸しに含めた場合は「計上済」を選んでください。', 'hint'));
  const save = el('button', '保存・送信待ちに追加'); save.type = 'submit';
  form.append(buttons(save, action('入力を閉じる', async () => {
    stopScan(); await changeState(s => { delete s.drafts[panel]; }); container.replaceChildren();
  })));
  form.addEventListener('input', () => {
    draft.values = values();
    changeState(s => { s.drafts[panel] = structuredClone(draft); }).catch(error => message(`下書きを保存できません：${error.message}`));
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (save.disabled) return; save.disabled = true;
    try {
      await enqueue(draft.op, draft.target, values(), draft.label, draft.base, panel);
      container.replaceChildren(); stopScan();
      message('端末に保存しました。NASへの送信完了は同期状態で確認できます。');
      await render(); sync.run();
    } catch (error) { message(error.message); } finally { save.disabled = false; }
  });
  container.append(heading, form);
}
function record(title) { const box = el('article', undefined, 'inventory-record'); box.append(el('h4', title)); return box; }
function empty(container, rows) { if (!rows.length) container.append(el('p', '登録はありません。')); }
async function remove(op, target, data, label) {
  if (!confirm(`${label}を削除待ちに追加しますか？送信前に共通設定で再確認します。`)) return;
  await enqueue(op, target, data, `${label}：削除`); await render(); sync.run();
}
function renderDaily(view) {
  const list = $('inventory-products'); list.replaceChildren();
  const search = $('inventory-product-search').value.trim().toLowerCase();
  const rows = view.products.filter(p => `${p.name} ${p.jan || ''} ${p.storage_location || ''}`.toLowerCase().includes(search));
  empty(list, rows);
  for (const p of rows) {
    const box = record(`${p.name}${p.pending ? '（新規・送信待ち）' : ''}`);
    box.append(el('p', `JAN：${display(p.jan)} ／ 保管：${display(p.storage_location)} ／ 1箱：${display(p.pieces_per_box)}個 ／ 1個：${display(p.usage_days_per_piece)}日`));
    box.append(el('p', `使い切り予定：${display(p.expected_empty_date)}（${p.expected_date_source === 'manual' ? '手動' : '自動'}） ／ 残日数：${display(p.estimated_days)}`));
    box.append(el('p', `棚卸し：${display(p.last_checked_at)} ／ 未開封：${display(p.sealed_boxes)}箱 ／ 開封済未使用：${display(p.opened_unused_pieces)}個 ／ 使用中：${display(p.in_use_remaining_days)}日`));
    if (p.error) box.append(el('p', p.error, 'inventory-error'));
    box.append(buttons(
      action('商品編集', () => editForm('daily', 'product.update', p.id, p, `${p.name}：商品編集`)),
      action('購入追加', () => editForm('daily', 'purchase.create', p.id, { pieces_per_box: p.pieces_per_box }, `${p.name}：購入追加`)),
      action('棚卸確認', () => editForm('daily', 'inventory.update', p.id, { ...p, checked_at: today() }, `${p.name}：棚卸し`)),
      action('予定変更', () => editForm('daily', 'expected.update', p.id, { date: p.expected_date_source === 'manual' ? p.expected_empty_date : '' }, `${p.name}：予定日`)),
      action('商品削除', () => remove('product.delete', p.id, {}, p.name))
    ));
    const details = el('details'); details.append(el('summary', `購入履歴（${p.purchases?.length || 0}件）`));
    for (const purchase of p.purchases || []) {
      const row = el('div', undefined, 'inventory-history');
      row.append(el('p', `${purchase.purchase_date} ／ ${purchase.store || '店舗未記入'} ／ ${purchase.boxes}箱 × ${purchase.pieces_per_box}個 ／ ${display(purchase.price)}円 ／ ${purchase.counted ? '計上済' : '未計上'}`));
      row.append(buttons(action('履歴編集', () => editForm('daily', 'purchase.update', p.id, { ...purchase, purchase_id: purchase.id }, `${p.name}：購入編集`)), action('履歴削除', () => remove('purchase.delete', p.id, { purchase_id: purchase.id }, `${p.name}の購入履歴`)))); details.append(row);
    }
    box.append(details); list.append(box);
  }
}
function itemFields(view, creating) {
  const fields = [['name', '衣類名', 'text', true], ['product_number', '品番', 'text'], ['type_id', '種類', 'select', false, '', [['', '未指定'], ...view.types.map(t => [String(t.id), `${t.name}${t.pending ? '（送信待ち）' : ''}`])]], ['purchase_date', '購入日', 'date', true, today]];
  if (creating) fields.push(['quantity', '個体数', 'number', true, 1]);
  return fields;
}
function renderClothes(view) {
  const types = $('inventory-types'); types.replaceChildren(); empty(types, view.types);
  for (const type of view.types) {
    const row = el('div', undefined, 'inventory-history'); row.append(el('p', `${type.name}${type.pending ? '（送信待ち）' : ''} ／ 更新周期：${type.renewal_period_days ?? '対象外'}${type.renewal_period_days ? '日' : ''}`), action('種類編集', () => editForm('clothing', 'type.update', type.id, type, `${type.name}：種類編集`))); types.append(row);
  }
  const list = $('inventory-items'); list.replaceChildren();
  const query = $('inventory-item-search').value.trim().toLowerCase();
  const items = view.items.filter(i => `${i.name} ${i.product_number || ''} ${i.type_name || ''}`.toLowerCase().includes(query));
  empty(list, items);
  for (const item of items) {
    const box = record(`${item.name}${item.pending ? '（新規・送信待ち）' : ''}`);
    box.append(el('p', `${item.type_name || '種類未指定'} ／ 品番：${item.product_number || '—'} ／ 購入：${item.purchase_date}`));
    box.append(buttons(action('衣類編集', () => editForm('clothing', 'item.update', item.id, item, `${item.name}：衣類編集`, itemFields(view, false))), action('衣類削除', () => remove('item.delete', item.id, {}, item.name))));
    for (const ind of item.individuals || []) {
      const row = el('div', undefined, 'inventory-history');
      row.append(el('p', `#${ind.individual_number} ／ ${statuses.find(s => s[0] === ind.status)?.[1] || ind.status} ／ 更新目安：${display(ind.due_date)} ／ 備考：${ind.note || '—'}`));
      if (ind.error) row.append(el('p', ind.error, 'inventory-error'));
      const values = { ...ind, individual_id: ind.id };
      row.append(buttons(
        action('状態変更', () => editForm('clothing', 'individual.update', item.id, values, `${item.name} #${ind.individual_number}：状態`, [['status', '状態', 'select', true, 'active', statuses], ['note', '備考', 'text']])),
        action('期限変更', () => editForm('clothing', 'individual.update', item.id, values, `${item.name} #${ind.individual_number}：期限`, [['due_date_override', '手動期限（空欄で自動・延期解除）', 'date']])),
        action('期限延期', () => editForm('clothing', 'individual.update', item.id, { individual_id: ind.id }, `${item.name} #${ind.individual_number}：延期`, [['postpone_days', '延期日数', 'number', true, 7]]))
      )); box.append(row);
    }
    if (item.pending) box.append(el('p', '個体ごとの操作は、新規登録がNASで確定した後に利用できます。', 'hint'));
    list.append(box);
  }
}
function renderNotifications(view) {
  const list = $('inventory-notifications'); list.replaceChildren(); empty(list, view.notifications);
  for (const n of view.notifications) {
    const row = el('article', undefined, 'inventory-history');
    row.append(el('p', `${n.target_date} ／ ${n.sent ? '送信済' : '未送信'} ／ ${n.kind}`), el('p', n.message)); list.append(row);
  }
  const settings = state.snapshot?.notification_settings;
  $('inventory-notification-settings').textContent = settings ? `Discord：${settings.webhook_configured ? '設定済' : '未設定'} ／ 日用品：${settings.daily_warn_days}日前 ／ 衣類：${settings.clothing_warn_days}日前。通知先はNAS側の環境設定で管理します。` : '初回同期後に通知設定を表示します。';
}
function renderQueue() {
  const list = $('inventory-queue'); list.replaceChildren();
  if (!state.queue.length) list.append(el('p', '送信待ちはありません。'));
  const labels = { pending: '送信待ち', sending: '送信中・結果確認中', uncertain: '送信結果未確認', conflict: '競合・要確認', error: '入力エラー' };
  for (const q of state.queue) {
    const row = el('article', undefined, 'inventory-history');
    row.append(el('p', `${q.label} ／ ${labels[q.status]} ／ ${stamp(q.createdAt)}`));
    if (q.error) row.append(el('p', q.error, 'inventory-error'));
    const details = el('details'); details.append(el('summary', '待機内容を確認'), el('pre', JSON.stringify(q.body.data, null, 2))); row.append(details);
    const actions = buttons();
    if (!q.confirmed && !['conflict', 'error'].includes(q.status)) actions.append(action('削除を送信', async () => {
      if (!sync.online) throw new Error('先に同期し、NASへの接続を確認してください。');
      if (!confirm(`${q.label}をNASへ送信します。関連履歴も削除される場合があります。続行しますか？`)) return;
      await changeState(s => { const target = s.queue.find(x => x.body.id === q.body.id); if (target) target.confirmed = true; }); await sync.run();
    }));
    if (!q.attempted || ['conflict', 'error'].includes(q.status)) actions.append(action('待機を取消', async () => {
      if (confirm('端末内の待機操作を取り消しますか？NASに確定済みのデータは変更しません。')) { await cancelCommand(q.body.id); await render(); sync.run(); }
    }));
    else actions.append(el('span', '結果未確認の操作は、再同期で確定するまで取消できません。', 'hint'));
    row.append(actions); list.append(row);
  }
}
async function render() {
  rendering = rendering.catch(() => {}).then(async () => {
    state = await readState(); const view = localView(state);
    $('inventory-sync-status').textContent = `${sync.running ? 'NASと同期中…' : sync.message} ／ 最終取得：${stamp(state.lastSync)} ／ 送信待ち：${state.queue.length}件`;
    $('inventory-data-note').textContent = state.snapshot ? '一覧は最後にNASから取得した値です。待機中の変更内容は共通設定で確認できます。' : '初回は共通設定でNASの接続先を登録してください。';
    renderDaily(view); renderClothes(view); renderNotifications(view); renderQueue();
  });
  return rendering;
}
async function onlineAction(path, data) {
  const current = await readState();
  if (!current.endpoint) throw new Error('接続先を設定してください。');
  if (current.queue.length || sync.running) throw new Error('送信待ちを解消し、同期が終わってから実行してください。');
  const status = await api(current.endpoint, '/api/status');
  if (status.maintenance && data !== undefined) throw new Error(`NASは保守中です：${status.maintenance}`);
  return api(current.endpoint, path, data);
}
async function backups() {
  const result = await onlineAction('/api/backup/list'); const list = $('inventory-backups'); list.replaceChildren();
  for (const backup of result) {
    const row = el('div', undefined, 'inventory-history'); row.append(el('p', backup.prefix));
    for (const file of backup.files) row.append(action(`保存：${file}`, async () => {
      const current = await readState();
      const response = await fetch(`${current.endpoint}/api/backup/download?file=${encodeURIComponent(file)}`, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error(`バックアップ取得失敗：HTTP ${response.status}`);
      download(await response.blob(), file);
    }));
    row.append(action('この版を復元', async () => {
      if (!confirm(`${backup.prefix}からNASの両データベースを復元します。現在のデータを置き換え、他端末の古い送信待ちも停止します。続行しますか？`)) return;
      await onlineAction('/api/backup/restore', { prefix: backup.prefix }); message('復元しました。'); await sync.run();
    })); list.append(row);
  }
  empty(list, result);
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function initInventory() {
  sync = new InventorySync(); state = await readState();
  for (const button of document.querySelectorAll('[data-inventory-tab]')) button.addEventListener('click', () => {
    stopScan();
    for (const b of document.querySelectorAll('[data-inventory-tab]')) { const selected = b === button; b.setAttribute('aria-pressed', String(selected)); b.classList.toggle('is-active', selected); }
    for (const p of document.querySelectorAll('[data-inventory-panel]')) p.hidden = p.dataset.inventoryPanel !== button.dataset.inventoryTab;
  });
  new MutationObserver(() => { if ($('inventory-section').hidden) stopScan(); }).observe($('inventory-section'), { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); else sync.run(); });
  window.addEventListener('online', () => sync.run());
  window.addEventListener('pageshow', () => sync.run());
  setInterval(() => { if (!document.hidden) sync.run(); }, 60000);
  sync.addEventListener('change', () => render().catch(error => message(error.message)));
  $('inventory-sync').append(action('今すぐ同期', () => sync.run()));
  $('inventory-add-product').append(action('商品追加', () => editForm('daily', 'product.create', null, {}, '商品追加')));
  $('inventory-add-clothing').append(action('種類追加', () => editForm('clothing', 'type.create', null, {}, '種類追加')), action('衣類追加', () => editForm('clothing', 'item.create', null, {}, '衣類追加', itemFields(localView(state), true))));
  $('inventory-product-search').addEventListener('input', () => renderDaily(localView(state)));
  $('inventory-item-search').addEventListener('input', () => renderClothes(localView(state)));
  $('inventory-endpoint').value = state.endpoint;
  $('inventory-connection-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await setEndpoint(normalizeEndpoint($('inventory-endpoint').value.trim()));
      $('inventory-backups').replaceChildren();
      for (const panel of ['daily', 'clothing']) $(`inventory-${panel}-editor`).replaceChildren();
      message('接続先を保存しました。'); await sync.run();
    } catch (error) { message(error.message); }
  });
  $('inventory-notify-actions').append(action('通知を確認・送信', async () => {
    if (!confirm('NASで通知チェックを実行します。設定済みのDiscord宛に通知が送信されます。')) return;
    const result = await onlineAction('/api/notify/run', {});
    message(`送信：${result.delivered.length}件 ／ 失敗：${result.failed.length}件${result.webhook_configured ? '' : '（Webhook未設定）'}`); await sync.run();
  }));
  $('inventory-backup-actions').append(action('一覧を取得', backups), action('バックアップ作成', async () => {
    const result = await onlineAction('/api/backup/run', {}); message(`作成しました：${result.prefix}`); await backups();
  }));
  $('inventory-storage-actions').append(action('端末保存を維持', async () => {
    const persisted = await navigator.storage?.persist?.(); message(persisted ? '永続保存が許可されました。ブラウザのデータ削除は避けてください。' : '永続保存の許可は得られませんでした。必要に応じて端末データを書き出してください。');
  }), action('端末データを書出', async () => {
    const current = await readState(); delete current.lease;
    download(new Blob([JSON.stringify({ format: 'mini-app-inventory-export-v1', ...current }, null, 2)], { type: 'application/json' }), `mini-app-inventory-${today()}.json`);
    message('取得済みデータ・下書き・送信待ちを書き出しました。復旧時の内容確認用です。');
  }));
  for (const panel of ['daily', 'clothing']) drawForm(panel, state.drafts[panel]);
  await render(); sync.run();
}
