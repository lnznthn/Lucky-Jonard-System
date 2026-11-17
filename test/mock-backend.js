// Runs apps-script/Code.gs unchanged against an in-memory fake of the Google services it uses,
// and serves it over HTTP like the /exec URL. Test-only: node test/mock-backend.js [port]
const fs = require('fs'), vm = require('vm'), http = require('http'), path = require('path');

function colNum(s) { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n; }

class Range {
  constructor(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = this.sh.cell(this.r + i, this.c + j); row.push(v === undefined ? '' : v); } out.push(row); } return out; }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) { if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('Mock: range size ' + this.nr + 'x' + this.nc + ' does not match values ' + vals.length + 'x' + vals[0].length); vals.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v))); this.sh.writes++; const h = this.sh.ss.onSetValues; if (h) h(this.sh, this); return this; }
  setNumberFormat(f) { if (f === '@' && this.r === 1 && this.nr === this.sh.max) for (let j = 0; j < this.nc; j++) this.sh.textCols.add(this.c + j); return this; }
  setFontWeight() { return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) delete this.sh.cells[(this.r + i) + ',' + (this.c + j)]; return this; }
  setDataValidation(rule) { this.sh.validation = { r: this.r, c: this.c, nr: this.nr, nc: this.nc, rule }; return this; }
}
class Sheet {
  constructor(name, ss) { this.name = name; this.ss = ss || {}; this.cells = {}; this.max = 1000; this.frozen = 0; this.textCols = new Set(); this.protections = []; this.validation = null; this.filter = null; this.writes = 0; }
  cell(r, c) { return this.cells[r + ',' + c]; }
  set(r, c, v) { if (r > this.max) throw new Error('Mock: row ' + r + ' beyond grid ' + this.max); if (typeof v === 'string' && /^[=+@-]/.test(v) && !this.textCols.has(c) && r > 1) throw new Error('Mock: column ' + c + ' is not text-formatted, so "' + v + '" would become a formula'); this.cells[r + ',' + c] = v; }
  getMaxRows() { return this.max; }
  getMaxColumns() { return 26; }
  insertRowsAfter(after, n) { this.max += n; }
  setFrozenRows(n) { this.frozen = n; }
  protect() { const p = { desc: '', warn: false, setDescription(d) { this.desc = d; return this; }, getDescription() { return this.desc; }, setWarningOnly(w) { this.warn = w; return this; } }; this.protections.push(p); return p; }
  getProtections() { return this.protections; }
  // Test helpers: rows 2..last as arrays, and putting them back in a new order (what sorting the tab does).
  rowsOf() { const out = []; for (let r = 2; r <= this.getLastRow(); r++) { const row = []; for (let c = 1; c <= 20; c++) row.push(this.cells[r + ',' + c]); out.push(row); } return out; }
  putRows(rows) { const last = this.getLastRow(); for (let r = 2; r <= last; r++) for (let c = 1; c <= 20; c++) delete this.cells[r + ',' + c]; rows.forEach((row, i) => row.forEach((v, j) => { if (v !== undefined) this.cells[(i + 2) + ',' + (j + 1)] = v; })); }
  getLastRow() { let m = 0; for (const k of Object.keys(this.cells)) { if (this.cells[k] !== '') m = Math.max(m, +k.split(',')[0]); } return m; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(a); if (!m) throw new Error('Mock: bad A1 ' + a);
      const c1 = colNum(m[1]), c2 = m[3] ? colNum(m[3]) : c1; const r1 = m[2] ? +m[2] : 1, r2 = m[4] ? +m[4] : (m[3] ? this.max : r1);
      return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    return new Range(this, a, b, c || 1, d || 1);
  }
}
function makeSandbox() {
  const sheets = [];
  const props = {};
  const copies = [];
  const ss = {
    onSetValues: null,
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = new Sheet(n, ss); sheets.push(s); return s; },
    getSheets: () => sheets,
    deleteSheet: s => { sheets.splice(sheets.indexOf(s), 1); },
    // A copy keeps each tab's cells as they were at that moment.
    copy: n => { const c = { name: n, sheets: sheets.map(s => ({ name: s.name, cells: { ...s.cells } })) }; copies.push(c); return c; },
  };
  sheets.push(new Sheet('Sheet1', ss));
  let locked = false;
  const sandbox = {
    sheets, props, copies,
    ss,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, ProtectionType: { SHEET: 'SHEET' },
      newDataValidation: () => { const b = { list: null, strict: false, requireValueInList(l) { this.list = l; return this; }, setAllowInvalid(a) { this.strict = !a; return this; }, build() { return { list: this.list, strict: this.strict }; } }; return b; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (locked) throw new Error('locked'); locked = true; }, releaseLock() { locked = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    Utilities: { getUuid: () => require('crypto').randomUUID(), formatDate: d => d.toISOString().slice(0, 10) },
    Session: { getScriptTimeZone: () => 'UTC' },
    Logger: { log() {} },
    JSON, Date, Math, Object, String, Number, Array, isNaN, RegExp, Error,
  };
  return sandbox;
}
function load() {
  const sb = makeSandbox();
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), sb);
  vm.runInContext('setup()', sb);
  return sb;
}
module.exports = { load };

if (require.main === module) {
  const port = +process.argv[2] || 8766;
  let sb = load();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.url.startsWith('/_reset')) { sb = load(); res.writeHead(200, cors); return res.end(sb.props.KEY); }
    if (req.url.startsWith('/_dump')) {
      const dump = {}; sb.sheets.forEach(s => { const rows = []; for (let r = 1; r <= s.getLastRow(); r++) { const row = []; for (let c = 1; c <= 20; c++) row.push(s.cell(r, c) === undefined ? '' : s.cell(r, c)); rows.push(row); } dump[s.name] = { rows }; });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(dump));
    }
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      // Test-only: appends rows to the Inbox tab the way the assistant does through a Sheets connector.
      // Body: a JSON array of rows, each an array in INBOX_HEAD_ order or an object with the keys below.
      if (req.url.startsWith('/_inbox')) {
        const keys = ['added', 'type', 'name', 'qty', 'cost', 'mfr', 'brand', 'line', 'chr', 'rel', 'verify', 'note', 'status'];
        const sh = sb.sheets.find(s => s.name === 'Inbox'); let row = sh.getLastRow();
        JSON.parse(body || '[]').forEach(r => { row++; (Array.isArray(r) ? r : keys.map(k => r[k] == null ? '' : r[k])).forEach((v, j) => sh.set(row, j + 1, String(v))); });
        res.writeHead(200, cors); return res.end(String(row));
      }
      // Test-only: puts whole rows into a tab as a person editing the sheet would. Body: { tab, rows: [[...], ...] } replaces rows 2 onward.
      if (req.url.startsWith('/_rows')) {
        const { tab, rows } = JSON.parse(body || '{}'), sh = sb.sheets.find(s => s.name === tab);
        sh.putRows(rows.map(r => r.map(v => (v === '' || v == null ? undefined : v))));
        res.writeHead(200, cors); return res.end(String(rows.length));
      }
      let out;
      if (req.method === 'POST') { sb.__e = { postData: { contents: body } }; out = vm.runInContext('doPost(__e)', sb).text; }
      else out = vm.runInContext('doGet()', sb).text;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(out);
    });
  }).listen(port, () => console.log('mock backend on ' + port));
}
