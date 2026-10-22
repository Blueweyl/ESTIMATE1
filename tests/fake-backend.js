// Runs backend/Code.gs under Node against an in-memory fake of SpreadsheetApp,
// and serves the frontend from the same origin.
const fs = require('fs'), http = require('http'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const REPO = process.argv[2] || path.join(__dirname, "..");
const PORT = Number(process.argv[3] || 8787);

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.maxRows = 1000; this.formulaWrites = 0; }
  write_(v) {
    if (typeof v === 'string' && v[0] === "'") return v.slice(1);       // Sheets text prefix
    if (typeof v === 'string' && v[0] === '=') { this.formulaWrites++; return '#FORMULA:' + v; }
    return v;
  }
  ensure_(r, c) { while (this.rows.length < r) this.rows.push([]); const row = this.rows[r - 1]; while (row.length < c) row.push(''); }
  getLastRow() { for (let i = this.rows.length; i > 0; i--) if (this.rows[i - 1].some(v => v !== '')) return i; return 0; }
  getLastColumn() { return this.rows.reduce((m, r) => { let l = 0; r.forEach((v, i) => { if (v !== '') l = i + 1; }); return Math.max(m, l); }, 0); }
  getMaxRows() { return Math.max(this.maxRows, this.rows.length); }
  appendRow(arr) { const r = this.getLastRow() + 1; this.getRange(r, 1, 1, arr.length).setValues([arr]); }
  setFrozenRows() {}
  insertRowsAfter(after, n) { this.maxRows += n; }
  deleteRows(start, n) {
    if (start <= 1) throw new Error('cannot delete header');
    if (start + n - 1 >= this.getMaxRows() && start === 2) throw new Error('Sorry, it is not possible to delete all non-frozen rows.');
    this.rows.splice(start - 1, n); this.maxRows -= n;
  }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (sh.rows[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; },
      setValues(vals) {
        if (vals.length !== nr || vals.some(v => v.length !== nc)) throw new Error('setValues dimension mismatch');
        vals.forEach((row, i) => row.forEach((v, j) => { sh.ensure_(r + i, c + j); sh.rows[r - 1 + i][c - 1 + j] = sh.write_(v); }));
      },
      setValue(v) { this.setValues([[v]]); },
      getValue() { return this.getValues()[0][0]; },
    };
  }
}
const sheets = {};
const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n)) };
// NO_TOKEN=1 runs without an API_TOKEN property (the optional no-password setup).
const props = process.env.NO_TOKEN ? {} : { API_TOKEN: 'test-token' };
const out = obj => ({ setMimeType() { return this; }, body: obj });
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Session: { getActiveUser: () => ({ getEmail: () => 'qs@example.com' }) },
  Utilities: { getUuid: () => crypto.randomUUID() },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => out(s) },
  console,
};
const code = fs.readFileSync(path.join(REPO, 'backend/Code.gs'), 'utf8');
// Each request is a fresh execution, like Apps Script (resets sheetsEnsured_).
const run = (fnCall, e) => { const c = vm.createContext({ ...ctx, __e: e }); vm.runInContext(code, c); return vm.runInContext(fnCall, c); };

let delayMs = 0;
const log = [];
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__state') { res.end(JSON.stringify(Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, { rows: v.rows, formulaWrites: v.formulaWrites }])))); return; }
  if (u.pathname === '/__log') { res.end(JSON.stringify(log)); return; }
  if (u.pathname === '/__delay') { delayMs = Number(u.searchParams.get('ms')); res.end('ok'); return; }
  if (u.pathname === '/__bump') { // simulate an edit from another tab: bump a project's Version
    const p = sheets.Projects; const id = u.searchParams.get('id');
    p.rows.forEach(r => { if (r[0] === id) r[7] = Number(r[7]) + 1; }); res.end('ok'); return;
  }
  if (u.pathname === '/exec') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => setTimeout(() => {
      const e = req.method === 'POST' ? { postData: { contents: body } } : { parameter: Object.fromEntries(u.searchParams) };
      let result;
      try { result = run(req.method === 'POST' ? 'doPost(__e)' : 'doGet(__e)', e).body; }
      catch (e) { result = JSON.stringify({ ok: false, error: 'HARNESS: ' + e.stack }); }
      log.push({ method: req.method, url: req.url, body: body.slice(0, 300), result: result.slice(0, 300) });
      res.setHeader('Content-Type', 'application/json'); res.end(result);
    }, delayMs));
    return;
  }
  const file = u.pathname === '/' ? '/Estimator.dc.html' : u.pathname;
  const fp = path.join(REPO, file);
  if (!fs.existsSync(fp)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(fs.readFileSync(fp));
}).listen(PORT, () => console.log('listening ' + PORT));
