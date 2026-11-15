# Toy Stock

Offline-first toy inventory, pre-orders and invoicing for a phone, backed by a Google Sheet. Stock goes in and out as movements, Claude can read a photo of boxes, shelves or supplier paperwork into rows that wait in the sheet's Inbox tab for review in the app, and each sale produces an invoice PDF to send to the customer. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

1. Open the Google Sheet that will hold the data. In **Extensions > Apps Script**, replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo and save.
2. Run `setup` once and approve the permissions. It creates the tabs (Items, Movements, Customers, Supplier orders, Pre-orders, Invoices, Invoice lines, Returns, Inbox) and a connection key. After pasting a newer `Code.gs`, run `setup` again and publish a new version of the deployment (Deploy > Manage deployments > edit > New version).
3. Run `showKey`, then open **View > Logs** and copy the key.
4. **Deploy > New deployment > Web app**, Execute as **Me**, Who has access **Anyone**. Copy the web app URL (it ends in `/exec`).
5. In the app, open Settings (the gear) and paste `<URL>#<key>` as the connection code, then **Test and save**.
6. On the phone, open the GitHub Pages address in Safari and use Share > Add to Home Screen.

The app works before step 5. Everything is kept on the device and sent to the sheet once it is connected.

## Using it

The same address works on a phone and in a desktop browser. A wide window gets a side bar and two-column pages; a phone gets the bottom tabs.

- **Home**: **New Sale** and **New pre-order** buttons, a "Ready to ship" list with an **Invoice** button for each waiting customer, and a "Needs you" list that shows only what has something to do (entries the sheet refused, rows from Claude to review, supplier orders due, toys promised beyond stock, pre-orders with a balance, toys low or out, toys with no price, release dates to verify). Three cards show sales today, sales this month and margin this month. **All stock activity** opens the movement log, where a movement can be reversed.
- **Stock**: search, filter by category or low stock, tap a toy for its four numbers (on hand, incoming, owed to customers, left to promise), details, average cost, history and edit. **+ Stock in** and **− Stock out** on the toy's sheet record stock by hand, with the cost each on a receipt, and return to Stock. The toy's sheet also links to its own activity.
- **Sell > New Sale**: pick the toy (or tap **Sell** on the toy in Stock), check the price, type the customer's name, **Issue invoice**. That takes the toy out of stock and opens the invoice with **Share PDF**, which downloads the file where the browser cannot share files. Open an invoice later to mark it Delivered or record a return (Restock puts the toy back in stock, Write-off does not).
- **Orders > Pre-orders**: save a pre-order when a customer pays for a toy that has not arrived; a receipt PDF is made at once. When the toy arrives the customer appears under "Ready to ship" with an **Invoice** button. Cancelling a pre-order asks for the deposit kept; 0 is a full refund.
- **Orders > Supplier orders**: save what has been ordered and paid for. When it arrives, open it, type the cost each, **Received**.
- **Import**: rows that Claude has added to the sheet's Inbox tab appear here as soon as the app syncs, in a preview with the Import tab showing how many are waiting. Check them, then **Apply** to record them or **Dismiss** to discard them. Photos reach Claude either attached in chat or uploaded to a Google Drive folder; Claude reads them with the toy-inventory-logger skill. When nothing is waiting, **Paste a block by hand** is the fallback: tap "Copy the prompt and toy list for Claude", send that text with a photo to Claude, paste the code block it returns, preview, apply. **Count from photo** is for boxes and shelves; **Receive** is for a supplier's invoice or packing list; **Movements** takes rows of dated stock changes.
- **Settings**: shop name, contact details, footer line and logo for the PDF.

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
