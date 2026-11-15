// Direct tests of Code.gs through the mock. Run: node test/backend.test.js
const vm = require('vm'), assert = require('assert');
const { load } = require('./mock-backend');
const sb = load();
const key = sb.props.KEY;
const call = (action, extra = {}, k = key) => { sb.__e = { postData: { contents: JSON.stringify({ key: k, action, ...extra }) } }; return JSON.parse(vm.runInContext('doPost(__e)', sb).text); };
const item = (sku, name, extra = {}) => ({ id: 'i' + sku, kind: 'item', item: { sku, name, cat: 'Cars', price: 99.5, min: 2, active: true, ...extra } });
const move = (id, sku, dir, qty, reason, extra = {}) => ({ id: 'q' + id, kind: 'move', move: { id, date: '2026-11-15', sku, dir, qty, reason, ref: '', note: '', ...extra } });

assert.equal(call('ping', {}, 'nope').ok, false); assert.equal(call('ping', {}, 'nope').auth, true);
assert.equal(call('ping').ok, true);
assert.ok(sb.sheets.find(s => s.name === 'Items').formulas['2,7'].startsWith('=ARRAYFORMULA'), 'On hand formula');
assert.equal(sb.sheets.find(s => s.name === 'Sheet1'), undefined, 'default tab removed');

// 1. add items + moves in one batch, results per entry
let r = call('add', { have: { rows: 0, lastId: '' }, entries: [
  item('T0001', 'Hot Wheels Mix'), item('T0002', 'Plush Bear', { cat: 'Plush', price: null, min: null }),
  move('m1', 'T0001', 'In', 10, 'Opening'), move('m2', 'T0001', 'Out', 3, 'Sale'), move('m3', 'T0009', 'In', 1, 'Restock'),
  move('m4', 'T0001', 'In', 1, 'Sale'), move('m5', 'T0001', 'In', 0, 'Restock'), move('m6', 'T0001', 'In', 1, 'Restock', { date: '2026-02-30' }),
  item('T0003', 'plush  BEAR!'), { ...item('T0001', 'Other name'), id: 'dupsku' },
] }).data;
const byId = Object.fromEntries(r.results.map(x => [x.id, x]));
assert.ok(byId.iT0001.ok && byId.iT0002.ok && byId.qm1.ok && byId.qm2.ok);
assert.match(byId.qm3.error, /Unknown item/); assert.match(byId.qm4.error, /cannot be recorded as In/);
assert.match(byId.qm5.error, /Qty/); assert.match(byId.qm6.error, /Date/);
assert.match(byId.iT0003.error, /already exists/); assert.match(byId.dupsku.error, /already belongs/);
assert.equal(r.sync.items.length, 2); assert.equal(r.sync.moves.length, 2); assert.equal(r.sync.rows, 2); assert.equal(r.sync.reset, true);

// 2. idempotent retry (lost response)
r = call('add', { have: { rows: 2, lastId: 'm2' }, entries: [item('T0001', 'Hot Wheels Mix'), move('m1', 'T0001', 'In', 10, 'Opening'), move('m2', 'T0001', 'Out', 3, 'Sale')] }).data;
assert.ok(r.results.every(x => x.ok)); assert.equal(r.sync.rows, 2); assert.equal(r.sync.moves.length, 0); assert.equal(r.sync.reset, false);

// 3. incremental sync and reset detection
r = call('add', { have: { rows: 2, lastId: 'm2' }, entries: [move('m7', 'T0002', 'In', 5, 'Restock', { note: '=SUM(1)' })] }).data;
assert.equal(r.sync.moves.length, 1); assert.equal(r.sync.moves[0].id, 'm7'); assert.equal(r.sync.moves[0].note, '=SUM(1)');
assert.equal(call('sync', { have: { rows: 3, lastId: 'WRONG' } }).data.reset, true);
assert.equal(call('sync', { have: { rows: 3, lastId: 'm7' } }).data.moves.length, 0);
assert.equal(call('sync', { have: { rows: 99, lastId: 'm7' } }).data.reset, true);

// 4. edits: name, price, archive, and name clash
r = call('add', { have: { rows: 3, lastId: 'm7' }, entries: [
  { id: 'e1', kind: 'edit', sku: 'T0002', patch: { name: 'Plush Bear Large', price: 250 } },
  { id: 'e2', kind: 'edit', sku: 'T0001', patch: { name: 'plush bear large' } },
  { id: 'e3', kind: 'edit', sku: 'T0001', patch: { active: false } },
  { id: 'e4', kind: 'edit', sku: 'T9999', patch: { price: 1 } },
  item('T0005', 'Blocks Set'), { id: 'e5', kind: 'edit', sku: 'T0005', patch: { price: 12, cat: 'Blocks' } },
] }).data;
const e = Object.fromEntries(r.results.map(x => [x.id, x]));
assert.ok(e.e1.ok && !e.e2.ok && e.e3.ok && !e.e4.ok && e.e5.ok);
const items = Object.fromEntries(r.sync.items.map(i => [i.sku, i]));
assert.equal(items.T0002.name, 'Plush Bear Large'); assert.equal(items.T0002.price, 250); assert.equal(items.T0001.active, false);
assert.equal(items.T0005.price, 12); assert.equal(items.T0005.cat, 'Blocks'); assert.equal(items.T0001.name, 'Hot Wheels Mix');

// 5. item name snapshot on movement rows stays the name at the time of the move
r = call('sync', { have: { rows: 0 } }).data; assert.equal(r.moves.length, 3);

// 6. SKU collision between two phones: auto SKU is renumbered, dependents follow, wrong toy never credited
r = call('add', { have: { rows: 3, lastId: 'm7' }, entries: [
  { ...item('T0001', 'Dino Figure'), auto: true }, move('d1', 'T0001', 'In', 4, 'Opening'), { id: 'ed1', kind: 'edit', sku: 'T0001', patch: { price: 77 } },
] }).data;
const renum = r.results[0]; assert.ok(renum.ok && renum.from === 'T0001' && /^T\d{4}$/.test(renum.sku) && renum.sku !== 'T0001', 'renumbered: ' + JSON.stringify(renum));
assert.ok(r.results[1].ok && r.results[2].ok);
const dino = r.sync.items.find(i => i.name === 'Dino Figure'); assert.equal(dino.sku, renum.sku); assert.equal(dino.price, 77);
assert.equal(r.sync.items.find(i => i.sku === 'T0001').name, 'Hot Wheels Mix', 'original toy untouched');
const d1 = r.sync.moves.find(m => m.id === 'd1'); assert.equal(d1.sku, renum.sku); assert.equal(d1.item, undefined);
// 7. refused toy blocks its dependents in the same batch, but not other toys
r = call('add', { have: { rows: r.sync.rows, lastId: 'd1' }, entries: [
  { ...item('T0777', 'Dino Figure'), auto: true, id: 'dupname' }, move('x1', 'T0777', 'In', 2, 'Opening'), move('x2', 'T0002', 'In', 1, 'Restock'),
] }).data;
const z = Object.fromEntries(r.results.map(x => [x.id, x]));
assert.match(z.dupname.error, /already exists/); assert.match(z.qx1.error, /refused/); assert.ok(z.qx2.ok);
assert.ok(!r.sync.moves.some(m => m.id === 'x1'));
// 8. retry of the renumbered batch (response was lost): same result, nothing duplicated
const before = call('sync', { have: { rows: 0 } }).data;
r = call('add', { have: { rows: before.rows, lastId: before.lastId }, entries: [
  { ...item('T0001', 'Dino Figure'), auto: true }, move('d1', 'T0001', 'In', 4, 'Opening'),
] }).data;
assert.ok(r.results.every(x => x.ok)); assert.equal(r.results[0].sku, renum.sku);
assert.equal(r.sync.rows, before.rows, 'no duplicate movement'); assert.equal(r.sync.items.length, before.items.length, 'no duplicate item');
console.log('backend tests passed');
