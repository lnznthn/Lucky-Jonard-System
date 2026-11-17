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
assert.deepEqual(sb.sheets.find(s => s.name === 'Items').formulas, {}, 'Items holds no formula');
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

// ---------- v2: toy details, receipt cost, customers, supplier orders, pre-orders, invoices, returns ----------
const sheet = n => sb.sheets.find(s => s.name === n);
const add = entries => { const s = call('sync', { have: { rows: 0 } }).data; return call('add', { have: { rows: s.rows, lastId: s.lastId, moveRev: s.moveRev }, entries }).data; };
const res = d => Object.fromEntries(d.results.map(x => [x.id, x]));
const full = () => call('sync', { have: { rows: 0 } }).data;
['Customers', 'Supplier orders', 'Pre-orders', 'Invoices', 'Invoice lines', 'Returns'].forEach(n => assert.ok(sheet(n), n + ' tab exists'));

// 9. item details: stored, patched, validated; On hand is a written number
r = add([
  item('T0100', 'Grandista Son Goku', { cat: 'Figures', price: 1800, mfr: 'Bandai Spirits', brand: 'Banpresto', line: 'Grandista', chr: 'Son Goku', rel: '2019-06', relCheck: true }),
  { ...item('T0101', 'Bad Release', { rel: 'June 2019' }), id: 'badrel' },
  { id: 'ed9', kind: 'edit', sku: 'T0100', patch: { rel: '2019-06-20', relCheck: false, chr: 'Goku' } },
  { id: 'ed10', kind: 'edit', sku: 'T0002', patch: { brand: '=Brand' } },
]);
let z9 = res(r);
assert.ok(z9.iT0100.ok && z9.ed9.ok && z9.ed10.ok); assert.match(z9.badrel.error, /Release date/);
let goku = r.sync.items.find(i => i.sku === 'T0100');
assert.deepEqual([goku.mfr, goku.brand, goku.line, goku.chr, goku.rel, goku.relCheck], ['Bandai Spirits', 'Banpresto', 'Grandista', 'Goku', '2019-06-20', false]);
assert.equal(r.sync.items.find(i => i.sku === 'T0002').brand, '=Brand', 'detail text is stored as typed');
assert.deepEqual(sheet('Items').formulas, {}, 'no formula after item writes');
for (let row = 2; row <= sheet('Items').getLastRow(); row++) assert.equal(typeof sheet('Items').cell(row, 7), 'number', 'On hand is a number on row ' + row);

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

// 12. supplier orders: ordered, received with cost (movement Ref = order ID), cancelled, idempotent
const order = (id, sku, qty, extra = {}) => ({ id: 'o' + id, kind: 'order', order: { id, date: '2026-11-10', sku, qty, expected: '2026-12-01', note: '', ...extra } });
r = add([order('so1', 'T0100', 6), order('so2', 'T0100', 2, { expected: '' }), order('so3', 'T9999', 1), order('so4', 'T0100', 1, { expected: 'soon' })]);
assert.ok(res(r).oso1.ok && res(r).oso2.ok); assert.match(res(r).oso3.error, /Unknown item/); assert.match(res(r).oso4.error, /Expected arrival/);
assert.deepEqual(r.sync.orders.map(o => o.status), ['Ordered', 'Ordered']);
let rowsBefore = full().rows;
r = add([{ id: 'rc0', kind: 'receive', orderId: 'so1', date: '2026-11-14', qty: 5, costs: [1300, -5, 1300, 1300, 1300] },
  { id: 'rc1', kind: 'receive', orderId: 'so1', date: '2026-11-14', qty: 5, costs: [1300, 1300, 1250, null, 1300] }, { id: 'oc2', kind: 'orderCancel', orderId: 'so2' },
  { id: 'rc2', kind: 'receive', orderId: 'so2', date: '2026-11-14', qty: 2, costs: [1, 1] }, { id: 'oc1', kind: 'orderCancel', orderId: 'so1' }]);
assert.match(res(r).rc0.error, /Unit cost/, 'one bad cost refuses the whole receipt');
assert.ok(res(r).rc1.ok && res(r).oc2.ok); assert.match(res(r).rc2.error, /cancelled/); assert.match(res(r).oc1.error, /already received/);
let rcv = full().moves.filter(m => m.ref === 'so1');
assert.deepEqual(rcv.map(m => [m.id, m.sku, m.dir, m.qty, m.reason, m.cost]), [1300, 1300, 1250, null, 1300].map((c, k) => ['rcv-so1-' + (k + 1), 'T0100', 'In', 1, 'Restock', c]), 'one row per unit, each with its cost; blank allowed');
assert.deepEqual(full().orders.map(o => [o.status, o.recQty, o.recDate]), [['Received', 5, '2026-11-14'], ['Cancelled', null, '']]);
r = add([{ id: 'rc1', kind: 'receive', orderId: 'so1', date: '2026-11-15', qty: 9, costs: [1] }, order('so1', 'T0100', 6)]);
assert.ok(r.results.every(x => x.ok)); assert.equal(full().rows, rowsBefore + 5, 'receiving twice adds nothing more');

// 13. pre-orders: receipt numbered 1, no movement, partial payment, validation
const pre = (id, extra = {}) => ({ id: 'p' + id, kind: 'pre', pre: { id, date: '2026-11-12', custId: 'c-ana', sku: 'T0100', qty: 2, price: 1700, paid: 1000, note: '', invId: 'rcpt-' + id, no: 1, ...extra } });
rowsBefore = full().rows;
r = add([pre('po1'), pre('po2', { custId: 'c-ben' }), pre('po3', { paid: 9999 }), pre('po4', { custId: 'nobody' })]);
let z13 = res(r);
assert.ok(z13.ppo1.ok && z13.ppo1.no === 1 && z13.ppo1.fromNo === undefined);
assert.match(z13.ppo2.error, /phone or Messenger/); assert.match(z13.ppo3.error, /more than the total/); assert.match(z13.ppo4.error, /Unknown customer/);
assert.equal(full().rows, rowsBefore, 'a pre-order moves no stock');
let po1 = r.sync.pres[0];
assert.deepEqual([po1.cust, po1.contact, po1.qty, po1.price, po1.paid, po1.balance, po1.status, po1.recNo], ['Ana Reyes', 'm.me/ana', 2, 1700, 1000, 2400, 'Open', 1]);
assert.deepEqual([r.sync.invs[0].no, r.sync.invs[0].type, r.sync.invs[0].total, r.sync.invs[0].lines.length], [1, 'Pre-order receipt', 3400, 1]);
r = add([pre('po1'), { id: 'pay1', kind: 'prePay', preId: 'po1', paid: 3400 }, { id: 'pay2', kind: 'prePay', preId: 'po1', paid: 3401 }]);
assert.ok(res(r).ppo1.ok && res(r).pay1.ok); assert.match(res(r).pay2.error, /more than the total/);
assert.equal(r.sync.pres.length, 1); assert.equal(r.sync.invs.length, 1); assert.equal(r.sync.pres[0].balance, 0);

// 14. sale invoice: sequential number, Out/Sale movement per line with Ref = number, price override, number clash renumbered
const invoice = (id, no, lines, extra = {}) => ({ id: 'v' + id, kind: 'invoice', invoice: { id, no, date: '2026-11-15', custId: 'c-ben', lines, ...extra } });
r = add([invoice('inv2', 2, [{ sku: 'T0100', qty: 1, price: 1500, cost: 1255.56 }, { sku: 'T0002', qty: 2, price: 250 }]), invoice('inv3', 2, [{ sku: 'T0002', qty: 1, price: 0 }]), invoice('inv4', 9, []), invoice('inv5', 9, [{ sku: 'T0002', qty: 1 }])]);
let z14 = res(r);
assert.deepEqual([z14.vinv2.ok, z14.vinv2.no, z14.vinv2.fromNo], [true, 2, undefined]);
assert.deepEqual([z14.vinv3.ok, z14.vinv3.no, z14.vinv3.fromNo], [true, 3, 2], 'a taken number moves to the next free one');
assert.match(z14.vinv4.error, /at least one toy/); assert.match(z14.vinv5.error, /Price/);
let inv2 = r.sync.invs.find(i => i.id === 'inv2');
assert.deepEqual([inv2.type, inv2.cust, inv2.total, inv2.ship], ['Sale', 'Ben Cruz', 2000, '']);
assert.deepEqual(inv2.lines.map(l => [l.sku, l.qty, l.list, l.price, l.cost]), [['T0100', 1, 1800, 1500, 1255.56], ['T0002', 2, 250, 250, null]]);
let sale = full().moves.filter(m => m.ref === '2');
assert.deepEqual(sale.map(m => [m.id, m.sku, m.dir, m.qty, m.reason, m.cost]), [['inv2-1', 'T0100', 'Out', 1, 'Sale', 1255.56], ['inv2-2', 'T0002', 'Out', 2, 'Sale', null]]);
rowsBefore = full().rows;
r = add([invoice('inv2', 2, [{ sku: 'T0100', qty: 1, price: 1500 }])]);
assert.ok(r.results[0].ok && r.results[0].no === 2); assert.equal(full().rows, rowsBefore, 'retrying an invoice adds nothing'); assert.equal(full().invs.length, 3);

// 15. pre-order fulfilled by a sale invoice; cancellation with the deposit kept (0 = full refund); closed pre-orders refuse changes
r = add([pre('po5', { no: 4, qty: 1, paid: 500 }), pre('po6', { no: 5, qty: 1, paid: 500 }), pre('po7', { no: 6, qty: 1, paid: 500 }), pre('po8', { no: 9, qty: 1, paid: 500, invId: 'rcpt-po8' })]);
assert.deepEqual(r.results.map(x => x.no), [4, 5, 6, 9]);
r = add([
  invoice('inv7', 7, [{ sku: 'T0100', qty: 2, price: 1700 }], { custId: 'c-ana', preId: 'po1' }),
  { id: 'cx5', kind: 'preCancel', preId: 'po5' },
  { id: 'cx6', kind: 'preCancel', preId: 'po6', kept: 300 },
  { id: 'cx7', kind: 'preCancel', preId: 'po7', kept: 501 },
  { id: 'cx1', kind: 'preCancel', preId: 'po1', kept: 0 },
  { id: 'cx8', kind: 'preCancel', preId: 'po8', kept: 0 },
  { id: 'cx6b', kind: 'preCancel', preId: 'po6', kept: 100 },
  { id: 'pay5', kind: 'prePay', preId: 'po5', paid: 600 },
  invoice('inv8', 8, [{ sku: 'T0100', qty: 1, price: 1700 }], { custId: 'c-ana', preId: 'po6' }),
]);
let z15 = res(r);
assert.ok(z15.vinv7.ok && z15.cx5.ok && z15.cx6.ok && z15.cx8.ok && z15.cx6b.ok);
assert.match(z15.cx7.error, /more than what was paid/); assert.match(z15.cx1.error, /already fulfilled/); assert.match(z15.pay5.error, /closed/); assert.match(z15.vinv8.error, /closed/);
const pres = Object.fromEntries(r.sync.pres.map(p => [p.id, p]));
assert.deepEqual([pres.po1.status, pres.po1.invNo], ['Fulfilled', 7]);
assert.deepEqual([pres.po5.status, pres.po5.kept], ['Cancelled', 0], 'no kept amount means a full refund');
assert.deepEqual([pres.po8.status, pres.po8.kept], ['Cancelled', 0]);
assert.deepEqual([pres.po6.status, pres.po6.kept], ['Cancelled', 300], 'a second cancel of a cancelled pre-order changes nothing');
assert.equal(pres.po7.status, 'Open');
assert.ok(sheet('Pre-orders').getRange('A:P').getValues().some(v => v[0] === 'po5' && v[11] === 'Cancelled' && v[12] === 0), 'Kept column holds 0 for a full refund');
assert.equal(full().moves.filter(m => m.reason === 'Sale' && m.ref === '7').length, 1, 'stock leaves when the sale invoice is issued');
assert.ok(!full().invs.some(i => i.id === 'inv8'), 'a refused invoice leaves no row');

// 16. delivered mark: sale invoices only, Delivered or blank, absolute
r = add([{ id: 's1', kind: 'ship', invId: 'inv2', ship: 'Delivered' }, { id: 's2', kind: 'ship', invId: 'inv2', ship: 'Shipped' }, { id: 's3', kind: 'ship', invId: 'inv2', ship: 'Packed' }, { id: 's4', kind: 'ship', invId: 'rcpt-po1', ship: 'Delivered' }]);
assert.ok(res(r).s1.ok); assert.match(res(r).s2.error, /Shipping status/); assert.match(res(r).s3.error, /Shipping status/); assert.match(res(r).s4.error, /sale invoice/);
assert.equal(r.sync.invs.find(i => i.id === 'inv2').ship, 'Delivered');
r = add([{ id: 's5', kind: 'ship', invId: 'inv2', ship: '' }]); assert.ok(res(r).s5.ok); assert.equal(r.sync.invs.find(i => i.id === 'inv2').ship, '', 'the mark can be taken off');
r = add([{ id: 's6', kind: 'ship', invId: 'inv2', ship: 'Delivered' }, { id: 's6', kind: 'ship', invId: 'inv2', ship: 'Delivered' }]); assert.ok(r.results.every(x => x.ok)); assert.equal(r.sync.invs.find(i => i.id === 'inv2').ship, 'Delivered');

// 17. returns: capped at what was sold, stock effect per outcome, idempotent
const ret = (id, sku, qty, outcome, extra = {}) => ({ id: 'r' + id, kind: 'ret', ret: { id, date: '2026-11-16', invId: 'inv2', sku, qty, outcome, refund: 100, note: '', ...extra } });
rowsBefore = full().rows;
r = add([ret('rt1', 'T0002', 1, 'Restock'), ret('rt2', 'T0002', 2, 'Write-off'), ret('rt3', 'T0002', 1, 'Write-off', { refund: '' }), ret('rt4', 'T0005', 1, 'Restock'), ret('rt5', 'T0100', 1, 'Burn'), ret('rt6', 'T0100', 1, 'Exchange'), ret('rt9', 'T0100', 1, 'Restock'), ret('rt7', 'T0100', 1, 'Restock', { invId: 'rcpt-po1' })]);
let z17 = res(r);
assert.ok(z17.rrt1.ok && z17.rrt3.ok && z17.rrt9.ok);
assert.match(z17.rrt2.error, /Only 1 of/); assert.match(z17.rrt4.error, /is not on invoice 2/); assert.match(z17.rrt5.error, /Outcome/); assert.match(z17.rrt6.error, /Outcome must be Restock or Write-off/, 'Exchange is no longer an outcome'); assert.match(z17.rrt7.error, /sale invoice/);
let back = full().moves.filter(m => m.reason === 'Return');
assert.deepEqual(back.map(m => [m.id, m.sku, m.dir, m.qty, m.ref, m.cost]), [['ret-rt1-1', 'T0002', 'In', 1, 'rt1', null], ['ret-rt9-1', 'T0100', 'In', 1, 'rt9', 1255.56]], 'restock comes back in at the line cost, write-off does not');
assert.equal(full().rows, rowsBefore + 2);
assert.deepEqual(r.sync.rets.map(x => [x.id, x.invNo, x.cust, x.outcome, x.refund]), [['rt1', 2, 'Ben Cruz', 'Restock', 100], ['rt3', 2, 'Ben Cruz', 'Write-off', 0], ['rt9', 2, 'Ben Cruz', 'Restock', 100]]);
r = add([ret('rt1', 'T0002', 1, 'Restock'), ret('rt8', 'T0002', 1, 'Restock')]);
assert.ok(res(r).rrt1.ok); assert.match(res(r).rrt8.error, /Only 0 of/); assert.equal(full().rows, rowsBefore + 2);

// 18. a renumbered toy carries its documents with it; a refused toy blocks them
r = add([{ ...item('T0001', 'Gigo Luffy'), auto: true }, order('so9', 'T0001', 3), invoice('inv9', 20, [{ sku: 'T0001', qty: 1, price: 900 }]),
  { ...item('T0888', 'Gigo Luffy'), id: 'dupname2' }, order('so10', 'T0888', 1)]);
let z18 = res(r), luffy = z18.iT0001.sku;
assert.ok(luffy && luffy !== 'T0001' && z18.oso9.ok && z18.vinv9.ok);
assert.equal(r.sync.orders.find(o => o.id === 'so9').sku, luffy); assert.equal(r.sync.invs.find(i => i.id === 'inv9').lines[0].sku, luffy);
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
// A sheet set up before the Inbox tab existed: sync and inboxDone still work
sb.sheets.splice(sb.sheets.indexOf(ib), 1);
assert.deepEqual(full().inbox, []);
r = add([{ id: 'ib6', kind: 'inboxDone', rows: [{ row: 2, name: 'Grandista Son Goku' }], mark: 'Done' }, move('ib7', 'T0002', 'In', 1, 'Restock')]);
assert.ok(r.results.every(x => x.ok), 'no Inbox tab: entries still apply'); assert.deepEqual(r.sync.inbox, []);
vm.runInContext('setup()', sb); assert.ok(sheet('Inbox') && sheet('Inbox').textCols.has(12), 'setup adds the Inbox tab again, columns as text');

// 20. nothing internal leaks, and unknown kinds are refused
assert.ok(!JSON.stringify(full()).includes('"_row"') && !JSON.stringify(full()).includes('"_dirty"'));
assert.match(add([{ id: 'u1', kind: 'nuke' }]).results[0].error, /Unknown entry type/);
// ---------- 2.2: writes find rows by key, On hand is a number, Browse, Edits, warnings ----------
function bench() {
  const b = load(), k = b.props.KEY;
  const c = (action, extra = {}) => { b.__e = { postData: { contents: JSON.stringify({ key: k, action, ...extra }) } }; return JSON.parse(vm.runInContext('doPost(__e)', b).text); };
  const fullB = () => c('sync', { have: { rows: 0 } }).data;
  const addB = entries => { const s = fullB(); return c('add', { have: { rows: s.rows, lastId: s.lastId, moveRev: s.moveRev }, entries }).data; };
  return { b, c, full: fullB, add: addB, sheet: n => b.sheets.find(x => x.name === n) };
}
const edit = (id, sku, patch) => ({ id, kind: 'edit', sku, patch });
const MSG = (tab, key, what) => `The ${tab} tab was changed in Google Sheets (${key} ${what}). Nothing was written for this entry; fix the tab and sync again.`;
const W = bench();
const names = () => Object.fromEntries(W.sheet('Items').rowsOf().map(r => [r[0], r[1]]));
const G = () => Object.fromEntries(W.sheet('Items').rowsOf().map(r => [r[0], r[6]]));
r = W.add(['A', 'B', 'C', 'D', 'E', 'F'].map((x, i) => item('S' + i, 'Item ' + x)).concat([move('o1', 'S0', 'In', 5, 'Opening'), move('o2', 'S1', 'In', 2, 'Opening'), move('o3', 'S2', 'In', 7, 'Opening')]));
assert.ok(r.results.every(x => x.ok)); assert.deepEqual(r.warnings, []); assert.deepEqual(r.sync.warnings, []);

// (a) the owner sorts Items between two requests: an edit still lands on its SKU
W.sheet('Items').putRows(W.sheet('Items').rowsOf().reverse());
let want = names();
r = W.add([edit('a1', 'S2', { name: 'Item C renamed', price: 5 }), edit('a2', 's4', { cat: 'Lower' })]);
assert.ok(r.results.every(x => x.ok)); want.S2 = 'Item C renamed';
assert.deepEqual(names(), want, 'every row keeps its own item');
let rowS2 = W.sheet('Items').rowsOf().find(x => x[0] === 'S2'), rowS4 = W.sheet('Items').rowsOf().find(x => x[0] === 'S4');
assert.deepEqual([rowS2[1], rowS2[3], rowS2[6], rowS4[1], rowS4[2]], ['Item C renamed', 5, 7, 'Item E', 'Lower'], 'whole row written on the right SKU, SKU matched without case');

// (b) rows move between the read and the write inside one request
let fired = 0;
W.b.ss.onSetValues = sh => { if (sh.name === 'Items' && !fired++) { const rows = sh.rowsOf(); sh.putRows([rows[3], rows[0], rows[5], rows[1], rows[4], rows[2]]); } };
const writesBefore = W.sheet('Items').writes;
r = W.add([edit('b1', 'S0', { name: 'Item A2' }), edit('b2', 'S5', { name: 'Item F2' }), edit('b3', 'S3', { name: 'Item D2' }), move('b4', 'S5', 'In', 1, 'Restock')]);
W.b.ss.onSetValues = null;
assert.equal(fired > 0, true, 'the hook fired'); assert.ok(r.results.every(x => x.ok), JSON.stringify(r.results));
Object.assign(want, { S0: 'Item A2', S5: 'Item F2', S3: 'Item D2' });
assert.deepEqual(names(), want, 'the shuffle in the middle sends no edit to a wrong row');
assert.ok(W.sheet('Items').writes - writesBefore <= 5, 'one call per changed row, plus On hand');
assert.equal(G().S5, 1, 'On hand follows the SKU after the shuffle');
// a row deleted in the middle: that entry is refused, the others still apply (S1 is put last so it is written after the hook)
const lastFirst = (sh, key) => sh.putRows(sh.rowsOf().filter(x => x[0] !== key).concat(sh.rowsOf().filter(x => x[0] === key)));
lastFirst(W.sheet('Items'), 'S1'); fired = 0;
W.b.ss.onSetValues = sh => { if (sh.name === 'Items' && !fired++) sh.putRows(sh.rowsOf().filter(x => x[0] !== 'S1')); };
r = W.add([edit('b5', 'S0', { name: 'Item A3' }), edit('b6', 'S1', { name: 'Item B3' }), move('b7', 'S0', 'In', 2, 'Restock')]);
W.b.ss.onSetValues = null;
let rb = res(r);
assert.ok(rb.b5.ok && rb.qb7.ok); assert.equal(rb.b6.error, MSG('Items', 'S1', 'not found'));
assert.ok(!Object.values(names()).includes('Item B3'), 'the refused edit is written nowhere');
assert.equal(names().S0, 'Item A3'); assert.equal(G().S0, 7);
W.add([item('S1', 'Item B')]);   // put the deleted row back for the later cases

// (c) a duplicated SKU is reported and refused; a missing one too; other entries in the same request apply
const items0 = W.sheet('Items').rowsOf();
W.sheet('Items').putRows(items0.concat([items0.find(x => x[0] === 'S2')]));
assert.deepEqual(W.full().warnings, ['Items: SKU S2 appears on 2 rows. The first is used.']);
assert.equal(W.full().items.filter(i => i.sku === 'S2').length, 1, 'the app gets the first row only');
r = W.add([edit('c1', 'S2', { name: 'Item C again' }), edit('c2', 'S3', { price: 9 }), move('c3', 'S2', 'In', 1, 'Restock')]);
let rc = res(r);
assert.equal(rc.c1.error, MSG('Items', 'S2', 'appears twice')); assert.ok(rc.c2.ok && rc.qc3.ok);
assert.deepEqual(r.warnings, ['Items: SKU S2 appears on 2 rows. The first is used.'], 'add carries the warning too');
assert.equal(W.sheet('Items').rowsOf().filter(x => x[1] === 'Item C again').length, 0, 'neither copy was written');
assert.ok(W.sheet('Items').rowsOf().filter(x => x[0] === 'S2').every(x => x[6] === 8), 'On hand on both copies');
W.sheet('Items').putRows(W.sheet('Items').rowsOf().filter((x, i, all) => all.findIndex(y => y[0] === x[0]) === i));
assert.deepEqual(W.full().warnings, []);

// (d) the same for a Pre-orders row, and an entry refused there writes nothing anywhere
W.add([{ id: 'dk', kind: 'cust', cust: { id: 'c1', name: 'Ana', contact: '0917' } }]);
const preD = (id, no) => ({ id: 'p' + id, kind: 'pre', pre: { id, date: '2026-11-12', custId: 'c1', sku: 'S0', qty: 1, price: 100, paid: 10, note: '', invId: 'r-' + id, no } });
r = W.add([preD('d1', 1), preD('d2', 2), preD('d3', 3), preD('d4', 4)]); assert.ok(r.results.every(x => x.ok));
const preRows = () => Object.fromEntries(W.sheet('Pre-orders').rowsOf().map(x => [x[0], x]));
W.sheet('Pre-orders').putRows(W.sheet('Pre-orders').rowsOf().reverse());
r = W.add([{ id: 'dp2', kind: 'prePay', preId: 'd2', paid: 60 }]); assert.ok(r.results[0].ok);
assert.deepEqual([preRows().d2[9], preRows().d2[10], preRows().d1[9], preRows().d3[9]], [60, 40, 10, 10], 'payment on the right pre-order after a sort');
fired = 0;
W.b.ss.onSetValues = sh => { if (sh.name === 'Pre-orders' && !fired++) { const rows = sh.rowsOf(); sh.putRows([rows[2], rows[0], rows[3], rows[1]]); } };
r = W.add([{ id: 'dp1', kind: 'prePay', preId: 'd1', paid: 20 }, { id: 'dp3', kind: 'prePay', preId: 'd3', paid: 30 }, { id: 'dc4', kind: 'preCancel', preId: 'd4', kept: 5 }]);
W.b.ss.onSetValues = null;
assert.ok(fired && r.results.every(x => x.ok)); assert.deepEqual([preRows().d1[9], preRows().d3[9], preRows().d4[11], preRows().d4[12], preRows().d2[9]], [20, 30, 'Cancelled', 5, 60], 'rows moved mid-request still get their own changes');
const pr0 = W.sheet('Pre-orders').rowsOf();
W.sheet('Pre-orders').putRows(pr0.concat([pr0.find(x => x[0] === 'd1')]));
const movesBefore = W.full().rows, invsBefore = W.sheet('Invoices').rowsOf().length;
r = W.add([{ id: 'dp1b', kind: 'prePay', preId: 'd1', paid: 50 }, { id: 'vd', kind: 'invoice', invoice: { id: 'sale-d1', no: 9, date: '2026-11-15', custId: 'c1', lines: [{ sku: 'S0', qty: 1, price: 100 }], preId: 'd1' } }, { id: 'dp3b', kind: 'prePay', preId: 'd3', paid: 40 }]);
let rd = res(r);
assert.equal(rd.dp1b.error, MSG('Pre-orders', 'd1', 'appears twice')); assert.equal(rd.vd.error, MSG('Pre-orders', 'd1', 'appears twice')); assert.ok(rd.dp3b.ok);
assert.equal(W.full().rows, movesBefore, 'the refused invoice wrote no movement'); assert.equal(W.sheet('Invoices').rowsOf().length, invsBefore, 'and no invoice row');
assert.ok(W.sheet('Pre-orders').rowsOf().filter(x => x[0] === 'd1').every(x => x[9] === 20 && x[11] === 'Open'), 'neither copy of d1 changed');
assert.equal(preRows().d3[9], 40);
lastFirst(W.sheet('Pre-orders'), 'd3'); fired = 0;
W.b.ss.onSetValues = sh => { if (sh.name === 'Pre-orders' && !fired++) sh.putRows(sh.rowsOf().filter(x => x[0] !== 'd3')); };
r = W.add([{ id: 'dp2c', kind: 'prePay', preId: 'd2', paid: 70 }, { id: 'dp3c', kind: 'prePay', preId: 'd3', paid: 50 }]);
W.b.ss.onSetValues = null;
assert.ok(res(r).dp2c.ok); assert.equal(res(r).dp3c.error, MSG('Pre-orders', 'd3', 'not found'));
assert.ok(!W.sheet('Pre-orders').rowsOf().some(x => x[9] === 50), 'the refused payment was written nowhere');
W.sheet('Pre-orders').putRows(W.sheet('Pre-orders').rowsOf().filter((x, i, all) => all.findIndex(y => y[0] === x[0]) === i));

// (e) On hand is a number per SKU, right after every add, with no formula
const stockNow = () => { const m = {}; W.full().moves.forEach(x => { m[x.sku] = (m[x.sku] || 0) + (x.dir === 'In' ? x.qty : -x.qty); }); return m; };
W.add([move('e1', 'S0', 'Out', 2, 'Sale'), move('e2', 'S4', 'In', 3, 'Restock'), item('S9', 'Item New')]);
const st = stockNow();
assert.deepEqual(G(), Object.fromEntries(Object.keys(names()).map(k => [k, st[k] || 0])), 'On hand matches the movements for every row');
assert.deepEqual(W.sheet('Items').formulas, {}); assert.equal(G().S9, 0);

// (f) Browse: every item with its numbers, rewritten on add and on sync; a filter stays
W.add([{ id: 'f1', kind: 'order', order: { id: 'fo1', date: '2026-11-10', sku: 'S5', qty: 4, expected: '', note: '' } }, move('f2', 'S5', 'In', 2, 'Restock', { cost: 100 }), move('f3', 'S5', 'In', 2, 'Restock', { cost: 200 }), move('f4', 'S5', 'Out', 1, 'Sale'), preD('f5', 20)]);
W.add([{ ...preD('f6', 21), pre: { ...preD('f6', 21).pre, sku: 'S5', qty: 2, paid: 0 } }]);
const br = W.sheet('Browse');
assert.equal(br.frozen, 1);
assert.deepEqual(br.getRange(1, 1, 1, 19).getValues()[0], ['SKU', 'Name', 'Category', 'Price', 'Reorder at', 'Active', 'On hand', 'Incoming', 'Owed', 'Left to promise', 'Unit costs', 'Stock value at cost', 'Units without cost', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Release check']);
let bs = Object.fromEntries(br.rowsOf().map(x => [x[0], x]));
assert.equal(Object.keys(bs).length, Object.keys(names()).length, 'one row per item');
assert.deepEqual(bs.S5.slice(6, 13), [4, 4, 2, 6, '100, 100, 200, 200', 600, 0], 'on hand, incoming, owed, left to promise, unit costs (the sale took the uncosted unit, the oldest), stock value, units without cost');
assert.deepEqual(bs.S2.slice(0, 6), ['S2', 'Item C renamed', 'Cars', 5, 2, 'Yes']); assert.deepEqual(bs.S2.slice(10, 13), ['?, ?, ?, ?, ?, ?, ?, ?', 0, 8], 'a unit without a cost shows as ?');
assert.deepEqual(bs.S9.slice(6, 13), [0, 0, 0, 0, '', '', ''], 'nothing on hand leaves the cost columns blank');
assert.ok(br.textCols.has(11), 'Unit costs is a text column');
br.filter = { range: 'A1:R' };
W.sheet('Items').set(2, 2, 'Typed in the sheet');
W.full(); bs = Object.fromEntries(br.rowsOf().map(x => [x[0], x]));
assert.ok(br.rowsOf().some(x => x[1] === 'Typed in the sheet'), 'sync rewrites Browse'); assert.deepEqual(br.filter, { range: 'A1:R' }, 'the filter stays');
assert.equal(br.getLastRow(), Object.keys(names()).length + 1, 'nothing left below the last item');

// (g) the Edits tab: applied as edit entries at the start of a sync or add, Done or Refused with the reason
const ed = W.sheet('Edits');
assert.deepEqual(ed.getRange(1, 1, 1, 5).getValues()[0], ['SKU', 'Field', 'New value', 'Status', 'Note']);
assert.deepEqual(ed.validation.rule.list, ['Name', 'Category', 'Price', 'Reorder at', 'Active', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Release check']);
[['s3', 'Price', '300', '', ''], ['S4', 'Colour', 'red', '', ''], ['T9999', 'Name', 'Ghost', '', ''], ['S5', 'Active', 'maybe', '', ''], ['S9', 'Name', 'Item A3', '', ''],
 ['S9', 'Product line', '=Line', '', ''], ['S9', 'Release check', 'Verify', '', ''], ['S0', 'Name', 'Old row', 'Done', ''], ['', 'Price', '5', '', '']].forEach((v, i) => v.forEach((x, j) => { if (x !== '') ed.set(i + 2, j + 1, x); }));
let sy = W.full(), its = Object.fromEntries(sy.items.map(i => [i.sku, i]));
const edCol = c => ed.rowsOf().map(x => x[c] === undefined ? '' : x[c]);
assert.deepEqual(edCol(3), ['Done', 'Refused', 'Refused', 'Refused', 'Refused', 'Done', 'Done', 'Done', 'Refused']);
assert.deepEqual(edCol(4).map(n => n.split(' ').slice(0, 3).join(' ')), ['', 'Field must be', 'Unknown item T9999', 'Active must be', 'An item named', '', '', '', 'SKU is required']);
assert.deepEqual([its.S3.price, its.S9.line, its.S9.relCheck, its.S0.name], [300, '=Line', true, 'Item A3'], 'applied rows reach Items; a Done row is not applied again');
assert.equal(Object.fromEntries(W.sheet('Browse').rowsOf().map(x => [x[0], x])).S3[3], 300, 'Browse shows the edit at once');
ed.set(11, 1, 'S1'); ed.set(11, 2, 'Brand'); ed.set(11, 3, 'Tomica');
r = W.add([move('g1', 'S1', 'In', 1, 'Restock')]);
assert.deepEqual(r.results.map(x => x.id), ['qg1'], 'Edits results stay out of the reply to the app');
assert.equal(ed.cell(11, 4), 'Done'); assert.equal(r.sync.items.find(i => i.sku === 'S1').brand, 'Tomica');
// an Edits row moved by a sort before its status is written is still found
ed.set(12, 1, 'S2'); ed.set(12, 2, 'Brand'); ed.set(12, 3, 'Gigo');
fired = 0; W.b.ss.onSetValues = sh => { if (sh.name === 'Items' && !fired++) ed.putRows(ed.rowsOf().reverse()); };
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
const tabsH = ['Items', 'Movements', 'Customers', 'Supplier orders', 'Pre-orders', 'Invoices', 'Invoice lines', 'Returns', 'Inbox'];
const snap = () => Object.fromEntries(tabsH.map(n => [n, W.sheet(n).rowsOf()]));
const prot = () => tabsH.slice(0, 8).map(n => W.sheet(n).getProtections().map(p => [p.desc, p.warn]));
const beforeH = snap();
vm.runInContext('setup()', W.b);
assert.deepEqual(prot(), tabsH.slice(0, 8).map(() => [['Used by the app. Sort and filter in the Browse tab; change fields in the Edits tab.', true]]), 'warning-only protection on the app tabs');
assert.deepEqual(W.sheet('Inbox').getProtections(), [], 'the Inbox stays open for Claude');
assert.deepEqual(snap(), beforeH, 'every cell kept');

// ---------- 2.3: units first in, first out, a cost per unit, cost entries, moveRev, wipe ----------
const U = bench();
const brU = sku => U.sheet('Browse').rowsOf().find(x => x[0] === sku).slice(6, 13);
const onHandU = sku => U.sheet('Items').rowsOf().find(x => x[0] === sku)[6];
r = U.add([item('U1', 'Unit One'), item('U2', 'Unit Two'), item('U3', 'Unit Three'), item('U4', 'Unit Four'), { id: 'uk', kind: 'cust', cust: { id: 'cu', name: 'Cora', contact: '0917' } }]);
assert.ok(r.results.every(x => x.ok));

// (i) a sale below zero, then receipts: the first unit to arrive covers the deficit, the rest go on hand
r = U.add([move('n1', 'U2', 'Out', 2, 'Sale'), move('n2', 'U2', 'In', 1, 'Restock', { cost: 50 })]);
assert.deepEqual([onHandU('U2'), brU('U2')], [-1, [-1, 0, 0, -1, '', '', '']], 'still below zero: no unit on hand');
r = U.add([move('n3', 'U2', 'In', 1, 'Restock', { cost: 60 }), move('n4', 'U2', 'In', 1, 'Restock', { cost: 70 })]);
assert.deepEqual([onHandU('U2'), brU('U2')], [1, [1, 0, 0, 1, '70', 70, 0]], 'the deficit took the units at 50 and 60');

// (j) a Correction reversing an In takes that In's unit, not the oldest; once it is gone, a Correction takes the oldest
r = U.add([move('a1', 'U4', 'In', 1, 'Opening', { cost: 10 }), move('a2', 'U4', 'In', 1, 'Restock', { cost: 20 }), move('a3', 'U4', 'In', 1, 'Restock', { cost: 30 }),
  move('a4', 'U4', 'Out', 1, 'Correction', { ref: 'a2' })]);
assert.deepEqual(brU('U4'), [2, 0, 0, 2, '10, 30', 40, 0]);
r = U.add([move('a5', 'U4', 'Out', 1, 'Correction', { ref: 'a2' })]);
assert.deepEqual(brU('U4'), [1, 0, 0, 1, '30', 30, 0]);
r = U.add([move('a6', 'U4', 'In', 2, 'Restock', { cost: 5 }), move('a7', 'U4', 'Out', 3, 'Correction', { ref: 'a6' })]);
assert.deepEqual([onHandU('U4'), brU('U4')[4]], [0, ''], 'a read In of Qty 2 is two units; the third unit of the Correction comes from the front');

// (k) four units received at four costs, then two sales: each line keeps the cost the app sent, the two newest units stay, oldest first
const saleU = (id, no, lines) => ({ id: 'v' + id, kind: 'invoice', invoice: { id, no, date: '2026-11-16', custId: 'cu', lines } });
r = U.add([{ id: 'uo', kind: 'order', order: { id: 'uo1', date: '2026-11-10', sku: 'U1', qty: 4, expected: '', note: '' } },
  { id: 'ur', kind: 'receive', orderId: 'uo1', date: '2026-11-14', qty: 4, costs: [100, 200, 300, 400] }]);
assert.ok(r.results.every(x => x.ok));
assert.deepEqual(U.sheet('Movements').rowsOf().filter(x => x[7] === 'uo1').map(x => [x[0], x[5], x[9]]), [['rcv-uo1-1', 1, 100], ['rcv-uo1-2', 1, 200], ['rcv-uo1-3', 1, 300], ['rcv-uo1-4', 1, 400]]);
assert.deepEqual(brU('U1'), [4, 0, 0, 4, '100, 200, 300, 400', 1000, 0]);
r = U.add([saleU('us1', 1, [{ sku: 'U1', qty: 1, price: 500, cost: 100 }]), saleU('us2', 2, [{ sku: 'U1', qty: 1, price: 500, cost: 150 }])]);
assert.ok(r.results.every(x => x.ok));
assert.deepEqual(U.sheet('Invoice lines').rowsOf().map(x => [x[0], x[7]]), [[1, 100], [2, 150]], 'the line cost is written as the app sent it');
assert.deepEqual(U.sheet('Movements').rowsOf().filter(x => x[6] === 'Sale' && x[2] === 'U1').map(x => [x[0], x[9]]), [['us1-1', 100], ['us2-1', 150]], 'and the same on the Sale movement');
assert.deepEqual([onHandU('U1'), brU('U1')], [2, [2, 0, 0, 2, '300, 400', 700, 0]], 'the two oldest units left');

// (l) a Restock return writes one row per unit at the cost of the first line of that item on the invoice, at the back of the queue
r = U.add([move('t1', 'U3', 'In', 1, 'Opening', { cost: 80 }), move('t2', 'U3', 'In', 1, 'Opening', { cost: 90 }), move('t3', 'U3', 'In', 1, 'Opening', { cost: 95 }),
  saleU('us3', 3, [{ sku: 'U3', qty: 1, price: 200, cost: 80 }, { sku: 'U3', qty: 1, price: 200, cost: 90 }])]);
r = U.add([{ id: 'ut', kind: 'ret', ret: { id: 'urt', date: '2026-11-17', invId: 'us3', sku: 'U3', qty: 2, outcome: 'Restock', refund: 0, note: '' } }]);
assert.ok(r.results[0].ok);
assert.deepEqual(U.sheet('Movements').rowsOf().filter(x => x[7] === 'urt').map(x => x.slice(0, 10)), [1, 2].map(k => ['ret-urt-' + k, '2026-11-17', 'U3', 'Unit Three', 'In', 1, 'Return', 'urt', 'Invoice 3', 80]));
assert.deepEqual(brU('U3'), [3, 0, 0, 3, '95, 80, 80', 255, 0]);

// (m) a cost changed on a unit on hand: column J only, Browse, moveRev raised, and a second device gets every movement again
const costE = (id, moveId, cost) => ({ id, kind: 'cost', moveId, cost });
const mvRow = (b, id) => b.sheet('Movements').rowsOf().find(x => x[0] === id);
const s0 = U.full(), rowBefore = mvRow(U, 'rcv-uo1-4');
r = U.c('add', { have: { rows: s0.rows, lastId: s0.lastId, moveRev: s0.moveRev }, entries: [costE('cc1', 'rcv-uo1-4', 450)] }).data;
assert.ok(r.results[0].ok);
assert.deepEqual(mvRow(U, 'rcv-uo1-4'), rowBefore.slice(0, 9).concat(450, rowBefore.slice(10)), 'only Unit cost changed');
assert.deepEqual(brU('U1'), [2, 0, 0, 2, '300, 450', 750, 0]);
assert.equal(r.sync.moveRev, s0.moveRev + 1, 'a cost write raises moveRev');
assert.deepEqual([r.sync.reset, r.sync.moves.length, r.sync.moves.find(m => m.id === 'rcv-uo1-4').cost], [true, s0.rows, 450], 'the reply carries every movement');
let s1 = U.c('sync', { have: { rows: s0.rows, lastId: s0.lastId, moveRev: s0.moveRev } }).data;
assert.deepEqual([s1.reset, s1.moves.length, s1.moves.find(m => m.id === 'rcv-uo1-4').cost], [true, s0.rows, 450], 'a device holding the old moveRev gets everything');
s1 = U.c('sync', { have: { rows: s1.rows, lastId: s1.lastId, moveRev: s1.moveRev } }).data;
assert.deepEqual([s1.reset, s1.moves.length], [false, 0], 'and then syncs incrementally again');
r = U.add([costE('cc1', 'rcv-uo1-4', 450), costE('cc2', 'rcv-uo1-3', null)]);
assert.ok(r.results.every(x => x.ok)); assert.equal(r.sync.moveRev, s0.moveRev + 2, 'a retry writes nothing; clearing a cost is a write');
assert.equal(mvRow(U, 'rcv-uo1-3')[9], ''); assert.deepEqual(brU('U1'), [2, 0, 0, 2, '?, 450', 450, 1]);
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
assert.deepEqual([mvRow(U, 'rcv-uo1-3')[9], brU('U1')[4], brU('U2')[4]], ['', '450', '75, 6']);

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

// (p) wipeAllData(): a backup first, then every row under the header goes on the listed tabs; key, tabs, formatting and Inbox stay
const ibU = U.sheet('Inbox');
[['Done', 'Done Row'], ['Dismissed', 'Dismissed Row'], ['Working', 'Working Row'], ['', 'Waiting Row'], ['Done', 'Done Too']].forEach(([st, name], i) =>
  ['2026-11-15', 'Count', name, '1', '', '', '', '', '', '', '', '', st].forEach((v, j) => { if (v) ibU.set(i + 2, j + 1, v); }));
U.sheet('Edits').set(2, 1, 'U1'); U.sheet('Edits').set(2, 2, 'Price'); U.sheet('Edits').set(2, 3, '5'); U.sheet('Edits').set(2, 4, 'Done');
U.add([{ id: 'up', kind: 'pre', pre: { id: 'upo', date: '2026-11-12', custId: 'cu', sku: 'U4', qty: 1, price: 100, paid: 0, note: '', invId: 'r-upo', no: 9 } }]);
const wiped = ['Items', 'Movements', 'Customers', 'Supplier orders', 'Pre-orders', 'Invoices', 'Invoice lines', 'Returns', 'Edits', 'Browse'];
const heads = () => wiped.map(n => U.sheet(n).getRange(1, 1, 1, 19).getValues()[0]);
const sW = U.full(), keyW = U.b.props.KEY, inboxW = ibU.rowsOf(), headsW = heads();
assert.ok(wiped.every(n => U.sheet(n).getLastRow() > 1), 'every listed tab has rows before the wipe');
vm.runInContext('wipeAllData()', U.b);
assert.deepEqual(U.b.copies.map(c => c.name), ['Bodega backup ' + new Date().toISOString().slice(0, 10)]);
assert.ok(Object.values(U.b.copies[0].sheets.find(s => s.name === 'Movements').cells).includes('rcv-uo1-4'), 'the backup was made before the wipe');
assert.deepEqual(wiped.map(n => U.sheet(n).getLastRow()), wiped.map(() => 1), 'nothing left under the headers'); assert.deepEqual(heads(), headsW, 'headers kept');
assert.deepEqual(ibU.rowsOf(), inboxW, 'Inbox kept'); assert.equal(U.b.props.KEY, keyW, 'key kept');
assert.ok(U.sheet('Movements').textCols.has(1) && U.sheet('Edits').validation && U.sheet('Items').getProtections().length === 1, 'formatting, the dropdown and the protection stay');
const sAfter = U.c('sync', { have: { rows: sW.rows, lastId: sW.lastId, moveRev: sW.moveRev } }).data;
assert.deepEqual([sAfter.moveRev, sAfter.reset, sAfter.rows, sAfter.moves, sAfter.items, sAfter.invs], [sW.moveRev + 1, true, 0, [], [], []], 'a phone syncing after the wipe gets the empty sheet');
r = U.add([item('W1', 'After Wipe'), { id: 'wk', kind: 'cust', cust: { id: 'cu', name: 'Cora', contact: '0917' } }, saleU('w1', 1, [{ sku: 'W1', qty: 1, price: 10 }])]);
assert.deepEqual([r.results[2].ok, r.results[2].no, r.results[2].fromNo], [true, 1, undefined], 'invoice numbers start again at 1');

// (q) reopenInbox(): Done rows come back for review; Dismissed and Working stay
vm.runInContext('reopenInbox()', U.b);
assert.deepEqual(ibU.rowsOf().map(x => [x[2], x[12]]), [['Done Row', undefined], ['Dismissed Row', 'Dismissed'], ['Working Row', 'Working'], ['Waiting Row', undefined], ['Done Too', undefined]]);
assert.deepEqual(U.full().inbox.map(x => x.name), ['Done Row', 'Waiting Row', 'Done Too']);
console.log('backend tests passed');
