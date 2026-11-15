# Bodega: how the app works

This file describes release 2.1.1 (`VERSION` `2.1.1`, service worker cache `toys-v2.1.1`). Releases 2.1.0 and 2.1.1 changed the app only: `apps-script/Code.gs`, the sync protocol and the sheet are as they were in 2.0.0.

Bodega is a single-page web app (PWA) for a small shop that sells through chat, over a Google Sheet, installed on a phone's home screen. It is local-first: the phone keeps every item and movement, computes stock itself, and uses the sheet to share data between devices and to keep a record the owner can read and chart. This file is the reference for anyone changing the app, so the logic below does not have to be rediscovered from chat history.

This repository is meant to be served by GitHub Pages. Keep the spreadsheet ID, the connection key and real stock data out of this file and out of the code.

It follows the same pattern as the Ledger app (a public Pages repo, an Apps Script web app bound to a sheet, a `URL#key` connection code, a queue of pending writes, paste-to-import).

## Files and deployment

| File | Role |
| --- | --- |
| `index.html` | The whole app: markup, CSS and one main `<script>`. A small `<script data-boot>` in the head applies the stored theme before the first paint. `VERSION` and `APP_NAME` are constants at the top of the main script. |
| `sw.js` | Service worker. The page is network-first (3-second budget, then the cached copy); fonts, icons and the manifest are cache-first. Never caches sheet data. |
| `fonts/` | Bebas Neue 400 and Geist 400, 500 and 600 (latin subsets, woff2), served with the app so text looks the same offline. `fonts/README.md` names the source packages and the licence (SIL OFL 1.1). |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata. |
| `apps-script/Code.gs` | The back end. Paste it into the sheet's Apps Script project; it is not deployed from this repo. |
| `test/` | `mock-backend.js` runs `Code.gs` unchanged against an in-memory fake of Google's services. `backend.test.js` tests it directly; `e2e.py` (stock, import, sync) and `e2e_v2.py` (item details, costs, orders, invoices, PDF, returns) drive the app in Chrome against it at phone size; `desktop.py` checks the desktop layout; `offline.py` checks offline launch. |

Changing this repo needs only a push to `main`; GitHub Pages republishes in about a minute. Changing `Code.gs` means pasting the new file into the Apps Script editor and publishing a new version of the existing web app deployment (Deploy > Manage deployments > edit > New version), which keeps the `/exec` URL.

### Release checklist

1. Bump `VERSION` in `index.html`.
2. Bump `CACHE` in `sw.js` to the same version (`toys-vX.Y.Z`). Browsers only install a new service worker when the bytes of `sw.js` change.
3. Never commit an empty or truncated `sw.js`: `test -s sw.js && node --check sw.js`.
4. Check the main script parses (the head script is `<script data-boot>`, so `indexOf('<script>')` finds the main one): `node -e "const h=require('fs').readFileSync('index.html','utf8');new Function(h.slice(h.indexOf('<script>')+8,h.lastIndexOf('</script>')))"`.
5. Run `node test/backend.test.js`, then start `python3 -m http.server 8765` and `node test/mock-backend.js 8766` and run `python3 test/e2e.py`, `python3 test/e2e_v2.py`, `python3 test/desktop.py` and `python3 test/offline.py`.
6. Commit and push to `main`.

## The sheet

`setup()` in `Code.gs` creates nine tabs and formats the text columns as plain text, so a SKU such as `0012`, a phone number such as `+63917...` or a note starting with `=` is stored as typed. It is safe to run again; after pasting a new `Code.gs`, run it once more so new tabs and columns exist.

**Items** (one row per item): `SKU`, `Name`, `Category`, `Price`, `Reorder at`, `Active` (`Yes` or `No`), `On hand`, `Manufacturer`, `Brand`, `Toy line` (labelled Product line in the app), `Character`, `Release date`, `Release check`. `On hand` is a single `ARRAYFORMULA` in `G2` that sums `Movements` per SKU; the script writes the columns on either side of G and never G itself. `Release date` is a best guess stored as text (`2024`, `2024-07` or `2024-07-15`); `Release check` holds `Verify` while that guess still needs checking. A variant (chase, exclusive colour, reissue) is its own row with its own name and SKU. Archiving sets `Active` to `No`; rows are never deleted.

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

**Pre-orders** (customer has paid, item not yet in stock): `ID`, `Date`, `Customer ID`, `Customer`, `Contact`, `SKU`, `Item`, `Qty`, `Price`, `Paid`, `Balance`, `Status` (`Open`, `Fulfilled`, `Cancelled`), `Kept`, `Receipt no`, `Invoice no`, `Note`. `Balance` is zero when paid in full. On a cancelled pre-order `Kept` holds the deposit the shop kept, and 0 means a full refund.

**Invoices**: `No`, `ID`, `Date`, `Type` (`Sale` or `Pre-order receipt`), `Customer ID`, `Customer`, `Contact`, `Total`, `Shipping` (blank or `Delivered`), `Pre-order ID`. Sale invoices and pre-order receipts share one plain sequential number series.

**Invoice lines** (append-only): `Invoice no`, `Invoice ID`, `SKU`, `Item`, `Qty`, `Listed price`, `Charged price`, `Unit cost`.

**Returns** (append-only, one row per returned item): `ID`, `Date`, `Invoice no`, `Invoice ID`, `Customer`, `SKU`, `Item`, `Qty`, `Outcome` (`Restock`, `Write-off`), `Refund`, `Note`.

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
| Sale invoice issued (Sales > New sale) | Invoices (`Sale`) + lines; a linked pre-order becomes `Fulfilled`, and the app first marks any balance on it as paid, because payment comes before the invoice | `Out` / `Sale` per line, `Ref` = invoice number |
| Marked delivered (or unmarked) | `Shipping` set to `Delivered` or blank | None |
| Return recorded | Returns | `Restock`: `In` / `Return`, `Ref` = return ID. `Write-off`: none. See `RETURN_STOCK_`. |
| Inbox rows applied or dismissed | `Status` on the Inbox rows (`Done` or `Dismissed`) | None from the marking; applying also queues the normal entries, which write their own movements |

A return cannot exceed what the invoice sold of that item, less what was already returned. The stock effect of each outcome lives in one table, `RETURN_STOCK_` in `Code.gs` and `RETURN_STOCK` in `index.html`; change both together.

### The four numbers per item

`on hand` = stock. `incoming` = quantities on supplier orders still `Ordered`. `owed` = quantities on `Open` pre-orders. `left to promise` = on hand + incoming − owed. Pre-orders are not tied to particular supplier shipments. A pre-order counts as ready to ship when the stock on hand covers it, oldest pre-order first. Home lists it as a job ("Ship Ana Reyes's pre-order"), and Orders lists it with the customer's contact.

`free to sell` = max(on hand, 0) − owed. Incoming stock does not count. The New sale form uses this number to decide whether it makes an invoice or saves a pre-order (see "The New sale form" below).

### Cost and margin

Cost is typed by hand on each receipt (a stock in from an item's sheet, a received supplier order, Receive import, or a new item's starting stock). The average cost on hand is a moving weighted average replayed over the movement log in sheet order: a receipt with a cost moves the average, and every other movement leaves it alone. An invoice line stores that average as `Unit cost`, and the invoice screen shows margin as total minus cost. Margin is not printed on the PDF.

### Invoice PDF

The PDF is made on the phone and is not stored anywhere: it is redrawn from the invoice record each time, so it can be produced offline and on any device that has synced. The page is drawn on a canvas and wrapped as a PDF with one image per A4 page, which keeps the currency symbol and any name readable without embedding fonts; the text in it cannot be selected. Shop name, contact details, footer line and logo are typed in Settings and kept on the device (`prefs.shop`), so each phone that issues invoices needs them entered once. The invoice screen has one PDF button, Share PDF. It opens the phone's share sheet when the browser can share files and downloads the file otherwise.

## Sync protocol

All calls are `POST` to the Apps Script `/exec` URL with a `text/plain` JSON body `{ key, action, ...payload }` (plain text avoids a CORS preflight). Responses are `{ ok, data }` or `{ ok: false, error, auth }`. The connection code the owner pastes is `<exec URL>#<key>`; `showKey()` in the script editor prints the key.

| Action | Payload | Returns |
| --- | --- | --- |
| `ping` | none | `{ version }`, used by Settings to test the code |
| `sync` | `have: { rows, lastId }` | `{ items, moves, rows, lastId, reset, syncedAt, custs, orders, pres, invs, rets, inbox }` |
| `add` | `entries`, `have` | `{ results: [{ id, ok, error, sku?, from?, no?, fromNo? }], sync }` |

Items, documents and the waiting `inbox` rows are always sent whole (a shop has hundreds of them). Each `inbox` row carries its sheet row number (`row`), `type` (`count` or `receive`) and the cell values as text. Movements are incremental: the app says how many movement rows it holds and the ID of the last one; if the sheet still has that ID at that row, only later rows come back, otherwise everything comes back with `reset: true` and the app replaces its copy. Hand-editing or deleting movement rows in the sheet therefore heals itself at the next sync.

`add` entries are applied in order and each is idempotent, so a retry after a lost response changes nothing: an item by SKU and name, everything else by its own ID, and a status change by carrying the final value.

| `kind` | Payload | Effect |
| --- | --- | --- |
| `item` | `item`, `auto` | New item |
| `edit` | `sku`, `patch` | Change an item's fields |
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

Auto-generated SKUs are `T0001`, `T0002`, and so on, picked by the phone from its own list. Two phones that work offline can pick the same next SKU for different items. Item entries made with a generated SKU carry `auto: true`. When the sheet finds a different item on that SKU, it assigns the next free one, applies the rest of the batch (movements and documents alike) to the new SKU, and returns `{ sku, from }`; the app then renumbers whatever is still in its queue. If the name already exists under another SKU the entry is treated as the same item, which makes a retry of a renumbered batch safe.

A refused item (for example a name already used by another SKU) blocks every later entry for that SKU in the same batch, and the app fails any queued entries for it, so a movement or document can never be credited to a different item that owns the SKU. Refused entries stay in the queue, listed in Activity with the reason and counted on Home under "Needs you"; deleting a refused item also deletes the entries waiting on it.

### Invoice numbers

The phone picks the next number (highest it knows plus one), so invoices can be issued offline. One phone issues invoices, so the numbers carry no device prefix. If the sheet already holds that number on a different document, it assigns the next free one and returns `{ no, fromNo }`; the app says so, because a PDF already sent carries the old number and should be shared again.

## Tabs and routes

The phone has four tabs in a bottom bar: **Home**, **Stock**, **Sales** and **Orders**. Three routes have no tab: `import` (titled Update stock), `move` (Stock in and out, one item by hand) and `activity` (the movement log, where a movement can be reversed). While one of them shows, the tab it belongs to stays lit (Home for Update stock, Stock for the other two), and the header carries a close button in place of Settings that returns to the last tabbed page. Update stock opens from the Home button and from the Home row about rows from Claude. Stock in and out opens from an item's sheet and from Update stock. Activity opens from the Activity link on Stock, from "See all in Activity" on an item's sheet and from the Home row about refused entries.

Tapping **Sales** opens the invoice list, with a **New sale** button at the top. When the New sale form has an item picked (a draft in progress), tapping Sales opens the form instead. The form's close button clears the draft and returns to the list.

In a window 900 px wide or more the same page uses a desktop layout. The tabs move to a side bar on the left, which lists Home, Stock, Sales, Orders, Update stock (with the number of waiting Inbox rows, for example "Update stock · 3") and Activity. The current page is drawn in the text colour. Sales shows the New sale form beside the invoice list, Orders shows pre-orders beside supplier orders, and Home shows the numbers and the two buttons beside "Needs you". Sheets open as centred dialogs. `wide()` reads the media query, `render()` runs again when the window crosses the breakpoint, and the rest is CSS in the `min-width:900px` block. Nothing else differs between phone and desktop: the data, queue and sync are the same code.

The header shows the page title. On Home it shows the shop name from Settings when one is set, and the app name otherwise. On the right are the sync status as plain text (a button that syncs now; attention colour while entries wait, danger colour when entries were refused or the last sync failed) and the Settings button.

### Home

`renderHome()` draws, from the top on a phone:

1. The numbers strip, titled "<Month> so far", with three cells: Today, Month and Margin, in whole pesos. Margin leaves out invoice lines with no cost on file. It shows "–" when no line sold this month has a cost and carries an asterisk when only some do. Tapping the strip opens the invoice list. One muted line follows only when there is something to say: what the asterisk means, that no item sold has a cost, or the refunds this month.
2. Two buttons: **New sale** and **Update stock** (which reads "Update stock · N" when N Inbox rows wait). With no active items, New sale is left out and Update stock becomes the primary button.
3. **Needs you**: one list of jobs in a fixed order, built by `needsRows()`. The badge on the title counts the rows. Each row is phrased as an action and opens the place to do it:
   1. Fix N entries the sheet refused (Activity).
   2. Ship <Customer>'s pre-order, one row per customer, oldest first, with the item, quantity and any balance (opens New sale filled from that pre-order). A customer with two ready pre-orders gets one row for the oldest, which says how many more are ready. When four or more pre-orders are ready, a single row "Ship N pre-orders now in stock" opens the pre-order list instead.
   3. Review N rows from Claude (Update stock).
   4. Order stock for N items promised beyond supply (Stock, filtered).
   5. Receive N supplier orders due, with the first two item names (Orders, supplier list).
   6. Collect ₱X on N pre-orders (Orders, pre-order list).
   7. Restock N items (Stock, low or out).
   8. Price N items (Stock, no price yet).
   9. Check N release dates (Stock, release date to verify).

   On a phone a list of more than five rows shows the first four and a line "See N more", which then reads "See less". The expanded state is `ui.homeMore`, kept in memory only: it survives a re-render after a sync and resets when Home is entered from the tab bar. A desktop window shows every row. With nothing to do the section says "Nothing needs you." and has no badge.

With no items and no Inbox rows, Home shows a first-run screen with **Add an item** and **Update stock**.

### The New sale form

Sales and pre-orders share one form, `renderInvForm()`, whose state is `ui.inv`: customer, contact, date, lines, `preId`, `paid` ('' means paid in full), `note` and `force` ('' or 'sale').

The form decides its mode in `invInfo()`. Opened from a pre-order (`preId` set), it is a sale. Otherwise, with `force === 'sale'` it is a sale. Otherwise, when any picked line asks for more than is free to sell, it saves a pre-order; else it is a sale.

- **Sale**: a customer name is required and the contact is optional. Several items can go on one invoice ("Add another item"). The button reads "Issue invoice no. N", and a muted line under it says what the tap does. Issuing takes the items out of stock with no confirmation, even below zero, and opens the invoice. When `force === 'sale'` and a line is short, one muted line says so ("Only 1 on hand. Stock will go below zero.", or that the units are owed to earlier pre-orders) with a text button "Save as a pre-order" that clears `force`.
- **Pre-order**: a bordered notice under the item explains why ("Not in stock, so this is saved as a pre-order", "The 2 on hand are owed to earlier pre-orders, so this is saved as a pre-order", or "Only 1 is free to sell, so this is saved as a pre-order") and offers "It is here, sell it now", which sets `force`. The form adds "Paid now", makes the contact required, shows the total and the balance when it arrives, and its button reads "Save pre-order · receipt no. N". Saving queues the same `cust` and `pre` entries as before, clears the form and opens the receipt. A pre-order holds one item, so "Add another item" is hidden; a form that already has several items with one short shows the notice for that item and refuses to save with a toast until the other items are removed or the item is sold now.

Changing or clearing a picked item resets `force`. The date (and the note, for a pre-order) sits behind one folded line, "Dated today". Typing a quantity that changes the mode redraws the form and keeps the cursor in the field (`invSig()`).

The `fulfil` action (a ready row on Home, or "Issue invoice" on a pre-order's sheet) fills the form with `preId`. Issuing first marks any balance as paid.

### Update stock

The `import` route (`renderImport()`). With Inbox rows waiting it shows them for review as before (see "Importing"). With none waiting it shows one line on sending Claude photos, then a list of other ways to change stock: "Receive a supplier order (N on the way)" when orders are on the way, "One item by hand" (the Move screen with a picker) and "Add a new item", then the folded "Paste a block by hand" section. That section is open by default while no connection code is set. When a sync raises the number of waiting Inbox rows and Update stock is not on screen, a toast says "N rows from Claude to review".

### Theme

Settings > Preferences > Theme offers Device, Light and Dark, stored as `prefs.theme` (`auto`, `light` or `dark`; default `auto`) on the device. There is no theme control in the header. The colour tokens are CSS custom properties: light in `:root`, dark under `@media (prefers-color-scheme: dark)` for `:root:not([data-theme="light"])` and again for `:root[data-theme="dark"]`, each with a matching `color-scheme`. An explicit choice sets `data-theme` on `<html>`; Device removes it. The head script applies the stored choice before the first paint, and `applyTheme()` does the same when the setting changes. Both theme-color metas follow the choice. The invoice PDF is drawn with literal colours, so its bytes are the same in either theme.

### Look

Every rule uses the tokens (`--bg`, `--text`, `--muted`, `--line`, `--field`, `--raise`, `--raise-edge`, `--accent`, `--accent-edge`, `--on-accent`, `--attn`, `--danger`). Yellow (`--accent`) marks only what to act on: the primary button, the badges and counts that need action. Bebas Neue is used for page and sheet titles and for the numbers that are the point of an element; Geist for everything else, at 13, 15 and 16 px, weights 400 to 600. Corners are square. A button has a solid lower layer (`box-shadow: 0 4px 0` of its edge colour) that shrinks when pressed; minor actions are underlined text buttons, and destructive ones are text buttons in the danger colour. Sections (`sec()`) are hairline boxes with the title on the top rule; lists are rows (`row()`) with a title, one muted line, and a chevron or one number on the right. Filters and switches are text tabs underlined when chosen. Icons are inline stroke SVGs (`ICON`). Inputs use 16 px text so iOS does not zoom when one is focused.

## Local state (`localStorage`, prefix `toys.`)

| Key | Contents |
| --- | --- |
| `cfg` | `{ url, key }` |
| `items` | Items as of the last sync |
| `moves` | Movements as of the last sync, in sheet order |
| `docs` | `{ custs, orders, pres, invs, rets, inbox }` as of the last sync |
| `meta` | `{ rows, lastId, syncedAt }` for the incremental pull |
| `queue` | Entries not yet confirmed by the sheet; `status` is `pending` or `failed` |
| `prefs` | Current tab (default `home`), currency symbol, default reorder level, `theme` (`auto`, `light` or `dark`), and `shop` (name, contact, footer, logo) for the PDF and the Home header |

Everything the owner does is written to the queue first and flushed when a connection exists. Without a connection the app works fully on the device; the queue holds everything until the connection code is pasted. `live()` merges synced data with pending entries (failed entries are not counted) and is the only thing the screens read. Inbox rows that have a pending `inboxDone` entry drop out of `live().inbox` at once. It replays pending documents the way `Code.gs` will apply them, including the movements they write, so an invoice issued offline already counts against stock. The app is the only writer to the sheet.

## Stock math

`stock(sku)` is the sum of signed movement quantities over synced movements plus pending queue moves. Negative stock is allowed and shown in the danger colour: recording a sale for something that was never counted in should not be blocked at the till. The New sale form saves a pre-order when a line asks for more than is free to sell; "It is here, sell it now" issues the invoice anyway, with no confirmation, and stock goes below zero. A stock out by hand for more than is on hand still asks for confirmation. A low-stock item is one with `0 < stock <= reorder level`; the item's own `Reorder at` wins over the default in Settings.

## Importing

There are two ways in, and both end in the same preview. Nothing is written before the preview is applied. The app has no lookup service: the assistant identifies the item, looks up its details and writes the rows.

**Inbox (the main path).** Claude appends rows to the Inbox tab after reading photos of boxes, shelves or supplier paperwork. The photos reach Claude either attached in chat or uploaded to a Google Drive folder that the skill checks; that part lives in the skill and is outside this repo. Every sync returns the waiting rows as `inbox`. Update stock shows them at once in the same preview used for pasted blocks, one `Type` at a time (the type of the first waiting row, then the next type after those are handled). `Count` rows go through the Count from photo rules and `Receive` rows through the Receive rules below. Apply queues the normal entries plus one `inboxDone` entry with `mark: 'Done'`. Dismiss queues `inboxDone` with `mark: 'Dismissed'` and records nothing. `Code.gs` marks a row only when the name at that row still matches, so rows that were edited or moved in the sheet in the meantime keep waiting. When the last waiting row is applied, the app returns to Stock.

**Paste a block by hand (the fallback).** When nothing is waiting, Update stock offers "Paste a block by hand" with three modes: Count from photo, Receive and Movements. The importers parse pasted text split on tabs (or `|`, or `;`) and queue only the ticked rows. "Copy the prompt and item list for Claude" builds the exact instructions for the current mode plus the catalogue, so existing names are reused.

**Count from photo** (`Name, Category, Count, Price, Note, Manufacturer, Brand, Product line, Character, Release date, Verify`), for photos of boxes or of the stockroom. A count is an absolute quantity. For an item already on file the app records only the difference as a `Count` movement; an item that is new is created with its details and given an `Opening` movement. Re-pasting the same counts therefore changes nothing. Details in the paste fill blank fields on an item already on file and never overwrite what is there. Items missing from the paste are left alone. Names match after lower-casing and stripping punctuation; a name that is similar but not equal (token overlap of 50% or more) is held back unticked with a "Use ..." button. `?` or a blank count skips the row. An item listed twice in one paste is flagged, and its counts are not added. `Verify` set to `Y` raises the release-date flag. An Inbox `Count` row supplies `Name`, `Qty` (the count), `Note` and the item details; it has no category or price. Inbox `Count` rows for the same item (one per photo it appears in) are added into one count before the preview, so each box must be photographed once. Inbox `Receive` rows are dated on the day they are applied.

**Receive** (`Name, Qty, Cost each, Category, Manufacturer, Brand, Product line, Character, Release date, Verify, Note`), for supplier invoices and packing lists. Each row adds stock as a `Restock` at its cost on the "Received on" date. A new item is created first. When the item has a supplier order on the way, the row receives that order (oldest first) so it stops counting as incoming.

**Movements** (`Date, Item, In/Out, Qty, Reason, Note`, and an optional seventh column with the cost each for an `In` row): the item can be a name or a SKU. Rows that repeat an existing movement (same date, item, direction, quantity and reason) come in unticked as likely duplicates; rows that would take stock below zero are flagged but allowed. This mode exists only in the paste box.

## Assumptions made where the brief was open

Each of these was undecided when v2 or v2.1 was built. They are listed so they can be changed in one place.

| Topic | What the app does | Where to change it |
| --- | --- | --- |
| Currency and number format | `₱` by default, device number format | Settings > Currency symbol; `money()` |
| Return outcomes | Restock brings the item back into stock; Write-off does not. A replacement for a returned item is a new sale. | `RETURN_STOCK_` / `RETURN_STOCK` |
| Customer tracker | A Customers tab in the same spreadsheet | `T_.cust` |
| "Ready to collect" | Labelled "Ready to ship" | `preListHtml()`, `renderHome()` |
| Shipping status | A single `Delivered` mark on a sale invoice, blank until set | `SHIP_`, `ship` |
| PDF | Made on the phone and never stored; shop details are kept per device | `drawDoc()`, `prefs.shop` |
| PDF wording | Titles "INVOICE" and "PRE-ORDER RECEIPT"; no tax lines; footer line optional | `drawDoc()`, Settings |
| Supplier orders | No supplier name and no cost at order time; cost is typed when received; the whole order closes on receipt with the quantity typed | `T_.order`, `receive` |
| Receive import | A row for an item with an open supplier order closes the oldest one | `settleReceive()` |
| Sale or pre-order | One form. More than is free to sell (on hand less owed, incoming not counted) saves a pre-order; "It is here, sell it now" makes it a sale with no confirmation | `invInfo()`, `freeOf()` |
| A pre-order with several items | Refused: a pre-order holds one item, as the sheet's Pre-orders tab does | `savePreOrder()` |
| Notice when some units are free but not enough | "Only N are free to sell, so this is saved as a pre-order" | `invNotice()` |
| Selling now when units are owed but on hand | One muted line says the units are owed to earlier pre-orders | `invForced()` |
| Two ready pre-orders for one customer | One Home row for the oldest, saying how many more are ready | `needsRows()` |
| Ready rows on Orders | Open the pre-order's sheet, which has Issue invoice; the Home row opens the filled form directly | `preRow()` |
| Closing the New sale form on a phone | Clears the draft and shows the invoice list | `back` in the click handler |
| Settings on pages without a tab | The header shows a close button in its place; Settings opens from any tabbed page | `render()` |
| Delivered mark | A checkbox on the invoice sheet | `openInv()` |
| App name | "Bodega", a placeholder | `APP_NAME`, `<title>`, head meta, `manifest.webmanifest` |
| Theme | Device, Light or Dark, kept per device in `prefs.theme`; the invoice PDF looks the same in all three | `applyTheme()`, `drawDoc()` |
| Update stock on desktop and phone | A route with no phone tab; a Home button and the desktop side bar open it | `TABS`, `render()` |
| Fonts | Two self-hosted families, cached first by the service worker, licensed SIL OFL 1.1 | `fonts/`, `sw.js` |
| Pre-order receipt | Always made when a pre-order is saved | `pre` in `addEntries_` |
| Balance on a pre-order at invoice time | Marked as paid when the invoice is issued | `issueInvoice()` |
| Inbox | Claude writes the rows and the app reviews them; the app never writes an Inbox row, and only sets `Status` after the owner applies or dismisses | `INBOX_HEAD_`, `readInbox_()`, `inboxDone` |

Not built because the brief left them undecided: an ID-confidence field, holds on unpaid units, return windows, refund approval, payment method and reference, voiding an invoice, and exchanges as a return outcome.

## Known limits

- Two phones that each create an item with the same name at the same moment, one of them offline, will merge into one item and both opening stocks are added. The log shows both entries, and either can be reversed.
- A SKU cannot be changed after the item is created.
- An invoice cannot be edited or voided once it has reached the sheet. A wrong one is undone with a return, or by reversing its movement in Activity.
- The average cost follows sheet order and ignores movement dates, and a reversed receipt does not take its cost back out of the average.
- The movement log and all documents live in `localStorage` (about 5 MB), which is enough for tens of thousands of rows. Beyond that the app would need IndexedDB.
- The Inbox depends on the assistant writing well-formed rows (a name, a numeric `Qty`, a `Type` of `Count` or `Receive`). A malformed row shows up in the preview as skipped or flagged, and the app cannot fix it. The Inbox has never been exercised against a real sheet or the real Google Sheets connector, only against the test fake.
- Release 2.1.0 made no backend or sheet change. The tests run against the mock backend only, so they do not prove behaviour on a real sheet.
- The latin font subsets have no peso sign, so ₱ is drawn with a system font next to Bebas Neue and Geist.
- The sheet keeps its own header names, including `Toy line` on Items and Inbox, because `Code.gs` and the deployed sheet were left unchanged; only the app's labels say Product line.
- Settings cannot be opened from Update stock, Stock in and out, Activity or the New sale form on a phone, because the close button takes its place there.
- `Code.gs` was tested only against a fake of Google's services. The fake enforces plain-text formatting on the columns that hold free text; the real behaviour of `setup()` and of every write should be confirmed once on a real sheet.
