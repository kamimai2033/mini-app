import {
  readLibraryState, libraryRecord, selectEndpoint, applySnapshot, enqueueOperations, recordResults, cancelOperation, overrideConflict,
  saveDraft, savePreferences, LIBRARY_SYNC_LOCK
} from './libraryStore.js';
import { normalizeLibraryEndpoint } from './libraryTransport.js';
import {
  localView, placePath, placeOptions, descendants, childrenOf, compareText, compareVolumes, compareCopies, bookSortKey, bookTitle, bookMeta, matchesSearch, today, dueDate,
  dueState, dateLabel, validDate, READING_LABELS, FORMAT_LABELS, DISPOSITION_LABELS, PERIOD_LABELS, ACTIVE
} from './libraryCore.js';
import { createRegister, el, button, select } from './libraryRegister.js';
import { beep, createContinuousScanner } from './libraryScan.js';

const PAGE = 200;
const field = (label, control, className) => el('label', { class: className }, label, control);
const STATUS_LABELS = { pending: '送信待ち', sending: '送信待ち', conflict: '競合', rejected: '送信できません' };

export async function mountLibrary(root, transport) {
  const $ = id => root.getElementById(`lib-${id}`);
  const section = document.getElementById('library-section');
  let state = await readLibraryState(), busy = false, message = '', messageError = false, lastAttempt = 0;
  let copyLimit = PAGE, moveScanner = null;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(LIBRARY_SYNC_LOCK) : null;
  const record = () => libraryRecord(state);
  const view = () => localView(record());
  const prefs = () => state.preferences;
  const account = () => ({ endpoint: state.endpoint, server_id: record().server_id });
  const visible = () => !section.hidden && !document.hidden;
  const announce = () => channel?.postMessage('changed');
  const coverObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { coverObserver.unobserve(entry.target); void loadCover(entry.target); }
  }, { rootMargin: '300px' }) : null;

  function notify(text, error = false) { message = text; messageError = error; renderStatus(); }
  function report(error) {
    if (error.status === 401) transport.disconnect();
    notify(`${error.message || '通信に失敗しました。'} 端末のデータと送信待ちは保持しています。`, true);
  }
  async function enqueue(entries) {
    state = await enqueueOperations(entries, account());
    announce(); render();
    if (transport.connected && navigator.onLine) void sync();
  }
  async function setPreferences(changes) { state = await savePreferences(changes); }
  const registerContext = mode => ({
    mode, transport, view, preferences: prefs, draft: state.drafts[`${mode}Register`],
    saveDraft: value => saveDraft(`${mode}Register`, value), savePreferences: setPreferences, enqueue,
    notify: (text, error) => notify(text, error), closed: () => render()
  });
  const registers = { copy: createRegister($('copy-register-area'), registerContext('copy')), loan: createRegister($('loan-register-area'), registerContext('loan')) };
  function stopCameras() { registers.copy.stop(); registers.loan.stop(); moveScanner?.stop(); moveScanner = null; }

  // --- Status & tabs ------------------------------------------------------
  function renderStatus() {
    const queue = record().queue, pending = queue.filter(item => ACTIVE.has(item.status)).length, problems = queue.length - pending;
    const connection = !navigator.onLine ? 'オフライン' : transport.connected ? '接続中' : state.endpoint ? '保存済みデータを表示中' : '未接続';
    $('status').textContent = `${connection}${busy ? '・同期中' : ''} ／ 送信待ち${pending}件${problems ? ` ／ 要確認${problems}件` : ''}`;
    $('message').textContent = message; $('message').classList.toggle('error', messageError);
    $('sync').disabled = busy || !transport.connected || !navigator.onLine;
  }
  function render() {
    const tab = prefs().tab;
    for (const node of root.querySelectorAll('[data-tab]')) node.setAttribute('aria-pressed', String(node.dataset.tab === tab));
    for (const panel of root.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab;
    renderStatus();
    if (tab === 'copies') renderCopies();
    else if (tab === 'loans') renderLoans();
    else if (tab === 'places') renderPlaces();
    else renderSettings();
    registers.copy.refresh(); registers.loan.refresh();
  }

  // --- Shared pieces ---------------------------------------------------------
  function tags(...items) { return el('p', { class: 'tags' }, ...items.filter(Boolean).map(([text, kind]) => el('span', { class: `tag ${kind || ''}`, text }))); }
  function bibTags(bib) {
    if (bib.lookup_status === 'pending') return ['書誌未取得', 'muted'];
    if (bib.lookup_status === 'notfound') return ['書誌が見つかりません', 'muted'];
    return null;
  }
  function markTag(v, id) { const status = v.marks.get(id); return status ? [STATUS_LABELS[status], status] : null; }
  function coverSlot(bib) {
    if (!prefs().covers || !bib?.id || bib.local) return null;
    const slot = el('div', { class: 'cover', 'data-bib': bib.id, 'aria-hidden': 'true' });
    coverObserver?.observe(slot);
    return slot;
  }
  async function loadCover(slot) {
    const url = await transport.cover(slot.dataset.bib);
    if (url && slot.isConnected) slot.replaceChildren(el('img', { src: url, alt: '', decoding: 'async' }));
  }
  function placeSelect(v, value, { none = '場所未設定', exclude = new Set(), attrs = {} } = {}) {
    return select([['', none], ...placeOptions(v.places, exclude).map(option => [option.id, option.label])], value || '', attrs);
  }
  function seriesSelect(v, value, attrs = {}) {
    return select([['', 'シリーズなし'], ...Object.values(v.series).sort((a, b) => compareText(a.name, b.name)).map(s => [s.id, s.name]), ['__new', '＋新しいシリーズ']], value || '', attrs);
  }
  function editorFrame(container, title, body, actions) {
    container.replaceChildren(el('section', { class: 'editor', 'aria-label': title }, el('h4', { text: title }), body, el('div', { class: 'button-row' }, ...actions)));
    container.querySelector('input, select, textarea, button')?.focus({ preventScroll: false });
    container.scrollIntoView?.({ block: 'nearest' });
  }

  // --- 蔵書管理 ------------------------------------------------------------
  function copyCard(copy, v) {
    const bib = v.bibs[copy.bib_id] || { title: '（書誌なし）' };
    const place = copy.place_id ? placePath(v.places, copy.place_id) : '';
    const disposed = copy.disposition !== 'owned';
    const card = el('article', { class: `book${disposed ? ' disposed' : ''}`, 'data-copy-id': copy.id });
    const cover = coverSlot(bib); if (cover) card.append(cover);
    const body = el('div', { class: 'book-body' },
      el('h5', { text: bookTitle(bib, copy) }),
      el('p', { class: 'meta', text: bookMeta(bib, dateLabel) || ' ' }),
      tags([READING_LABELS[copy.reading] || '未読', `reading-${copy.reading}`], copy.format === 'digital' && ['電子', ''], [place ? `場所：${place}` : '場所未設定', place ? '' : 'muted'],
        bibTags(bib), markTag(v, copy.id), disposed && [`${DISPOSITION_LABELS[copy.disposition]}${copy.disposed_on ? `（${dateLabel(copy.disposed_on)}）` : ''}`, 'muted']),
      copy.note ? el('p', { class: 'note', text: copy.note }) : null,
      el('div', { class: 'button-row' }, button('詳細・編集', () => openCopyEditor(copy.id), { 'data-action': 'edit' })));
    card.append(body);
    return card;
  }
  function filteredCopies(v) {
    const p = prefs();
    const within = p.place && p.place !== '__none' && v.places[p.place] ? descendants(v.places, p.place) : null;
    return Object.values(v.copies).filter(copy => {
      const bib = v.bibs[copy.bib_id] || {};
      return (p.disposed || copy.disposition === 'owned') && (!p.reading || copy.reading === p.reading) && (!p.format || copy.format === p.format) &&
        (p.place === '__none' ? !copy.place_id : !within || within.has(copy.place_id)) &&
        matchesSearch(p.search, bib.title, bib.title_kana, bib.creators, bib.publisher, bib.isbn13, copy.note, copy.acquired_from, v.series[copy.series_id]?.name, copy.volume_label);
    });
  }
  function renderCopies() {
    const v = view(), p = prefs();
    const placeFilter = $('copy-place');
    placeFilter.replaceChildren(new Option('すべての置き場所', ''), new Option('場所未設定', '__none'), ...placeOptions(v.places).map(option => new Option(option.label, option.id)));
    placeFilter.value = p.place && (p.place === '__none' || v.places[p.place]) ? p.place : '';
    $('copy-search').value = p.search; $('copy-reading').value = p.reading; $('copy-format').value = p.format; $('copy-grouping').value = p.grouping; $('copy-disposed').checked = p.disposed;
    const copies = filteredCopies(v), owned = Object.values(v.copies).filter(copy => copy.disposition === 'owned').length;
    $('copy-count').textContent = `${copies.length}冊を表示 ／ 所持${owned}冊${record().pending_lookups ? ` ／ NASで書誌を取得中${record().pending_lookups}件` : ''}`;
    const list = $('copy-list'); list.replaceChildren();
    if (!copies.length) {
      list.append(el('p', { class: 'empty', text: owned ? '条件に合う本はありません。' : state.endpoint ? '「本を登録」から本を追加してください。' : '共通設定でNASへ接続してから、本を登録してください。' }));
      return;
    }
    let shown = 0;
    if (p.grouping === 'series') {
      const groups = new Map();
      for (const copy of copies) { const key = v.series[copy.series_id] ? copy.series_id : ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(copy); }
      const order = [...groups.keys()].filter(Boolean).sort((a, b) => compareText(v.series[a].name, v.series[b].name));
      if (groups.has('')) order.push('');
      for (const key of order) {
        if (shown >= copyLimit) break;
        const items = groups.get(key).sort((a, b) => key ? compareVolumes(a, b, v.bibs) : compareText(bookSortKey(v.bibs[a.bib_id]), bookSortKey(v.bibs[b.bib_id])));
        const series = v.series[key];
        const group = el('section', { class: 'series-group', 'data-series-id': key || 'none' },
          el('div', { class: 'series-heading' }, el('h4', { text: `${series ? series.name : 'シリーズなし'}（${items.length}冊）` }),
            series ? button('シリーズを編集', () => openSeriesEditor(key), { class: 'small' }) : null),
          series?.creator ? el('p', { class: 'meta', text: series.creator }) : null);
        for (const copy of items) { if (shown >= copyLimit) break; group.append(copyCard(copy, v)); shown++; }
        list.append(group);
      }
    } else {
      const items = copies.sort((a, b) => compareText(bookSortKey(v.bibs[a.bib_id]), bookSortKey(v.bibs[b.bib_id])) || compareVolumes(a, b, v.bibs));
      // 1冊ずつ: plain title order (reading when known).
      for (const copy of items.slice(0, copyLimit)) { list.append(copyCard(copy, v)); shown++; }
    }
    if (copies.length > shown) list.append(button(`さらに表示（残り${copies.length - shown}冊）`, () => { copyLimit += PAGE; renderCopies(); }, { class: 'more' }));
  }
  function openCopyEditor(copyId) {
    const v = view(), copy = v.copies[copyId]; if (!copy) return;
    const bib = v.bibs[copy.bib_id] || { title: '' };
    const container = $('copy-editor');
    const inputs = {
      title: el('input', { value: bib.title || '', maxlength: '500', required: true }), title_kana: el('input', { value: bib.title_kana || '', maxlength: '500' }),
      creators: el('input', { value: bib.creators || '', maxlength: '300' }), publisher: el('input', { value: bib.publisher || '', maxlength: '300' }),
      issued: el('input', { value: bib.issued || '', maxlength: '10', placeholder: 'YYYY-MM-DD / YYYY-MM / YYYY' }),
      series: seriesSelect(v, copy.series_id), newSeries: el('input', { maxlength: '120', placeholder: '新しいシリーズ名' }),
      volume_label: el('input', { value: copy.volume_label || '', maxlength: '40' }), volume_sort: el('input', { type: 'number', step: 'any', value: copy.volume_sort ?? '' }),
      format: select(Object.entries(FORMAT_LABELS), copy.format), place: placeSelect(v, copy.place_id), reading: select(Object.entries(READING_LABELS), copy.reading),
      acquired_on: el('input', { type: 'date', value: copy.acquired_on || '' }), acquired_from: el('input', { value: copy.acquired_from || '', maxlength: '120' }),
      price: el('input', { type: 'number', min: '0', step: '1', value: copy.price ?? '' }), note: el('textarea', { maxlength: '2000', rows: '3' })
    };
    inputs.note.value = copy.note || '';
    const newSeriesField = field('新しいシリーズ名', inputs.newSeries); newSeriesField.hidden = true;
    inputs.series.addEventListener('change', () => { newSeriesField.hidden = inputs.series.value !== '__new'; });
    const bibLocked = bib.local || !bib.id;
    for (const key of ['title', 'title_kana', 'creators', 'publisher', 'issued']) inputs[key].disabled = bibLocked;
    const disposeKind = select([['sold', '売却'], ['given', '譲渡'], ['discarded', '廃棄']], 'sold'), disposeDate = el('input', { type: 'date', value: today() });
    const identifiers = [bib.isbn13 && `ISBN ${bib.isbn13}`, bib.ndl_id && `国立国会図書館 書誌ID ${bib.ndl_id}`, bib.source && `取得元：${{ ndl: '国立国会図書館サーチ', rakuten: '楽天ブックス', google: 'Google Books', manual: '手入力', scan: 'バーコード' }[bib.source] || bib.source}`].filter(Boolean).join(' ／ ');
    const body = el('div', { class: 'editor-body' },
      el('fieldset', {}, el('legend', { text: '書誌' }),
        bibLocked ? el('p', { class: 'hint', text: 'NASへ送信した後に書誌を修正できます。' }) : null,
        el('div', { class: 'grid' }, field('書名', inputs.title), field('書名よみ', inputs.title_kana), field('著者', inputs.creators), field('出版者・サークル', inputs.publisher), field('発行日', inputs.issued)),
        identifiers ? el('p', { class: 'meta', text: identifiers }) : null,
        bib.overridden?.length ? el('p', { class: 'hint', text: `手で修正した項目：${bib.overridden.map(key => ({ title: '書名', title_kana: '書名よみ', creators: '著者', publisher: '出版者', issued: '発行日' })[key] || key).join('・')}（書誌を再取得しても保持します）` }) : null,
        bib.series_hint && !copy.series_id ? el('p', { class: 'hint' }, `書誌上のシリーズ名：${bib.series_hint} `, button('この名前でシリーズを作る', () => { inputs.series.value = '__new'; inputs.newSeries.value = bib.series_hint; newSeriesField.hidden = false; }, { class: 'small' })) : null),
      el('fieldset', {}, el('legend', { text: 'この本' }),
        el('div', { class: 'grid' }, field('シリーズ', inputs.series), newSeriesField, field('巻表記', inputs.volume_label), field('巻の並び順', inputs.volume_sort),
          field('形態', inputs.format), field('置き場所', inputs.place), field('読書状態', inputs.reading), field('入手日', inputs.acquired_on), field('入手先', inputs.acquired_from), field('価格（円）', inputs.price)),
        field('メモ', inputs.note)),
      el('fieldset', {}, el('legend', { text: copy.disposition === 'owned' ? '手放す' : '手放した本' }),
        copy.disposition === 'owned'
          ? el('div', { class: 'grid' }, field('手放し方', disposeKind), field('手放した日', disposeDate))
          : el('p', { text: `${DISPOSITION_LABELS[copy.disposition]}（${dateLabel(copy.disposed_on)}）` })));
    const actions = [
      button('保存', async () => {
        const entries = [];
        if (!bibLocked) {
          const fields = {};
          for (const key of ['title', 'title_kana', 'creators', 'publisher', 'issued']) if (inputs[key].value.trim() !== (bib[key] || '')) fields[key] = inputs[key].value.trim();
          if ('title' in fields && !fields.title) { notify('書名は空にできません。', true); return; }
          if (Object.keys(fields).length) entries.push({ op: 'bib.update', data: { id: bib.id, fields }, base_revision: bib.revision, label: `書誌修正：${fields.title || bib.title}` });
        }
        let seriesId = inputs.series.value || null;
        if (seriesId === '__new') {
          const name = inputs.newSeries.value.trim(); if (!name) { notify('新しいシリーズ名を入力してください。', true); return; }
          seriesId = crypto.randomUUID(); entries.push({ op: 'series.create', data: { id: seriesId, name, creator: bib.creators || '' }, label: `シリーズ作成：${name}` });
        }
        const sort = inputs.volume_sort.value === '' ? null : Number(inputs.volume_sort.value);
        const price = inputs.price.value === '' ? null : Number(inputs.price.value);
        if (price !== null && (!Number.isInteger(price) || price < 0)) { notify('価格は0以上の整数で入力してください。', true); return; }
        const next = { series_id: seriesId, volume_label: inputs.volume_label.value.trim(), volume_sort: Number.isFinite(sort) ? sort : null, format: inputs.format.value,
          place_id: inputs.place.value || null, reading: inputs.reading.value, acquired_on: inputs.acquired_on.value || null, acquired_from: inputs.acquired_from.value.trim(), price, note: inputs.note.value.trim() };
        const before = { series_id: copy.series_id ?? null, volume_label: copy.volume_label || '', volume_sort: copy.volume_sort ?? null, format: copy.format, place_id: copy.place_id ?? null,
          reading: copy.reading, acquired_on: copy.acquired_on || null, acquired_from: copy.acquired_from || '', price: copy.price ?? null, note: copy.note || '' };
        const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => before[key] !== value));
        if (Object.keys(changes).length) entries.push({ op: 'copy.update', data: { id: copy.id, ...changes }, base_revision: copy.revision, label: `蔵書の編集：${inputs.title.value || bib.title}` });
        if (!entries.length) { notify('変更はありません。'); return; }
        try { await enqueue(entries); container.replaceChildren(); notify('変更を保存しました（送信待ちに追加）。'); } catch (error) { notify(error.message, true); }
      }, { class: 'primary' }),
      copy.disposition === 'owned'
        ? button('手放す', async () => {
          if (!validDate(disposeDate.value)) { notify('手放した日を入力してください。', true); return; }
          try { await enqueue([{ op: 'copy.dispose', data: { id: copy.id, disposition: disposeKind.value, disposed_on: disposeDate.value }, base_revision: copy.revision, label: `手放す：${bib.title}` }]); container.replaceChildren(); notify('手放した本として記録しました。「手放した本を含む」で表示できます。'); } catch (error) { notify(error.message, true); }
        })
        : button('所持に戻す', async () => {
          try { await enqueue([{ op: 'copy.restore', data: { id: copy.id }, base_revision: copy.revision, label: `所持に戻す：${bib.title}` }]); container.replaceChildren(); notify('所持中に戻しました。'); } catch (error) { notify(error.message, true); }
        }),
      !bibLocked && bib.isbn13 ? button('書誌を再取得', async () => {
        try { await enqueue([{ op: 'bib.refresh', data: { id: bib.id }, label: `書誌の再取得：${bib.title}` }]); notify('NASで書誌を再取得します。手で修正した項目は保持します。'); } catch (error) { notify(error.message, true); }
      }) : null,
      !bibLocked && bib.overridden?.length ? button('手で修正した書誌を元に戻す', async () => {
        try { await enqueue([{ op: 'bib.update', data: { id: bib.id, fields: Object.fromEntries(bib.overridden.map(key => [key, null])) }, base_revision: bib.revision, label: `書誌を元に戻す：${bib.title}` }]); container.replaceChildren(); notify('取得した書誌に戻しました。'); } catch (error) { notify(error.message, true); }
      }) : null,
      button('閉じる', () => container.replaceChildren())
    ].filter(Boolean);
    editorFrame(container, '本の詳細', body, actions);
  }
  function openSeriesEditor(seriesId) {
    const v = view(), series = v.series[seriesId]; if (!series) return;
    const container = $('copy-editor');
    const name = el('input', { value: series.name, maxlength: '120', required: true }), creator = el('input', { value: series.creator || '', maxlength: '200' });
    const note = el('textarea', { maxlength: '1000', rows: '2' }); note.value = series.note || '';
    const others = Object.values(v.series).filter(item => item.id !== seriesId).sort((a, b) => compareText(a.name, b.name));
    const into = select([['', '統合先を選ぶ'], ...others.map(item => [item.id, item.name])], '');
    editorFrame(container, `シリーズ：${series.name}`, el('div', { class: 'editor-body' },
      el('div', { class: 'grid' }, field('シリーズ名', name), field('著者・サークル', creator)), field('メモ', note),
      el('fieldset', {}, el('legend', { text: '別のシリーズに統合' }), el('p', { class: 'hint', text: '重複して作ったシリーズをまとめます。このシリーズの本は統合先へ移ります。' }), field('統合先', into))), [
      button('保存', async () => {
        const changes = {};
        if (name.value.trim() !== series.name) changes.name = name.value.trim();
        if (creator.value.trim() !== (series.creator || '')) changes.creator = creator.value.trim();
        if (note.value.trim() !== (series.note || '')) changes.note = note.value.trim();
        if (!name.value.trim()) { notify('シリーズ名を入力してください。', true); return; }
        if (!Object.keys(changes).length) { notify('変更はありません。'); return; }
        try { await enqueue([{ op: 'series.update', data: { id: seriesId, ...changes }, base_revision: series.revision, label: `シリーズの編集：${name.value.trim()}` }]); container.replaceChildren(); } catch (error) { notify(error.message, true); }
      }, { class: 'primary' }),
      button('統合する', async () => {
        if (!into.value) { notify('統合先のシリーズを選んでください。', true); return; }
        try { await enqueue([{ op: 'series.merge', data: { id: seriesId, into: into.value }, base_revision: series.revision, label: `シリーズ統合：${series.name} → ${v.series[into.value].name}` }]); container.replaceChildren(); notify('シリーズを統合しました。'); } catch (error) { notify(error.message, true); }
      }),
      button('閉じる', () => container.replaceChildren())]);
  }

  // --- 借用管理 ------------------------------------------------------------
  function renderLoans() {
    const v = view(), p = prefs(), base = today();
    $('loan-returned').checked = p.showReturned;
    const all = Object.values(v.loans), open = all.filter(loan => !loan.returned_on);
    const loans = all.filter(loan => p.showReturned || !loan.returned_on).sort((a, b) =>
      (a.returned_on ? 1 : 0) - (b.returned_on ? 1 : 0) || (a.returned_on ? compareText(b.returned_on, a.returned_on) : compareText(a.due_on, b.due_on)) || compareText(v.bibs[a.bib_id]?.title, v.bibs[b.bib_id]?.title));
    const overdue = open.filter(loan => loan.due_on < base).length;
    $('loan-count').textContent = `借用中${open.length}冊${overdue ? ` ／ 期限切れ${overdue}冊` : ''}`;
    const list = $('loan-list'); list.replaceChildren();
    if (!loans.length) { list.append(el('p', { class: 'empty', text: open.length || !all.length ? '借りている本はありません。' : '借りている本はありません（返却済みを表示できます）。' })); return; }
    for (const loan of loans) {
      const bib = v.bibs[loan.bib_id] || { title: '（書誌なし）' };
      const due = loan.returned_on ? null : dueState(loan.due_on, base, Number(p.dueSoonDays) || 0);
      const card = el('article', { class: `loan${due ? ` due-${due.state}` : ' returned'}`, 'data-loan-id': loan.id });
      const cover = coverSlot(bib); if (cover) card.append(cover);
      card.append(el('div', { class: 'book-body' },
        el('h5', { text: bookTitle(bib) }),
        el('p', { class: 'due', text: loan.returned_on ? `返却済み（${dateLabel(loan.returned_on)}）` : `返却期限 ${dateLabel(loan.due_on)}（${due.text}）` }),
        el('p', { class: 'meta', text: [loan.lender || '借りた先未入力', `借りた日 ${dateLabel(loan.borrowed_on)}`, loan.renewals ? `延長${loan.renewals}回` : ''].filter(Boolean).join(' ／ ') }),
        tags([READING_LABELS[loan.reading] || '未読', `reading-${loan.reading}`], bibTags(bib), markTag(v, loan.id)),
        loan.note ? el('p', { class: 'note', text: loan.note }) : null,
        el('div', { class: 'button-row' },
          loan.returned_on ? button('返却を取り消す', () => void loanOp('loan.update', loan, { returned_on: null }, `返却の取消し：${bib.title}`), { 'data-action': 'reopen' })
            : button('返却した', () => void loanOp('loan.return', loan, { returned_on: today() }, `返却：${bib.title}`, '返却済みにしました。'), { 'data-action': 'return' }),
          loan.returned_on ? null : button('延長', () => openRenew(loan.id), { 'data-action': 'renew' }),
          button('詳細・編集', () => openLoanEditor(loan.id), { 'data-action': 'edit' }))));
      list.append(card);
    }
  }
  async function loanOp(op, loan, data, label, done = '') {
    try { await enqueue([{ op, data: { id: loan.id, ...data }, base_revision: loan.revision, label }]); if (done) notify(done); } catch (error) { notify(error.message, true); }
  }
  function openRenew(loanId) {
    const v = view(), loan = v.loans[loanId]; if (!loan) return;
    const container = $('loan-editor');
    const period = select(Object.entries(PERIOD_LABELS), '2w'), start = el('input', { type: 'date', value: today() }), custom = el('input', { type: 'date', value: loan.due_on });
    const preview = el('p', { class: 'due-preview' }), customField = field('新しい返却期限', custom);
    const update = () => { customField.hidden = period.value !== 'custom'; const due = dueDate(start.value, period.value, custom.value); preview.textContent = validDate(due) ? `新しい返却期限：${dateLabel(due)}` : ''; };
    period.addEventListener('change', update); start.addEventListener('change', update); custom.addEventListener('change', update);
    editorFrame(container, `延長：${v.bibs[loan.bib_id]?.title || ''}`, el('div', { class: 'editor-body' },
      el('p', { class: 'hint', text: `現在の返却期限：${dateLabel(loan.due_on)}。多くの図書館は延長手続きの日から期間を数えます。` }),
      el('div', { class: 'grid' }, field('期間', period), field('数え始める日', start), customField), preview), [
      button('延長する', async () => {
        const due = dueDate(start.value, period.value, custom.value);
        if (!validDate(due) || due < loan.borrowed_on) { notify('新しい返却期限を確認してください。', true); return; }
        await loanOp('loan.renew', loan, { due_on: due }, `延長：${v.bibs[loan.bib_id]?.title || ''}`, `返却期限を${dateLabel(due)}に延長しました。`);
        container.replaceChildren();
      }, { class: 'primary' }),
      button('閉じる', () => container.replaceChildren())]);
    update();
  }
  function openLoanEditor(loanId) {
    const v = view(), loan = v.loans[loanId]; if (!loan) return;
    const container = $('loan-editor'), bib = v.bibs[loan.bib_id] || {};
    const inputs = { lender: el('input', { value: loan.lender || '', maxlength: '120' }), borrowed_on: el('input', { type: 'date', value: loan.borrowed_on }),
      due_on: el('input', { type: 'date', value: loan.due_on }), returned_on: el('input', { type: 'date', value: loan.returned_on || '' }),
      reading: select(Object.entries(READING_LABELS), loan.reading), note: el('textarea', { maxlength: '2000', rows: '3' }) };
    inputs.note.value = loan.note || '';
    editorFrame(container, `借用の詳細：${bib.title || ''}`, el('div', { class: 'editor-body' },
      el('p', { class: 'meta', text: [bib.creators, bib.publisher, bib.isbn13 && `ISBN ${bib.isbn13}`].filter(Boolean).join(' ／ ') }),
      el('div', { class: 'grid' }, field('借りた先', inputs.lender), field('借りた日', inputs.borrowed_on), field('返却期限', inputs.due_on), field('返却日（未返却は空欄）', inputs.returned_on), field('読書状態', inputs.reading)),
      field('メモ', inputs.note)), [
      button('保存', async () => {
        const next = { lender: inputs.lender.value.trim(), borrowed_on: inputs.borrowed_on.value, due_on: inputs.due_on.value, returned_on: inputs.returned_on.value || null, reading: inputs.reading.value, note: inputs.note.value.trim() };
        if (!validDate(next.borrowed_on) || !validDate(next.due_on) || next.due_on < next.borrowed_on) { notify('借りた日と返却期限を確認してください。', true); return; }
        if (next.returned_on && next.returned_on < next.borrowed_on) { notify('返却日は借りた日以降にしてください。', true); return; }
        const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => (loan[key] ?? (key === 'returned_on' ? null : '')) !== value));
        if (!Object.keys(changes).length) { notify('変更はありません。'); return; }
        await loanOp('loan.update', loan, changes, `借用の編集：${bib.title || ''}`, '変更を保存しました（送信待ちに追加）。');
        container.replaceChildren();
      }, { class: 'primary' }),
      button('閉じる', () => container.replaceChildren())]);
  }

  // --- 置場管理 ------------------------------------------------------------
  function ownedCounts(v) {
    const direct = new Map(); let unplaced = 0;
    for (const copy of Object.values(v.copies)) {
      if (copy.disposition !== 'owned') continue;
      if (copy.place_id && v.places[copy.place_id]) direct.set(copy.place_id, (direct.get(copy.place_id) || 0) + 1); else unplaced++;
    }
    const total = id => [...descendants(v.places, id)].reduce((sum, child) => sum + (direct.get(child) || 0), 0);
    return { direct, total, unplaced };
  }
  function renderPlaces() {
    const v = view(), counts = ownedCounts(v);
    const parent = $('place-parent'), parentValue = parent.value;
    parent.replaceChildren(new Option('いちばん上（部屋・家具など）', ''), ...placeOptions(v.places).map(option => new Option(option.label, option.id)));
    parent.value = v.places[parentValue] ? parentValue : '';
    const tree = $('place-tree'); tree.replaceChildren();
    const build = parentId => {
      const children = childrenOf(v.places, parentId); if (!children.length) return null;
      const list = el('ul', { class: parentId ? 'tree' : 'tree root' });
      for (const place of children) {
        const total = counts.total(place.id), direct = counts.direct.get(place.id) || 0;
        list.append(el('li', { 'data-place-id': place.id },
          el('div', { class: 'place-row' },
            el('span', { class: 'place-name', text: `${place.name}（${total}冊${total !== direct ? `、直下${direct}冊` : ''}）` }), markTag(v, place.id) ? el('span', { class: `tag ${v.marks.get(place.id)}`, text: STATUS_LABELS[v.marks.get(place.id)] }) : null,
            el('span', { class: 'button-row' },
              button('本を見る', () => showPlace(place.id), { class: 'small' }), button('名前変更', () => openPlaceEditor(place.id, 'rename'), { class: 'small' }),
              button('移動', () => openPlaceEditor(place.id, 'move'), { class: 'small' }), button('統合', () => openPlaceEditor(place.id, 'merge'), { class: 'small' }),
              button('削除', () => openPlaceEditor(place.id, 'delete'), { class: 'small' }))),
          build(place.id)));
      }
      return list;
    };
    tree.append(build(null) || el('p', { class: 'empty', text: '置き場所はまだありません。上の欄から追加してください。' }));
    tree.append(el('p', { class: 'place-row unplaced' }, el('span', { class: 'place-name', text: `場所未設定（${counts.unplaced}冊）` }), button('本を見る', () => showPlace('__none'), { class: 'small' })));
    renderMoveList(v);
    const target = $('move-scan-target'), targetValue = target.value;
    target.replaceChildren(new Option('移動先を選ぶ', ''), new Option('場所未設定にする', '__none'), ...placeOptions(v.places).map(option => new Option(option.label, option.id)));
    target.value = targetValue === '__none' || v.places[targetValue] ? targetValue : '';
  }
  async function showPlace(id) { await setPreferences({ place: id, tab: 'copies' }); copyLimit = PAGE; stopCameras(); render(); }
  function renderMoveList(v) {
    const sourceSelect = $('move-source'), targetSelect = $('move-target');
    const sourceValue = sourceSelect.value, targetValue = targetSelect.value;
    sourceSelect.replaceChildren(new Option('移動元を選ぶ', ''), new Option('場所未設定の本', '__none'), ...placeOptions(v.places).map(option => new Option(option.label, option.id)));
    sourceSelect.value = sourceValue === '__none' || v.places[sourceValue] ? sourceValue : '';
    targetSelect.replaceChildren(new Option('移動先を選ぶ', ''), new Option('場所未設定にする', '__none'), ...placeOptions(v.places).map(option => new Option(option.label, option.id)));
    targetSelect.value = targetValue === '__none' || v.places[targetValue] ? targetValue : '';
    const list = $('move-list'); list.replaceChildren();
    const source = sourceSelect.value;
    if (!source) { list.append(el('p', { class: 'hint', text: '移動元を選ぶと、そこに置いてある本（中の置き場所は含みません）が並びます。' })); return; }
    const copies = Object.values(v.copies).filter(copy => copy.disposition === 'owned' && (source === '__none' ? !copy.place_id || !v.places[copy.place_id] : copy.place_id === source))
      .sort((a, b) => compareCopies(a, b, v));
    if (!copies.length) { list.append(el('p', { class: 'empty', text: 'この置き場所に直接置いてある本はありません。' })); return; }
    const all = el('input', { type: 'checkbox', onchange: event => { for (const box of list.querySelectorAll('input[data-copy]')) box.checked = event.target.checked; } });
    list.append(el('label', { class: 'check' }, all, `すべて選ぶ（${copies.length}冊）`));
    for (const copy of copies) {
      const bib = v.bibs[copy.bib_id] || {};
      list.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', 'data-copy': copy.id }), bookTitle(bib, copy)));
    }
  }
  async function moveCopies(ids, target, label) {
    const place = target === '__none' ? null : target;
    for (let i = 0; i < ids.length; i += 500) await enqueue([{ op: 'copies.move', data: { ids: ids.slice(i, i + 500), place_id: place }, label }]);
  }
  function openPlaceEditor(placeId, action) {
    const v = view(), place = v.places[placeId]; if (!place) return;
    const container = $('place-editor'), inside = descendants(v.places, placeId);
    const path = placePath(v.places, placeId), counts = ownedCounts(v);
    if (action === 'rename') {
      const name = el('input', { value: place.name, maxlength: '80', required: true });
      editorFrame(container, `名前変更：${path}`, field('新しい名前', name), [
        button('保存', async () => {
          if (!name.value.trim()) { notify('名前を入力してください。', true); return; }
          if (name.value.trim() === place.name) { container.replaceChildren(); return; }
          try { await enqueue([{ op: 'place.update', data: { id: placeId, name: name.value.trim() }, base_revision: place.revision, label: `置き場所の名前変更：${name.value.trim()}` }]); container.replaceChildren(); } catch (error) { notify(error.message, true); }
        }, { class: 'primary' }), button('閉じる', () => container.replaceChildren())]);
    } else if (action === 'move') {
      const parent = placeSelect(v, place.parent_id, { none: 'いちばん上', exclude: inside });
      editorFrame(container, `移動：${path}`, el('div', {}, el('p', { class: 'hint', text: '中の置き場所と本もいっしょに移ります（箱ごとの移動）。' }), field('移動先', parent)), [
        button('移動する', async () => {
          const next = parent.value || null; if (next === (place.parent_id ?? null)) { container.replaceChildren(); return; }
          try { await enqueue([{ op: 'place.update', data: { id: placeId, parent_id: next }, base_revision: place.revision, label: `置き場所の移動：${place.name}` }]); container.replaceChildren(); notify('置き場所を移動しました。'); } catch (error) { notify(error.message, true); }
        }, { class: 'primary' }), button('閉じる', () => container.replaceChildren())]);
    } else if (action === 'merge') {
      const target = placeSelect(v, '', { none: '統合先を選ぶ', exclude: inside });
      editorFrame(container, `統合：${path}`, el('div', {}, el('p', { class: 'hint', text: `「${place.name}」の本（${counts.direct.get(placeId) || 0}冊）と中の置き場所を統合先へ移し、「${place.name}」をなくします。` }), field('統合先', target)), [
        button('統合する', async () => {
          if (!target.value) { notify('統合先を選んでください。', true); return; }
          try { await enqueue([{ op: 'place.merge', data: { id: placeId, into: target.value }, base_revision: place.revision, label: `置き場所の統合：${place.name} → ${v.places[target.value].name}` }]); container.replaceChildren(); notify('置き場所を統合しました。'); } catch (error) { notify(error.message, true); }
        }, { class: 'primary' }), button('閉じる', () => container.replaceChildren())]);
    } else {
      const blocked = childrenOf(v.places, placeId).length || counts.direct.get(placeId);
      editorFrame(container, `削除：${path}`, el('p', { class: blocked ? 'warning' : 'hint', text: blocked ? '中に置き場所や本があるため削除できません。先に移動するか、「統合」を使ってください。' : 'この置き場所を削除します。手放した本の置き場所の記録は「場所未設定」になります。' }), [
        blocked ? null : button('削除する', async () => {
          try { await enqueue([{ op: 'place.delete', data: { id: placeId }, base_revision: place.revision, label: `置き場所の削除：${place.name}` }]); container.replaceChildren(); notify('置き場所を削除しました。'); } catch (error) { notify(error.message, true); }
        }, { class: 'danger' }), button('閉じる', () => container.replaceChildren())].filter(Boolean));
    }
  }

  // --- 共通設定 ------------------------------------------------------------
  function renderSettings() {
    const p = prefs(), r = record();
    if (!$('endpoint').value) $('endpoint').value = state.endpoint;
    $('covers').checked = p.covers; $('due-days').value = String(p.dueSoonDays ?? 3);
    $('disconnect').disabled = !transport.connected;
    const info = transport.info;
    $('server-info').textContent = info ? `接続先：${transport.endpoint} ／ API ${info.version} ／ 書誌の取得先：${(info.capabilities?.sources || []).map(name => ({ ndl: '国立国会図書館', rakuten: '楽天ブックス', google: 'Google Books' })[name] || name).join('・') || 'なし'}${info.capabilities?.covers ? '' : ' ／ 表紙はNASで無効'}`
      : state.endpoint ? `保存済みの接続先：${state.endpoint}（キーを入力して接続してください）` : '未接続です。';
    $('last-sync').textContent = `端末への最終同期：${r.synced_at ? new Date(r.synced_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '未取得'}`;
    const v = view(), notfound = Object.values(v.bibs).filter(bib => bib.lookup_status === 'notfound' && bib.isbn13 && !bib.local);
    $('lookups').textContent = `NASで書誌を取得中：${r.pending_lookups || 0}件 ／ 見つからなかった書誌：${notfound.length}件`;
    $('refresh-notfound').disabled = !notfound.length;
    const queue = $('queue'); queue.replaceChildren();
    if (!r.queue.length) queue.append(el('p', { class: 'hint', text: '送信待ちはありません。' }));
    for (const item of r.queue) {
      queue.append(el('article', { class: `queue-item ${item.status}`, 'data-operation-id': item.operation_id },
        el('p', {}, el('span', { class: `tag ${item.status}`, text: STATUS_LABELS[item.status] || item.status }), ` ${item.label}`),
        item.message ? el('p', { class: 'meta', text: item.message }) : null,
        el('div', { class: 'button-row' },
          item.status === 'conflict' && Number.isInteger(item.current_revision) ? button('自分の変更で上書き', async () => {
            try { state = await overrideConflict(item.operation_id); announce(); render(); void sync(); } catch (error) { notify(error.message, true); }
          }, { class: 'small' }) : null,
          button(item.status === 'pending' ? '取り消す' : '破棄する', async () => {
            state = await cancelOperation(item.operation_id); announce(); notify(item.status === 'conflict' ? 'NASの最新の値を表示しています。' : '取り消しました。'); render();
          }, { class: 'small' }))));
    }
  }

  // --- Sync ------------------------------------------------------------------
  async function sync() {
    if (busy || !transport.connected || !navigator.onLine) { renderStatus(); return; }
    busy = true; lastAttempt = Date.now(); renderStatus();
    try {
      if (!navigator.locks) throw new Error('安全な同期には新しいブラウザーが必要です。');
      await navigator.locks.request(LIBRARY_SYNC_LOCK, { ifAvailable: true }, async lock => {
        if (!lock) { notify('別のタブが同期しています。'); return; }
        state = await readLibraryState();
        if (state.endpoint !== transport.endpoint) throw new Error('接続先が変更されました。再接続してください。');
        for (let round = 0; round < 100; round++) {
          const batch = record().queue.filter(item => item.status === 'pending').slice(0, 50);
          if (!batch.length) break;
          const result = await transport.request('/api/library/commands', { server_id: record().server_id, operations: batch.map(({ operation_id, op, data, base_revision }) => ({ operation_id, op, data, base_revision })) });
          if (result.server_id !== record().server_id || !Array.isArray(result.results) || !result.results.length) throw new Error('NASの受付結果を確認できません。同じ操作IDで再送します。');
          state = await recordResults(transport.endpoint, result.results);
        }
        let data;
        try { data = await transport.request(`/api/library/snapshot?since=${record().cursor || 0}`); }
        catch (error) { if (error.code !== 'cursor_ahead') throw error; data = await transport.request('/api/library/snapshot?since=0'); }
        state = await applySnapshot(transport.endpoint, data);
        const problems = record().queue.filter(item => !ACTIVE.has(item.status)).length;
        if (problems) notify(`確認が必要な送信が${problems}件あります（共通設定の「送信待ち」）。`, true);
        else if (messageError) notify('');
      });
    } catch (error) { report(error); }
    finally { busy = false; announce(); render(); }
  }

  // --- Events ----------------------------------------------------------------
  for (const node of root.querySelectorAll('[data-tab]')) node.addEventListener('click', async () => {
    stopCameras(); await setPreferences({ tab: node.dataset.tab }); render();
  });
  $('sync').addEventListener('click', () => void sync());
  $('copy-register').addEventListener('click', () => { registers.copy.open(); $('copy-register-area').scrollIntoView?.({ block: 'nearest' }); });
  $('loan-register').addEventListener('click', () => { registers.loan.open(); $('loan-register-area').scrollIntoView?.({ block: 'nearest' }); });
  $('copy-filters').addEventListener('submit', event => event.preventDefault());
  const filterKeys = { 'copy-search': 'search', 'copy-reading': 'reading', 'copy-place': 'place', 'copy-format': 'format', 'copy-grouping': 'grouping' };
  for (const [id, key] of Object.entries(filterKeys)) $(id).addEventListener(id === 'copy-search' ? 'input' : 'change', async event => { copyLimit = PAGE; await setPreferences({ [key]: event.target.value }); renderCopies(); });
  $('copy-disposed').addEventListener('change', async event => { await setPreferences({ disposed: event.target.checked }); renderCopies(); });
  $('loan-returned').addEventListener('change', async event => { await setPreferences({ showReturned: event.target.checked }); renderLoans(); });
  $('place-form').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('place-name').value.trim(); if (!name) return;
    try { await enqueue([{ op: 'place.create', data: { id: crypto.randomUUID(), name, parent_id: $('place-parent').value || null }, label: `置き場所の追加：${name}` }]); $('place-name').value = ''; notify(`「${name}」を追加しました。`); }
    catch (error) { notify(error.message, true); }
  });
  $('move-source').addEventListener('change', () => renderMoveList(view()));
  $('move-form').addEventListener('submit', async event => {
    event.preventDefault();
    const ids = [...$('move-list').querySelectorAll('input[data-copy]:checked')].map(box => box.dataset.copy), target = $('move-target').value;
    if (!ids.length || !target) { notify('移動する本と移動先を選んでください。', true); return; }
    if (target === $('move-source').value) { notify('移動元と同じ置き場所です。', true); return; }
    try { await moveCopies(ids, target, `${ids.length}冊を移動 → ${target === '__none' ? '場所未設定' : placePath(view().places, target)}`); notify(`${ids.length}冊を移動しました。`); }
    catch (error) { notify(error.message, true); }
  });
  $('move-scan-start').addEventListener('click', async () => {
    const target = $('move-scan-target').value;
    if (!target) { $('move-scan-status').textContent = '先に移動先を選んでください。'; return; }
    moveScanner?.stop();
    moveScanner = createContinuousScanner($('move-scan-video'), async result => {
      if (result.kind !== 'isbn') { beep(false); $('move-scan-status').textContent = `ISBNではないコードです（${result.code}）。`; return; }
      const v = view(), destination = $('move-scan-target').value, place = destination === '__none' ? null : destination;
      const matches = Object.values(v.copies).filter(copy => copy.disposition === 'owned' && v.bibs[copy.bib_id]?.isbn13 === result.isbn);
      if (!matches.length) { beep(false); $('move-scan-status').textContent = `蔵書にない本です（ISBN ${result.isbn}）。`; return; }
      const ids = matches.filter(copy => (copy.place_id ?? null) !== place).map(copy => copy.id), title = v.bibs[matches[0].bib_id].title || result.isbn;
      if (!ids.length) { beep(true); $('move-scan-status').textContent = `「${title}」は既に移動先にあります。`; return; }
      try { await moveCopies(ids, destination, `移動スキャン：${title}`); beep(true); $('move-scan-status').textContent = `「${title}」を移動しました。続けて読み取れます。`; }
      catch (error) { beep(false); $('move-scan-status').textContent = error.message; }
    });
    $('move-scan-status').textContent = '移動する本のバーコードを読み取ってください。';
    try { await moveScanner.start(); } catch (error) { moveScanner = null; $('move-scan-status').textContent = error.message; }
  });
  $('move-scan-stop').addEventListener('click', () => { moveScanner?.stop(); moveScanner = null; $('move-scan-status').textContent = '読み取りを停止しました。'; });
  $('connect-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    busy = true; renderStatus();
    try {
      const endpoint = normalizeLibraryEndpoint($('endpoint').value);
      const probed = await transport.connect(endpoint, $('access-key').value);
      state = await selectEndpoint(probed.endpoint, probed.info.server_id);
      $('access-key').value = ''; $('endpoint').value = probed.endpoint; notify('接続しました。');
    } catch (error) { transport.disconnect(); report(error); }
    finally { busy = false; render(); }
    if (transport.connected) await sync();
  });
  $('disconnect').addEventListener('click', () => { transport.disconnect(); notify('接続を解除しました。端末のデータと送信待ちは残ります。'); render(); });
  $('covers').addEventListener('change', async event => { const on = event.target.checked; await setPreferences({ covers: on }); notify(on ? '表紙を表示します（NAS接続中のみ）。' : '表紙を読み込みません。'); });
  $('due-days').addEventListener('change', async event => { const days = Math.max(0, Math.min(30, Math.round(Number(event.target.value) || 0))); event.target.value = String(days); await setPreferences({ dueSoonDays: days }); });
  $('refresh-notfound').addEventListener('click', async () => {
    const bibs = Object.values(view().bibs).filter(bib => bib.lookup_status === 'notfound' && bib.isbn13 && !bib.local).slice(0, 100);
    try { await enqueue(bibs.map(bib => ({ op: 'bib.refresh', data: { id: bib.id }, label: `書誌の再取得：ISBN ${bib.isbn13}` }))); notify(`${bibs.length}件の書誌をNASで再検索します。`); }
    catch (error) { notify(error.message, true); }
  });
  $('export').addEventListener('click', async () => {
    const saved = await readLibraryState();
    const blob = new Blob([JSON.stringify({ version: 1, exported_at: new Date().toISOString(), endpoint: saved.endpoint, data: libraryRecord(saved) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `library-${today()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  channel?.addEventListener('message', async () => { state = await readLibraryState(); if (transport.connected && transport.endpoint !== state.endpoint) transport.disconnect(); render(); });
  const refreshVisible = () => { if (visible() && transport.connected && navigator.onLine && Date.now() - lastAttempt > 60000) void sync(); else renderStatus(); };
  window.addEventListener('online', () => { if (visible()) void sync(); else renderStatus(); });
  window.addEventListener('offline', renderStatus);
  window.addEventListener('focus', refreshVisible);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCameras(); refreshVisible(); });
  new MutationObserver(() => { if (section.hidden) stopCameras(); refreshVisible(); }).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  setInterval(() => { if (visible()) refreshVisible(); }, 60000);
  if (!state.endpoint) { message = '共通設定でNASへ接続すると、蔵書や借りている本を管理できます。'; }
  render();
  return { sync };
}
