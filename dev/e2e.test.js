// End-to-end check of the full donation -> shop flow on a phone-sized screen.
//   node dev/e2e.test.js   (uses the globally installed playwright)
const assert = require('assert');
const { chromium } = require('playwright');
const { start, PORT, createBackend } = require('./server');

const BASE = `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOTS_DIR;
// Optional local copy of qrcode.min.js for machines that can't reach cdnjs.
const QR_LIB = process.env.QR_LIB;

async function main() {
  const server = await start();
  const browser = await chromium.launch();
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const newPage = async () => {
    const ctx = await browser.newContext(phone);
    if (QR_LIB) await ctx.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: QR_LIB, contentType: 'text/javascript' }));
    return ctx.newPage();
  };
  const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const rpc = (page, fn, ...args) => page.evaluate(([fn, args]) =>
    fetch('/api', { method: 'POST', body: JSON.stringify({ fn, args }) }).then((r) => r.json()), [fn, args]);
  const balance = (page) => page.locator('#balance').innerText().then(Number);
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  try {
    const staff = await newPage();
    await staff.goto(BASE);
    await staff.getByText('Check your tickets').waitFor();
    assert(await noHScroll(staff), 'home page scrolls sideways');
    await shot(staff, '1-home');

    // Login: wrong PIN rejected, right PIN accepted.
    await staff.getByRole('button', { name: 'Volunteer login' }).click();
    await staff.fill('#staffName', 'Maya');
    await staff.fill('#staffPin', '0000');
    await staff.getByRole('button', { name: 'Log in' }).click();
    await staff.locator('#toast', { hasText: 'Wrong staff PIN' }).waitFor();
    await staff.fill('#staffPin', '1234');
    await staff.getByRole('button', { name: 'Log in' }).click();
    await staff.getByRole('button', { name: 'New donor' }).waitFor();

    // Register a donor who dropped off 3 items, each with a name and optional description.
    await staff.getByRole('button', { name: 'New donor' }).click();
    await staff.fill('#newName', 'Ana R');
    // A phone number is required (for reminder texts).
    await staff.locator('#registerBtn').click();
    await staff.locator('#toast', { hasText: 'Please enter a phone number' }).waitFor();
    await staff.fill('#newPhone', '555-12');
    await staff.locator('#registerBtn').click();
    await staff.locator('#toast', { hasText: "doesn't look right" }).waitFor();
    await staff.fill('#newPhone', '(209) 555-0101');
    assert(await staff.locator('#styleQuick.on').count(), 'Quick count should be the default');
    assert.strictEqual(await staff.locator('#registerBtn').innerText(), 'Register + give 1 ticket');
    await staff.locator('#styleList').click();                               // phone remembers this
    assert.strictEqual(await staff.locator('#registerBtn').innerText(), 'Register (no tickets yet)');
    await staff.getByRole('button', { name: '+ Jacket' }).click();          // fills the empty first row
    await staff.locator('.item-desc').nth(0).fill('Blue denim, size M');
    await staff.getByRole('button', { name: '+ Shirt' }).click();           // adds a second row
    await staff.getByRole('button', { name: '+ Add another item' }).click();
    await staff.locator('.item-name').nth(2).fill('Scarf');
    await staff.getByRole('button', { name: '+ Add another item' }).click();
    await staff.locator('.item-desc').nth(3).fill('description but no name');
    await staff.getByRole('button', { name: 'Register + give 3 tickets' }).click();
    await staff.locator('#toast', { hasText: 'Every item needs a name' }).waitFor();
    await staff.getByRole('button', { name: 'Remove item' }).nth(3).click();
    await staff.getByRole('button', { name: 'Register + give 3 tickets' }).click();
    await staff.getByText('Give them their ticket').waitFor();
    assert.strictEqual(await balance(staff), 3);
    assert(await staff.locator('.qr canvas, .qr img').count() > 0, 'QR code not drawn');
    const code = (await staff.locator('.codebig').innerText()).trim();
    assert.match(code, /^[A-Z2-9]{5}$/);
    // qrcodejs puts the encoded text in the title attribute.
    assert.strictEqual(await staff.locator('.qr').getAttribute('title'), BASE + '?m=' + code);
    assert(await noHScroll(staff), 'member page scrolls sideways');
    assert(!(await staff.locator('#app').innerText()).startsWith('null'), 'stray null rendered');
    const history = await staff.locator('.list').last().innerText();
    assert.match(history, /Donated 3 items/);
    assert.match(history, /Jacket — Blue denim, size M/);
    assert.match(history, /Shirt/);
    assert.match(history, /Scarf/);
    await shot(staff, '2-registered');

    // Later drop-off of 2 items on the Donation panel.
    assert(await staff.locator('#addBtn').isDisabled(), 'can give tickets with no items listed');
    await staff.getByRole('button', { name: '+ Shoes' }).click();
    await staff.getByRole('button', { name: '+ Bag' }).click();
    await staff.locator('.item-desc').nth(1).fill('=SUM(A1)');
    await shot(staff, '2b-donation-form');
    await staff.getByRole('button', { name: '+ Give 2 tickets' }).click();
    await staff.locator('#flash', { hasText: 'New balance: 5' }).waitFor();

    // Shop: can't overspend, can spend 4.
    await staff.locator('#modeShop').click();
    for (let i = 0; i < 5; i++) await staff.getByRole('button', { name: 'More' }).click();
    assert(await staff.locator('#redeemBtn').isDisabled(), 'overspend allowed');
    await staff.getByRole('button', { name: 'Fewer' }).click();
    await staff.getByRole('button', { name: 'Fewer' }).click();
    await staff.locator('#redeemBtn').click();
    await staff.locator('#flash', { hasText: 'New balance: 1' }).waitFor();
    assert(await staff.locator('#modeShop.on').count(), 'Shop mode not remembered');
    await shot(staff, '3-after-shop');

    // Undo the purchase (two taps).
    const undoTop = async () => {
      await staff.locator('ul.list > li').first().getByRole('button', { name: 'Undo' }).click();
      await staff.getByRole('button', { name: 'Tap to confirm' }).click();
    };
    await undoTop();
    await staff.locator('#flash', { hasText: 'New balance: 5' }).waitFor();
    assert.strictEqual(await staff.locator('ul.list > li.struck').count(), 1);

    // Undo the 2-item donation: its items are flagged in the Items tab, not deleted.
    await staff.locator('ul.list > li', { hasText: 'Donated 2 items' }).getByRole('button', { name: 'Undo' }).click();
    await staff.getByRole('button', { name: 'Tap to confirm' }).click();
    await staff.locator('#flash', { hasText: 'New balance: 3' }).waitFor();
    const sheets = await staff.evaluate(() => fetch('/__sheets').then((r) => r.json()));
    const [itemsHeader, ...itemRows] = sheets.Items;
    assert.deepStrictEqual(itemsHeader, ['Timestamp', 'Code', 'Donor', 'Item', 'Description', 'Entry ID', 'Staff', 'Status']);
    assert.deepStrictEqual(itemRows.map((r) => [r[1], r[2], r[3], r[4], r[6], r[7]]), [
      [code, 'Ana R', 'Jacket', 'Blue denim, size M', 'Maya', ''],
      [code, 'Ana R', 'Shirt', '', 'Maya', ''],
      [code, 'Ana R', 'Scarf', '', 'Maya', ''],
      [code, 'Ana R', 'Shoes', '', 'Maya', 'Undone'],
      [code, 'Ana R', 'Bag', '=SUM(A1)', 'Maya', 'Undone'],
    ]);
    const ledgerIds = sheets.Ledger.slice(1).filter((r) => r[4] === 'DONATION').map((r) => r[7]);
    assert(itemRows.every((r) => ledgerIds.includes(r[5])), 'item rows must link to a Ledger donation');
    assert.match(sheets.Ledger[1][5], /^Donated: Jacket, Shirt, Scarf$/);

    // Same phone number again -> credits the existing person, no duplicate.
    await staff.getByRole('button', { name: '← Back to search' }).click();
    await staff.getByRole('button', { name: 'New donor' }).click();
    await staff.fill('#newName', 'Ana Rivera');
    await staff.fill('#newPhone', '1 209 555 0101');
    await staff.fill('#newEmail', 'Ana@Example.com');
    await staff.getByRole('button', { name: '+ Dress' }).click();
    await staff.getByRole('button', { name: 'Register + give 1 ticket' }).click();
    await staff.locator('#toast', { hasText: 'Already registered' }).waitFor();
    assert.strictEqual(await balance(staff), 4);
    assert.strictEqual((await staff.locator('.codebig').innerText()).trim(), code);
    assert.match(await staff.locator('.card').first().innerText(), /\(209\) 555-0101 · ana@example\.com/);

    // Spreadsheet-formula names are stored as plain text.
    await staff.getByRole('button', { name: '← Back to search' }).click();
    await staff.getByRole('button', { name: 'New donor' }).click();
    await staff.fill('#newName', '=1+1');
    await staff.fill('#newPhone', '+44 20 7946 0958');
    await staff.locator('.item-name').first().fill('Hat');
    await staff.getByRole('button', { name: 'Register + give 1 ticket' }).click();
    await staff.getByText('Give them their ticket').waitFor();
    assert.strictEqual(await staff.locator('.who').innerText(), '=1+1');
    assert.strictEqual(await staff.locator('#noPhone').count(), 0);

    // Edit contact info: a phone that belongs to someone else is refused.
    await staff.locator('#editContactBtn').click();
    await staff.fill('#editPhone', '209.555.0101');
    await staff.locator('#saveContactBtn').click();
    await staff.locator('#toast', { hasText: 'already belongs to Ana R' }).waitFor();
    await staff.fill('#editPhone', '209-555-0199');
    await staff.locator('#saveContactBtn').click();
    await staff.locator('#flash', { hasText: 'Contact info saved' }).waitFor();
    assert.match(await staff.locator('.card').first().innerText(), /\(209\) 555-0199/);
    const members = (await staff.evaluate(() => fetch('/__sheets').then((r) => r.json()))).Members;
    assert.deepStrictEqual(members[0], ['Code', 'Name', 'Phone', 'Created', 'Created by', 'Email']);
    assert.deepStrictEqual(members.slice(1).map((r) => [r[1], r[2], r[5]]), [
      ['Ana R', '(209) 555-0101', 'ana@example.com'],
      ['=1+1', '(209) 555-0199', ''],
    ]);

    // Search by phone digits.
    await staff.getByRole('button', { name: '← Back to search' }).click();
    await staff.fill('#search', '5550101');
    await staff.waitForFunction(() => document.querySelectorAll('.list li').length === 1);
    assert.match(await staff.locator('.list li').innerText(), /Ana R/);

    // Stats.
    await staff.getByRole('button', { name: 'Stats' }).click();
    await staff.getByText('Recent activity').waitFor();
    const stats = await staff.locator('.stats:not(.three) .stat b').allInnerTexts();
    assert.deepStrictEqual(stats, ['2', '5', '5', '0'], 'stats: people, unspent, given, spent');
    await shot(staff, '4-stats');

    // Ticket holder's own phone: read-only wallet, no staff controls.
    const holder = await newPage();
    await holder.goto(BASE + '?m=' + code.toLowerCase());
    await holder.getByText('Show this screen at the Swap Shop').waitFor();
    assert.strictEqual(await balance(holder), 4);
    assert.match(await holder.locator('.list').innerText(), /Jacket — Blue denim, size M/);
    assert.strictEqual(await holder.locator('#addBtn, #redeemBtn, button:has-text("Undo")').count(), 0);
    assert(await noHScroll(holder), 'wallet scrolls sideways');
    await shot(holder, '5-wallet');

    // "Keep your ticket handy": save a ticket picture (a download where sharing isn't available).
    assert.match(await holder.locator('#keepHandy').innerText(), /Add to Home screen/);
    const [download] = await Promise.all([holder.waitForEvent('download'), holder.locator('#saveTicketBtn').click()]);
    assert.strictEqual(download.suggestedFilename(), `swap-shop-ticket-${code}.png`);
    const png = require('fs').readFileSync(await download.path());
    assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1080, 1500], 'ticket picture size');
    const icon = await holder.evaluate(() => fetch('apple-touch-icon.png').then((r) => [r.status, r.headers.get('content-type')]));
    assert.deepStrictEqual(icon, [200, 'image/png']);

    // On an iPhone the button opens the share sheet (where "Save Image" puts it in Photos).
    const iphoneCtx = await browser.newContext({ ...phone,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    if (QR_LIB) await iphoneCtx.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: QR_LIB, contentType: 'text/javascript' }));
    await iphoneCtx.addInitScript(() => {
      navigator.canShare = (d) => !!(d && d.files);
      navigator.share = async (d) => { window.shared = d.files.map((f) => [f.name, f.type, f.size > 1000]); };
    });
    const iphone = await iphoneCtx.newPage();
    await iphone.goto(BASE + '?m=' + code);
    await iphone.locator('#saveTicketBtn', { hasText: 'Save ticket to Photos' }).waitFor();
    assert.match(await iphone.locator('#keepHandy').innerText(), /tap the Share button .* in Safari, then Add to Home Screen/);
    await iphone.waitForTimeout(300);                                         // picture is made in the background
    await iphone.locator('#saveTicketBtn').click();
    await iphone.waitForFunction(() => window.shared);
    assert.deepStrictEqual(await iphone.evaluate(() => window.shared), [[`swap-shop-ticket-${code}.png`, 'image/png', true]]);
    assert(await noHScroll(iphone), 'iPhone wallet scrolls sideways');
    await shot(iphone, '5b-wallet-iphone');
    await iphoneCtx.close();

    // Bad code shows a friendly error.
    await holder.goto(BASE + '?m=ZZZZZ');
    await holder.getByText('No tickets found').waitFor();

    // Server guards hold even if the UI is bypassed.
    const err = async (fn, ...args) => (await rpc(holder, fn, ...args)).error;
    assert.match(await err('addTickets', '9999', 'x', code, 1, ''), /Wrong staff PIN/);
    assert.match(await err('redeemTickets', '1234', 'x', code, 7, ''), /only has 4/);
    assert.match(await err('addTickets', '1234', 'x', code, 0, ''), /whole number/);
    assert.match(await err('addTickets', '1234', 'x', code, 51, ''), /whole number/);
    assert.match(await err('addTickets', '1234', 'x', code, 1.5, ''), /whole number/);
    assert.match(await err('addTickets', '1234', 'x', code, [], ''), /at least one item/);
    assert.match(await err('addTickets', '1234', 'x', code, [{ name: '', description: 'x' }], ''), /needs a name/);
    const tooMany = Array.from({ length: 51 }, () => ({ name: 'Sock' }));
    assert.match(await err('addTickets', '1234', 'x', code, tooMany, ''), /whole number from 1 to 50/);
    const hist = (await rpc(holder, 'getMemberForStaff', '1234', code)).result.history;
    const undoneId = hist.find((e) => e.undone).id;
    assert.match(await err('undoEntry', '1234', 'x', undoneId), /already undone/);
    const undoRow = hist.find((e) => e.type === 'UNDO').id;
    assert.match(await err('undoEntry', '1234', 'x', undoRow), /can't be undone/);
    assert.match(await err('searchMembers_', '1234'), /Unknown request/);
    assert.match(await err('constructor'), /Unknown request/);
    assert.match(await err('createMember', '1234', 'x', 'No Phone', '', 1, ''), /enter a phone number/);
    assert.match(await err('createMember', '1234', 'x', 'Bad', '12345', 1, ''), /doesn't look right/);
    assert.match(await err('createMember', '1234', 'x', 'Bad', '2095550111', 1, '', 'not-an-email'), /email doesn't look right/);
    assert.match(await err('updateContact', '1234', 'x', code, '', ''), /enter a phone number/);

    assert.strictEqual((await rpc(holder, 'getConfig')).result.apiVersion, 4);

    // Quick count: just a number of tickets, no item details. The phone remembers the choice.
    await staff.goto(BASE + '?m=' + code);
    await staff.locator('#modeGive').click();
    assert(await staff.locator('#styleList.on').count(), 'List items choice not remembered');
    await staff.locator('#styleQuick').click();
    await staff.getByRole('button', { name: 'More' }).click();
    await staff.getByRole('button', { name: 'More' }).click();
    await shot(staff, '2c-quick-count');
    await staff.getByRole('button', { name: '+ Give 3 tickets' }).click();
    await staff.locator('#flash', { hasText: 'Gave 3 tickets. New balance: 7' }).waitFor();
    await staff.reload();
    await staff.locator('#modeGive').click();
    assert(await staff.locator('#styleQuick.on').count(), 'Quick count choice not remembered');
    await staff.getByRole('button', { name: '← Back to search' }).click();
    await staff.getByRole('button', { name: 'New donor' }).click();
    await staff.fill('#newName', 'Bo T');
    await staff.fill('#newPhone', '+44 20 7946 0958');
    await staff.getByRole('button', { name: 'Fewer' }).click();
    await staff.getByRole('button', { name: 'Register (no tickets yet)' }).click();
    await staff.getByText('Give them their ticket').waitFor();
    assert.strictEqual(await balance(staff), 0);
    const after = await staff.evaluate(() => fetch('/__sheets').then((r) => r.json()));
    assert.strictEqual(after.Items.length - 1, 7, 'quick count must not add Items rows');
    assert.match(after.Ledger[after.Ledger.length - 1][5], /^Donated 3 item\(s\)$/);

    // Paper tickets: handed out against a donor (never touching their phone balance), with ticket numbers.
    const boCode = new URL(staff.url()).searchParams.get('m');
    await staff.locator('#modeGive').click();
    assert(await staff.locator('#givePhone.on').count(), 'phone tickets should be the default');
    await staff.locator('#givePaper').click();
    await staff.getByRole('button', { name: 'More' }).first().click();
    await staff.getByRole('button', { name: 'More' }).first().click();
    await staff.fill('#paperFirst', '001041');
    await shot(staff, '2d-give-paper');
    await staff.getByRole('button', { name: '+ Give 3 paper tickets' }).click();
    await staff.locator('#flash', { hasText: 'Hand them 3 paper tickets (#001041–001043).' }).waitFor();
    assert.strictEqual(await balance(staff), 0, 'paper must not change the phone balance');
    assert.strictEqual(await staff.locator('#paperLine').innerText(), '+ 3 paper tickets handed out');
    assert.match(await staff.locator('.list li').first().innerText(), /\+3 paper/);
    assert.match(await staff.locator('.list li').first().innerText(), /#001041–001043/);
    assert(await staff.locator('#givePhone.on').count(), 'paper choice must not stick');
    // Overlapping ticket numbers are refused (catches typos and double handouts).
    await staff.locator('#givePaper').click();
    await staff.fill('#paperFirst', '1043');
    await staff.locator('#addBtn').click();
    await staff.locator('#toast', { hasText: 'overlaps #001041–001043, already given to Bo T' }).waitFor();
    await staff.fill('#paperFirst', '10a');
    await staff.locator('#addBtn').click();
    await staff.locator('#toast', { hasText: 'digits only' }).waitFor();

    // A new donor can be registered straight into paper tickets (no ticket number noted).
    await staff.getByRole('button', { name: '← Back to search' }).click();
    await staff.getByRole('button', { name: 'New donor' }).click();
    await staff.fill('#newName', 'Cy P');
    await staff.fill('#newPhone', '209-555-0190');
    await staff.getByRole('button', { name: 'More' }).click();
    await staff.locator('#givePaper').click();
    await staff.getByRole('button', { name: 'Register + give 2 paper tickets' }).click();
    await staff.locator('#flash', { hasText: 'Hand them 2 paper tickets.' }).waitFor();
    assert(await staff.locator('.card.center.hidden', { hasText: 'Give them their ticket' }).count(), 'no QR pop-up for paper');
    assert.strictEqual(await staff.locator('#paperLine').innerText(), '+ 2 paper tickets handed out');

    // Paper tab: collect paper at checkout, see what's still out, look up a ticket number, undo.
    await staff.getByRole('button', { name: '← Back to search' }).click();
    await staff.getByRole('button', { name: 'Paper' }).click();
    const paperNums = () => staff.locator('.stats.three .stat b').allInnerTexts();
    await staff.locator('#collectBtn').waitFor();
    assert.deepStrictEqual(await paperNums(), ['5', '0', '5']);
    for (let i = 0; i < 3; i++) await staff.getByRole('button', { name: 'More' }).click();
    await staff.getByRole('button', { name: '− Collect 4 paper tickets' }).click();
    await staff.locator('#flash', { hasText: 'Collected 4 paper tickets.' }).waitFor();
    assert.deepStrictEqual(await paperNums(), ['5', '4', '1']);
    assert.match(await staff.locator('#paperRecent li').first().innerText(), /Collected 4 paper tickets[\s\S]*−4 paper/);
    await staff.fill('#checkNum', '1042');
    await staff.locator('#checkBtn').click();
    await staff.locator('#checkResult', { hasText: 'Given to Bo T (' + boCode + ') · #001041–001043' }).waitFor();
    await staff.fill('#checkNum', '2000');
    await staff.locator('#checkBtn').click();
    await staff.locator('#checkResult', { hasText: 'Not in any recorded handout' }).waitFor();
    assert(await noHScroll(staff), 'paper tab scrolls sideways');
    await shot(staff, '7-paper-tab');
    const undoCollect = staff.locator('#paperRecent li').first().getByRole('button', { name: 'Undo' });
    await undoCollect.click();
    await staff.locator('#paperRecent li').first().getByRole('button', { name: 'Tap to confirm' }).click();
    await staff.locator('#flash', { hasText: 'Undone.' }).waitFor();
    assert.deepStrictEqual(await paperNums(), ['5', '0', '5']);
    await staff.getByRole('button', { name: 'Stats' }).click();
    await staff.getByRole('heading', { name: 'Paper tickets' }).waitFor();
    assert.deepStrictEqual(await paperNums(), ['5', '0', '5']);
    await staff.getByRole('button', { name: 'Find' }).click();
    await staff.fill('#search', 'Bo T');
    await staff.locator('.list li', { hasText: '+3 paper' }).waitFor();

    // The donor sees their paper tickets too; the sheet has them in the Ledger's Paper column.
    await holder.goto(BASE + '?m=' + boCode);
    assert.strictEqual(await holder.locator('#paperLine').innerText(), '+ 3 paper tickets given to you — bring them to the shop');
    const sheetsNow = await staff.evaluate(() => fetch('/__sheets').then((r) => r.json()));
    assert.deepStrictEqual(sheetsNow.Ledger[0].slice(-2), ['Paper', 'Ticket #s']);
    const collectRow = sheetsNow.Ledger.find((r) => r[4] === 'PAPER_IN');
    assert.deepStrictEqual([collectRow[1], collectRow[3], collectRow[9]], ['', 0, -4]);
    assert(sheetsNow.Ledger.some((r) => r[1] === boCode && r[3] === 0 && r[9] === 3 && r[10] === '#001041–001043'));
    assert.match(await err('collectPaper', '1234', 'x', 0, ''), /whole number/);
    assert.match(await err('collectPaper', '9999', 'x', 1, ''), /Wrong staff PIN/);
    assert.match(await err('addTickets', '1234', 'x', boCode, 1, '', { first: '12-3' }), /digits only/);
    assert.match(await err('checkPaperTicket', '1234', ''), /digits only/);

    // A Members tab from before phone was required: one "Contact" column that may hold an email.
    const old = createBackend();
    old.sheets.Members.rows.splice(0, Infinity,
      ['Code', 'Name', 'Contact', 'Created', 'Created by'],
      ['AAAAA', 'Old Phone', '209 555 0123', '', 'x'],
      ['BBBBB', 'Old Email', 'kw@ucmerced.edu', '', 'x'],
      ['CCCCC', 'Old None', '', '', 'x']);
    const found = old.ctx.searchMembers('1234', '');
    assert.deepStrictEqual(found.map((m) => m.contact), ['', 'kw@ucmerced.edu', '209 555 0123']);
    assert.deepStrictEqual(old.sheets.Members.rows[0], ['Code', 'Name', 'Phone', 'Created', 'Created by', 'Email']);
    assert.strictEqual(old.ctx.getMemberForStaff('1234', 'BBBBB').phone, '');
    old.ctx.createMember('1234', 'x', 'Kylie W', '2095550177', 2, '', 'KW@ucmerced.edu');
    assert.deepStrictEqual(old.sheets.Members.rows[2], ['BBBBB', 'Old Email', '(209) 555-0177', '', 'x', 'kw@ucmerced.edu']);
    assert.strictEqual(old.sheets.Members.rows.length, 4, 'matched by email, no duplicate');
    // A Ledger from before paper tickets gets the two new columns; its rows still count.
    old.sheets.Ledger.rows.splice(0, Infinity,
      ['Timestamp', 'Code', 'Name', 'Change', 'Type', 'Note', 'Staff', 'Entry ID', 'Undoes'],
      ['', 'AAAAA', 'Old Phone', 2, 'DONATION', 'Donated 2 item(s)', 'x', 'e1', '']);
    assert.strictEqual(old.ctx.getWallet('AAAAA').balance, 2);
    old.ctx.addTickets('1234', 'x', 'AAAAA', 1, '', { first: '7' });
    assert.deepStrictEqual(old.sheets.Ledger.rows[0].slice(-2), ['Paper', 'Ticket #s']);
    assert.deepStrictEqual([old.ctx.getWallet('AAAAA').balance, old.ctx.getWallet('AAAAA').paper], [2, 1]);
    assert.strictEqual(old.ctx.checkPaperTicket('1234', '#7').entry.code, 'AAAAA');

    // An out-of-date server (before paper tickets) must refuse paper rather than give phone tickets.
    const v3 = await newPage();
    await v3.route('**/api', async (route) => {
      if (JSON.parse(route.request().postData()).fn === 'getConfig') return route.fulfill({ json: { ok: true, result: { apiVersion: 3 } } });
      return route.continue();
    });
    await v3.goto(BASE);
    await v3.evaluate(() => { localStorage.setItem('swapshop.pin', '1234'); localStorage.setItem('swapshop.staff', 'Maya'); });
    await v3.goto(BASE + '?m=' + boCode);
    await v3.locator('#modeGive').click();
    await v3.locator('#givePaper').click();
    await v3.locator('#addBtn').click();
    await v3.locator('#toast', { hasText: 'out of date' }).waitFor();
    assert.strictEqual((await rpc(v3, 'getWallet', boCode)).result.paper, 3, 'nothing given');

    // The staff page flags someone with no phone yet (as older registrations may be) and lets you add one.
    await staff.route('**/api', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (body.result && body.result.code === code && body.result.history) Object.assign(body.result, { phone: '', contact: '' });
      await route.fulfill({ response: res, json: body });
    });
    await staff.goto(BASE + '?m=' + code);
    await staff.locator('#noPhone').waitFor();
    assert(await staff.locator('#contactForm.hidden').count(), 'contact form should start closed');
    await staff.locator('#noPhone').getByRole('button', { name: 'Add one' }).click();
    assert.strictEqual(await staff.locator('#editPhone').inputValue(), '');
    await shot(staff, '6-no-phone');
    await staff.unroute('**/api');
    console.log('All e2e checks passed. Ticket code used:', code);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
