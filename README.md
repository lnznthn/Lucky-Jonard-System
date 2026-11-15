# Toy Stock

Offline-first toy inventory for a phone, backed by a Google Sheet. Stock goes in and out as movements, and a photo of the shelves can be turned into a block of rows that pastes straight into the app. How it works is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

1. Open the Google Sheet that will hold the data. In **Extensions > Apps Script**, replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo and save.
2. Run `setup` once and approve the permissions. It creates the **Items** and **Movements** tabs and a connection key.
3. Run `showKey`, then open **View > Logs** and copy the key.
4. **Deploy > New deployment > Web app**, Execute as **Me**, Who has access **Anyone**. Copy the web app URL (it ends in `/exec`).
5. In the app, open Settings (the gear) and paste `<URL>#<key>` as the connection code, then **Test and save**.
6. On the phone, open the GitHub Pages address in Safari and use Share > Add to Home Screen.

The app works before step 5. Everything is kept on the device and sent to the sheet once it is connected.

## Using it

- **Stock**: search, filter by category or low stock, tap a toy for its history, in/out buttons and edit.
- **Move**: pick a toy, choose In or Out, set the quantity and reason, record.
- **Activity**: every movement, newest first. Tap one to reverse it.
- **Import > Count from photo**: tap "Copy the prompt and toy list for Claude", send that text with a photo of the shelves to Claude, paste the code block it returns, preview, apply. Only differences from the stock on file are recorded.

## Tests

```
node test/backend.test.js                 # Code.gs against an in-memory fake of Google's services
python3 -m http.server 8765 &             # the app
node test/mock-backend.js 8766 &          # the fake back end over HTTP
python3 test/e2e.py                       # drives the app in Chrome (needs Playwright and Chrome)
python3 test/offline.py                   # the app opens with no network
```
