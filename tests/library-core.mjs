import assert from 'node:assert/strict';
import {
  isbn13, classifyCode, addDays, addMonths, dayDiff, dueDate, dueState, validDate, today, normalizeTitle, volumeFrom,
  localView, placePath, descendants, placeOptions, findDuplicates, compareVolumes, matchesSearch
} from '../scripts/modules/libraryCore.js';

let checks = 0; const pass = name => { checks++; console.log(`PASS: ${name}`); };

assert.equal(isbn13('4-10-101013-7'), '9784101010137');
assert.equal(isbn13('９７８４０８８７２５０９３'), '9784088725093');
assert.equal(isbn13('9784088725094'), null);
assert.deepEqual(classifyCode('1920193004009'), { kind: 'ignore', code: '1920193004009' });
assert.deepEqual(classifyCode('9784088725093'), { kind: 'isbn', isbn: '9784088725093' });
assert.equal(classifyCode('4901234567894').kind, 'other');
pass('ISBN-10/13 normalisation, check digits and the ignored 191/192 lower barcode');

assert.equal(addDays('2026-11-24', 14), '2026-12-08');
assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
assert.equal(dayDiff('2026-11-24', '2026-12-08'), 14);
assert.equal(dueDate('2026-11-24', '2w'), '2026-12-08');
assert.equal(dueDate('2026-11-24', '1m'), '2026-12-24');
assert.equal(dueDate('2026-11-24', 'custom', '2026-11-30'), '2026-11-30');
assert.deepEqual(dueState('2026-11-20', '2026-11-24'), { state: 'overdue', text: '4日超過' });
assert.equal(dueState('2026-11-24', '2026-11-24').state, 'today');
assert.equal(dueState('2026-11-26', '2026-11-24', 3).state, 'soon');
assert.equal(dueState('2026-12-24', '2026-11-24', 3).state, 'later');
assert(validDate('2028-02-29')); assert(!validDate('2026-02-29')); assert(!validDate('2026-1-1'));
assert.equal(today(new Date('2026-11-24T16:30:00Z')), '2026-11-25');
pass('Loan periods (2 weeks, 1 month with month-end clamp), due states and Tokyo calendar days');

assert.equal(normalizeTitle('ワンピース　１！'), normalizeTitle('ﾜﾝﾋﾟｰｽ 1'));
assert.deepEqual(volumeFrom('2', ''), { label: '2', sort: 2 });
assert.deepEqual(volumeFrom('', 'ワンピース 12'), { label: '12', sort: 12 });
assert.deepEqual(volumeFrom('総集編', ''), { label: '総集編', sort: null });
assert(matchesSearch('ONE', 'one piece') && !matchesSearch('zzz', 'one piece') && matchesSearch('', 'x'));
pass('Title normalisation, volume hints and search');

const places = {
  room: { id: 'room', parent_id: null, name: '部屋', sort: 1, revision: 1 },
  shelf: { id: 'shelf', parent_id: 'room', name: '本棚A', sort: 1, revision: 1 },
  box: { id: 'box', parent_id: 'shelf', name: '箱3', sort: 2, revision: 1 }
};
assert.equal(placePath(places, 'box'), '部屋 ＞ 本棚A ＞ 箱3');
assert.deepEqual([...descendants(places, 'shelf')].sort(), ['box', 'shelf']);
assert.deepEqual(placeOptions(places, descendants(places, 'shelf')).map(o => o.id), ['room']);
pass('Place paths, descendants and options excluding a subtree');

const record = {
  places, series: {}, loans: {},
  bibs: { b1: { id: 'b1', isbn13: '9784101010137', title: 'こころ', creators: '夏目 漱石', revision: 1 } },
  copies: { c1: { id: 'c1', bib_id: 'b1', place_id: 'shelf', disposition: 'owned', reading: 'unread', revision: 3 } },
  queue: [
    { operation_id: 'o1', op: 'place.create', data: { id: 'new', name: '押入れ', parent_id: null }, status: 'pending' },
    { operation_id: 'o2', op: 'copy.update', data: { id: 'c1', reading: 'done' }, base_revision: 3, status: 'pending' },
    { operation_id: 'o3', op: 'copy.create', data: { id: 'c2', bib: { isbn13: '4101010137', source: 'scan' }, place_id: 'new' }, status: 'pending' },
    { operation_id: 'o4', op: 'copy.create', data: { id: 'c3', bib: { title: '夏の合同誌', creators: '月見サークル', source: 'manual' } }, status: 'pending' },
    { operation_id: 'o5', op: 'copies.move', data: { ids: ['c1'], place_id: 'box' }, status: 'pending' },
    { operation_id: 'o6', op: 'place.merge', data: { id: 'box', into: 'new' }, base_revision: 1, status: 'conflict' }
  ]
};
const view = localView(record);
assert.equal(view.places.new.name, '押入れ');
assert.equal(view.copies.c1.reading, 'done');
assert.equal(view.copies.c1.revision, 5, 'each queued edit bumps the revision used for the next base');
assert.equal(view.copies.c1.place_id, 'box');
assert.equal(view.copies.c2.bib_id, 'b1', 'a scanned ISBN reuses the known bibliographic record');
assert.equal(view.bibs[view.copies.c3.bib_id].local, true);
assert(view.places.box, 'conflicting merge is not applied');
assert.equal(view.marks.get('box'), 'conflict');
assert.equal(view.marks.get('c1'), 'pending');
pass('Local view applies queued operations optimistically and marks conflicts');

const duplicates = findDuplicates(view, { isbn13: '9784101010137', title: 'こころ' });
assert.deepEqual(duplicates.map(d => [d.copy.id, d.reason]).sort(), [['c1', 'ISBN'], ['c2', 'ISBN']]);
assert.equal(findDuplicates(view, { title: '夏の合同誌 ', creators: '月見サークル' })[0].reason, '書名');
assert.equal(findDuplicates(view, { title: '別の本' }).length, 0);
view.copies.c1.disposition = 'sold';
assert.equal(findDuplicates(view, { isbn13: '9784101010137' }).find(d => d.copy.id === 'c1').disposed, true);
pass('Duplicate detection by ISBN, normalised title and previously disposed books');

const bibs = { a: { title: 'x' }, b: { title: 'x' } };
const order = [{ volume_sort: 2, volume_label: '2', bib_id: 'a' }, { volume_sort: null, volume_label: '総集編', bib_id: 'b' }, { volume_sort: 1, volume_label: '1', bib_id: 'a' }]
  .sort((x, y) => compareVolumes(x, y, bibs)).map(c => c.volume_label);
assert.deepEqual(order, ['1', '2', '総集編']);
pass('Volumes sort numerically with unnumbered volumes last');

console.log(`\n${checks} checks passed.`);
