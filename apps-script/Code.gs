/**
 * Swap Shop digital tickets — Google Apps Script backend.
 *
 * Storage is the Google Sheet this script is bound to:
 *   Members: one row per person (their ticket code, name, contact).
 *   Ledger:  one row per ticket change. A person's balance is the sum of
 *            their Ledger "Change" column, so the Sheet is the source of truth
 *            and doubles as an audit log.
 *
 * Staff actions require the STAFF_PIN script property (see README).
 */

var EVENT_NAME = 'UCM YDSA Swap Shop';
var MAX_TICKETS_PER_ENTRY = 50; // guards against fat-finger typos
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
var CODE_LENGTH = 5;

var MEMBERS_SHEET = 'Members';
var LEDGER_SHEET = 'Ledger';
var MEMBERS_HEADER = ['Code', 'Name', 'Contact', 'Created', 'Created by'];
var LEDGER_HEADER = ['Timestamp', 'Code', 'Name', 'Change', 'Type', 'Note', 'Staff', 'Entry ID', 'Undoes'];

// Column indexes (0-based) into the rows above.
var M = { CODE: 0, NAME: 1, CONTACT: 2, CREATED: 3, CREATED_BY: 4 };
var L = { TS: 0, CODE: 1, NAME: 2, CHANGE: 3, TYPE: 4, NOTE: 5, STAFF: 6, ID: 7, UNDOES: 8 };

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(EVENT_NAME + ' Tickets')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** Run once from the Apps Script editor to create the sheets. Safe to re-run. */
function setup() {
  getSheet_(MEMBERS_SHEET, MEMBERS_HEADER);
  getSheet_(LEDGER_SHEET, LEDGER_HEADER);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName('Balances')) {
    // Live per-person totals, handy to print as a paper backup before the shop opens.
    ss.insertSheet('Balances').appendRow([
      '=QUERY(Ledger!B:D, "select B, C, sum(D) where B is not null group by B, C order by C ' +
        'label B \'Code\', C \'Name\', sum(D) \'Tickets\'", 1)'
    ]);
  }
  if (!PropertiesService.getScriptProperties().getProperty('STAFF_PIN')) {
    Logger.log('Remember to set the STAFF_PIN script property (Project Settings > Script properties).');
  }
}

// ---------------------------------------------------------------------------
// Public API (no PIN needed)
// ---------------------------------------------------------------------------

function getConfig() {
  return { eventName: EVENT_NAME, appUrl: ScriptApp.getService().getUrl(), maxPerEntry: MAX_TICKETS_PER_ENTRY };
}

/** What a ticket holder sees on their own phone. */
function getWallet(code) {
  var data = loadData_();
  var member = data.byCode[normalizeCode_(code)];
  if (!member) throw new Error('No tickets found for code "' + code + '". Double-check it with a volunteer.');
  return publicWallet_(member, data);
}

// ---------------------------------------------------------------------------
// Staff API (PIN required)
// ---------------------------------------------------------------------------

function staffLogin(pin) {
  checkPin_(pin);
  return true;
}

/** Search by code, name, or contact. Empty query returns the most recent people. */
function searchMembers(pin, query) {
  checkPin_(pin);
  var data = loadData_();
  var q = String(query || '').trim().toLowerCase();
  var digits = q.replace(/\D/g, '');
  var matches = data.members.filter(function (m) {
    if (!q) return true;
    if (m.code.toLowerCase() === q) return true;
    if (m.name.toLowerCase().indexOf(q) !== -1) return true;
    if (m.contact.toLowerCase().indexOf(q) !== -1) return true;
    return digits.length >= 4 && m.contact.replace(/\D/g, '').indexOf(digits) !== -1;
  });
  return matches
    .slice(-25)
    .reverse()
    .map(function (m) {
      return { code: m.code, name: m.name, contact: m.contact, balance: data.balances[m.code] || 0 };
    });
}

/** Full view of one person for staff: wallet plus staff-only ledger details. */
function getMemberForStaff(pin, code) {
  checkPin_(pin);
  var data = loadData_();
  var member = data.byCode[normalizeCode_(code)];
  if (!member) throw new Error('No one with code "' + code + '".');
  var wallet = publicWallet_(member, data);
  wallet.contact = member.contact;
  wallet.history = entriesFor_(data, member.code).map(staffEntry_);
  return wallet;
}

/**
 * Register a new donor and (optionally) credit their first donation in one step.
 * If the contact matches someone already registered, credits that person instead
 * of creating a duplicate.
 */
function createMember(pin, staff, name, contact, tickets, note) {
  checkPin_(pin);
  name = cleanText_(name, 60);
  contact = cleanText_(contact, 80);
  if (!name) throw new Error('Please enter a name.');
  tickets = Number(tickets) || 0;
  if (tickets) validateCount_(tickets);

  return withLock_(function () {
    var data = loadData_();
    var existing = contact ? findByContact_(data, contact) : null;
    var code;
    if (existing) {
      code = existing.code;
    } else {
      code = newCode_(data);
      getSheet_(MEMBERS_SHEET, MEMBERS_HEADER).appendRow(
        [code, name, contact, new Date(), cleanText_(staff, 40)].map(sheetSafe_)
      );
      data.byCode[code] = { code: code, name: name, contact: contact };
    }
    if (tickets) {
      appendEntry_(data.byCode[code], tickets, 'DONATION', note || 'Donated ' + tickets + ' item(s)', staff, '');
    }
    var result = getMemberForStaff(pin, code);
    result.matchedExisting = !!existing;
    return result;
  });
}

/** Donation drop-off: 1 item = 1 ticket. */
function addTickets(pin, staff, code, count, note) {
  checkPin_(pin);
  validateCount_(count);
  return withLock_(function () {
    var data = loadData_();
    var member = requireMember_(data, code);
    appendEntry_(member, Number(count), 'DONATION', note || 'Donated ' + count + ' item(s)', staff, '');
    return getMemberForStaff(pin, member.code);
  });
}

/** At the shop: spend tickets on goods. Never lets a balance go below zero. */
function redeemTickets(pin, staff, code, count, note) {
  checkPin_(pin);
  validateCount_(count);
  return withLock_(function () {
    var data = loadData_();
    var member = requireMember_(data, code);
    var balance = data.balances[member.code] || 0;
    if (Number(count) > balance) {
      throw new Error(member.name + ' only has ' + balance + ' ticket' + (balance === 1 ? '' : 's') + '.');
    }
    appendEntry_(member, -Number(count), 'REDEEM', note || 'Took ' + count + ' item(s)', staff, '');
    return getMemberForStaff(pin, member.code);
  });
}

/** Reverse a mistaken entry by adding an opposite entry (the original row stays). */
function undoEntry(pin, staff, entryId) {
  checkPin_(pin);
  return withLock_(function () {
    var data = loadData_();
    var entry = null;
    for (var i = 0; i < data.entries.length; i++) {
      if (data.entries[i].id === entryId) entry = data.entries[i];
    }
    if (!entry) throw new Error('That entry no longer exists.');
    if (entry.type === 'UNDO') throw new Error('An undo can\'t be undone. Add or redeem tickets instead.');
    if (data.undone[entryId]) throw new Error('That entry was already undone.');
    var member = requireMember_(data, entry.code);
    var reversal = -entry.change;
    if ((data.balances[member.code] || 0) + reversal < 0) {
      throw new Error('Undoing this would make the balance negative (tickets were already spent).');
    }
    appendEntry_(member, reversal, 'UNDO', 'Undo: ' + entry.note, staff, entryId);
    return getMemberForStaff(pin, member.code);
  });
}

function getStats(pin) {
  checkPin_(pin);
  var data = loadData_();
  var issued = 0;
  var redeemed = 0;
  // An undone entry and its UNDO cancel out, so both are left out of the totals.
  data.entries.forEach(function (e) {
    if (e.undone || e.type === 'UNDO') return;
    if (e.change > 0) issued += e.change;
    else redeemed -= e.change;
  });
  return {
    people: data.members.length,
    issued: issued,
    redeemed: redeemed,
    outstanding: issued - redeemed,
    recent: data.entries.slice(-15).reverse().map(staffEntry_)
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function checkPin_(pin) {
  var expected = PropertiesService.getScriptProperties().getProperty('STAFF_PIN');
  if (!expected) throw new Error('STAFF_PIN is not set up yet. See the README.');
  if (String(pin || '') !== String(expected)) {
    Utilities.sleep(1500); // slow down guessing
    throw new Error('Wrong staff PIN.');
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('The system is busy — please try again.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getSheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readRows_(name, header) {
  var sheet = getSheet_(name, header);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, header.length).getValues();
}

/** Loads everything once per request; the event is small enough for this. */
function loadData_() {
  var members = readRows_(MEMBERS_SHEET, MEMBERS_HEADER)
    .filter(function (r) { return r[M.CODE]; })
    .map(function (r) {
      return { code: String(r[M.CODE]).toUpperCase(), name: String(r[M.NAME]), contact: String(r[M.CONTACT]) };
    });
  var byCode = {};
  members.forEach(function (m) { byCode[m.code] = m; });

  var balances = {};
  var undone = {};
  var entries = readRows_(LEDGER_SHEET, LEDGER_HEADER)
    .filter(function (r) { return r[L.CODE]; })
    .map(function (r) {
      var e = {
        ts: r[L.TS] instanceof Date ? r[L.TS].toISOString() : String(r[L.TS]),
        code: String(r[L.CODE]).toUpperCase(),
        name: String(r[L.NAME]),
        change: Number(r[L.CHANGE]) || 0,
        type: String(r[L.TYPE]),
        note: String(r[L.NOTE]),
        staff: String(r[L.STAFF]),
        id: String(r[L.ID]),
        undoes: String(r[L.UNDOES])
      };
      balances[e.code] = (balances[e.code] || 0) + e.change;
      if (e.undoes) undone[e.undoes] = true;
      return e;
    });
  entries.forEach(function (e) { e.undone = !!undone[e.id]; });

  return { members: members, byCode: byCode, entries: entries, balances: balances, undone: undone };
}

function appendEntry_(member, change, type, note, staff, undoes) {
  var id = Utilities.getUuid().slice(0, 8);
  getSheet_(LEDGER_SHEET, LEDGER_HEADER).appendRow(
    [new Date(), member.code, member.name, change, type, cleanText_(note, 120), cleanText_(staff, 40), id, undoes || '']
      .map(sheetSafe_)
  );
  return id;
}

function entriesFor_(data, code) {
  return data.entries.filter(function (e) { return e.code === code; }).reverse();
}

function publicWallet_(member, data) {
  return {
    code: member.code,
    name: member.name,
    balance: data.balances[member.code] || 0,
    history: entriesFor_(data, member.code).map(function (e) {
      return { ts: e.ts, change: e.change, type: e.type, note: e.note };
    })
  };
}

function staffEntry_(e) {
  return {
    id: e.id, ts: e.ts, code: e.code, name: e.name, change: e.change,
    type: e.type, note: e.note, staff: e.staff, undone: e.undone
  };
}

function requireMember_(data, code) {
  var member = data.byCode[normalizeCode_(code)];
  if (!member) throw new Error('No one with code "' + code + '".');
  return member;
}

function findByContact_(data, contact) {
  var key = contactKey_(contact);
  if (!key) return null;
  for (var i = 0; i < data.members.length; i++) {
    if (contactKey_(data.members[i].contact) === key) return data.members[i];
  }
  return null;
}

/** Phone numbers compare by digits, emails case-insensitively. */
function contactKey_(contact) {
  var c = String(contact || '').trim().toLowerCase();
  if (c.indexOf('@') !== -1) return c;
  var digits = c.replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : c;
}

function newCode_(data) {
  for (var attempt = 0; attempt < 100; attempt++) {
    var code = '';
    for (var i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    if (!data.byCode[code]) return code;
  }
  throw new Error('Could not generate a unique code.');
}

function normalizeCode_(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function validateCount_(count) {
  var n = Number(count);
  if (!(n >= 1 && n <= MAX_TICKETS_PER_ENTRY && Math.floor(n) === n)) {
    throw new Error('Ticket count must be a whole number from 1 to ' + MAX_TICKETS_PER_ENTRY + '.');
  }
}

function cleanText_(value, maxLen) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** Stops user-entered text like "=IMPORTXML(...)" from becoming a formula. */
function sheetSafe_(value) {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value;
}
