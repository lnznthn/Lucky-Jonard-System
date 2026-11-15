// Runs apps-script/Code.gs unchanged against an in-memory fake of the Google services it uses,
// and serves it over HTTP like the /exec URL. Test-only: node test/mock-backend.js [port]
const fs = require('fs'), vm = require('vm'), http = require('http'), path = require('path');

function colNum(s) { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n; }

class Range {
  constructor(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = this.sh.cell(this.r + i, this.c + j); row.push(v === undefined ? '' : v); } out.push(row); } return out; }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) { if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('Mock: range size ' + this.nr + 'x' + this.nc + ' does not match values ' + vals.length + 'x' + vals[0].length); vals.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v))); return this; }
  setValue(v) { this.sh.set(this.r, this.c, v); return this; }
  setNumberFormat(f) { if (f === '@' && this.r === 1 && this.nr === this.sh.max) for (let j = 0; j < this.nc; j++) this.sh.textCols.add(this.c + j); return this; }
  setFontWeight() { return this; }
  getFormula() { return this.sh.formulas[this.r + ',' + this.c] || ''; }
  setFormula(f) { this.sh.formulas[this.r + ',' + this.c] = f; return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.cells = {}; this.formulas = {}; this.max = 1000; this.frozen = 0; this.textCols = new Set(); }
  cell(r, c) { return this.cells[r + ',' + c]; }
  set(r, c, v) { if (r > this.max) throw new Error('Mock: row ' + r + ' beyond grid ' + this.max); if (typeof v === 'string' && /^[=+@-]/.test(v) && !this.textCols.has(c) && r > 1) throw new Error('Mock: column ' + c + ' is not text-formatted, so "' + v + '" would become a formula'); this.cells[r + ',' + c] = v; }
  getMaxRows() { return this.max; }
  insertRowsAfter(after, n) { this.max += n; }
  setFrozenRows(n) { this.frozen = n; }
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
  const sheets = [new Sheet('Sheet1')];
  const props = {};
  const ss = {
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = new Sheet(n); sheets.push(s); return s; },
    getSheets: () => sheets,
    deleteSheet: s => { sheets.splice(sheets.indexOf(s), 1); },
  };
  let locked = false;
  const sandbox = {
    sheets, props, logs: [],
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (locked) throw new Error('locked'); locked = true; }, releaseLock() { locked = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    Utilities: { getUuid: () => require('crypto').randomUUID(), formatDate: d => d.toISOString().slice(0, 10) },
    Session: { getScriptTimeZone: () => 'UTC' },
    Logger: { log: m => sandbox.logs.push(String(m)) },
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
    if (req.url.startsWith('/_key')) { res.writeHead(200, cors); return res.end(sb.props.KEY); }
    if (req.url.startsWith('/_reset')) { sb = load(); res.writeHead(200, cors); return res.end(sb.props.KEY); }
    if (req.url.startsWith('/_dump')) {
      const dump = {}; sb.sheets.forEach(s => { const rows = []; for (let r = 1; r <= s.getLastRow(); r++) { const row = []; for (let c = 1; c <= 9; c++) row.push(s.cell(r, c) === undefined ? '' : s.cell(r, c)); rows.push(row); } dump[s.name] = { rows, formulas: s.formulas }; });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(dump));
    }
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      let out;
      if (req.method === 'POST') { sb.__e = { postData: { contents: body } }; out = vm.runInContext('doPost(__e)', sb).text; }
      else out = vm.runInContext('doGet()', sb).text;
      if (process.env.MOCK_LATENCY) return setTimeout(() => { res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(out); }, +process.env.MOCK_LATENCY);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(out);
    });
  }).listen(port, () => console.log('mock backend on ' + port));
}
