/**
 * Toy Stock API: a Google Apps Script web app bound to the "Toy Inventory" spreadsheet.
 *
 * Install: Extensions > Apps Script, paste this whole file over Code.gs, save, run setup() once,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * The app talks to the deployment URL with a shared key; see README.md and ARCHITECTURE.md.
 *
 * The app is the only writer. Items and Movements are append-only apart from item edits.
 */
var VERSION_ = '1.0.0';
var ITEM_HEAD_ = ['SKU', 'Name', 'Category', 'Price', 'Reorder at', 'Active', 'On hand'];
var MOVE_HEAD_ = ['ID', 'Date', 'SKU', 'Item', 'Direction', 'Qty', 'Reason', 'Ref', 'Note'];
var IN_ONLY_ = ['Opening', 'Restock', 'Return'];
var OUT_ONLY_ = ['Sale', 'Damaged', 'Lost'];
var EITHER_ = ['Count', 'Correction', 'Other'];
// One formula in Items!G2 fills the whole On hand column, so new items need no formula copying.
var ON_HAND_ = '=ARRAYFORMULA(IF(LEN(A2:A), SUMIFS(Movements!F:F, Movements!C:C, A2:A, Movements!E:E, "In") - SUMIFS(Movements!F:F, Movements!C:C, A2:A, Movements!E:E, "Out"), ))';

/** Run once. Creates the two tabs, formats them, and makes the connection key. Safe to run again. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var items = ensureSheet_(ss, 'Items', ITEM_HEAD_);
  var moves = ensureSheet_(ss, 'Movements', MOVE_HEAD_);
  // Text columns stay text, so a SKU like 0012 or a note starting with "=" is never reinterpreted.
  items.getRange('A:C').setNumberFormat('@');
  items.getRange('F:F').setNumberFormat('@');
  items.getRange('D:D').setNumberFormat('#,##0.00');
  moves.getRange('A:E').setNumberFormat('@');
  moves.getRange('G:I').setNumberFormat('@');
  if (!items.getRange('G2').getFormula()) items.getRange('G2').setFormula(ON_HAND_);
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

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- sheet helpers ----------

function ensureSheet_(ss, name, head) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}
function itemsSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Items'); }
function movesSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Movements'); }

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
function num_(v) { if (v === '' || v == null) return null; var n = Number(v); return isNaN(n) ? null : n; }
function dateStr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).trim();
}

function readItems_() {
  var sh = itemsSheet_();
  var last = lastRowOf_(sh);
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 6).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (!String(v[0]).trim()) continue;
    out.push({ row: i + 2, sku: String(v[0]).trim(), name: String(v[1]).trim(), cat: String(v[2]).trim(), price: num_(v[3]), min: num_(v[4]), active: String(v[5]).trim().toLowerCase() !== 'no' });
  }
  return out;
}
function itemRow_(it) {
  return [it.sku, it.name, it.cat, it.price == null ? '' : it.price, it.min == null ? '' : it.min, it.active ? 'Yes' : 'No'];
}

// ---------- reading ----------

/**
 * Returns every item plus the movement rows the app does not have yet.
 * have = { rows, lastId } describes the movement rows the app already holds. If the sheet still has
 * that last row in the same place, only later rows are sent; otherwise everything is sent with reset = true.
 */
function snapshot_(have) {
  var items = readItems_().map(function (it) { return { sku: it.sku, name: it.name, cat: it.cat, price: it.price, min: it.min, active: it.active }; });
  var sh = movesSheet_();
  var rows = lastRowOf_(sh) - 1;
  var from = 0, reset = true;
  if (have && have.rows > 0 && have.rows <= rows && have.lastId) {
    if (String(sh.getRange(have.rows + 1, 1).getValue()) === String(have.lastId)) { from = have.rows; reset = false; }
  }
  var moves = [];
  if (rows > from) {
    var vals = sh.getRange(from + 2, 1, rows - from, 9).getValues();
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (!String(v[0]).trim()) continue;
      moves.push({ id: String(v[0]).trim(), date: dateStr_(v[1]), sku: String(v[2]).trim(), dir: String(v[4]).trim(), qty: Number(v[5]), reason: String(v[6]).trim(), ref: String(v[7]).trim(), note: String(v[8]) });
    }
  }
  var lastId = rows > 0 ? String(sh.getRange(rows + 1, 1).getValue()) : '';
  return { items: items, moves: moves, rows: rows, lastId: lastId, reset: reset, syncedAt: new Date().toISOString() };
}

// ---------- writing ----------

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
  return { sku: sku, name: name, cat: String(x.cat || '').trim().slice(0, 60), price: price, min: min, active: x.active !== false };
}

function cleanMove_(x) {
  if (!x) throw new Error('Missing movement');
  var id = String(x.id || '').trim();
  if (!id || id.length > 60) throw new Error('Movement needs an ID');
  var date = String(x.date || '').trim();
  var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  var dt = d ? new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])) : null;
  if (!dt || dt.getUTCFullYear() !== +d[1] || dt.getUTCMonth() !== +d[2] - 1 || dt.getUTCDate() !== +d[3]) throw new Error('Date must look like 2026-11-15');
  var dir = String(x.dir || '');
  if (dir !== 'In' && dir !== 'Out') throw new Error('Direction must be In or Out');
  var qty = Number(x.qty);
  if (!(qty >= 1) || Math.floor(qty) !== qty || qty > 100000) throw new Error('Qty must be a whole number from 1 to 100000');
  var reason = String(x.reason || '');
  var okReason = EITHER_.indexOf(reason) >= 0 || (dir === 'In' ? IN_ONLY_ : OUT_ONLY_).indexOf(reason) >= 0;
  if (!okReason) throw new Error(reason + ' cannot be recorded as ' + dir);
  return { id: id, date: date, sku: String(x.sku || '').trim(), dir: dir, qty: qty, reason: reason, ref: String(x.ref || '').trim().slice(0, 60), note: String(x.note || '').trim().slice(0, 300) };
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

/**
 * entries: [{ id, kind: 'item' | 'edit' | 'move', ... }] applied in order. Every entry is idempotent
 * (an item by SKU and name, a movement by its ID), so a retry after a lost response changes nothing.
 * Two phones can each invent the same next SKU while offline. An item sent with auto: true that meets a
 * different toy on its SKU is renumbered, the rest of the batch follows the new SKU, and the result carries
 * { sku, from } so the app can renumber what is still queued. A refused item blocks the rest of the batch
 * for its SKU, so a movement can never land on another toy that happens to own that SKU.
 * Returns { results: [{ id, ok, error, sku?, from? }], sync }.
 */
function addEntries_(entries, have) {
  var itemSh = itemsSheet_(), moveSh = movesSheet_();
  var items = readItems_();
  var bySku = {}, byName = {};
  items.forEach(function (it) { bySku[it.sku.toLowerCase()] = it; byName[norm_(it.name)] = it; });
  var existingIds = idSet_(moveSh);
  var newItems = [], editedRows = {}, newMoves = [], results = [], remap = {}, refused = {};
  function skuOf_(sku) { var k = String(sku || '').toLowerCase(); return remap[k] || String(sku || ''); }
  function guard_(sku) { if (refused[String(sku || '').toLowerCase()]) throw new Error('Skipped because its toy was refused'); }

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
        var tsku = skuOf_(e.sku);
        guard_(tsku);
        var target = bySku[tsku.toLowerCase()];
        if (!target) throw new Error('Unknown item ' + e.sku);
        var merged = cleanItem_({
          sku: target.sku,
          name: e.patch && e.patch.name !== undefined ? e.patch.name : target.name,
          cat: e.patch && e.patch.cat !== undefined ? e.patch.cat : target.cat,
          price: e.patch && e.patch.price !== undefined ? e.patch.price : target.price,
          min: e.patch && e.patch.min !== undefined ? e.patch.min : target.min,
          active: e.patch && e.patch.active !== undefined ? e.patch.active : target.active
        });
        var clash = byName[norm_(merged.name)];
        if (clash && clash.sku !== target.sku) throw new Error('An item named "' + clash.name + '" already exists');
        delete byName[norm_(target.name)];
        target.name = merged.name; target.cat = merged.cat; target.price = merged.price; target.min = merged.min; target.active = merged.active;
        byName[norm_(target.name)] = target;
        if (target.row) editedRows[target.row] = target;
      } else if (e.kind === 'move') {
        var m = cleanMove_(e.move);
        m.sku = skuOf_(m.sku);
        guard_(m.sku);
        if (!existingIds[m.id]) {
          var item = bySku[m.sku.toLowerCase()];
          if (!item) throw new Error('Unknown item ' + m.sku);
          existingIds[m.id] = true;
          newMoves.push([m.id, m.date, item.sku, item.name, m.dir, m.qty, m.reason, m.ref, m.note]);
        }
      } else {
        throw new Error('Unknown entry type');
      }
      results.push({ id: e.id, ok: true });
    } catch (err) {
      if (e.kind === 'item' && e.item && e.item.sku) refused[String(e.item.sku).toLowerCase()] = true;
      results.push({ id: e.id, ok: false, error: String(err.message || err) });
    }
  });

  Object.keys(editedRows).forEach(function (r) { itemSh.getRange(Number(r), 1, 1, 6).setValues([itemRow_(editedRows[r])]); });
  if (newItems.length) {
    var start = lastRowOf_(itemSh) + 1;
    ensureRows_(itemSh, start + newItems.length - 1);
    itemSh.getRange(start, 1, newItems.length, 6).setValues(newItems.map(itemRow_));
  }
  if (newMoves.length) {
    var mStart = lastRowOf_(moveSh) + 1;
    ensureRows_(moveSh, mStart + newMoves.length - 1);
    moveSh.getRange(mStart, 1, newMoves.length, 9).setValues(newMoves);
  }
  return { results: results, sync: snapshot_(have) };
}
