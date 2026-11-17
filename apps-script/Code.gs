/**
 * Toy Stock API: a Google Apps Script web app bound to the "Toy Inventory" spreadsheet.
 *
 * Install: Extensions > Apps Script, paste this whole file over Code.gs, save, run setup() once,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * After pasting a newer version, run setup() again and publish a new version of the existing deployment.
 * The app talks to the deployment URL with a shared key; see README.md and ARCHITECTURE.md.
 *
 * The app is the writer of the data tabs. Movements, invoice lines and returns are append-only, except that a cost entry
 * rewrites the Unit cost of an In movement while one of its units is on hand. Items, customers,
 * supplier orders, pre-orders and invoices are one row each; only their status-type fields change later.
 * Units leave stock first in, first out, in the order of the Movements tab; see stockOf_().
 * No write trusts a row number: a changed record is written to the row that holds its key at that moment.
 * Browse is a copy the script rewrites for the owner to sort and filter; Edits takes item changes typed in the sheet.
 */
var VERSION_ = '2.2.0';
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
// Rows Claude writes after reading photos. The app shows the rows whose Status is blank and marks them Done or Dismissed.
// An intake run may set Status to Working while it still researches a row; any non-blank Status keeps a row out of the app.
// Nothing in this tab counts as stock until the app applies it.
var INBOX_HEAD_ = ['Added', 'Type', 'Name', 'Qty', 'Cost each', 'Manufacturer', 'Brand', 'Toy line', 'Character', 'Release date', 'Verify', 'Note', 'Status'];
// Browse: one row per item with the computed numbers, rewritten in full at the end of every sync and add.
// Unit costs lists the cost of each unit on hand, oldest first, with ? for a unit without one.
var BROWSE_HEAD_ = ['SKU', 'Name', 'Category', 'Price', 'Reorder at', 'Active', 'On hand', 'Incoming', 'Owed', 'Left to promise', 'Unit costs', 'Stock value at cost', 'Units without cost', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Release check'];
var BROWSE_TEXT_ = ['A:C', 'F:F', 'K:K', 'N:S'];
// Edits: item changes typed in the sheet, applied as edit entries at the start of every sync and add.
var EDIT_HEAD_ = ['SKU', 'Field', 'New value', 'Status', 'Note'];
var EDIT_FIELDS_ = { 'Name': 'name', 'Category': 'cat', 'Price': 'price', 'Reorder at': 'min', 'Active': 'active', 'Manufacturer': 'mfr', 'Brand': 'brand',
  'Product line': 'line', 'Character': 'chr', 'Release date': 'rel', 'Release check': 'relCheck' };
var PROTECT_NOTE_ = 'Used by the app. Sort and filter in the Browse tab; change fields in the Edits tab.';

function s_(v) { return String(v == null ? '' : v).trim(); }
function num_(v) { if (v === '' || v == null) return null; var n = Number(v); return isNaN(n) ? null : n; }
function blank_(v) { return v == null ? '' : v; }
function r2_(n) { return Math.round(n * 100) / 100; }

/**
 * The document tabs. Each has a header row, the columns to keep as plain text (so a phone number such as
 * +63917... or a note starting with "=" is stored as typed), the mapping between a row and an object,
 * and col, the column of the key a changed row is found by (the ID; for Invoices the ID in column B).
 */
var T_ = {
  cust: { name: 'Customers', col: 1, head: ['ID', 'Name', 'Contact'], text: ['A:C'],
    from: function (v) { return { id: s_(v[0]), name: s_(v[1]), contact: s_(v[2]) }; },
    to: function (o) { return [o.id, o.name, o.contact]; } },
  order: { name: 'Supplier orders', col: 1, head: ['ID', 'Date', 'SKU', 'Item', 'Qty', 'Expected', 'Status', 'Received qty', 'Received on', 'Note'], text: ['A:D', 'F:G', 'I:J'],
    from: function (v) { return { id: s_(v[0]), date: dateStr_(v[1]), sku: s_(v[2]), name: s_(v[3]), qty: Number(v[4]), expected: dateStr_(v[5]), status: s_(v[6]), recQty: num_(v[7]), recDate: dateStr_(v[8]), note: String(v[9]) }; },
    to: function (o) { return [o.id, o.date, o.sku, o.name, o.qty, o.expected, o.status, blank_(o.recQty), o.recDate, o.note]; } },
  pre: { name: 'Pre-orders', col: 1, head: ['ID', 'Date', 'Customer ID', 'Customer', 'Contact', 'SKU', 'Item', 'Qty', 'Price', 'Paid', 'Balance', 'Status', 'Kept', 'Receipt no', 'Invoice no', 'Note'], text: ['A:G', 'L:L', 'P:P'],
    from: function (v) { return { id: s_(v[0]), date: dateStr_(v[1]), custId: s_(v[2]), cust: s_(v[3]), contact: s_(v[4]), sku: s_(v[5]), name: s_(v[6]), qty: Number(v[7]), price: Number(v[8]), paid: Number(v[9]), balance: Number(v[10]), status: s_(v[11]), kept: num_(v[12]), recNo: num_(v[13]), invNo: num_(v[14]), note: String(v[15]) }; },
    to: function (o) { return [o.id, o.date, o.custId, o.cust, o.contact, o.sku, o.name, o.qty, o.price, o.paid, o.balance, o.status, blank_(o.kept), blank_(o.recNo), blank_(o.invNo), o.note]; } },
  inv: { name: 'Invoices', col: 2, head: ['No', 'ID', 'Date', 'Type', 'Customer ID', 'Customer', 'Contact', 'Total', 'Shipping', 'Pre-order ID'], text: ['B:G', 'I:J'],
    from: function (v) { return { no: Number(v[0]), id: s_(v[1]), date: dateStr_(v[2]), type: s_(v[3]), custId: s_(v[4]), cust: s_(v[5]), contact: s_(v[6]), total: Number(v[7]), ship: s_(v[8]), preId: s_(v[9]) }; },
    to: function (o) { return [o.no, o.id, o.date, o.type, o.custId, o.cust, o.contact, o.total, o.ship, o.preId]; } },
  // Invoice lines and returns are only ever appended.
  line: { name: 'Invoice lines', col: 1, head: ['Invoice no', 'Invoice ID', 'SKU', 'Item', 'Qty', 'Listed price', 'Charged price', 'Unit cost'], text: ['B:D'],
    from: function (v) { return { invNo: Number(v[0]), invId: s_(v[1]), sku: s_(v[2]), name: s_(v[3]), qty: Number(v[4]), list: num_(v[5]), price: Number(v[6]), cost: num_(v[7]) }; },
    to: function (o) { return [o.invNo, o.invId, o.sku, o.name, o.qty, blank_(o.list), o.price, blank_(o.cost)]; } },
  ret: { name: 'Returns', col: 1, head: ['ID', 'Date', 'Invoice no', 'Invoice ID', 'Customer', 'SKU', 'Item', 'Qty', 'Outcome', 'Refund', 'Note'], text: ['A:B', 'D:G', 'I:I', 'K:K'],
    from: function (v) { return { id: s_(v[0]), date: dateStr_(v[1]), invNo: Number(v[2]), invId: s_(v[3]), cust: s_(v[4]), sku: s_(v[5]), name: s_(v[6]), qty: Number(v[7]), outcome: s_(v[8]), refund: Number(v[9]), note: String(v[10]) }; },
    to: function (o) { return [o.id, o.date, o.invNo, o.invId, o.cust, o.sku, o.name, o.qty, o.outcome, o.refund, o.note]; } }
};

/** Run once, and again after pasting a newer Code.gs. Creates and formats the tabs and makes the connection key. Never deletes data. */
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
  // 2.0.0 filled On hand with one ARRAYFORMULA in G2. It is now a plain number the script writes.
  if (items.getRange('G2').getFormula()) items.getRange('G2').clearContent();
  Object.keys(T_).forEach(function (k) {
    var sh = ensureSheet_(ss, T_[k].name, T_[k].head);
    T_[k].text.forEach(function (a1) { sh.getRange(a1).setNumberFormat('@'); });
  });
  ensureSheet_(ss, 'Inbox', INBOX_HEAD_).getRange('A:M').setNumberFormat('@');
  // Formatted on every run, so a Browse tab made by an older release gets the text columns where they are now.
  var br = browseSheet_(ss);
  BROWSE_TEXT_.forEach(function (a1) { br.getRange(a1).setNumberFormat('@'); });
  var ed = ensureSheet_(ss, 'Edits', EDIT_HEAD_);
  ed.getRange('A:E').setNumberFormat('@');
  ed.getRange(2, 2, ed.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(EDIT_FIELDS_), true).setAllowInvalid(false).build());
  // A warning, not a lock: the owner can still edit, but is asked first.
  ['Items', 'Movements'].concat(Object.keys(T_).map(function (k) { return T_[k].name; })).forEach(function (n) {
    var sh = ss.getSheetByName(n);
    var has = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).some(function (p) { return p.getDescription() === PROTECT_NOTE_; });
    if (!has) sh.protect().setDescription(PROTECT_NOTE_).setWarningOnly(true);
  });
  var first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KEY')) props.setProperty('KEY', Utilities.getUuid().replace(/-/g, ''));
  writeOnHand_();
  writeBrowse_();
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
      case 'sync': return out_({ ok: true, data: syncAll_(body.have) });
      case 'add': return out_({ ok: true, data: addEntries_(body.entries || [], body.have) });
      default: return out_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

// Keys starting with "_" are bookkeeping (sheet row, dirty flag, owning entries) and never leave the script.
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

// Last row with something in the key column (default A). getLastRow() would count other columns.
function lastRowOf_(sh, col) {
  var n = sh.getMaxRows();
  var v = sh.getRange(1, col || 1, n, 1).getValues();
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

/** Items, first row per SKU. warn, when given, collects a sentence for each SKU found on more than one row. */
function readItems_(warn) {
  var sh = itemsSheet_();
  var last = lastRowOf_(sh);
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, ITEM_HEAD_.length).getValues();
  var out = [], seen = {}, twice = {};
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i], k = s_(v[0]).toLowerCase();
    if (!k) continue;
    if (seen[k]) { twice[k] = twice[k] || { sku: s_(v[0]), n: 1 }; twice[k].n++; continue; }
    seen[k] = true;
    out.push({ _row: i + 2, sku: s_(v[0]), name: s_(v[1]), cat: s_(v[2]), price: num_(v[3]), min: num_(v[4]), active: s_(v[5]).toLowerCase() !== 'no',
      mfr: s_(v[7]), brand: s_(v[8]), line: s_(v[9]), chr: s_(v[10]), rel: dateStr_(v[11]), relCheck: s_(v[12]).toLowerCase() === 'verify' });
  }
  if (warn) Object.keys(twice).forEach(function (k) { warn.push('Items: SKU ' + twice[k].sku + ' appears on ' + twice[k].n + ' rows. The first is used.'); });
  return out;
}
// One 13-column Items row; On hand is the number the script last worked out.
function itemRow_(it, have) {
  return [it.sku, it.name, it.cat, it.price == null ? '' : it.price, it.min == null ? '' : it.min, it.active ? 'Yes' : 'No', have || 0,
    it.mfr, it.brand, it.line, it.chr, it.rel, it.relCheck ? 'Verify' : ''];
}
function moveOf_(v) { return { id: s_(v[0]), date: dateStr_(v[1]), sku: s_(v[2]), dir: s_(v[4]), qty: Number(v[5]), reason: s_(v[6]), ref: s_(v[7]), note: String(v[8]), cost: num_(v[9]) }; }
function readMoves_() {
  var sh = movesSheet_(), last = lastRowOf_(sh);
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, MOVE_HEAD_.length).getValues(), out = [];
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim()) out.push(moveOf_(vals[i]));
  return out;
}
/**
 * Stock per lower-case SKU, replayed first in, first out in sheet order, the same way as live() in the app; dates are not used.
 * Each SKU has a queue of units on hand, oldest first ({ id, cost } per unit: an In of Qty 3 is three units at its cost), and a deficit.
 * An In covers the deficit first and queues the rest. An Out takes units from the front, except that a Correction whose Ref is an In
 * takes that In's own units first; what the queue cannot give is added to the deficit.
 * Returns { stock, units }: stock is units on hand minus the deficit (one of the two is always zero).
 */
function stockOf_(moves) {
  var units = {}, owe = {}, stock = {};
  moves.forEach(function (m) {
    var k = m.sku.toLowerCase(), u = units[k] = units[k] || [], n = m.qty, d = owe[k] || 0;
    if (m.dir === 'In') {
      owe[k] = Math.max(d - n, 0);
      for (n -= d; n > 0; n--) u.push({ id: m.id, cost: m.cost });
    } else {
      for (var i = u.length - 1; m.reason === 'Correction' && i >= 0 && n > 0; i--) if (u[i].id === m.ref) { u.splice(i, 1); n--; }
      var took = Math.min(n, u.length);
      u.splice(0, took); owe[k] = d + n - took;
    }
  });
  Object.keys(units).forEach(function (k) { stock[k] = units[k].length - (owe[k] || 0); });
  return { stock: stock, units: units };
}
/** Writes On hand (column G) for every item in one call, aligned by the SKU in each row now. */
function writeOnHand_() {
  var sh = itemsSheet_(), last = lastRowOf_(sh);
  if (last < 2) return;
  var stock = stockOf_(readMoves_()).stock;
  var skus = sh.getRange(2, 1, last - 1, 1).getValues();
  sh.getRange(2, 7, last - 1, 1).setValues(skus.map(function (v) { var k = s_(v[0]).toLowerCase(); return [k ? stock[k] || 0 : '']; }));
}
function browseSheet_(ss) {
  var sh = ss.getSheetByName('Browse');
  if (sh) return sh;
  sh = ensureSheet_(ss, 'Browse', BROWSE_HEAD_);
  BROWSE_TEXT_.forEach(function (a1) { sh.getRange(a1).setNumberFormat('@'); });
  return sh;
}
/** Rewrites Browse: contents below the header cleared, then one write. A filter on the tab stays. */
function writeBrowse_() {
  var sh = browseSheet_(SpreadsheetApp.getActiveSpreadsheet());
  var m = stockOf_(readMoves_()), inc = {}, owed = {};
  readTab_('order').forEach(function (o) { if (o.status === 'Ordered') { var k = o.sku.toLowerCase(); inc[k] = (inc[k] || 0) + o.qty; } });
  readTab_('pre').forEach(function (p) { if (p.status === PRE_OPEN_) { var k = p.sku.toLowerCase(); owed[k] = (owed[k] || 0) + p.qty; } });
  var rows = readItems_().map(function (it) {
    var k = it.sku.toLowerCase(), have = m.stock[k] || 0, u = m.units[k] || [], i = inc[k] || 0, o = owed[k] || 0, val = 0, none = 0;
    u.forEach(function (x) { if (x.cost == null) none++; else val += x.cost; });
    // Unit costs, stock value and units without cost are blank when no unit is on hand.
    return [it.sku, it.name, it.cat, blank_(it.price), blank_(it.min), it.active ? 'Yes' : 'No', have, i, o, have + i - o,
      u.map(function (x) { return x.cost == null ? '?' : x.cost; }).join(', '), u.length ? r2_(val) : '', u.length ? none : '', it.mfr, it.brand, it.line, it.chr, it.rel, it.relCheck ? 'Verify' : ''];
  });
  if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, BROWSE_HEAD_.length).clearContent();
  ensureRows_(sh, rows.length + 1);
  sh.getRange(1, 1, rows.length + 1, BROWSE_HEAD_.length).setValues([BROWSE_HEAD_].concat(rows));
}

/** Inbox rows still waiting: a name and no status. Tolerates a sheet set up before the Inbox tab existed. */
function inboxType_(v) { return /^r/i.test(s_(v)) ? 'receive' : 'count'; }
function readInbox_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inbox');
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, INBOX_HEAD_.length).getValues(), out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (!s_(v[2]) || s_(v[12])) continue;
    out.push({ row: i + 2, added: dateStr_(v[0]), type: inboxType_(v[1]), name: s_(v[2]), qty: s_(v[3]), cost: s_(v[4]), mfr: s_(v[5]), brand: s_(v[6]), line: s_(v[7]), chr: s_(v[8]), rel: dateStr_(v[9]), verify: s_(v[10]), note: s_(v[11]) });
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

// ---------- reading ----------

/**
 * Returns every item and document plus the movement rows the app does not have yet.
 * have = { rows, lastId } describes the movement rows the app already holds. If the sheet still has
 * that last row in the same place, only later rows are sent; otherwise everything is sent with reset = true.
 * Customers, supplier orders, pre-orders, invoices (with their lines), returns and waiting Inbox rows are always sent whole.
 * warnings lists problems found in the tabs, one plain sentence each; older apps ignore it.
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
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim()) moves.push(moveOf_(vals[i]));
  }
  var lastId = rows > 0 ? String(sh.getRange(rows + 1, 1).getValue()) : '';
  var invs = readTab_('inv'), byInv = {}, warnings = [];
  invs.forEach(function (x) { x.lines = []; byInv[x.id] = x; });
  readTab_('line').forEach(function (l) { if (byInv[l.invId]) byInv[l.invId].lines.push({ sku: l.sku, name: l.name, qty: l.qty, list: l.list, price: l.price, cost: l.cost }); });
  return { items: readItems_(warnings), moves: moves, rows: rows, lastId: lastId, reset: reset, syncedAt: new Date().toISOString(),
    custs: readTab_('cust'), orders: readTab_('order'), pres: readTab_('pre'), invs: invs, rets: readTab_('ret'), inbox: readInbox_(), warnings: warnings };
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
// First record per key; a repeated key is caught when that record is written.
function index_(list, key) { var m = {}; list.forEach(function (o) { if (!m.hasOwnProperty(o[key])) m[o[key]] = o; }); return m; }

// ---------- writing ----------

/**
 * entries: [{ id, kind, ... }] applied in order. Every entry is idempotent (an item by SKU and name, anything
 * else by its own ID, a status change by being an absolute value), so a retry after a lost response changes nothing.
 *
 * kind        payload                                                  effect
 * item        item, auto                                               new item
 * edit        sku, patch                                               change an item's details
 * move        move { id, date, sku, dir, qty, reason, ref, note, cost } one stock movement
 * cust        cust { id, name, contact }                               new customer, or new details for one
 * order       order { id, date, sku, qty, expected, note }             supplier order (status Ordered)
 * receive     orderId, date, qty, costs                                order Received + one In/Restock movement per unit, rcv-<orderId>-1 ...,
 *                                                                      Ref = order ID, Unit cost costs[k-1] (a number, or null for blank)
 * orderCancel orderId                                                  order Cancelled
 * pre         pre { id, date, custId, sku, qty, price, paid, note, invId, no }  pre-order (Open) + receipt; no movement
 * prePay      preId, paid                                              new total paid on an open pre-order
 * preCancel   preId, kept                                              pre-order Cancelled; kept = deposit kept, 0 = full refund; no movement
 * invoice     invoice { id, no, date, custId, lines, preId }           sale invoice + Out/Sale movement per line, Ref = invoice no
 * ship        invId, ship ('Delivered' or '')                          delivered mark on a sale invoice
 * ret         ret { id, date, invId, sku, qty, outcome, refund, note } return against an invoice + movement per RETURN_STOCK_
 * inboxDone   rows [{ row, name, added?, type?, qty? }], mark          Inbox rows handled ('Done' or 'Dismissed')
 *
 * Two phones can each invent the same next SKU while offline. An item sent with auto: true that meets a
 * different item on its SKU is renumbered, the rest of the batch follows the new SKU, and the result carries
 * { sku, from } so the app can renumber what is still queued. A refused item blocks the rest of the batch
 * for its SKU, so a movement or document can never land on another item that happens to own that SKU.
 * Invoice and receipt numbers are plain sequential numbers picked by the phone. A number already used by a
 * different document is replaced by the next free one and the result carries { no, fromNo }.
 * Pending rows of the Edits tab are applied first, as edit entries. Their results go to the Edits tab, not the app.
 * Returns { results: [{ id, ok, error, sku?, from?, no?, fromNo? }], sync, warnings }.
 */
function addEntries_(entries, have) {
  var eds = editRows_(), mine = eds.filter(function (x) { return x.entry; }).map(function (x) { return x.entry; });
  var results = apply_(mine.concat(entries));
  finishEdits_(eds, results.slice(0, mine.length));
  writeBrowse_();
  var sync = snapshot_(have);
  return { results: results.slice(mine.length), sync: sync, warnings: sync.warnings };
}
/** sync: applies the Edits tab, rewrites Browse, and returns the snapshot. */
function syncAll_(have) {
  var eds = editRows_(), mine = eds.filter(function (x) { return x.entry; }).map(function (x) { return x.entry; });
  if (eds.length) finishEdits_(eds, mine.length ? apply_(mine) : []);
  writeBrowse_();
  return snapshot_(have);
}

/**
 * Plans the entries in memory, checks that every row to change in place is still found by its key exactly once,
 * plans again without the entries that touched a row that was not, then writes. An entry is final only after the writes.
 */
function apply_(entries) {
  var skip = {}, p;
  for (var round = 0; round <= entries.length; round++) {
    p = plan_(entries, skip);
    var bad = check_(p), more = false;
    Object.keys(bad).forEach(function (id) { if (!skip[id]) { skip[id] = bad[id]; more = true; } });
    if (!more) break;
  }
  write_(p, skip);
  return p.results.map(function (r) { return skip[r.id] ? { id: r.id, ok: false, error: skip[r.id] } : r; });
}

function moved_(tab, key, n) {
  return 'The ' + tab + ' tab was changed in Google Sheets (' + key + (n ? ' appears twice' : ' not found') + '). Nothing was written for this entry; fix the tab and sync again.';
}
function itemKey_(o) { return o.sku.toLowerCase(); }
function idKey_(o) { return s_(o.id); }
// Row numbers per key in a tab's key column, as the tab is now. Items match SKUs without regard to case.
function keyRows_(sh, col, lower) {
  var last = lastRowOf_(sh, col), map = {};
  if (last < 2) return map;
  sh.getRange(2, col, last - 1, 1).getValues().forEach(function (v, i) {
    var k = s_(v[0]); if (lower) k = k.toLowerCase();
    if (k) (map[k] = map[k] || []).push(i + 2);
  });
  return map;
}
// The tabs whose rows change in place: [sheet name, key column, key of a record, records, record -> row, width].
function tabsOf_(p) {
  var out = [['Items', 1, itemKey_, p.items, function (it) { return itemRow_(it, p.stock[it.sku.toLowerCase()]); }, ITEM_HEAD_.length]];
  ['cust', 'order', 'pre', 'inv'].forEach(function (k) { out.push([T_[k].name, T_[k].col, idKey_, p.tabs[k], T_[k].to, T_[k].head.length]); });
  return out;
}
/** Plan-time check: { entryId: message } for each entry that touched a row whose key is now missing or repeated. */
function check_(p) {
  var bad = {};
  tabsOf_(p).forEach(function (t) {
    var dirty = t[3].filter(function (o) { return o._row && o._dirty; });
    if (!dirty.length) return;
    var map = keyRows_(sheet_(t[0]), t[1], t[0] === 'Items');
    dirty.forEach(function (o) {
      var n = (map[t[2](o)] || []).length;
      if (n !== 1) o._by.forEach(function (id) { bad[id] = bad[id] || moved_(t[0], t[0] === 'Items' ? o.sku : o.id, n); });
    });
  });
  return bad;
}

/**
 * Writes a plan. Rows changed in place go first, each one to the row that holds its key at that moment
 * (the key cell is read again just before the write, and the column again if it moved), as one row in one call.
 * New rows follow, after the last used row of the key column, without those of entries refused on the way.
 * Then On hand, then the Inbox marks.
 */
function write_(p, skip) {
  var changed = false;
  tabsOf_(p).forEach(function (t) {
    var dirty = t[3].filter(function (o) { return o._row && o._dirty; });
    if (!dirty.length) return;
    var sh = sheet_(t[0]), lower = t[0] === 'Items', map = keyRows_(sh, t[1], lower), width = t[5];
    dirty.forEach(function (o) {
      var key = t[2](o), shown = lower ? o.sku : o.id, gone = o._by.filter(function (id) { return skip[id]; })[0];
      if (gone) { o._by.forEach(function (id) { skip[id] = skip[id] || skip[gone]; }); return; }
      var rows = map[key] || [], at = rows.length === 1 ? rows[0] : 0, cell = at ? s_(sh.getRange(at, t[1]).getValue()) : '';
      if (!at || (lower ? cell.toLowerCase() : cell) !== key) { map = keyRows_(sh, t[1], lower); rows = map[key] || []; at = rows.length === 1 ? rows[0] : 0; }
      if (!at) { o._by.forEach(function (id) { skip[id] = skip[id] || moved_(t[0], shown, rows.length); }); return; }
      sh.getRange(at, 1, 1, width).setValues([t[4](o)]);
      if (lower) changed = true;
    });
  });
  var keep = function (o) { return !skip[o._by[0]]; };
  var items = p.newItems.filter(keep), moves = p.newMoves.filter(function (m) { return !skip[m.by]; });
  append_(itemsSheet_(), 1, items.map(function (it) { return itemRow_(it, p.stock[it.sku.toLowerCase()]); }));
  append_(movesSheet_(), 1, moves.map(function (m) { return m.v; }));
  Object.keys(T_).forEach(function (k) { append_(sheet_(T_[k].name), T_[k].col, p.tabs[k].filter(function (o) { return !o._row && keep(o); }).map(T_[k].to)); });
  if (changed || items.length || moves.length) writeOnHand_();
  markInbox_(p.marks.filter(function (m) { return !skip[m.by]; }));
}
function append_(sh, col, rows) {
  if (!rows.length) return;
  var start = lastRowOf_(sh, col) + 1;
  ensureRows_(sh, start + rows.length - 1);
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}
/**
 * Sets Status on Inbox rows. A row is found at its row number when the name there matches (and, when the app sent them,
 * Added, Type and Qty too); otherwise by a single row anywhere with that name, Added, Type and Qty. A row that is not
 * found, or already has a Status, is left alone and keeps waiting.
 */
function markInbox_(marks) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Inbox');
  if (!sh || !marks.length) return;
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, INBOX_HEAD_.length).getValues();
  marks.forEach(function (m) {
    var x = m.x, rr = Number(x.row), full = x.added != null && x.type != null && x.qty != null;
    var same = function (v) { return norm_(v[2]) === norm_(x.name) && (!full || (dateStr_(v[0]) === s_(x.added) && inboxType_(v[1]) === s_(x.type) && s_(v[3]) === s_(x.qty))); };
    var at = rr >= 2 && rr <= last && Math.floor(rr) === rr && same(vals[rr - 2]) ? rr - 2 : -1;
    if (at < 0 && full) {
      var hits = [];
      vals.forEach(function (v, i) { if (same(v)) hits.push(i); });
      if (hits.length === 1) at = hits[0];
    }
    if (at < 0 || s_(vals[at][12])) return;
    sh.getRange(at + 2, 13, 1, 1).setValues([[m.mark]]);
    vals[at][12] = m.mark;
  });
}

/** Pending rows of the Edits tab: a SKU or field filled and no Status. Each becomes an edit entry, or carries the reason it cannot. */
function editRows_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Edits');
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var out = [];
  sh.getRange(2, 1, last - 1, EDIT_HEAD_.length).getValues().forEach(function (v, i) {
    if (s_(v[3]) || (!s_(v[0]) && !s_(v[1]) && !s_(v[2]))) return;
    var x = { row: i + 2, sku: s_(v[0]), field: s_(v[1]), value: v[2] };
    try {
      if (!x.sku) throw new Error('SKU is required');
      x.entry = { id: 'Edits!' + x.row, kind: 'edit', sku: x.sku, patch: editPatch_(x.field, x.value) };
    } catch (err) { x.error = String(err.message || err); }
    out.push(x);
  });
  return out;
}
// One field of the Edits tab as an edit patch. The values are checked again by the edit entry itself.
function editPatch_(field, v) {
  var f = EDIT_FIELDS_[field];
  if (!f) throw new Error('Field must be one of: ' + Object.keys(EDIT_FIELDS_).join(', '));
  var t = typeof v === 'number' ? v : dateStr_(v), p = {};
  if (f === 'active') {
    if (!/^(yes|no)$/i.test(t)) throw new Error('Active must be Yes or No');
    p.active = /^yes$/i.test(t);
  } else if (f === 'relCheck') {
    if (!/^(verify)?$/i.test(t)) throw new Error('Release check must be Verify or blank');
    p.relCheck = t !== '';
  } else p[f] = t === '' && (f === 'price' || f === 'min') ? null : t;
  return p;
}
/** Writes Done or Refused and the reason on each Edits row, found again by its row, SKU, field and value. */
function finishEdits_(eds, results) {
  if (!eds.length) return;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Edits'), last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, EDIT_HEAD_.length).getValues(), byId = {};
  results.forEach(function (r) { byId[r.id] = r; });
  eds.forEach(function (x) {
    var r = x.entry ? byId[x.entry.id] : { ok: false, error: x.error };
    if (!r) return;
    var same = function (v) { return !s_(v[3]) && s_(v[0]) === x.sku && s_(v[1]) === x.field && String(v[2]) === String(x.value); };
    var at = x.row <= last && same(vals[x.row - 2]) ? x.row - 2 : -1;
    if (at < 0) { var hits = []; vals.forEach(function (v, i) { if (same(v)) hits.push(i); }); if (hits.length === 1) at = hits[0]; }
    if (at < 0) return;
    sh.getRange(at + 2, 4, 1, 2).setValues([[r.ok ? 'Done' : 'Refused', r.ok ? '' : r.error]]);
    vals[at][3] = 'x';
  });
}

/** Works out every entry in memory. Nothing is written here. skip: { entryId: message } for entries refused in an earlier round. */
function plan_(entries, skip) {
  var items = readItems_(), moveList = readMoves_();
  var bySku = {}, byName = {}, existingIds = {};
  items.forEach(function (it) { bySku[it.sku.toLowerCase()] = it; byName[norm_(it.name)] = it; });
  moveList.forEach(function (m) { existingIds[m.id] = true; });
  var custs = readTab_('cust'), orders = readTab_('order'), pres = readTab_('pre'), invs = readTab_('inv'), lines = readTab_('line'), rets = readTab_('ret');
  var custById = index_(custs, 'id'), orderById = index_(orders, 'id'), preById = index_(pres, 'id'), invById = index_(invs, 'id'), invByNo = index_(invs, 'no'), retById = index_(rets, 'id');
  var newItems = [], newMoves = [], results = [], remap = {}, refused = {}, marks = [], who = null;
  // Every record remembers the entries that changed it (_by), so a row that cannot be written fails exactly those.
  function touch_(o) { o._dirty = true; o._by = o._by || []; if (o._by.indexOf(who) < 0) o._by.push(who); }
  function made_(o) { o._by = [who]; return o; }
  function skuOf_(sku) { var k = String(sku || '').toLowerCase(); return remap[k] || String(sku || ''); }
  function guard_(sku) { if (refused[String(sku || '').toLowerCase()]) throw new Error('Skipped because its item was refused'); }
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
    newMoves.push({ v: [id, date, it.sku, it.name, dir, qty, reason, ref, note, cost == null ? '' : cost], by: who });
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
    who = e.id;
    if (skip[e.id]) { results.push({ id: e.id, ok: false, error: skip[e.id] }); return; }
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
          bySku[it.sku.toLowerCase()] = it; byName[norm_(it.name)] = it; newItems.push(made_(it));
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
        touch_(target);

      } else if (e.kind === 'move') {
        var m = cleanMove_(e.move);
        if (!existingIds[m.id]) pushMove_(m.id, m.date, toy_(m.sku), m.dir, m.qty, m.reason, m.ref, m.note, m.cost);

      } else if (e.kind === 'cust') {
        var c = e.cust || {}, cid = id_(c.id, 'Customer'), cname = text_(c.name, 120);
        if (!cname) throw new Error('Customer name is required');
        var have_ = custById[cid];
        if (!have_) { have_ = made_({ id: cid }); custs.push(have_); custById[cid] = have_; } else touch_(have_);
        have_.name = cname; have_.contact = text_(c.contact, 120);

      } else if (e.kind === 'order') {
        var o = e.order || {}, oid = id_(o.id, 'Supplier order');
        if (!orderById[oid]) {
          var oit = toy_(o.sku);
          var ord = { id: oid, date: date_(o.date), sku: oit.sku, name: oit.name, qty: qty_(o.qty), expected: s_(o.expected) ? date_(o.expected, 'Expected arrival') : '', status: 'Ordered', recQty: null, recDate: '', note: text_(o.note, 300) };
          orders.push(made_(ord)); orderById[oid] = ord;
        }

      } else if (e.kind === 'receive') {
        var ro = orderById[s_(e.orderId)];
        if (!ro) throw new Error('Unknown supplier order');
        if (ro.status === 'Cancelled') throw new Error('That supplier order was cancelled');
        if (ro.status !== 'Received') {
          // One movement per unit with its own cost; a blank cost is allowed and can be typed later.
          var rq = qty_(e.qty), rd = date_(e.date), rcit = toy_(ro.sku), rcs = [];
          for (var j = 0; j < rq; j++) rcs.push(moneyOrNull_((e.costs || [])[j], 'Unit cost'));
          rcs.forEach(function (c, j) { pushMove_('rcv-' + ro.id + '-' + (j + 1), rd, rcit, 'In', 1, 'Restock', ro.id, '', c); });
          ro.status = 'Received'; ro.recQty = rq; ro.recDate = rd; touch_(ro);
        }

      } else if (e.kind === 'orderCancel') {
        var co = orderById[s_(e.orderId)];
        if (!co) throw new Error('Unknown supplier order');
        if (co.status === 'Received') throw new Error('That supplier order was already received');
        if (co.status !== 'Cancelled') { co.status = 'Cancelled'; touch_(co); }

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
        pres.push(made_(pre)); preById[pid] = pre;
        invs.push(made_(rec)); invById[rid] = rec; invByNo[rec.no] = rec;
        lines.push(made_({ invNo: rec.no, invId: rid, sku: pit.sku, name: pit.name, qty: pq, list: pit.price, price: pp, cost: null }));
        results.push(numbered_(e, rec, q.no)); return;

      } else if (e.kind === 'prePay') {
        var pp_ = preById[s_(e.preId)];
        if (!pp_) throw new Error('Unknown pre-order');
        if (pp_.status !== PRE_OPEN_) throw new Error('That pre-order is closed');
        var np = money_(e.paid, 'Amount paid'), pt = Math.round(pp_.qty * pp_.price * 100) / 100;
        if (np > pt) throw new Error('Amount paid is more than the total');
        pp_.paid = np; pp_.balance = Math.round((pt - np) * 100) / 100; touch_(pp_);

      } else if (e.kind === 'preCancel') {
        var pcx = preById[s_(e.preId)];
        if (!pcx) throw new Error('Unknown pre-order');
        if (pcx.status === PRE_DONE_) throw new Error('That pre-order was already fulfilled');
        if (pcx.status === PRE_OPEN_) {
          // Kept is the deposit the shop keeps; zero means the customer was refunded in full.
          var kept = money_(e.kept == null || e.kept === '' ? 0 : e.kept, 'Deposit kept');
          if (kept > pcx.paid) throw new Error('The deposit kept is more than what was paid');
          pcx.status = PRE_CANCEL_; pcx.kept = kept; touch_(pcx);
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
        invs.push(made_(inv)); invById[vid] = inv; invByNo[inv.no] = inv;
        vlines.forEach(function (l, i) {
          lines.push(made_({ invNo: inv.no, invId: vid, sku: l.it.sku, name: l.it.name, qty: l.qty, list: l.list, price: l.price, cost: l.cost }));
          pushMove_(vid + '-' + (i + 1), vdate, l.it, 'Out', l.qty, 'Sale', String(inv.no), '', l.cost);
        });
        if (vpre) { vpre.status = PRE_DONE_; vpre.invNo = inv.no; touch_(vpre); }
        results.push(numbered_(e, inv, v.no)); return;

      } else if (e.kind === 'ship') {
        var si = invById[s_(e.invId)];
        if (!si) throw new Error('Unknown invoice');
        if (si.type !== TYPE_SALE_) throw new Error('Only a sale invoice has a shipping status');
        var st = s_(e.ship);
        if (SHIP_.indexOf(st) < 0) throw new Error('Shipping status must be Delivered or blank');
        if (si.ship !== st) { si.ship = st; touch_(si); }

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
          rets.push(made_(ret)); retById[retId] = ret;
          if (RETURN_STOCK_[outcome] === 'In') pushMove_('ret-' + retId, rdate, rit, 'In', rqty, 'Return', retId, 'Invoice ' + ri.no, null);
        }

      } else if (e.kind === 'inboxDone') {
        // Marked after the other writes, by markInbox_; a row that cannot be found is left waiting.
        var mark = e.mark === 'Dismissed' ? 'Dismissed' : 'Done';
        (e.rows || []).forEach(function (x) { if (x && s_(x.name)) marks.push({ x: x, mark: mark, by: who }); });

      } else {
        throw new Error('Unknown entry type');
      }
      results.push({ id: e.id, ok: true });
    } catch (err) {
      if (e.kind === 'item' && e.item && e.item.sku) refused[String(e.item.sku).toLowerCase()] = true;
      results.push({ id: e.id, ok: false, error: String(err.message || err) });
    }
  });

  var stock = stockOf_(moveList.concat(newMoves.map(function (m) { return moveOf_(m.v); }))).stock;
  return { results: results, items: items, newItems: newItems, newMoves: newMoves, marks: marks, stock: stock,
    tabs: { cust: custs, order: orders, pre: pres, inv: invs, line: lines, ret: rets } };
}
