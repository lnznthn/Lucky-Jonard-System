# End-to-end test: python3 test/e2e.py  (needs static server on 8765, mock backend on 8766, Chrome)
import json, os, urllib.request
from playwright.sync_api import sync_playwright
from common import *

SHOTS = '/tmp/shots'
os.makedirs(SHOTS, exist_ok=True)
def activity(p): tab(p, 'Inventory'); p.click('#view button[data-t="activity"]')
def update_label(p): tab(p, 'Home'); return p.inner_text('#view button[data-t="import"]')
def post_rows(name, rs): urllib.request.urlopen(urllib.request.Request(API + '/_rows', data=json.dumps({'tab': name, 'rows': rs}).encode(), method='POST')).read()   # rows 2 onward of a tab, as typed in the sheet

with sync_playwright() as pw:
    b = launch(pw)
    ctx1 = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    p = page(ctx1)
    p.goto(APP)
    check(p.is_visible('#view button.primary:has-text("New sale")') and p.is_visible('#view button[data-t="import"]:has-text("Update inventory")') and 'Nothing needs you.' in p.inner_text('#view'), 'empty Home still shows New sale and Update inventory')
    p.click('#view button.primary:has-text("New sale")'); p.wait_for_timeout(200)
    check('No products to sell yet' in p.inner_text('#view') and p.is_visible('#view button.primary:has-text("Add a product")'), 'New sale with no products offers Add a product')
    p.click('nav button[data-t="home"]'); p.wait_for_timeout(200)
    check(p.title() == 'Bodega' and json.load(urllib.request.urlopen(f'http://localhost:{APP_PORT}/manifest.webmanifest'))['name'] == 'Bodega', 'document title and manifest name are Bodega')
    check(p.inner_text('#title') == 'Bodega', 'Home header shows the app name when no shop name is set')
    check('on' in p.get_attribute('#tabs button[data-t="home"]', 'class') and [b.inner_text().strip() for b in p.query_selector_all('#tabs button')] == ['Home', 'Inventory', 'Sales', 'Orders'], 'first launch opens Home; the bar is Home, Inventory, Sales, Orders')
    check(all(b.query_selector('svg') for b in p.query_selector_all('#tabs button')), 'each tab has a stroke icon')
    no_toy(p, 'Home (empty)')
    update_stock(p); v = p.inner_text('#view')
    check(p.inner_text('#title') == 'Update inventory' and 'Other ways to change stock' in v and 'One product by hand' in v and 'Add a new product' in v and 'Receive a supplier order' not in v, 'Update inventory with nothing waiting lists the other ways to change stock')
    check(p.is_visible('#impText'), 'with no connection code the paste box is open')
    no_toy(p, 'Update inventory')
    p.click('#view .item:has-text("One product by hand")')
    check(p.inner_text('#title') == 'Stock in and out' and p.is_visible('[data-pk="mv"]'), 'One product by hand opens the Move screen with a picker')
    p.click('#backBtn'); check(p.inner_text('#title') == 'Bodega', 'the close button leaves the Move screen')
    check(p.inner_text('#syncTxt') == 'Local only', 'sync pill says Local only before connecting')
    p.screenshot(path=f'{SHOTS}/01-empty.png')

    # ---- photo count import: new items, skipped row, bad row
    photo = "Hot Wheels 5-Pack\t12\t₱299\t\nBarbie Dreamhouse\t2\t₱5,499\tonly 2 visible\nBlocks 500pc\t?\t\t\nPlush Bear Large\t4\t650\t\nBroken Row\tabc\t\t"
    paste_import(p, 'count', photo)
    txt = p.inner_text('#impOut')
    check(txt.count('New product') == 3, 'preview: 3 new products')
    check('Ready · 3' in txt and 'Needs a name · 2' in txt and '2 rows with no name or no count. They are not recorded.' in txt and 'Skipped' not in txt, 'preview: the skipped (?) and problem (abc) rows are folded under Needs a name')
    p.click('#impOut details[data-grp="name"] summary'); txt = p.inner_text('#impOut')
    check('Skipped' in txt and 'Problem' in txt, 'preview: skipped (?) and problem (abc) rows flagged')
    check('Apply 3 changes' in txt, 'apply button counts only valid rows')
    p.screenshot(path=f'{SHOTS}/02-import-preview.png')
    apply(p, 'Apply 3 changes')
    sm = stock_map(p)
    check(sm == {'Barbie Dreamhouse': 2, 'Hot Wheels 5-Pack': 12, 'Plush Bear Large': 4}, f'stock after photo import: {sm}')
    # Home with toys but no sales yet
    tab(p, 'Home'); home = p.inner_text('#view'); p.screenshot(path=f'{SHOTS}/03a-home.png')
    check('Today\n₱0' in home and 'Month\n₱0' in home and 'Margin\n–' in home and 'invoice' not in home, 'Home with no sales shows the numbers strip with zero sales and no margin')
    check('Restock' not in home and 'Low or out' not in home and 'No products yet' not in home and 'Ship' not in home, 'Home has no low-stock row: a single unit on hand is normal')
    tab(p, 'Inventory')
    check(p.query_selector('#view .seg button[data-f="attn"]') is None and p.query_selector('#stockList .qty.low') is None, 'Stock has no Low filter and no low-stock colour')
    p.screenshot(path=f'{SHOTS}/03-stock.png')

    # ---- second photo: name variant matches, similar name needs confirmation, unchanged row
    paste_import(p, 'count', "Hot Wheels 5 Pack\t10\nBarbie Dreamhouse Playset\t3\nPlush Bear Large\t4")
    txt = p.inner_text('#impOut')
    check('stock 12 → counted 10 (−2)' in txt, 'recount shows delta for exact-normalised name')
    check('Looks like “Barbie Dreamhouse”' in txt and 'Apply 1 change' in txt, 'similar name is held back by default')
    check('No change' in txt, 'unchanged row marked No change')
    p.click('button:has-text("Use “Barbie Dreamhouse”")')
    check('stock 2 → counted 3 (+1)' in p.inner_text('#impOut') and 'Apply 2 changes' in p.inner_text('#impOut'), 'Use similar remaps the row and recomputes')
    p.screenshot(path=f'{SHOTS}/04-import-recount.png')
    apply(p, 'Apply 2 changes')
    sm = stock_map(p)
    check(sm['Hot Wheels 5-Pack'] == 10 and sm['Barbie Dreamhouse'] == 3 and len(sm) == 3, f'stock after recount: {sm}')

    # ---- manual move via Move tab
    p.click('.item:has-text("Hot Wheels 5-Pack")'); p.screenshot(path=f'{SHOTS}/05-item-sheet.png')
    p.click('button:has-text("Stock out")')
    check(p.inner_text('#view .picked').find('Hot Wheels 5-Pack') >= 0, 'Stock out opens Move with the toy preselected')
    p.click('button[aria-label="More"]'); p.click('button[aria-label="More"]')
    check(p.input_value('#mvQty') == '3' and 'Stock 10 → 7' in p.inner_text('#mvHint'), 'stepper and hint show stock 10 → 7')
    p.fill('#mvNote', 'Weekend sale'); p.screenshot(path=f'{SHOTS}/06-move.png')
    p.click('button:has-text("Record stock out")')
    check('on' in p.get_attribute('#tabs button[data-t="stock"]', 'class') and 'Hot Wheels 5-Pack' in p.inner_text('#stockList'), 'recording a movement returns to Inventory')
    check(stock_map(p)['Hot Wheels 5-Pack'] == 7, 'out 3 leaves 7')
    # reloading while on Move lands on Home, not on an empty Move form
    p.click('.item:has-text("Hot Wheels 5-Pack")'); p.click('button:has-text("Stock in")'); p.reload(); p.wait_for_selector('#tabs button')
    check('on' in p.get_attribute('#tabs button[data-t="home"]', 'class') and not p.is_visible('#mvQty'), 'a reload on the Move screen opens Home')

    # ---- out more than stock asks and goes negative
    tab(p, 'Inventory'); p.click('.item:has-text("Plush Bear Large")'); p.click('button:has-text("Stock out")'); p.fill('#mvQty', '6'); p.click('button:has-text("Record stock out")')
    check(stock_map(p)['Plush Bear Large'] == -2, 'oversell is allowed after confirm and shows -2')
    tab(p, 'Inventory'); check('neg' in p.get_attribute('.item:has-text("Plush Bear Large") .qty', 'class'), 'negative stock is styled')

    # ---- activity and reverse
    activity(p); p.screenshot(path=f'{SHOTS}/07-activity.png')
    p.click('.item:has-text("Plush Bear Large"):has-text("−6")'); p.click('button:has-text("Delete")')
    check(stock_map(p)['Plush Bear Large'] == 4, 'deleting an unsynced movement restores stock')
    activity(p); p.click('.item:has-text("Hot Wheels 5-Pack"):has-text("−3")')
    check('Waiting to sync' in p.inner_text('#sheet'), 'unsynced movement says waiting')
    p.click('button[aria-label="Close"]')

    # ---- edit item
    tab(p, 'Inventory'); p.click('.item:has-text("Plush Bear Large")'); p.click('button:has-text("Edit")')
    check(p.query_selector('#fMin') is None, 'the item editor has no reorder level')
    p.fill('#fPrice', '699'); p.click('#sheet button.primary:has-text("Save")')
    check('₱699' in p.inner_text('.item:has-text("Plush Bear Large")'), 'edit saved: new price shows')

    # ---- add item by hand with starting stock; duplicate name refused
    tab(p, 'Inventory'); p.click('button:has-text("Add product")'); p.fill('#fName', 'Toy Train Set'); p.fill('#fStart', '6'); p.click('#sheet button.primary:has-text("Save")')
    check(stock_map(p).get('Toy Train Set') == 6, 'manual item with starting stock 6')
    p.click('button:has-text("Add product")'); p.fill('#fName', 'toy train  set'); p.click('#sheet button.primary:has-text("Save")')
    check('already exists' in p.inner_text('#toast'), 'duplicate name is refused')
    p.click('button[aria-label="Close"]')
    before = stock_map(p)

    # ---- connect: queue flushes into the sheet
    check(p.inner_text('#syncTxt').endswith('saved here'), 'pill counts items saved on the device')
    connect(p); synced(p)
    d = dump()
    check(len(d['Products']['rows']) - 1 == 4, f"sheet has 4 products: {len(d['Products']['rows']) - 1}")
    mv_rows = d['Movements']['rows'][1:]
    check(len(mv_rows) == 27, f'sheet has movement rows, one per unit stocked in: {len(mv_rows)}')
    check(stock_map(p) == before, 'stock unchanged by sync')
    check(any(r[8] == 'Weekend sale' for r in mv_rows), 'note reached the sheet')
    check(all(r[0] and r[1] and r[2] and r[3] for r in mv_rows), 'sheet rows carry id, date, Product ID and product name')
    onh = {r[1]: r[4] for r in d['Products']['rows'][1:]}
    check(onh == before, f'On hand in the sheet is a written number per item: {onh}')
    p.screenshot(path=f'{SHOTS}/08-synced.png')

    # ---- reverse a synced movement
    activity(p); p.click('.item:has-text("Hot Wheels 5-Pack"):has-text("−3")'); p.click('button:has-text("Reverse this movement")')
    check(stock_map(p)['Hot Wheels 5-Pack'] == 10, 'reversal restores 10')
    synced(p)
    activity(p); p.click('.item:has-text("Hot Wheels 5-Pack"):has-text("−3")')
    check(p.is_disabled('button:has-text("Already reversed")'), 'second reversal blocked')
    p.click('button[aria-label="Close"]')
    check(any(r[6] == 'Correction' and r[7] for r in dump()['Movements']['rows'][1:]), 'correction row with Ref is in the sheet')

    # ---- device 2 connects and sees the same numbers
    ctx2 = b.new_context(viewport={'width': 390, 'height': 844}); p2 = page(ctx2, 'p2 ')
    p2.goto(APP); connect(p2); synced(p2)
    check(stock_map(p2) == stock_map(p), f'device 2 matches device 1: {stock_map(p2)}')

    # ---- movements import: dup, unknown item, bad reason, negative warning
    paste_import(p2, 'moves', "2026-11-10\tHot Wheels 5-Pack\tIn\t5\tRestock\tdelivery\n11/12/26\tPlush Bear Large\tOut\t9\tSale\t\n2026-11-12\tHot Wheels 5 Pak\tOut\t1\n2026-11-12\tToy Train Set\tIn\t2\tSale\n2026-11-13\tToy Train Set\tOut\t1")
    txt = p2.inner_text('#impOut'); p2.screenshot(path=f'{SHOTS}/09-moves-preview.png')
    check('Below zero' in txt and 'No product matches “Hot Wheels 5 Pak”' in txt and 'Sale cannot be recorded as In' in txt, 'moves preview flags below-zero, unknown item, bad reason')
    check('Apply 3 changes' in txt, 'moves preview applies the 3 good rows')
    apply(p2, 'Apply 3 changes'); synced(p2)
    check(stock_map(p2)['Hot Wheels 5-Pack'] == 15 and stock_map(p2)['Toy Train Set'] == 5, f'stock after movement import: {stock_map(p2)}')
    paste_import(p2, 'moves', "2026-11-10\tHot Wheels 5-Pack\tIn\t5\tRestock\tdelivery")
    check('Duplicate?' in p2.inner_text('#impOut') and 'Apply 0 changes' in p2.inner_text('#impOut'), 'pasting the same movement again is held as a duplicate')

    # ---- device 1 catches up
    p.click('#syncBtn'); synced(p)
    check(stock_map(p) == stock_map(p2), 'device 1 pulls device 2 changes incrementally')

    # ---- offline: queue then reconnect
    ctx1.set_offline(True)
    tab(p, 'Inventory'); p.click('.item:has-text("Plush Bear Large")'); p.click('button:has-text("Stock out")'); p.click('button:has-text("Change")')
    p.click('button[data-d="In"]'); p.fill('[data-pk="mv"]', 'train'); p.click('[data-sug="mv"] button')
    check('Toy Train Set' in p.inner_text('#view .picked') and p.is_visible('button:has-text("Record stock in")'), 'Change on the Move screen lets another toy be searched and picked')
    p.click('button:has-text("Record stock in")')
    p.wait_for_timeout(1500)
    check(stock_map(p)['Toy Train Set'] == 6 and 'waiting' in p.inner_text('#syncTxt') or 'failed' in p.inner_text('#syncTxt'), f"offline entry is kept ({p.inner_text('#syncTxt')})")
    ctx1.set_offline(False); p.click('#syncBtn'); synced(p)
    p2.click('#syncBtn'); synced(p2)
    check(stock_map(p2)['Toy Train Set'] == 6, 'offline entry reached device 2 after reconnect')

    def add_toy(pg, name, start):
        tab(pg, 'Inventory'); pg.click('button:has-text("Add product")'); pg.fill('#fName', name); pg.fill('#fStart', str(start))
        pg.click('#sheet button.primary:has-text("Save")')

    # ---- two phones invent the same next Product ID: the second is renumbered, nobody is credited wrongly
    add_toy(p, 'Dino Figure', 2); synced(p)
    sku_dino = [r[0] for r in dump()['Products']['rows'][1:] if r[1] == 'Dino Figure'][0]
    ctx2.set_offline(True)
    add_toy(p2, 'Robot Kit', 3)
    local_sku = p2.evaluate("live().list.find(i => i.name === 'Robot Kit').sku")
    check(sku_dino in local_sku, f'both phones picked the same SKU {sku_dino} ({local_sku})')
    ctx2.set_offline(False); p2.click('#syncBtn'); synced(p2); p.click('#syncBtn'); synced(p)
    items = {r[1]: r[0] for r in dump()['Products']['rows'][1:]}
    check(items['Dino Figure'] == sku_dino and items['Robot Kit'] != sku_dino, f'Robot Kit renumbered: {items}')
    check(stock_map(p2)['Dino Figure'] == 2 and stock_map(p2)['Robot Kit'] == 3, f'no cross-credit on device 2: {stock_map(p2)}')
    check(stock_map(p) == stock_map(p2), 'devices agree after renumbering')

    # ---- a product the sheet refuses (a name over 120 characters) takes its stock entries down with it, not onto the product that owns its Product ID
    add_toy(p, 'Lego Castle', 7); synced(p)
    long_name = 'Lego Castle' + ' with every extra piece' * 6
    ctx2.set_offline(True); add_toy(p2, long_name, 4); ctx2.set_offline(False)
    p2.click('#syncBtn'); p2.wait_for_timeout(1500)
    check('need attention' in p2.inner_text('#syncTxt'), f"refused entries flagged ({p2.inner_text('#syncTxt')})")
    tab(p2, 'Home'); check('Fix 5 entries the sheet refused' in p2.inner_text('#view'), 'Home flags the refused entries: the item and its four units')
    p2.click('#view .item:has-text("the sheet refused")'); p2.screenshot(path=f'{SHOTS}/10-failed.png')
    check(f'New product “{long_name}” was refused: Name is too long.' in p2.inner_text('#view'), 'activity says which product was refused and why, with no Product ID')
    check(not any(r[1] == long_name for r in dump()['Products']['rows']) and not any(r[3] == long_name for r in dump()['Movements']['rows']), 'sheet has neither the product nor its stock entries')
    p2.click('#view .banner.bad button:has-text("Delete")'); synced(p2)
    check(stock_map(p2)['Lego Castle'] == 7 and long_name not in stock_map(p2), f"after Delete, Lego Castle stays at 7 and the refused product is gone: {stock_map(p2)}")

    # ---- Inbox: Claude appends rows to the sheet; the app shows them under Import to apply or dismiss
    p.click('#syncBtn'); synced(p); before = stock_map(p)
    post_inbox([
        {'added': '2026-11-15', 'type': 'Count', 'name': 'Hot Wheels 5-Pack', 'qty': 20, 'brand': 'Mattel', 'line': 'Hot Wheels'},
        {'added': '2026-11-15', 'type': 'Count', 'name': 'Inbox Robot', 'qty': 3, 'mfr': 'Bandai', 'rel': '2024-05', 'verify': 'Y', 'note': 'box only'},
        {'added': '2026-11-15', 'type': 'Count', 'name': 'Lego Castle Big', 'qty': 9},
        {'added': '2026-11-15', 'type': 'Receive', 'name': 'Dino Figure', 'qty': 2, 'cost': 150},
        {'added': '', 'type': 'Receive', 'name': 'Inbox Car', 'qty': 1, 'cost': '80', 'brand': 'Tomica'},
    ])
    tab(p, 'Inventory'); p.click('#syncBtn'); synced(p)
    check(p.inner_text('#toast') == '5 rows from Claude to review', f"a toast says rows arrived: {p.inner_text('#toast')!r}")
    check(update_label(p) == 'Update inventory · 5', 'the Home button shows the waiting count')
    check('Review 5 rows from Claude\nRead from your photos, not recorded yet' in p.inner_text('#view'), 'Home lists the rows from Claude')
    p.click('#view .item:has-text("Review 5 rows from Claude")')
    txt = p.inner_text('#view'); p.screenshot(path=f'{SHOTS}/11-inbox.png')
    check('Claude read 3 rows' in txt and '2 more after these' in txt and not p.is_visible('#impText') and [h.inner_text() for h in p.query_selector_all('#impOut .sec > h2')] == ['Check these · 2', 'Ready · 1'], 'Update inventory opens on the count rows from Claude, receive rows after them, grouped')
    check(p.inner_text('#impOut .grp-check') .count('Inbox Robot') == 1 and 'Lego Castle Big' in p.inner_text('#impOut .grp-check') and 'Hot Wheels 5-Pack' in p.inner_text('#impOut .grp-ready'), 'a release date to verify and a similar name are under Check these')
    check(f"stock {before['Hot Wheels 5-Pack']} → counted 20" in txt and 'adds brand, product line' in txt, 'existing toy: count difference and the details it adds')
    check('Inbox Robot' in txt and 'opening stock 3' in txt and 'released 2024-05 (to verify)' in txt, 'new toy from Claude with its details')
    check('Looks like “Lego Castle”' in txt and 'Apply 2 changes' in txt, 'a similar-but-not-equal name is held back unticked')
    p.click('button:has-text("Use “Lego Castle”")')
    check(f"stock {before['Lego Castle']} → counted 9" in p.inner_text('#impOut') and 'Apply 3 changes' in p.inner_text('#impOut'), 'Use … maps the row onto the toy on file')
    p.click('.prow:has-text("Inbox Robot") input[type=checkbox]')
    check('Apply 2 changes' in p.inner_text('#impOut'), 'unticking a row')
    p.click('#syncBtn'); synced(p)
    check('Apply 2 changes' in p.inner_text('#impOut') and not p.is_checked('.prow:has-text("Inbox Robot") input[type=checkbox]'), 'ticks survive a sync that redraws the screen')
    p.click('.prow:has-text("Inbox Robot") input[type=checkbox]'); apply(p, 'Apply 3 changes')
    txt = p.inner_text('#view')
    check(p.inner_text('#title') == 'Update inventory' and 'Claude read 2 rows' in txt and 'Dino Figure: +2 at ₱150 each' in txt and 'Inbox Car' in txt and 'Apply 2 changes' in txt, 'the receive rows from Claude come up next')
    check(p.evaluate('live().inbox.length') == 2, 'the waiting count drops at once')
    synced(p); inbox = dump()['Inbox']['rows'][1:]
    check([r[12] for r in inbox] == ['Done', 'Done', 'Done', '', ''], f'applied rows are marked Done in the sheet: {[r[12] for r in inbox]}')
    it = {r[1]: r for r in dump()['Products']['rows'][1:]}
    check(it['Hot Wheels 5-Pack'][6:8] == ['Mattel', 'Hot Wheels'] and it['Inbox Robot'][5] == 'Bandai' and it['Inbox Robot'][9:11] == ['2024-05', 'Verify'], 'details from Claude reached the sheet')
    sm = stock_map(p); check(sm['Hot Wheels 5-Pack'] == 20 and sm['Inbox Robot'] == 3 and sm['Lego Castle'] == 9, f'counts from Claude recorded: {sm}')
    update_stock(p); apply(p, 'Apply 2 changes')
    check('on' in p.get_attribute('#tabs button[data-t="stock"]', 'class'), 'after the last group from Claude the app goes to Inventory')
    check(update_label(p) == 'Update inventory', 'nothing left waiting')
    synced(p); sm = stock_map(p)
    check(sm['Dino Figure'] == before['Dino Figure'] + 2 and sm['Inbox Car'] == 1, f'received stock recorded: {sm}')
    mv = dump()['Movements']['rows'][1:]
    check(sorted(r[9] for r in mv if r[6] == 'Restock' and r[3] in ('Dino Figure', 'Inbox Car')) == [80, 150, 150], 'receive rows carry their cost, one row per unit')
    check([r[12] for r in dump()['Inbox']['rows'][1:]] == ['Done'] * 5, 'all rows Done in the sheet')
    update_stock(p); check('Other ways to change stock' in p.inner_text('#view') and not p.is_visible('#impText'), 'Update inventory is back to the other ways; with a connection the paste box is folded')
    # Dismiss records nothing
    n_items, n_moves = len(dump()['Products']['rows']), len(dump()['Movements']['rows'])
    post_inbox([{'type': 'Count', 'name': 'Dismiss Me', 'qty': 5}, {'type': 'count', 'name': 'Hot Wheels 5-Pack', 'qty': 1}])
    p.click('#syncBtn'); synced(p); update_stock(p)
    check('Claude read 2 rows' in p.inner_text('#view'), 'new rows from Claude show')
    p.click('#view button[data-act="inboxDismiss"]'); synced(p)
    check('Other ways to change stock' in p.inner_text('#view') and [r[12] for r in dump()['Inbox']['rows'][1:]][-2:] == ['Dismissed', 'Dismissed'], f"Dismiss marks the rows Dismissed: {[r[12] for r in dump()['Inbox']['rows'][1:]]} {p.inner_text('#view')[:200]!r}")
    check(len(dump()['Products']['rows']) == n_items and len(dump()['Movements']['rows']) == n_moves and stock_map(p)['Hot Wheels 5-Pack'] == 20, 'Dismiss records nothing')

    # the same item counted in three photos is added into one count; the '?' row stays apart and keeps waiting
    post_inbox([{'type': 'Count', 'name': 'Hot Wheels 5-Pack', 'qty': 12}, {'type': 'Count', 'name': 'hot wheels 5 pack', 'qty': 9, 'note': 'second shelf'}, {'type': 'Count', 'name': 'Hot Wheels 5-Pack', 'qty': '?'}])
    p.click('#syncBtn'); synced(p); update_stock(p); txt = p.inner_text('#impOut')
    check('stock 20 → counted 21 (+1)' in txt and 'Apply 1 change' in txt and 'Listed twice' not in txt, f'rows for one toy are summed: {txt[:120]}')
    apply(p, 'Apply 1 change'); synced(p)
    check(stock_map(p)['Hot Wheels 5-Pack'] == 21 and [r[12] for r in dump()['Inbox']['rows'][1:]][-3:] == ['Done', 'Done', ''], 'summed count applied; the two counted rows are Done and the ? row still waits')

    # ---- Inventory has the Activity link; Activity and Inventory read without the word
    tab(p, 'Inventory'); no_toy(p, 'Inventory'); p.click('#view button.tbtn:has-text("Activity")')
    check(p.inner_text('#title') == 'Activity' and 'on' in p.get_attribute('#tabs button[data-t="stock"]', 'class') and p.is_visible('#actList .sec'), 'the Activity link on Inventory opens the movement log, grouped by day')
    no_toy(p, 'Activity'); p.click('#backBtn'); check(p.inner_text('#title') == 'Inventory', 'closing Activity returns to Inventory')
    p.click('.item:has-text("Hot Wheels 5-Pack")'); no_toy(p, 'a product sheet'); p.click('button[aria-label="Close"]')
    post_inbox([{'type': 'Count', 'name': 'Hot Wheels 5-Pack', 'qty': 22}]); p.click('#syncBtn'); synced(p); update_stock(p); no_toy(p, 'Update inventory with rows')
    p.click('#view button[data-act="inboxDismiss"]'); synced(p)

    # ---- 2.2 review: groups, corrections, only recorded rows leave the Inbox, result sheet, fresh content, warnings
    rows_post = [{'added': '2026-11-16', 'type': 'Count', 'name': 'Fresh Box', 'qty': 2}, {'added': '2026-11-16', 'type': 'Count', 'name': 'Fresh Box', 'qty': 3},
                 {'added': '2026-11-16', 'type': 'Count', 'name': 'Unidentified figure, blue', 'qty': 1}, {'added': '2026-11-16', 'type': 'Count', 'name': 'Mystery', 'qty': '?'},
                 {'added': '2026-11-16', 'type': 'Count', 'name': 'Keep Me', 'qty': 4}, {'added': '2026-11-16', 'type': 'Count', 'name': 'Hot Wheels 5-Pack', 'qty': 21}]
    post_inbox(rows_post + [{'added': '2026-11-16', 'type': 'Count', 'name': f'Bulk {i}', 'qty': 1} for i in range(1, 11)])
    p.click('#syncBtn'); synced(p); update_stock(p); txt = p.inner_text('#impOut'); p.screenshot(path=f'{SHOTS}/12-review-groups.png')
    check([h.inner_text() for h in p.query_selector_all('#impOut .sec > h2')] == ['Check these · 1', 'Ready · 12', 'Needs a name · 2'], 'review grouped: Check these, Ready, Needs a name, each with its row count')
    first = dump()['Inbox']['rows'].index(next(r for r in dump()['Inbox']['rows'] if r[2] == 'Fresh Box')) + 1
    check(f'Possibly the same box in two photos: 5 in all, row {first} has 2, row {first + 1} has 3' in txt, 'the same new name on two rows is summed and shows each source row')
    check(not p.is_visible('#impOut .grp-ready .prow') and '11 new products, 1 already right' in txt and not p.is_visible('#impOut .grp-name .prow'), 'Ready (more than 8) and Needs a name start folded, Ready says what it holds')
    check('Apply 13 changes' in txt, 'Apply counts the ticked rows, including the count that is already right')
    bar = p.eval_on_selector('.applybar', 'e => [getComputedStyle(e).position, Math.round(e.getBoundingClientRect().bottom), innerHeight, Math.round(document.querySelector("nav.tabs").getBoundingClientRect().top)]')
    check(bar[0] == 'sticky' and bar[1] <= bar[3] + 1, f'Apply stays at the bottom of the screen above the tab bar: {bar}')
    p.click('#impOut details[data-grp="ready"] summary'); p.click('.prow:has-text("Keep Me") input[type=checkbox]')
    check('Apply 12 changes' in p.inner_text('#impOut'), 'unticking a Ready row')
    # correct a row that needs a name; it moves to Ready
    p.click('#impOut details[data-grp="name"] summary'); p.click('#impOut .prow:has-text("Mystery") button[data-act="impFix"]')
    check(p.input_value('#fxName') == 'Mystery' and p.input_value('#fxCount') == '?' and 'stays as Claude wrote it' in p.inner_text('#sheet'), 'tapping a row opens the correction sheet with Name, Count and Release date')
    p.fill('#fxCount', 'x'); p.click('#sheet button:has-text("Save")'); check('whole number' in p.inner_text('#toast'), 'a count that is not a whole number is refused')
    p.fill('#fxName', 'Mystery Robot'); p.fill('#fxCount', '2'); p.fill('#fxRel', '2023'); p.click('#sheet button:has-text("Save")')
    heads = [h.inner_text() for h in p.query_selector_all('#impOut .sec > h2')]
    check(heads == ['Check these · 1', 'Ready · 13', 'Needs a name · 1'] and 'Corrected here' in p.inner_text('#impOut .grp-ready') and 'Apply 13 changes' in p.inner_text('#impOut'), f'a corrected row with a name and a whole count moves to Ready: {heads}')
    p.click('#impOut .prow:has-text("Fresh Box") button[data-act="impFix"]'); p.fill('#fxCount', '4'); p.click('#sheet button:has-text("Save")')
    check('opening stock 4' in p.inner_text('#impOut .grp-check'), 'the corrected count is what will be recorded')
    # the sheet changes a row while the review is open: the next sync shows it as it is now, corrections on other rows stay
    ib = dump()['Inbox']['rows'][1:]
    for r in ib:
        if r[2] == 'Bulk 1': r[3] = '7'
    post_rows('Inbox', ib)
    p.click('#syncBtn'); synced(p)
    check('opening stock 7' in p.inner_text('.prow:has-text("Bulk 1")') and 'Corrected here' in p.inner_text('#impOut') and 'opening stock 4' in p.inner_text('#impOut .grp-check'), f"a row edited in the sheet shows its new content after a sync; corrections stay: {p.inner_text('#impOut')[:900]!r}")
    check(not p.is_checked('.prow:has-text("Keep Me") input[type=checkbox]'), 'an untick survives that sync')
    p.click('button:has-text("Apply 13 changes")'); p.wait_for_selector('#sheet h2:has-text("Applied")')
    sh_txt = p.inner_text('#sheet')
    check('Recorded: 12 new products, 0 count changes, 0 products with new details.' in sh_txt and 'Left in the Inbox: 1 row that needs a name; 1 row you unticked.' in sh_txt, f'the result sheet says what was recorded and what was left: {sh_txt!r}')
    p.wait_for_function("document.querySelector('#resSync') && document.querySelector('#resSync').textContent === 'Synced with the sheet.'", timeout=8000)
    p.wait_for_timeout(400); check(p.is_visible('#sheet h2:has-text("Applied")'), 'the result stays open after the sync, saying it has synced'); p.screenshot(path=f'{SHOTS}/13-result.png')
    p.click('#sheet .btn[data-act="close"]')
    st = {r[2]: r[12] for r in dump()['Inbox']['rows'][1:] if r[0] == '2026-11-16'}
    check(st == {'Fresh Box': 'Done', 'Unidentified figure, blue': '', 'Mystery': 'Done', 'Keep Me': '', 'Hot Wheels 5-Pack': 'Done', **{f'Bulk {i}': 'Done' for i in range(1, 11)}}, f'only the recorded rows are Done in the Inbox: {st}')
    it = {r[1]: r for r in dump()['Products']['rows'][1:]}
    check(it['Fresh Box'][4] == 4 and it['Mystery Robot'][9] == '2023' and 'Mystery' not in it and it['Bulk 1'][4] == 7 and 'Keep Me' not in it, 'the corrected values are what was recorded')
    check(any(r[2] == 'Mystery' and r[3] == '?' for r in dump()['Inbox']['rows']), 'the correction was not written back to the Inbox tab')
    check('Claude read 2 rows' in p.inner_text('#view'), 'the rows left in the Inbox show again')
    p.click('#view button[data-act="inboxDismiss"]'); synced(p)
    check([v for k, v in {r[2]: r[12] for r in dump()['Inbox']['rows'][1:] if r[0] == '2026-11-16'}.items() if k in ('Keep Me', 'Unidentified figure, blue')] == ['Dismissed', 'Dismissed'], 'Dismiss these rows marks everything shown')
    # warnings from the sheet: a banner on Home under the buttons, gone once fixed
    items_rows = dump()['Products']['rows'][1:]
    post_rows('Products', items_rows + [items_rows[0]]); tab(p, 'Home'); p.click('#syncBtn'); synced(p)
    warn = f'Products: Product ID {items_rows[0][0]} appears on 2 rows. The first is used.'
    check(p.inner_text('#view .banner.danger') == warn and p.evaluate("getComputedStyle(document.querySelector('.banner.danger')).color") == p.evaluate("getComputedStyle(document.querySelector('.banner.danger')).borderTopColor"), 'a warning from the sheet shows on Home in the danger colour')
    check(p.evaluate("document.querySelector('.banner.danger').previousElementSibling.classList.contains('actions')"), 'the banner sits under the buttons'); p.screenshot(path=f'{SHOTS}/14-warning.png')
    post_rows('Products', items_rows); p.click('#syncBtn'); synced(p)
    check(p.query_selector('#view .banner.danger') is None, 'no banner when the sheet reports no warnings')

    # ---- theme: Device, Light or Dark, set in Settings only, kept on the device
    bg = lambda pg: pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toUpperCase()")
    check(p.query_selector('header [data-act="theme"]') is None and p.evaluate("document.documentElement.getAttribute('data-theme')") is None, 'no theme control in the header; Device leaves data-theme unset')
    tab(p, 'Home'); p.click('button[aria-label="Settings"]'); no_toy(p, 'Settings')
    check([h.inner_text() for h in p.query_selector_all('#sheet .sec > h2')] == ['Connection', 'Invoice image', 'Preferences', 'Data'], 'Settings is grouped under four headings')
    p.click('#sheet button[data-act="theme"][data-v="dark"]')
    check(p.evaluate("document.documentElement.getAttribute('data-theme')") == 'dark' and bg(p) == '#0D0D0D', 'Dark sets data-theme and the dark tokens')
    p.reload(); p.wait_for_selector('#tabs button')
    check(p.evaluate("document.documentElement.getAttribute('data-theme')") == 'dark' and p.evaluate("[...document.querySelectorAll('meta[name=theme-color]')].every(m => m.content === '#0D0D0D')"), 'the choice survives a reload, theme-color follows')
    p.click('button[aria-label="Settings"]'); p.click('#sheet button[data-act="theme"][data-v="auto"]')
    check(p.evaluate("document.documentElement.getAttribute('data-theme')") is None and bg(p) == '#FAFAFA', 'Device removes data-theme and follows the light device')
    p.click('button[aria-label="Close"]')
    for scheme, want in [('dark', '#0D0D0D'), ('light', '#FAFAFA')]:
        cx = b.new_context(color_scheme=scheme); pp = page(cx, 'theme '); pp.goto(APP); pp.wait_for_selector('#tabs button')
        check(bg(pp) == want, f'Device follows a {scheme} device: {bg(pp)}')
        pp.evaluate("prefs.theme = '" + ('light' if scheme == 'dark' else 'dark') + "'; savePrefs()"); pp.reload(); pp.wait_for_selector('#tabs button')
        check(bg(pp) == ('#FAFAFA' if scheme == 'dark' else '#0D0D0D'), f'an explicit choice overrides a {scheme} device')
        cx.close()

    # ---- wrong key
    p3 = b.new_context().new_page(); p3.goto(APP); connect(p3, f'{API}/exec#wrongkey'); p3.wait_for_timeout(800)
    check('Wrong key' in p3.inner_text('#toast'), 'wrong key is reported')

    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
