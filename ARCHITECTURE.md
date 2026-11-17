# Bodega: how the app works

This file describes app 2.4.1 and back end 2.4.0 (`VERSION` `2.4.1`, service worker cache `toys-v2.4.1`, `VERSION_` `2.4.0` in `Code.gs`). App 2.4.1 adds an editable Price column to the Update inventory review. Release 2.4.0 calls what the app used to call an item a product, gives every unit its own SKU, renames Stock to Inventory and Update stock to Update inventory, removes Category and Reorder at, draws every desktop table in one compact fixed-width style with sort and tickbox filters in the header cells, lets the review set a cost each in place, and lets the side bar fold to icons. It builds on 2.3.0, which tracks every unit on hand with its own cost and sells the oldest first (see "Movements and FIFO") and exports the invoice as a PNG image (see "Invoice image"). A live 2.3 sheet is upgraded in place by `setup()`: nothing is wiped (see "Going live with 2.4.0").

Bodega is a single-page web app (PWA) for a small shop that sells through chat, over a Google Sheet, installed on a phone's home screen. It is local-first: the phone keeps every product and movement, computes stock itself, and uses the sheet to share data between devices and to keep a record the owner can read and chart. This file is the reference for anyone changing the app, so the logic below does not have to be rediscovered from chat history.

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
| `test/` | `mock-backend.js` runs `Code.gs` unchanged against an in-memory fake of Google's services and serves it over HTTP like the `/exec` URL. `backend.test.js` tests `Code.gs` through it directly. The browser tests drive the app in Chrome against it: `e2e.py` (stock, import, sync), `e2e_v2.py` (product details, supplier orders, pre-orders, invoices and the invoice image, returns), `cost.py` (units and cost: FIFO sales, cost changes, deficits, returns, reversals, the "No cost yet" filter), `fix.py` (Correct this row), `desktop.py` (the desktop layout and its tables) and `offline.py` (offline launch). `common.py` holds the helpers they share; importing it resets the mock backend, so each test starts on an empty sheet. They read the ports from `APP_PORT` and `API_PORT` (default 8765 and 8766). |

Changing this repo needs only a push to `main`; GitHub Pages republishes in about a minute. Changing `Code.gs` means pasting the new file into the Apps Script editor and publishing a new version of the existing web app deployment (Deploy > Manage deployments > edit > New version), which keeps the `/exec` URL.

### Release checklist

1. Bump `VERSION` in `index.html`, and `VERSION_` in `Code.gs` when the back end changes.
2. Bump `CACHE` in `sw.js` to the same version (`toys-vX.Y.Z`). Browsers only install a new service worker when the bytes of `sw.js` change.
3. Never commit an empty or truncated `sw.js`: `test -s sw.js && node --check sw.js`.
4. Check the main script parses (the head script is `<script data-boot>`, so `indexOf('<script>')` finds the main one): `node -e "const h=require('fs').readFileSync('index.html','utf8');new Function(h.slice(h.indexOf('<script>')+8,h.lastIndexOf('</script>')))"`.
5. Run the tests as the README lists them: `node test/backend.test.js`, then start `python3 -m http.server 8765` and `node test/mock-backend.js 8766` and run `for t in test/*.py; do python3 $t; done`. A browser test that fails prints `FAIL` lines and exits non-zero.
6. Commit and push to `main`.

### Going live with 2.4.0

1. Paste the new `Code.gs` into the Apps Script editor and save.
2. Run `setup()` once. It renames the Items tab to Products, deletes the Category and Reorder at columns, writes the current header row on every tab, gives every `In` row of Movements its unit SKU, and makes Browse again. Nothing is wiped; `wipeAllData()` and `reopenInbox()` are not needed.
3. Deploy > Manage deployments > edit > New version.
4. Merge the app to `main` and wait for GitHub Pages to republish.
5. Open the app on each device, sync, and confirm Settings shows 2.4.0. Each phone downloads the movements again, because `setup()` raised `moveRev` when it wrote the unit SKUs.
6. The toy-inventory-logger skill reads and clears the Products tab (`Products!B2:B`) in place of Items.

## The sheet

`setup()` in `Code.gs` creates eleven tabs and formats the text columns as plain text, so a Product ID such as `0012`, a phone number such as `+63917...` or a note starting with `=` is stored as typed. It is safe to run again and never deletes data. After pasting a newer `Code.gs`, run it once more so new tabs and columns exist, then publish a new version of the existing deployment. It also writes the `On hand` numbers, writes Browse, puts the Field dropdown on Edits, and sets a warning-only protection on Products, Movements, Customers, Supplier orders, Pre-orders, Invoices, Invoice lines and Returns with the description "Used by the app. Sort and filter in the Browse tab; change fields in the Edits tab." A warning-only protection still lets the owner edit; Google Sheets asks first. Inbox, Browse and Edits have no protection.

`setup()` also upgrades a 2.3 sheet in place, and is safe to run again. It renames the Items tab to Products when there is no Products tab, deletes the `Category` and `Reorder at` columns of Products by their header names when present, writes the current header row on every tab (`SKU` becomes `Product ID` and `Item` becomes `Product`), fills `SKU` on the `In` rows of Movements that lack one, in sheet order, by the rule under "Movements and FIFO", and makes Browse again when its header is not the current one. When it filled any unit SKU it raises `moveRev`, so each phone downloads the movements again.

`wipeAllData()` starts again from an empty sheet. It is run by hand from the script editor, after every phone has synced with nothing waiting, and takes the script lock so a phone syncing at that moment waits. It first saves a copy of the whole spreadsheet named "Bodega backup" and the date (`Bodega backup 2026-11-17`). It then clears every row under the header on Products, Movements, Customers, Supplier orders, Pre-orders, Invoices, Invoice lines, Returns and Edits, deletes the Browse tab, and raises `moveRev`, so each phone drops its movements at its next sync. Invoice numbers restart at 1, because the next number is worked out from the invoices on file. The connection key, the other tabs, their formatting and protections, and the Inbox stay. Browse is deleted rather than cleared because the script owns it: the next write (or `setup()`) makes it again with the current header and text columns, and no filter or format from an older layout is left on it. The app needs no reset button; each phone picks up the empty sheet at its next sync.

`reopenInbox()`, also run by hand and optional, clears `Status` on the Inbox rows marked `Done`, so the rows Claude already researched come back for review and can be applied again with their costs. Only the `Done` cells are cleared; `Dismissed` and `Working` stay.

**Products** (one row per product): `Product ID`, `Name`, `Price`, `Active` (`Yes` or `No`), `On hand`, `Manufacturer`, `Brand`, `Toy line` (labelled Product line in the app), `Character`, `Release date`, `Release check`. The Product ID (`T0001` and so on) is the key of the row and is never shown in the app; Category and Reorder at no longer exist. `On hand` is a plain number that the script writes: after every `add` request that changed movements or products, it works out stock for every product from Movements and writes column E in one call, matched to the Product ID in each row at that moment. Reading ignores column E. `Release date` is a best guess stored as text (`2024`, `2024-07` or `2024-07-15`); `Release check` holds `Verify` while that guess still needs checking. A variant (chase, exclusive colour, reissue) is its own row with its own name and Product ID. Archiving sets `Active` to `No`; rows are never deleted. When a Product ID appears on more than one row, the first row is used and every `sync` and `add` reply carries a warning about it.

**Movements** (the log of stock): `ID`, `Date` (`YYYY-MM-DD`, text), `Product ID`, `Product` (the name at the time, for readability), `Direction` (`In` or `Out`), `Qty` (positive whole number), `Reason`, `Ref`, `Note`, `Unit cost`, `SKU`. Every `In` movement the app or the script writes has `Qty` 1 and that unit's cost, so a stock in of four units writes four rows; an `In` with `Qty` above 1 is still read as that many units sharing its cost. An `Out` is one row with the full quantity. `SKU` (column K) is the unit SKU, `<Product ID>-<n>`, which the script writes on every `In` row it appends; an `Out` row leaves it blank, and so does an `In` with `Qty` above 1 typed by hand, whose units show without one. Stock is replayed from this log first in, first out (see "Movements and FIFO"). Movements are only appended, apart from `Unit cost` on an `In` row, which a `cost` entry rewrites while a unit of that row is on hand. A mistake is fixed by a reversing entry.

Reasons and the direction each allows (enforced by the app and by `Code.gs`):

| Reason | Direction | Used for |
| --- | --- | --- |
| Opening, Restock, Return | In only | First stock, deliveries, customer returns |
| Sale, Damaged, Lost | Out only | Sales, write-offs |
| Count, Correction, Other | Either | Photo counts and stock-takes, reversals, anything else |

`Ref` links a movement to what caused it: the movement a `Correction` reverses, the invoice number of a `Sale`, the supplier order ID of the `Restock` that received it, or the return ID of a `Return`. `Unit cost` on an `In` is the cost of that unit (blank when not known yet). On a `Sale` it is the cost of the units the line took, fixed when the invoice was issued.

**Customers**: `ID`, `Name`, `Contact` (phone or Messenger). Pre-orders and invoices point here by ID and also keep the name and contact as they were at the time.

**Supplier orders** (stock ordered and paid for, not yet received): `ID`, `Date`, `Product ID`, `Product`, `Qty`, `Expected`, `Status` (`Ordered`, `Received`, `Cancelled`), `Received qty`, `Received on`, `Note`.

**Pre-orders** (customer has paid, product not yet in stock): `ID`, `Date`, `Customer ID`, `Customer`, `Contact`, `Product ID`, `Product`, `Qty`, `Price`, `Paid`, `Balance`, `Status` (`Open`, `Fulfilled`, `Cancelled`), `Kept`, `Receipt no`, `Invoice no`, `Note`. `Balance` is zero when paid in full. On a cancelled pre-order `Kept` holds the deposit the shop kept, and 0 means a full refund.

**Invoices**: `No`, `ID`, `Date`, `Type` (`Sale` or `Pre-order receipt`), `Customer ID`, `Customer`, `Contact`, `Total`, `Shipping` (blank or `Delivered`), `Pre-order ID`. Sale invoices and pre-order receipts share one plain sequential number series.

**Invoice lines** (append-only): `Invoice no`, `Invoice ID`, `Product ID`, `Product`, `Qty`, `Listed price`, `Charged price`, `Unit cost`.

**Returns** (append-only, one row per returned product): `ID`, `Date`, `Invoice no`, `Invoice ID`, `Customer`, `Product ID`, `Product`, `Qty`, `Outcome` (`Restock`, `Write-off`), `Refund`, `Note`.

**Inbox** (rows Claude writes after reading photos): `Added`, `Type` (`Count` or `Receive`), `Name`, `Qty`, `Cost each`, `Manufacturer`, `Brand`, `Toy line`, `Character`, `Release date`, `Verify`, `Note`, `Status`. Every column is plain text. Claude appends rows here through the Google Sheets connector, using the toy-inventory-logger skill, after reading photos of boxes, shelves or supplier paperwork. This is the one data tab the app does not write first, and nothing in it counts as stock. `Cost each` is a starting value for every unit the row adds; the owner can overwrite it with the landed cost in Correct this row. A row is waiting when `Name` is filled and `Status` is blank; a row with any `Status` is not sent to the app. The statuses are `Working` (an intake run may set it while it still researches a row, and clears it when the row is ready), `Done` (the app recorded the row) and `Dismissed` (the owner dismissed it). The app sets `Done` only on rows it actually recorded. A `Type` starting with R reads as `Receive`; any other value reads as `Count`.

**Browse** (for the owner; the app never reads it): `Product ID`, `Name`, `Price`, `Active`, `On hand`, `Incoming`, `Owed`, `Left to promise`, `Units on hand`, `Stock value at cost`, `Units without cost`, `Manufacturer`, `Brand`, `Product line`, `Character`, `Release date`, `Release check`. One row per product, plain values, frozen header. The script owns it: at the end of every `sync` and every `add` it clears everything below the header and writes the tab again in one call, in Products order. The numbers use the app's definitions (see "The four numbers per product" and "Movements and FIFO"). `Units on hand` lists each unit on hand, oldest first, as its SKU and cost, with `?` for a unit without a cost (`T0012-2 1200, T0012-3 ?`); a unit without a SKU shows its cost alone. `Stock value at cost` is the sum of the known costs of those units, and `Units without cost` counts the rest; all three are blank when no unit is on hand. A basic filter on the tab stays in place. A sort is not kept: the next rewrite puts the rows back in Products order. `setup()` creates the tab, and the first write creates it when it is missing.

**Edits** (product changes typed in the sheet): `Product ID`, `Field`, `New value`, `Status`, `Note`. `Field` has a dropdown with Name, Price, Active, Manufacturer, Brand, Product line, Character, Release date and Release check. At the start of every `sync` and `add`, under the script lock, each row with a Product ID or field and an empty `Status` is applied as an `edit` entry through the same code and checks, before the app's own entries. The script then writes `Status` `Done`, or `Refused` with the reason in `Note`. `Active` takes Yes or No, `Release check` takes Verify or blank, and a blank `Price` clears it. A refused row is not tried again until its `Status` is cleared. The change reaches each phone at its next sync, because the phone reads Products. A cost cannot be changed here.

## How the script writes

The owner may sort, filter or edit any tab while a phone syncs; the script lock only keeps two requests apart. So no write trusts a row number the script read earlier.

1. An `add` (or a `sync` with rows waiting in Edits) first plans every entry in memory, reading each tab once. Each record it changes remembers which entries changed it.
2. Before writing, the script reads the key column of every tab it changes in place: Product ID for Products (without regard to case), the ID for Customers, Supplier orders, Pre-orders and Invoices (column B on Invoices), and the ID in column A for Movements when a `cost` entry changes a row there. Invoice lines and Returns are only ever appended, and so is Movements apart from that one cell. A record whose key is now missing, or appears more than once, is not written, and every entry in the request that changed it fails with `The <tab> tab was changed in Google Sheets (<key> not found)` or `(<key> appears twice)`, followed by `Nothing was written for this entry; fix the tab and sync again.` The plan is then made again without those entries, so nothing they would have written (an invoice, a movement, a pre-order change) is written anywhere. The app keeps a refused entry and lists it under Activity.
3. Rows changed in place are written first. Just before each write the script reads the key cell of the row it expects; if the key is not there it reads the key column again. Each row is written whole, in one call; on Movements only column J is written. Each Movements cell written raises `moveRev` (see "Sync protocol"). If the key has gone at this point, that entry fails the same way and its new rows are left out.
4. New rows are added after the last used row of the key column, worked out at that moment.
5. `On hand` is written for every product (see Products), then the Inbox marks, then the Edits statuses, then Browse.

Results for entries are final only after the writes. Inbox marks find a row by its row number and its name, `Added`, `Type` and `Qty`, which the app sends as it received them; when the row has moved, they fall back to the one row with that name, `Added`, `Type` and `Qty`. A mark that finds no row, or finds a row that already has a `Status`, changes nothing and does not fail the entry, so a row edited in the sheet keeps waiting. Edits statuses are found again the same way, by row number, SKU, field and value.

## Documents and what they do to stock

A document never changes stock directly. `Code.gs` writes ordinary movements for it in the same request, so the Movements tab stays the single source of stock.

| Action | Rows written | Stock movement |
| --- | --- | --- |
| Supplier order saved | Supplier orders (`Ordered`) | None. Counts as incoming. |
| Supplier order received | Status `Received` | One `In` / `Restock` per unit, IDs `rcv-<orderId>-1` ... `-N`, `Ref` = order ID, each with the cost typed for that unit (blank allowed) |
| Supplier order cancelled | Status `Cancelled` | None |
| Pre-order saved | Pre-orders (`Open`) + Invoices (`Pre-order receipt`) + one line | None. Counts as owed. |
| Payment added to a pre-order | `Paid`, `Balance` | None |
| Pre-order cancelled | Status `Cancelled`, and `Kept` with the deposit kept (typed each time; 0 is a full refund) | None |
| Sale invoice issued (Sales > New sale) | Invoices (`Sale`) + lines; a linked pre-order becomes `Fulfilled`, and the app first marks any balance on it as paid, because payment comes before the invoice | `Out` / `Sale` per line, `Ref` = invoice number, `Unit cost` = the line's cost |
| Marked delivered (or unmarked) | `Shipping` set to `Delivered` or blank | None |
| Return recorded | Returns | `Restock`: one `In` / `Return` per unit, IDs `ret-<retId>-1` ... `-N`, `Ref` = return ID, note `Invoice <no>`, at the `Unit cost` of the first line of that product on the invoice. `Write-off`: none. See `RETURN_STOCK_`. |
| Inbox rows applied or dismissed | `Status` on the Inbox rows: `Done` on the rows that were recorded, `Dismissed` on every row shown when the owner dismisses | None from the marking; applying also queues the normal entries, which write their own movements |

A return cannot exceed what the invoice sold of that product, less what was already returned. The stock effect of each outcome lives in one table, `RETURN_STOCK_` in `Code.gs` and `RETURN_STOCK` in `index.html`; change both together.

### The four numbers per product

`on hand` = stock (units on hand less any deficit; see below). `incoming` = quantities on supplier orders still `Ordered`. `owed` = quantities on `Open` pre-orders. `left to promise` = on hand + incoming − owed; a negative number means more has been promised than supply covers. The product sheet shows that sentence as a muted line under the four numbers, and the Left to promise header of the stock table carries it as a hover hint (`LTP_TEXT`). Pre-orders are not tied to particular supplier shipments. A pre-order counts as ready to ship when the stock on hand covers it, oldest pre-order first. Home lists it as a job ("Ship Ana Reyes's pre-order"), and Orders lists it with the customer's contact.

`free to sell` = max(on hand, 0) − owed. Incoming stock does not count. The New sale form uses this number to decide whether it makes an invoice or saves a pre-order (see "The New sale form" below).

### Movements and FIFO

A Product ID is the identifier of a product, a model that can have many units (it is called `sku` in the code and the sync payload, so the protocol does not change). Each unit has a SKU of its own, `<Product ID>-<n>` (for example `T0012-3`), where n counts the units of that product ever received, in movement-log order, from 1, and is never reused. The SKU is a label only: sales still take the oldest unit first. `unit_()` in `Code.gs` and `live()` in `index.html` apply the same rule: an `In` that already has a SKU keeps it and moves the counter to at least its number; an `In` of `Qty` 1 without one takes the next number; an `In` of `Qty` above 1 without one advances the counter by its quantity and gets none; an `Out` has none. A pending unit not yet synced shows a provisional SKU by the same rule. Each unit on hand is tracked through the `In` movement that brought it in, and that movement holds the unit's cost and SKU. Cost means landed cost, worked out by the owner and typed as one number per unit; the app does not allocate shipping or fees.

`stockOf_()` in `Code.gs` and `fifo()` in `index.html` replay the log the same way. Change both together. Per Product ID, movements are taken in sheet order (in the app: synced movements, then pending ones in queue order); movement dates are not used. Each Product ID has a queue of units on hand, oldest first (one entry per unit, carrying its movement's ID, cost and SKU), and a deficit that starts at zero.

- An `In` of `Qty` q first covers the deficit (those units are consumed), then puts the rest at the back of the queue.
- An `Out` of `Qty` q removes units from the front of the queue. A `Correction` whose `Ref` is the ID of an `In` first removes that movement's own units while they are on hand, then takes the rest from the front.
- What the queue cannot supply is added to the deficit. Stock is units on hand less the deficit, and one of the two is always zero, so stock below zero means a deficit that the next units to arrive cover first.

The cost of a sale line is the sum of the costs of the units the line removes, divided by its quantity and rounded to two decimals. It is blank when any of those units has no cost, or when the line takes stock below zero. The app works it out from `live()` when the invoice is issued (`costOut()`) and sends it as `lines[].cost`; the script writes it unchanged on the invoice line and the `Sale` movement. Nothing rewrites it later, so a cost typed afterwards changes only units still on hand and never an issued invoice. The invoice screen shows margin as total minus cost ("Margin ₱X"), or "Margin unknown: a product has no cost" when a line has none. Margin is not drawn on the image.

A count that lowers stock and a write-off remove the oldest units, like a sale. Reversing an `In` in Activity writes one `Out` `Correction` with `Ref` = that movement's ID, which takes that receipt's unit back out. Reversing an `Out` writes one `In` `Correction` per unit with `Ref` = the `Out`'s ID and its `Unit cost`, so the units come back at the cost they left with.

A cost is changed with a `cost` entry (see "Sync protocol"). The script refuses it when the movement is unknown, is not an `In`, or has no unit left on hand after replaying every movement, including those written earlier in the same request: `That unit has already left stock, so its cost can no longer be changed.`

### Invoice image

The invoice and the pre-order receipt export as PNG. PNG keeps text sharp, and the image is sent through Facebook Messenger, which compresses whatever it receives. The image is made on the device and never stored: it is redrawn from the invoice record each time, so it can be produced offline and on any device that has synced. The text in it cannot be selected. Shop name, contact details, footer line and logo are typed in Settings > Invoice image and kept on the device (`prefs.shop`), so each device that issues invoices needs them entered once.

`drawDoc()` draws the document on canvases 595 pt wide at scale 2, so each image is 1190 px wide. Its height is cropped to the content: header, lines, totals, then the footer line directly under the totals. An image is at most 1024 pt (2048 px) tall. A line that would not fit starts the next image, which repeats the column header; the last line takes the totals and footer with it. When there are several images, each carries "Page i of N" at its foot. `drawDoc()` is synchronous so the number of images is known during the tap: the logo has a fixed 150 × 56 pt box at the top left, and `docPngs()` draws it in afterwards. `prepImg()` starts making the PNGs when the invoice sheet opens, so the tap itself has nothing to wait for.

The invoice sheet has **Save image**. For a one-image document it opens a blank tab during the tap, so popup blocking does not apply, then points it at the PNG; when no tab opens, the file downloads instead. For a document with several images, every image downloads and no tab opens. File names are `Invoice-12.png` and `Receipt-12.png`, with `-1`, `-2` and so on added when there are several images (`imgName()`). **Copy image** sits beside it on phone and desktop when the browser can write images to the clipboard (`canCopyImg`) and the document is one image; it copies the PNG and says "Copied. Paste it into the chat." See `saveImg()` and `copyImg()`.

## Sync protocol

All calls are `POST` to the Apps Script `/exec` URL with a `text/plain` JSON body `{ key, action, ...payload }` (plain text avoids a CORS preflight). Responses are `{ ok, data }` or `{ ok: false, error, auth }`. The connection code the owner pastes is `<exec URL>#<key>`; `showKey()` in the script editor prints the key.

| Action | Payload | Returns |
| --- | --- | --- |
| `ping` | none | `{ version }`, used by Settings to test the code |
| `sync` | `have: { rows, lastId, moveRev }` | `{ items, moves, rows, lastId, reset, moveRev, syncedAt, custs, orders, pres, invs, rets, inbox, warnings }` |
| `add` | `entries`, `have` | `{ results: [{ id, ok, error, sku?, from?, no?, fromNo? }], sync, warnings }` |

`warnings` is a list of plain sentences about problems the script found in the tabs, for example `Items: SKU T0013 appears on 2 rows. The first is used.` The app shows them on Home as a banner under the two buttons, in the danger colour, and replaces them at every sync; the banner is absent when the list is missing or empty. Results for rows of the Edits tab are never sent to the app.

Products, documents and the waiting `inbox` rows are always sent whole (a shop has hundreds of them). Each `inbox` row carries its sheet row number (`row`), `type` (`count` or `receive`) and the cell values as text. Movements are incremental: the app says how many movement rows it holds, the ID of the last one and the `moveRev` it holds. If `moveRev` is the script's and the sheet still has that ID at that row, only later rows come back; otherwise everything comes back with `reset: true` and the app replaces its copy. Deleting or moving movement rows in the sheet therefore heals itself at the next sync. `moveRev` is a number in Script Properties. The script raises it for each Movements cell a `cost` entry writes and in `wipeAllData()`, because an incremental pull would miss a changed row, and it compares it strictly: an app that sends no `have.moveRev` gets every movement. The app keeps the value in `meta`.

`add` entries are applied in order and each is idempotent, so a retry after a lost response changes nothing: a product by SKU and name, everything else by its own ID, and a status change or a cost by carrying the final value.

| `kind` | Payload | Effect |
| --- | --- | --- |
| `item` | `item`, `auto` | New product |
| `edit` | `sku`, `patch` | Change a product's fields |
| `move` | `move { id, date, sku, dir, qty, reason, ref, note, cost }` | One movement (the script adds the unit `SKU` of an `In`; moves in the payload carry it as `unit`). The app sends an `In` of N units as N entries with IDs `<id>-1` ... `<id>-N`, each `Qty` 1 with that unit's cost. |
| `cust` | `cust { id, name, contact }` | New customer, or new details for one |
| `order` | `order { id, date, sku, qty, expected, note }` | Supplier order |
| `receive` | `orderId, date, qty, costs` | Receive a supplier order. `costs` has one value per unit, a number of zero or more or null for blank; the script writes `rcv-<orderId>-1` ... `-N`. |
| `orderCancel` | `orderId` | Cancel a supplier order |
| `pre` | `pre { id, date, custId, sku, qty, price, paid, note, invId, no }` | Pre-order and its receipt |
| `prePay` | `preId, paid` | New total paid on an open pre-order |
| `preCancel` | `preId, kept` | Cancel a pre-order; `kept` is the deposit kept, 0 is a full refund |
| `invoice` | `invoice { id, no, date, custId, lines: [{ sku, qty, price, cost }], preId }` | Sale invoice and its stock-out; `cost` is the line's FIFO cost at issue |
| `ship` | `invId, ship` (`'Delivered'` or `''`) | Delivered mark on a sale invoice |
| `ret` | `ret { id, date, invId, sku, qty, outcome, refund, note }` | Return (`outcome` is `Restock` or `Write-off`); Restock writes one `In` per unit, `ret-<id>-1` ... |
| `cost` | `moveId, cost` (a number of zero or more, or null to clear it) | `Unit cost` (column J) of an `In` movement with a unit still on hand, found by its ID at write time; raises `moveRev` |
| `inboxDone` | `rows: [{ row, name, added, type, qty }], mark: 'Done' or 'Dismissed'` | Sets `Status` on Inbox rows that still have a blank `Status`, found as described in "How the script writes" |

The app queues a `cost` entry in place of a pending one for the same movement, so the last value typed wins. `live()` applies pending `cost` entries to its copy of the movements before the replay, so a typed cost shows at once while offline.

### Product ID collisions

Auto-generated Product IDs are `T0001`, `T0002`, and so on, picked by the phone from its own list. Two phones that work offline can pick the same next Product ID for different products. Product entries made with a generated Product ID carry `auto: true`. When the sheet finds a different product on that Product ID, it assigns the next free one, applies the rest of the batch (movements and documents alike) to the new Product ID, and returns `{ sku, from }`; the app then renumbers whatever is still in its queue. If the name already exists under another Product ID the entry is treated as the same product, which makes a retry of a renumbered batch safe.

A refused product (for example a name already used by another Product ID) blocks every later entry for that Product ID in the same batch, and the app fails any queued entries for it, so a movement or document can never be credited to a different product that owns the Product ID. Refused entries stay in the queue, listed in Activity with the reason and counted on Home under "Needs you"; deleting a refused product also deletes the entries waiting on it.

### Invoice numbers

The phone picks the next number (highest it knows plus one), so invoices can be issued offline. One phone issues invoices, so the numbers carry no device prefix. If the sheet already holds that number on a different document, it assigns the next free one and returns `{ no, fromNo }`; the app says so, because an image already sent carries the old number and should be sent again.

## Tabs and routes

The phone has four tabs in a bottom bar: **Home**, **Inventory**, **Sales** and **Orders**. Three routes have no tab: `import` (titled Update inventory), `move` (Stock in and out, one product by hand) and `activity` (the movement log, where a movement can be reversed). While one of them shows, the tab it belongs to stays lit (Home for Update inventory, Inventory for the other two), and the header carries a close button in place of Settings that returns to the last tabbed page. Update inventory opens from the Home button and from the Home row about rows from Claude. Stock in and out opens from a product's sheet and from Update inventory. Activity opens from the Activity link on Inventory, from "See all in Activity" on a product's sheet and from the Home row about refused entries.

Tapping **Sales** opens the invoice list, with a **New sale** button at the top. When the New sale form has a product picked (a draft in progress), tapping Sales opens the form instead. The form's close button clears the draft and returns to the list.

In a window 900 px wide or more the same page uses a desktop layout, and the phone layout stays as it is. The tabs move to a side bar on the left, which lists Home, Inventory, Sales, Orders, Update inventory (with the number of waiting Inbox rows, for example "Update inventory · 3") and Activity. The current page is drawn in the text colour. Pages may be up to 1600 px wide (Home 1160 px, Stock in and out 760 px), and Inventory has no width limit. Lists become tables built by `table()`, which share one style: Inventory, the invoice list under the full-width New sale form, pre-orders and supplier orders one under the other on Orders, Activity, and each group of an Update inventory review. The style is compact: 13 px text, rows of about 30 px with just enough padding to read, and `table-layout: fixed` with a fixed width per column kind (short text, name, date, number, money; `tableTag()`), so widths never change with the filter, the sort or the rows shown. Long text is cut with an ellipsis and carries the full value as a `title`, and numbers are right-aligned. Sort and filter live in the header cells: clicking the header text sorts by that column and clicking again reverses it (text alphabetically without regard to case, numbers numerically, release dates chronologically, with a year-only or year-month value at the start of its period; blank values sort last in both directions), and a small filter button in a filterable header opens a popover. A sort or a filter redraws only the table body (`redrawTable()`): no page render, no flicker, no change of width, and the popover stays open while ticking. A table scrolls sideways inside its own box when the window is narrower than its columns, and its header row stays in view while it scrolls down. Clicking a row opens its sheet (Correct this row in a review); rows can be reached with Tab and opened with Enter. No cell is editable in a table. Only the Inventory table has column filters (see "Inventory and the product sheet"), and the Update inventory review has an editable Cost cell (see "Importing"). Home shows the numbers and the two buttons beside "Needs you". Sheets open as centred dialogs. `wide()` reads the media query, `render()` runs again when the window crosses the breakpoint, and the rest is CSS in the `min-width:900px` block. Sort and filter choices (`ui.sort`, `ui.tf`) are kept in memory while the app is open and survive a re-render after a sync, and `keepScroll()` keeps each table's scroll position. At this width the side bar can be folded to icons only with the toggle at its top (`navMini`, kept in `prefs` on the device); each icon carries its label as a tooltip, and badges such as the number of waiting Inbox rows still show. Nothing else differs between phone and desktop: the data, queue and sync are the same code.

The header shows the page title. On Home it shows the shop name from Settings when one is set, and the app name otherwise. On the right are the sync status as plain text (a button that syncs now; attention colour while entries wait, danger colour when entries were refused or the last sync failed) and the Settings button.

### Home

`renderHome()` draws, from the top on a phone:

1. The numbers strip, titled "<Month> so far", with three cells: Today, Month and Margin, in whole pesos. Margin leaves out invoice lines with no cost on file. It shows "–" when no line sold this month has a cost and carries an asterisk when only some do. Tapping the strip opens the invoice list. One muted line follows only when there is something to say: what the asterisk means, that no product sold has a cost, or the refunds this month.
2. Two buttons: **New sale** and **Update inventory** (which reads "Update inventory · N" when N Inbox rows wait). With no active products, New sale is left out and Update inventory becomes the primary button.
3. **Needs you**: one list of jobs in a fixed order, built by `needsRows()`. The badge on the title counts the rows. Each row is phrased as an action and opens the place to do it:
   1. Fix N entries the sheet refused (Activity).
   2. Ship <Customer>'s pre-order, one row per customer, oldest first, with the product, quantity and any balance (opens New sale filled from that pre-order). A customer with two ready pre-orders gets one row for the oldest, which says how many more are ready. When four or more pre-orders are ready, a single row "Ship N pre-orders now in stock" opens the pre-order list instead.
   3. Review N rows from Claude (Update inventory).
   4. Order stock for N products promised beyond supply (Inventory, filtered).
   5. Receive N supplier orders due, with the first two product names (Orders, supplier list).
   6. Collect ₱X on N pre-orders (Orders, pre-order list).
   7. Price N products (Inventory, no price yet).
   8. Add the cost of N units, where N counts the units on hand without a cost across active products (Inventory, no cost yet).
   9. Check N release dates (Inventory, release date to verify).

   The rows that open Inventory set its filter and clear the search and the table's column filters, so the list shows exactly what the row counted. On a phone a list of more than five rows shows the first four and a line "See N more", which then reads "See less". The expanded state is `ui.homeMore`, kept in memory only: it survives a re-render after a sync and resets when Home is entered from the tab bar. A desktop window shows every row. With nothing to do the section says "Nothing needs you." and has no badge.

With no products and no Inbox rows, Home shows a first-run screen with **Add a product** and **Update inventory**.

### Inventory and the product sheet

Inventory has a search box (name, brand or character), the filters All, Out and Archived, and the filters that Home rows open ("Promised beyond supply", "No price yet", "No cost yet", "Release date to verify"), which show as "Showing only: ..." with "Show all". "No cost yet" lists products with a unit on hand that has no cost. It lists products only: no Product ID or SKU column, and no page lists all units. In the desktop layout it is a table of Name, Manufacturer, Brand, Product line, Character, Release date, Price, On hand, Incoming, Owed, Left to promise, Unit cost and Stock cost, at most 400 rows. Unit cost shows one value when every unit on hand has the same cost, a range such as "1,200 to 1,500" when they differ, and a dash when no unit has a cost; it sorts by its lowest value. Stock cost is the sum of the known costs of the units on hand. Manufacturer, Brand, Product line and Character have a filter button in their header (`openTf()`). Its popover lists every value in use with a tickbox each, with "All" and "None" shortcuts, and nothing ticked means no filter. Release date has a from and a to field in its popover that accept `2024`, `2024-07` or `2024-07-15`. The column filters (`ui.tf`) combine with the search box and the filters above the table.

The product sheet shows the four numbers, the Left to promise sentence, Sell, Order stock, Stock in, Stock out and Edit details, then a section **Units on hand**: one row per unit, oldest first, with its SKU (for example `T0012-3`), the date it came in, its reason (Opening, Restock, Count, Return and so on) and an editable cost field. A unit still waiting to sync shows a provisional SKU by the same rule as the sheet. The first row is marked "Next to leave". A changed field queues a `cost` entry when it loses focus (`setUnitCost()`). A line under the list gives the cost of stock on hand and, when it applies, "2 units have no cost yet". When stock is below zero the section says "Below zero by N. Units that arrive next cover this first."

### Cost fields

Every screen that takes stock in shows one cost field per unit, labelled "Unit 1 cost", "Unit 2 cost" and so on (`costFields()`): Stock in on the Move screen, Starting stock on a new product, receiving a supplier order, and Correct this row. Typing in the first field fills every field that has not been typed in yet. A cost may be left blank and filled later on the product sheet. For more than 12 units the screen shows one "Cost each" field and a text button "Different costs per unit" that opens one field per unit.

### The New sale form

Sales and pre-orders share one form, `renderInvForm()`, whose state is `ui.inv`: customer, contact, date, lines, `preId`, `paid` ('' means paid in full), `note` and `force` ('' or 'sale').

The form decides its mode in `invInfo()`. Opened from a pre-order (`preId` set), it is a sale. Otherwise, with `force === 'sale'` it is a sale. Otherwise, when any picked line asks for more than is free to sell, it saves a pre-order; else it is a sale.

- **Sale**: a customer name is required and the contact is optional. Several products can go on one invoice ("Add another product"), each on its own line: issuing refuses a second line of the same product with a toast. The button reads "Issue invoice no. N", and a muted line under it says what the tap does. Issuing takes the products out of stock with no confirmation, even below zero, and opens the invoice. When `force === 'sale'` and a line is short, one muted line says so ("Only 1 on hand. Stock will go below zero.", or that the units are owed to earlier pre-orders) with a text button "Save as a pre-order" that clears `force`. When a line will remove a unit that has no cost, a muted line under it says "1 unit of this product has no cost yet, so the margin on this sale will stay unknown." with a text button "Add the cost" that opens the product sheet.
- **Pre-order**: a bordered notice under the product explains why ("Not in stock, so this is saved as a pre-order", "The 2 on hand are owed to earlier pre-orders, so this is saved as a pre-order", or "Only 1 is free to sell, so this is saved as a pre-order") and offers "It is here, sell it now", which sets `force`. The form adds "Paid now", makes the contact required, shows the total and the balance when it arrives, and its button reads "Save pre-order · receipt no. N". Saving queues the same `cust` and `pre` entries as before, clears the form and opens the receipt. A pre-order holds one product, so "Add another product" is hidden; a form that already has several products with one short shows the notice for that product and refuses to save with a toast until the other products are removed or the product is sold now.

Changing or clearing a picked product resets `force`. On a phone the date (and the note, for a pre-order) sits behind one folded line, "Dated today". Typing a quantity that changes the mode, or the notices a line needs, redraws the form and keeps the cursor in the field (`invSig()`).

In the desktop layout the form takes the full width. Customer, Phone or Messenger and Date sit in one row at the top, joined by Paid now and Note in pre-order mode. The lines are rows of a table: Product (the picker), a muted stock hint, Quantity, Price each, Amount and a remove button. A pre-order notice, a below-zero notice or the no-cost line spans the full width directly under the line it refers to. The total and the issue button sit at the right under the lines. The invoice list is a table under the form, with its search box: No, Date, Customer, Products, Total, Margin, Delivered.

The `fulfil` action (a ready row on Home, or "Issue invoice" on a pre-order's sheet) fills the form with `preId`. Issuing first marks any balance as paid.

### Update inventory

The `import` route (`renderImport()`). With Inbox rows waiting it shows them for review (see "Importing"). With none waiting it shows one line on sending Claude photos, then a list of other ways to change stock: "Receive a supplier order (N on the way)" when orders are on the way, "One product by hand" (the Move screen with a picker) and "Add a new product", then the folded "Paste a block by hand" section. That section is open by default while no connection code is set. When a sync raises the number of waiting Inbox rows and Update inventory is not on screen, a toast says "N rows from Claude to review".

### Theme

Settings > Preferences > Theme offers Device, Light and Dark, stored as `prefs.theme` (`auto`, `light` or `dark`; default `auto`) on the device. There is no theme control in the header. The colour tokens are CSS custom properties: light in `:root`, dark under `@media (prefers-color-scheme: dark)` for `:root:not([data-theme="light"])` and again for `:root[data-theme="dark"]`, each with a matching `color-scheme`. An explicit choice sets `data-theme` on `<html>`; Device removes it. The head script applies the stored choice before the first paint, and `applyTheme()` does the same when the setting changes. Both theme-color metas follow the choice. The invoice image is drawn with literal colours on white, so its bytes are the same in either theme.

### Look

Every rule uses the tokens (`--bg`, `--text`, `--muted`, `--line`, `--field`, `--raise`, `--raise-edge`, `--accent`, `--accent-edge`, `--on-accent`, `--attn`, `--danger`). Yellow (`--accent`) marks only what to act on: the primary button, the badges and counts that need action. Bebas Neue is used for page and sheet titles and for the numbers that are the point of an element; Geist for everything else, at 13, 15 and 16 px, weights 400 to 600. Corners are square. A button has a solid lower layer (`box-shadow: 0 4px 0` of its edge colour) that shrinks when pressed; minor actions are underlined text buttons, and destructive ones are text buttons in the danger colour. Sections (`sec()`) are hairline boxes with the title on the top rule; lists are rows (`row()`) with a title, one muted line, and a chevron or one number on the right, and desktop tables (`table()`) use the same hairline rows. Filters and switches are text tabs underlined when chosen. Icons are inline stroke SVGs (`ICON`). Inputs use 16 px text so iOS does not zoom when one is focused.

## Local state (`localStorage`, prefix `toys.`)

| Key | Contents |
| --- | --- |
| `cfg` | `{ url, key }` |
| `items` | Products as of the last sync |
| `moves` | Movements as of the last sync, in sheet order |
| `docs` | `{ custs, orders, pres, invs, rets, inbox }` as of the last sync |
| `meta` | `{ rows, lastId, syncedAt, moveRev }` for the incremental pull |
| `queue` | Entries not yet confirmed by the sheet; `status` is `pending` or `failed` |
| `prefs` | Current tab (default `home`), currency symbol, `navMini` (the side bar is folded to icons), `theme` (`auto`, `light` or `dark`), and `shop` (name, contact, footer, logo) for the invoice image and the Home header |

Everything the owner does is written to the queue first and flushed when a connection exists. Without a connection the app works fully on the device; the queue holds everything until the connection code is pasted. `live()` merges synced data with pending entries (failed entries are not counted) and is the only thing the screens read. Inbox rows that have a pending `inboxDone` entry drop out of `live().inbox` at once. It replays pending documents the way `Code.gs` will apply them, including the movements they write with the same IDs (a received order's `rcv-<orderId>-N` and a return's `ret-<retId>-N`), so an invoice issued offline already counts against stock. Settings > Connection > Re-download everything clears `meta`, so the next sync sends every movement. The script writes the data tabs only for the app's entries and for rows in Edits; Claude writes the Inbox rows.

## Stock math

`stockOf(sku)` is the stock from the FIFO replay of synced movements plus pending ones (see "Movements and FIFO"). Negative stock is allowed and shown in the danger colour: recording a sale for something that was never counted in should not be blocked at the till. The New sale form saves a pre-order when a line asks for more than is free to sell; "It is here, sell it now" issues the invoice anyway, with no confirmation, and stock goes below zero. A stock out by hand for more than is on hand still asks for confirmation. There is no low-stock state: a product is flagged only at zero (`out`) or below zero (`neg`), since one unit on hand is normal for collectibles. Category and Reorder at no longer exist anywhere: the app, the sheet, Browse and the Edits dropdown dropped them in 2.4.0.

## Importing

There are two ways in, and both end in the same preview. Nothing is written before the preview is applied. The app has no lookup service: the assistant identifies the product, looks up its details and writes the rows.

**Inbox (the main path).** Claude appends rows to the Inbox tab after reading photos of boxes, shelves or supplier paperwork. The photos reach Claude either attached in chat or uploaded to a Google Drive folder that the skill checks; that part lives in the skill and is outside this repo. Every sync returns the waiting rows as `inbox`. Update inventory shows them at once in the review, one `Type` at a time (the type of the first waiting row, then the next type after those are handled). `Count` rows go through the Count from photo rules and `Receive` rows through the Receive rules below. The review is kept in memory with a key made of the type and the full content of the waiting rows, so a row edited in the sheet after it was loaded shows as it is now after the next sync. Corrections, ticks and "Use" choices stay for rows whose content did not change. Apply queues the normal entries plus one `inboxDone` entry with `mark: 'Done'` for the rows that were recorded: ticked rows that could be recorded, including a count that already matched stock. Rows that were unticked, rows that need a name, problems and rows with an unknown count stay in the Inbox and come back in the next review. "Dismiss these rows" queues `inboxDone` with `mark: 'Dismissed'` for every row shown and records nothing. When no waiting rows are left after Apply, the app goes to Stock.

**The review groups** (`impGroup()`), in this order, each a section titled with its row count:

- **Check these** (open, and foldable like Needs a name): a similar name is on file ("Looks like ..." with a "Use ..." button, unticked), the same new name on more than one Inbox row (shown as "Possibly the same box in two photos" with the total and each source row and count; the rows are summed), a release date marked to verify, a movement that would take stock below zero, or a likely duplicate movement.
- **Ready**: everything else that will be recorded. With more than 8 rows it is folded behind a line that says what it holds, for example "172 new products, 3 count changes, 11 with new details".
- **Needs a name** (folded): rows with an unknown count (`?`, blank or not a whole number) or a name starting with "Unidentified", and other rows that cannot be recorded. They are never recorded as they are.

Each row shows the cost of the units it adds next to its quantity ("at ₱1,200 each", a range when they differ, or "no cost yet"), and the Cost cell of a desktop table is an input: one "cost each" applies to every unit the row adds, and it may be blank (`setRowCost()`). The Price cell is an input too: a typed price overwrites the product's price on Apply, as in Correct this row, and a product on file shows its price as the placeholder (`setRowPrice()`). A row whose units have different costs shows the range and opens Correct this row for per-unit costs. Like Correct this row, the typed cost changes the review only. In the desktop layout each group is a table of tick box, Name, status, Count or Qty, Cost, Manufacturer, Brand, Product line, Character, Release date and Note. The Apply button reads "Apply N changes" (N is the ticked rows) and stays at the bottom of the screen above the tab bar on a phone (`.applybar`, `position: sticky`). The Movements paste keeps one flat list.

**Correcting a row.** Tapping a row's name in a Count or Receive review (clicking the row in a desktop table) opens Correct this row (`openFix()`). It shows every field the row can carry: Name, Count (Qty for Receive), the cost fields, Price, Manufacturer, Brand, Product line, Character, Release date, "Release date still needs checking" and Note, and "Use the existing product ..." when a similar product is on file. There is one cost field per unit the row adds: the count or quantity for a new product or a Receive row, and the count minus the stock on hand for a Count row on a product on file, so a count that lowers stock shows none. The fields start with the row's `Cost each` when Claude supplied one, and follow the rules in "Cost fields". A field counts as typed when its value differs from what the modal showed. A typed value overwrites what is on file for a product already on file; a field cleared in the modal never erases data, and the name never renames a product on file (it only decides which product the row is). Values that came from the Inbox or a paste and were not typed in the modal keep the import rule: they fill blank fields and never overwrite. Saving changes the review only: the corrected values are what Apply records, and the Inbox row in the sheet stays as Claude wrote it. A row under Needs a name that gets a name and a whole-number count moves to Ready (or to Check these when it still needs a decision).

**After Apply** a sheet stays open until it is closed. It says "Recorded: N new products, N count changes, N products with new details." (receipts in place of count changes for Receive), for an Inbox review "Left in the Inbox: N rows that need a name; N rows you unticked.", and whether the entries have synced or are waiting. It follows the sync while it is open.

**Paste a block by hand (the fallback).** When nothing is waiting, Update inventory offers "Paste a block by hand" with three modes: Count from photo, Receive and Movements. The importers parse pasted text split on tabs (or `|`, or `;`) and queue only the ticked rows. "Copy the prompt and product list for Claude" builds the exact instructions for the current mode plus the catalogue, so existing names are reused.

**Count from photo** (`Name, Count, Price, Note, Manufacturer, Brand, Product line, Character, Release date, Verify`), for photos of boxes or of the stockroom. A count is an absolute quantity. For a product already on file the app records only the difference as a `Count` movement: a count that raises stock adds one `In` per unit, at the costs typed in Correct this row as far as they go and then the row's `Cost each`; a count that lowers stock writes one `Out`, which removes the oldest units. A product that is new is created with its details and given one `Opening` movement per unit. Re-pasting the same counts therefore changes nothing. Details in the paste fill blank fields on a product already on file and never overwrite what is there. Products missing from the paste are left alone. Names match after lower-casing and stripping punctuation; a name that is similar but not equal (token overlap of 50% or more) is held back unticked with a "Use ..." button. `?` or a blank count skips the row. A product listed twice in one paste is flagged, and its counts are not added. `Verify` set to `Y` raises the release-date flag. An Inbox `Count` row supplies `Name`, `Qty` (the count), `Cost each`, `Note` and the product details; it has no price. Inbox `Count` rows for the same product (one per photo it appears in) are added into one count before the review, so each box must be photographed once. Rows with no usable count or a name starting with "Unidentified" are kept apart and are not added in. Inbox `Receive` rows are dated on the day they are applied.

**Receive** (`Name, Qty, Cost each, Manufacturer, Brand, Product line, Character, Release date, Verify, Note`), for supplier invoices and packing lists. Each row adds one `Restock` per unit on the "Received on" date, at the row's cost unless other costs were typed in Correct this row. A new product is created first, with the price typed in Correct this row when there is one. When the product has a supplier order on the way, the row receives that order (oldest first) with a `receive` entry, so it stops counting as incoming.

**Movements** (`Date, Product, In/Out, Qty, Reason, Note`, and an optional seventh column with the cost of each unit for an `In` row): the product can be a name or a Product ID. An `In` row is written one unit per movement. Rows that repeat an existing movement (same date, product, direction, quantity and reason, counting the per-unit rows of one `In` as one movement) come in unticked as likely duplicates; rows that would take stock below zero are flagged but allowed. This mode exists only in the paste box.

## Assumptions made where the brief was open

Each of these was undecided when the release that added it was built. They are listed so they can be changed in one place.

| Topic | What the app does | Where to change it |
| --- | --- | --- |
| Currency and number format | `₱` by default, device number format | Settings > Currency symbol; `money()` |
| Return outcomes | Restock brings the product back into stock; Write-off does not. A replacement for a returned product is a new sale. | `RETURN_STOCK_` / `RETURN_STOCK` |
| Customer tracker | A Customers tab in the same spreadsheet | `T_.cust` |
| "Ready to collect" | Labelled "Ready to ship" | `preListHtml()`, `renderHome()` |
| Shipping status | A single `Delivered` mark on a sale invoice, blank until set | `SHIP_`, `ship` |
| Invoice image | A PNG made on the device and never stored; shop details are kept per device | `drawDoc()`, `prefs.shop` |
| Invoice image wording | Titles "INVOICE" and "PRE-ORDER RECEIPT"; no tax lines; footer line optional | `drawDoc()`, Settings |
| Invoice taller than 2048 px | Split into several images that download together | `drawDoc()`, `saveImg()` |
| "Page i of N" | Drawn only when there are two or more images | `drawDoc()` |
| Logo on the image | Drawn into a fixed 150 × 56 pt box, so the number of images is known during the tap | `drawDoc()`, `docPngs()` |
| Copy image button | Shown on phone and desktop (the owner's change to a spec that said desktop only), when the browser can write images to the clipboard; hidden for documents with several images | `canCopyImg`, `openInv()` |
| Supplier orders | No supplier name and no cost at order time; one cost per unit is typed when received, and blank is allowed; the whole order closes on receipt with the quantity typed | `T_.order`, `receive` |
| Receive import | A row for a product with an open supplier order closes the oldest one | `settleReceive()` |
| Sale or pre-order | One form. More than is free to sell (on hand less owed, incoming not counted) saves a pre-order; "It is here, sell it now" makes it a sale with no confirmation | `invInfo()`, `freeOf()` |
| A pre-order with several products | Refused: a pre-order holds one product, as the sheet's Pre-orders tab does | `savePreOrder()` |
| Two lines of the same product on a sale | Refused with a toast, so a line's cost always comes from the front of the queue | `issueInvoice()` |
| Notice when some units are free but not enough | "Only N are free to sell, so this is saved as a pre-order" | `invNotice()` |
| Selling now when units are owed but on hand | One muted line says the units are owed to earlier pre-orders | `invForced()` |
| Two ready pre-orders for one customer | One Home row for the oldest, saying how many more are ready | `needsRows()` |
| Ready rows on Orders | Open the pre-order's sheet, which has Issue invoice; the Home row opens the filled form directly | `preRow()` |
| Closing the New sale form on a phone | Clears the draft and shows the invoice list | `back` in the click handler |
| Settings on pages without a tab | The header shows a close button in its place; Settings opens from any tabbed page | `render()` |
| Delivered mark | A checkbox on the invoice sheet | `openInv()` |
| App name | "Bodega", a placeholder | `APP_NAME`, `<title>`, head meta, `manifest.webmanifest` |
| Theme | Device, Light or Dark, kept per device in `prefs.theme`; the invoice image looks the same in all three | `applyTheme()`, `drawDoc()` |
| Update inventory on desktop and phone | A route with no phone tab; a Home button and the desktop side bar open it | `TABS`, `render()` |
| Fonts | Two self-hosted families, cached first by the service worker, licensed SIL OFL 1.1 | `fonts/`, `sw.js` |
| Pre-order receipt | Always made when a pre-order is saved | `pre` in `addEntries_` |
| Balance on a pre-order at invoice time | Marked as paid when the invoice is issued | `issueInvoice()` |
| Inbox | Claude writes the rows and the app reviews them; the app never writes an Inbox row, and only sets `Status` after the owner applies or dismisses | `INBOX_HEAD_`, `readInbox_()`, `inboxDone` |
| Key of each tab | Products by Product ID without regard to case; Customers, Supplier orders, Pre-orders and Movements by the ID in column A; Invoices by the ID in column B | `T_[k].col`, `tabsOf_()` |
| An Inbox mark that finds no row | Changes nothing and does not fail the entry, so the row keeps waiting | `markInbox_()` |
| How an Inbox mark or Edits status is written | Only the status cells, in one call | `markInbox_()`, `finishEdits_()` |
| A count that already matches stock, from the Inbox | Ticked, recorded as no change, and marked `Done` | `resettle()` |
| "Possibly the same box in two photos" | Only for a name not on file; rows for a product already on file are summed under Ready as before | `impGroup()` |
| Rows that cannot be recorded for other reasons (a bad quantity, no name) | Under Needs a name | `impGroup()` |
| Corrections | Count and Receive reviews, from the Inbox or a paste; every field the row carries | `openFix()`, `saveFix()` |
| Values typed in Correct this row | Overwrite the product's fields; untouched Inbox values only fill blanks. A field counts as typed when it differs from what it showed; a cleared field never erases data; the name never renames a product on file | `saveFix()`, `detailPatch()` |
| Price on a Receive row | Can be typed in Correct this row; it sets the price of a new product and, being typed, overwrites the price of a product on file | `ROW_COLS`, `recvRow()` |
| Result after Apply | Shown for every Apply, including a pasted block | `openImpResult()` |
| Warnings banner | Kept in memory and replaced at every sync | `ui.warn`, `renderHome()` |
| Duplicated rows in tabs other than Products | Not reported as warnings; an entry that changes one is refused | `check_()` |
| Left to promise label | Kept, with a one-sentence explanation on the product sheet and the table header | `LTP_TEXT` |
| FIFO order | The order of the movement log; movement dates are not used | `stockOf_()`, `fifo()` |
| Which unit a write-off removes | The oldest, the same as a sale | `stockOf_()`, `fifo()` |
| A sale of a unit with no cost | Allowed, with a warning; the margin on that sale stays unknown | `invNoCost()`, `costOut()` |
| More than 12 units in one stock-in | One "Cost each" field, expandable to one field per unit | `costFields()` |
| Costs through the sheet | Not supported; a cost is changed in the app | `cost` |
| A `cost` entry carrying the value the unit already has | Changes nothing and is not refused, even after the unit has left stock, so a retry after a lost response succeeds | `cost` in `plan_()` |
| A `cost` entry for a movement written earlier in the same request | Written into that new row, without raising `moveRev` | `cost` in `plan_()` |
| `moveRev` | Raised once per Movements cell written and compared strictly; an app that sends no `have.moveRev` gets every movement | `write_()`, `snapshot_()` |
| Inbox on reset | Kept, with an optional function to bring researched rows back for review | `wipeAllData()`, `reopenInbox()` |
| Browse on reset | Deleted and made again by the next write, not cleared, so no layout from an older release is left | `wipeAllData()`, `browseSheet_()` |
| Home rows that open Inventory | Reset the search and the column filters | `homeGo` in the click handler |
| Table rows | Reachable with Tab; Enter opens the row's sheet | `table()`, the `keydown` handler |

Not built because the brief left them undecided: an ID-confidence field, holds on unpaid units, return windows, refund approval, payment method and reference, voiding an invoice, and exchanges as a return outcome.

## Known limits

- Two phones that each create a product with the same name at the same moment, one of them offline, will merge into one product and both opening stocks are added. The log shows both entries, and either can be reversed.
- A Product ID cannot be changed after the product is created.
- An invoice cannot be edited or voided once it has reached the sheet. A wrong one is undone with a return, or by reversing its movement in Activity.
- A cost cannot be changed once its unit has left stock, and a sale's cost never changes after the invoice is issued.
- A movement cell edited in place in the sheet, such as a `Unit cost`, is used by the script at once (Browse, the `cost` check) but reaches a phone only when it next downloads every movement: after a `cost` entry from any device, a wipe, or Re-download everything.
- The movement log and all documents live in `localStorage` (about 5 MB), which is enough for tens of thousands of rows. Per-unit `In` rows make the log grow by one row per unit received. Beyond that the app would need IndexedDB.
- The Inbox depends on the assistant writing well-formed rows (a name, a numeric `Qty`, a `Type` of `Count` or `Receive`). A malformed row shows up in the preview as skipped or flagged, and the app cannot fix it. The Inbox has never been exercised against a real sheet or the real Google Sheets connector, only against the test fake.
- The tests run against the mock backend only, so they do not prove behaviour on a real sheet. The fake models protections, data validation, clearing contents and a hook that rearranges rows in the middle of a request.
- A change to a row made in the few milliseconds between the script's check of a key cell and its write to that row is not caught. If an entry changes two rows and the second one has gone by the time it is written, the first stays written.
- `On hand` is written after the other writes; a sort in that moment can put a number on the wrong row until the next `add` writes the column again. Browse and the app are not affected, because they work stock out from Movements.
- Every `sync` and `add` reads all of Movements and rewrites Browse, which takes longer on a sheet with many thousands of movements. A `cost` entry makes every device download all movements at its next sync.
- A sort of Browse lasts until the next sync. A filter or a filter view is the way to keep a view.
- The protections are warnings. Google Sheets asks before an edit or a sort on those tabs, and the owner can still go ahead.
- The latin font subsets have no peso sign, so ₱ is drawn with a system font next to Bebas Neue and Geist.
- The sheet keeps its own header names, including `Toy line` on Products and Inbox, so the toy-inventory-logger skill keeps writing the Inbox as it does; the app's labels, Browse and Edits say Product line.
- Settings cannot be opened from Update inventory, Stock in and out, Activity or the New sale form on a phone, because the close button takes its place there.
- `Code.gs` was tested only against a fake of Google's services. The fake enforces plain-text formatting on the columns that hold free text; the real behaviour of `setup()`, `wipeAllData()` and of every write should be confirmed once on a real sheet.
