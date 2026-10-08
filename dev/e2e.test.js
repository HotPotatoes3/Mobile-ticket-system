// End-to-end check of the full donation -> shop flow on a phone-sized screen.
//   node dev/e2e.test.js   (uses the globally installed playwright)
const assert = require('assert');
const { chromium } = require('playwright');
const { start, PORT } = require('./server');

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
    await staff.fill('#newContact', '(209) 555-0101');
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
    await staff.fill('#newContact', '209-555-0101');
    await staff.getByRole('button', { name: '+ Dress' }).click();
    await staff.getByRole('button', { name: 'Register + give 1 ticket' }).click();
    await staff.locator('#toast', { hasText: 'Already registered' }).waitFor();
    assert.strictEqual(await balance(staff), 4);
    assert.strictEqual((await staff.locator('.codebig').innerText()).trim(), code);

    // Spreadsheet-formula names are stored as plain text.
    await staff.getByRole('button', { name: '← Back to search' }).click();
    await staff.getByRole('button', { name: 'New donor' }).click();
    await staff.fill('#newName', '=1+1');
    await staff.locator('.item-name').first().fill('Hat');
    await staff.getByRole('button', { name: 'Register + give 1 ticket' }).click();
    await staff.getByText('Give them their ticket').waitFor();
    assert.strictEqual(await staff.locator('.who').innerText(), '=1+1');

    // Search by phone digits.
    await staff.getByRole('button', { name: '← Back to search' }).click();
    await staff.fill('#search', '5550101');
    await staff.waitForFunction(() => document.querySelectorAll('.list li').length === 1);
    assert.match(await staff.locator('.list li').innerText(), /Ana R/);

    // Stats.
    await staff.getByRole('button', { name: 'Stats' }).click();
    await staff.getByText('Recent activity').waitFor();
    const stats = await staff.locator('.stat b').allInnerTexts();
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

    assert.strictEqual((await rpc(holder, 'getConfig')).result.apiVersion, 2);

    console.log('All e2e checks passed. Ticket code used:', code);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
