# Toy Stock: how the app works

Toy Stock is a single-page web app (PWA) over a Google Sheet, installed on a phone's home screen. It is local-first: the phone keeps every item and movement, computes stock itself, and uses the sheet to share data between devices and to keep a record the owner can read and chart. This file is the reference for anyone changing the app, so the logic below does not have to be rediscovered from chat history.

This repository is meant to be served by GitHub Pages. Keep the spreadsheet ID, the connection key and real stock data out of this file and out of the code.

It follows the same pattern as the Ledger app (a public Pages repo, an Apps Script web app bound to a sheet, a `URL#key` connection code, a queue of pending writes, paste-to-import).

## Files and deployment

| File | Role |
| --- | --- |
| `index.html` | The whole app: markup, CSS and one `<script>`. Version is the `VERSION` constant at the top of the script. |
| `sw.js` | Service worker. The page is network-first (3-second budget, then the cached copy), icons and manifest are cache-first. Never caches sheet data. |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata. |
| `apps-script/Code.gs` | The back end. Paste it into the sheet's Apps Script project; it is not deployed from this repo. |
| `test/` | `mock-backend.js` runs `Code.gs` unchanged against an in-memory fake of Google's services. `backend.test.js` tests it directly; `e2e.py` (stock, import, sync) and `e2e_v2.py` (toy details, costs, orders, invoices, PDF, returns) drive the app in Chrome against it at phone size; `desktop.py` checks the desktop layout; `offline.py` checks offline launch. |

Changing this repo needs only a push to `main`; GitHub Pages republishes in about a minute. Changing `Code.gs` means pasting the new file into the Apps Script editor and publishing a new version of the existing web app deployment (Deploy > Manage deployments > edit > New version), which keeps the `/exec` URL.

### Release checklist

1. Bump `VERSION` in `index.html`.
2. Bump `CACHE` in `sw.js` to the same version (`toys-vX.Y.Z`). Browsers only install a new service worker when the bytes of `sw.js` change.
3. Never commit an empty or truncated `sw.js`: `test -s sw.js && node --check sw.js`.
4. Check the script parses: `node -e "const h=require('fs').readFileSync('index.html','utf8');new Function(h.slice(h.indexOf('<script>')+8,h.lastIndexOf('</script>')))"`.
5. Run `node test/backend.test.js`, then start `python3 -m http.server 8765` and `node test/mock-backend.js 8766` and run `python3 test/e2e.py`, `python3 test/e2e_v2.py`, `python3 test/desktop.py` and `python3 test/offline.py`.
6. Commit and push to `main`.

## The sheet

`setup()` in `Code.gs` creates nine tabs and formats the text columns as plain text, so a SKU such as `0012`, a phone number such as `+63917...` or a note starting with `=` is stored as typed. It is safe to run again; after pasting a new `Code.gs`, run it once more so new tabs and columns exist.

**Items** (one row per toy): `SKU`, `Name`, `Category`, `Price`, `Reorder at`, `Active` (`Yes` or `No`), `On hand`, `Manufacturer`, `Brand`, `Toy line`, `Character`, `Release date`, `Release check`. `On hand` is a single `ARRAYFORMULA` in `G2` that sums `Movements` per SKU; the script writes the columns on either side of G and never G itself. `Release date` is a best guess stored as text (`2024`, `2024-07` or `2024-07-15`); `Release check` holds `Verify` while that guess still needs checking. A variant (chase, exclusive colour, reissue) is its own row with its own name and SKU. Archiving sets `Active` to `No`; rows are never deleted.

**Movements** (append-only log): `ID`, `Date` (`YYYY-MM-DD`, text), `SKU`, `Item` (the name at the time, for readability), `Direction` (`In` or `Out`), `Qty` (positive whole number), `Reason`, `Ref`, `Note`, `Unit cost`. Stock for a SKU is the sum of `In` minus the sum of `Out`. Movements are never edited or deleted; a mistake is fixed by a reversing entry.

Reasons and the direction each allows (enforced by the app and by `Code.gs`):

| Reason | Direction | Used for |
| --- | --- | --- |
| Opening, Restock, Return | In only | First stock, deliveries, customer returns |
| Sale, Damaged, Lost | Out only | Sales, write-offs |
| Count, Correction, Other | Either | Photo counts and stock-takes, reversals, anything else |

`Ref` links a movement to what caused it: the movement a `Correction` reverses, the invoice number of a `Sale`, the supplier order ID of the `Restock` that received it, or the return ID of a `Return`. `Unit cost` is the cost each on a receipt, and on a `Sale` it is the average cost on hand at the moment the invoice was issued.

**Customers**: `ID`, `Name`, `Contact` (phone or Messenger). Pre-orders and invoices point here by ID and also keep the name and contact as they were at the time.

**Supplier orders** (stock ordered and paid for, not yet received): `ID`, `Date`, `SKU`, `Item`, `Qty`, `Expected`, `Status` (`Ordered`, `Received`, `Cancelled`), `Received qty`, `Received on`, `Note`.

**Pre-orders** (customer has paid, toy not yet in stock): `ID`, `Date`, `Customer ID`, `Customer`, `Contact`, `SKU`, `Item`, `Qty`, `Price`, `Paid`, `Balance`, `Status` (`Open`, `Fulfilled`, `Cancelled`), `Kept`, `Receipt no`, `Invoice no`, `Note`. `Balance` is zero when paid in full. On a cancelled pre-order `Kept` holds the deposit the shop kept, and 0 means a full refund.

**Invoices**: `No`, `ID`, `Date`, `Type` (`Sale` or `Pre-order receipt`), `Customer ID`, `Customer`, `Contact`, `Total`, `Shipping` (blank or `Delivered`), `Pre-order ID`. Sale invoices and pre-order receipts share one plain sequential number series.

**Invoice lines** (append-only): `Invoice no`, `Invoice ID`, `SKU`, `Item`, `Qty`, `Listed price`, `Charged price`, `Unit cost`.

**Returns** (append-only, one row per returned toy): `ID`, `Date`, `Invoice no`, `Invoice ID`, `Customer`, `SKU`, `Item`, `Qty`, `Outcome` (`Restock`, `Write-off`), `Refund`, `Note`.

**Inbox** (rows Claude writes after reading photos): `Added`, `Type` (`Count` or `Receive`), `Name`, `Qty`, `Cost each`, `Manufacturer`, `Brand`, `Toy line`, `Character`, `Release date`, `Verify`, `Note`, `Status`. Every column is plain text. Claude appends rows here through the Google Sheets connector, using the toy-inventory-logger skill, after reading photos of boxes, shelves or supplier paperwork. This is the one tab the app does not write first, and nothing in it counts as stock. A row is waiting when `Name` is filled and `Status` is blank. The app sets `Status` to `Done` after applying a row and to `Dismissed` after dismissing it. A `Type` starting with R reads as `Receive`; any other value reads as `Count`.

## Documents and what they do to stock

A document never changes stock directly. `Code.gs` writes ordinary movements for it in the same request, so the Movements tab stays the single source of stock.

| Action | Rows written | Stock movement |
| --- | --- | --- |
| Supplier order saved | Supplier orders (`Ordered`) | None. Counts as incoming. |
| Supplier order received | Status `Received` | `In` / `Restock`, `Ref` = order ID, with the cost typed at receipt |
| Supplier order cancelled | Status `Cancelled` | None |
| Pre-order saved | Pre-orders (`Open`) + Invoices (`Pre-order receipt`) + one line | None. Counts as owed. |
| Payment added to a pre-order | `Paid`, `Balance` | None |
| Pre-order cancelled | Status `Cancelled`, and `Kept` with the deposit kept (typed each time; 0 is a full refund) | None |
| Sale invoice issued (Sell > New Sale) | Invoices (`Sale`) + lines; a linked pre-order becomes `Fulfilled`, and the app first marks any balance on it as paid, because payment comes before the invoice | `Out` / `Sale` per line, `Ref` = invoice number |
| Marked delivered (or unmarked) | `Shipping` set to `Delivered` or blank | None |
| Return recorded | Returns | `Restock`: `In` / `Return`, `Ref` = return ID. `Write-off`: none. See `RETURN_STOCK_`. |
| Inbox rows applied or dismissed | `Status` on the Inbox rows (`Done` or `Dismissed`) | None from the marking; applying also queues the normal entries, which write their own movements |

A return cannot exceed what the invoice sold of that toy, less what was already returned. The stock effect of each outcome lives in one table, `RETURN_STOCK_` in `Code.gs` and `RETURN_STOCK` in `index.html`; change both together.

### The four numbers per toy

`on hand` = stock. `incoming` = quantities on supplier orders still `Ordered`. `owed` = quantities on `Open` pre-orders. `left to promise` = on hand + incoming − owed. Pre-orders are not tied to particular supplier shipments. A pre-order counts as ready to ship when the stock on hand covers it, oldest pre-order first. Home and the Orders tab list it with the customer's contact, and Home carries an Invoice button on each waiting customer.

### Cost and margin

Cost is typed by hand on each receipt (a stock in from a toy's sheet, a received supplier order, Receive import, or a new toy's starting stock). The average cost on hand is a moving weighted average replayed over the movement log in sheet order: a receipt with a cost moves the average, and every other movement leaves it alone. An invoice line stores that average as `Unit cost`, and the invoice screen shows margin as total minus cost. Margin is not printed on the PDF.

### Invoice PDF

The PDF is made on the phone and is not stored anywhere: it is redrawn from the invoice record each time, so it can be produced offline and on any device that has synced. The page is drawn on a canvas and wrapped as a PDF with one image per A4 page, which keeps the currency symbol and any name readable without embedding fonts; the text in it cannot be selected. Shop name, contact details, footer line and logo are typed in Settings and kept on the device (`prefs.shop`), so each phone that issues invoices needs them entered once. The invoice screen has one PDF button, Share PDF. It opens the phone's share sheet when the browser can share files and downloads the file otherwise.

## Sync protocol

All calls are `POST` to the Apps Script `/exec` URL with a `text/plain` JSON body `{ key, action, ...payload }` (plain text avoids a CORS preflight). Responses are `{ ok, data }` or `{ ok: false, error, auth }`. The connection code the owner pastes is `<exec URL>#<key>`; `showKey()` in the script editor prints the key.

| Action | Payload | Returns |
| --- | --- | --- |
| `ping` | none | `{ version }`, used by Settings to test the code |
| `sync` | `have: { rows, lastId }` | `{ items, moves, rows, lastId, reset, syncedAt, custs, orders, pres, invs, rets, inbox }` |
| `add` | `entries`, `have` | `{ results: [{ id, ok, error, sku?, from?, no?, fromNo? }], sync }` |

Items, documents and the waiting `inbox` rows are always sent whole (a shop has hundreds, not millions). Each `inbox` row carries its sheet row number (`row`), `type` (`count` or `receive`) and the cell values as text. Movements are incremental: the app says how many movement rows it holds and the ID of the last one; if the sheet still has that ID at that row, only later rows come back, otherwise everything comes back with `reset: true` and the app replaces its copy. Hand-editing or deleting movement rows in the sheet therefore heals itself at the next sync.

`add` entries are applied in order and each is idempotent, so a retry after a lost response changes nothing: an item by SKU and name, everything else by its own ID, and a status change by carrying the final value.

| `kind` | Payload | Effect |
| --- | --- | --- |
| `item` | `item`, `auto` | New toy |
| `edit` | `sku`, `patch` | Change a toy's fields |
| `move` | `move { id, date, sku, dir, qty, reason, ref, note, cost }` | One movement |
| `cust` | `cust { id, name, contact }` | New customer, or new details for one |
| `order` | `order { id, date, sku, qty, expected, note }` | Supplier order |
| `receive` | `orderId, date, qty, cost` | Receive a supplier order |
| `orderCancel` | `orderId` | Cancel a supplier order |
| `pre` | `pre { id, date, custId, sku, qty, price, paid, note, invId, no }` | Pre-order and its receipt |
| `prePay` | `preId, paid` | New total paid on an open pre-order |
| `preCancel` | `preId, kept` | Cancel a pre-order; `kept` is the deposit kept, 0 is a full refund |
| `invoice` | `invoice { id, no, date, custId, lines: [{ sku, qty, price, cost }], preId }` | Sale invoice and its stock-out |
| `ship` | `invId, ship` (`'Delivered'` or `''`) | Delivered mark on a sale invoice |
| `ret` | `ret { id, date, invId, sku, qty, outcome, refund, note }` | Return (`outcome` is `Restock` or `Write-off`) |
| `inboxDone` | `rows: [{ row, name }], mark: 'Done' or 'Dismissed'` | Sets `Status` on Inbox rows. A row is marked only when the name at that row still matches and its `Status` is blank. |

### SKU collisions

Auto-generated SKUs are `T0001`, `T0002`, and so on, picked by the phone from its own list. Two phones that work offline can pick the same next SKU for different toys. Item entries made with a generated SKU carry `auto: true`. When the sheet finds a different toy on that SKU, it assigns the next free one, applies the rest of the batch (movements and documents alike) to the new SKU, and returns `{ sku, from }`; the app then renumbers whatever is still in its queue. If the name already exists under another SKU the entry is treated as the same toy, which makes a retry of a renumbered batch safe.

A refused item (for example a name already used by another SKU) blocks every later entry for that SKU in the same batch, and the app fails any queued entries for it, so a movement or document can never be credited to a different toy that owns the SKU. Refused entries stay in the queue, listed in Activity with the reason and counted on Home under "Needs you"; deleting a refused toy also deletes the entries waiting on it.

### Invoice numbers

The phone picks the next number (highest it knows plus one), so invoices can be issued offline. One phone issues invoices, so the numbers carry no device prefix. If the sheet already holds that number on a different document, it assigns the next free one and returns `{ no, fromNo }`; the app says so, because a PDF already sent carries the old number and should be shared again.

## Tabs

The bottom bar has five tabs: **Home**, **Stock**, **Sell**, **Orders** and **Import**. The Import tab shows the number of waiting Inbox rows next to its name. Two screens have no tab. Stock in and out by hand is reached from a toy's sheet in Stock ("+ Stock in" and "− Stock out") and returns to Stock after recording. Activity, the movement log where a movement can be reversed, is reached from the "All stock activity" button on Home or from "See all in Activity" on a toy's sheet.

In a window 900 px wide or more the same page uses a desktop layout. The tabs move to a side bar on the left, which also lists Activity, and the header names the current page. Sell shows the New Sale form beside the invoice list, Orders shows pre-orders beside supplier orders, and Home shows what needs doing beside the month's numbers. Sheets open as centred dialogs. `wide()` reads the media query, `render()` runs again when the window crosses the breakpoint, and the rest is CSS in the `min-width:900px` block. Nothing else differs between phone and desktop: the data, queue and sync are the same code.

`renderHome()` draws the dashboard:

- **New Sale** and **New pre-order** buttons.
- **Ready to ship**: one row per customer whose pre-order the stock on hand now covers, with an Invoice button.
- **Needs you**: a row appears only when its count is above zero. The rows are entries refused by the sheet, rows from Claude to review, supplier orders due to arrive, toys promised beyond stock and incoming, pre-orders with a balance, toys low or out, toys with no price, and release dates to verify. Each row opens the screen that handles it.
- Three cards: sales today, sales this month and margin this month. Margin leaves out invoice lines with no cost on file, and the card carries an asterisk when any were left out.

## Local state (`localStorage`, prefix `toys.`)

| Key | Contents |
| --- | --- |
| `cfg` | `{ url, key }` |
| `items` | Items as of the last sync |
| `moves` | Movements as of the last sync, in sheet order |
| `docs` | `{ custs, orders, pres, invs, rets, inbox }` as of the last sync |
| `meta` | `{ rows, lastId, syncedAt }` for the incremental pull |
| `queue` | Entries not yet confirmed by the sheet; `status` is `pending` or `failed` |
| `prefs` | Current tab (default `home`), currency symbol, default reorder level, and `shop` (name, contact, footer, logo) for the PDF |

Everything the owner does is written to the queue first and flushed when a connection exists. Without a connection the app works fully on the device; the queue holds everything until the connection code is pasted. `live()` merges synced data with pending entries (failed entries are not counted) and is the only thing the screens read. Inbox rows that have a pending `inboxDone` entry drop out of `live().inbox` at once. It replays pending documents the way `Code.gs` will apply them, including the movements they write, so an invoice issued offline already counts against stock. The app is the only writer to the sheet.

## Stock math

`stock(sku)` is the sum of signed movement quantities over synced movements plus pending queue moves. Negative stock is allowed and shown in red: recording a sale for something that was never counted in should not be blocked at the till. Issuing an invoice for more than is on hand asks for confirmation and then goes ahead, the same as a stock out from a toy's sheet. A low-stock toy is one with `0 < stock <= reorder level`; the item's own `Reorder at` wins over the default in Settings.

## Importing

There are two ways in, and both end in the same preview. Nothing is written before the preview is applied. The app has no lookup service: the assistant identifies the toy, looks up its details and writes the rows.

**Inbox (the main path).** Claude appends rows to the Inbox tab after reading photos of boxes, shelves or supplier paperwork. The photos reach Claude either attached in chat or uploaded to a Google Drive folder that the skill checks; that part lives in the skill, not in this repo. Every sync returns the waiting rows as `inbox`. The Import tab shows them at once in the same preview used for pasted blocks, one `Type` at a time (the type of the first waiting row, then the next type after those are handled). `Count` rows go through the Count from photo rules and `Receive` rows through the Receive rules below. Apply queues the normal entries plus one `inboxDone` entry with `mark: 'Done'`. Dismiss queues `inboxDone` with `mark: 'Dismissed'` and records nothing. `Code.gs` marks a row only when the name at that row still matches, so rows that were edited or moved in the sheet in the meantime keep waiting. When the last waiting row is applied, the app returns to Stock.

**Paste a block by hand (the fallback).** When nothing is waiting, the Import tab offers "Paste a block by hand" with three modes: Count from photo, Receive and Movements. The importers parse pasted text split on tabs (or `|`, or `;`) and queue only the ticked rows. "Copy the prompt and toy list for Claude" builds the exact instructions for the current mode plus the catalogue, so existing names are reused.

**Count from photo** (`Name, Category, Count, Price, Note, Manufacturer, Brand, Toy line, Character, Release date, Verify`), for photos of boxes or of the stockroom. A count is an absolute quantity. For a toy already on file the app records only the difference as a `Count` movement; a toy that is new is created with its details and given an `Opening` movement. Re-pasting the same counts therefore changes nothing. Details in the paste fill blank fields on a toy already on file and never overwrite what is there. Toys missing from the paste are left alone. Names match after lower-casing and stripping punctuation; a name that is similar but not equal (token overlap of 50% or more) is held back unticked with a "Use ..." button. `?` or a blank count skips the row. A toy listed twice in one paste is flagged rather than summed. `Verify` set to `Y` raises the release-date flag. An Inbox `Count` row supplies `Name`, `Qty` (the count), `Note` and the toy details; it has no category or price. Inbox `Count` rows for the same toy (one per photo it appears in) are added into one count before the preview, so each box must be photographed once. Inbox `Receive` rows are dated on the day they are applied.

**Receive** (`Name, Qty, Cost each, Category, Manufacturer, Brand, Toy line, Character, Release date, Verify, Note`), for supplier invoices and packing lists. Each row adds stock as a `Restock` at its cost on the "Received on" date. A new toy is created first. When the toy has a supplier order on the way, the row receives that order (oldest first) so it stops counting as incoming.

**Movements** (`Date, Toy, In/Out, Qty, Reason, Note`, and an optional seventh column with the cost each for an `In` row): the toy can be a name or a SKU. Rows that repeat an existing movement (same date, toy, direction, quantity and reason) come in unticked as likely duplicates; rows that would take stock below zero are flagged but allowed. This mode exists only in the paste box.

## Assumptions made where the brief was open

Each of these was undecided when v2 was built. They are listed so they can be changed in one place.

| Topic | What the app does | Where to change it |
| --- | --- | --- |
| Currency and number format | `₱` by default, device number format | Settings > Currency symbol; `money()` |
| Return outcomes | Restock brings the toy back into stock; Write-off does not. A replacement for a returned toy is a new sale. | `RETURN_STOCK_` / `RETURN_STOCK` |
| Customer tracker | A Customers tab in the same spreadsheet | `T_.cust` |
| "Ready to collect" | Labelled "Ready to ship" | `preListHtml()`, `renderHome()` |
| Shipping status | A single `Delivered` mark on a sale invoice, blank until set | `SHIP_`, `ship` |
| PDF | Made on the phone, not stored, shop details per device | `drawDoc()`, `prefs.shop` |
| PDF wording | Titles "INVOICE" and "PRE-ORDER RECEIPT"; no tax lines; footer line optional | `drawDoc()`, Settings |
| Supplier orders | No supplier name and no cost at order time; cost is typed when received; the whole order closes on receipt with the quantity typed | `T_.order`, `receive` |
| Receive import | A row for a toy with an open supplier order closes the oldest one | `settleReceive()` |
| Selling more than is left to promise | No warning beyond the existing on-hand confirmation | `issueInvoice()` |
| Pre-order receipt | Always made when a pre-order is saved | `pre` in `addEntries_` |
| Balance on a pre-order at invoice time | Marked as paid when the invoice is issued | `issueInvoice()` |
| Inbox | Claude writes the rows and the app reviews them; the app never writes an Inbox row, and only sets `Status` after the owner applies or dismisses | `INBOX_HEAD_`, `readInbox_()`, `inboxDone` |

Not built because the brief left them undecided: an ID-confidence field, holds on unpaid units, return windows, refund approval, payment method and reference, voiding an invoice, and exchanges as a return outcome.

## Known limits

- Two phones that each create a toy with the same name at the same moment, one of them offline, will merge into one toy and both opening stocks are added. The log shows both entries, and either can be reversed.
- A SKU cannot be changed after the toy is created.
- An invoice cannot be edited or voided once it has reached the sheet. A wrong one is undone with a return, or by reversing its movement in Activity.
- The average cost follows sheet order, not movement dates, and a reversed receipt does not take its cost back out of the average.
- The movement log and all documents live in `localStorage` (about 5 MB), which is enough for tens of thousands of rows. Beyond that the app would need IndexedDB.
- The Inbox depends on the assistant writing well-formed rows (a name, a numeric `Qty`, a `Type` of `Count` or `Receive`). A malformed row shows up in the preview as skipped or flagged, and the app cannot fix it. The Inbox has never been exercised against a real sheet or the real Google Sheets connector, only against the test fake.
- `Code.gs` was tested against a fake of Google's services, not on a live sheet. The fake enforces plain-text formatting on the columns that hold free text; the real behaviour of `setup()` and of every write should be confirmed once on a real sheet.
