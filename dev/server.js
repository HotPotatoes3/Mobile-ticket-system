// Local preview: serves the ticket page from docs/ and runs apps-script/Code.gs
// in Node against an in-memory fake spreadsheet, so everything can be tried and
// tested without Google.
//   node dev/server.js            -> http://localhost:8080  (staff PIN: 1234)
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'apps-script');
const DOCS = path.join(__dirname, '..', 'docs');
const PORT = Number(process.env.PORT || 8080);
const PIN = process.env.STAFF_PIN || '1234';

function fakeSheet(name) {
  const rows = [];
  // Like Sheets, a leading apostrophe forces plain text and isn't part of the value.
  const unquote = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
  return {
    name,
    rows,
    appendRow(r) { rows.push(r.map(unquote)); },
    setFrozenRows() {},
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((n, r) => Math.max(n, r.length), 0); },
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues: () => rows.slice(row - 1, row - 1 + numRows).map((r) => {
          const out = r.slice(col - 1, col - 1 + numCols);
          while (out.length < numCols) out.push('');
          return out;
        }),
        setValues(values) {
          values.forEach((vals, i) => {
            const r = (rows[row - 1 + i] = rows[row - 1 + i] || []);
            vals.forEach((v, j) => { r[col - 1 + j] = unquote(v); });
          });
          return this;
        },
        setValue(v) { return this.setValues([[v]]); },
        getValue: () => (rows[row - 1] || [])[col - 1] ?? '',
      };
    },
  };
}

function createBackend() {
  const sheets = {};
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sheets[n] || null,
      insertSheet: (n) => (sheets[n] = fakeSheet(n)),
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'STAFF_PIN' ? PIN : null) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { sleep() {}, getUuid: () => crypto.randomUUID() },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ setMimeType() { return this; }, getContent: () => text }),
    },
    HtmlService: {
      createHtmlOutput: (html) => ({ setTitle() { return this; }, addMetaTag() { return this; }, getContent: () => html }),
    },
    Logger: { log() {} },
    Date, Math, String, Number, Error, JSON, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  ctx.setup();
  return { ctx, sheets };
}

function start() {
  let backend = createBackend();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const out = backend.ctx.doPost({ postData: { contents: body } });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(out.getContent());
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__reset') {
      backend = createBackend();
      res.end('ok');
      return;
    }
    if (url.pathname === '/__sheets') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Object.fromEntries(Object.entries(backend.sheets).map(([k, s]) => [k, s.rows]))));
      return;
    }
    if (url.pathname === '/config.js') {
      // Same settings as docs/config.js, but pointed at this local server.
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end("window.SWAP_SHOP = { eventName: 'UCM YDSA Swap Shop', apiUrl: '/api', maxPerEntry: 50 };");
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(DOCS, 'index.html')));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

if (require.main === module) {
  start().then(() => console.log(`Swap Shop preview on http://localhost:${PORT}  (staff PIN: ${PIN})`));
}
module.exports = { start, PORT, createBackend };
