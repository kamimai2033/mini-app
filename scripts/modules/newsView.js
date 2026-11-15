import { readNewsState, changeNewsState, newsRecord, groupedNews, saveNewsSnapshot, queueNewsChanges, acknowledgeNewsOperation, validateNewsSnapshot, safeNewsURL, NEWS_SYNC_LOCK } from './newsStore.js';
import { normalizeNewsEndpoint } from './newsTransport.js';

const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
const dateText = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '不明'; };
const categories = ['総合', '経済', 'IT'];

export async function mountNews(root, transport) {
  const $ = id => root.getElementById(`news-${id}`);
  const section = document.getElementById('news-section');
  let state = await readNewsState(), busy = false, message = '', info = null, activeArticles = [], lastAttempt = 0;
  let view = state.preferences.view === 'settings' ? 'home' : state.preferences.view;
  let activeAccount = null, editedFeedAccount = null;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(NEWS_SYNC_LOCK) : null;
  const visible = () => !section.hidden && !document.hidden;
  const record = () => newsRecord(state);
  const account = () => ({ endpoint: state.endpoint, server_id: record().server_id });
  $('endpoint').value = state.endpoint;
  $('category').value = state.preferences.category;
  $('feed').value = state.preferences.feed;
  $('search').value = state.preferences.search;
  if (!state.endpoint) message = '設定でニュースAPIへ接続すると、記事を取得できます。';
  const announce = () => channel?.postMessage('changed');
  async function locked(work) {
    if (!navigator.locks) throw new Error('安全な同期には新しいブラウザーが必要です。保存済み記事は読めます。');
    return navigator.locks.request(NEWS_SYNC_LOCK, work);
  }
  async function reload() {
    state = await readNewsState();
    if (transport.connected && transport.endpoint !== state.endpoint) { transport.disconnect(); message = '別のタブで接続先が変わりました。設定から再接続してください。'; }
    render();
  }
  async function persistPreferences() {
    state = await changeNewsState(data => { data.preferences = { view, category: $('category').value, feed: $('feed').value, search: $('search').value }; });
  }
  function reportError(error) {
    if (error.status === 401) transport.disconnect();
    message = `${error.message || '通信に失敗しました。'} 保存済み記事と送信待ちは保持しています。`;
  }
  function filteredArticles() {
    const query = $('search').value.trim().toLocaleLowerCase('ja'), category = $('category').value, feed = $('feed').value;
    return groupedNews(record()).filter(item =>
      (!category || item.categories.includes(category)) && (!feed || item.feed_ids.includes(feed)) &&
      (view !== 'unread' || !item.read) && (view !== 'saved' || item.starred) &&
      (!query || `${item.title}\n${item.summary}\n${item.source}`.toLocaleLowerCase('ja').includes(query))
    );
  }
  function articleCard(item) {
    const expected = account();
    const card = element('article', undefined, `article${item.read ? ' read' : ''}`); card.dataset.articleId = item.id;
    const heading = element('h4');
    if (item.url) {
      const link = element('a', item.title); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.addEventListener('click', () => { if (!item.read) void updateItems(item.ids, { read: true }, expected); }); heading.append(link);
    } else heading.textContent = item.title;
    card.append(heading);
    const sources = record().feeds.filter(feed => item.feed_ids.includes(feed.id)).map(feed => feed.title);
    const meta = element('p', `${item.source || sources[0] || '配信元不明'} ／ ${item.published_at ? `公開 ${dateText(item.published_at)}` : `公開日時不明・取得 ${dateText(item.received_at)}`}`, 'meta');
    if (sources.length > 1) meta.append(element('span', ` ／ 配信経路：${sources.join('・')}`));
    card.append(meta);
    const tags = element('p');
    if (!item.read) tags.append(element('span', '未読', 'badge'));
    if (item.starred) tags.append(element('span', '保存済み', 'badge'));
    for (const category of item.categories) tags.append(element('span', category, 'badge'));
    card.append(tags);
    if (item.summary) card.append(element('p', item.summary, 'summary'));
    const buttons = element('div', undefined, 'article-actions');
    const read = element('button', item.read ? '未読に戻す' : '既読にする'); read.type = 'button'; read.dataset.action = 'read';
    read.disabled = !navigator.locks; read.addEventListener('click', () => void updateItems(item.ids, { read: !item.read }, expected));
    const saved = element('button', item.starred ? '保存を解除' : 'あとで読む'); saved.type = 'button'; saved.dataset.action = 'starred';
    saved.disabled = !navigator.locks; saved.setAttribute('aria-pressed', String(item.starred)); saved.addEventListener('click', () => void updateItems(item.ids, { starred: !item.starred }, expected));
    buttons.append(read, saved); card.append(buttons); return card;
  }
  function renderArticles() {
    const focused = root.activeElement;
    const focusArticle = focused?.closest('[data-article-id]')?.dataset.articleId;
    const focusAction = focused?.dataset.action;
    const items = filteredArticles(), results = $('results'); results.replaceChildren();
    activeArticles = [];
    activeAccount = account();
    if (view === 'home' && !$('category').value && !$('feed').value && !$('search').value.trim()) {
      const grid = element('div', undefined, 'category-grid');
      for (const category of categories) {
        const column = element('section', undefined, 'category-column'); column.append(element('h3', category));
        const selected = items.filter(item => item.categories.includes(category)).slice(0, 5); activeArticles.push(...selected);
        if (!selected.length) column.append(element('p', '取得済みの記事はありません。', 'empty'));
        for (const item of selected) column.append(articleCard(item));
        grid.append(column);
      }
      results.append(grid);
    } else {
      activeArticles = items;
      if (!items.length) results.append(element('p', state.endpoint ? '条件に合う取得済みの記事はありません。' : '設定からNASへ接続してください。', 'empty'));
      for (const item of items) results.append(articleCard(item));
    }
    $('count').textContent = `${new Set(activeArticles.map(item => item.id)).size}件を表示 ／ 取得済み${groupedNews(record()).length}件`;
    $('mark-visible').disabled = !navigator.locks || !activeArticles.some(item => !item.read);
    $('more').hidden = view !== 'saved' || !record().cursors.saved;
    $('more').disabled = busy || !transport.connected || !navigator.onLine;
    if (focusArticle && focusAction) {
      const card = [...results.querySelectorAll('[data-article-id]')].find(node => node.dataset.articleId === focusArticle);
      [...(card?.querySelectorAll('[data-action]') || [])].find(node => node.dataset.action === focusAction)?.focus({ preventScroll: true });
    }
  }
  function resetFeedForm() {
    editedFeedAccount = null;
    $('feed-form').reset(); $('feed-id').value = ''; $('feed-url').readOnly = false;
    $('feed-save').textContent = '購読先を追加'; $('feed-cancel').hidden = true;
  }
  function renderFeeds() {
    const selected = $('feed').value || state.preferences.feed;
    $('feed').replaceChildren(new Option('すべて', ''));
    for (const feed of record().feeds) $('feed').append(new Option(feed.title, feed.id));
    $('feed').value = selected;
    if (!$('feed').value && selected) $('feed').value = '';
    $('feeds').replaceChildren();
    for (const feed of record().feeds) {
      const expected = account();
      const row = element('article', undefined, 'feed'); row.dataset.feedId = feed.id;
      row.append(element('h4', `${feed.title} ／ ${feed.category || '未分類'}${feed.enabled === false ? ' ／ 停止中' : ''}`));
      row.append(element('p', feed.url, 'meta'));
      row.append(element('p', `配信元の最終取得：${dateText(feed.last_success_at)}${feed.error ? ` ／ ${String(feed.error)}` : ''}`, 'meta'));
      const buttons = element('div', undefined, 'button-row');
      const edit = element('button', '編集'); edit.type = 'button'; edit.disabled = busy || !transport.connected;
      edit.addEventListener('click', () => {
        editedFeedAccount = expected;
        $('feed-id').value = feed.id; $('feed-url').value = feed.url; $('feed-url').readOnly = true;
        $('feed-title').value = feed.title; $('feed-category').value = categories.includes(feed.category) ? feed.category : '総合';
        $('feed-save').textContent = '変更を保存'; $('feed-cancel').hidden = false; $('feed-title').focus();
      });
      const pause = element('button', feed.enabled === false ? '収集を再開' : '収集を停止'); pause.type = 'button'; pause.disabled = busy || !transport.connected || !navigator.onLine;
      pause.addEventListener('click', () => void feedOperation({ action: feed.enabled === false ? 'resume' : 'pause', feed_id: feed.id }, expected));
      buttons.append(edit, pause); row.append(buttons); $('feeds').append(row);
    }
    if (!record().feeds.length) $('feeds').append(element('p', '購読先は未取得です。'));
  }
  function render() {
    for (const button of root.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
    $('reading').hidden = view === 'settings'; $('settings').hidden = view !== 'settings';
    const current = record(), pending = current.queue.length;
    const connection = !navigator.onLine ? 'オフライン' : transport.connected ? '接続設定済み' : '保存済み表示';
    $('status').textContent = `${connection}${busy ? '・同期中' : ''} ／ 送信待ち${pending}件${message ? ` ／ ${message}` : ''}`;
    $('cache-status').textContent = `端末への最終同期：${dateText(current.synced_at)}。通常記事は直近500件、保存記事は取得済みの範囲を利用できます。${current.cursors.saved ? ' 保存記事には未取得の続きがあります。' : ''}${current.sync?.error ? ` 収集状態：${current.sync.error}` : ''}`;
    $('queue-status').textContent = `既読・保存の送信待ち：${pending}件。${pending ? 'NASへ接続して同期してください。' : ''}`;
    $('sync').disabled = busy || !transport.connected || !navigator.onLine;
    $('refresh').disabled = busy || !transport.connected || !navigator.onLine;
    $('connect-form').querySelector('button[type=submit]').disabled = busy;
    $('disconnect').disabled = busy || !transport.connected;
    $('feed-save').disabled = busy || !transport.connected || !navigator.onLine;
    const admin = safeNewsURL(info?.admin_url);
    $('admin-link').hidden = !admin; if (admin) $('admin-link').href = admin;
    renderFeeds(); renderArticles();
  }
  async function updateItems(ids, changes, expected) {
    try {
      for (let i = 0; i < ids.length; i += 100) state = await queueNewsChanges(ids.slice(i, i + 100), changes, expected);
      message = '端末に保存しました。'; announce(); render();
      if (transport.connected && navigator.onLine) await sync();
    } catch (error) { reportError(error); render(); }
  }
  async function fetchSnapshot(snapshotView, append = false) {
    state = await readNewsState();
    if (state.endpoint !== transport.endpoint) throw new Error('接続先が変更されました。設定から再接続してください。');
    const cursor = append ? record().cursors[snapshotView] : null;
    const params = new URLSearchParams({ view: snapshotView, limit: '500', ...(cursor ? { cursor } : {}) });
    const data = await transport.request(`/api/news/snapshot?${params}`);
    state = await saveNewsSnapshot(transport.endpoint, data, { view: snapshotView, append });
    if (state.endpoint !== transport.endpoint) throw new Error('接続先が変更されました。設定から再接続してください。');
  }
  async function flushQueue() {
    state = await readNewsState();
    while (record().queue.length) {
      if (state.endpoint !== transport.endpoint) throw new Error('接続先が変更されました。設定から再接続してください。');
      const operation = record().queue[0];
      const result = await transport.request('/api/news/operations', { operation_id: operation.operation_id, server_id: operation.server_id, item_ids: operation.ids, changes: operation.changes });
      if (result.operation_id !== operation.operation_id || result.status !== 'applied' || result.server_id !== operation.server_id) throw new Error('NASの受付結果を確認できません。同じ操作IDを保持して再試行します。');
      state = await acknowledgeNewsOperation(transport.endpoint, operation.operation_id); announce();
    }
  }
  async function sync({ collect = false } = {}) {
    if (busy || !transport.connected || !navigator.onLine) { render(); return; }
    busy = true; lastAttempt = Date.now(); message = ''; render();
    try {
      if (!navigator.locks) throw new Error('安全な同期には新しいブラウザーが必要です。保存済み記事は読めます。');
      await navigator.locks.request(NEWS_SYNC_LOCK, { ifAvailable: true }, async lock => {
        if (!lock) { message = '別のタブが同期しています。'; return; }
        await fetchSnapshot('all');
        await flushQueue();
        if (collect) await transport.request('/api/news/refresh', { server_id: record().server_id });
        await fetchSnapshot('all');
        await fetchSnapshot('saved');
        message = collect ? 'ニュースの更新結果を取得しました。' : '既読・保存を同期しました。'; announce();
      });
    } catch (error) { reportError(error); }
    finally { busy = false; render(); }
  }
  async function feedOperation(fields, expected) {
    if (busy || !transport.connected || !navigator.onLine) return;
    busy = true; message = ''; render();
    try {
      await locked(async () => {
        state = await readNewsState();
        if (state.endpoint !== transport.endpoint || state.endpoint !== expected?.endpoint || record().server_id !== expected?.server_id) throw new Error('接続先が変更されました。再接続して購読先を選び直してください。');
        const result = await transport.request('/api/news/feeds', { operation_id: crypto.randomUUID(), server_id: record().server_id, ...fields });
        if (result.server_id && result.server_id !== record().server_id) throw new Error('NASの識別情報が変わりました。再接続してください。');
        await fetchSnapshot('all'); message = '購読設定を保存しました。'; resetFeedForm(); announce();
      });
    } catch (error) { reportError(error); }
    finally { busy = false; render(); }
  }
  $('connect-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    busy = true; message = ''; render();
    try {
      await locked(async () => {
        const endpoint = normalizeNewsEndpoint($('endpoint').value);
        state = await readNewsState();
        if (state.endpoint && state.endpoint !== endpoint && record().queue.length) throw new Error('送信待ちを同期してから接続先を変更してください。');
        const connected = await transport.connect(endpoint, $('access-key').value);
        validateNewsSnapshot(connected.data);
        state = await saveNewsSnapshot(endpoint, connected.data, { connect: true }); info = connected.info;
        $('access-key').value = ''; $('endpoint').value = endpoint; view = 'home'; message = '接続しました。';
        announce();
      });
    } catch (error) { transport.disconnect(); reportError(error); }
    finally { busy = false; render(); }
    if (transport.connected) await sync();
  });
  $('disconnect').addEventListener('click', () => { transport.disconnect(); $('access-key').value = ''; message = '接続を解除しました。保存済み記事と送信待ちは残ります。'; render(); });
  for (const button of root.querySelectorAll('[data-view]')) button.addEventListener('click', async () => {
    view = button.dataset.view; await persistPreferences(); render();
    if (view === 'saved' && transport.connected && navigator.onLine && !busy) {
      busy = true; render();
      try { await locked(() => fetchSnapshot('saved')); } catch (error) { reportError(error); }
      finally { busy = false; render(); }
    }
  });
  $('filter-form').addEventListener('submit', event => event.preventDefault());
  for (const id of ['category', 'feed', 'search']) $(id).addEventListener(id === 'search' ? 'input' : 'change', async () => { await persistPreferences(); renderArticles(); });
  $('sync').addEventListener('click', () => void sync());
  $('refresh').addEventListener('click', () => void sync({ collect: true }));
  $('more').addEventListener('click', async () => {
    if (busy || !transport.connected || !navigator.onLine) return;
    busy = true; render();
    try { await locked(() => fetchSnapshot('saved', true)); announce(); } catch (error) { reportError(error); }
    finally { busy = false; render(); }
  });
  $('mark-visible').addEventListener('click', () => void updateItems([...new Set(activeArticles.filter(item => !item.read).flatMap(item => item.ids))], { read: true }, activeAccount));
  $('feed-form').addEventListener('submit', event => {
    event.preventDefault();
    const id = $('feed-id').value;
    let url;
    try { url = new URL($('feed-url').value.trim()); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); }
    catch { message = '購読先には外部のHTTPS RSS／Atom URLを指定してください。'; render(); return; }
    void feedOperation({ action: id ? 'update' : 'add', ...(id ? { feed_id: id } : { url: url.href }), title: $('feed-title').value.trim(), category: $('feed-category').value }, id ? editedFeedAccount : account());
  });
  $('feed-cancel').addEventListener('click', resetFeedForm);
  for (const button of root.querySelectorAll('[data-news-preset]')) button.addEventListener('click', () => {
    resetFeedForm();
    const category = button.dataset.newsCategory;
    $('feed-url').value = `https://news.yahoo.co.jp/rss/topics/${button.dataset.newsPreset}.xml`;
    $('feed-title').value = `Yahoo!ニュース・${category === '総合' ? '主要' : category}`;
    $('feed-category').value = category;
    $('feed-title').focus();
  });
  $('export').addEventListener('click', async () => {
    const saved = await readNewsState();
    const blob = new Blob([JSON.stringify({ version: 1, exported_at: new Date().toISOString(), endpoint: saved.endpoint, data: newsRecord(saved) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `news-kun-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const refreshVisible = () => { if (visible() && transport.connected && navigator.onLine && Date.now() - lastAttempt > 60000) void sync(); else render(); };
  channel?.addEventListener('message', () => void reload());
  window.addEventListener('online', () => { if (visible()) void sync(); });
  window.addEventListener('offline', render);
  window.addEventListener('focus', refreshVisible);
  document.addEventListener('visibilitychange', refreshVisible);
  new MutationObserver(refreshVisible).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  setInterval(() => { if (visible()) refreshVisible(); }, 60000);
  render();
}
