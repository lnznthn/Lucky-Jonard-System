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

// ---------- v2: toy details, receipt cost, customers, supplier orders, pre-orders, invoices, returns ----------
const sheet = n => sb.sheets.find(s => s.name === n);
const add = entries => { const s = call('sync', { have: { rows: 0 } }).data; return call('add', { have: { rows: s.rows, lastId: s.lastId }, entries }).data; };
const res = d => Object.fromEntries(d.results.map(x => [x.id, x]));
const full = () => call('sync', { have: { rows: 0 } }).data;
['Customers', 'Supplier orders', 'Pre-orders', 'Invoices', 'Invoice lines', 'Returns'].forEach(n => assert.ok(sheet(n), n + ' tab exists'));

// 9. toy details: stored, patched, validated; On hand formula column is never written
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
assert.ok(sheet('Items').formulas['2,7'].startsWith('=ARRAYFORMULA'), 'On hand formula survives item writes');
for (let row = 3; row <= sheet('Items').getLastRow(); row++) assert.equal(sheet('Items').cell(row, 7), undefined, 'column G untouched on row ' + row);

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
r = add([{ id: 'rc1', kind: 'receive', orderId: 'so1', date: '2026-11-14', qty: 5, cost: 1300 }, { id: 'oc2', kind: 'orderCancel', orderId: 'so2' }, { id: 'rc2', kind: 'receive', orderId: 'so2', date: '2026-11-14', qty: 2, cost: 1 }, { id: 'oc1', kind: 'orderCancel', orderId: 'so1' }]);
assert.ok(res(r).rc1.ok && res(r).oc2.ok); assert.match(res(r).rc2.error, /cancelled/); assert.match(res(r).oc1.error, /already received/);
let rcv = full().moves.find(m => m.id === 'rcv-so1');
assert.deepEqual([rcv.sku, rcv.dir, rcv.qty, rcv.reason, rcv.ref, rcv.cost], ['T0100', 'In', 5, 'Restock', 'so1', 1300]);
assert.deepEqual(full().orders.map(o => [o.status, o.recQty, o.recDate]), [['Received', 5, '2026-11-14'], ['Cancelled', null, '']]);
r = add([{ id: 'rc1', kind: 'receive', orderId: 'so1', date: '2026-11-15', qty: 9, cost: 1 }, order('so1', 'T0100', 6)]);
assert.ok(r.results.every(x => x.ok)); assert.equal(full().rows, rowsBefore + 1, 'receiving twice adds one movement');

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
assert.deepEqual(back.map(m => [m.id, m.sku, m.dir, m.qty, m.ref]), [['ret-rt1', 'T0002', 'In', 1, 'rt1'], ['ret-rt9', 'T0100', 'In', 1, 'rt9']], 'restock comes back in, write-off does not');
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
console.log('backend tests passed');
