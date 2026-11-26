// Registration sheet shared by 蔵書管理 (mode 'copy') and 借用管理 (mode 'loan').
import { classifyCode, dueDate, findDuplicates, isbn13, PERIOD_LABELS, placeOptions, placePath, today, validDate, volumeFrom, dateLabel, compareText, bookMeta } from './libraryCore.js';
import { beep, createContinuousScanner, readPhoto } from './libraryScan.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  return node;
}
export const button = (label, onclick, attrs = {}) => el('button', { type: 'button', onclick, ...attrs }, label);
export function select(options, value, attrs = {}) {
  const node = el('select', attrs);
  for (const [optionValue, label] of options) node.append(new Option(label, optionValue));
  node.value = value ?? '';
  return node;
}
const field = (label, control, className) => el('label', { class: className }, label, control);

const blankPresets = mode => mode === 'copy'
  ? { place_id: '', series: '', new_series_name: '', format: 'paper', reading: 'unread', acquired_on: '', acquired_from: '' }
  : { lender: '', borrowed_on: today(), period: '2w', due_on: '' };

export function bibFromRow(row) {
  const candidate = row.candidates?.[row.selected ?? 0];
  if (candidate) {
    const { isbn13: isbn, ndl_id, title, title_kana, creators, publisher, issued, series_hint, volume_hint, source, source_url, cover_url } = candidate;
    return { isbn13: isbn || row.isbn || null, ndl_id: ndl_id || null, title, title_kana, creators, publisher, issued, series_hint, volume_hint, source, source_url, cover_url };
  }
  return { isbn13: row.isbn || null, title: (row.title || '').trim(), creators: (row.creators || '').trim(), source: row.isbn ? 'scan' : 'manual' };
}
export const rowTitle = row => bibFromRow(row).title || '';

/**
 * ctx: { mode, transport, view(), preferences(), draft, saveDraft(value), savePreferences(changes), enqueue(entries), notify(text, error) }
 */
export function createRegister(container, ctx) {
  const mode = ctx.mode, isCopy = mode === 'copy';
  let draft = ctx.draft && Array.isArray(ctx.draft.rows) ? structuredClone(ctx.draft) : { presets: blankPresets(mode), rows: [] };
  draft.presets = { ...blankPresets(mode), ...draft.presets };
  let scanner = null, pumping = false, saveTimer = null, searchResults = [], searchMessage = '';
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => ctx.saveDraft(draft).catch(error => ctx.notify(`下書きを保存できません：${error.message}`, true)), 200); };
  const sheet = el('section', { class: 'sheet', 'aria-label': isCopy ? '本の登録' : '借りた本の登録' });
  const presetArea = el('div', { class: 'presets' });
  const scanStatus = el('p', { class: 'hint scan-status', role: 'status' });
  const video = el('video', { class: 'scanner', playsInline: true, muted: true, hidden: true, 'aria-label': 'バーコード読取用のカメラ映像' });
  const rowsArea = el('div', { class: 'rows' });
  const searchArea = el('div', { class: 'search-results' });
  const submit = button('まとめて登録', () => void register(), { class: 'primary' });
  const isbnInput = el('input', { inputmode: 'numeric', autocomplete: 'off', maxlength: '20', placeholder: '978… または10桁' });
  const titleInput = el('input', { maxlength: '200', autocomplete: 'off', placeholder: '書名（一部でも可）' });
  const creatorInput = el('input', { maxlength: '200', autocomplete: 'off', placeholder: '著者・サークル名' });
  const photo = el('input', { type: 'file', accept: 'image/*', capture: 'environment' });

  function setStatus(text) { scanStatus.textContent = text; }
  // Never rebuild inputs under the user's fingers: background syncs and lookups wait until focus leaves.
  let deferred = false;
  const typing = () => { const active = sheet.getRootNode().activeElement; return !!active && sheet.contains(active) && ['INPUT', 'TEXTAREA'].includes(active.tagName) && active.type !== 'file'; };
  function rerender(presetsToo = false) {
    if (!container.firstChild) return;
    if (typing()) { deferred = deferred || (presetsToo ? 'all' : 'rows'); return; }
    if (presetsToo) renderPresets();
    renderRows();
  }
  sheet.addEventListener('focusout', () => setTimeout(() => {
    if (!deferred || typing()) return;
    const all = deferred === 'all'; deferred = false; rerender(all);
  }, 0));
  function addRow(row, announce = true) {
    if (row.isbn && draft.rows.some(item => item.isbn === row.isbn)) { setStatus(`ISBN ${row.isbn} は一覧に追加済みです。`); return false; }
    draft.rows.push({ key: crypto.randomUUID(), selected: 0, candidates: [], title: '', creators: '', volume_label: '', volume_sort: null, ...row });
    persist(); renderRows();
    if (announce) setStatus(`${draft.rows.length}件目を追加しました${row.isbn ? `（ISBN ${row.isbn}）` : ''}。`);
    void pump();
    return true;
  }
  function addIsbn(isbn) { return addRow({ isbn, status: 'lookup' }); }
  function onRead(result) {
    if (result.kind === 'isbn') { if (addIsbn(result.isbn)) beep(true); }
    else { beep(false); setStatus(`ISBNではないコード（${result.code}）です。書名で検索してください。`); }
  }
  function applyVolume(row) {
    if (!isCopy || row.volume_label) return;
    const candidate = row.candidates[row.selected ?? 0];
    const volume = volumeFrom(candidate?.volume_hint, draft.presets.series ? candidate?.title : '');
    row.volume_label = volume.label; row.volume_sort = volume.sort;
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (ctx.transport.connected && navigator.onLine) {
        const row = draft.rows.find(item => item.status === 'lookup');
        if (!row) break;
        try {
          const result = await ctx.transport.request(`/api/library/lookup?isbn=${encodeURIComponent(row.isbn)}`);
          const current = draft.rows.find(item => item.key === row.key); if (!current) continue;
          current.candidates = Array.isArray(result.results) ? result.results.slice(0, 5) : [];
          current.status = current.candidates.length ? 'found' : 'notfound';
          applyVolume(current);
        } catch (error) {
          const current = draft.rows.find(item => item.key === row.key);
          if (current) { current.status = 'offline'; current.message = error.message; }
          if (error.status === 401) { ctx.notify(error.message, true); break; }
        }
        persist(); rerender();
      }
    } finally { pumping = false; }
  }
  function duplicateNotes(row) {
    const view = ctx.view(), bib = bibFromRow(row), notes = [];
    if (!bib.title && !bib.isbn13) return notes;
    for (const match of findDuplicates(view, bib)) {
      const place = match.copy.place_id && view.places[match.copy.place_id] ? `・${placePath(view.places, match.copy.place_id)}` : '';
      notes.push(match.disposed ? `以前手放した本です（${match.reason}一致）` : `既に蔵書にあります（${match.reason}一致${place}）`);
    }
    if (!isCopy) {
      const open = Object.values(view.loans).find(loan => !loan.returned_on && view.bibs[loan.bib_id] && (bib.isbn13 ? view.bibs[loan.bib_id].isbn13 === isbn13(bib.isbn13) : view.bibs[loan.bib_id].title === bib.title));
      if (open) notes.push(`返却前の同じ本があります（期限 ${dateLabel(open.due_on)}）`);
    }
    return notes;
  }
  function statusText(row) {
    if (row.status === 'lookup') return ctx.transport.connected && navigator.onLine ? '書誌を取得中…' : '書誌未取得（接続後に取得。このまま登録するとNASが後で取得）';
    if (row.status === 'found') return row.candidates.length > 1 ? `候補${row.candidates.length}件` : '書誌を取得しました';
    if (row.status === 'notfound') return '書誌が見つかりませんでした。書名を入力してください。';
    if (row.status === 'offline') return '書誌未取得（登録後にNASが取得します）';
    return '手入力';
  }
  function renderRows() {
    rowsArea.replaceChildren();
    const count = draft.rows.length;
    submit.textContent = `まとめて登録（${count}件）`; submit.disabled = !count;
    if (!count) { rowsArea.append(el('p', { class: 'empty', text: '読み取った本がここに並びます。' })); return; }
    draft.rows.forEach((row, index) => {
      const bib = bibFromRow(row);
      const card = el('article', { class: `row status-${row.status}`, 'data-row': row.key });
      card.append(el('h5', { text: `${index + 1}. ${bib.title || (row.isbn ? `ISBN ${row.isbn}` : '（書名未入力）')}` }));
      const meta = [bookMeta(bib, dateLabel), bib.isbn13 && `ISBN ${bib.isbn13}`].filter(Boolean).join(' ／ ');
      if (meta) card.append(el('p', { class: 'meta', text: meta }));
      card.append(el('p', { class: 'row-status', text: statusText(row) }));
      for (const note of duplicateNotes(row)) card.append(el('p', { class: 'warning', text: `⚠ ${note}` }));
      if (row.candidates.length > 1) {
        card.append(field('候補', select(row.candidates.map((c, i) => [String(i), `${c.title}${c.creators ? ` ／ ${c.creators}` : ''}${c.issued ? `（${dateLabel(c.issued)}）` : ''}`]), String(row.selected ?? 0), {
          onchange: event => { row.selected = Number(event.target.value); row.volume_label = ''; applyVolume(row); persist(); renderRows(); }
        })));
      }
      if (!row.candidates.length) {
        const fields = el('div', { class: 'grid' });
        fields.append(field('書名', el('input', { value: row.title || '', maxlength: '500', oninput: event => { row.title = event.target.value; persist(); } })));
        fields.append(field('著者・サークル', el('input', { value: row.creators || '', maxlength: '300', oninput: event => { row.creators = event.target.value; persist(); } })));
        card.append(fields);
      }
      if (isCopy) {
        const volume = el('div', { class: 'grid compact' });
        volume.append(field('巻表記', el('input', { value: row.volume_label || '', maxlength: '40', placeholder: '例：3、上、総集編', oninput: event => { row.volume_label = event.target.value; persist(); } })));
        volume.append(field('並び順', el('input', { type: 'number', step: 'any', value: row.volume_sort ?? '', oninput: event => { row.volume_sort = event.target.value === '' ? null : Number(event.target.value); persist(); } })));
        card.append(volume);
      }
      card.append(el('div', { class: 'button-row' }, button('一覧から外す', () => { draft.rows = draft.rows.filter(item => item.key !== row.key); persist(); renderRows(); })));
      rowsArea.append(card);
    });
  }
  function renderSearch() {
    searchArea.replaceChildren();
    if (searchMessage) searchArea.append(el('p', { class: 'hint', text: searchMessage }));
    for (const result of searchResults) {
      const item = el('article', { class: 'candidate' },
        el('h5', { text: result.title }),
        el('p', { class: 'meta', text: [bookMeta(result, dateLabel), result.volume_hint && `巻：${result.volume_hint}`, result.isbn13 ? `ISBN ${result.isbn13}` : 'ISBNなし', { ndl: '国立国会図書館', rakuten: '楽天ブックス', google: 'Google Books' }[result.source]].filter(Boolean).join(' ／ ') }),
        el('div', { class: 'button-row' }, button('一覧に追加', () => {
          const row = { isbn: result.isbn13 || null, status: 'found', candidates: [result] };
          applyVolume(row); if (addRow(row)) beep(true);
        })));
      searchArea.append(item);
    }
  }
  async function search() {
    const title = titleInput.value.trim(), creator = creatorInput.value.trim();
    if (!title && !creator) { searchMessage = '書名か著者・サークル名を入力してください。'; renderSearch(); return; }
    if (!ctx.transport.connected || !navigator.onLine) { searchMessage = '書名検索にはNASへの接続が必要です。「書名だけで追加」なら接続なしで登録できます。'; searchResults = []; renderSearch(); return; }
    searchMessage = '検索中…'; searchResults = []; renderSearch();
    try {
      const params = new URLSearchParams({ ...(title ? { title } : {}), ...(creator ? { creator } : {}) });
      const result = await ctx.transport.request(`/api/library/lookup?${params}`);
      searchResults = Array.isArray(result.results) ? result.results : [];
      searchMessage = searchResults.length ? `${searchResults.length}件見つかりました。${result.partial ? '（一部の取得先に接続できませんでした）' : ''}` : '見つかりませんでした。書名だけで追加できます。';
    } catch (error) { searchMessage = error.message; }
    renderSearch();
  }
  function renderPresets() {
    presetArea.replaceChildren();
    const view = ctx.view(), p = draft.presets;
    const set = key => event => { p[key] = event.target.value; persist(); renderPresetsLater(); };
    if (isCopy) {
      const places = [['', '場所未設定'], ...placeOptions(view.places).map(option => [option.id, option.label])];
      const series = [['', 'シリーズなし'], ...Object.values(view.series).sort((a, b) => compareText(a.name, b.name)).map(s => [s.id, s.name]), ['__new', '＋新しいシリーズ']];
      if (p.place_id && !view.places[p.place_id]) p.place_id = '';
      if (p.series && p.series !== '__new' && !view.series[p.series]) p.series = '';
      const grid = el('div', { class: 'grid' },
        field('置き場所', select(places, p.place_id, { onchange: set('place_id') })),
        field('シリーズ', select(series, p.series, { onchange: set('series') })),
        p.series === '__new' ? field('新しいシリーズ名', el('input', { value: p.new_series_name, maxlength: '120', oninput: event => { p.new_series_name = event.target.value; persist(); } })) : null,
        field('形態', select([['paper', '紙'], ['digital', '電子（同人誌の電子版など）']], p.format, { onchange: set('format') })),
        field('読書状態', select([['unread', '未読'], ['reading', '読書中'], ['done', '読了']], p.reading, { onchange: set('reading') })));
      const extra = el('details', { class: 'extra' }, el('summary', { text: '入手情報（任意）' }), el('div', { class: 'grid' },
        field('入手日', el('input', { type: 'date', value: p.acquired_on, onchange: set('acquired_on') })),
        field('入手先（イベント名・店名など）', el('input', { value: p.acquired_from, maxlength: '120', oninput: event => { p.acquired_from = event.target.value; persist(); } }))));
      if (p.acquired_on || p.acquired_from) extra.open = true;
      presetArea.append(el('p', { class: 'hint', text: '下の条件で、読み取った本をまとめて登録します。' }), grid, extra);
    } else {
      const lenders = [...new Set(Object.values(view.loans).map(loan => loan.lender).filter(Boolean))].sort(compareText);
      const listId = `lender-options-${Math.random().toString(36).slice(2)}`;
      const lender = el('input', { value: p.lender, maxlength: '120', list: listId, placeholder: '例：市立図書館、大学図書館', oninput: event => { p.lender = event.target.value; persist(); } });
      lender.addEventListener('change', () => {
        const remembered = ctx.preferences().periods?.[p.lender.trim()];
        if (remembered && remembered !== p.period) { p.period = remembered; persist(); renderPresets(); }
      });
      const due = dueDate(p.borrowed_on, p.period, p.due_on);
      const grid = el('div', { class: 'grid' },
        field('借りた先', lender), el('datalist', { id: listId }, ...lenders.map(name => el('option', { value: name }))),
        field('借りた日', el('input', { type: 'date', value: p.borrowed_on, required: true, onchange: set('borrowed_on') })),
        field('貸出期間', select(Object.entries(PERIOD_LABELS), p.period, { onchange: set('period') })),
        p.period === 'custom'
          ? field('返却期限', el('input', { type: 'date', value: p.due_on, required: true, onchange: set('due_on') }))
          : el('p', { class: 'due-preview', text: validDate(due) ? `返却期限：${dateLabel(due)}` : '借りた日を入力してください。' }));
      presetArea.append(el('p', { class: 'hint', text: '借りた先と期間を決めてから、本を読み取ってください。' }), grid);
    }
  }
  let presetTimer;
  function renderPresetsLater() { clearTimeout(presetTimer); presetTimer = setTimeout(() => { renderPresets(); renderRows(); }, 0); }
  async function register() {
    if (!draft.rows.length) return;
    const p = draft.presets, entries = [];
    for (const row of draft.rows) {
      const bib = bibFromRow(row);
      if (!bib.title && !bib.isbn13) { ctx.notify('書名のない行があります。書名を入力するか、一覧から外してください。', true); return; }
    }
    try {
      if (isCopy) {
        let seriesId = p.series || null;
        if (seriesId === '__new') {
          const name = p.new_series_name.trim();
          if (!name) { ctx.notify('新しいシリーズ名を入力してください。', true); return; }
          seriesId = crypto.randomUUID();
          entries.push({ op: 'series.create', data: { id: seriesId, name, creator: '' }, label: `シリーズ作成：${name}` });
        }
        for (const row of draft.rows) {
          const bib = bibFromRow(row);
          entries.push({ op: 'copy.create', label: `蔵書登録：${bib.title || `ISBN ${bib.isbn13}`}`, data: {
            id: crypto.randomUUID(), bib, series_id: seriesId, volume_label: String(row.volume_label || '').trim(),
            volume_sort: Number.isFinite(row.volume_sort) ? row.volume_sort : null, format: p.format, place_id: p.place_id || null, reading: p.reading,
            acquired_on: p.acquired_on || null, acquired_from: p.acquired_from.trim() } });
        }
      } else {
        const due = dueDate(p.borrowed_on, p.period, p.due_on);
        if (!validDate(p.borrowed_on) || !validDate(due)) { ctx.notify('借りた日と返却期限を確認してください。', true); return; }
        if (due < p.borrowed_on) { ctx.notify('返却期限は借りた日以降にしてください。', true); return; }
        for (const row of draft.rows) {
          const bib = bibFromRow(row);
          entries.push({ op: 'loan.create', label: `借用登録：${bib.title || `ISBN ${bib.isbn13}`}`, data: {
            id: crypto.randomUUID(), bib, lender: p.lender.trim(), borrowed_on: p.borrowed_on, due_on: due, reading: 'unread' } });
        }
        if (p.lender.trim()) await ctx.savePreferences({ periods: { ...(ctx.preferences().periods || {}), [p.lender.trim()]: p.period } });
      }
      const count = draft.rows.length;
      await ctx.enqueue(entries);
      // Keep adding to the series just created instead of creating it again next time.
      const created = entries.find(entry => entry.op === 'series.create');
      if (created) { p.series = created.data.id; p.new_series_name = ''; }
      draft.rows = []; clearTimeout(saveTimer); await ctx.saveDraft(draft);
      stop(); container.replaceChildren(); ctx.notify(`${count}件を登録しました（送信待ちに追加）。`);
      ctx.closed?.();
    } catch (error) { ctx.notify(error.message, true); }
  }
  function stop() { scanner?.stop(); scanner = null; }
  function open() {
    if (container.firstChild) return;
    const isbnForm = el('form', { class: 'inline isbn-form', onsubmit: event => {
      event.preventDefault();
      const result = classifyCode(isbnInput.value);
      if (result.kind !== 'isbn') { setStatus('ISBNを確認してください（978/979で始まる13桁、または10桁）。'); return; }
      if (addIsbn(result.isbn)) isbnInput.value = '';
    } }, field('ISBNを入力', isbnInput), el('button', { type: 'submit' }, '追加'));
    const searchForm = el('form', { class: 'inline search-form', onsubmit: event => { event.preventDefault(); void search(); } },
      field('書名', titleInput), field('著者・サークル', creatorInput),
      el('div', { class: 'button-row' }, el('button', { type: 'submit' }, '検索'), button('書名だけで追加', () => {
        if (!titleInput.value.trim()) { searchMessage = '書名を入力してください。'; renderSearch(); return; }
        addRow({ isbn: null, status: 'manual', title: titleInput.value.trim(), creators: creatorInput.value.trim() });
        titleInput.value = ''; creatorInput.value = '';
      })));
    photo.addEventListener('change', async () => {
      const file = photo.files[0]; if (!file) return;
      setStatus('写真を読み取り中…');
      try {
        const result = await readPhoto(file);
        if (result.kind === 'isbn') addIsbn(result.isbn);
        else setStatus(result.kind === 'ignore' ? '下段のコードを読み取りました。978で始まる上段のバーコードを写してください。' : 'ISBNではないコードです。書名で検索してください。');
      } catch (error) { setStatus(error.message); }
      photo.value = '';
    });
    const startButton = button('カメラで連続読取', async () => {
      if (scanner?.running) return;
      scanner = createContinuousScanner(video, onRead);
      setStatus('バーコード（978で始まる上段）を枠に入れてください。続けて次の本を読み取れます。');
      try { await scanner.start(); } catch (error) { scanner = null; setStatus(error.message); }
    });
    sheet.replaceChildren(
      el('h4', { text: isCopy ? '本を登録' : '本を借りる' }), presetArea,
      el('div', { class: 'methods' },
        el('div', { class: 'button-row' }, startButton, button('読取停止', () => { stop(); setStatus('読み取りを停止しました。'); })),
        video, scanStatus, field('バーコードの写真から読取', photo), isbnForm,
        el('details', { class: 'title-search' }, el('summary', { text: '書名で検索（ISBNのない本・同人誌）' }),
          el('p', { class: 'hint', text: 'iPhoneでは入力欄を長押しして「テキストをスキャン」を選ぶと、表紙や奥付の文字をカメラで入力できます。' }),
          searchForm, searchArea)),
      el('h4', { text: '読取済み一覧' }), rowsArea,
      el('div', { class: 'button-row sheet-actions' }, submit,
        button('一覧を空にする', () => { draft.rows = []; persist(); renderRows(); }),
        button('閉じる', () => { stop(); container.replaceChildren(); ctx.closed?.(); })));
    container.replaceChildren(sheet);
    renderPresets(); renderRows(); renderSearch(); void pump();
  }
  return {
    open, stop,
    get isOpen() { return !!container.firstChild; },
    refresh() { if (container.firstChild) { rerender(true); void pump(); } },
    get rowCount() { return draft.rows.length; }
  };
}
