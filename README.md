# Swap Shop Digital Tickets

A phone-only ticket system for the **UCM YDSA Swap Shop**. It replaces paper tickets:
1 donated item = 1 ticket, and tickets are spent on goods at the shop.

- **Volunteers** use one shared link on their own phones to give and spend tickets.
- **Donors** get a personal ticket page with a QR code and a short code (like `HN7MK`)
  that they can bookmark or screenshot.
- **Everything is stored in a Google Sheet**, so you get a live, readable record of every ticket
  given and spent. It's free and needs no server or app install.

**The link for everyone:** https://hotpotatoes3.github.io/Mobile-ticket-system/

How it fits together: the page is hosted on GitHub Pages (`docs/`). It saves and reads tickets
through a small Google Apps Script (`apps-script/Code.gs`) attached to the Sheet. The page never
uses anyone's Google sign-in, so it works no matter how many Google accounts a phone is logged into.

## How it works at the table

**Donation drop-off (Oct 5–22, during tabling or by appointment)**
1. Volunteer opens the app → **New donor** → types a name and **phone number** (required, so
   we can text a reminder before the shop; email is optional) → sets how many items they dropped off → **Register + give N tickets**.
   - **Quick count** (the default) is just a number. Nothing to describe.
   - **List items** records each item instead: a name (tap a quick button like **+ Jacket**, or
     type one) and an optional description ("blue denim, size M"). The ticket count is the
     number of items listed, and they show up in the **Items** tab.

   Each phone remembers which of the two you used last.
2. A QR code appears. The donor scans it with their phone camera and bookmarks or screenshots
   the page. Or they can just write down the 5-letter code. At the bottom of their ticket page,
   **Save ticket to Photos** saves a picture with their name, QR code and code, and there's a tip
   for adding the page to their Home Screen. (Real Apple Wallet passes would need a paid Apple
   Developer account, so the app doesn't make them.)
3. Someone who comes back with more donations: **Find** them by name, phone, or code
   → **Donation** → count or list the items → **+ Give**. If you register someone again with the same phone or email, the app spots that
   and adds the tickets to their existing account.
4. Someone registered before phone numbers were required gets a red **No phone number on file**
   note on their page. Tap **Add one**. The **Edit** link next to their code fixes a typo the same way.

**Shop day (Oct 23, 6–8pm, Pavilion Lawn)**
1. The shopper shows their ticket page. A volunteer either scans the QR with their phone camera
   (this opens that person's account with the staff buttons) or searches by name or code.
2. Tap **Shop** (the app remembers this for the next person) → set the number of items
   → **− Spend**. The app won't let anyone spend more tickets than they have.

**Mistakes:** every entry has an **Undo** button (tap it twice). The original row stays in the
Sheet and a reversing row is added, so nothing is ever silently deleted.

**Lost code?** Volunteers can search by name or phone and show the QR again.

**The spreadsheet tabs:**
- **Items**: one row per item logged with **List items**: when, who donated it, item name,
  description, and the volunteer who logged it. Quick-count donations only appear in the Ledger. Sort or filter it like any sheet (e.g. to count jackets). If a donation
  is undone, its items stay but the **Status** column says `Undone`.
- **Ledger**: every ticket change (donations, spends, undos). Balances are calculated from this.
- **Members**: everyone registered, with their code, phone, and email. For reminder texts, copy
  the **Phone** column. (Sheets from before phone was required get the **Email** column added
  automatically, and old emails in the Phone column are still recognized.)
- **Balances**: live total of tickets per person.

The Items tab is created automatically the first time items are logged. You don't need to re-run
`setup`.

**Stats tab:** number of people, tickets given, spent, and still unspent, plus recent activity.

## One-time setup

### 1. The Google Sheet and script (about 10 minutes, needs a computer)

1. **Create the Sheet.** Make a new Google Sheet in the org's Google account
   (e.g. "Swap Shop Tickets").
2. **Add the code.** In the Sheet: **Extensions → Apps Script**. Replace the contents of `Code.gs`
   with [`apps-script/Code.gs`](apps-script/Code.gs) (use GitHub's **Copy raw file** button so
   nothing gets cut off; the last function is `sheetSafe_`). If you had an `Index` HTML file there
   from an earlier version, delete it. It isn't used anymore.
3. **Set the staff PIN.** Click ⚙️ **Project Settings → Script properties → Add script property**:
   name `STAFF_PIN`, value: a passphrase you'll share only with volunteers (use something longer than
   4 digits, e.g. `swap-shop-oct23`).
4. **Create the tabs.** Back in the editor, pick `setup` in the function dropdown and click **Run**.
   Approve the permission prompt (it asks to edit this spreadsheet). `Members`, `Ledger`,
   `Items`, and `Balances` tabs appear in the Sheet.
5. **Publish it.** **Deploy → New deployment → ⚙️ Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone** (required, or the ticket page can't reach it)

   Copy the **Web app URL** (ends in `/exec`).

> **Changed `Code.gs` later?** Use **Deploy → Manage deployments → ✏️ Edit → Version: New version**
> so the URL stays the same. Creating a *new* deployment gives you a different URL, which you'd
> then have to put in `docs/config.js`.

### 2. The ticket page (about 2 minutes)

1. Put the Web app URL in [`docs/config.js`](docs/config.js) as `apiUrl`. It's already set to the
   current deployment, so you only need to change it if you make a new deployment.
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick the
   repository's default branch and the **`/docs`** folder, then **Save**. After about a minute the
   page is live at https://hotpotatoes3.github.io/Mobile-ticket-system/.

### 3. Share it

Send the link plus the PIN to volunteers. Each volunteer opens it, taps **Volunteer login**, and
enters their name and the PIN once. Their phone remembers it. Tip: "Add to Home Screen" makes it
feel like an app. You can also print the link as a QR code on the poster ("Check your tickets").

Old QR codes that point at the `script.google.com` link still work. That link now just sends
people on to the ticket page.

## Good to know

- **Who can see what:** anyone with a ticket link sees only that person's name, balance, and history.
  Phone numbers and emails are visible only to logged-in volunteers (and in the Sheet).
  The staff PIN is checked on the server for every staff action.
- **The Sheet is the source of truth.** A person's balance is the sum of their rows in `Ledger`.
  Don't edit or delete Ledger rows by hand during the event. Use the app's Undo instead.
  Organizers can still view, sort, filter, or download the Sheet any time.
- **Backup for bad Wi-Fi on shop day:** shortly before the shop opens, print the **Balances**
  tab (everyone's name, code, and current tickets). If the app goes down, cross names off on paper
  and enter them later.
- **Change the PIN** by editing the `STAFF_PIN` script property. Everyone has to log in again.
- **Several volunteers at once** is fine: writes are locked so two phones can't spend the same tickets.
- Limits: up to 50 tickets per entry (catches typos). Change `MAX_TICKETS_PER_ENTRY` in `Code.gs`.

## For developers

`dev/server.js` serves `docs/index.html` and runs `Code.gs` in Node against an in-memory fake
spreadsheet, so you can try everything without Google:

```bash
npm run dev     # http://localhost:8080, staff PIN 1234
npm test        # end-to-end test on a phone-sized browser (needs Playwright installed)
```

Files:

| File | What it is |
| --- | --- |
| `apps-script/Code.gs` | Backend: ticket rules, PIN check, Sheet storage, JSON API (`doPost`) |
| `docs/index.html` | The phone UI (donor ticket page + volunteer tools), served by GitHub Pages |
| `docs/config.js` | Event name, the date/place printed on saved tickets, and the Apps Script URL the page talks to |
| `apps-script/appsscript.json` | Apps Script manifest (for use with `clasp`) |
| `dev/` | Local preview server and end-to-end test |
