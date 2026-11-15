/**
 * Toy Stock API: a Google Apps Script web app bound to the "Toy Inventory" spreadsheet.
 *
 * Install: Extensions > Apps Script, paste this whole file over Code.gs, save, run setup() once,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * The app talks to the deployment URL with a shared key; see README.md and ARCHITECTURE.md.
 *
 * The app is the only writer. Movements, invoice lines and returns are append-only. Items, customers,
 * supplier orders, pre-orders and invoices are one row each; only their status-type fields change later.
 */
var VERSION_ = '2.0.0';
var ITEM_HEAD_ = ['SKU', 'Name', 'Category', 'Price', 'Reorder at', 'Active', 'On hand', 'Manufacturer', 'Brand', 'Toy line', 'Character', 'Release date', 'Release check'];
var MOVE_HEAD_ = ['ID', 'Date', 'SKU', 'Item', 'Direction', 'Qty', 'Reason', 'Ref', 'Note', 'Unit cost'];
var IN_ONLY_ = ['Opening', 'Restock', 'Return'];
var OUT_ONLY_ = ['Sale', 'Damaged', 'Lost'];
var EITHER_ = ['Count', 'Correction', 'Other'];
var SHIP_ = ['', 'Delivered'];
var PRE_OPEN_ = 'Open', PRE_DONE_ = 'Fulfilled', PRE_CANCEL_ = 'Cancelled';
var TYPE_SALE_ = 'Sale', TYPE_RECEIPT_ = 'Pre-order receipt';
// What a return does to stock, per outcome: 'In' writes a Return movement, null writes none.
// Change it here and in index.html together.
var RETURN_STOCK_ = { 'Restock': 'In', 'Write-off': null };
// Rows Claude writes after reading photos. The app shows them under Import and marks them Done or Dismissed.
// This is the one tab the app does not write first; nothing in it counts as stock until the app applies it.
var INBOX_HEAD_ = ['Added', 'Type', 'Name', 'Qty', 'Cost each', 'Manufacturer', 'Brand', 'Toy line', 'Character', 'Release date', 'Verify', 'Note', 'Status'];
// One formula in Items!G2 fills the whole On hand column, so new items need no formula copying.
var ON_HAND_ = '=ARRAYFORMULA(IF(LEN(A2:A), SUMIFS(Movements!F:F, Movements!C:C, A2:A, Movements!E:E, "In") - SUMIFS(Movements!F:F, Movements!C:C, A2:A, Movements!E:E, "Out"), ))';

function s_(v) { return String(v == null ? '' : v).trim(); }
function num_(v) { if (v === '' || v == null) return null; var n = Number(v); return isNaN(n) ? null : n; }
function blank_(v) { return v == null ? '' : v; }

/**
 * The document tabs. Each has a header row, the columns to keep as plain text (so a phone number such as
 * +63917... or a note starting with "=" is stored as typed), and the mapping between a row and an object.
 */
var T_ = {
  cust: { name: 'Customers', head: ['ID', 'Name', 'Contact'], text: ['A:C'],
    from: function (v) { return { id: s_(v[0]), name: s_(v[1]), contact: s_(v[2]) }; },
    to: function (o) { return [o.id, o.name, o.contact]; } },
  order: { name: 'Supplier orders', head: ['ID', 'Date', 'SKU', 'Item', 'Qty', 'Expected', 'Status', 'Received qty', 'Received on', 'Note'], text: ['A:D', 'F:G', 'I:J'],
    from: function (v) { return { id: s_(v[0]), date: dateStr_(v[1]), sku: s_(v[2]), name: s_(v[3]), qty: Number(v[4]), expected: dateStr_(v[5]), status: s_(v[6]), recQty: num_(v[7]), recDate: dateStr_(v[8]), note: String(v[9]) }; },
    to: function (o) { return [o.id, o.date, o.sku, o.name, o.qty, o.expected, o.status, blank_(o.recQty), o.recDate, o.note]; } },
  pre: { name: 'Pre-orders', head: ['ID', 'Date', 'Customer ID', 'Customer', 'Contact', 'SKU', 'Item', 'Qty', 'Price', 'Paid', 'Balance', 'Status', 'Kept', 'Receipt no', 'Invoice no', 'Note'], text: ['A:G', 'L:L', 'P:P'],
    from: function (v) { return { id: s_(v[0]), date: dateStr_(v[1]), custId: s_(v[2]), cust: s_(v[3]), contact: s_(v[4]), sku: s_(v[5]), name: s_(v[6]), qty: Number(v[7]), price: Number(v[8]), paid: Number(v[9]), balance: Number(v[10]), status: s_(v[11]), kept: num_(v[12]), recNo: num_(v[13]), invNo: num_(v[14]), note: String(v[15]) }; },
    to: function (o) { return [o.id, o.date, o.custId, o.cust, o.contact, o.sku, o.name, o.qty, o.price, o.paid, o.balance, o.status, blank_(o.kept), blank_(o.recNo), blank_(o.invNo), o.note]; } },
  inv: { name: 'Invoices', head: ['No', 'ID', 'Date', 'Type', 'Customer ID', 'Customer', 'Contact', 'Total', 'Shipping', 'Pre-order ID'], text: ['B:G', 'I:J'],
    from: function (v) { return { no: Number(v[0]), id: s_(v[1]), date: dateStr_(v[2]), type: s_(v[3]), custId: s_(v[4]), cust: s_(v[5]), contact: s_(v[6]), total: Number(v[7]), ship: s_(v[8]), preId: s_(v[9]) }; },
    to: function (o) { return [o.no, o.id, o.date, o.type, o.custId, o.cust, o.contact, o.total, o.ship, o.preId]; } },
  line: { name: 'Invoice lines', head: ['Invoice no', 'Invoice ID', 'SKU', 'Item', 'Qty', 'Listed price', 'Charged price', 'Unit cost'], text: ['B:D'],
    from: function (v) { return { invNo: Number(v[0]), invId: s_(v[1]), sku: s_(v[2]), name: s_(v[3]), qty: Number(v[4]), list: num_(v[5]), price: Number(v[6]), cost: num_(v[7]) }; },
    to: function (o) { return [o.invNo, o.invId, o.sku, o.name, o.qty, blank_(o.list), o.price, blank_(o.cost)]; } },
  ret: { name: 'Returns', head: ['ID', 'Date', 'Invoice no', 'Invoice ID', 'Customer', 'SKU', 'Item', 'Qty', 'Outcome', 'Refund', 'Note'], text: ['A:B', 'D:G', 'I:I', 'K:K'],
    from: function (v) { return { id: s_(v[0]), date: dateStr_(v[1]), invNo: Number(v[2]), invId: s_(v[3]), cust: s_(v[4]), sku: s_(v[5]), name: s_(v[6]), qty: Number(v[7]), outcome: s_(v[8]), refund: Number(v[9]), note: String(v[10]) }; },
    to: function (o) { return [o.id, o.date, o.invNo, o.invId, o.cust, o.sku, o.name, o.qty, o.outcome, o.refund, o.note]; } }
};

/** Run once. Creates the tabs, formats them, and makes the connection key. Safe to run again. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var items = ensureSheet_(ss, 'Items', ITEM_HEAD_);
  var moves = ensureSheet_(ss, 'Movements', MOVE_HEAD_);
  // Text columns stay text, so a SKU like 0012 or a note starting with "=" is never reinterpreted.
  items.getRange('A:C').setNumberFormat('@');
  items.getRange('F:F').setNumberFormat('@');
  items.getRange('H:M').setNumberFormat('@');
  items.getRange('D:D').setNumberFormat('#,##0.00');
  moves.getRange('A:E').setNumberFormat('@');
  moves.getRange('G:I').setNumberFormat('@');
  moves.getRange('J:J').setNumberFormat('#,##0.00');
  if (!items.getRange('G2').getFormula()) items.getRange('G2').setFormula(ON_HAND_);
  Object.keys(T_).forEach(function (k) {
    var sh = ensureSheet_(ss, T_[k].name, T_[k].head);
    T_[k].text.forEach(function (a1) { sh.getRange(a1).setNumberFormat('@'); });
  });
  ensureSheet_(ss, 'Inbox', INBOX_HEAD_).getRange('A:M').setNumberFormat('@');
  var first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KEY')) props.setProperty('KEY', Utilities.getUuid().replace(/-/g, ''));
  Logger.log('Setup done. Key: ' + props.getProperty('KEY'));
}

/** Prints the connection key in the execution log (View > Logs). */
function showKey() {
  Logger.log('Key: ' + PropertiesService.getScriptProperties().getProperty('KEY'));
}

function doGet() {
  return out_({ ok: true, data: { app: 'Toy Stock API', version: VERSION_ } });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request' }); }
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || body.key !== key) return out_({ ok: false, error: 'Wrong key', auth: true });
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return out_({ ok: false, error: 'The sheet is busy, try again' }); }
  try {
    switch (body.action) {
      case 'ping': return out_({ ok: true, data: { version: VERSION_ } });
      case 'sync': return out_({ ok: true, data: snapshot_(body.have) });
      case 'add': return out_({ ok: true, data: addEntries_(body.entries || [], body.have) });
      default: return out_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

// Keys starting with "_" are bookkeeping (sheet row, dirty flag) and never leave the script.
function out_(obj) {
  var text = JSON.stringify(obj, function (k, v) { return k.charAt(0) === '_' ? undefined : v; });
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// ---------- sheet helpers ----------

function ensureSheet_(ss, name, head) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}
function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('The "' + name + '" tab is missing. Run setup() again in the script editor.');
  return sh;
}
function itemsSheet_() { return sheet_('Items'); }
function movesSheet_() { return sheet_('Movements'); }

// Last row with something in column A. getLastRow() would count the On hand formula's spill.
function lastRowOf_(sh) {
  var n = sh.getMaxRows();
  var v = sh.getRange(1, 1, n, 1).getValues();
  for (var i = n - 1; i >= 1; i--) if (String(v[i][0]).trim() !== '') return i + 1;
  return 1;
}
function ensureRows_(sh, lastNeeded) {
  var max = sh.getMaxRows();
  if (lastNeeded > max) sh.insertRowsAfter(max, lastNeeded - max + 200);
}
function norm_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function dateStr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).trim();
}

function readItems_() {
  var sh = itemsSheet_();
  var last = lastRowOf_(sh);
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, ITEM_HEAD_.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (!String(v[0]).trim()) continue;
    out.push({ _row: i + 2, sku: s_(v[0]), name: s_(v[1]), cat: s_(v[2]), price: num_(v[3]), min: num_(v[4]), active: s_(v[5]).toLowerCase() !== 'no',
      mfr: s_(v[7]), brand: s_(v[8]), line: s_(v[9]), chr: s_(v[10]), rel: dateStr_(v[11]), relCheck: s_(v[12]).toLowerCase() === 'verify' });
  }
  return out;
}
// Column G (On hand) belongs to the formula, so an item row is written as two blocks around it.
function itemLeft_(it) { return [it.sku, it.name, it.cat, it.price == null ? '' : it.price, it.min == null ? '' : it.min, it.active ? 'Yes' : 'No']; }
function itemRight_(it) { return [it.mfr, it.brand, it.line, it.chr, it.rel, it.relCheck ? 'Verify' : '']; }

/** Inbox rows still waiting: a name and no status. Tolerates a sheet set up before the Inbox tab existed. */
function readInbox_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inbox');
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, INBOX_HEAD_.length).getValues(), out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (!s_(v[2]) || s_(v[12])) continue;
    out.push({ row: i + 2, added: dateStr_(v[0]), type: /^r/i.test(s_(v[1])) ? 'receive' : 'count', name: s_(v[2]), qty: s_(v[3]), cost: s_(v[4]), mfr: s_(v[5]), brand: s_(v[6]), line: s_(v[7]), chr: s_(v[8]), rel: dateStr_(v[9]), verify: s_(v[10]), note: s_(v[11]) });
  }
  return out;
}
function readTab_(k) {
  var t = T_[k], sh = sheet_(t.name);
  var last = lastRowOf_(sh);
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, t.head.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (!String(vals[i][0]).trim()) continue;
    var o = t.from(vals[i]); o._row = i + 2; out.push(o);
  }
  return out;
}
/** Rewrites the rows that changed and appends the new ones. */
function writeTab_(k, list) {
  var t = T_[k], sh = null, fresh = [];
  list.forEach(function (o) {
    if (!o._row) fresh.push(t.to(o));
    else if (o._dirty) { sh = sh || sheet_(t.name); sh.getRange(o._row, 1, 1, t.head.length).setValues([t.to(o)]); }
  });
  if (fresh.length) {
    sh = sh || sheet_(t.name);
    var start = lastRowOf_(sh) + 1;
    ensureRows_(sh, start + fresh.length - 1);
    sh.getRange(start, 1, fresh.length, t.head.length).setValues(fresh);
  }
}

// ---------- reading ----------

/**
 * Returns every item and document plus the movement rows the app does not have yet.
 * have = { rows, lastId } describes the movement rows the app already holds. If the sheet still has
 * that last row in the same place, only later rows are sent; otherwise everything is sent with reset = true.
 * Customers, supplier orders, pre-orders, invoices (with their lines), returns and waiting Inbox rows are always sent whole.
 */
function snapshot_(have) {
  var sh = movesSheet_();
  var rows = lastRowOf_(sh) - 1;
  var from = 0, reset = true;
  if (have && have.rows > 0 && have.rows <= rows && have.lastId) {
    if (String(sh.getRange(have.rows + 1, 1).getValue()) === String(have.lastId)) { from = have.rows; reset = false; }
  }
  var moves = [];
  if (rows > from) {
    var vals = sh.getRange(from + 2, 1, rows - from, MOVE_HEAD_.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (!String(v[0]).trim()) continue;
      moves.push({ id: s_(v[0]), date: dateStr_(v[1]), sku: s_(v[2]), dir: s_(v[4]), qty: Number(v[5]), reason: s_(v[6]), ref: s_(v[7]), note: String(v[8]), cost: num_(v[9]) });
    }
  }
  var lastId = rows > 0 ? String(sh.getRange(rows + 1, 1).getValue()) : '';
  var invs = readTab_('inv'), byInv = {};
  invs.forEach(function (x) { x.lines = []; byInv[x.id] = x; });
  readTab_('line').forEach(function (l) { if (byInv[l.invId]) byInv[l.invId].lines.push({ sku: l.sku, name: l.name, qty: l.qty, list: l.list, price: l.price, cost: l.cost }); });
  return { items: readItems_(), moves: moves, rows: rows, lastId: lastId, reset: reset, syncedAt: new Date().toISOString(),
    custs: readTab_('cust'), orders: readTab_('order'), pres: readTab_('pre'), invs: invs, rets: readTab_('ret'), inbox: readInbox_() };
}

// ---------- validation ----------

function text_(v, max) { return s_(v).slice(0, max); }
function date_(v, what) {
  var date = s_(v);
  var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  var dt = d ? new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])) : null;
  if (!dt || dt.getUTCFullYear() !== +d[1] || dt.getUTCMonth() !== +d[2] - 1 || dt.getUTCDate() !== +d[3]) throw new Error((what || 'Date') + ' must look like 2026-11-15');
  return date;
}
function qty_(v) {
  var qty = Number(v);
  if (!(qty >= 1) || Math.floor(qty) !== qty || qty > 100000) throw new Error('Qty must be a whole number from 1 to 100000');
  return qty;
}
function money_(v, what) {
  var n = Number(v);
  if (v === '' || v == null || isNaN(n) || n < 0 || n > 1e9) throw new Error(what + ' must be a number, zero or more');
  return Math.round(n * 100) / 100;
}
function moneyOrNull_(v, what) { return v === '' || v == null ? null : money_(v, what); }
function id_(v, what) {
  var id = s_(v);
  if (!id || id.length > 60) throw new Error(what + ' needs an ID');
  return id;
}
// A release date is a best guess, so a year or a year and month is accepted as well as a full date.
function release_(v) {
  var r = s_(v);
  if (r && !/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(r)) throw new Error('Release date must look like 2024, 2024-07 or 2024-07-15');
  return r;
}

function cleanItem_(x) {
  if (!x) throw new Error('Missing item');
  var sku = String(x.sku || '').trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(sku)) throw new Error('SKU must be 1 to 32 letters, digits, dots, dashes or underscores');
  var name = String(x.name || '').trim();
  if (!name) throw new Error('Name is required');
  if (name.length > 120) throw new Error('Name is too long');
  var price = x.price == null || x.price === '' ? null : Number(x.price);
  if (price != null && (isNaN(price) || price < 0)) throw new Error('Price must be a number, zero or more');
  var min = x.min == null || x.min === '' ? null : Number(x.min);
  if (min != null && (isNaN(min) || min < 0 || Math.floor(min) !== min)) throw new Error('Reorder level must be a whole number');
  return { sku: sku, name: name, cat: text_(x.cat, 60), price: price, min: min, active: x.active !== false,
    mfr: text_(x.mfr, 80), brand: text_(x.brand, 80), line: text_(x.line, 80), chr: text_(x.chr, 80), rel: release_(x.rel), relCheck: x.relCheck === true };
}

function cleanMove_(x) {
  if (!x) throw new Error('Missing movement');
  var id = id_(x.id, 'Movement');
  var date = date_(x.date);
  var dir = String(x.dir || '');
  if (dir !== 'In' && dir !== 'Out') throw new Error('Direction must be In or Out');
  var qty = qty_(x.qty);
  var reason = String(x.reason || '');
  var okReason = EITHER_.indexOf(reason) >= 0 || (dir === 'In' ? IN_ONLY_ : OUT_ONLY_).indexOf(reason) >= 0;
  if (!okReason) throw new Error(reason + ' cannot be recorded as ' + dir);
  return { id: id, date: date, sku: String(x.sku || '').trim(), dir: dir, qty: qty, reason: reason, ref: text_(x.ref, 60), note: text_(x.note, 300), cost: moneyOrNull_(x.cost, 'Unit cost') };
}

// Next unused T0001-style SKU, given a map of lower-case SKU -> item.
function freeSku_(bySku) {
  var max = 0;
  Object.keys(bySku).forEach(function (k) { var m = /^t(\d+)$/.exec(k); if (m) max = Math.max(max, Number(m[1])); });
  var n = String(max + 1);
  while (n.length < 4) n = '0' + n;
  return 'T' + n;
}

function idSet_(sh) {
  var last = lastRowOf_(sh);
  var set = {};
  if (last < 2) return set;
  var v = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < v.length; i++) { var id = String(v[i][0]).trim(); if (id) set[id] = true; }
  return set;
}
function index_(list, key) { var m = {}; list.forEach(function (o) { m[o[key]] = o; }); return m; }

// ---------- writing ----------

/**
 * entries: [{ id, kind, ... }] applied in order. Every entry is idempotent (an item by SKU and name, anything
 * else by its own ID, a status change by being an absolute value), so a retry after a lost response changes nothing.
 *
 * kind        payload                                                  effect
 * item        item, auto                                               new toy
 * edit        sku, patch                                               change a toy's details
 * move        move { id, date, sku, dir, qty, reason, ref, note, cost } one stock movement
 * cust        cust { id, name, contact }                               new customer, or new details for one
 * order       order { id, date, sku, qty, expected, note }             supplier order (status Ordered)
 * receive     orderId, date, qty, cost                                 order Received + In/Restock movement, Ref = order ID
 * orderCancel orderId                                                  order Cancelled
 * pre         pre { id, date, custId, sku, qty, price, paid, note, invId, no }  pre-order (Open) + receipt; no movement
 * prePay      preId, paid                                              new total paid on an open pre-order
 * preCancel   preId, kept                                              pre-order Cancelled; kept = deposit kept, 0 = full refund; no movement
 * invoice     invoice { id, no, date, custId, lines, preId }           sale invoice + Out/Sale movement per line, Ref = invoice no
 * ship        invId, ship ('Delivered' or '')                          delivered mark on a sale invoice
 * ret         ret { id, date, invId, sku, qty, outcome, refund, note } return against an invoice + movement per RETURN_STOCK_
 * inboxDone   rows [{ row, name }], mark 'Done' | 'Dismissed'          Inbox rows handled
 *
 * Two phones can each invent the same next SKU while offline. An item sent with auto: true that meets a
 * different toy on its SKU is renumbered, the rest of the batch follows the new SKU, and the result carries
 * { sku, from } so the app can renumber what is still queued. A refused item blocks the rest of the batch
 * for its SKU, so a movement or document can never land on another toy that happens to own that SKU.
 * Invoice and receipt numbers are plain sequential numbers picked by the phone. A number already used by a
 * different document is replaced by the next free one and the result carries { no, fromNo }.
 * Returns { results: [{ id, ok, error, sku?, from?, no?, fromNo? }], sync }.
 */
function addEntries_(entries, have) {
  var itemSh = itemsSheet_(), moveSh = movesSheet_();
  var items = readItems_();
  var bySku = {}, byName = {};
  items.forEach(function (it) { bySku[it.sku.toLowerCase()] = it; byName[norm_(it.name)] = it; });
  var existingIds = idSet_(moveSh);
  var custs = readTab_('cust'), orders = readTab_('order'), pres = readTab_('pre'), invs = readTab_('inv'), lines = readTab_('line'), rets = readTab_('ret');
  var custById = index_(custs, 'id'), orderById = index_(orders, 'id'), preById = index_(pres, 'id'), invById = index_(invs, 'id'), invByNo = index_(invs, 'no'), retById = index_(rets, 'id');
  var newItems = [], newMoves = [], results = [], remap = {}, refused = {};
  function skuOf_(sku) { var k = String(sku || '').toLowerCase(); return remap[k] || String(sku || ''); }
  function guard_(sku) { if (refused[String(sku || '').toLowerCase()]) throw new Error('Skipped because its toy was refused'); }
  function toy_(sku) {
    var real = skuOf_(sku);
    guard_(real);
    var it = bySku[real.toLowerCase()];
    if (!it) throw new Error('Unknown item ' + sku);
    return it;
  }
  function cust_(id) { var c = custById[s_(id)]; if (!c) throw new Error('Unknown customer'); return c; }
  function pushMove_(id, date, it, dir, qty, reason, ref, note, cost) {
    if (existingIds[id]) return;
    existingIds[id] = true;
    newMoves.push([id, date, it.sku, it.name, dir, qty, reason, ref, note, cost == null ? '' : cost]);
  }
  // The number the phone picked, or the next free one when a different document already holds it.
  function docNo_(asked) {
    var no = Number(asked);
    if (no >= 1 && Math.floor(no) === no && !invByNo[no]) return no;
    var max = 0;
    Object.keys(invByNo).forEach(function (k) { max = Math.max(max, Number(k)); });
    return max + 1;
  }
  function numbered_(e, inv, asked) {
    var r = { id: e.id, ok: true, no: inv.no };
    if (Number(asked) !== inv.no) r.fromNo = asked;
    return r;
  }

  entries.forEach(function (e) {
    try {
      if (e.kind === 'item') {
        var it = cleanItem_(e.item);
        var asked = it.sku;
        var cur = bySku[it.sku.toLowerCase()];
        if (cur && norm_(cur.name) !== norm_(it.name)) {
          if (!e.auto) throw new Error('SKU ' + it.sku + ' already belongs to "' + cur.name + '"');
          // Same name under another SKU: this is a retry of an item that was already renumbered, so reuse it.
          var same = byName[norm_(it.name)];
          if (same) { remap[asked.toLowerCase()] = same.sku; results.push({ id: e.id, ok: true, sku: same.sku, from: asked }); return; }
          it.sku = freeSku_(bySku); remap[asked.toLowerCase()] = it.sku; cur = null;
        }
        if (!cur) {
          if (byName[norm_(it.name)]) throw new Error('An item named "' + byName[norm_(it.name)].name + '" already exists');
          bySku[it.sku.toLowerCase()] = it; byName[norm_(it.name)] = it; newItems.push(it);
        }
        if (it.sku !== asked) { results.push({ id: e.id, ok: true, sku: it.sku, from: asked }); return; }

      } else if (e.kind === 'edit') {
        var target = toy_(e.sku), p = e.patch || {};
        var merged = { sku: target.sku };
        ['name', 'cat', 'price', 'min', 'active', 'mfr', 'brand', 'line', 'chr', 'rel', 'relCheck'].forEach(function (f) { merged[f] = p[f] !== undefined ? p[f] : target[f]; });
        merged = cleanItem_(merged);
        var clash = byName[norm_(merged.name)];
        if (clash && clash.sku !== target.sku) throw new Error('An item named "' + clash.name + '" already exists');
        delete byName[norm_(target.name)];
        Object.keys(merged).forEach(function (f) { target[f] = merged[f]; });
        byName[norm_(target.name)] = target;
        target._dirty = true;

      } else if (e.kind === 'move') {
        var m = cleanMove_(e.move);
        if (!existingIds[m.id]) pushMove_(m.id, m.date, toy_(m.sku), m.dir, m.qty, m.reason, m.ref, m.note, m.cost);

      } else if (e.kind === 'cust') {
        var c = e.cust || {}, cid = id_(c.id, 'Customer'), cname = text_(c.name, 120);
        if (!cname) throw new Error('Customer name is required');
        var have_ = custById[cid];
        if (!have_) { have_ = { id: cid }; custs.push(have_); custById[cid] = have_; } else have_._dirty = true;
        have_.name = cname; have_.contact = text_(c.contact, 120);

      } else if (e.kind === 'order') {
        var o = e.order || {}, oid = id_(o.id, 'Supplier order');
        if (!orderById[oid]) {
          var oit = toy_(o.sku);
          var ord = { id: oid, date: date_(o.date), sku: oit.sku, name: oit.name, qty: qty_(o.qty), expected: s_(o.expected) ? date_(o.expected, 'Expected arrival') : '', status: 'Ordered', recQty: null, recDate: '', note: text_(o.note, 300) };
          orders.push(ord); orderById[oid] = ord;
        }

      } else if (e.kind === 'receive') {
        var ro = orderById[s_(e.orderId)];
        if (!ro) throw new Error('Unknown supplier order');
        if (ro.status === 'Cancelled') throw new Error('That supplier order was cancelled');
        if (ro.status !== 'Received') {
          var rq = qty_(e.qty), rd = date_(e.date), rc = moneyOrNull_(e.cost, 'Unit cost');
          pushMove_('rcv-' + ro.id, rd, toy_(ro.sku), 'In', rq, 'Restock', ro.id, '', rc);
          ro.status = 'Received'; ro.recQty = rq; ro.recDate = rd; ro._dirty = true;
        }

      } else if (e.kind === 'orderCancel') {
        var co = orderById[s_(e.orderId)];
        if (!co) throw new Error('Unknown supplier order');
        if (co.status === 'Received') throw new Error('That supplier order was already received');
        if (co.status !== 'Cancelled') { co.status = 'Cancelled'; co._dirty = true; }

      } else if (e.kind === 'pre') {
        var q = e.pre || {}, pid = id_(q.id, 'Pre-order'), rid = id_(q.invId, 'Receipt');
        if (preById[pid]) { results.push(numbered_(e, invById[rid] || { no: preById[pid].recNo }, q.no)); return; }
        var pit = toy_(q.sku), pc = cust_(q.custId);
        if (!pc.contact) throw new Error('A pre-order needs the customer\'s phone or Messenger');
        var pq = qty_(q.qty), pp = money_(q.price, 'Price'), paid = money_(q.paid, 'Amount paid'), tot = Math.round(pq * pp * 100) / 100;
        if (paid > tot) throw new Error('Amount paid is more than the total');
        var pdate = date_(q.date);
        var rec = { no: docNo_(q.no), id: rid, date: pdate, type: TYPE_RECEIPT_, custId: pc.id, cust: pc.name, contact: pc.contact, total: tot, ship: '', preId: pid };
        var pre = { id: pid, date: pdate, custId: pc.id, cust: pc.name, contact: pc.contact, sku: pit.sku, name: pit.name, qty: pq, price: pp, paid: paid, balance: Math.round((tot - paid) * 100) / 100, status: PRE_OPEN_, kept: null, recNo: rec.no, invNo: null, note: text_(q.note, 300) };
        pres.push(pre); preById[pid] = pre;
        invs.push(rec); invById[rid] = rec; invByNo[rec.no] = rec;
        lines.push({ invNo: rec.no, invId: rid, sku: pit.sku, name: pit.name, qty: pq, list: pit.price, price: pp, cost: null });
        results.push(numbered_(e, rec, q.no)); return;

      } else if (e.kind === 'prePay') {
        var pp_ = preById[s_(e.preId)];
        if (!pp_) throw new Error('Unknown pre-order');
        if (pp_.status !== PRE_OPEN_) throw new Error('That pre-order is closed');
        var np = money_(e.paid, 'Amount paid'), pt = Math.round(pp_.qty * pp_.price * 100) / 100;
        if (np > pt) throw new Error('Amount paid is more than the total');
        pp_.paid = np; pp_.balance = Math.round((pt - np) * 100) / 100; pp_._dirty = true;

      } else if (e.kind === 'preCancel') {
        var pcx = preById[s_(e.preId)];
        if (!pcx) throw new Error('Unknown pre-order');
        if (pcx.status === PRE_DONE_) throw new Error('That pre-order was already fulfilled');
        if (pcx.status === PRE_OPEN_) {
          // Kept is the deposit the shop keeps; zero means the customer was refunded in full.
          var kept = money_(e.kept == null || e.kept === '' ? 0 : e.kept, 'Deposit kept');
          if (kept > pcx.paid) throw new Error('The deposit kept is more than what was paid');
          pcx.status = PRE_CANCEL_; pcx.kept = kept; pcx._dirty = true;
        }

      } else if (e.kind === 'invoice') {
        var v = e.invoice || {}, vid = id_(v.id, 'Invoice');
        if (invById[vid]) { results.push(numbered_(e, invById[vid], v.no)); return; }
        var vc = cust_(v.custId), vdate = date_(v.date);
        if (!v.lines || !v.lines.length) throw new Error('An invoice needs at least one toy');
        if (v.lines.length > 50) throw new Error('An invoice can hold 50 lines at most');
        var vlines = v.lines.map(function (l) {
          var lit = toy_(l.sku);
          return { it: lit, qty: qty_(l.qty), list: lit.price, price: money_(l.price, 'Price'), cost: moneyOrNull_(l.cost, 'Unit cost') };
        });
        var vpre = null;
        if (s_(v.preId)) {
          vpre = preById[s_(v.preId)];
          if (!vpre) throw new Error('Unknown pre-order');
          if (vpre.status !== PRE_OPEN_) throw new Error('That pre-order is closed');
        }
        var total = 0;
        vlines.forEach(function (l) { total += l.qty * l.price; });
        var inv = { no: docNo_(v.no), id: vid, date: vdate, type: TYPE_SALE_, custId: vc.id, cust: vc.name, contact: vc.contact, total: Math.round(total * 100) / 100, ship: '', preId: vpre ? vpre.id : '' };
        invs.push(inv); invById[vid] = inv; invByNo[inv.no] = inv;
        vlines.forEach(function (l, i) {
          lines.push({ invNo: inv.no, invId: vid, sku: l.it.sku, name: l.it.name, qty: l.qty, list: l.list, price: l.price, cost: l.cost });
          pushMove_(vid + '-' + (i + 1), vdate, l.it, 'Out', l.qty, 'Sale', String(inv.no), '', l.cost);
        });
        if (vpre) { vpre.status = PRE_DONE_; vpre.invNo = inv.no; vpre._dirty = true; }
        results.push(numbered_(e, inv, v.no)); return;

      } else if (e.kind === 'ship') {
        var si = invById[s_(e.invId)];
        if (!si) throw new Error('Unknown invoice');
        if (si.type !== TYPE_SALE_) throw new Error('Only a sale invoice has a shipping status');
        var st = s_(e.ship);
        if (SHIP_.indexOf(st) < 0) throw new Error('Shipping status must be Delivered or blank');
        if (si.ship !== st) { si.ship = st; si._dirty = true; }

      } else if (e.kind === 'ret') {
        var r = e.ret || {}, retId = id_(r.id, 'Return');
        if (!retById[retId]) {
          var ri = invById[s_(r.invId)];
          if (!ri) throw new Error('Unknown invoice');
          if (ri.type !== TYPE_SALE_) throw new Error('Only a sale invoice can take a return');
          var rit = toy_(r.sku), rqty = qty_(r.qty), outcome = s_(r.outcome);
          if (!RETURN_STOCK_.hasOwnProperty(outcome)) throw new Error('Outcome must be Restock or Write-off');
          var sold = 0, back = 0;
          lines.forEach(function (l) { if (l.invId === ri.id && l.sku === rit.sku) sold += l.qty; });
          rets.forEach(function (x) { if (x.invId === ri.id && x.sku === rit.sku) back += x.qty; });
          if (!sold) throw new Error(rit.name + ' is not on invoice ' + ri.no);
          if (rqty > sold - back) throw new Error('Only ' + (sold - back) + ' of ' + rit.name + ' can still be returned on invoice ' + ri.no);
          var rdate = date_(r.date);
          var ret = { id: retId, date: rdate, invNo: ri.no, invId: ri.id, cust: ri.cust, sku: rit.sku, name: rit.name, qty: rqty, outcome: outcome, refund: money_(r.refund == null || r.refund === '' ? 0 : r.refund, 'Refund'), note: text_(r.note, 300) };
          rets.push(ret); retById[retId] = ret;
          if (RETURN_STOCK_[outcome] === 'In') pushMove_('ret-' + retId, rdate, rit, 'In', rqty, 'Return', retId, 'Invoice ' + ri.no, null);
        }

      } else if (e.kind === 'inboxDone') {
        // Marks Inbox rows as handled. The name is checked so a row is never marked by position alone.
        var ish = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inbox'), mark = e.mark === 'Dismissed' ? 'Dismissed' : 'Done';
        if (ish) (e.rows || []).forEach(function (x) {
          var rr = Number(x.row);
          if (!(rr >= 2) || rr > ish.getLastRow()) return;
          var cur_ = ish.getRange(rr, 1, 1, INBOX_HEAD_.length).getValues()[0];
          if (s_(x.name) && norm_(cur_[2]) === norm_(x.name) && !s_(cur_[12])) ish.getRange(rr, 13).setValue(mark);
        });

      } else {
        throw new Error('Unknown entry type');
      }
      results.push({ id: e.id, ok: true });
    } catch (err) {
      if (e.kind === 'item' && e.item && e.item.sku) refused[String(e.item.sku).toLowerCase()] = true;
      results.push({ id: e.id, ok: false, error: String(err.message || err) });
    }
  });

  items.forEach(function (it) {
    if (!it._dirty) return;
    itemSh.getRange(it._row, 1, 1, 6).setValues([itemLeft_(it)]);
    itemSh.getRange(it._row, 8, 1, 6).setValues([itemRight_(it)]);
  });
  if (newItems.length) {
    var start = lastRowOf_(itemSh) + 1;
    ensureRows_(itemSh, start + newItems.length - 1);
    itemSh.getRange(start, 1, newItems.length, 6).setValues(newItems.map(itemLeft_));
    itemSh.getRange(start, 8, newItems.length, 6).setValues(newItems.map(itemRight_));
  }
  if (newMoves.length) {
    var mStart = lastRowOf_(moveSh) + 1;
    ensureRows_(moveSh, mStart + newMoves.length - 1);
    moveSh.getRange(mStart, 1, newMoves.length, MOVE_HEAD_.length).setValues(newMoves);
  }
  writeTab_('cust', custs); writeTab_('order', orders); writeTab_('pre', pres); writeTab_('inv', invs); writeTab_('line', lines); writeTab_('ret', rets);
  return { results: results, sync: snapshot_(have) };
}
