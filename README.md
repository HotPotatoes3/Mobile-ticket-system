# Swap Shop Digital Tickets

A phone-only ticket system for the **UCM YDSA Swap Shop**. It replaces paper tickets:
1 donated item = 1 ticket, and tickets are spent on goods at the shop.

- **Volunteers** use one shared link on their own phones to give and spend tickets.
- **Donors** get a personal ticket page with a QR code and a short code (like `HN7MK`)
  that they can bookmark or screenshot.
- **Everything is stored in a Google Sheet**, so you get a live, readable record of every ticket
  given and spent. It's free and needs no server or app install.

## How it works at the table

**Donation drop-off (Oct 5–22, during tabling or by appointment)**
1. Volunteer opens the app → **New donor** → types a name (and phone/email if they'll give it)
   → sets the number of items → **Register + give N tickets**.
2. A QR code appears. The donor scans it with their phone camera and bookmarks or screenshots
   the page. Or they can just write down the 5-letter code.
3. Someone who comes back with more donations: **Find** them by name, phone, or code
   → **+ Give**. If you register someone again with the same phone or email, the app spots that
   and adds the tickets to their existing account.

**Shop day (Oct 23, 6–8pm, Pavilion Lawn)**
1. The shopper shows their ticket page. A volunteer either scans the QR with their phone camera
   (this opens that person's account with the staff buttons) or searches by name or code.
2. Set the number of items → **− Spend**. The app won't let anyone spend more tickets than they have.

**Mistakes:** every entry has an **Undo** button (tap it twice). The original row stays in the
Sheet and a reversing row is added, so nothing is ever silently deleted.

**Lost code?** Volunteers can search by name or phone and show the QR again.

**Stats tab:** number of people, tickets given, spent, and still unspent, plus recent activity.

## One-time setup (about 10 minutes)

1. **Create the Sheet.** Make a new Google Sheet in the org's Google account
   (e.g. "Swap Shop Tickets").
2. **Add the code.** In the Sheet: **Extensions → Apps Script**.
   - Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
   - Click **+ → HTML**, name it `Index` (exactly), and paste in
     [`apps-script/Index.html`](apps-script/Index.html).
   - Optional: change `EVENT_NAME` at the top of `Code.gs`.
3. **Set the staff PIN.** Click ⚙️ **Project Settings → Script properties → Add script property**:
   name `STAFF_PIN`, value: a passphrase you'll share only with volunteers (use something longer than
   4 digits, e.g. `swap-shop-oct23`).
4. **Create the tabs.** Back in the editor, pick `setup` in the function dropdown and click **Run**.
   Approve the permission prompt (it asks to edit this spreadsheet). `Members`, `Ledger`, and
   `Balances` tabs appear in the Sheet.
5. **Publish it.** **Deploy → New deployment → ⚙️ Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone** (so donors don't need a Google account to view their tickets)

   Copy the **Web app URL**. That's the link for everyone.
6. **Share it.** Send the link plus the PIN to volunteers. Each volunteer opens it, taps
   **Volunteer login**, and enters their name and the PIN once. Their phone remembers it.
   Tip: "Add to Home Screen" makes it feel like an app.
   You can also print the link as a QR code on the poster ("Check your tickets").

> **Changed the code later?** Use **Deploy → Manage deployments → ✏️ Edit → Version: New version**
> so the link stays the same. Creating a *new* deployment gives you a different URL.

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

`dev/server.js` runs `Code.gs` in Node against an in-memory fake spreadsheet so you can try the
UI without Google:

```bash
npm run dev     # http://localhost:8080, staff PIN 1234
npm test        # end-to-end test on a phone-sized browser (needs Playwright installed)
```

Files:

| File | What it is |
| --- | --- |
| `apps-script/Code.gs` | Server: ticket rules, PIN check, Sheet storage |
| `apps-script/Index.html` | The phone UI (donor ticket page + volunteer tools) |
| `apps-script/appsscript.json` | Apps Script manifest (for use with `clasp`) |
| `dev/` | Local preview server and end-to-end test |
