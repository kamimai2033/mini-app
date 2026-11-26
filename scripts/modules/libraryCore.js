// Pure helpers for 「本棚・図書館」. No DOM or storage access, so Node tests can import this file.

export const READING_LABELS = { unread: '未読', reading: '読書中', done: '読了' };
export const FORMAT_LABELS = { paper: '紙', digital: '電子' };
export const DISPOSITION_LABELS = { owned: '所持', sold: '売却', given: '譲渡', discarded: '廃棄' };
export const PERIOD_LABELS = { '2w': '2週間', '1m': '1か月', custom: '日付を指定' };
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
export const compareText = (a, b) => collator.compare(String(a || ''), String(b || ''));

// --- ISBN ------------------------------------------------------------------
export function isbn13(value) {
  const text = String(value ?? '').normalize('NFKC').replace(/[\s\-‐－ー]/g, '').toUpperCase();
  const check13 = digits => (10 - [...digits].reduce((sum, c, i) => sum + Number(c) * (i % 2 ? 3 : 1), 0) % 10) % 10;
  if (/^\d{9}[\dX]$/.test(text)) {
    const total = [...text].reduce((sum, c, i) => sum + (10 - i) * (c === 'X' ? 10 : Number(c)), 0);
    if (total % 11) return null;
    const body = `978${text.slice(0, 9)}`;
    return body + check13(body);
  }
  if (/^97[89]\d{10}$/.test(text)) return check13(text.slice(0, 12)) === Number(text[12]) ? text : null;
  return null;
}
/** Classify a scanned EAN: ISBN, the price/class code printed below it (191/192), or something else. */
export function classifyCode(code) {
  const text = String(code || '').trim();
  if (/^19[12]\d{10}$/.test(text)) return { kind: 'ignore', code: text };
  const isbn = isbn13(text);
  return isbn ? { kind: 'isbn', isbn } : { kind: 'other', code: text };
}

// --- Dates (calendar days in Asia/Tokyo) -------------------------------------
export function today(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
}
const parts = value => value.split('-').map(Number);
const iso = time => new Date(time).toISOString().slice(0, 10);
export function addDays(value, days) { const [y, m, d] = parts(value); return iso(Date.UTC(y, m - 1, d + days)); }
export function addMonths(value, months) {
  const [y, m, d] = parts(value);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, m - 1 + months, Math.min(d, last)));
}
export function dayDiff(from, to) {
  const [a, b] = [parts(from), parts(to)];
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}
export function dueDate(start, period, custom) {
  if (period === '2w') return addDays(start, 14);
  if (period === '1m') return addMonths(start, 1);
  return custom || '';
}
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [y, m, d] = parts(value), date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
export function dateLabel(value) {
  if (!value) return '';
  const [y, m, d] = parts(value);
  return d ? `${y}/${m}/${d}` : m ? `${y}/${m}` : String(y);
}
/** 'overdue' | 'today' | 'soon' | 'later' plus the human text for a loan's due date. */
export function dueState(due, base, soonDays = 3) {
  const diff = dayDiff(base, due);
  if (diff < 0) return { state: 'overdue', text: `${-diff}日超過` };
  if (diff === 0) return { state: 'today', text: '本日が期限' };
  return { state: diff <= soonDays ? 'soon' : 'later', text: `あと${diff}日` };
}

// --- Text -----------------------------------------------------------------
export function normalizeTitle(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
/** Volume label/sort from NDL's volume field, or a trailing number in the title. */
export function volumeFrom(hint, title) {
  const text = String(hint || '').normalize('NFKC').trim();
  if (text) { const match = text.match(/\d+(?:\.\d+)?/); return { label: text, sort: match ? Number(match[0]) : null }; }
  const match = String(title || '').normalize('NFKC').match(/(\d+(?:\.\d+)?)\s*巻?\s*$/);
  return match ? { label: match[1], sort: Number(match[1]) } : { label: '', sort: null };
}

// --- Local view: server data with queued operations applied ---------------------
const tableOf = op => ({ place: 'places', series: 'series', copy: 'copies', copies: 'copies', loan: 'loans', bib: 'bibs' })[op.split('.')[0]];
export const ACTIVE = new Set(['pending', 'sending']);

function localBib(view, copyId, bib) {
  const isbn = bib?.isbn13 ? isbn13(bib.isbn13) : null;
  const existing = Object.values(view.bibs).find(item => (isbn && item.isbn13 === isbn) || (bib?.ndl_id && item.ndl_id === bib.ndl_id));
  if (existing) return existing.id;
  const id = `local:${copyId}`;
  view.bibs[id] = {
    id, isbn13: isbn, ndl_id: bib?.ndl_id || null, title: bib?.title || '', title_kana: bib?.title_kana || '', creators: bib?.creators || '',
    publisher: bib?.publisher || '', issued: bib?.issued || '', series_hint: bib?.series_hint || '', volume_hint: bib?.volume_hint || '',
    source: bib?.source || 'manual', lookup_status: bib?.title ? 'local' : 'pending', overridden: [], revision: 0, local: true
  };
  return id;
}
function bump(entity, changes) { return { ...entity, ...changes, revision: (entity.revision || 0) + 1 }; }

/**
 * Apply queued operations optimistically. Entities touched by a queued operation are
 * listed in `marks` with the worst status ('pending' < 'rejected' < 'conflict').
 */
export function localView(record) {
  const view = {};
  for (const table of ['places', 'series', 'bibs', 'copies', 'loans']) view[table] = { ...(record[table] || {}) };
  const marks = new Map();
  const mark = (id, status) => {
    const rank = { pending: 1, sending: 1, rejected: 2, conflict: 3 };
    if ((rank[status] || 0) > (rank[marks.get(id)] || 0)) marks.set(id, status);
  };
  for (const item of record.queue || []) {
    const { op, data = {} } = item, table = tableOf(op);
    const ids = op === 'copies.move' ? data.ids || [] : [data.id];
    ids.forEach(id => mark(id, item.status));
    if (!ACTIVE.has(item.status)) continue;
    const current = view[table]?.[data.id];
    switch (op) {
      case 'place.create': view.places[data.id] = { id: data.id, parent_id: data.parent_id ?? null, name: data.name, note: data.note || '', sort: 1e9, deleted: false, revision: 1 }; break;
      case 'series.create': view.series[data.id] = { id: data.id, name: data.name, creator: data.creator || '', note: data.note || '', deleted: false, revision: 1 }; break;
      case 'place.update': case 'series.update': case 'copy.update': case 'loan.update': {
        if (!current) break;
        const { id, ...changes } = data; view[table][id] = bump(current, changes); break;
      }
      case 'place.merge': {
        if (!current) break;
        for (const place of Object.values(view.places)) if (place.parent_id === data.id) view.places[place.id] = bump(place, { parent_id: data.into });
        for (const copy of Object.values(view.copies)) if (copy.place_id === data.id) view.copies[copy.id] = bump(copy, { place_id: data.into });
        delete view.places[data.id]; break;
      }
      case 'place.delete': {
        for (const copy of Object.values(view.copies)) if (copy.place_id === data.id) view.copies[copy.id] = bump(copy, { place_id: null });
        delete view.places[data.id]; break;
      }
      case 'series.merge': {
        for (const copy of Object.values(view.copies)) if (copy.series_id === data.id) view.copies[copy.id] = bump(copy, { series_id: data.into });
        delete view.series[data.id]; break;
      }
      case 'copy.create': {
        const { bib, id, ...fields } = data;
        view.copies[id] = { id, series_id: null, volume_sort: null, volume_label: '', format: 'paper', place_id: null, reading: 'unread', acquired_on: null,
          acquired_from: '', price: null, note: '', ...fields, bib_id: localBib(view, id, bib), disposition: 'owned', disposed_on: null, revision: 1, local: true };
        break;
      }
      case 'copy.dispose': if (current) view.copies[data.id] = bump(current, { disposition: data.disposition, disposed_on: data.disposed_on }); break;
      case 'copy.restore': if (current) view.copies[data.id] = bump(current, { disposition: 'owned', disposed_on: null }); break;
      case 'copies.move': for (const id of ids) if (view.copies[id] && view.copies[id].place_id !== (data.place_id ?? null)) view.copies[id] = bump(view.copies[id], { place_id: data.place_id ?? null }); break;
      case 'loan.create': {
        const { bib, id, ...fields } = data;
        view.loans[id] = { id, lender: '', reading: 'unread', note: '', renewals: 0, returned_on: null, ...fields, bib_id: localBib(view, id, bib), revision: 1, local: true };
        break;
      }
      case 'loan.renew': if (current) view.loans[data.id] = bump(current, { due_on: data.due_on, renewals: (current.renewals || 0) + 1 }); break;
      case 'loan.return': if (current) view.loans[data.id] = bump(current, { returned_on: data.returned_on }); break;
      case 'bib.update': {
        if (!current) break;
        const changes = {}, overridden = new Set(current.overridden || []);
        for (const [key, value] of Object.entries(data.fields || {})) { if (value !== null) { changes[key] = value; overridden.add(key); } }
        view.bibs[data.id] = bump(current, { ...changes, overridden: [...overridden] }); break;
      }
      case 'bib.refresh': if (current) view.bibs[data.id] = { ...current, lookup_status: 'pending' }; break;
      default: break;
    }
  }
  return { ...view, marks };
}

// --- Places ---------------------------------------------------------------
export function placePath(places, id) {
  const names = [], seen = new Set();
  let current = places[id];
  while (current && !seen.has(current.id)) { seen.add(current.id); names.unshift(current.name); current = places[current.parent_id]; }
  return names.join(' ＞ ');
}
export function descendants(places, id) {
  const result = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const place of Object.values(places)) if (place.parent_id && result.has(place.parent_id) && !result.has(place.id)) { result.add(place.id); grew = true; }
  }
  return result;
}
export function placeOptions(places, exclude = new Set()) {
  return Object.values(places).filter(place => !exclude.has(place.id))
    .map(place => ({ id: place.id, label: placePath(places, place.id) }))
    .sort((a, b) => compareText(a.label, b.label));
}
export function childrenOf(places, parentId) {
  return Object.values(places).filter(place => (place.parent_id ?? null) === parentId)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || compareText(a.name, b.name));
}

// --- Books ----------------------------------------------------------------
export function bookSortKey(bib) { return bib?.title_kana || bib?.title || ''; }
/** Display title with the volume label appended unless the title already ends with it. */
export function bookTitle(bib, copy) {
  const title = bib?.title || (bib?.isbn13 ? `ISBN ${bib.isbn13}` : '（書名なし）'), volume = String(copy?.volume_label || '').trim();
  return volume && !title.endsWith(volume) ? `${title}　${volume}` : title;
}
/** 'creators ／ publisher ／ issued', skipping a publisher that repeats the creator (common for circles). */
export function bookMeta(bib, formatDate = value => value) {
  const publisher = bib?.publisher && bib.publisher !== bib.creators ? bib.publisher : '';
  return [bib?.creators, publisher, formatDate(bib?.issued || '')].filter(Boolean).join(' ／ ');
}
/** Series name, then volume order, then reading/title. Copies without a series come last. */
export function compareCopies(a, b, view) {
  const sa = view.series[a.series_id]?.name, sb = view.series[b.series_id]?.name;
  if (sa !== sb) return sa === undefined ? 1 : sb === undefined ? -1 : compareText(sa, sb);
  return sa !== undefined ? compareVolumes(a, b, view.bibs) : compareText(bookSortKey(view.bibs[a.bib_id]), bookSortKey(view.bibs[b.bib_id])) || compareVolumes(a, b, view.bibs);
}
export function compareVolumes(a, b, bibs) {
  const av = a.volume_sort ?? Infinity, bv = b.volume_sort ?? Infinity;
  if (av !== bv) return av - bv;
  return compareText(a.volume_label, b.volume_label) || compareText(bookSortKey(bibs[a.bib_id]), bookSortKey(bibs[b.bib_id]));
}
/** Owned or previously owned copies that look like the same book. */
export function findDuplicates(view, bib, { ignore = new Set() } = {}) {
  const isbn = bib?.isbn13 ? isbn13(bib.isbn13) : null, title = normalizeTitle(bib?.title), creators = normalizeTitle(bib?.creators);
  const matches = [];
  for (const copy of Object.values(view.copies)) {
    if (ignore.has(copy.id)) continue;
    const other = view.bibs[copy.bib_id];
    if (!other) continue;
    let reason = '';
    if (isbn && other.isbn13 === isbn) reason = 'ISBN';
    else if (bib?.ndl_id && other.ndl_id === bib.ndl_id) reason = '書誌ID';
    else if (title && normalizeTitle(other.title) === title && (!creators || !other.creators || normalizeTitle(other.creators) === creators)) reason = '書名';
    if (reason) matches.push({ copy, bib: other, reason, disposed: copy.disposition !== 'owned' });
  }
  return matches;
}
export function matchesSearch(query, ...values) {
  const needle = normalizeTitle(query);
  return !needle || values.some(value => normalizeTitle(value).includes(needle));
}
