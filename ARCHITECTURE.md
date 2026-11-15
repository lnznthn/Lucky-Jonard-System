# Toy Stock: how the app works

Toy Stock is a single-page web app (PWA) over a Google Sheet, installed on a phone's home screen. It is local-first: the phone keeps every item and movement, computes stock itself, and uses the sheet to share data between devices and to keep a record the owner can read and chart. This file is the reference for anyone changing the app, so the logic below does not have to be rediscovered from chat history.

This repository is public and served by GitHub Pages. Keep the spreadsheet ID, the connection key and real stock data out of this file and out of the code.

It follows the same pattern as the Ledger app (a public Pages repo, an Apps Script web app bound to a sheet, a `URL#key` connection code, a queue of pending writes, paste-to-import).

## Files and deployment

| File | Role |
| --- | --- |
| `index.html` | The whole app: markup, CSS and one `<script>`. Version is the `VERSION` constant at the top of the script. |
| `sw.js` | Service worker. The page is network-first (3-second budget, then the cached copy), icons and manifest are cache-first. Never caches sheet data. |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata. |
| `apps-script/Code.gs` | The back end. Paste it into the sheet's Apps Script project; it is not deployed from this repo. |
| `test/` | `mock-backend.js` runs `Code.gs` unchanged against an in-memory fake of Google's services. `backend.test.js` tests it directly; `e2e.py` drives the app in Chrome against it; `offline.py` checks offline launch. |

Changing this repo needs only a push to `main`; GitHub Pages republishes in about a minute. Changing `Code.gs` means pasting the new file into the Apps Script editor and publishing a new version of the existing web app deployment (Deploy > Manage deployments > edit > New version), which keeps the `/exec` URL.

### Release checklist

1. Bump `VERSION` in `index.html`.
2. Bump `CACHE` in `sw.js` to the same version (`toys-vX.Y.Z`). Browsers only install a new service worker when the bytes of `sw.js` change.
3. Never commit an empty or truncated `sw.js`: `test -s sw.js && node --check sw.js`.
4. Check the script parses: `node -e "const h=require('fs').readFileSync('index.html','utf8');new Function(h.slice(h.indexOf('<script>')+8,h.lastIndexOf('</script>')))"`.
5. Run `node test/backend.test.js`, then start `python3 -m http.server 8765` and `node test/mock-backend.js 8766` and run `python3 test/e2e.py`.
6. Commit and push to `main`.

## The sheet

`setup()` in `Code.gs` creates two tabs and formats the text columns as plain text, so a SKU such as `0012` or a note starting with `=` is stored as typed.

**Items** (one row per toy): `SKU`, `Name`, `Category`, `Price`, `Reorder at`, `Active` (`Yes` or `No`), `On hand`. `On hand` is a single `ARRAYFORMULA` in `G2` that sums `Movements` per SKU; the script never writes column G. Archiving sets `Active` to `No`; rows are never deleted.

**Movements** (append-only log): `ID`, `Date` (`YYYY-MM-DD`, text), `SKU`, `Item` (the name at the time, for readability), `Direction` (`In` or `Out`), `Qty` (positive whole number), `Reason`, `Ref`, `Note`. Stock for a SKU is the sum of `In` minus the sum of `Out`. Movements are never edited or deleted; a mistake is fixed by a reversing entry.

Reasons and the direction each allows (enforced by the app and by `Code.gs`):

| Reason | Direction | Used for |
| --- | --- | --- |
| Opening, Restock, Return | In only | First stock, deliveries, customer returns |
| Sale, Damaged, Lost | Out only | Sales, write-offs |
| Count, Correction, Other | Either | Photo counts and stock-takes, reversals, anything else |

`Ref` holds the ID of the movement a `Correction` reverses. It is also reserved for the sales module: a sale or return will write its document ID here (see the sales plan).

## Sync protocol

All calls are `POST` to the Apps Script `/exec` URL with a `text/plain` JSON body `{ key, action, ...payload }` (plain text avoids a CORS preflight). Responses are `{ ok, data }` or `{ ok: false, error, auth }`. The connection code the owner pastes is `<exec URL>#<key>`; `showKey()` in the script editor prints the key.

| Action | Payload | Returns |
| --- | --- | --- |
| `ping` | none | `{ version }`, used by Settings to test the code |
| `sync` | `have: { rows, lastId }` | `{ items, moves, rows, lastId, reset, syncedAt }` |
| `add` | `entries`, `have` | `{ results: [{ id, ok, error, sku?, from? }], sync }` |

Items are always sent whole (a shop has hundreds, not millions). Movements are incremental: the app says how many movement rows it holds and the ID of the last one; if the sheet still has that ID at that row, only later rows come back, otherwise everything comes back with `reset: true` and the app replaces its copy. Hand-editing or deleting movement rows in the sheet therefore heals itself at the next sync.

`add` entries are `{ id, kind: 'item' | 'edit' | 'move', ... }`, applied in order and each idempotent: an item by SKU and name, a movement by its ID. A retry after a lost response changes nothing.

### SKU collisions

Auto-generated SKUs are `T0001`, `T0002`, and so on, picked by the phone from its own list. Two phones that work offline can pick the same next SKU for different toys. Item entries made with a generated SKU carry `auto: true`. When the sheet finds a different toy on that SKU, it assigns the next free one, applies the rest of the batch to the new SKU, and returns `{ sku, from }`; the app then renumbers whatever is still in its queue. If the name already exists under another SKU the entry is treated as the same toy, which makes a retry of a renumbered batch safe.

A refused item (for example a name already used by another SKU) blocks every later entry for that SKU in the same batch, and the app fails any queued entries for it, so a movement can never be credited to a different toy that owns the SKU. Refused entries stay in the queue, listed in Activity with the reason; deleting a refused toy also deletes the stock entries waiting on it.

## Local state (`localStorage`, prefix `toys.`)

| Key | Contents |
| --- | --- |
| `cfg` | `{ url, key }` |
| `items` | Items as of the last sync: `{ sku, name, cat, price, min, active }` |
| `moves` | Movements as of the last sync, in sheet order: `{ id, date, sku, dir, qty, reason, ref, note }` |
| `meta` | `{ rows, lastId, syncedAt }` for the incremental pull |
| `queue` | Entries not yet confirmed by the sheet; `status` is `pending` or `failed` |
| `prefs` | Current tab, currency symbol, default reorder level |

Everything the owner does is written to the queue first and flushed when a connection exists. Without a connection the app works fully on the device; the queue holds everything until the connection code is pasted. `live()` merges synced data with pending entries (failed entries are not counted) and is the only thing the screens read. The app is the only writer to the sheet.

## Stock math

`stock(sku)` is the sum of signed movement quantities over synced movements plus pending queue moves. Negative stock is allowed and shown in red: recording a sale for something that was never counted in should not be blocked at the till. A low-stock toy is one with `0 < stock <= reorder level`; the item's own `Reorder at` wins over the default in Settings.

## Importing

Both importers parse pasted text split on tabs (or `|`, or `;`), show a preview, and queue only the ticked rows. Nothing is written before the preview is applied.

**Count from photo** (`Name, Category, Count, Price, Note`): the owner sends Claude a photo of the shelves and pastes the answer. "Copy the prompt and toy list for Claude" in the app builds the exact instructions plus the current catalogue so Claude reuses existing names. A count is an absolute shelf quantity. For a toy already on file the app records only the difference as a `Count` movement; a toy that is new is created and given an `Opening` movement. Re-pasting the same counts therefore changes nothing. Toys missing from the paste are left alone. Names match after lower-casing and stripping punctuation; a name that is similar but not equal (token overlap of 50% or more) is held back unticked with a "Use ..." button. `?` or a blank count skips the row. A toy listed twice in one paste is flagged rather than summed.

**Movements** (`Date, Toy, In/Out, Qty, Reason, Note`): the toy can be a name or a SKU. Rows that repeat an existing movement (same date, toy, direction, quantity and reason) come in unticked as likely duplicates; rows that would take stock below zero are flagged but allowed.

## Known limits

- Two phones that each create a toy with the same name at the same moment, one of them offline, will merge into one toy and both opening stocks are added. The log shows both entries, and either can be reversed.
- A SKU cannot be changed after the toy is created.
- The whole movement log lives in `localStorage` (about 5 MB), which is enough for tens of thousands of rows. Beyond that the app would need IndexedDB.
- `Code.gs` was tested against a fake of Google's services, not on a live sheet. The fake enforces plain-text formatting on the columns that hold free text; the real behaviour of `setup()` should be confirmed once on a real sheet.
