/**
 * Toy Stock API: a Google Apps Script web app bound to the "Toy Inventory" spreadsheet.
 *
 * Install: Extensions > Apps Script, paste this whole file over Code.gs, save, run setup() once,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * After pasting a newer version, run setup() again and publish a new version of the existing deployment.
 * The app talks to the deployment URL with a shared key; see README.md and ARCHITECTURE.md.
 *
 * The app is the writer of the data tabs. Movements and returns are append-only, except that a cost or cond entry
 * rewrites the Unit cost or Condition of an In movement while one of its units is on hand. Products, customers, suppliers,
 * supplier order lines, invoices and invoice lines are one row each; only their status-type fields change later.
 * A product is keyed by its Product ID (called sku inside this script and in the JSON); each unit it receives gets a SKU, see unit_().
 * Units leave stock first in, first out, in the order of the Movements tab; see stockOf_().
 * No write trusts a row number: a changed record is written to the row that holds its key at that moment.
 * Browse is a copy the script rewrites for the owner to sort and filter; Edits takes product changes typed in the sheet.
 * The shop's own details belong to the sheet, not to a device: the Shop tab holds the text and Script Properties the logo.
 */
var VERSION_ = '2.6.0';
var ITEM_HEAD_ = ['Product ID', 'Name', 'Price', 'Active', 'On hand', 'Manufacturer', 'Brand', 'Toy line', 'Character', 'Release date', 'Release check'];
var MOVE_HEAD_ = ['ID', 'Date', 'Product ID', 'Product', 'Direction', 'Qty', 'Reason', 'Ref', 'Note', 'Unit cost', 'SKU', 'Condition'];
// A unit's condition, in this order; CONDITIONS in index.html is the same list. Blank means not recorded.
var CONDITIONS_ = ['MISB', 'MIB', 'MOC', 'CIB', 'Box damage', 'Loose complete', 'Loose'];
// Payment details: typed by the owner in the sheet and sent to the app for the invoice image. The app never writes it.
var PAY_HEAD_ = ['Method', 'Number', 'Name'];
// The Shop tab: one row per field, found by its label in column A in any order (the first row with a label is used); the owner may type in it.
// Each field: [label, JSON name, longest value]. Address, Notes and Currency are what the app calls contact, foot and cur.
var SHOP_HEAD_ = ['Field', 'Value'];
var SHOP_ = [['Shop name', 'name', 120], ['Address', 'contact', 500], ['Notes', 'foot', 500], ['Currency', 'cur', 4]];
// The logo is a data URL, too big for a cell, so it lives in Script Properties: LOGO_0, LOGO_1, ... (each under the 9 KB a property holds),
// LOGO_N chunks, and LOGO_REV, raised on every change so the snapshot sends the logo only to an app that does not have it yet.
var LOGO_MAX_ = 120000, LOGO_CHUNK_ = 8000;
var IN_ONLY_ = ['Opening', 'Restock', 'Return'];
var OUT_ONLY_ = ['Sale', 'Damaged', 'Lost'];
var EITHER_ = ['Count', 'Correction', 'Other'];
var SHIP_ = ['', 'Delivered'];
// What a return does to stock, per outcome: 'In' writes a Return movement per unit, null writes none.
// Change it here and in index.html together.
var RETURN_STOCK_ = { 'Restock': 'In', 'Write-off': null };
// Rows Claude writes after reading photos. The app shows the rows whose Status is blank and marks them Done or Dismissed.
// An intake run may set Status to Working while it still researches a row; any non-blank Status keeps a row out of the app.
// Nothing in this tab counts as stock until the app applies it. Supplier and Expected, after Status, belong to Order rows
// (a supplier order or quotation), which the app opens as an Ordered batch.
var INBOX_HEAD_ = ['Added', 'Type', 'Name', 'Qty', 'Cost each', 'Manufacturer', 'Brand', 'Toy line', 'Character', 'Release date', 'Verify', 'Note', 'Status', 'Supplier', 'Expected'];
// Browse: one row per product with the computed numbers, rewritten in full at the end of every sync and add.
// Units on hand lists each unit on hand, oldest first, as its SKU, its cost (? without one) and its condition when recorded.
var BROWSE_HEAD_ = ['Product ID', 'Name', 'Price', 'Active', 'On hand', 'Incoming', 'Owed', 'Left to promise', 'Units on hand', 'Stock value at cost', 'Units without cost', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Release check'];
var BROWSE_TEXT_ = ['A:B', 'D:D', 'I:I', 'L:Q'];
// Edits: product changes typed in the sheet, applied as edit entries at the start of every sync and add.
var EDIT_HEAD_ = ['Product ID', 'Field', 'New value', 'Status', 'Note'];
var EDIT_FIELDS_ = { 'Name': 'name', 'Price': 'price', 'Active': 'active', 'Manufacturer': 'mfr', 'Brand': 'brand',
  'Product line': 'line', 'Character': 'chr', 'Release date': 'rel', 'Release check': 'relCheck' };
var PROTECT_NOTE_ = 'Used by the app. Sort and filter in the Browse tab; change fields in the Edits tab.';

function s_(v) { return String(v == null ? '' : v).trim(); }
function num_(v) { if (v === '' || v == null) return null; var n = Number(v); return isNaN(n) ? null : n; }
function blank_(v) { return v == null ? '' : v; }
function r2_(n) { return Math.round(n * 100) / 100; }

/**
 * The document tabs. Each has a header row, the columns to keep as plain text (so a phone number such as
 * +63917... or a note starting with "=" is stored as typed), the mapping between a row and an object,
 * and col, the column of the key a changed row is found by (the ID; for Invoices the ID in column B). Invoice lines are found by
 * two cells, Invoice ID and Line (keys: 2), and key() gives the same key for a record.
 */
var T_ = {
  cust: { name: 'Customers', col: 1, head: ['ID', 'Name', 'Contact'], text: ['A:C'],
    from: function (v) { return { id: s_(v[0]), name: s_(v[1]), contact: s_(v[2]) }; },
    to: function (o) { return [o.id, o.name, o.contact]; } },
  sup: { name: 'Suppliers', col: 1, head: ['ID', 'Name', 'Contact', 'Note'], text: ['A:D'],
    from: function (v) { return { id: s_(v[0]), name: s_(v[1]), contact: s_(v[2]), note: String(v[3]) }; },
    to: function (o) { return [o.id, o.name, o.contact, o.note]; } },
  // One row per order line, keyed by the line ID. Status is Ordered, Received or Cancelled; a line can be received in parts.
  order: { name: 'Supplier orders', col: 1, head: ['ID', 'Order ID', 'Date', 'Supplier ID', 'Supplier', 'Product ID', 'Product', 'Qty', 'Cost each', 'Expected', 'Received qty', 'Status', 'Note'], text: ['A:G', 'J:J', 'L:M'],
    from: function (v) { return { id: s_(v[0]), orderId: s_(v[1]), date: dateStr_(v[2]), supId: s_(v[3]), sup: s_(v[4]), sku: s_(v[5]), name: s_(v[6]), qty: Number(v[7]), cost: num_(v[8]), expected: dateStr_(v[9]), recQty: Number(v[10]) || 0, status: s_(v[11]), note: String(v[12]) }; },
    to: function (o) { return [o.id, o.orderId, o.date, o.supId, o.sup, o.sku, o.name, o.qty, blank_(o.cost), o.expected, o.recQty, o.status, o.note]; } },
  // Total is the subtotal less Discount (never below zero) plus Shipping fee, see total_(); Balance is Total less Paid. A blank Discount or fee reads as 0.
  inv: { name: 'Invoices', col: 2, head: ['No', 'ID', 'Date', 'Customer ID', 'Customer', 'Contact', 'Total', 'Paid', 'Balance', 'Shipping', 'Discount', 'Shipping fee'], text: ['B:F', 'J:J'],
    from: function (v) { return { no: Number(v[0]), id: s_(v[1]), date: dateStr_(v[2]), custId: s_(v[3]), cust: s_(v[4]), contact: s_(v[5]), total: Number(v[6]), paid: Number(v[7]), balance: Number(v[8]), ship: s_(v[9]), disc: Number(v[10]) || 0, fee: Number(v[11]) || 0 }; },
    to: function (o) { return [o.no, o.id, o.date, o.custId, o.cust, o.contact, o.total, o.paid, o.balance, o.ship, o.disc, o.fee]; } },
  // Line is 1..n within the invoice. Status is Delivered (left stock), To follow (owed: no movement and no cost yet) or Cancelled.
  // Expected and Order line say when a to-follow line should arrive; Delivered on is the day it left stock. Condition is that of the units it took.
  line: { name: 'Invoice lines', col: 2, keys: 2, key: function (o) { return o.invId + ' line ' + o.line; },
    head: ['Invoice no', 'Invoice ID', 'Line', 'Product ID', 'Product', 'Qty', 'Listed price', 'Charged price', 'Unit cost', 'Status', 'Expected', 'Order line', 'Delivered on', 'Condition'], text: ['B:B', 'D:E', 'J:N'],
    from: function (v) { return { invNo: Number(v[0]), invId: s_(v[1]), line: Number(v[2]), sku: s_(v[3]), name: s_(v[4]), qty: Number(v[5]), list: num_(v[6]), price: Number(v[7]), cost: num_(v[8]), status: s_(v[9]), expected: dateStr_(v[10]), orderLine: s_(v[11]), delivered: dateStr_(v[12]), cond: s_(v[13]) }; },
    to: function (o) { return [o.invNo, o.invId, o.line, o.sku, o.name, o.qty, blank_(o.list), o.price, blank_(o.cost), o.status, o.expected, o.orderLine, o.delivered, o.cond]; } },
  // Returns are only ever appended.
  ret: { name: 'Returns', col: 1, head: ['ID', 'Date', 'Invoice no', 'Invoice ID', 'Customer', 'Product ID', 'Product', 'Qty', 'Outcome', 'Refund', 'Note'], text: ['A:B', 'D:G', 'I:I', 'K:K'],
    from: function (v) { return { id: s_(v[0]), date: dateStr_(v[1]), invNo: Number(v[2]), invId: s_(v[3]), cust: s_(v[4]), sku: s_(v[5]), name: s_(v[6]), qty: Number(v[7]), outcome: s_(v[8]), refund: Number(v[9]), note: String(v[10]) }; },
    to: function (o) { return [o.id, o.date, o.invNo, o.invId, o.cust, o.sku, o.name, o.qty, o.outcome, o.refund, o.note]; } }
};
// The tabs only the app writes: protected by setup(), cleared by wipeAllData().
var APP_TABS_ = ['Products', 'Movements'].concat(Object.keys(T_).map(function (k) { return T_[k].name; }));

/**
 * Run once, and again after pasting a newer Code.gs. Creates and formats the tabs and makes the connection key. Never deletes data.
 * It also brings a 2.3 sheet to 2.4: Items becomes Products without Category and Reorder at, In rows get their unit SKU,
 * and Browse is made again when its header is not the current one. And a 2.4 sheet to 2.5, see upgrade25_().
 * A 2.5 sheet becomes 2.6 by the header rows alone: Movements gains Condition, Invoices Discount and Shipping fee, Invoice lines
 * Condition, each a new last column that reads blank on older rows; and the Payment details tab is made.
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), old = ss.getSheetByName('Items'), pr = ss.getSheetByName('Products');
  if (old && !pr) pr = old.setName('Products');
  if (pr) ['Category', 'Reorder at'].forEach(function (h) { var c = pr.getRange(1, 1, 1, pr.getMaxColumns()).getValues()[0].indexOf(h); if (c >= 0) pr.deleteColumn(c + 1); });
  asText_(ensureSheet_(ss, 'Products', ITEM_HEAD_), ['A:B', 'D:D', 'F:K']).getRange('C:C').setNumberFormat('#,##0.00');
  asText_(ensureSheet_(ss, 'Movements', MOVE_HEAD_), ['A:E', 'G:I', 'K:L']).getRange('J:J').setNumberFormat('#,##0.00');
  locked_(function () { upgrade25_(ss); });
  Object.keys(T_).forEach(function (k) { asText_(ensureSheet_(ss, T_[k].name, T_[k].head), T_[k].text); });
  sheet_('Invoices').getRange('K:L').setNumberFormat('#,##0.00');
  // Not protected and not wiped: the owner types these rows.
  asText_(ensureSheet_(ss, 'Payment details', PAY_HEAD_), ['A:C']);
  putShop_(asText_(ensureSheet_(ss, 'Shop', SHOP_HEAD_), ['A:B']), {});
  asText_(ensureSheet_(ss, 'Inbox', INBOX_HEAD_), ['A:O']);
  var br = ss.getSheetByName('Browse');
  if (br && br.getRange(1, 1, 1, BROWSE_HEAD_.length).getValues()[0].join('|') !== BROWSE_HEAD_.join('|')) ss.deleteSheet(br);
  browseSheet_(ss);
  locked_(fillUnits_);
  var ed = asText_(ensureSheet_(ss, 'Edits', EDIT_HEAD_), ['A:E']);
  ed.getRange(2, 2, ed.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(EDIT_FIELDS_), true).setAllowInvalid(false).build());
  // A warning, not a lock: the owner can still edit, but is asked first.
  APP_TABS_.forEach(function (n) {
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

/**
 * 2.4 to 2.5. Invoices and Invoice lines are rewritten in the 2.5 layout, each only while it still has its 2.4 header, so a second
 * run changes nothing: Invoices lose Type and Pre-order ID and get Paid = Total and Balance 0; Invoice lines get Line (1..n per
 * invoice, in sheet order), Status Delivered and Delivered on = the invoice date. Each tab is read, given its 2.5 header and
 * formats (a column that held text and now holds numbers gets a number format), then written back in one call.
 * Supplier orders has no rows in a 2.4 sheet and only gets its header, with Cost each (a text column in 2.4) as a number.
 * Pre-orders is deleted when it has no rows below the header. Suppliers is made by setup() like any other tab.
 */
function upgrade25_(ss) {
  var inv = ss.getSheetByName('Invoices'), ln = ss.getSheetByName('Invoice lines'), so = ss.getSheetByName('Supplier orders'), po = ss.getSheetByName('Pre-orders'), day = {}, n = {};
  var old = function (sh, col, head, width) {
    if (!sh || s_(sh.getRange(1, col).getValue()) !== head) return null;
    var last = lastRowOf_(sh, 2);
    return last < 2 ? [] : sh.getRange(2, 1, last - 1, width).getValues();
  };
  var put = function (k, cols, fmt, rows) {
    asText_(ensureSheet_(ss, T_[k].name, T_[k].head), T_[k].text).getRange(cols).setNumberFormat(fmt);
    if (rows.length) sheet_(T_[k].name).getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  };
  var iv = old(inv, 4, 'Type', 10), lv = old(ln, 3, 'Product ID', 8);
  if (lv && inv) inv.getRange(1, 2, lastRowOf_(inv, 2), 2).getValues().forEach(function (v) { day[s_(v[0])] = dateStr_(v[1]); });
  if (iv) put('inv', 'G:I', '#,##0.00', iv.map(function (v) { return [v[0], v[1], v[2], v[4], v[5], v[6], v[7], v[7], 0, v[8]]; }));
  if (lv) put('line', 'C:C', '0', lv.map(function (v) { var id = s_(v[1]); n[id] = (n[id] || 0) + 1; return [v[0], v[1], n[id], v[2], v[3], v[4], v[5], v[6], v[7], 'Delivered', '', '', day[id] || '']; }));
  if (old(so, 2, 'Date', 1)) put('order', 'I:I', '#,##0.00', []);
  if (po && lastRowOf_(po) < 2) ss.deleteSheet(po);
}

/** Prints the connection key in the execution log (View > Logs). */
function showKey() {
  Logger.log('Key: ' + PropertiesService.getScriptProperties().getProperty('KEY'));
}

/**
 * Run by hand to start again from an empty sheet, after every phone has synced with nothing waiting.
 * Saves a copy of the whole spreadsheet named "Bodega backup <date>" first, then clears every row under the header on the
 * data tabs and Edits, and raises moveRev so each phone drops its movements at its next sync.
 * The key, those tabs, their formatting and the Inbox stay. Browse is deleted instead: the script owns it, and setup() or the
 * next write makes it again with the current header and text columns and no filter left from an older layout.
 */
function wipeAllData() {
  locked_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), name = 'Bodega backup ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    ss.copy(name);
    APP_TABS_.concat('Edits').map(sheet_).forEach(function (sh) { if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, sh.getMaxColumns()).clearContent(); });
    if (ss.getSheetByName('Browse')) ss.deleteSheet(ss.getSheetByName('Browse'));
    raiseRev_();
    Logger.log('Wiped. Backup: ' + name);
  });
}
/** Run by hand, if wanted, after wipeAllData(): clears Status Done on Inbox rows so they come back for review. Dismissed and Working stay. */
function reopenInbox() {
  locked_(function () {
    var sh = sheet_('Inbox'), last = sh.getLastRow(), n = 0;
    // Only the Done cells, so a row an intake run marks Working meanwhile keeps its status.
    if (last >= 2) sh.getRange(2, 13, last - 1, 1).getValues().forEach(function (v, i) { if (s_(v[0]) === 'Done') { sh.getRange(i + 2, 13).clearContent(); n++; } });
    Logger.log('Reopened ' + n + ' Inbox rows.');
  });
}
// The hand-run writers take the script lock too, so a phone syncing at that moment waits for them.
function locked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { fn(); } finally { lock.releaseLock(); }
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
      case 'sync': return out_({ ok: true, data: addEntries_([], body.have).sync });
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
// Text columns stay text, so a Product ID like 0012 or a note starting with "=" is never reinterpreted.
function asText_(sh, cols) { cols.forEach(function (a1) { sh.getRange(a1).setNumberFormat('@'); }); return sh; }
function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('The "' + name + '" tab is missing. Run setup() again in the script editor.');
  return sh;
}

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

/** Products, first row per Product ID. warn, when given, collects a sentence for each Product ID found on more than one row. */
function readItems_(warn) {
  var sh = sheet_('Products');
  var last = lastRowOf_(sh);
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, ITEM_HEAD_.length).getValues();
  var out = [], seen = {}, twice = {};
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i], k = s_(v[0]).toLowerCase();
    if (!k) continue;
    if (seen[k]) { twice[k] = twice[k] || { sku: s_(v[0]), n: 1 }; twice[k].n++; continue; }
    seen[k] = true;
    out.push({ _row: i + 2, sku: s_(v[0]), name: s_(v[1]), price: num_(v[2]), active: s_(v[3]).toLowerCase() !== 'no',
      mfr: s_(v[5]), brand: s_(v[6]), line: s_(v[7]), chr: s_(v[8]), rel: dateStr_(v[9]), relCheck: s_(v[10]).toLowerCase() === 'verify' });
  }
  if (warn) Object.keys(twice).forEach(function (k) { warn.push('Products: Product ID ' + twice[k].sku + ' appears on ' + twice[k].n + ' rows. The first is used.'); });
  return out;
}
// One 11-column Products row; On hand is the number the script last worked out.
function itemRow_(it, have) {
  return [it.sku, it.name, blank_(it.price), it.active ? 'Yes' : 'No', have || 0,
    it.mfr, it.brand, it.line, it.chr, it.rel, it.relCheck ? 'Verify' : ''];
}
function moveOf_(v) { return { id: s_(v[0]), date: dateStr_(v[1]), sku: s_(v[2]), dir: s_(v[4]), qty: Number(v[5]), reason: s_(v[6]), ref: s_(v[7]), note: String(v[8]), cost: num_(v[9]), unit: s_(v[10]), cond: s_(v[11]) }; }
// The rows of a tab that have something in column A, as objects that remember their sheet row.
function readRows_(name, head, from) {
  var sh = sheet_(name), last = lastRowOf_(sh), out = [];
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, head.length).getValues().forEach(function (v, i) { if (s_(v[0])) { var o = from(v); o._row = i + 2; out.push(o); } });
  return out;
}
function readMoves_() { return readRows_('Movements', MOVE_HEAD_, moveOf_); }
/**
 * Stock per lower-case SKU, replayed first in, first out in sheet order, the same way as live() in the app; dates are not used.
 * Each SKU has a queue of units on hand, oldest first ({ id, cost, unit, cond } per unit: an In of Qty 3 is three units at its cost
 * and condition), and a deficit.
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
      for (n -= d; n > 0; n--) u.push({ id: m.id, cost: m.cost, unit: m.unit, cond: m.cond });
    } else {
      if (m.reason === 'Correction') u = units[k] = u.filter(function (x) { return x.id === m.ref && n > 0 ? (n--, false) : true; });
      owe[k] = d + n - u.splice(0, n).length;
    }
  });
  Object.keys(units).forEach(function (k) { stock[k] = units[k].length - (owe[k] || 0); });
  return { stock: stock, units: units };
}
/**
 * Unit SKUs are <Product ID>-<n>, n counting the units of that product ever received, in sheet order, from 1 and never reused.
 * Steps the counters n (per lower-case Product ID) past movement m and returns the SKU m carries: its own, a new one for an In
 * of Qty 1 without one, or '' (an Out; an In of Qty above 1 typed by hand, whose units count but get none). index.html does the same in live().
 */
function unit_(n, m) {
  if (m.dir !== 'In') return '';
  var k = m.sku.toLowerCase(), had = /-(\d+)$/.exec(m.unit || '');
  if (had) { n[k] = Math.max(n[k] || 0, Number(had[1])); return m.unit; }
  n[k] = (n[k] || 0) + m.qty;
  return m.qty === 1 ? m.sku + '-' + n[k] : '';
}
/** Fills SKU (column K) on In rows that have none, in one write; when it filled any, raises moveRev so every phone downloads them. */
function fillUnits_() {
  var sh = sheet_('Movements'), last = lastRowOf_(sh), n = {}, any = false;
  if (last < 2) return;
  var col = sh.getRange(2, 1, last - 1, MOVE_HEAD_.length).getValues().map(function (v) {
    var u = s_(v[0]) ? unit_(n, moveOf_(v)) : '';
    if (u && !s_(v[10])) { any = true; return [u]; }
    return [v[10]];
  });
  if (any) { sh.getRange(2, 11, last - 1, 1).setValues(col); raiseRev_(); }
}
/** Writes On hand (column E) for every product in one call, aligned by the Product ID in each row now. */
function writeOnHand_() {
  var sh = sheet_('Products'), last = lastRowOf_(sh);
  if (last < 2) return;
  var stock = stockOf_(readMoves_()).stock;
  var skus = sh.getRange(2, 1, last - 1, 1).getValues();
  sh.getRange(2, 5, last - 1, 1).setValues(skus.map(function (v) { var k = s_(v[0]).toLowerCase(); return [k ? stock[k] || 0 : '']; }));
}
function browseSheet_(ss) {
  return ss.getSheetByName('Browse') || asText_(ensureSheet_(ss, 'Browse', BROWSE_HEAD_), BROWSE_TEXT_);
}
/** Rewrites Browse: contents below the header cleared, then one write. A filter on the tab stays. */
function writeBrowse_() {
  var sh = browseSheet_(SpreadsheetApp.getActiveSpreadsheet());
  var m = stockOf_(readMoves_()), inc = {}, owed = {};
  readTab_('order').forEach(function (o) { if (o.status === 'Ordered') { var k = o.sku.toLowerCase(); inc[k] = (inc[k] || 0) + o.qty - o.recQty; } });
  readTab_('line').forEach(function (l) { if (l.status === 'To follow') { var k = l.sku.toLowerCase(); owed[k] = (owed[k] || 0) + l.qty; } });
  var rows = readItems_().map(function (it) {
    var k = it.sku.toLowerCase(), have = m.stock[k] || 0, u = m.units[k] || [], i = inc[k] || 0, o = owed[k] || 0, val = 0, none = 0;
    u.forEach(function (x) { if (x.cost == null) none++; else val += x.cost; });
    // Units on hand, stock value and units without cost are blank when no unit is on hand.
    return [it.sku, it.name, blank_(it.price), it.active ? 'Yes' : 'No', have, i, o, have + i - o,
      u.map(function (x) { return (x.unit ? x.unit + ' ' : '') + (x.cost == null ? '?' : x.cost) + (x.cond ? ' ' + x.cond : ''); }).join(', '), u.length ? r2_(val) : '', u.length ? none : '', it.mfr, it.brand, it.line, it.chr, it.rel, it.relCheck ? 'Verify' : ''];
  });
  if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, BROWSE_HEAD_.length).clearContent();
  ensureRows_(sh, rows.length + 1);
  sh.getRange(1, 1, rows.length + 1, BROWSE_HEAD_.length).setValues([BROWSE_HEAD_].concat(rows));
}

/** Inbox rows still waiting: a name and no status. A Type starting with O is an order, with R a receipt, anything else a count. */
function inboxType_(v) { return /^o/i.test(s_(v)) ? 'order' : /^r/i.test(s_(v)) ? 'receive' : 'count'; }
function readInbox_() {
  var sh = sheet_('Inbox'), last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, INBOX_HEAD_.length).getValues(), out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (!s_(v[2]) || s_(v[12])) continue;
    out.push({ row: i + 2, added: dateStr_(v[0]), type: inboxType_(v[1]), name: s_(v[2]), qty: s_(v[3]), cost: s_(v[4]), mfr: s_(v[5]), brand: s_(v[6]), line: s_(v[7]), chr: s_(v[8]), rel: dateStr_(v[9]), verify: s_(v[10]), note: s_(v[11]), supplier: s_(v[13]), expected: dateStr_(v[14]) });
  }
  return out;
}
function readTab_(k) { return readRows_(T_[k].name, T_[k].head, T_[k].from); }
/** Payment details rows that have a Method, in sheet order. A missing tab (setup() not run since 2.5) reads as none rather than failing the sync. */
function readPay_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payment details'), last = sh ? sh.getLastRow() : 0;
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, PAY_HEAD_.length).getValues().filter(function (v) { return s_(v[0]); }).map(function (v) { return { method: s_(v[0]), number: s_(v[1]), name: s_(v[2]) }; });
}
// The Shop tab's rows as it is now: { lower-case label: { row, value } }, the first row per label.
function shopRows_(sh) {
  var last = sh.getLastRow(), at = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (v, i) { var k = s_(v[0]).toLowerCase(); if (k && !at[k]) at[k] = { row: i + 2, value: s_(v[1]) }; });
  return at;
}
/** The shop's details { name, contact, foot, cur }, '' where blank. A missing tab (setup() not run since 2.6) reads as blank. */
function readShop_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Shop'), at = sh ? shopRows_(sh) : {}, out = {};
  SHOP_.forEach(function (f) { var r = at[f[0].toLowerCase()]; out[f[1]] = r ? r.value : ''; });
  return out;
}

// ---------- reading ----------

// moveRev is raised whenever movement rows change other than by appending (a cost entry, wipeAllData()), so the next sync sends them all.
function moveRev_() { return Number(PropertiesService.getScriptProperties().getProperty('moveRev')) || 0; }
function raiseRev_() { PropertiesService.getScriptProperties().setProperty('moveRev', String(moveRev_() + 1)); }
function logoRev_() { return Number(PropertiesService.getScriptProperties().getProperty('LOGO_REV')) || 0; }
/** The logo's data URL, put together from its chunks; '' when there is none. */
function logo_() {
  var p = PropertiesService.getScriptProperties(), out = '';
  for (var i = 0, n = Number(p.getProperty('LOGO_N')) || 0; i < n; i++) out += p.getProperty('LOGO_' + i) || '';
  return out;
}
/** Stores a new logo ('' removes it) and raises LOGO_REV; the same logo again changes nothing. Chunks, count and rev go in one call. */
function setLogo_(url) {
  if (url === logo_()) return;
  var p = PropertiesService.getScriptProperties(), had = Number(p.getProperty('LOGO_N')) || 0, n = Math.ceil(url.length / LOGO_CHUNK_);
  var set = { LOGO_N: String(n), LOGO_REV: String(logoRev_() + 1) };
  for (var i = 0; i < n; i++) set['LOGO_' + i] = url.slice(i * LOGO_CHUNK_, (i + 1) * LOGO_CHUNK_);
  p.setProperties(set);
  for (i = n; i < had; i++) p.deleteProperty('LOGO_' + i);
}

/**
 * Returns every item and document plus the movement rows the app does not have yet.
 * have = { rows, lastId, moveRev } describes the movement rows the app already holds. If moveRev is the script's and the sheet
 * still has that last row in the same place, only later rows are sent; otherwise everything is sent with reset = true.
 * Customers, suppliers, supplier order lines, invoices (with their lines, in Line order), returns, waiting Inbox rows, the payment
 * details and the shop's details (shop, with logoRev) are always sent whole. The logo is sent only when have.logoRev is not LOGO_REV,
 * since it is the one big value.
 * warnings lists problems found in the tabs, one plain sentence each.
 */
function snapshot_(have) {
  var sh = sheet_('Movements'), rev = moveRev_();
  var rows = lastRowOf_(sh) - 1;
  var from = 0, reset = true;
  if (have && have.moveRev === rev && have.rows > 0 && have.rows <= rows && have.lastId) {
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
  readTab_('line').forEach(function (l) { if (byInv[l.invId]) byInv[l.invId].lines.push({ line: l.line, sku: l.sku, name: l.name, qty: l.qty, list: l.list, price: l.price, cost: l.cost, status: l.status, expected: l.expected, orderLine: l.orderLine, delivered: l.delivered, cond: l.cond }); });
  invs.forEach(function (x) { x.lines.sort(function (a, b) { return a.line - b.line; }); });
  var shop = readShop_(), out = { items: readItems_(warnings), moves: moves, rows: rows, lastId: lastId, reset: reset, moveRev: rev, syncedAt: new Date().toISOString(),
    custs: readTab_('cust'), sups: readTab_('sup'), orders: readTab_('order'), invs: invs, rets: readTab_('ret'), inbox: readInbox_(), pay: readPay_(), shop: shop, warnings: warnings };
  shop.logoRev = logoRev_();
  if (!have || have.logoRev !== shop.logoRev) out.logo = logo_();
  return out;
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
  return r2_(n);
}
function moneyOrNull_(v, what) { return v === '' || v == null ? null : money_(v, what); }
// A unit's condition: '' or one of CONDITIONS_. many: a sale line's, the conditions of the units it takes joined with ' / ', each in the list.
function cond_(v, many) {
  var c = s_(v);
  if (c && (many ? c.split(' / ') : [c]).some(function (x) { return CONDITIONS_.indexOf(x) < 0; })) throw new Error('Condition must be one of ' + CONDITIONS_.join(', '));
  return c;
}
// An invoice's total from its subtotal (the sum of qty x price), discount and shipping fee. index.html works it out the same way.
function total_(sub, disc, fee) { return r2_(Math.max(0, r2_(sub) - disc) + fee); }
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
  if (!x) throw new Error('Missing product');
  var sku = String(x.sku || '').trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(sku)) throw new Error('Product ID must be 1 to 32 letters, digits, dots, dashes or underscores');
  var name = String(x.name || '').trim();
  if (!name) throw new Error('Name is required');
  if (name.length > 120) throw new Error('Name is too long');
  var price = x.price == null || x.price === '' ? null : Number(x.price);
  if (price != null && (isNaN(price) || price < 0)) throw new Error('Price must be a number, zero or more');
  return { sku: sku, name: name, price: price, active: x.active !== false,
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
  return { id: id, date: date, sku: String(x.sku || '').trim(), dir: dir, qty: qty, reason: reason, ref: text_(x.ref, 60), note: text_(x.note, 300), cost: moneyOrNull_(x.cost, 'Unit cost'), cond: cond_(x.cond) };
}

// The fields a shop entry carries; an absent (or null) field is left out, so the sheet keeps what it has. The logo is a PNG or JPEG data URL, or '' to remove it.
function cleanShop_(x) {
  var out = {};
  SHOP_.forEach(function (f) {
    if (x[f[1]] == null) return;
    out[f[1]] = s_(x[f[1]]);
    if (out[f[1]].length > f[2]) throw new Error(f[0] + ' is too long');
  });
  if (x.logo != null) {
    out.logo = s_(x.logo);
    if (out.logo.length > LOGO_MAX_) throw new Error('The logo is too large; choose a smaller picture.');
    if (out.logo && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+\/]+=*$/.test(out.logo)) throw new Error('The logo must be a PNG or JPEG picture.');
  }
  return out;
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
 * move        move { id, date, sku, dir, qty, reason, ref, note, cost, cond }
 *                                                                      one stock movement; cond is '' or one condition (the units of an In)
 * cust        cust { id, name, contact }                               new customer, or new details for one
 * supplier    supplier { id, name, contact, note }                     new supplier, or new details for one
 * order       order { id, date, supId, expected, note, lines: [{ id, sku, qty, cost }] }
 *                                                                      one Supplier orders row per line (Ordered); a line ID on file is skipped
 * receive     lineId, date, from, costs, conds                         units from+1 ... from+n of a line (n = costs.length): one In/Restock per unit,
 *                                                                      rcv-<lineId>-<from+k>, Ref = order ID, Unit cost costs[k-1] (a number, or null
 *                                                                      for blank), Condition conds[k-1] ('' when missing); Received qty = max(it,
 *                                                                      from + n), Received when it reaches Qty
 * orderCancel lineId                                                   line Cancelled; what was received stays
 * invoice     invoice { id, no, date, custId, paid, disc, fee, lines: [{ sku, qty, price, cost, cond, follow, expected, orderLine }] }
 *                                                                      invoice + lines 1..n; a line with follow: true is To follow (no movement,
 *                                                                      blank cost and condition), any other is Delivered with an Out/Sale movement
 *                                                                      <id>-<line>, Ref = invoice no, carrying its cost and cond; Total per total_()
 *                                                                      (disc, fee blank = 0; disc at most the subtotal); paid blank = paid in full
 * deliver     invId, line, date, cost, cond                            To follow line Delivered + its Out/Sale movement <invId>-<line>
 * pay         invId, paid                                              new total paid on an invoice
 * lineCancel  invId, line, refund                                      To follow line Cancelled; Total per total_() over the lines not Cancelled,
 *                                                                      Paid less the refund
 * follow      invId, line, expected, orderLine                         new expected date or order line on a To follow line
 * ship        invId, ship ('Delivered' or '')                          delivered mark on an invoice
 * ret         ret { id, date, invId, sku, qty, outcome, refund, note } return of Delivered units + movements per RETURN_STOCK_: for Restock one
 *                                                                      In/Return per unit, ret-<id>-1 ..., at the cost of the first Delivered line of
 *                                                                      that product, and its condition when that is a single one
 * cost        moveId, cost (a number, or null to clear it)             Unit cost (column J) of an In movement with a unit still on hand; raises moveRev
 * cond        moveId, cond ('' or one condition)                       Condition (column L) of the same; raises moveRev
 * inboxDone   rows [{ row, name, added?, type?, qty? }], mark          Inbox rows handled ('Done' or 'Dismissed')
 * shop        shop { name?, contact?, foot?, cur?, logo? }, fill?      the shop's details: each field present is set to its value; with fill: true
 *                                                                      only where the sheet has it blank (the logo only when none is stored);
 *                                                                      written after the other writes, see writeShop_()
 *
 * A condition is one of CONDITIONS_; an invoice line and its Sale movement may carry several joined with ' / ', see cond_().
 *
 * Two phones can each invent the same next SKU while offline. An item sent with auto: true that meets a
 * different item on its SKU is renumbered, the rest of the batch follows the new SKU, and the result carries
 * { sku, from } so the app can renumber what is still queued. A refused item blocks the rest of the batch
 * for its SKU, so a movement or document can never land on another item that happens to own that SKU.
 * Invoice numbers are plain sequential numbers picked by the phone. A number already used by a
 * different document is replaced by the next free one and the result carries { no, fromNo }.
 * Pending rows of the Edits tab are applied first, as edit entries. Their results go to the Edits tab, not the app.
 * Browse is rewritten last. A sync is an add with no entries.
 * Returns { results: [{ id, ok, error, sku?, from?, no?, fromNo? }], sync, warnings }.
 */
function addEntries_(entries, have) {
  var eds = editRows_(), mine = eds.filter(function (x) { return x.entry; }).map(function (x) { return x.entry; }), all = mine.concat(entries);
  var results = all.length ? apply_(all) : [];
  finishEdits_(eds, results.slice(0, mine.length));
  writeBrowse_();
  var sync = snapshot_(have);
  return { results: results.slice(mine.length), sync: sync, warnings: sync.warnings };
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
// Row numbers per key, read from n key cells starting at column col (default 1), as the tab is now. Products match Product IDs
// without regard to case. Two key cells (Invoice lines) read as "<Invoice ID> line <Line>".
function keyRows_(sh, col, lower, n) {
  var last = lastRowOf_(sh, col), map = {};
  if (last < 2) return map;
  sh.getRange(2, col, last - 1, n || 1).getValues().forEach(function (v, i) {
    var k = keyOf_(v); if (lower) k = k.toLowerCase();
    if (k) (map[k] = map[k] || []).push(i + 2);
  });
  return map;
}
function keyOf_(v) { return v.length < 2 ? s_(v[0]) : s_(v[0]) && s_(v[1]) ? s_(v[0]) + ' line ' + s_(v[1]) : ''; }
// The tabs whose rows change in place: [sheet name, key column, key of a record, records, record -> row, width, first column (default 1),
// key cells (default 1)]. On Movements only Unit cost and Condition change in place, by a cost or cond entry: the row's J:L is written in
// one call, with the SKU it already had in K.
function tabsOf_(p) {
  var out = [['Products', 1, itemKey_, p.items, function (it) { return itemRow_(it, p.stock[it.sku.toLowerCase()]); }, ITEM_HEAD_.length]];
  ['cust', 'sup', 'order', 'inv', 'line'].forEach(function (k) { out.push([T_[k].name, T_[k].col, T_[k].key || idKey_, p.tabs[k], T_[k].to, T_[k].head.length, 1, T_[k].keys]); });
  out.push(['Movements', 1, idKey_, p.moves, function (m) { return [blank_(m.cost), m.unit, m.cond]; }, 3, 10]);
  return out;
}
/** Plan-time check: { entryId: message } for each entry that touched a row whose key is now missing or repeated. */
function check_(p) {
  var bad = {};
  tabsOf_(p).forEach(function (t) {
    var dirty = t[3].filter(function (o) { return o._row && o._dirty; });
    if (!dirty.length) return;
    var map = keyRows_(sheet_(t[0]), t[1], t[0] === 'Products', t[7]);
    dirty.forEach(function (o) {
      var n = (map[t[2](o)] || []).length;
      if (n !== 1) o._by.forEach(function (id) { bad[id] = bad[id] || moved_(t[0], t[0] === 'Products' ? o.sku : t[2](o), n); });
    });
  });
  return bad;
}

/**
 * Writes a plan. Rows changed in place go first, each one to the row that holds its key at that moment
 * (the key cell is read again just before the write, and the column again if it moved), as one row in one call.
 * A row written on Movements raises moveRev. New rows follow, after the last used row of the key column, without those of
 * entries refused on the way. Then On hand, then the Inbox marks, then the shop's details.
 */
function write_(p, skip) {
  var changed = false;
  tabsOf_(p).forEach(function (t) {
    var dirty = t[3].filter(function (o) { return o._row && o._dirty; });
    if (!dirty.length) return;
    var sh = sheet_(t[0]), lower = t[0] === 'Products', map = keyRows_(sh, t[1], lower, t[7]), width = t[5];
    dirty.forEach(function (o) {
      var key = t[2](o), shown = lower ? o.sku : key, gone = o._by.filter(function (id) { return skip[id]; })[0];
      if (gone) { o._by.forEach(function (id) { skip[id] = skip[id] || skip[gone]; }); return; }
      var rows = map[key] || [], at = rows.length === 1 ? rows[0] : 0, cell = at ? keyOf_(sh.getRange(at, t[1], 1, t[7] || 1).getValues()[0]) : '';
      if (!at || (lower ? cell.toLowerCase() : cell) !== key) { map = keyRows_(sh, t[1], lower, t[7]); rows = map[key] || []; at = rows.length === 1 ? rows[0] : 0; }
      if (!at) { o._by.forEach(function (id) { skip[id] = skip[id] || moved_(t[0], shown, rows.length); }); return; }
      sh.getRange(at, t[6] || 1, 1, width).setValues([t[4](o)]);
      if (lower) changed = true;
      if (t[0] === 'Movements') raiseRev_();
    });
  });
  var keep = function (o) { return !skip[o._by[0]]; };
  var items = p.newItems.filter(keep), moves = p.newMoves.filter(function (m) { return !skip[m.by]; });
  append_(sheet_('Products'), 1, items.map(function (it) { return itemRow_(it, p.stock[it.sku.toLowerCase()]); }));
  append_(sheet_('Movements'), 1, moves.map(function (m) { return m.v; }));
  Object.keys(T_).forEach(function (k) { append_(sheet_(T_[k].name), T_[k].col, p.tabs[k].filter(function (o) { return !o._row && keep(o); }).map(T_[k].to)); });
  if (changed || items.length || moves.length) writeOnHand_();
  markInbox_(p.marks.filter(function (m) { return !skip[m.by]; }));
  writeShop_(p.shop.filter(function (s) { return !skip[s.by]; }));
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
  if (!marks.length) return;
  var sh = sheet_('Inbox'), last = sh.getLastRow();
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
/** Writes the planned shop fields [{ f, v }], the last value per field: the logo to Script Properties, the rest to the Shop tab (made when missing). */
function writeShop_(sets) {
  var v = {}, ss = SpreadsheetApp.getActiveSpreadsheet();
  sets.forEach(function (s) { v[s.f] = s.v; });
  if (v.hasOwnProperty('logo')) setLogo_(v.logo);
  if (SHOP_.some(function (f) { return v.hasOwnProperty(f[1]); })) putShop_(ss.getSheetByName('Shop') || asText_(ensureSheet_(ss, 'Shop', SHOP_HEAD_), ['A:B']), v);
}
/**
 * Puts values { name: value, ... } on the Shop tab by label, found as the tab is now: in the first row with that label, only when it
 * differs. A label with no row gets a new one after the last row, with its value or blank; setup() passes {} to add only those.
 */
function putShop_(sh, vals) {
  var at = shopRows_(sh), add = [];
  SHOP_.forEach(function (f) {
    var r = at[f[0].toLowerCase()], v = vals[f[1]];
    if (!r) add.push([f[0], v == null ? '' : v]);
    else if (v != null && v !== r.value) sh.getRange(r.row, 2).setValues([[v]]);
  });
  if (!add.length) return;
  var start = sh.getLastRow() + 1;
  ensureRows_(sh, start + add.length - 1);
  sh.getRange(start, 1, add.length, 2).setValues(add);
}

/** Pending rows of the Edits tab: a Product ID or field filled and no Status. Each becomes an edit entry, or carries the reason it cannot. */
function editRows_() {
  var sh = sheet_('Edits'), last = sh.getLastRow(), out = [];
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, EDIT_HEAD_.length).getValues().forEach(function (v, i) {
    if (s_(v[3]) || (!s_(v[0]) && !s_(v[1]) && !s_(v[2]))) return;
    var x = { row: i + 2, sku: s_(v[0]), field: s_(v[1]), value: v[2] };
    try {
      if (!x.sku) throw new Error('Product ID is required');
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
  } else p[f] = t === '' && f === 'price' ? null : t;
  return p;
}
/** Writes Done or Refused and the reason on each Edits row, found again by its row, Product ID, field and value. */
function finishEdits_(eds, results) {
  if (!eds.length) return;
  var sh = sheet_('Edits'), last = sh.getLastRow();
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
  var bySku = {}, byName = {}, existingIds = {}, unitNo = {};
  items.forEach(function (it) { bySku[it.sku.toLowerCase()] = it; byName[norm_(it.name)] = it; });
  moveList.forEach(function (m) { existingIds[m.id] = true; unit_(unitNo, m); });
  var custs = readTab_('cust'), sups = readTab_('sup'), orders = readTab_('order'), invs = readTab_('inv'), lines = readTab_('line'), rets = readTab_('ret');
  var custById = index_(custs, 'id'), supById = index_(sups, 'id'), orderById = index_(orders, 'id'), invById = index_(invs, 'id'), invByNo = index_(invs, 'no'), retById = index_(rets, 'id');
  var newItems = [], newMoves = [], results = [], remap = {}, refused = {}, marks = [], shopSets = [], shop = null, who = null;
  // Every record remembers the entries that changed it (_by), so a row that cannot be written fails exactly those.
  function touch_(o) { o._dirty = true; o._by = o._by || []; if (o._by.indexOf(who) < 0) o._by.push(who); }
  function made_(o) { o._by = [who]; return o; }
  function skuOf_(sku) { var k = String(sku || '').toLowerCase(); return remap[k] || String(sku || ''); }
  function guard_(sku) { if (refused[String(sku || '').toLowerCase()]) throw new Error('Skipped because its product was refused'); }
  function toy_(sku) {
    var real = skuOf_(sku);
    guard_(real);
    var it = bySku[real.toLowerCase()];
    if (!it) throw new Error('Unknown product ' + sku);
    return it;
  }
  function cust_(id) { var c = custById[s_(id)]; if (!c) throw new Error('Unknown customer'); return c; }
  // A line by invoice ID and line number; the first when the owner copied a row, which the write then refuses.
  function line_(invId, n) {
    var l = lines.filter(function (x) { return x.invId === s_(invId) && x.line === Number(n); })[0];
    if (!l || !invById[l.invId]) throw new Error('Unknown invoice line');
    return l;
  }
  function orderLine_(id) { if (s_(id) && !orderById[s_(id)]) throw new Error('Unknown supplier order line'); return s_(id); }
  function allMoves_() { return moveList.concat(newMoves.map(function (m) { return moveOf_(m.v); })); }
  // Every In row gets the next unit SKU of its product.
  function pushMove_(id, date, it, dir, qty, reason, ref, note, cost, cond) {
    if (existingIds[id]) return;
    existingIds[id] = true;
    newMoves.push({ v: [id, date, it.sku, it.name, dir, qty, reason, ref, note, blank_(cost), unit_(unitNo, { sku: it.sku, dir: dir, qty: qty }), cond || ''], by: who });
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
          if (!e.auto) throw new Error('Product ID ' + it.sku + ' already belongs to "' + cur.name + '"');
          // Same name under another SKU: this is a retry of an item that was already renumbered, so reuse it.
          var same = byName[norm_(it.name)];
          if (same) { remap[asked.toLowerCase()] = same.sku; results.push({ id: e.id, ok: true, sku: same.sku, from: asked }); return; }
          it.sku = freeSku_(bySku); remap[asked.toLowerCase()] = it.sku; cur = null;
        }
        if (!cur) {
          if (byName[norm_(it.name)]) throw new Error('A product named "' + byName[norm_(it.name)].name + '" already exists');
          bySku[it.sku.toLowerCase()] = it; byName[norm_(it.name)] = it; newItems.push(made_(it));
        }
        if (it.sku !== asked) { results.push({ id: e.id, ok: true, sku: it.sku, from: asked }); return; }

      } else if (e.kind === 'edit') {
        var target = toy_(e.sku), p = e.patch || {};
        var merged = { sku: target.sku };
        ['name', 'price', 'active', 'mfr', 'brand', 'line', 'chr', 'rel', 'relCheck'].forEach(function (f) { merged[f] = p[f] !== undefined ? p[f] : target[f]; });
        merged = cleanItem_(merged);
        var clash = byName[norm_(merged.name)];
        if (clash && clash.sku !== target.sku) throw new Error('A product named "' + clash.name + '" already exists');
        delete byName[norm_(target.name)];
        Object.keys(merged).forEach(function (f) { target[f] = merged[f]; });
        byName[norm_(target.name)] = target;
        touch_(target);

      } else if (e.kind === 'move') {
        var m = cleanMove_(e.move);
        if (!existingIds[m.id]) pushMove_(m.id, m.date, toy_(m.sku), m.dir, m.qty, m.reason, m.ref, m.note, m.cost, m.cond);

      } else if (e.kind === 'cust') {
        var c = e.cust || {}, cid = id_(c.id, 'Customer'), cname = text_(c.name, 120);
        if (!cname) throw new Error('Customer name is required');
        var have_ = custById[cid];
        if (!have_) { have_ = made_({ id: cid }); custs.push(have_); custById[cid] = have_; } else touch_(have_);
        have_.name = cname; have_.contact = text_(c.contact, 120);

      } else if (e.kind === 'supplier') {
        var su = e.supplier || {}, suid = id_(su.id, 'Supplier'), suname = text_(su.name, 120);
        if (!suname) throw new Error('Supplier name is required');
        var hs = supById[suid];
        if (!hs) { hs = made_({ id: suid }); sups.push(hs); supById[suid] = hs; } else touch_(hs);
        hs.name = suname; hs.contact = text_(su.contact, 120); hs.note = text_(su.note, 300);

      } else if (e.kind === 'order') {
        // Every line is checked before any is made, so a bad line refuses the whole order.
        var o = e.order || {}, oid = id_(o.id, 'Supplier order'), osu = supById[s_(o.supId)];
        if (!osu) throw new Error('Unknown supplier');
        if (!o.lines || !o.lines.length) throw new Error('An order needs at least one product');
        var odate = date_(o.date), oexp = s_(o.expected) ? date_(o.expected, 'Expected arrival') : '', onote = text_(o.note, 300);
        o.lines.map(function (l) {
          var lit = toy_(l.sku);
          return { id: id_(l.id, 'Order line'), orderId: oid, date: odate, supId: osu.id, sup: osu.name, sku: lit.sku, name: lit.name, qty: qty_(l.qty), cost: moneyOrNull_(l.cost, 'Cost each'), expected: oexp, recQty: 0, status: 'Ordered', note: onote };
        }).forEach(function (ol) { if (!orderById[ol.id]) { orders.push(made_(ol)); orderById[ol.id] = ol; } });

      } else if (e.kind === 'receive') {
        // One movement per unit with its own cost and condition; either may be blank and typed later. When every movement is
        // already on file this is a retry and changes nothing, even on a line received or cancelled since.
        var ro = orderById[s_(e.lineId)];
        if (!ro) throw new Error('Unknown supplier order line');
        var rf = Number(e.from), rcs = (e.costs || []).map(function (c) { return moneyOrNull_(c, 'Unit cost'); }), rn = qty_(rcs.length);
        var rks = rcs.map(function (c, j) { return cond_((e.conds || [])[j]); });
        if (!(rf >= 0) || Math.floor(rf) !== rf) throw new Error('Received so far must be a whole number');
        var rids = rcs.map(function (c, j) { return 'rcv-' + ro.id + '-' + (rf + j + 1); });
        if (!rids.every(function (id) { return existingIds[id]; })) {
          if (ro.status === 'Cancelled') throw new Error('That order line was cancelled');
          if (rf + rn > ro.qty) throw new Error('Only ' + Math.max(ro.qty - rf, 0) + ' of ' + ro.name + ' are still due on that order line');
          var rd = date_(e.date), rcit = toy_(ro.sku);
          rcs.forEach(function (c, j) { pushMove_(rids[j], rd, rcit, 'In', 1, 'Restock', ro.orderId, '', c, rks[j]); });
        }
        var rq = Math.max(ro.recQty, rf + rn), rs = ro.status === 'Ordered' && rq >= ro.qty ? 'Received' : ro.status;
        if (rq !== ro.recQty || rs !== ro.status) { ro.recQty = rq; ro.status = rs; touch_(ro); }

      } else if (e.kind === 'orderCancel') {
        var co = orderById[s_(e.lineId)];
        if (!co) throw new Error('Unknown supplier order line');
        if (co.status === 'Received') throw new Error('That order line was already received');
        if (co.status !== 'Cancelled') { co.status = 'Cancelled'; touch_(co); }

      } else if (e.kind === 'invoice') {
        // A to-follow line is owed: no movement, no cost and no condition until a deliver entry ships it. paid blank means paid in full.
        var v = e.invoice || {}, vid = id_(v.id, 'Invoice');
        if (invById[vid]) { results.push(numbered_(e, invById[vid], v.no)); return; }
        var vc = cust_(v.custId), vdate = date_(v.date);
        if (!v.lines || !v.lines.length) throw new Error('An invoice needs at least one product');
        if (v.lines.length > 50) throw new Error('An invoice can hold 50 lines at most');
        var sub = 0, vlines = v.lines.map(function (l) {
          var lit = toy_(l.sku), f = l.follow === true, lq = qty_(l.qty), lp = money_(l.price, 'Price');
          sub += lq * lp;
          return { it: lit, qty: lq, price: lp, cost: f ? null : moneyOrNull_(l.cost, 'Unit cost'), cond: f ? '' : cond_(l.cond, true), follow: f,
            expected: f && s_(l.expected) ? date_(l.expected, 'Expected arrival') : '', orderLine: f ? orderLine_(l.orderLine) : '' };
        });
        if (!vc.contact && vlines.some(function (l) { return l.follow; })) throw new Error('A to-follow line needs the customer\'s phone or Messenger');
        var disc = moneyOrNull_(v.disc, 'Discount') || 0, fee = moneyOrNull_(v.fee, 'Shipping fee') || 0;
        if (disc > r2_(sub)) throw new Error('The discount is more than the subtotal');
        var total = total_(sub, disc, fee), paid = v.paid === '' || v.paid == null ? total : money_(v.paid, 'Amount paid');
        if (paid > total) throw new Error('Amount paid is more than the total');
        var inv = { no: docNo_(v.no), id: vid, date: vdate, custId: vc.id, cust: vc.name, contact: vc.contact, total: total, paid: paid, balance: r2_(total - paid), ship: '', disc: disc, fee: fee };
        invs.push(made_(inv)); invById[vid] = inv; invByNo[inv.no] = inv;
        vlines.forEach(function (l, i) {
          lines.push(made_({ invNo: inv.no, invId: vid, line: i + 1, sku: l.it.sku, name: l.it.name, qty: l.qty, list: l.it.price, price: l.price, cost: l.cost,
            status: l.follow ? 'To follow' : 'Delivered', expected: l.expected, orderLine: l.orderLine, delivered: l.follow ? '' : vdate, cond: l.cond }));
          if (!l.follow) pushMove_(vid + '-' + (i + 1), vdate, l.it, 'Out', l.qty, 'Sale', String(inv.no), '', l.cost, l.cond);
        });
        results.push(numbered_(e, inv, v.no)); return;

      } else if (e.kind === 'deliver') {
        // Ships a to-follow line under its invoice number at the cost and condition the app worked out at that moment. A Delivered line is left as it is.
        var dl = line_(e.invId, e.line);
        if (dl.status === 'Cancelled') throw new Error('That line was cancelled');
        if (dl.status === 'To follow') {
          var dd = date_(e.date), dc = moneyOrNull_(e.cost, 'Unit cost'), dk = cond_(e.cond, true);
          pushMove_(dl.invId + '-' + dl.line, dd, toy_(dl.sku), 'Out', dl.qty, 'Sale', String(dl.invNo), '', dc, dk);
          dl.status = 'Delivered'; dl.cost = dc; dl.cond = dk; dl.delivered = dd; touch_(dl);
        }

      } else if (e.kind === 'pay') {
        var pi = invById[s_(e.invId)];
        if (!pi) throw new Error('Unknown invoice');
        var np = money_(e.paid, 'Amount paid');
        if (np > pi.total) throw new Error('Amount paid is more than the total');
        if (np !== pi.paid) { pi.paid = np; pi.balance = r2_(pi.total - np); touch_(pi); }

      } else if (e.kind === 'lineCancel') {
        // The total is worked out again from the lines left, with the invoice's discount and fee; the refund leaves Paid. A Cancelled line is left as it is.
        var cl = line_(e.invId, e.line), ci = invById[cl.invId];
        if (cl.status === 'Delivered') throw new Error('That line was already delivered; record a return instead');
        if (cl.status === 'To follow') {
          var refund = moneyOrNull_(e.refund, 'Refund') || 0, lsub = 0;
          if (refund > ci.paid) throw new Error('The refund is more than what was paid');
          cl.status = 'Cancelled'; touch_(cl); touch_(ci);
          lines.forEach(function (l) { if (l.invId === ci.id && l.status !== 'Cancelled') lsub += l.qty * l.price; });
          ci.total = total_(lsub, ci.disc, ci.fee); ci.paid = r2_(ci.paid - refund); ci.balance = r2_(ci.total - ci.paid);
        }

      } else if (e.kind === 'follow') {
        // The values the line already has are not refused, so a retry after the line shipped still succeeds.
        var fl = line_(e.invId, e.line), fe = s_(e.expected) ? date_(e.expected, 'Expected arrival') : '', fo = orderLine_(e.orderLine);
        if (fl.expected !== fe || fl.orderLine !== fo) {
          if (fl.status !== 'To follow') throw new Error('Only a to-follow line has an expected arrival');
          fl.expected = fe; fl.orderLine = fo; touch_(fl);
        }

      } else if (e.kind === 'ship') {
        var si = invById[s_(e.invId)];
        if (!si) throw new Error('Unknown invoice');
        var st = s_(e.ship);
        if (SHIP_.indexOf(st) < 0) throw new Error('Shipping status must be Delivered or blank');
        if (si.ship !== st) { si.ship = st; touch_(si); }

      } else if (e.kind === 'ret') {
        var r = e.ret || {}, retId = id_(r.id, 'Return');
        if (!retById[retId]) {
          var ri = invById[s_(r.invId)];
          if (!ri) throw new Error('Unknown invoice');
          var rit = toy_(r.sku), rqty = qty_(r.qty), outcome = s_(r.outcome);
          if (!RETURN_STOCK_.hasOwnProperty(outcome)) throw new Error('Outcome must be Restock or Write-off');
          // Only Delivered lines left stock. A restocked unit comes back at the Unit cost of the first of them for that product,
          // and in its condition when that is a single one.
          var sold = 0, back = 0, rcost, rcond;
          lines.forEach(function (l) { if (l.invId === ri.id && l.sku === rit.sku && l.status === 'Delivered') { if (rcost === undefined) { rcost = l.cost; rcond = l.cond.indexOf(' / ') < 0 ? l.cond : ''; } sold += l.qty; } });
          rets.forEach(function (x) { if (x.invId === ri.id && x.sku === rit.sku) back += x.qty; });
          if (!sold) throw new Error(rit.name + ' was not delivered on invoice ' + ri.no);
          if (rqty > sold - back) throw new Error('Only ' + (sold - back) + ' of ' + rit.name + ' can still be returned on invoice ' + ri.no);
          var rdate = date_(r.date);
          var ret = { id: retId, date: rdate, invNo: ri.no, invId: ri.id, cust: ri.cust, sku: rit.sku, name: rit.name, qty: rqty, outcome: outcome, refund: moneyOrNull_(r.refund, 'Refund') || 0, note: text_(r.note, 300) };
          rets.push(made_(ret)); retById[retId] = ret;
          if (RETURN_STOCK_[outcome] === 'In') for (var k = 1; k <= rqty; k++) pushMove_('ret-' + retId + '-' + k, rdate, rit, 'In', 1, 'Return', retId, 'Invoice ' + ri.no, rcost, rcond);
        }

      } else if (e.kind === 'cost' || e.kind === 'cond') {
        // A unit's cost or condition, only while a unit of that In is on hand, after every movement so far including this request's.
        // The same value again changes nothing and is not refused, so a retry after a lost response still succeeds once the unit has been sold.
        var f = e.kind, mid = s_(e.moveId), mc = f === 'cost' ? moneyOrNull_(e.cost, 'Unit cost') : cond_(e.cond), now = allMoves_();
        var tm = now.filter(function (x) { return x.id === mid; })[0], nm = newMoves.filter(function (x) { return x.v[0] === mid; })[0];
        if (!tm) throw new Error('Unknown movement');
        var left = tm.dir === 'In' && (stockOf_(now).units[tm.sku.toLowerCase()] || []).some(function (u) { return u.id === mid; });
        if (tm.dir !== 'In' || (!left && tm[f] !== mc)) throw new Error('That unit has already left stock, so its ' + (f === 'cost' ? 'cost' : 'condition') + ' can no longer be changed.');
        if (tm[f] !== mc) { if (nm) nm.v[f === 'cost' ? 9 : 11] = blank_(mc); else { tm[f] = mc; touch_(tm); } }

      } else if (e.kind === 'inboxDone') {
        // Marked after the other writes, by markInbox_; a row that cannot be found is left waiting.
        var mark = e.mark === 'Dismissed' ? 'Dismissed' : 'Done';
        (e.rows || []).forEach(function (x) { if (x && s_(x.name)) marks.push({ x: x, mark: mark, by: who }); });

      } else if (e.kind === 'shop') {
        // Checked whole first. Values are absolute, so a retry changes nothing; fill only sets what the sheet (as this request leaves it) has blank.
        var sv = cleanShop_(e.shop || {});
        if (!shop) { shop = readShop_(); shop.logo = logo_(); }
        Object.keys(sv).forEach(function (f) { if (e.fill === true && shop[f]) return; shop[f] = sv[f]; shopSets.push({ f: f, v: sv[f], by: who }); });

      } else {
        throw new Error('Unknown entry type');
      }
      results.push({ id: e.id, ok: true });
    } catch (err) {
      if (e.kind === 'item' && e.item && e.item.sku) refused[String(e.item.sku).toLowerCase()] = true;
      results.push({ id: e.id, ok: false, error: String(err.message || err) });
    }
  });

  var stock = stockOf_(allMoves_()).stock;
  return { results: results, items: items, moves: moveList, newItems: newItems, newMoves: newMoves, marks: marks, shop: shopSets, stock: stock,
    tabs: { cust: custs, sup: sups, order: orders, inv: invs, line: lines, ret: rets } };
}
