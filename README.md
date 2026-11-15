# Bodega

Offline-first stock, pre-orders and invoicing for a phone, pre-orders and invoicing for a phone, backed by a Google Sheet. Stock goes in and out as movements. Claude can read a photo of boxes, shelves or supplier paperwork into rows that wait in the sheet's Inbox tab for review in the app, and each sale produces an invoice PDF to send to the customer. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

1. Open the Google Sheet that will hold the data. In **Extensions > Apps Script**, replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo and save.
2. Run `setup` once and approve the permissions. It creates the tabs (Items, Movements, Customers, Supplier orders, Pre-orders, Invoices, Invoice lines, Returns, Inbox) and a connection key. After pasting a newer `Code.gs`, run `setup` again and publish a new version of the deployment (Deploy > Manage deployments > edit > New version).
3. Run `showKey`, then open **View > Logs** and copy the key.
4. **Deploy > New deployment > Web app**, Execute as **Me**, Who has access **Anyone**. Copy the web app URL (it ends in `/exec`).
5. In the app, open Settings (the sliders button at the top right) and paste `<URL>#<key>` as the connection code, then **Test and save**.
6. On the phone, open the GitHub Pages address in Safari and use Share > Add to Home Screen.

The app works before step 5. Everything is kept on the device and sent to the sheet once it is connected.

## Using it

The same address works on a phone and in a desktop browser. A window 900 px wide or more gets a side bar (Home, Stock, Sales, Orders, Update stock with the number of waiting rows, and Activity) and two-column pages. A phone gets four bottom tabs: Home, Stock, Sales and Orders.

- **Home**: a strip with sales today, sales this month and margin this month; two buttons, **New sale** and **Update stock**; and one **Needs you** list. Each row in the list is a job that opens the place to do it, in a fixed order: entries the sheet refused, pre-orders ready to ship (one row per customer), rows from Claude to review, items promised beyond supply, supplier orders due, pre-order balances to collect, items low or out of stock, items with no price, and release dates to verify. A phone shows the first four rows and a "See N more" line when there are more than five.
- **Stock**: search, filter by category, low stock, short supply, no price, release date to verify or archived, and tap an item for its four numbers (on hand, incoming, owed to customers, left to promise), details, average cost, history and edit. **Stock in** and **Stock out** on the item's sheet record stock by hand, with the cost each on a receipt. The **Activity** link on this page opens the movement log, where a movement can be reversed.
- **Sales**: the invoice list, with **New sale** at the top. Open an invoice to share its PDF, mark it Delivered or record a return (Restock puts the item back in stock, Write-off does not).
- **New sale**: pick the item (or tap **Sell** on the item in Stock), check the price, type the customer's name and tap **Issue invoice**. That takes the item out of stock and opens the invoice with **Share PDF**, which downloads the file where the browser cannot share files. The same form saves a pre-order when a customer asks for more than is free to sell, which is the stock on hand less what earlier open pre-orders are owed. A notice says so, and the form then asks for the amount paid now and for the customer's phone or Messenger. A pre-order makes a receipt PDF at once. **It is here, sell it now** overrides the notice and issues the invoice anyway, which can take stock below zero.
- **Orders > Pre-orders**: pre-orders ready to ship, waiting and closed. When stock arrives, the customer appears as ready to ship and the invoice is one tap away. Cancelling a pre-order asks for the deposit kept; 0 is a full refund.
- **Orders > Supplier orders**: save what has been ordered and paid for. When it arrives, open it, type the cost each and tap **Received**.
- **Update stock**: rows that Claude has added to the sheet's Inbox tab appear here as soon as the app syncs, in a preview. Check them, then **Apply** to record them or **Dismiss** to discard them. Photos reach Claude either attached in chat or uploaded to a Google Drive folder, and Claude reads them with the toy-inventory-logger skill. When nothing is waiting, this page lists the other ways to change stock: receive a supplier order, change one item by hand, add a new item, or **Paste a block by hand**. For the paste, tap "Copy the prompt and item list for Claude", send that text with a photo to Claude, paste the code block it returns, preview and apply. **Count from photo** is for boxes and shelves, **Receive** is for a supplier's invoice or packing list, and **Movements** takes rows of dated stock changes.
- **Settings**: four groups. Connection holds the connection code and re-download. Invoice PDF holds the shop name, contact details, footer line and logo. Preferences holds the theme (Device, Light or Dark, kept per device), the currency symbol and the default reorder level. Data holds the two exports and erase.

## Look and fonts

The app uses Bebas Neue for titles and key numbers and Geist for all other text. Both are served from `fonts/` and cached by the service worker, so text looks the same offline. They are licensed under the SIL Open Font License 1.1; `fonts/README.md` names the source packages.

## Release 2.1.0

Release 2.1.0 changes the app only. It makes no change to `apps-script/Code.gs` or to the sheet, so the sheet still labels the Items and Inbox column `Toy line` while the app calls it Product line. The cache name is `toys-v2.1.0`.

## Tests

```
node test/backend.test.js                 # Code.gs against an in-memory fake of Google's services
python3 -m http.server 8765 &             # the app
node test/mock-backend.js 8766 &          # the fake back end over HTTP
python3 test/e2e.py                       # drives the app in Chrome (needs Playwright and Chrome)
python3 test/e2e_v2.py                    # orders, pre-orders, invoices, PDF, returns (also needs pdfinfo and pdftoppm)
python3 test/desktop.py                   # desktop layout
python3 test/offline.py                   # the app opens with no network
```

All of these run against the mock backend, which runs `Code.gs` on a fake of Google's services. They do not prove behaviour on a real sheet.
