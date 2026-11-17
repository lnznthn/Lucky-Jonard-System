# Bodega

Offline-first stock, pre-orders and invoicing for a phone, backed by a Google Sheet. Stock goes in and out as movements. Claude can read a photo of boxes, shelves or supplier paperwork into rows that wait in the sheet's Inbox tab for review in the app, and each sale produces an invoice image to send to the customer. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

1. Open the Google Sheet that will hold the data. In **Extensions > Apps Script**, replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo and save.
2. Run `setup` once and approve the permissions. It creates the tabs (Items, Movements, Customers, Supplier orders, Pre-orders, Invoices, Invoice lines, Returns, Inbox, Browse and Edits) and a connection key. Browse is a copy of every item with its numbers, for sorting and filtering. Edits is where item fields are changed from the sheet. After pasting a newer Code.gs, run setup again and publish a new version of the existing deployment (Deploy > Manage deployments > edit > New version), which keeps the same `/exec` URL. `setup` is safe to run again and never deletes data.
3. Run `showKey`, then open **View > Logs** and copy the key.
4. **Deploy > New deployment > Web app**, Execute as **Me**, Who has access **Anyone**. Copy the web app URL (it ends in `/exec`).
5. In the app, open Settings (the sliders button at the top right) and paste `<URL>#<key>` as the connection code, then **Test and save**.
6. On the phone, open the GitHub Pages address in Safari and use Share > Add to Home Screen.

The app works before step 5. Everything is kept on the device and sent to the sheet once it is connected.

## Using it

The same address works on a phone and in a desktop browser. A window 900 px wide or more gets a side bar (Home, Stock, Sales, Orders, Update stock with the number of waiting rows, and Activity) and shows the lists as tables: click a column header to sort, click a row to open it. A phone gets four bottom tabs: Home, Stock, Sales and Orders.

- **Home**: a strip with sales today, sales this month and margin this month; two buttons, **New sale** and **Update stock**; and one **Needs you** list. Each row in the list is a job that opens the place to do it, in a fixed order: entries the sheet refused, pre-orders ready to ship (one row per customer), rows from Claude to review, items promised beyond supply, supplier orders due, pre-order balances to collect, items with no price, units with no cost, and release dates to verify. A phone shows the first four rows and a "See N more" line when there are more than five.
- **Stock**: search, filter by category, out of stock, short supply, no price, no cost, release date to verify or archived, and tap an item for its four numbers (on hand, incoming, owed to customers, left to promise), details, the units on hand (oldest first, each with its own cost, which can be typed or changed while the unit is in stock), history and edit. Units leave stock oldest first. On a desktop, Stock is a table with every field, the unit cost and the stock cost, and a filter row for category, manufacturer, brand, product line, character and a release date range. **Stock in** and **Stock out** on the item's sheet record stock by hand, with one cost field per unit coming in; a cost can be left blank and added later. The **Activity** link on this page opens the movement log, where a movement can be reversed.
- **Sales**: the invoice list, with **New sale** at the top. Open an invoice to save or copy its image, mark it Delivered or record a return (Restock puts the item back in stock, Write-off does not).
- **New sale**: pick the item (or tap **Sell** on the item in Stock), check the price, type the customer's name and tap **Issue invoice**. That takes the item out of stock, records the cost of the units it took, and opens the invoice with **Save image**, which opens the PNG in a new tab to save or share, and downloads the file when a new tab cannot open. An invoice too long for one image continues on further images, which all download. Where the browser can put an image on the clipboard, **Copy image** beside it copies a one-image invoice to paste into a chat, on a phone or a desktop. A sale of a unit with no cost yet is allowed; the form says so, and the margin on that sale stays unknown. The same form saves a pre-order when a customer asks for more than is free to sell, which is the stock on hand less what earlier open pre-orders are owed. A notice says so, and the form then asks for the amount paid now and for the customer's phone or Messenger. A pre-order makes a receipt image at once. **It is here, sell it now** overrides the notice and issues the invoice anyway, which can take stock below zero.
- **Orders > Pre-orders**: pre-orders ready to ship, waiting and closed. When stock arrives, the customer appears as ready to ship and the invoice is one tap away. Cancelling a pre-order asks for the deposit kept; 0 is a full refund.
- **Orders > Supplier orders**: save what has been ordered and paid for. When it arrives, open it, type the cost of each unit (or leave it blank for now) and tap **Received**.
- **Update stock**: rows that Claude has added to the sheet's Inbox tab appear here as soon as the app syncs, in a review with three groups. **Check these** holds the rows that need a decision (a similar name on file, the same new name on two rows, a release date to verify). **Ready** holds the rest of what will be recorded. **Needs a name** holds rows with no count or a name starting with "Unidentified", which are never recorded as they are. Tap a row's name (click the row on a desktop) to correct any of its fields before applying, including one cost per unit it adds. A value typed there overwrites the item on file; values from Claude only fill blank fields. The correction is used for this review only and the Inbox row stays as Claude wrote it. **Apply** records the ticked rows and marks only those rows Done in the Inbox; unticked rows and rows that need a name stay there. A sheet then says what was recorded and what was left. **Dismiss these rows** discards everything shown. Photos reach Claude either attached in chat or uploaded to a Google Drive folder, and Claude reads them with the toy-inventory-logger skill. When nothing is waiting, this page lists the other ways to change stock: receive a supplier order, change one item by hand, add a new item, or **Paste a block by hand**. For the paste, tap "Copy the prompt and item list for Claude", send that text with a photo to Claude, paste the code block it returns, preview and apply. **Count from photo** is for boxes and shelves, **Receive** is for a supplier's invoice or packing list, and **Movements** takes rows of dated stock changes.
- **Settings**: four groups. Connection holds the connection code and re-download. Invoice image holds the shop name, contact details, footer line and logo. Preferences holds the theme (Device, Light or Dark, kept per device), and the currency symbol. Data holds the two exports and erase.

## Working in the sheet

- To sort, filter or look through the items, use the **Browse** tab. It has one row per item with on hand, incoming, owed, left to promise, the costs of the units on hand (oldest first, `?` for a unit without a cost), their total and the number of units without a cost. The script rewrites it at every sync, so a filter stays and a sort lasts until the next sync. Changes typed into Browse are overwritten.
- To change an item from the sheet, add a row to the **Edits** tab: the SKU, the field (pick it from the dropdown), and the new value. Leave Status blank. At the next sync the script applies the row and writes Done, or Refused with the reason in Note. The phone gets the change at its sync after that. To try a refused row again, fix it and clear its Status.
- The other tabs (Items, Movements, Customers, Supplier orders, Pre-orders, Invoices, Invoice lines and Returns) belong to the app. They can be viewed, but they should not be sorted or edited, and Google Sheets shows a warning before a change to them. If one is sorted anyway, the script still finds each row by its SKU or ID, so nothing is written to the wrong row. If a SKU or ID is deleted or appears twice, the change for that row is refused with a message under Activity in the app and nothing of it is written; fix the tab and sync again. A SKU on two Items rows also shows as a red line on Home.
- The Inbox is Claude's tab. A row with any Status, including Working, is not shown in the app.
- A cost is changed in the app, not in the sheet.

## Look and fonts

The app uses Bebas Neue for titles and key numbers and Geist for all other text. Both are served from `fonts/` and cached by the service worker, so text looks the same offline. They are licensed under the SIL Open Font License 1.1; `fonts/README.md` names the source packages.

## Release 2.3.0

Release 2.3.0 changes both `apps-script/Code.gs` and the app, and does not work with 2.2.x or its data. Every unit on hand carries its own cost and units leave stock oldest first, so each sale records the cost of the units it took and keeps it. The invoice exports as a PNG image. In a wide window the lists are tables. To go live: sync every phone with nothing waiting, paste the new `Code.gs`, run `wipeAllData` (it saves a backup copy of the spreadsheet first, then empties the data tabs; invoice numbers restart at 1) and, if wanted, `reopenInbox` to bring Claude's researched rows back for review, run `setup`, publish a new version of the deployment, merge the app to `main`, and sync each device. The cache name is `toys-v2.3.0`. [ARCHITECTURE.md](ARCHITECTURE.md) lists every step.

## Tests

```
node test/backend.test.js                 # Code.gs against an in-memory fake of Google's services
python3 -m http.server 8765 &             # the app
node test/mock-backend.js 8766 &          # the fake back end over HTTP
for t in test/*.py; do python3 $t; done   # drive the app in Chrome (needs Playwright and Chrome); common.py holds their shared steps
```

The browser tests read the ports from `APP_PORT` and `API_PORT` (default 8765 and 8766). All of these run against the mock backend, which runs `Code.gs` on a fake of Google's services. They do not prove behaviour on a real sheet.
