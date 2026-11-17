// Direct tests of Code.gs through the mock. Run: node test/backend.test.js
const vm = require('vm'), assert = require('assert');
const { load } = require('./mock-backend');
// A fresh sheet with its own key; c() calls doPost like the app, full() is a sync of everything, add() posts entries on top of it.
function bench() {
  const b = load(), k = b.props.KEY;
  const c = (action, extra = {}, kk = k) => { b.__e = { postData: { contents: JSON.stringify({ key: kk, action, ...extra }) } }; return JSON.parse(vm.runInContext('doPost(__e)', b).text); };
  const full = () => c('sync', { have: { rows: 0 } }).data;
  const add = entries => { const s = full(); return c('add', { have: { rows: s.rows, lastId: s.lastId, moveRev: s.moveRev }, entries }).data; };
  return { b, c, full, add, sheet: n => b.sheets.find(x => x.name === n) };
}
const A = bench(), call = A.c, { sheet, add, full } = A;
const res = d => Object.fromEntries(d.results.map(x => [x.id, x]));
const item = (sku, name, extra = {}) => ({ id: 'i' + sku, kind: 'item', item: { sku, name, price: 99.5, active: true, ...extra } });
const move = (id, sku, dir, qty, reason, extra = {}) => ({ id: 'q' + id, kind: 'move', move: { id, date: '2026-11-15', sku, dir, qty, reason, ref: '', note: '', ...extra } });

assert.equal(call('ping', {}, 'nope').ok, false); assert.equal(call('ping', {}, 'nope').auth, true);
assert.equal(call('ping').ok, true);
assert.equal(sheet('Sheet1'), undefined, 'default tab removed');

// 1. add items + moves in one batch, results per entry
let r = call('add', { have: { rows: 0, lastId: '' }, entries: [
  item('T0001', 'Hot Wheels Mix'), item('T0002', 'Plush Bear', { price: null }),
  move('m1', 'T0001', 'In', 10, 'Opening'), move('m2', 'T0001', 'Out', 3, 'Sale'), move('m3', 'T0009', 'In', 1, 'Restock'),
  move('m4', 'T0001', 'In', 1, 'Sale'), move('m5', 'T0001', 'In', 0, 'Restock'), move('m6', 'T0001', 'In', 1, 'Restock', { date: '2026-02-30' }),
  item('T0003', 'plush  BEAR!'), { ...item('T0001', 'Other name'), id: 'dupsku' },
] }).data;
const byId = res(r);
assert.ok(byId.iT0001.ok && byId.iT0002.ok && byId.qm1.ok && byId.qm2.ok);
assert.match(byId.qm3.error, /Unknown product/); assert.match(byId.qm4.error, /cannot be recorded as In/);
assert.match(byId.qm5.error, /Qty/); assert.match(byId.qm6.error, /Date/);
assert.match(byId.iT0003.error, /already exists/); assert.match(byId.dupsku.error, /already belongs/);
assert.equal(r.sync.items.length, 2); assert.equal(r.sync.moves.length, 2); assert.equal(r.sync.rows, 2); assert.equal(r.sync.reset, true);

// 2. idempotent retry (lost response)
r = call('add', { have: { rows: 2, lastId: 'm2', moveRev: 0 }, entries: [item('T0001', 'Hot Wheels Mix'), move('m1', 'T0001', 'In', 10, 'Opening'), move('m2', 'T0001', 'Out', 3, 'Sale')] }).data;
assert.ok(r.results.every(x => x.ok)); assert.equal(r.sync.rows, 2); assert.equal(r.sync.moves.length, 0); assert.equal(r.sync.reset, false);

// 3. incremental sync and reset detection
r = call('add', { have: { rows: 2, lastId: 'm2', moveRev: 0 }, entries: [move('m7', 'T0002', 'In', 5, 'Restock', { note: '=SUM(1)' })] }).data;
assert.equal(r.sync.moves.length, 1); assert.equal(r.sync.moves[0].id, 'm7'); assert.equal(r.sync.moves[0].note, '=SUM(1)');
assert.equal(call('sync', { have: { rows: 3, lastId: 'WRONG', moveRev: 0 } }).data.reset, true);
assert.equal(call('sync', { have: { rows: 3, lastId: 'm7', moveRev: 0 } }).data.moves.length, 0);
assert.equal(call('sync', { have: { rows: 99, lastId: 'm7', moveRev: 0 } }).data.reset, true);
assert.equal(call('sync', { have: { rows: 3, lastId: 'm7' } }).data.moveRev, 0, 'every snapshot carries moveRev');
assert.deepEqual([call('sync', { have: { rows: 3, lastId: 'm7' } }).data.reset, call('sync', { have: { rows: 3, lastId: 'm7', moveRev: 7 } }).data.moves.length], [true, 3], 'a missing or different moveRev sends every movement');

// 4. edits: name, price, archive, and name clash
r = call('add', { have: { rows: 3, lastId: 'm7' }, entries: [
  { id: 'e1', kind: 'edit', sku: 'T0002', patch: { name: 'Plush Bear Large', price: 250 } },
  { id: 'e2', kind: 'edit', sku: 'T0001', patch: { name: 'plush bear large' } },
  { id: 'e3', kind: 'edit', sku: 'T0001', patch: { active: false } },
  { id: 'e4', kind: 'edit', sku: 'T9999', patch: { price: 1 } },
  item('T0005', 'Blocks Set'), { id: 'e5', kind: 'edit', sku: 'T0005', patch: { price: 12, brand: 'Blocks' } },
] }).data;
const e = res(r);
assert.ok(e.e1.ok && !e.e2.ok && e.e3.ok && !e.e4.ok && e.e5.ok);
const items = Object.fromEntries(r.sync.items.map(i => [i.sku, i]));
assert.equal(items.T0002.name, 'Plush Bear Large'); assert.equal(items.T0002.price, 250); assert.equal(items.T0001.active, false);
assert.equal(items.T0005.price, 12); assert.equal(items.T0005.brand, 'Blocks'); assert.equal(items.T0001.name, 'Hot Wheels Mix');

// 5. item name snapshot on movement rows stays the name at the time of the move
r = full(); assert.equal(r.moves.length, 3);

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
const z = res(r);
assert.match(z.dupname.error, /already exists/); assert.match(z.qx1.error, /refused/); assert.ok(z.qx2.ok);
assert.ok(!r.sync.moves.some(m => m.id === 'x1'));
// 8. retry of the renumbered batch (response was lost): same result, nothing duplicated
const before = full();
r = call('add', { have: { rows: before.rows, lastId: before.lastId }, entries: [
  { ...item('T0001', 'Dino Figure'), auto: true }, move('d1', 'T0001', 'In', 4, 'Opening'),
] }).data;
assert.ok(r.results.every(x => x.ok)); assert.equal(r.results[0].sku, renum.sku);
assert.equal(r.sync.rows, before.rows, 'no duplicate movement'); assert.equal(r.sync.items.length, before.items.length, 'no duplicate item');

// ---------- v2: toy details, receipt cost, customers, supplier orders, pre-orders, invoices, returns ----------
['Customers', 'Suppliers', 'Supplier orders', 'Invoices', 'Invoice lines', 'Returns'].forEach(n => assert.ok(sheet(n), n + ' tab exists'));

// 9. item details: stored, patched, validated; On hand is a written number
r = add([
  item('T0100', 'Grandista Son Goku', { price: 1800, mfr: 'Bandai Spirits', brand: 'Banpresto', line: 'Grandista', chr: 'Son Goku', rel: '2019-06', relCheck: true }),
  { ...item('T0101', 'Bad Release', { rel: 'June 2019' }), id: 'badrel' },
  { id: 'ed9', kind: 'edit', sku: 'T0100', patch: { rel: '2019-06-20', relCheck: false, chr: 'Goku' } },
  { id: 'ed10', kind: 'edit', sku: 'T0002', patch: { brand: '=Brand' } },
]);
let z9 = res(r);
assert.ok(z9.iT0100.ok && z9.ed9.ok && z9.ed10.ok); assert.match(z9.badrel.error, /Release date/);
let goku = r.sync.items.find(i => i.sku === 'T0100');
assert.deepEqual([goku.mfr, goku.brand, goku.line, goku.chr, goku.rel, goku.relCheck], ['Bandai Spirits', 'Banpresto', 'Grandista', 'Goku', '2019-06-20', false]);
assert.equal(r.sync.items.find(i => i.sku === 'T0002').brand, '=Brand', 'detail text is stored as typed');
for (let row = 2; row <= sheet('Products').getLastRow(); row++) assert.equal(typeof sheet('Products').cell(row, 5), 'number', 'On hand is a number on row ' + row);

// 10. cost on a receipt movement
r = add([move('c1', 'T0100', 'In', 4, 'Restock', { cost: 1200 }), move('c2', 'T0100', 'In', 1, 'Restock', { cost: -5 })]);
assert.ok(res(r).qc1.ok); assert.match(res(r).qc2.error, /Unit cost/);
assert.equal(full().moves.find(m => m.id === 'c1').cost, 1200);
assert.equal(full().moves.find(m => m.id === 'm1').cost, null);

// 11. customers: created, updated, contact kept as text
r = add([{ id: 'k1', kind: 'cust', cust: { id: 'c-ana', name: 'Ana Reyes', contact: '+63 917 000 0000' } }, { id: 'k2', kind: 'cust', cust: { id: 'c-ben', name: 'Ben Cruz', contact: '' } }, { id: 'k3', kind: 'cust', cust: { id: 'c-x', name: ' ' } }]);
assert.ok(res(r).k1.ok && res(r).k2.ok); assert.match(res(r).k3.error, /name is required/);
assert.equal(r.sync.custs.find(c => c.id === 'c-ana').contact, '+63 917 000 0000');
r = add([{ id: 'k4', kind: 'cust', cust: { id: 'c-ana', name: 'Ana Reyes', contact: 'm.me/ana' } }]);
assert.equal(r.sync.custs.length, 2); assert.equal(r.sync.custs.find(c => c.id === 'c-ana').contact, 'm.me/ana');

// 12. suppliers; supplier orders as one row per line, no stock until a line is received, in parts (Ref = order ID), retry safe
r = add([{ id: 'su1', kind: 'supplier', supplier: { id: 'sup-a', name: 'Toy Hub', contact: '+63 2 000', note: '=net 30' } }, { id: 'su2', kind: 'supplier', supplier: { id: 'sup-b', name: ' ' } }]);
assert.ok(res(r).su1.ok); assert.match(res(r).su2.error, /name is required/);
assert.deepEqual(r.sync.sups, [{ id: 'sup-a', name: 'Toy Hub', contact: '+63 2 000', note: '=net 30' }]);
const order = (id, lines, extra = {}) => ({ id: 'o' + id, kind: 'order', order: { id, date: '2026-11-10', supId: 'sup-a', expected: '2026-12-01', note: '', lines, ...extra } });
let rowsBefore = full().rows;
r = add([order('so1', [{ id: 'sl1', sku: 'T0100', qty: 6, cost: 1300 }, { id: 'sl2', sku: 'T0100', qty: 2, cost: null }]), order('so3', [{ id: 'sl3', sku: 'T0100', qty: 1 }, { id: 'sl4', sku: 'T9999', qty: 1 }]),
  order('so5', [{ id: 'sl5', sku: 'T0100', qty: 1 }], { expected: 'soon' }), order('so6', [{ id: 'sl6', sku: 'T0100', qty: 1 }], { supId: 'nobody' })]);
assert.ok(res(r).oso1.ok); assert.match(res(r).oso3.error, /Unknown product/); assert.match(res(r).oso5.error, /Expected arrival/); assert.match(res(r).oso6.error, /Unknown supplier/);
assert.deepEqual(r.sync.orders.map(o => [o.id, o.orderId, o.supId, o.sup, o.sku, o.qty, o.cost, o.expected, o.recQty, o.status]),
  [['sl1', 'so1', 'sup-a', 'Toy Hub', 'T0100', 6, 1300, '2026-12-01', 0, 'Ordered'], ['sl2', 'so1', 'sup-a', 'Toy Hub', 'T0100', 2, null, '2026-12-01', 0, 'Ordered']], 'a bad line refuses its whole order');
assert.equal(full().rows, rowsBefore, 'an order moves no stock');
const rcv = (id, lineId, from, costs) => ({ id, kind: 'receive', lineId, date: '2026-11-14', from, costs });
r = add([rcv('rc0', 'sl1', 0, [1300, -5]), rcv('rc1', 'sl1', 0, [1300, 1300, 1250]), rcv('rc2', 'sl1', 3, [5, 5, 5, 5])]);
assert.match(res(r).rc0.error, /Unit cost/, 'one bad cost refuses the whole receipt'); assert.ok(res(r).rc1.ok);
assert.match(res(r).rc2.error, /Only 3 of Grandista Son Goku are still due/);
assert.deepEqual(full().orders.map(o => [o.id, o.recQty, o.status]), [['sl1', 3, 'Ordered'], ['sl2', 0, 'Ordered']], 'a short line stays open for the rest');
r = add([rcv('rc1', 'sl1', 0, [1300, 1300, 1250]), rcv('rc3', 'sl1', 3, [null, 1300, 1300]), rcv('rc3', 'sl1', 3, [null, 1300, 1300]), order('so1', [{ id: 'sl1', sku: 'T0100', qty: 6 }])]);
assert.ok(r.results.every(x => x.ok), 'the first part again, then the rest twice, then the order again');
assert.deepEqual(full().moves.filter(m => m.ref === 'so1').map(m => [m.id, m.sku, m.dir, m.qty, m.reason, m.cost, m.unit]), [1300, 1300, 1250, null, 1300, 1300].map((c, k) => ['rcv-sl1-' + (k + 1), 'T0100', 'In', 1, 'Restock', c, 'T0100-' + (k + 5)]), 'one row per unit, each with its cost; blank allowed; each unit gets the next SKU after the 4 units of c1');
assert.equal(full().rows, rowsBefore + 6, 'each unit written once');
// orderCancel closes the rest of a line, keeps what was received, and refuses a received line; a new receive on it is refused, a retry is not
r = add([rcv('rc4', 'sl2', 0, [700]), { id: 'oc2', kind: 'orderCancel', lineId: 'sl2' }, { id: 'oc2', kind: 'orderCancel', lineId: 'sl2' }, rcv('rc4', 'sl2', 0, [700]), rcv('rc5', 'sl2', 1, [700]), { id: 'oc3', kind: 'orderCancel', lineId: 'sl1' }]);
assert.ok(res(r).rc4.ok && res(r).oc2.ok); assert.match(res(r).rc5.error, /cancelled/); assert.match(res(r).oc3.error, /already received/);
assert.deepEqual(full().orders.map(o => [o.id, o.recQty, o.status]), [['sl1', 6, 'Received'], ['sl2', 1, 'Cancelled']]);
assert.equal(full().rows, rowsBefore + 7);

// 13. a mixed invoice: the Delivered line leaves stock, the to-follow line is owed with no movement and no cost; Paid and Balance
const invoice = (id, no, lines, extra = {}) => ({ id: 'v' + id, kind: 'invoice', invoice: { id, no, date: '2026-11-15', custId: 'c-ben', lines, ...extra } });
const brow = sku => sheet('Browse').rowsOf().find(x => x[0] === sku).slice(4, 8);
r = add([order('so7', [{ id: 'sl7', sku: 'T0005', qty: 3, cost: 8 }]),
  invoice('inv1', 1, [{ sku: 'T0100', qty: 1, price: 1700, cost: 1200 }, { sku: 'T0005', qty: 2, price: 500, cost: 9, follow: true, expected: '2026-12-01', orderLine: 'sl7' }], { custId: 'c-ana', paid: 2000 }),
  invoice('inv1b', 1, [{ sku: 'T0005', qty: 1, price: 500, follow: true }]), invoice('inv1c', 1, [{ sku: 'T0100', qty: 1, price: 1700 }], { paid: 1701 }),
  invoice('inv1d', 1, [{ sku: 'T0005', qty: 1, price: 500, follow: true, orderLine: 'nope' }], { custId: 'c-ana' })]);
let z13 = res(r);
assert.deepEqual([z13.vinv1.ok, z13.vinv1.no], [true, 1]); assert.match(z13.vinv1b.error, /to-follow line needs the customer's phone or Messenger/);
assert.match(z13.vinv1c.error, /more than the total/); assert.match(z13.vinv1d.error, /Unknown supplier order line/);
let inv1 = r.sync.invs.find(i => i.id === 'inv1');
assert.deepEqual([inv1.cust, inv1.contact, inv1.total, inv1.paid, inv1.balance, inv1.ship], ['Ana Reyes', 'm.me/ana', 2700, 2000, 700, '']);
assert.deepEqual(inv1.lines, [{ line: 1, sku: 'T0100', name: 'Grandista Son Goku', qty: 1, list: 1800, price: 1700, cost: 1200, status: 'Delivered', expected: '', orderLine: '', delivered: '2026-11-15' },
  { line: 2, sku: 'T0005', name: 'Blocks Set', qty: 2, list: 12, price: 500, cost: null, status: 'To follow', expected: '2026-12-01', orderLine: 'sl7', delivered: '' }]);
assert.deepEqual([sheet('Invoices').rowsOf().find(x => x[1] === 'inv1').slice(0, 10), sheet('Invoice lines').rowsOf().filter(x => x[1] === 'inv1').map(x => x.slice(0, 13))],
  [[1, 'inv1', '2026-11-15', 'c-ana', 'Ana Reyes', 'm.me/ana', 2700, 2000, 700, ''], [[1, 'inv1', 1, 'T0100', 'Grandista Son Goku', 1, 1800, 1700, 1200, 'Delivered', '', '', '2026-11-15'], [1, 'inv1', 2, 'T0005', 'Blocks Set', 2, 12, 500, '', 'To follow', '2026-12-01', 'sl7', '']]], 'the rows in the 2.5 layout');
assert.deepEqual(full().moves.filter(m => m.ref === '1').map(m => [m.id, m.sku, m.qty, m.reason, m.cost]), [['inv1-1', 'T0100', 1, 'Sale', 1200]], 'only the Delivered line leaves stock');
assert.deepEqual(brow('T0005'), [0, 3, 2, 1], 'on hand, incoming, owed (the to-follow line), left to promise');

// 14. sale invoice: sequential number, Out/Sale movement per line with Ref = number, price override, number clash renumbered
r = add([invoice('inv2', 2, [{ sku: 'T0100', qty: 1, price: 1500, cost: 1255.56 }, { sku: 'T0002', qty: 2, price: 250 }]), invoice('inv3', 2, [{ sku: 'T0002', qty: 1, price: 0 }]), invoice('inv4', 9, []), invoice('inv5', 9, [{ sku: 'T0002', qty: 1 }])]);
let z14 = res(r);
assert.deepEqual([z14.vinv2.ok, z14.vinv2.no, z14.vinv2.fromNo], [true, 2, undefined]);
assert.deepEqual([z14.vinv3.ok, z14.vinv3.no, z14.vinv3.fromNo], [true, 3, 2], 'a taken number moves to the next free one');
assert.match(z14.vinv4.error, /at least one product/); assert.match(z14.vinv5.error, /Price/);
let inv2 = r.sync.invs.find(i => i.id === 'inv2');
assert.deepEqual([inv2.cust, inv2.total, inv2.paid, inv2.balance, inv2.ship], ['Ben Cruz', 2000, 2000, 0, ''], 'paid blank means paid in full');
assert.deepEqual(inv2.lines.map(l => [l.line, l.sku, l.qty, l.list, l.price, l.cost, l.status]), [[1, 'T0100', 1, 1800, 1500, 1255.56, 'Delivered'], [2, 'T0002', 2, 250, 250, null, 'Delivered']]);
let sale = full().moves.filter(m => m.ref === '2');
assert.deepEqual(sale.map(m => [m.id, m.sku, m.dir, m.qty, m.reason, m.cost]), [['inv2-1', 'T0100', 'Out', 1, 'Sale', 1255.56], ['inv2-2', 'T0002', 'Out', 2, 'Sale', null]]);
rowsBefore = full().rows;
r = add([invoice('inv2', 2, [{ sku: 'T0100', qty: 1, price: 1500 }])]);
assert.ok(r.results[0].ok && r.results[0].no === 2); assert.equal(full().rows, rowsBefore, 'retrying an invoice adds nothing'); assert.equal(full().invs.length, 3);

// 15. deliver ships a to-follow line under its invoice (Sale <invId>-<line>); pay; follow; lineCancel with a refund; the batch again changes nothing
const flow = [invoice('inv4', 4, [{ sku: 'T0005', qty: 1, price: 500, follow: true }, { sku: 'T0002', qty: 1, price: 250, follow: true, expected: '2026-12-24' }], { custId: 'c-ana', paid: 600 }),
  rcv('rc7', 'sl7', 0, [8, 9]),
  { id: 'dv1', kind: 'deliver', invId: 'inv1', line: 2, date: '2026-11-20', cost: 8.5 }, { id: 'dv2', kind: 'deliver', invId: 'inv1', line: 2, date: '2026-11-21', cost: 1 },
  { id: 'dv3', kind: 'deliver', invId: 'inv1', line: 9, date: '2026-11-21' },
  { id: 'pay1', kind: 'pay', invId: 'inv1', paid: 2700 }, { id: 'pay2', kind: 'pay', invId: 'inv1', paid: 2701 },
  { id: 'fw1', kind: 'follow', invId: 'inv4', line: 1, expected: '', orderLine: 'sl7' }, { id: 'fw2', kind: 'follow', invId: 'inv1', line: 2, expected: '2026-12-02' },
  { id: 'lc1', kind: 'lineCancel', invId: 'inv4', line: 2, refund: 100 }, { id: 'lc2', kind: 'lineCancel', invId: 'inv4', line: 1, refund: 501 }, { id: 'lc3', kind: 'lineCancel', invId: 'inv1', line: 1, refund: 0 }];
const failing = ['dv3', 'pay2', 'fw2', 'lc2', 'lc3'];
r = add(flow);
let z15 = res(r);
assert.deepEqual(r.results.map(x => x.ok), flow.map(x => !failing.includes(x.id)), JSON.stringify(r.results));
assert.match(z15.dv3.error, /Unknown invoice line/); assert.match(z15.pay2.error, /more than the total/); assert.match(z15.fw2.error, /Only a to-follow line/);
assert.match(z15.lc2.error, /refund is more than what was paid/); assert.match(z15.lc3.error, /already delivered/);
assert.deepEqual(full().moves.filter(m => m.ref === '1').map(m => [m.id, m.date, m.sku, m.qty, m.reason, m.cost]), [['inv1-1', '2026-11-15', 'T0100', 1, 'Sale', 1200], ['inv1-2', '2026-11-20', 'T0005', 2, 'Sale', 8.5]], 'shipped once, under the same invoice number');
const invsNow = () => Object.fromEntries(full().invs.map(v => [v.id, [v.total, v.paid, v.balance, v.lines.map(l => [l.status, l.cost, l.expected, l.orderLine, l.delivered])]]));
assert.deepEqual([invsNow().inv1, invsNow().inv4], [
  [2700, 2700, 0, [['Delivered', 1200, '', '', '2026-11-15'], ['Delivered', 8.5, '2026-12-01', 'sl7', '2026-11-20']]],
  [500, 500, 0, [['To follow', null, '', 'sl7', ''], ['Cancelled', null, '2026-12-24', '', '']]]], 'the cancelled line leaves the total and the refund leaves Paid');
assert.deepEqual([brow('T0005'), brow('T0002')[2]], [[0, 1, 1, 0], 0], 'owed drops as lines ship or are cancelled');
const invsBefore = invsNow(); rowsBefore = full().rows;
r = add(flow);
assert.deepEqual(r.results.map(x => x.ok), flow.map(x => !failing.includes(x.id)), 'a retry gives the same answers');
assert.deepEqual([invsNow(), full().rows], [invsBefore, rowsBefore], 'and changes nothing');

// 16. delivered mark: Delivered or blank, absolute
r = add([{ id: 's1', kind: 'ship', invId: 'inv2', ship: 'Delivered' }, { id: 's2', kind: 'ship', invId: 'inv2', ship: 'Shipped' }, { id: 's3', kind: 'ship', invId: 'inv2', ship: 'Packed' }, { id: 's4', kind: 'ship', invId: 'nope', ship: 'Delivered' }]);
assert.ok(res(r).s1.ok); assert.match(res(r).s2.error, /Shipping status/); assert.match(res(r).s3.error, /Shipping status/); assert.match(res(r).s4.error, /Unknown invoice/);
assert.equal(r.sync.invs.find(i => i.id === 'inv2').ship, 'Delivered');
r = add([{ id: 's5', kind: 'ship', invId: 'inv2', ship: '' }]); assert.ok(res(r).s5.ok); assert.equal(r.sync.invs.find(i => i.id === 'inv2').ship, '', 'the mark can be taken off');
r = add([{ id: 's6', kind: 'ship', invId: 'inv2', ship: 'Delivered' }, { id: 's6', kind: 'ship', invId: 'inv2', ship: 'Delivered' }]); assert.ok(r.results.every(x => x.ok)); assert.equal(r.sync.invs.find(i => i.id === 'inv2').ship, 'Delivered');

// 17. returns: capped at what was sold, stock effect per outcome, idempotent
const ret = (id, sku, qty, outcome, extra = {}) => ({ id: 'r' + id, kind: 'ret', ret: { id, date: '2026-11-16', invId: 'inv2', sku, qty, outcome, refund: 100, note: '', ...extra } });
rowsBefore = full().rows;
r = add([ret('rt1', 'T0002', 1, 'Restock'), ret('rt2', 'T0002', 2, 'Write-off'), ret('rt3', 'T0002', 1, 'Write-off', { refund: '' }), ret('rt4', 'T0005', 1, 'Restock'), ret('rt5', 'T0100', 1, 'Burn'), ret('rt6', 'T0100', 1, 'Exchange'), ret('rt9', 'T0100', 1, 'Restock'), ret('rt7', 'T0005', 1, 'Restock', { invId: 'inv4' })]);
let z17 = res(r);
assert.ok(z17.rrt1.ok && z17.rrt3.ok && z17.rrt9.ok);
assert.match(z17.rrt2.error, /Only 1 of/); assert.match(z17.rrt4.error, /was not delivered on invoice 2/); assert.match(z17.rrt5.error, /Outcome/); assert.match(z17.rrt6.error, /Outcome must be Restock or Write-off/, 'Exchange is no longer an outcome'); assert.match(z17.rrt7.error, /Blocks Set was not delivered on invoice 4/, 'only Delivered lines take a return');
let back = full().moves.filter(m => m.reason === 'Return');
assert.deepEqual(back.map(m => [m.id, m.sku, m.dir, m.qty, m.ref, m.cost]), [['ret-rt1-1', 'T0002', 'In', 1, 'rt1', null], ['ret-rt9-1', 'T0100', 'In', 1, 'rt9', 1255.56]], 'restock comes back in at the line cost, write-off does not');
assert.equal(full().rows, rowsBefore + 2);
assert.deepEqual(r.sync.rets.map(x => [x.id, x.invNo, x.cust, x.outcome, x.refund]), [['rt1', 2, 'Ben Cruz', 'Restock', 100], ['rt3', 2, 'Ben Cruz', 'Write-off', 0], ['rt9', 2, 'Ben Cruz', 'Restock', 100]]);
r = add([ret('rt1', 'T0002', 1, 'Restock'), ret('rt8', 'T0002', 1, 'Restock')]);
assert.ok(res(r).rrt1.ok); assert.match(res(r).rrt8.error, /Only 0 of/); assert.equal(full().rows, rowsBefore + 2);

// 18. a renumbered toy carries its documents with it; a refused toy blocks them
r = add([{ ...item('T0001', 'Gigo Luffy'), auto: true }, order('so9', [{ id: 'sl9', sku: 'T0001', qty: 3 }]), invoice('inv9', 20, [{ sku: 'T0001', qty: 1, price: 900 }]),
  { ...item('T0888', 'Gigo Luffy'), id: 'dupname2' }, order('so10', [{ id: 'sl10', sku: 'T0888', qty: 1 }])]);
let z18 = res(r), luffy = z18.iT0001.sku;
assert.ok(luffy && luffy !== 'T0001' && z18.oso9.ok && z18.vinv9.ok);
assert.equal(r.sync.orders.find(o => o.id === 'sl9').sku, luffy); assert.equal(r.sync.invs.find(i => i.id === 'inv9').lines[0].sku, luffy);
assert.equal(full().moves.find(m => m.id === 'inv9-1').sku, luffy);
assert.match(z18.dupname2.error, /already exists/); assert.match(z18.oso10.error, /refused/);

// 19. Inbox: rows Claude appends in the sheet show up as waiting, the app marks them Done or Dismissed
const ib = sheet('Inbox');
assert.ok(ib, 'setup creates the Inbox tab');
assert.deepEqual(ib.getRange(1, 1, 1, 13).getValues()[0], ['Added', 'Type', 'Name', 'Qty', 'Cost each', 'Manufacturer', 'Brand', 'Toy line', 'Character', 'Release date', 'Verify', 'Note', 'Status']);
assert.deepEqual(full().inbox, [], 'an empty Inbox sends nothing');
const putRow = (row, vals) => vals.forEach((v, j) => ib.set(row, j + 1, v));
putRow(2, ['2026-11-15', 'Count', 'Grandista Son Goku', '3', '', 'Bandai Spirits', 'Banpresto', 'Grandista', 'Son Goku', '2019-06', 'Y', '=back row hidden', '']);
putRow(3, ['2026-11-15', 'Receive', 'Gigo Zoro', '2', '900', '', 'Gigo', '', '', '', '', '', '']);
putRow(4, ['2026-11-15', 'count', 'Already Done', '1', '', '', '', '', '', '', '', '', 'Done']);
putRow(5, ['2026-11-15', 'Count', '', '4', '', '', '', '', '', '', '', 'no name', '']);
putRow(6, ['', 'receive', 'No Date Toy', '1', '50', '', '', '', '', '', '', '', '']);
let inbox = full().inbox;
assert.deepEqual(inbox.map(x => [x.row, x.type, x.name]), [[2, 'count', 'Grandista Son Goku'], [3, 'receive', 'Gigo Zoro'], [6, 'receive', 'No Date Toy']], 'waiting rows only: a name and no status; a blank Added still shows');
assert.deepEqual(inbox[0], { row: 2, added: '2026-11-15', type: 'count', name: 'Grandista Son Goku', qty: '3', cost: '', mfr: 'Bandai Spirits', brand: 'Banpresto', line: 'Grandista', chr: 'Son Goku', rel: '2019-06', verify: 'Y', note: '=back row hidden' });
assert.deepEqual([inbox[1].qty, inbox[1].cost, inbox[1].brand], ['2', '900', 'Gigo']); assert.equal(inbox[2].added, '');
rowsBefore = full().rows;
r = add([{ id: 'ib1', kind: 'inboxDone', rows: [{ row: 2, name: 'grandista son goku' }, { row: 3, name: 'Gigo Zoro' }], mark: 'Done' },
  { id: 'ib2', kind: 'inboxDone', rows: [{ row: 6, name: 'Someone Else' }, { row: 99, name: 'Far Away' }, { row: 1, name: 'Name' }, { row: 'x', name: 'Bad' }], mark: 'Dismissed' }]);
assert.ok(res(r).ib1.ok && res(r).ib2.ok);
assert.deepEqual([ib.cell(2, 13), ib.cell(3, 13), ib.cell(6, 13), ib.cell(1, 13)], ['Done', 'Done', '', 'Status'], 'marked when the name matches; a different name or a row out of range is left alone');
assert.equal(ib.cell(99, 13), undefined); assert.equal(ib.getLastRow(), 6, 'nothing written past the last row');
assert.deepEqual(r.sync.inbox.map(x => x.row), [6], 'the reply already leaves out the handled rows');
assert.equal(full().rows, rowsBefore, 'clearing Inbox rows moves no stock');
r = add([{ id: 'ib3', kind: 'inboxDone', rows: [{ row: 2, name: 'Grandista Son Goku' }], mark: 'Dismissed' }, { id: 'ib4', kind: 'inboxDone', rows: [{ row: 6, name: 'No Date Toy' }], mark: 'Dismissed' }]);
assert.ok(r.results.every(x => x.ok)); assert.deepEqual([ib.cell(2, 13), ib.cell(6, 13)], ['Done', 'Dismissed'], 'a handled row keeps its first mark; Dismissed is written');
putRow(7, ['2026-11-15', 'Count', 'Mark Test', '1', '', '', '', '', '', '', '', '', '']);
r = add([{ id: 'ib4', kind: 'inboxDone', rows: [{ row: 6, name: 'No Date Toy' }], mark: 'Dismissed' }, { id: 'ib5', kind: 'inboxDone', rows: [{ row: 7, name: 'Mark Test' }], mark: 'Weird' }]);
assert.ok(r.results.every(x => x.ok)); assert.equal(ib.cell(6, 13), 'Dismissed', 'retrying is harmless'); assert.equal(ib.cell(7, 13), 'Done', 'an unknown mark becomes Done');
assert.deepEqual(r.sync.inbox, []);

// 20. nothing internal leaks, and unknown kinds are refused
assert.ok(!JSON.stringify(full()).includes('"_row"') && !JSON.stringify(full()).includes('"_dirty"'));
assert.match(add([{ id: 'u1', kind: 'nuke' }]).results[0].error, /Unknown entry type/);
// ---------- 2.2: writes find rows by key, On hand is a number, Browse, Edits, warnings ----------
const edit = (id, sku, patch) => ({ id, kind: 'edit', sku, patch });
const MSG = (tab, key, what) => `The ${tab} tab was changed in Google Sheets (${key} ${what}). Nothing was written for this entry; fix the tab and sync again.`;
const W = bench();
const names = () => Object.fromEntries(W.sheet('Products').rowsOf().map(r => [r[0], r[1]]));
const G = () => Object.fromEntries(W.sheet('Products').rowsOf().map(r => [r[0], r[4]]));
r = W.add(['A', 'B', 'C', 'D', 'E', 'F'].map((x, i) => item('S' + i, 'Item ' + x)).concat([move('o1', 'S0', 'In', 5, 'Opening'), move('o2', 'S1', 'In', 2, 'Opening'), move('o3', 'S2', 'In', 7, 'Opening')]));
assert.ok(r.results.every(x => x.ok)); assert.deepEqual(r.warnings, []); assert.deepEqual(r.sync.warnings, []);

// (a) the owner sorts Products between two requests: an edit still lands on its Product ID
W.sheet('Products').putRows(W.sheet('Products').rowsOf().reverse());
let want = names();
r = W.add([edit('a1', 'S2', { name: 'Item C renamed', price: 5 }), edit('a2', 's4', { brand: 'Lower' })]);
assert.ok(r.results.every(x => x.ok)); want.S2 = 'Item C renamed';
assert.deepEqual(names(), want, 'every row keeps its own item');
let rowS2 = W.sheet('Products').rowsOf().find(x => x[0] === 'S2'), rowS4 = W.sheet('Products').rowsOf().find(x => x[0] === 'S4');
assert.deepEqual([rowS2[1], rowS2[2], rowS2[4], rowS4[1], rowS4[6]], ['Item C renamed', 5, 7, 'Item E', 'Lower'], 'whole row written on the right SKU, SKU matched without case');

// (b) rows move between the read and the write inside one request
let fired = 0;
W.b.ss.onSetValues = sh => { if (sh.name === 'Products' && !fired++) { const rows = sh.rowsOf(); sh.putRows([rows[3], rows[0], rows[5], rows[1], rows[4], rows[2]]); } };
const writesBefore = W.sheet('Products').writes;
r = W.add([edit('b1', 'S0', { name: 'Item A2' }), edit('b2', 'S5', { name: 'Item F2' }), edit('b3', 'S3', { name: 'Item D2' }), move('b4', 'S5', 'In', 1, 'Restock')]);
W.b.ss.onSetValues = null;
assert.equal(fired > 0, true, 'the hook fired'); assert.ok(r.results.every(x => x.ok), JSON.stringify(r.results));
Object.assign(want, { S0: 'Item A2', S5: 'Item F2', S3: 'Item D2' });
assert.deepEqual(names(), want, 'the shuffle in the middle sends no edit to a wrong row');
assert.ok(W.sheet('Products').writes - writesBefore <= 5, 'one call per changed row, plus On hand');
assert.equal(G().S5, 1, 'On hand follows the SKU after the shuffle');
// a row deleted in the middle: that entry is refused, the others still apply (S1 is put last so it is written after the hook)
const lastFirst = (sh, key) => sh.putRows(sh.rowsOf().filter(x => x[0] !== key).concat(sh.rowsOf().filter(x => x[0] === key)));
lastFirst(W.sheet('Products'), 'S1'); fired = 0;
W.b.ss.onSetValues = sh => { if (sh.name === 'Products' && !fired++) sh.putRows(sh.rowsOf().filter(x => x[0] !== 'S1')); };
r = W.add([edit('b5', 'S0', { name: 'Item A3' }), edit('b6', 'S1', { name: 'Item B3' }), move('b7', 'S0', 'In', 2, 'Restock')]);
W.b.ss.onSetValues = null;
let rb = res(r);
assert.ok(rb.b5.ok && rb.qb7.ok); assert.equal(rb.b6.error, MSG('Products', 'S1', 'not found'));
assert.ok(!Object.values(names()).includes('Item B3'), 'the refused edit is written nowhere');
assert.equal(names().S0, 'Item A3'); assert.equal(G().S0, 7);
W.add([item('S1', 'Item B')]);   // put the deleted row back for the later cases

// (c) a duplicated Product ID is reported and refused; a missing one too; other entries in the same request apply
const items0 = W.sheet('Products').rowsOf();
W.sheet('Products').putRows(items0.concat([items0.find(x => x[0] === 'S2')]));
assert.deepEqual(W.full().warnings, ['Products: Product ID S2 appears on 2 rows. The first is used.']);
assert.equal(W.full().items.filter(i => i.sku === 'S2').length, 1, 'the app gets the first row only');
r = W.add([edit('c1', 'S2', { name: 'Item C again' }), edit('c2', 'S3', { price: 9 }), move('c3', 'S2', 'In', 1, 'Restock')]);
let rc = res(r);
assert.equal(rc.c1.error, MSG('Products', 'S2', 'appears twice')); assert.ok(rc.c2.ok && rc.qc3.ok);
assert.deepEqual(r.warnings, ['Products: Product ID S2 appears on 2 rows. The first is used.'], 'add carries the warning too');
assert.equal(W.sheet('Products').rowsOf().filter(x => x[1] === 'Item C again').length, 0, 'neither copy was written');
assert.ok(W.sheet('Products').rowsOf().filter(x => x[0] === 'S2').every(x => x[4] === 8), 'On hand on both copies');
W.sheet('Products').putRows(W.sheet('Products').rowsOf().filter((x, i, all) => all.findIndex(y => y[0] === x[0]) === i));
assert.deepEqual(W.full().warnings, []);

// (d) the same for Invoices and Invoice lines (keyed by Invoice ID and Line together), and an entry refused there writes nothing anywhere
W.add([{ id: 'dk', kind: 'cust', cust: { id: 'c1', name: 'Ana', contact: '0917' } }]);
const invD = (id, no) => ({ id: 'v' + id, kind: 'invoice', invoice: { id, no, date: '2026-11-12', custId: 'c1', paid: 10, lines: [{ sku: 'S0', qty: 1, price: 100, follow: true }, { sku: 'S1', qty: 1, price: 50, follow: true }] } });
r = W.add([invD('d1', 1), invD('d2', 2), invD('d3', 3)]); assert.ok(r.results.every(x => x.ok));
const invRows = () => Object.fromEntries(W.sheet('Invoices').rowsOf().map(x => [x[1], x]));
const lineRows = () => Object.fromEntries(W.sheet('Invoice lines').rowsOf().map(x => [x[1] + ' line ' + x[2], x]));
['Invoices', 'Invoice lines'].forEach(n => W.sheet(n).putRows(W.sheet(n).rowsOf().reverse()));
r = W.add([{ id: 'dp2', kind: 'pay', invId: 'd2', paid: 60 }, { id: 'df2', kind: 'follow', invId: 'd2', line: 2, expected: '2026-12-01' }]); assert.ok(r.results.every(x => x.ok));
assert.deepEqual([invRows().d2[7], invRows().d2[8], invRows().d1[7], lineRows()['d2 line 2'][10], lineRows()['d1 line 2'][10], lineRows()['d2 line 1'][10]], [60, 90, 10, '2026-12-01', '', ''], 'payment and date on the right rows after a sort');
fired = 0;
W.b.ss.onSetValues = sh => { if (sh.name === 'Invoice lines' && !fired++) { const rows = sh.rowsOf(); sh.putRows([rows[2], rows[0], rows[5], rows[3], rows[1], rows[4]]); } };
r = W.add([{ id: 'dd1', kind: 'deliver', invId: 'd1', line: 1, date: '2026-11-20', cost: null }, { id: 'dc3', kind: 'lineCancel', invId: 'd3', line: 2, refund: 5 }, { id: 'df1', kind: 'follow', invId: 'd1', line: 2, expected: '2026-12-05' }]);
W.b.ss.onSetValues = null;
assert.ok(fired && r.results.every(x => x.ok));
assert.deepEqual([lineRows()['d1 line 1'][9], lineRows()['d1 line 1'][12], lineRows()['d3 line 2'][9], lineRows()['d1 line 2'][10], invRows().d3.slice(6, 9)], ['Delivered', '2026-11-20', 'Cancelled', '2026-12-05', [100, 5, 95]], 'rows moved mid-request still get their own changes');
const ln0 = W.sheet('Invoice lines').rowsOf(), movesBefore = W.full().rows;
W.sheet('Invoice lines').putRows(ln0.concat([ln0.find(x => x[1] === 'd2' && x[2] === 1)]));
r = W.add([{ id: 'dd2', kind: 'deliver', invId: 'd2', line: 1, date: '2026-11-21', cost: 1 }, { id: 'dd3', kind: 'deliver', invId: 'd3', line: 1, date: '2026-11-21', cost: 1 }]);
let rd = res(r);
assert.equal(rd.dd2.error, MSG('Invoice lines', 'd2 line 1', 'appears twice')); assert.ok(rd.dd3.ok);
assert.equal(W.full().rows, movesBefore + 1, 'the refused delivery wrote no movement');
assert.ok(W.sheet('Invoice lines').rowsOf().filter(x => x[1] === 'd2' && x[2] === 1).every(x => x[9] === 'To follow'), 'neither copy changed');
W.sheet('Invoice lines').putRows(W.sheet('Invoice lines').rowsOf().filter((x, i, all) => all.findIndex(y => y[1] === x[1] && y[2] === x[2]) === i));
const iv0 = W.sheet('Invoices').rowsOf(); W.sheet('Invoices').putRows(iv0.filter(x => x[1] !== 'd3').concat(iv0.filter(x => x[1] === 'd3'))); fired = 0;
W.b.ss.onSetValues = sh => { if (sh.name === 'Invoices' && !fired++) sh.putRows(sh.rowsOf().filter(x => x[1] !== 'd3')); };
r = W.add([{ id: 'dp1', kind: 'pay', invId: 'd1', paid: 20 }, { id: 'dp3', kind: 'pay', invId: 'd3', paid: 50 }]);
W.b.ss.onSetValues = null;
assert.ok(res(r).dp1.ok); assert.equal(res(r).dp3.error, MSG('Invoices', 'd3', 'not found'));
assert.ok(!W.sheet('Invoices').rowsOf().some(x => x[7] === 50), 'the refused payment was written nowhere');
W.sheet('Invoices').putRows(iv0.filter(x => x[1] === 'd3').concat(W.sheet('Invoices').rowsOf()));

// (e) On hand is a number per SKU, right after every add
const stockNow = () => { const m = {}; W.full().moves.forEach(x => { m[x.sku] = (m[x.sku] || 0) + (x.dir === 'In' ? x.qty : -x.qty); }); return m; };
W.add([move('e1', 'S0', 'Out', 2, 'Sale'), move('e2', 'S4', 'In', 3, 'Restock'), item('S9', 'Item New')]);
const st = stockNow();
assert.deepEqual(G(), Object.fromEntries(Object.keys(names()).map(k => [k, st[k] || 0])), 'On hand matches the movements for every row');
assert.equal(G().S9, 0);

// (f) Browse: every item with its numbers, rewritten on add and on sync; a filter stays
W.add([{ id: 'fs', kind: 'supplier', supplier: { id: 'fs', name: 'Supplier F' } }, { id: 'f1', kind: 'order', order: { id: 'fo1', date: '2026-11-10', supId: 'fs', expected: '', note: '', lines: [{ id: 'fl1', sku: 'S5', qty: 2 }, { id: 'fl2', sku: 'S5', qty: 5 }] } },
  { id: 'f0', kind: 'receive', lineId: 'fl2', date: '2026-11-11', from: 0, costs: [100, 150, 200] }, move('f2', 'S5', 'In', 2, 'Restock', { cost: 100 }), move('f4', 'S5', 'Out', 2, 'Sale')]);
W.add([{ id: 'vf6', kind: 'invoice', invoice: { id: 'f6', no: 21, date: '2026-11-12', custId: 'c1', paid: 0, lines: [{ sku: 'S5', qty: 2, price: 100, follow: true }] } }]);
const br = W.sheet('Browse');
assert.equal(br.frozen, 1);
assert.deepEqual(br.getRange(1, 1, 1, 17).getValues()[0], ['Product ID', 'Name', 'Price', 'Active', 'On hand', 'Incoming', 'Owed', 'Left to promise', 'Units on hand', 'Stock value at cost', 'Units without cost', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Release check']);
let bs = Object.fromEntries(br.rowsOf().map(x => [x[0], x]));
assert.equal(Object.keys(bs).length, Object.keys(names()).length, 'one row per item');
assert.deepEqual(bs.S5.slice(4, 11), [4, 4, 2, 6, 'S5-3 150, S5-4 200, 100, 100', 550, 0], 'on hand, incoming (Qty less Received qty over Ordered lines), owed, left to promise, units on hand (the sale took the uncosted unit, the oldest; an In of Qty 2 has no unit SKUs), stock value, units without cost');
assert.deepEqual(bs.S2.slice(0, 4), ['S2', 'Item C renamed', 5, 'Yes']); assert.deepEqual(bs.S2.slice(8, 11), ['?, ?, ?, ?, ?, ?, ?, S2-8 ?', 0, 8], 'a unit without a cost shows as ?; the In of Qty 7 used SKU numbers 1 to 7');
assert.deepEqual(bs.S9.slice(4, 11), [0, 0, 0, 0, '', '', ''], 'nothing on hand leaves the cost columns blank');
assert.ok(br.textCols.has(9), 'Units on hand is a text column');
br.filter = { range: 'A1:R' };
W.sheet('Products').set(2, 2, 'Typed in the sheet');
W.full(); bs = Object.fromEntries(br.rowsOf().map(x => [x[0], x]));
assert.ok(br.rowsOf().some(x => x[1] === 'Typed in the sheet'), 'sync rewrites Browse'); assert.deepEqual(br.filter, { range: 'A1:R' }, 'the filter stays');
assert.equal(br.getLastRow(), Object.keys(names()).length + 1, 'nothing left below the last item');

// (g) the Edits tab: applied as edit entries at the start of a sync or add, Done or Refused with the reason
const ed = W.sheet('Edits');
assert.deepEqual(ed.getRange(1, 1, 1, 5).getValues()[0], ['Product ID', 'Field', 'New value', 'Status', 'Note']);
assert.deepEqual(ed.validation.rule.list, ['Name', 'Price', 'Active', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Release check']);
[['s3', 'Price', '300', '', ''], ['S4', 'Colour', 'red', '', ''], ['T9999', 'Name', 'Ghost', '', ''], ['S5', 'Active', 'maybe', '', ''], ['S9', 'Name', 'Item A3', '', ''],
 ['S9', 'Product line', '=Line', '', ''], ['S9', 'Release check', 'Verify', '', ''], ['S0', 'Name', 'Old row', 'Done', ''], ['', 'Price', '5', '', '']].forEach((v, i) => v.forEach((x, j) => { if (x !== '') ed.set(i + 2, j + 1, x); }));
let sy = W.full(), its = Object.fromEntries(sy.items.map(i => [i.sku, i]));
const edCol = c => ed.rowsOf().map(x => x[c] === undefined ? '' : x[c]);
assert.deepEqual(edCol(3), ['Done', 'Refused', 'Refused', 'Refused', 'Refused', 'Done', 'Done', 'Done', 'Refused']);
assert.deepEqual(edCol(4).map(n => n.split(' ').slice(0, 3).join(' ')), ['', 'Field must be', 'Unknown product T9999', 'Active must be', 'A product named', '', '', '', 'Product ID is']);
assert.deepEqual([its.S3.price, its.S9.line, its.S9.relCheck, its.S0.name], [300, '=Line', true, 'Item A3'], 'applied rows reach Products; a Done row is not applied again');
assert.equal(Object.fromEntries(W.sheet('Browse').rowsOf().map(x => [x[0], x])).S3[2], 300, 'Browse shows the edit at once');
ed.set(11, 1, 'S1'); ed.set(11, 2, 'Brand'); ed.set(11, 3, 'Tomica');
r = W.add([move('g1', 'S1', 'In', 1, 'Restock')]);
assert.deepEqual(r.results.map(x => x.id), ['qg1'], 'Edits results stay out of the reply to the app');
assert.equal(ed.cell(11, 4), 'Done'); assert.equal(r.sync.items.find(i => i.sku === 'S1').brand, 'Tomica');
// an Edits row moved by a sort before its status is written is still found
ed.set(12, 1, 'S2'); ed.set(12, 2, 'Brand'); ed.set(12, 3, 'Gigo');
fired = 0; W.b.ss.onSetValues = sh => { if (sh.name === 'Products' && !fired++) ed.putRows(ed.rowsOf().reverse()); };
W.full(); W.b.ss.onSetValues = null;
assert.deepEqual(ed.rowsOf().filter(x => x[0] === 'S2' && x[1] === 'Brand').map(x => x[3]), ['Done']);

// Inbox marks from app 2.2 carry Added, Type and Qty and find a row that moved
const ibx = W.sheet('Inbox');
[['2026-11-15', 'Count', 'Box One', '2'], ['2026-11-15', 'Count', 'Box Two', '3'], ['2026-11-15', 'Count', 'Box One', '?']].forEach((v, i) => v.forEach((x, j) => ibx.set(i + 2, j + 1, x)));
const ref = row => { const x = W.full().inbox.find(y => y.row === row); return { row, name: x.name, added: x.added, type: x.type, qty: x.qty }; };
const refs = [ref(2), ref(3)];
ibx.putRows([ibx.rowsOf()[2], ibx.rowsOf()[1], ibx.rowsOf()[0]]);   // now Box One ? / Box Two / Box One 2
r = W.add([{ id: 'ibm', kind: 'inboxDone', rows: refs, mark: 'Done' }]);
assert.ok(r.results[0].ok);
assert.deepEqual(ibx.rowsOf().map(x => [x[2], x[3], x[12]]), [['Box One', '?', undefined], ['Box Two', '3', 'Done'], ['Box One', '2', 'Done']], 'the unknown count stays waiting');
ibx.set(5, 1, '2026-11-15'); ibx.set(5, 2, 'Count'); ibx.set(5, 3, 'Box Three'); ibx.set(5, 4, '1'); ibx.set(5, 13, 'Working');
assert.ok(!W.full().inbox.some(x => x.name === 'Box Three'), 'a Working row is not sent');
W.add([{ id: 'ibw', kind: 'inboxDone', rows: [{ row: 5, name: 'Box Three', added: '2026-11-15', type: 'count', qty: '1' }], mark: 'Done' }]);
assert.equal(ibx.cell(5, 13), 'Working', 'a row with a status is never overwritten');

// (h) setup(): warning-only protection on the app tabs and none on the Inbox; running it again keeps every cell and adds no second protection
const tabsH = ['Products', 'Movements', 'Customers', 'Suppliers', 'Supplier orders', 'Invoices', 'Invoice lines', 'Returns', 'Inbox'];
const snap = () => Object.fromEntries(tabsH.map(n => [n, W.sheet(n).rowsOf()]));
const prot = () => tabsH.slice(0, -1).map(n => W.sheet(n).getProtections().map(p => [p.desc, p.warn]));
const beforeH = snap();
vm.runInContext('setup()', W.b);
assert.deepEqual(prot(), tabsH.slice(0, -1).map(() => [['Used by the app. Sort and filter in the Browse tab; change fields in the Edits tab.', true]]), 'warning-only protection on the app tabs');
assert.deepEqual(W.sheet('Inbox').getProtections(), [], 'the Inbox stays open for Claude');
assert.deepEqual(snap(), beforeH, 'every cell kept');

// ---------- 2.3: units first in, first out, a cost per unit, cost entries, moveRev, wipe ----------
const U = bench();
const brU = sku => U.sheet('Browse').rowsOf().find(x => x[0] === sku).slice(4, 11);
const onHandU = sku => U.sheet('Products').rowsOf().find(x => x[0] === sku)[4];
r = U.add([item('U1', 'Unit One'), item('U2', 'Unit Two'), item('U3', 'Unit Three'), item('U4', 'Unit Four'), { id: 'uk', kind: 'cust', cust: { id: 'cu', name: 'Cora', contact: '0917' } }]);
assert.ok(r.results.every(x => x.ok));

// (i) a sale below zero, then receipts: the first unit to arrive covers the deficit, the rest go on hand
r = U.add([move('n1', 'U2', 'Out', 2, 'Sale'), move('n2', 'U2', 'In', 1, 'Restock', { cost: 50 })]);
assert.deepEqual([onHandU('U2'), brU('U2')], [-1, [-1, 0, 0, -1, '', '', '']], 'still below zero: no unit on hand');
r = U.add([move('n3', 'U2', 'In', 1, 'Restock', { cost: 60 }), move('n4', 'U2', 'In', 1, 'Restock', { cost: 70 })]);
assert.deepEqual([onHandU('U2'), brU('U2')], [1, [1, 0, 0, 1, 'U2-3 70', 70, 0]], 'the deficit took the units at 50 and 60');

// (j) a Correction reversing an In takes that In's unit, not the oldest; once it is gone, a Correction takes the oldest
r = U.add([move('a1', 'U4', 'In', 1, 'Opening', { cost: 10 }), move('a2', 'U4', 'In', 1, 'Restock', { cost: 20 }), move('a3', 'U4', 'In', 1, 'Restock', { cost: 30 }),
  move('a4', 'U4', 'Out', 1, 'Correction', { ref: 'a2' })]);
assert.deepEqual(brU('U4'), [2, 0, 0, 2, 'U4-1 10, U4-3 30', 40, 0]);
r = U.add([move('a5', 'U4', 'Out', 1, 'Correction', { ref: 'a2' })]);
assert.deepEqual(brU('U4'), [1, 0, 0, 1, 'U4-3 30', 30, 0]);
r = U.add([move('a6', 'U4', 'In', 2, 'Restock', { cost: 5 }), move('a7', 'U4', 'Out', 3, 'Correction', { ref: 'a6' })]);
assert.deepEqual([onHandU('U4'), brU('U4')[4]], [0, ''], 'a read In of Qty 2 is two units; the third unit of the Correction comes from the front');

// (k) four units received at four costs, then two sales: each line keeps the cost the app sent, the two newest units stay, oldest first
const saleU = (id, no, lines) => ({ id: 'v' + id, kind: 'invoice', invoice: { id, no, date: '2026-11-16', custId: 'cu', lines } });
r = U.add([{ id: 'us', kind: 'supplier', supplier: { id: 'us', name: 'Supplier U' } }, { id: 'uo', kind: 'order', order: { id: 'uo', date: '2026-11-10', supId: 'us', expected: '', note: '', lines: [{ id: 'uo1', sku: 'U1', qty: 4 }] } },
  { id: 'ur', kind: 'receive', lineId: 'uo1', date: '2026-11-14', from: 0, costs: [100, 200, 300, 400] }]);
assert.ok(r.results.every(x => x.ok));
assert.deepEqual(U.sheet('Movements').rowsOf().filter(x => x[7] === 'uo').map(x => [x[0], x[5], x[9], x[10]]), [['rcv-uo1-1', 1, 100, 'U1-1'], ['rcv-uo1-2', 1, 200, 'U1-2'], ['rcv-uo1-3', 1, 300, 'U1-3'], ['rcv-uo1-4', 1, 400, 'U1-4']], 'each unit received has its SKU in column K');
assert.deepEqual(brU('U1'), [4, 0, 0, 4, 'U1-1 100, U1-2 200, U1-3 300, U1-4 400', 1000, 0]);
r = U.add([saleU('us1', 1, [{ sku: 'U1', qty: 1, price: 500, cost: 100 }]), saleU('us2', 2, [{ sku: 'U1', qty: 1, price: 500, cost: 150 }])]);
assert.ok(r.results.every(x => x.ok));
assert.deepEqual(U.sheet('Invoice lines').rowsOf().map(x => [x[0], x[8]]), [[1, 100], [2, 150]], 'the line cost is written as the app sent it');
assert.deepEqual(U.sheet('Movements').rowsOf().filter(x => x[6] === 'Sale' && x[2] === 'U1').map(x => [x[0], x[9], x[10]]), [['us1-1', 100, ''], ['us2-1', 150, '']], 'and the same on the Sale movement, which has no SKU');
assert.deepEqual([onHandU('U1'), brU('U1')], [2, [2, 0, 0, 2, 'U1-3 300, U1-4 400', 700, 0]], 'the two oldest units left');

// (l) a Restock return writes one row per unit at the cost of the first line of that item on the invoice, at the back of the queue
r = U.add([move('t1', 'U3', 'In', 1, 'Opening', { cost: 80 }), move('t2', 'U3', 'In', 1, 'Opening', { cost: 90 }), move('t3', 'U3', 'In', 1, 'Opening', { cost: 95 }),
  saleU('us3', 3, [{ sku: 'U3', qty: 1, price: 200, cost: 80 }, { sku: 'U3', qty: 1, price: 200, cost: 90 }])]);
r = U.add([{ id: 'ut', kind: 'ret', ret: { id: 'urt', date: '2026-11-17', invId: 'us3', sku: 'U3', qty: 2, outcome: 'Restock', refund: 0, note: '' } }]);
assert.ok(r.results[0].ok);
assert.deepEqual(U.sheet('Movements').rowsOf().filter(x => x[7] === 'urt').map(x => x.slice(0, 10)), [1, 2].map(k => ['ret-urt-' + k, '2026-11-17', 'U3', 'Unit Three', 'In', 1, 'Return', 'urt', 'Invoice 3', 80]));
assert.deepEqual(brU('U3'), [3, 0, 0, 3, 'U3-3 95, U3-4 80, U3-5 80', 255, 0], 'returned units get new SKUs');

// (m) a cost changed on a unit on hand: column J only, Browse, moveRev raised, and a second device gets every movement again
const costE = (id, moveId, cost) => ({ id, kind: 'cost', moveId, cost });
const mvRow = (b, id) => b.sheet('Movements').rowsOf().find(x => x[0] === id);
const s0 = U.full(), rowBefore = mvRow(U, 'rcv-uo1-4');
r = U.c('add', { have: { rows: s0.rows, lastId: s0.lastId, moveRev: s0.moveRev }, entries: [costE('cc1', 'rcv-uo1-4', 450)] }).data;
assert.ok(r.results[0].ok);
assert.deepEqual(mvRow(U, 'rcv-uo1-4'), rowBefore.slice(0, 9).concat(450, rowBefore.slice(10)), 'only Unit cost changed');
assert.deepEqual(brU('U1'), [2, 0, 0, 2, 'U1-3 300, U1-4 450', 750, 0]);
assert.equal(r.sync.moveRev, s0.moveRev + 1, 'a cost write raises moveRev');
assert.deepEqual([r.sync.reset, r.sync.moves.length, r.sync.moves.find(m => m.id === 'rcv-uo1-4').cost], [true, s0.rows, 450], 'the reply carries every movement');
let s1 = U.c('sync', { have: { rows: s0.rows, lastId: s0.lastId, moveRev: s0.moveRev } }).data;
assert.deepEqual([s1.reset, s1.moves.length, s1.moves.find(m => m.id === 'rcv-uo1-4').cost], [true, s0.rows, 450], 'a device holding the old moveRev gets everything');
s1 = U.c('sync', { have: { rows: s1.rows, lastId: s1.lastId, moveRev: s1.moveRev } }).data;
assert.deepEqual([s1.reset, s1.moves.length], [false, 0], 'and then syncs incrementally again');
r = U.add([costE('cc1', 'rcv-uo1-4', 450), costE('cc2', 'rcv-uo1-3', null)]);
assert.ok(r.results.every(x => x.ok)); assert.equal(r.sync.moveRev, s0.moveRev + 2, 'a retry writes nothing; clearing a cost is a write');
assert.equal(mvRow(U, 'rcv-uo1-3')[9], ''); assert.deepEqual(brU('U1'), [2, 0, 0, 2, 'U1-3 ?, U1-4 450', 450, 1]);
r = U.add([move('nx', 'U2', 'In', 1, 'Restock', { cost: 5 }), costE('cc3', 'nx', 6)]);
assert.ok(r.results.every(x => x.ok)); assert.equal(mvRow(U, 'nx')[9], 6, 'a movement written earlier in the same request takes the cost');
assert.equal(r.sync.moveRev, s0.moveRev + 2, 'a new row needs no reset');

// (n) refused: a unit that left stock (also earlier in the same request), an Out, an unknown ID, a bad value; nothing changes
const LEFT = 'That unit has already left stock, so its cost can no longer be changed.';
const tabsN = () => ['Movements', 'Invoice lines', 'Invoices'].map(n => U.sheet(n).rowsOf());
let beforeN = tabsN(), revN = U.full().moveRev;
r = U.add([costE('cn1', 'rcv-uo1-1', 999), costE('cn2', 'us1-1', 1), costE('cn3', 'nope', 1), costE('cn4', 'rcv-uo1-4', -1), costE('cn5', 'n2', 1), costE('cn6', 'rcv-uo1-1', 100)]);
let zn = res(r);
assert.deepEqual([zn.cn1.error, zn.cn2.error, zn.cn3.error, zn.cn5.error], [LEFT, LEFT, 'Unknown movement', LEFT], 'sold, an Out, unknown, a unit that only covered a deficit');
assert.match(zn.cn4.error, /Unit cost/); assert.ok(zn.cn6.ok, 'the value it already has is not refused, so a retry after the sale succeeds');
assert.deepEqual(tabsN(), beforeN, 'no movement and no invoice changed'); assert.equal(r.sync.moveRev, revN);
r = U.add([saleU('us4', 4, [{ sku: 'U1', qty: 1, price: 500, cost: null }]), costE('cn7', 'rcv-uo1-3', 310), costE('cn8', 'n4', 75)]);
zn = res(r);
assert.ok(zn.vus4.ok && zn.cn8.ok); assert.equal(zn.cn7.error, LEFT, 'the sale earlier in the request took that unit');
assert.deepEqual([mvRow(U, 'rcv-uo1-3')[9], brU('U1')[4], brU('U2')[4]], ['', 'U1-4 450', 'U2-3 75, U2-4 6']);

// (o) the Movements key check: a sorted tab still gets the cost on the right row; a duplicated or deleted row refuses the entry
const K = bench();
K.add([item('K1', 'Key One'), move('k1', 'K1', 'In', 1, 'Opening', { cost: 1 }), move('k2', 'K1', 'In', 1, 'Opening', { cost: 2 }), move('k3', 'K1', 'In', 1, 'Opening', { cost: 3 })]);
const jK = () => Object.fromEntries(K.sheet('Movements').rowsOf().map(x => [x[0], x[9]]));
K.sheet('Movements').putRows(K.sheet('Movements').rowsOf().reverse());
r = K.add([costE('ko1', 'k2', 20)]);
assert.ok(r.results[0].ok); assert.deepEqual(jK(), { k1: 1, k2: 20, k3: 3 });
const mk = K.sheet('Movements').rowsOf();
K.sheet('Movements').putRows(mk.concat([mk.find(x => x[0] === 'k1')]));
let revK = K.full().moveRev;
r = K.add([costE('ko2', 'k1', 10), costE('ko3', 'k3', 30)]);
assert.equal(res(r).ko2.error, MSG('Movements', 'k1', 'appears twice')); assert.ok(res(r).ko3.ok);
assert.ok(K.sheet('Movements').rowsOf().filter(x => x[0] === 'k1').every(x => x[9] === 1), 'neither copy written'); assert.equal(r.sync.moveRev, revK + 1);
K.sheet('Movements').putRows(mk);
fired = 0; K.b.ss.onSetValues = sh => { if (sh.name === 'Movements' && !fired++) sh.putRows(sh.rowsOf().filter(x => x[0] !== 'k1')); };
r = K.add([costE('ko4', 'k3', 33), costE('ko5', 'k1', 11)]);
K.b.ss.onSetValues = null;
assert.ok(fired && res(r).ko4.ok); assert.equal(res(r).ko5.error, MSG('Movements', 'k1', 'not found'));
assert.deepEqual(jK(), { k2: 20, k3: 33 }, 'the refused cost was written nowhere');

// (p) wipeAllData(): a backup first, then every row under the header goes on the listed tabs; key, tabs, formatting and Inbox stay;
// Browse is deleted and the next sync makes it again with the current header, text columns and no filter
const ibU = U.sheet('Inbox');
[['Done', 'Done Row'], ['Dismissed', 'Dismissed Row'], ['Working', 'Working Row'], ['', 'Waiting Row'], ['Done', 'Done Too']].forEach(([st, name], i) =>
  ['2026-11-15', 'Count', name, '1', '', '', '', '', '', '', '', '', st].forEach((v, j) => { if (v) ibU.set(i + 2, j + 1, v); }));
U.sheet('Edits').set(2, 1, 'U1'); U.sheet('Edits').set(2, 2, 'Price'); U.sheet('Edits').set(2, 3, '5'); U.sheet('Edits').set(2, 4, 'Done');
const wiped = ['Products', 'Movements', 'Customers', 'Suppliers', 'Supplier orders', 'Invoices', 'Invoice lines', 'Returns', 'Edits'];
const heads = () => wiped.map(n => U.sheet(n).getRange(1, 1, 1, 19).getValues()[0]);
const sW = U.full(), keyW = U.b.props.KEY, inboxW = ibU.rowsOf(), headsW = heads();
assert.ok(wiped.concat('Browse').every(n => U.sheet(n).getLastRow() > 1), 'every listed tab has rows before the wipe');
U.sheet('Browse').filter = { range: 'A1:R' };
vm.runInContext('wipeAllData()', U.b);
assert.deepEqual(U.b.copies.map(c => c.name), ['Bodega backup ' + new Date().toISOString().slice(0, 10)]);
assert.ok(Object.values(U.b.copies[0].sheets.find(s => s.name === 'Movements').cells).includes('rcv-uo1-4'), 'the backup was made before the wipe');
assert.deepEqual(wiped.map(n => U.sheet(n).getLastRow()), wiped.map(() => 1), 'nothing left under the headers'); assert.deepEqual(heads(), headsW, 'headers kept');
assert.deepEqual(ibU.rowsOf(), inboxW, 'Inbox kept'); assert.equal(U.b.props.KEY, keyW, 'key kept');
assert.ok(U.sheet('Movements').textCols.has(1) && U.sheet('Edits').validation && U.sheet('Products').getProtections().length === 1, 'formatting, the dropdown and the protection stay');
assert.equal(U.sheet('Browse'), undefined, 'Browse is deleted');
const sAfter = U.c('sync', { have: { rows: sW.rows, lastId: sW.lastId, moveRev: sW.moveRev } }).data;
assert.deepEqual([sAfter.moveRev, sAfter.reset, sAfter.rows, sAfter.moves, sAfter.items, sAfter.invs], [sW.moveRev + 1, true, 0, [], [], []], 'a phone syncing after the wipe gets the empty sheet');
const brW = U.sheet('Browse');
assert.deepEqual([brW.getRange(1, 1, 1, 17).getValues()[0][16], brW.getLastRow(), brW.textCols.has(9), brW.filter], ['Release check', 1, true, null], 'Browse made again by the sync');
r = U.add([item('W1', 'After Wipe'), { id: 'wk', kind: 'cust', cust: { id: 'cu', name: 'Cora', contact: '0917' } }, saleU('w1', 1, [{ sku: 'W1', qty: 1, price: 10 }])]);
assert.deepEqual([r.results[2].ok, r.results[2].no, r.results[2].fromNo], [true, 1, undefined], 'invoice numbers start again at 1');

// (q) reopenInbox(): Done rows come back for review; Dismissed and Working stay
vm.runInContext('reopenInbox()', U.b);
assert.deepEqual(ibU.rowsOf().map(x => [x[2], x[12]]), [['Done Row', undefined], ['Dismissed Row', 'Dismissed'], ['Working Row', 'Working'], ['Waiting Row', undefined], ['Done Too', undefined]]);
assert.deepEqual(U.full().inbox.map(x => x.name), ['Done Row', 'Waiting Row', 'Done Too']);

// ---------- 2.4: setup() upgrades a 2.3 sheet in place, and running it again changes nothing ----------
const V = bench(), pv = V.sheet('Products'), mvV = V.sheet('Movements');
pv.name = 'Items'; pv.cells = {};
[['SKU', 'Name', 'Category', 'Price', 'Reorder at', 'Active', 'On hand', 'Manufacturer', 'Brand', 'Toy line', 'Character', 'Release date', 'Release check'],
 ['V1', 'Vee One', 'Cars', 100, 2, 'Yes', 0, 'Maker', 'Brand', 'Line', 'Chr', '2024', 'Verify']].forEach((r, i) => r.forEach((v, j) => pv.set(i + 1, j + 1, v)));
mvV.set(1, 3, 'SKU'); mvV.set(1, 4, 'Item'); mvV.set(1, 11, '');
mvV.putRows([['v1', '2026-11-01', 'V1', 'Vee One', 'In', 1, 'Opening', '', '', 10], ['v2', '2026-11-01', 'V1', 'Vee One', 'In', 3, 'Restock', '', 'typed by hand', 20],
  ['v3', '2026-11-02', 'V1', 'Vee One', 'Out', 2, 'Sale', '1', '', 10], ['v4', '2026-11-03', 'V2', 'Vee Two', 'In', 1, 'Opening', '', '', ''], ['v5', '2026-11-04', 'V1', 'Vee One', 'In', 1, 'Return', 'r1', '', 10]]);
V.sheet('Browse').getRange(1, 1, 1, 3).setValues([['SKU', 'Name', 'Category']]); V.sheet('Browse').filter = { range: 'A1:S' };
vm.runInContext('setup()', V.b);
assert.equal(V.sheet('Items'), undefined, 'Items is renamed');
assert.deepEqual(V.sheet('Products').rowsOf()[0].slice(0, 13), ['V1', 'Vee One', 100, 'Yes', 3, 'Maker', 'Brand', 'Line', 'Chr', '2024', 'Verify', undefined, undefined], 'Category and Reorder at are gone, the rest moved left');
assert.deepEqual([V.sheet('Products').cell(1, 1), mvV.getRange(1, 3, 1, 9).getValues()[0], V.sheet('Invoice lines').cell(1, 4)], ['Product ID', ['Product ID', 'Product', 'Direction', 'Qty', 'Reason', 'Ref', 'Note', 'Unit cost', 'SKU'], 'Product ID'], 'every header row is current');
assert.deepEqual(mvV.rowsOf().map(x => x[10]), ['V1-1', '', '', 'V2-1', 'V1-5'], 'In rows of one unit get their SKU in sheet order; the hand-typed In of 3 uses three numbers and gets none');
assert.deepEqual([V.sheet('Browse').filter, V.sheet('Browse').rowsOf()[0].slice(4, 11)], [null, [3, 0, 0, 3, '20, 20, V1-5 10', 50, 0]], 'Browse is made again with the current header');
assert.deepEqual([V.b.props.moveRev, V.full().moves.map(m => m.unit), V.add([move('v6', 'V1', 'In', 1, 'Restock')]).sync.moves.slice(-1)[0].unit], ['1', ['V1-1', '', '', 'V2-1', 'V1-5'], 'V1-6'], 'moveRev is raised so phones get the SKUs; the next unit continues the count');
const cellsV = () => V.b.sheets.map(x => [x.name, JSON.stringify(Object.entries(x.cells).sort())]);
const beforeV = cellsV(); V.sheet('Browse').filter = { range: 'A1:Q' };
vm.runInContext('setup()', V.b);
assert.deepEqual([cellsV(), V.b.props.moveRev, V.sheet('Browse').filter], [beforeV, '1', { range: 'A1:Q' }], 'running setup() again changes nothing');
console.log('backend tests passed');
