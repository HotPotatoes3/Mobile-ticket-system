/**
 * Swap Shop digital tickets — Google Apps Script backend.
 *
 * Storage is the Google Sheet this script is bound to:
 *   Members: one row per person (their ticket code, name, phone, email).
 *   Ledger:  one row per ticket change. A person's balance is the sum of
 *            their Ledger "Change" column, so the Sheet is the source of truth
 *            and doubles as an audit log.
 *   Items:   one row per donated item (name + description), linked to the
 *            Ledger donation that gave the tickets for it.
 *
 * Paper tickets (from a raffle roll) are tracked in the Ledger's "Paper" column:
 * +N when handed to a donor (with the ticket numbers, if entered), -N when
 * collected at checkout. They never change anyone's phone balance.
 *
 * The ticket page itself is hosted on GitHub Pages (docs/) and calls doPost
 * below. Staff actions require the STAFF_PIN script property (see README).
 */

var EVENT_NAME = 'UCM YDSA Swap Shop';
var PAGE_URL = 'https://hotpotatoes3.github.io/Mobile-ticket-system/'; // the GitHub Pages site
var API_VERSION = 4; // 2 = itemized donations, 3 = phone required + email, 4 = paper tickets
var MAX_TICKETS_PER_ENTRY = 50; // guards against fat-finger typos
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
var CODE_LENGTH = 5;

var MEMBERS_SHEET = 'Members';
var LEDGER_SHEET = 'Ledger';
var ITEMS_SHEET = 'Items';
var MEMBERS_HEADER = ['Code', 'Name', 'Phone', 'Created', 'Created by', 'Email'];
var LEDGER_HEADER = ['Timestamp', 'Code', 'Name', 'Change', 'Type', 'Note', 'Staff', 'Entry ID', 'Undoes', 'Paper', 'Ticket #s'];
var ITEMS_HEADER = ['Timestamp', 'Code', 'Donor', 'Item', 'Description', 'Entry ID', 'Staff', 'Status'];

// Column indexes (0-based) into the rows above.
var M = { CODE: 0, NAME: 1, PHONE: 2, CREATED: 3, CREATED_BY: 4, EMAIL: 5 };
var L = { TS: 0, CODE: 1, NAME: 2, CHANGE: 3, TYPE: 4, NOTE: 5, STAFF: 6, ID: 7, UNDOES: 8, PAPER: 9, SERIALS: 10 };
var I = { TS: 0, CODE: 1, DONOR: 2, ITEM: 3, DESC: 4, ENTRY: 5, STAFF: 6, STATUS: 7 };

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/** Functions the ticket page may call. Anything else is refused. */
var API = {
  getConfig: getConfig,
  getWallet: getWallet,
  staffLogin: staffLogin,
  searchMembers: searchMembers,
  getMemberForStaff: getMemberForStaff,
  createMember: createMember,
  updateContact: updateContact,
  addTickets: addTickets,
  redeemTickets: redeemTickets,
  undoEntry: undoEntry,
  getStats: getStats,
  collectPaper: collectPaper,
  checkPaperTicket: checkPaperTicket
};

/** JSON API used by the ticket page: body is {"fn": "...", "args": [...]}. */
function doPost(e) {
  var reply;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = API.hasOwnProperty(req.fn) ? API[req.fn] : null;
    if (!fn) throw new Error('Unknown request.');
    reply = { ok: true, result: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    reply = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(reply)).setMimeType(ContentService.MimeType.JSON);
}

/** Opening the script URL directly (e.g. an old QR code) points people to the ticket page. */
function doGet(e) {
  var code = normalizeCode_(e && e.parameter && e.parameter.m);
  var url = PAGE_URL + (code ? '?m=' + code : '');
  return HtmlService.createHtmlOutput(
    '<p style="font:18px sans-serif;text-align:center;margin-top:40px">' +
      '<a href="' + url + '" target="_top">Open your Swap Shop tickets &rarr;</a></p>' +
      '<script>try { window.top.location.href = ' + JSON.stringify(url) + '; } catch (e) {}</script>'
  ).setTitle(EVENT_NAME + ' Tickets')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Run once from the Apps Script editor to create the sheets. Safe to re-run. */
function setup() {
  getSheet_(MEMBERS_SHEET, MEMBERS_HEADER);
  getSheet_(LEDGER_SHEET, LEDGER_HEADER);
  getSheet_(ITEMS_SHEET, ITEMS_HEADER);
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
  // apiVersion lets the ticket page refuse to run against an outdated copy of this script.
  return { eventName: EVENT_NAME, maxPerEntry: MAX_TICKETS_PER_ENTRY, apiVersion: API_VERSION };
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

/** Search by code, name, phone, or email. Empty query returns the most recent people. */
function searchMembers(pin, query) {
  checkPin_(pin);
  var data = loadData_();
  var q = String(query || '').trim().toLowerCase();
  var digits = q.replace(/\D/g, '');
  var matches = data.members.filter(function (m) {
    if (!q) return true;
    if (m.code.toLowerCase() === q) return true;
    if (m.name.toLowerCase().indexOf(q) !== -1) return true;
    if (m.email.toLowerCase().indexOf(q) !== -1) return true;
    return digits.length >= 4 && m.phone.replace(/\D/g, '').indexOf(digits) !== -1;
  });
  return matches
    .slice(-25)
    .reverse()
    .map(function (m) {
      return {
        code: m.code, name: m.name, contact: m.contact,
        balance: data.balances[m.code] || 0, paper: data.paperByCode[m.code] || 0
      };
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
  wallet.phone = member.phone;
  wallet.email = member.email;
  wallet.history = entriesFor_(data, member.code).map(staffEntry_);
  return wallet;
}

/**
 * Register a new donor and (optionally) credit their first donation in one step.
 * A phone number is required (for reminder texts); email is optional.
 * `items` is a list of {name, description} (1 item = 1 ticket), or a plain count.
 * If the phone or email matches someone already registered, credits that person
 * instead of creating a duplicate. `paper` (optional) gives paper tickets
 * instead: {first: '1041'} or {} when the ticket numbers weren't noted.
 */
function createMember(pin, staff, name, phone, items, note, email, paper) {
  checkPin_(pin);
  name = cleanText_(name, 60);
  if (!name) throw new Error('Please enter a name.');
  phone = parsePhone_(phone);
  email = parseEmail_(email);
  var donation = parseDonation_(items, note, true);

  return withLock_(function () {
    var data = loadData_();
    var existing = findByPhone_(data, phone) || (email ? findByEmail_(data, email) : null);
    var code;
    if (existing) {
      code = existing.code;
      // Fill in whatever the earlier registration was missing.
      if (!existing.phone || (email && !existing.email)) {
        writeContact_(existing, existing.phone || phone, existing.email || email);
      }
    } else {
      code = newCode_(data);
      getSheet_(MEMBERS_SHEET, MEMBERS_HEADER).appendRow(
        [code, name, phone, new Date(), cleanText_(staff, 40), email].map(sheetSafe_)
      );
      data.byCode[code] = { code: code, name: name, phone: phone, email: email };
    }
    if (donation.count) donate_(data.byCode[code], donation, staff, parsePaper_(data, paper, donation.count));
    var result = getMemberForStaff(pin, code);
    result.matchedExisting = !!existing;
    return result;
  });
}

/** Add or correct a person's phone (required) and email (optional). */
function updateContact(pin, staff, code, phone, email) {
  checkPin_(pin);
  phone = parsePhone_(phone);
  email = parseEmail_(email);
  return withLock_(function () {
    var data = loadData_();
    var member = requireMember_(data, code);
    var other = findByPhone_(data, phone);
    if (other && other.code !== member.code) {
      throw new Error('That phone number already belongs to ' + other.name + ' (' + other.code + ').');
    }
    writeContact_(member, phone, email);
    return getMemberForStaff(pin, member.code);
  });
}

/**
 * Donation drop-off: `items` is a list of {name, description} (1 item = 1 ticket),
 * or a plain count. `paper` (optional) gives paper tickets instead, as in createMember.
 */
function addTickets(pin, staff, code, items, note, paper) {
  checkPin_(pin);
  var donation = parseDonation_(items, note, false);
  return withLock_(function () {
    var data = loadData_();
    var member = requireMember_(data, code);
    donate_(member, donation, staff, parsePaper_(data, paper, donation.count));
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
    // Paper collected at checkout isn't tied to a person.
    var member = entry.code ? requireMember_(data, entry.code) : null;
    var reversal = -entry.change;
    if (member && (data.balances[member.code] || 0) + reversal < 0) {
      throw new Error('Undoing this would make the balance negative (tickets were already spent).');
    }
    appendEntry_(member, reversal, 'UNDO', 'Undo: ' + entry.note, staff, entryId, -entry.paper, '');
    if (entry.items.length) markItemsUndone_(entryId);
    return member ? getMemberForStaff(pin, member.code) : getStats(pin);
  });
}

function getStats(pin) {
  checkPin_(pin);
  var data = loadData_();
  var issued = 0, redeemed = 0, paperGiven = 0, paperCollected = 0;
  // An undone entry and its UNDO cancel out, so both are left out of the totals.
  data.entries.forEach(function (e) {
    if (e.undone || e.type === 'UNDO') return;
    if (e.change > 0) issued += e.change;
    else redeemed -= e.change;
    if (e.paper > 0) paperGiven += e.paper;
    else paperCollected -= e.paper;
  });
  return {
    people: data.members.length,
    issued: issued,
    redeemed: redeemed,
    outstanding: issued - redeemed,
    paperGiven: paperGiven,
    paperCollected: paperCollected,
    paperOut: paperGiven - paperCollected,
    recent: data.entries.slice(-15).reverse().map(staffEntry_),
    paperRecent: data.entries.filter(function (e) { return e.paper; }).slice(-15).reverse().map(staffEntry_)
  };
}

/** At checkout: paper tickets handed in (from anyone). Returns the updated stats. */
function collectPaper(pin, staff, count, note) {
  checkPin_(pin);
  validateCount_(count);
  return withLock_(function () {
    var n = Number(count);
    appendEntry_(null, 0, 'PAPER_IN', cleanText_(note, 120) || 'Collected ' + n + ' paper ticket' + (n === 1 ? '' : 's'),
      staff, '', -n, '');
    return getStats(pin);
  });
}

/** Who was a paper ticket number handed to? Only handouts with ticket numbers noted can be found. */
function checkPaperTicket(pin, number) {
  checkPin_(pin);
  var n = parseTicketNumber_(number);
  var data = loadData_();
  for (var i = data.entries.length - 1; i >= 0; i--) {
    var e = data.entries[i];
    if (e.range && !e.undone && e.type !== 'UNDO' && n >= e.range[0] && n <= e.range[1]) {
      return { found: true, entry: staffEntry_(e) };
    }
  }
  return { found: false };
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
  } else if (sheet.getLastColumn() < header.length) {
    // Sheet made by an older version: add the new columns' headers.
    var have = sheet.getLastColumn();
    sheet.getRange(1, have + 1, 1, header.length - have).setValues([header.slice(have)]);
    if (name === MEMBERS_SHEET && sheet.getRange(1, M.PHONE + 1).getValue() === 'Contact') {
      sheet.getRange(1, M.PHONE + 1).setValue('Phone');
    }
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
    .map(function (r, i) {
      var phone = String(r[M.PHONE] || '');
      var email = String(r[M.EMAIL] || '');
      // Older versions had one "Contact" column that could hold an email.
      if (phone.indexOf('@') !== -1 && !email) { email = phone; phone = ''; }
      return {
        row: i + 2, code: String(r[M.CODE]).toUpperCase(), name: String(r[M.NAME]),
        phone: phone, email: email, contact: [phone, email].filter(String).join(' · ')
      };
    })
    .filter(function (m) { return m.code; });
  var byCode = {};
  members.forEach(function (m) { byCode[m.code] = m; });

  var itemsByEntry = {};
  readRows_(ITEMS_SHEET, ITEMS_HEADER).forEach(function (r) {
    var entryId = String(r[I.ENTRY]);
    if (!entryId || !r[I.ITEM]) return;
    (itemsByEntry[entryId] = itemsByEntry[entryId] || []).push({
      name: String(r[I.ITEM]),
      description: String(r[I.DESC])
    });
  });

  var balances = {};
  var paperByCode = {};
  var undone = {};
  var entries = readRows_(LEDGER_SHEET, LEDGER_HEADER)
    .filter(function (r) { return r[L.CODE] || r[L.PAPER]; })
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
        undoes: String(r[L.UNDOES]),
        paper: Number(r[L.PAPER]) || 0,
        serials: String(r[L.SERIALS] || '')
      };
      e.items = itemsByEntry[e.id] || [];
      e.range = e.paper > 0 && e.serials ? parseRange_(e.serials) : null;
      if (e.code) {
        balances[e.code] = (balances[e.code] || 0) + e.change;
        paperByCode[e.code] = (paperByCode[e.code] || 0) + e.paper;
      }
      if (e.undoes) undone[e.undoes] = true;
      return e;
    });
  entries.forEach(function (e) { e.undone = !!undone[e.id]; });

  return {
    members: members, byCode: byCode, entries: entries, balances: balances,
    paperByCode: paperByCode, undone: undone
  };
}

/** `member` is null for paper collected at checkout. */
function appendEntry_(member, change, type, note, staff, undoes, paper, serials) {
  var id = Utilities.getUuid().slice(0, 8);
  getSheet_(LEDGER_SHEET, LEDGER_HEADER).appendRow(
    [new Date(), member ? member.code : '', member ? member.name : '', change, type, cleanText_(note, 120),
      cleanText_(staff, 40), id, undoes || '', paper || 0, serials || ''].map(sheetSafe_)
  );
  return id;
}

/**
 * Normalizes a donation given as a list of {name, description} items or as a
 * plain ticket count. Blank item rows are ignored.
 */
function parseDonation_(items, note, allowEmpty) {
  var list = [];
  var count;
  if (Array.isArray(items)) {
    items.forEach(function (it) {
      var name = cleanText_(it && it.name, 60);
      var description = cleanText_(it && it.description, 200);
      if (!name && !description) return;
      if (!name) throw new Error('Every item needs a name (e.g. "Jacket").');
      list.push({ name: name, description: description });
    });
    count = list.length;
    if (!count && !allowEmpty) throw new Error('List at least one item.');
  } else {
    count = Number(items) || 0;
  }
  if (count || !allowEmpty) validateCount_(count);
  var names = list.map(function (it) { return it.name; }).join(', ');
  return {
    count: count,
    items: list,
    note: cleanText_(note, 120) || (names ? 'Donated: ' + names : 'Donated ' + count + ' item(s)')
  };
}

/** `paper` (from parsePaper_) gives paper tickets instead of phone tickets. */
function donate_(member, donation, staff, paper) {
  var entryId = paper
    ? appendEntry_(member, 0, 'DONATION', donation.note, staff, '', donation.count, paper.serials)
    : appendEntry_(member, donation.count, 'DONATION', donation.note, staff, '');
  if (donation.items.length) {
    var now = new Date();
    var rows = donation.items.map(function (it) {
      return [now, member.code, member.name, it.name, it.description, entryId, cleanText_(staff, 40), ''].map(sheetSafe_);
    });
    var sheet = getSheet_(ITEMS_SHEET, ITEMS_HEADER);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ITEMS_HEADER.length).setValues(rows);
  }
  return entryId;
}

/**
 * Paper handout details: null for phone tickets, otherwise {serials} where
 * serials is '#1041–1045' (or '' if the first ticket number wasn't noted).
 * Refuses numbers that overlap tickets already handed out, which catches typos.
 */
function parsePaper_(data, paper, count) {
  if (!paper) return null;
  var raw = String(paper.first == null ? '' : paper.first).trim();
  if (!raw) return { serials: '' };
  var first = parseTicketNumber_(raw);
  var last = first + count - 1;
  var digits = raw.replace(/\D/g, '');
  var pad = function (n) { var s = String(n); while (s.length < digits.length) s = '0' + s; return s; };
  data.entries.forEach(function (e) {
    if (e.range && !e.undone && e.type !== 'UNDO' && first <= e.range[1] && last >= e.range[0]) {
      throw new Error('Ticket ' + formatRange_(pad(first), pad(last)) + ' overlaps ' + e.serials +
        ', already given to ' + e.name + ' (' + e.code + '). Check the number on the first ticket.');
    }
  });
  return { serials: formatRange_(pad(first), pad(last)) };
}

function parseTicketNumber_(value) {
  var digits = String(value == null ? '' : value).replace(/^\s*(#|no\.?)\s*/i, '').trim();
  if (!/^\d{1,9}$/.test(digits)) throw new Error('Ticket numbers are digits only, like 1041.');
  return Number(digits);
}

/** The "#" keeps Sheets from turning 001041 into 1041. */
function formatRange_(first, last) {
  return '#' + first + (last !== first ? '–' + last : '');
}

/** Reads '#1041–1045' (or '#1041') back into [1041, 1045]. */
function parseRange_(serials) {
  var m = String(serials || '').match(/(\d+)(?:\s*[–-]\s*#?(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || m[1])] : null;
}

/** Flags an undone donation's items in the Items tab (rows are kept for the record). */
function markItemsUndone_(entryId) {
  var sheet = getSheet_(ITEMS_SHEET, ITEMS_HEADER);
  readRows_(ITEMS_SHEET, ITEMS_HEADER).forEach(function (r, i) {
    if (String(r[I.ENTRY]) === entryId) sheet.getRange(i + 2, I.STATUS + 1).setValue('Undone');
  });
}

function entriesFor_(data, code) {
  return data.entries.filter(function (e) { return e.code === code; }).reverse();
}

function publicWallet_(member, data) {
  return {
    code: member.code,
    name: member.name,
    balance: data.balances[member.code] || 0,
    paper: data.paperByCode[member.code] || 0,
    history: entriesFor_(data, member.code).map(function (e) {
      return {
        ts: e.ts, change: e.change, type: e.type, note: e.note, items: e.items, undone: e.undone,
        paper: e.paper, serials: e.serials
      };
    })
  };
}

function staffEntry_(e) {
  return {
    id: e.id, ts: e.ts, code: e.code, name: e.name, change: e.change,
    type: e.type, note: e.note, staff: e.staff, undone: e.undone, items: e.items,
    paper: e.paper, serials: e.serials
  };
}

function requireMember_(data, code) {
  var member = data.byCode[normalizeCode_(code)];
  if (!member) throw new Error('No one with code "' + code + '".');
  return member;
}

/** Phone numbers compare by their last 10 digits, emails case-insensitively. */
function findByPhone_(data, phone) {
  var key = String(phone).replace(/\D/g, '').slice(-10);
  for (var i = 0; i < data.members.length; i++) {
    var p = data.members[i].phone.replace(/\D/g, '');
    if (p && p.slice(-10) === key) return data.members[i];
  }
  return null;
}

function findByEmail_(data, email) {
  for (var i = 0; i < data.members.length; i++) {
    if (data.members[i].email.toLowerCase() === email) return data.members[i];
  }
  return null;
}

/** Required. US numbers are stored as (209) 555-0101; others as +<digits>. */
function parsePhone_(phone) {
  var raw = cleanText_(phone, 40);
  var digits = raw.replace(/\D/g, '');
  var intl = raw.charAt(0) === '+' && raw.indexOf('+1') !== 0;
  if (!intl && digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  if (!intl && digits.length === 10) {
    return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  }
  if (intl && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  throw new Error(raw ? 'That phone number doesn\'t look right. Use 10 digits, like 209-555-0101.'
                      : 'Please enter a phone number (we text a reminder before the shop).');
}

/** Optional. */
function parseEmail_(email) {
  var e = cleanText_(email, 80).toLowerCase();
  if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('That email doesn\'t look right.');
  return e;
}

function writeContact_(member, phone, email) {
  var sheet = getSheet_(MEMBERS_SHEET, MEMBERS_HEADER);
  sheet.getRange(member.row, M.PHONE + 1).setValue(sheetSafe_(phone));
  sheet.getRange(member.row, M.EMAIL + 1).setValue(sheetSafe_(email));
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
