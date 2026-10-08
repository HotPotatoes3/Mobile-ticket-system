// Local preview of the Apps Script app: runs Code.gs in Node against an
// in-memory fake spreadsheet, so the UI can be tried and tested without Google.
//   node dev/server.js            -> http://localhost:8080  (staff PIN: 1234)
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'apps-script');
const PORT = Number(process.env.PORT || 8080);
const PIN = process.env.STAFF_PIN || '1234';

function fakeSheet(name) {
  const rows = [];
  return {
    name,
    rows,
    appendRow(r) { rows.push(r.map((v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v))); },
    setFrozenRows() {},
    getLastRow() { return rows.length; },
    getRange(row, col, numRows, numCols) {
      return { getValues: () => rows.slice(row - 1, row - 1 + numRows).map((r) => {
        const out = r.slice(col - 1, col - 1 + numCols);
        while (out.length < numCols) out.push('');
        return out;
      }) };
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
    ScriptApp: { getService: () => ({ getUrl: () => `http://localhost:${PORT}/` }) },
    HtmlService: {},
    Logger: { log() {} },
    Date, Math, String, Number, Error, JSON, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  ctx.setup();
  return { ctx, sheets };
}

// Stand-in for the google.script.* client API that Apps Script injects.
const CLIENT_SHIM = `<script>
(function () {
  function runner(ok, fail) {
    return new Proxy({}, { get(_, prop) {
      if (prop === 'withSuccessHandler') return (f) => runner(f, fail);
      if (prop === 'withFailureHandler') return (f) => runner(ok, f);
      return (...args) => fetch('/rpc', { method: 'POST', body: JSON.stringify({ fn: prop, args }) })
        .then((r) => r.json())
        .then((r) => (r.error ? fail && fail(new Error(r.error)) : ok && ok(r.result)));
    } });
  }
  const params = () => Object.fromEntries(new URLSearchParams(location.search));
  let onChange = null;
  window.addEventListener('popstate', () => onChange && onChange({ location: { parameter: params() } }));
  window.google = { script: {
    run: runner(null, null),
    url: { getLocation: (cb) => setTimeout(() => cb({ parameter: params() })) },
    history: {
      push: (st, p) => history.pushState(st, '', '?' + new URLSearchParams(p || {})),
      setChangeHandler: (f) => { onChange = f; },
    },
  } };
})();
</script>`;

function start() {
  let backend = createBackend();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/rpc') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { fn, args } = JSON.parse(body);
        let out;
        try {
          if (typeof backend.ctx[fn] !== 'function' || fn.endsWith('_')) throw new Error('Unknown function ' + fn);
          out = { result: JSON.parse(JSON.stringify(backend.ctx[fn](...args))) };
        } catch (e) {
          out = { error: e.message };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/__reset') {
      backend = createBackend();
      res.end('ok');
      return;
    }
    if (req.url === '/__sheets') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Object.fromEntries(Object.entries(backend.sheets).map(([k, s]) => [k, s.rows]))));
      return;
    }
    const html = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8')
      .replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">' + CLIENT_SHIM);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

if (require.main === module) {
  start().then(() => console.log(`Swap Shop preview on http://localhost:${PORT}  (staff PIN: ${PIN})`));
}
module.exports = { start, PORT };
