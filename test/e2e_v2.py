# End-to-end test of the v2 flows: toy details, receipt cost, supplier orders, pre-orders, invoices with the image, returns.
# python3 test/e2e_v2.py  (needs static server on 8765, mock backend on 8766, Chrome)
import datetime, os, re
from playwright.sync_api import sync_playwright
from common import *

SHOTS = '/tmp/shots2'
os.makedirs(SHOTS, exist_ok=True)
TODAY = datetime.date.today().isoformat()
def png_size(data):
    """Width and height from a PNG's IHDR chunk, or None when the bytes are not a PNG."""
    return (int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')) if data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR' else None
def save_img(p, name, blocked=False):
    """Taps Save image. Normally the PNG opens in a new tab (returns 'tab'); with blocked=True no tab can open,
    so the file downloads instead (returns its file name). Also returns the image's width and height."""
    path = f'{SHOTS}/{name}.png'
    if blocked:
        p.evaluate("() => { window.__open = window.open; window.open = () => null; }")
        with p.expect_download() as d: p.click('button:has-text("Save image")')
        d.value.save_as(path); got = d.value.suggested_filename
        p.evaluate("() => { window.open = window.__open; }")
    else:
        with p.expect_popup() as pop: p.click('button:has-text("Save image")')
        t = pop.value; t.wait_for_url('blob:**')
        data = t.evaluate("async () => Array.from(new Uint8Array(await (await fetch(location.href)).arrayBuffer()))")
        t.close(); open(path, 'wb').write(bytes(data)); got = 'tab'
    return got, png_size(open(path, 'rb').read())

with sync_playwright() as pw:
    b = launch(pw)
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, accept_downloads=True)
    p = page(ctx)
    p.goto(APP); connect(p); synced(p)

    # ---- photo import carries the toy details; the release-date flag is its own field
    T = '\t'
    paste_import(p, 'count', T.join(['Grandista Son Goku', '2', '', '', 'Bandai Spirits', 'Banpresto', 'Grandista', 'Son Goku', '2019-06', 'Y']) + '\n'
        + T.join(['Maximatic Luffy', '1', '', 'name guessed from artwork', 'Bandai Spirits', 'Banpresto', 'Maximatic', 'Monkey D. Luffy', 'sometime', '']) + '\n'
        + 'Plain Toy\t1')
    txt = p.inner_text('#impOut'); p.screenshot(path=f'{SHOTS}/01-import-details.png')
    check('Banpresto / Grandista / Son Goku · released 2019-06 (to verify)' in txt, 'preview shows brand, line, character and the verify flag')
    check('Release date “sometime” not understood' in txt and 'Apply 3 changes' in txt, 'an unreadable release date is left blank, row still applies')
    apply(p, 'Apply 3 changes'); synced(p)
    it = {r[1]: r for r in rows('Products')}
    check(it['Grandista Son Goku'][5:11] == ['Bandai Spirits', 'Banpresto', 'Grandista', 'Son Goku', '2019-06', 'Verify'], f"details reached the sheet: {it['Grandista Son Goku'][5:11]}")
    check(it['Maximatic Luffy'][9:11] == ['', ''], 'no release date, no flag')
    h = home(p); p.screenshot(path=f'{SHOTS}/01a-home.png')
    titles = [e.inner_text() for e in p.query_selector_all('#view .sec:has-text("Needs you") .item .name')]
    check(titles == ['Price 3 products', 'Add the cost of 4 units', 'Check 1 release date'] and p.inner_text('#view .badge') == '3', f'Home: Needs you rows in their fixed order, badge counts rows: {titles}')
    check('Price 3 products\nA sale needs the price typed each time' in h and 'See ' not in h, 'each row is an action with a second line; three rows need no See more')
    check('Collect' not in h and 'supplier order' not in h and 'promised beyond supply' not in h and 'Ship' not in h, 'Home leaves out rows that are zero')
    p.click('#view .item:has-text("Check 1 release date")')
    check('on' in p.get_attribute('#tabs button[data-t="stock"]', 'class') and 'Showing only: Release date to verify' in p.inner_text('#view') and stock_names(p) == ['Grandista Son Goku'], 'the verify row opens Stock with its filter named')
    p.click('#view button:has-text("Show all")')
    check('Showing only' not in p.inner_text('#view') and len(stock_names(p)) == 3, 'Show all clears the filter')
    home(p); p.click('#view .item:has-text("Price 3 products")')
    check('Showing only: No price yet' in p.inner_text('#view') and len(stock_names(p)) == 3, 'the no-price row opens Stock filtered')
    p.click('#view .seg button[data-f="out"]')
    check('Showing only' not in p.inner_text('#view') and p.get_attribute('#view .seg button[data-f="out"]', 'class') == 'on', 'a filter tab replaces the special filter')
    p.click('#view .seg button[data-f="all"]')
    tab(p, 'Inventory'); p.click('.item:has-text("Grandista Son Goku")'); sheet = p.inner_text('#sheet')
    check('Banpresto' in sheet and 'to verify' in sheet and '2 units have no cost yet.' in sheet, 'toy sheet shows details, flag and the units with no cost')
    p.screenshot(path=f'{SHOTS}/02-toy-sheet.png')
    p.click('button:has-text("Edit")'); p.fill('#fPrice', '1800'); p.uncheck('#fRelCheck'); p.fill('#fRel', '2019-06-20'); p.click('#sheet button.primary:has-text("Save")'); synced(p)
    it = {r[1]: r for r in rows('Products')}
    check(it['Grandista Son Goku'][2] == 1800 and it['Grandista Son Goku'][9:11] == ['2019-06-20', ''], 'edit clears the flag and sets the verified date')

    # ---- a later paste fills blank details only, and never overwrites what is on file
    paste_import(p, 'count', T.join(['Plain Toy', '1', '', '', 'Sega', 'Gigo', '', 'Zoro', '2023', '']) + '\n' + T.join(['Grandista Son Goku', '2', '', '', 'Other Maker', '', '', '', '', '']))
    txt = p.inner_text('#impOut')
    check('Details' in txt and 'adds manufacturer, brand, character, release date' in txt and 'Apply 1 change' in txt, 'blank details are offered, existing ones are not')
    apply(p, 'Apply 1 change'); synced(p)
    it = {r[1]: r for r in rows('Products')}
    check(it['Plain Toy'][5:7] == ['Sega', 'Gigo'] and it['Grandista Son Goku'][5] == 'Bandai Spirits', 'details filled without overwriting')

    # ---- receive mode: supplier paperwork adds stock at its cost, one unit per row
    paste_import(p, 'receive', 'Grandista Son Goku\t3\t1,200\nGigo Zoro\t2\t900\tSega\tGigo\t\tRoronoa Zoro\t2023-11\t\nBad Row\tx\t5')
    txt = p.inner_text('#impOut'); p.screenshot(path=f'{SHOTS}/03-receive-preview.png')
    check('+3 at ₱1,200 each' in txt and 'New product' in txt and 'Needs a name · 1' in txt and 'Apply 2 changes' in txt, 'receive preview')
    p.click('#impOut details[data-grp="name"] summary'); check('Problem' in p.inner_text('#impOut') and 'must be a whole number' in p.inner_text('#impOut'), 'the bad receive row is under Needs a name')
    apply(p, 'Apply 2 changes'); synced(p)
    sm = stock_map(p)
    check(sm['Grandista Son Goku'] == 5 and sm['Gigo Zoro'] == 2, f'stock after receiving: {sm}')
    mv = [r for r in rows('Movements') if r[6] == 'Restock']
    check(sorted(r[9] for r in mv) == [900, 900, 1200, 1200, 1200] and {r[5] for r in mv} == {1}, f'cost recorded on each unit received: {[r[9] for r in mv]}')
    p.click('.item:has-text("Grandista Son Goku")')
    check([e.input_value() for e in p.query_selector_all('#sheet [data-unit]')] == ['', '', '1200', '1200', '1200'] and 'Cost of stock on hand ₱3,600. 2 units have no cost yet.' in p.inner_text('#sheet'), 'the item sheet lists the units on hand, oldest first, with their costs'); close(p)

    # ---- supplier order counts as incoming (test/supply.py covers ordering and receiving)
    tab(p, 'Inventory'); p.click('.item:has-text("Maximatic Luffy")'); p.click('#sheet button:has-text("Order stock")')
    p.click('#impOut [data-act="impFix"]'); p.fill('#fxCount', '4'); p.click('#sheet button:has-text("Save")')
    p.fill('#oSup', 'Kanto Hobby'); p.fill('#oExp', TODAY); p.screenshot(path=f'{SHOTS}/04-supplier-order.png'); apply(p, 'Apply 1 change'); synced(p)
    check([r[5:8] + r[9:12:2] for r in rows('Supplier orders')] == [['T0002', 'Maximatic Luffy', 4, TODAY, 'Ordered']], f"supplier order line in the sheet: {rows('Supplier orders')}")
    tab(p, 'Inventory'); check('4 arriving' in p.inner_text('.item:has-text("Maximatic Luffy")'), 'stock list shows incoming')
    check('Receive 1 supplier order line due\nMaximatic Luffy' in home(p), 'Home: a supplier order line expected today is due')
    home(p); check(not p.is_visible('#view button:has-text("pre-order")'), 'Home has no New pre-order button')
    p.click('#view button:has-text("New sale")')
    check('on' in p.get_attribute('#tabs button[data-t="sell"]', 'class') and p.inner_text('#title') == 'New sale' and p.is_visible('button:has-text("Issue invoice no. 1")'), 'New sale on Home opens the form')

    # ---- customer pre-order: partial payment, receipt image, no stock movement, four numbers
    n_moves = len(rows('Movements'))
    pick(p, 'inv.lines.0', 'luffy'); p.fill('[data-b="inv.lines.0.price"]', '1500')
    check(not p.is_visible('#invNotice') and p.is_visible('#iCust') and not p.is_visible('#iPaid') and 'Takes 1 Maximatic Luffy out of stock and opens the invoice.' == p.inner_text('#invHint'), 'one in stock and one wanted: the form is a sale and says what the tap does')
    p.fill('[data-b="inv.lines.0.qty"]', '2')
    v = p.inner_text('#sellBody')
    check('Only 1 is free to sell, so this is saved as a pre-order' in v and 'Stock moves when the product arrives and you invoice it.' in v and p.is_visible('#iPaid') and not p.is_visible('button:has-text("Add another product")'), 'more than is free to sell: notice, Paid now, no Add another item')
    check(p.is_visible('button:has-text("Save pre-order · receipt no. 1")') and p.evaluate('document.activeElement.dataset.b') == 'inv.lines.0.qty', 'the button saves a pre-order; the quantity field keeps focus through the redraw')
    no_toy(p, 'New sale in pre-order mode')
    p.click('button:has-text("Save pre-order")'); check('customer’s name' in p.inner_text('#toast'), 'pre-order needs a name')
    p.fill('[data-b="inv.cust"]', 'Ana Reyes'); p.click('button:has-text("Save pre-order")'); check('phone or Messenger' in p.inner_text('#toast'), 'pre-order needs a contact')
    p.fill('[data-b="inv.contact"]', '+63 917 000 0000'); p.fill('[data-b="inv.paid"]', '1000')
    check(p.inner_text('#invTotal') == '₱3,000' and p.inner_text('#invBal') == '₱2,000' and 'Balance when it arrives' in p.inner_text('#sellBody'), 'the form shows the total and the balance when it arrives')
    p.screenshot(path=f'{SHOTS}/05-preorder-form.png')
    p.click('button:has-text("Save pre-order · receipt no. 1")')
    sheet = p.inner_text('#sheet'); p.screenshot(path=f'{SHOTS}/06-receipt.png')
    check('Pre-order receipt no. 1' in sheet and 'Paid ₱1,000 · balance ₱2,000' in sheet, 'receipt opens straight after saving')
    name, size = save_img(p, 'receipt-1', blocked=True)
    check(name == 'Receipt-1.png' and size and size[0] == 1190 and size[1] <= 2048, f'with no tab allowed, the receipt image downloads as a valid PNG 1190 px wide: {name} {size}')
    close(p); synced(p)
    check(len(rows('Movements')) == n_moves, 'pre-order moved no stock')
    pre = rows('Pre-orders')[0]
    check(pre[3:5] == ['Ana Reyes', '+63 917 000 0000'] and pre[7:12] == [2, 1500, 1000, 2000, 'Open'] and pre[13] == 1, f'pre-order row: {pre}')
    check(rows('Customers')[0][1:3] == ['Ana Reyes', '+63 917 000 0000'], 'customer kept in its own tab, phone stored as text')
    check(rows('Invoices')[0][0] == 1 and rows('Invoices')[0][3] == 'Pre-order receipt', 'receipt took number 1')
    tab(p, 'Inventory'); p.click('.item:has-text("Maximatic Luffy")'); sheet = p.inner_text('#sheet')
    check(re.search(r'On hand\s+1\s+Incoming\s+4\s+Owed\s+2\s+Left to promise\s+3', sheet) is not None, f'four numbers: on hand 1, incoming 4, owed 2, left to promise 3')
    check(not p.is_visible('#sheet button:has-text("Pre-order")') and p.is_visible('#sheet button:has-text("Sell")') and p.is_visible('#sheet button:has-text("Order stock")'), 'an item sheet has Sell and Order stock, no Pre-order button')
    p.screenshot(path=f'{SHOTS}/07-four-numbers.png'); close(p)
    # the one on hand is owed to Ana: a new sale of it becomes a pre-order until "It is here, sell it now"
    new_sale(p); pick(p, 'inv.lines.0', 'luffy')
    check('The 1 on hand is owed to earlier pre-orders, so this is saved as a pre-order' in p.inner_text('#sellBody'), 'owed-to-earlier-pre-orders notice')
    p.click('button:has-text("It is here, sell it now")')
    check(p.is_visible('button:has-text("Issue invoice no. 2")') and 'These units are owed to earlier pre-orders.' in p.inner_text('#sellBody') and p.is_visible('button:has-text("Save as a pre-order")'), 'sell it now turns the form back into a sale with one muted line')
    p.click('button:has-text("Change")'); pick(p, 'inv.lines.0', 'luffy')
    check(p.is_visible('#invNotice'), 'changing the item resets the choice')
    p.click('button:has-text("It is here, sell it now")'); p.click('button:has-text("Save as a pre-order")')
    check(p.is_visible('#invNotice'), 'Save as a pre-order clears the choice')
    p.click('#backBtn'); check(p.is_visible('#view [data-act="sellNew"]') and p.evaluate('ui.inv.lines[0].sku') == '', 'closing New sale clears the draft and shows the invoice list')
    tab(p, 'Orders'); p.click('button[data-s="pre"]'); check('waiting for stock' in p.inner_text('#view').lower() and 'ready to ship' not in p.inner_text('#view').lower(), 'pre-order waits while stock is short')
    check('Collect ₱2,000 on 1 pre-order\nBalances still open' in home(p), 'Home: pre-order with a balance')
    p.click('#view .item:has-text("Collect ₱2,000")')
    check('on' in p.get_attribute('#tabs button[data-t="orders"]', 'class') and p.get_attribute('#view button[data-s="pre"]', 'class') == 'on' and 'Ana Reyes' in p.inner_text('#view'), 'the balance row opens Orders > Pre-orders')

    # ---- add a payment
    p.click('.item:has-text("Ana Reyes")'); p.click('button:has-text("Add payment")'); p.fill('[data-b="sub.paid"]', '2500'); p.click('button:has-text("Save payment")'); check('more than the balance' in p.inner_text('#toast'), 'a payment cannot exceed the balance')
    p.fill('[data-b="sub.paid"]', '1000'); p.click('button:has-text("Save payment")')
    check('₱1,000' in p.inner_text('#sheet .kv') and 'Add payment' in p.inner_text('#sheet'), 'payment updates the balance'); close(p); synced(p)
    check(rows('Pre-orders')[0][9:11] == [2000, 1000], 'payment reached the sheet')

    # ---- supplier stock arrives: cost typed at receipt, pre-order becomes ready to ship
    tab(p, 'Suppliers'); p.click('#view button[data-s="orders"]'); p.click('#view .item:has-text("Maximatic Luffy")')
    check([e.inner_text() for e in p.query_selector_all('#sheet [data-costbox] label')] == ['Unit 1 cost', 'Unit 2 cost', 'Unit 3 cost', 'Unit 4 cost'], 'receiving shows one cost field per unit')
    p.fill('#sheet [data-cost][data-k="0"]', '800'); p.screenshot(path=f'{SHOTS}/08-receive-order.png'); p.click('#sheet button:has-text("Received")'); close(p); synced(p)
    so = rows('Supplier orders')[0]; rc = [r for r in rows('Movements') if r[0].startswith('rcv-')]
    check(so[10:12] == [4, 'Received'] and [r[0] for r in rc] == [f'rcv-{so[0]}-{k}' for k in (1, 2, 3, 4)] and all(r[4:8] == ['In', 1, 'Restock', so[1]] and r[9] == 800 for r in rc), f'order line received, one movement per unit refers to its order with its cost: {rc}')

    # ---- ready to ship -> one tap pre-fills the invoice; stock leaves when the invoice is issued
    h = home(p); p.screenshot(path=f'{SHOTS}/09a-home-ready.png')
    check('Ship Ana Reyes’s pre-order\nMaximatic Luffy × 2 · balance ₱1,000' in h, 'Home lists the ready pre-order as an action')
    titles = [e.inner_text() for e in p.query_selector_all('#view .sec:has-text("Needs you") .item .name')]
    check(titles[0] == 'Ship Ana Reyes’s pre-order' and 'supplier order due' not in h, f'ready rows come first; a received supplier order is no longer due: {titles}')
    p.click('#view .item:has-text("Ship Ana Reyes")')
    check('For the pre-order of Ana Reyes' in p.inner_text('#view') and p.input_value('[data-b="inv.cust"]') == 'Ana Reyes' and p.input_value('[data-b="inv.lines.0.price"]') == '1500', 'invoice form is pre-filled from the pre-order')
    p.click('button:has-text("Issue invoice no. 2")')
    check('Invoice no. 2' in p.inner_text('#sheet'), 'sale invoice 2 opens'); close(p); synced(p)
    check(stock_map(p)['Maximatic Luffy'] == 3, 'pre-ordered toys left stock on invoice')
    check(rows('Pre-orders')[0][11] == 'Fulfilled' and rows('Pre-orders')[0][14] == 2, 'pre-order fulfilled by invoice 2')
    check(rows('Pre-orders')[0][9:11] == [3000, 0], f"issuing the invoice settled the balance: {rows('Pre-orders')[0][9:11]}")
    tab(p, 'Sales'); check(p.is_visible('#view [data-act="sellNew"]') and 'No. 2 · Ana Reyes' in p.inner_text('#invList'), 'after a sale the Sales tab opens the invoice list')
    no_toy(p, 'Sales')

    # ---- from a toy's sheet: Sell, Pre-order and Order stock start with the toy already picked
    tab(p, 'Inventory'); p.click('.item:has-text("Gigo Zoro")'); p.screenshot(path=f'{SHOTS}/19-toy-actions.png'); p.click('#sheet button:has-text("Sell")')
    check('Gigo Zoro' in p.inner_text('#sellBody') and p.is_visible('button:has-text("Issue invoice no. 3")'), 'Sell on a toy opens New Sale with it picked')
    p.screenshot(path=f'{SHOTS}/17-new-sale-from-toy.png')
    tab(p, 'Home'); tab(p, 'Sales'); check(p.inner_text('#title') == 'New sale' and 'Gigo Zoro' in p.inner_text('#sellBody'), 'with an item picked, the Sales tab reopens the draft')
    p.click('button:has-text("Change")')

    # ---- ordinary chat sale: one toy, listed price prefilled, overridden; the oldest unit has no cost, so the margin is unknown
    new_sale(p)
    p.click('button:has-text("Issue invoice")'); check('Pick a product' in p.inner_text('#toast'), 'invoice needs an item')
    pick(p, 'inv.lines.0', 'goku')
    check(p.input_value('[data-b="inv.lines.0.price"]') == '1800' and '5 in stock' in p.inner_text('#sellBody'), 'picking an item fills the listed price and shows the units in stock')
    no_toy(p, 'New sale in sale mode')
    p.fill('[data-b="inv.lines.0.price"]', '1700'); p.fill('[data-b="inv.cust"]', 'Ben Cruz')
    check(p.inner_text('#invTotal') == '₱1,700', 'total follows the overridden price'); p.screenshot(path=f'{SHOTS}/10-invoice-form.png')
    check('1 unit of this product has no cost yet, so the margin on this sale will stay unknown.' in p.inner_text('#sellBody') and p.is_visible('#sellBody button:has-text("Add the cost")'), 'the form says the unit sold has no cost')
    p.click('button:has-text("Issue invoice no. 3")')
    sheet = p.inner_text('#sheet'); p.screenshot(path=f'{SHOTS}/11-invoice.png')
    check('Invoice no. 3' in sheet and '(listed ₱1,800)' in sheet and 'Margin unknown: a product has no cost' in sheet, 'invoice sheet shows override and the unknown margin')
    name, size = save_img(p, 'invoice-3')
    check(name == 'tab' and size and size[0] == 1190 and size[1] < 1684, f'Save image opens a valid PNG in a new tab, 1190 px wide and cropped shorter than an A4 page: {size}')
    ctx.grant_permissions(['clipboard-read', 'clipboard-write']); p.wait_for_selector('#sheet button:has-text("Copy image")', state='visible')
    p.click('#sheet button:has-text("Copy image")'); p.wait_for_function("document.querySelector('#toast').textContent.startsWith('Copied')", timeout=5000)
    clip = p.evaluate("async () => { const [it] = await navigator.clipboard.read(); return Array.from(new Uint8Array(await (await it.getType('image/png')).arrayBuffer())); }")
    check(p.inner_text('#toast') == 'Copied. Paste it into the chat.' and png_size(bytes(clip)) == size, f'with the clipboard API, Copy image sits beside Save image and copies the PNG: {png_size(bytes(clip))}')
    p.click('#sheet [data-act="ship"]'); check(p.is_checked('#sheet [data-act="ship"]'), 'ticking Delivered marks it')
    p.click('#sheet [data-act="ship"]'); check(not p.is_checked('#sheet [data-act="ship"]'), 'unticking takes the mark off')
    p.click('#sheet [data-act="ship"]'); close(p); synced(p)
    check(len([q for q in p.evaluate('queue') if q['kind'] == 'ship']) == 0, 'the three taps were sent and cleared')
    inv = [r for r in rows('Invoices') if r[0] == 3][0]; sale = [r for r in rows('Movements') if r[7] == '3']
    check(inv[3] == 'Sale' and inv[5] == 'Ben Cruz' and inv[7] == 1700 and inv[8] == 'Delivered', f'invoice row: {inv}')
    check(len(sale) == 1 and sale[0][4:7] == ['Out', 1, 'Sale'] and sale[0][9] == '', f'issuing wrote the stock-out with Ref = invoice number, with no cost: {sale}')
    ln = [r for r in rows('Invoice lines') if r[0] == 3][0]; check(ln[4:8] == [1, 1800, 1700, ''], f'line keeps listed price, charged price and the blank cost: {ln}')
    check(stock_map(p)['Grandista Son Goku'] == 4, 'sale took one out of stock')
    tab(p, 'Sales'); check('delivered' in p.inner_text('.item:has-text("No. 3")'), 'the invoice list shows the delivered tag')
    h = home(p)
    check('Today\n₱4,700' in h and 'Month\n₱4,700' in h and 'Margin\n–' in h and 'the products sold have no cost on file' in h and 'invoices this month' not in h, 'Home numbers strip after two sales whose oldest units had no cost')
    p.click('#view .strip'); check('on' in p.get_attribute('#tabs button[data-t="sell"]', 'class') and p.is_visible('#invList .item'), 'tapping the numbers strip opens the invoice list')

    # ---- several toys on one invoice; known customer brings the contact; many lines paginate
    new_sale(p)
    pick(p, 'inv.lines.0', 'zoro'); p.fill('[data-b="inv.lines.0.price"]', '1100')
    p.click('button:has-text("Add another product")'); pick(p, 'inv.lines.1', 'plain'); p.fill('[data-b="inv.lines.1.price"]', '300'); p.fill('[data-b="inv.lines.1.qty"]', '2')
    check('Plain Toy is not in stock. A pre-order holds one product: remove the other products to save it as a pre-order, or sell it now.' in p.inner_text('#invNotice'), 'several items with one short: the notice explains the one-item rule')
    p.click('#view [data-act="invIssue"]'); check('A pre-order holds one product' in p.inner_text('#toast') and len([q for q in p.evaluate('queue') if q['kind'] in ('pre', 'invoice') and q['status'] == 'pending']) == 0, 'saving is refused with a toast and nothing is queued')
    p.click('button:has-text("It is here, sell it now")')
    check('Only 1 on hand. Stock will go below zero.' in p.inner_text('#sellBody') and p.is_visible('button:has-text("Issue invoice no. 4")'), 'sell it now: one muted line says stock will go below zero')
    p.fill('[data-b="inv.cust"]', 'ana reyes'); p.dispatch_event('[data-b="inv.cust"]', 'change')
    check(p.input_value('[data-b="inv.contact"]') == '+63 917 000 0000' and p.inner_text('#invTotal') == '₱1,700', 'contact filled from the customer tracker; two-line total')
    p.click('button:has-text("Issue invoice no. 4")'); close(p); synced(p)
    check(len([r for r in rows('Movements') if r[7] == '4']) == 2 and len(rows('Customers')) == 2, 'two movements for two lines, no duplicate customer')
    check(stock_map(p)['Plain Toy'] == -1, 'selling it now takes stock below zero with no confirm')

    # ---- return: restock brings the toy back, capped at what was sold
    tab(p, 'Sales'); p.screenshot(path=f'{SHOTS}/12-invoice-list.png')
    p.click('.item:has-text("No. 3")'); p.click('button:has-text("Record a return")'); p.fill('[data-b="sub.refund"]', '1700'); p.screenshot(path=f'{SHOTS}/13-return.png')
    p.fill('[data-b="sub.qty"]', '2'); p.click('button:has-text("Record return")'); check('Only 1 can still be returned' in p.inner_text('#toast'), 'return is capped')
    p.fill('[data-b="sub.qty"]', '1'); p.click('button:has-text("Record return")')
    check('Restock' in p.inner_text('#sheet') and 'refunded ₱1,700' in p.inner_text('#sheet') and not p.is_visible('button:has-text("Record a return")'), 'return listed on the invoice; nothing left to return')
    close(p); synced(p)
    rt = rows('Returns')[0]; back = [r for r in rows('Movements') if r[6] == 'Return']
    check(rt[2] == 3 and rt[7:10] == [1, 'Restock', 1700] and len(back) == 1 and back[0][7] == rt[0], f'return row and its In movement: {rt}')
    check(stock_map(p)['Grandista Son Goku'] == 5, 'restocked toy is back on hand')
    tab(p, 'Sales'); p.click('.item:has-text("No. 4")'); p.click('button:has-text("Record a return")'); p.click('#sheet button[data-v="Write-off"]'); p.click('button:has-text("Record return")'); close(p); synced(p)
    check(len([r for r in rows('Movements') if r[6] == 'Return']) == 1 and rows('Returns')[1][8] == 'Write-off', 'a write-off records the return without a stock movement')

    # ---- cancellation: kept deposit typed each time, no stock movement
    n_moves = len(rows('Movements'))
    new_sale(p); pick(p, 'inv.lines.0', 'plain')
    check('Not in stock, so this is saved as a pre-order' in p.inner_text('#invNotice'), 'an item below zero: not in stock notice')
    p.fill('[data-b="inv.cust"]', 'Carla Santos'); p.fill('[data-b="inv.contact"]', 'm.me/carla'); p.fill('[data-b="inv.lines.0.price"]', '1100'); p.fill('[data-b="inv.paid"]', '500')
    p.click('button:has-text("Save pre-order · receipt no. 5")'); close(p)
    tab(p, 'Orders'); p.click('button[data-s="pre"]'); no_toy(p, 'Orders')
    check('Carla Santos' in p.inner_text('#view .sec:has-text("Waiting for stock")'), 'the pre-order waits for stock')
    p.click('.item:has-text("Carla Santos") .name'); p.click('#sheet button.danger:has-text("Cancel")')
    check('Leave blank for a full refund' == p.get_attribute('[data-b="sub.kept"]', 'placeholder'), 'cancel asks only for the deposit kept')
    p.fill('[data-b="sub.kept"]', '600'); p.click('button:has-text("Cancel the pre-order")'); check('more than what was paid' in p.inner_text('#toast'), 'deposit kept cannot exceed what was paid')
    p.fill('[data-b="sub.kept"]', '200'); p.screenshot(path=f'{SHOTS}/14-cancel.png'); p.click('button:has-text("Cancel the pre-order")')
    check('Cancelled, kept ₱200' in p.inner_text('#sheet'), 'cancelled with the typed deposit'); close(p); synced(p)
    cp = [r for r in rows('Pre-orders') if r[3] == 'Carla Santos'][0]
    check(cp[11] == 'Cancelled' and cp[12] == 200 and len(rows('Movements')) == n_moves, f'cancellation in the sheet, stock untouched: {cp[11:13]}')

    # ---- a second phone sees the same documents
    ctx2 = b.new_context(viewport={'width': 390, 'height': 844}); p2 = page(ctx2, 'p2 ')
    p2.goto(APP); connect(p2); synced(p2)
    check(stock_map(p2) == stock_map(p), f'device 2 stock matches: {stock_map(p2)}')
    tab(p2, 'Sales'); check(len(p2.query_selector_all('#invList .item')) == 5, 'device 2 lists all five documents')
    p2.click('.item:has-text("No. 3")'); check('Margin unknown' in p2.inner_text('#sheet') and 'Restock' in p2.inner_text('#sheet'), 'device 2 sees the margin and the return'); close(p2)

    # ---- offline: invoice issued with no signal waits, then lands once
    ctx.set_offline(True)
    new_sale(p); pick(p, 'inv.lines.0', 'goku'); p.fill('[data-b="inv.cust"]', 'Ben Cruz'); p.click('button:has-text("Issue invoice no. 6")')
    check('waiting' in p.inner_text('#sheet') and 'Delete this invoice' in p.inner_text('#sheet'), 'offline invoice is marked waiting and can still be deleted')
    name, size = save_img(p, 'invoice-6-offline'); check(size and size[0] == 1190, 'the image works offline'); close(p)
    check(stock_map(p)['Grandista Son Goku'] == 4, 'offline invoice already counts against stock')
    ctx.set_offline(False); p.click('#syncBtn'); synced(p)
    check(len([r for r in rows('Invoices') if r[0] == 6]) == 1 and len([r for r in rows('Movements') if r[7] == '6']) == 1, 'offline invoice reached the sheet once')

    # ---- shop details and logo appear on the image
    logo = f'{SHOTS}/logo.png'
    p.evaluate("""() => { const c = document.createElement('canvas'); c.width = 300; c.height = 120; const x = c.getContext('2d'); x.fillStyle = '#e4572e'; x.fillRect(0, 0, 300, 120); x.fillStyle = '#fff'; x.font = '700 48px sans-serif'; x.fillText('SHOP', 70, 78); window._logo = c.toDataURL('image/png'); }""")
    import base64; open(logo, 'wb').write(base64.b64decode(p.evaluate('window._logo').split(',')[1]))
    p.click('button[aria-label="Settings"]'); p.fill('#sShop', 'Sample Toy Shop'); p.fill('#sContact', 'm.me/sampletoys\n0917 000 0000'); p.fill('#sFoot', 'Thank you for your order.')
    p.set_input_files('#sLogo', logo); p.wait_for_selector('#sheet img.logo')
    check(p.input_value('#sShop') == 'Sample Toy Shop', 'typed shop fields survive the logo upload'); p.screenshot(path=f'{SHOTS}/15-settings.png')
    p.click('#sheet [data-act="savePrefs"]')
    check(home(p) and p.inner_text('#title') == 'Sample Toy Shop', 'with a shop name set, Home is headed by it')
    tab(p, 'Sales'); p.click('.item:has-text("No. 4")'); save_img(p, 'invoice-4-branded'); close(p)
    p.click('.item:has-text("No. 1")'); save_img(p, 'receipt-1-branded'); close(p)

    # ---- invoice number already used in the sheet (second phone): renumbered, both kept
    ctx2.set_offline(True)
    new_sale(p2); pick(p2, 'inv.lines.0', 'luffy'); p2.fill('[data-b="inv.lines.0.price"]', '1500'); p2.fill('[data-b="inv.cust"]', 'Dan Lim'); p2.click('button:has-text("Issue invoice no. 6")'); close(p2)
    ctx2.set_offline(False); p2.click('#syncBtn'); p2.wait_for_function("document.querySelector('#toast').textContent.includes('now no. 7')", timeout=8000)
    nos = sorted(r[0] for r in rows('Invoices')); check(nos == [1, 2, 3, 4, 5, 6, 7], f'numbers stay unique and sequential: {nos}')
    check([r[7] for r in rows('Movements') if r[2] == 'T0002' and r[6] == 'Sale'][-1] == '7', 'the renumbered invoice’s movement carries the new number')

    # ---- activity shows document movements; a refused document is explained
    tab(p, 'Inventory'); p.click('#view button[data-t="activity"]'); p.click('#syncBtn'); synced(p); p.screenshot(path=f'{SHOTS}/16-activity.png')
    check('invoice 3' in p.inner_text('#view'), 'activity names the invoice behind a sale')
    for name in ['Home', 'Inventory', 'Sales', 'Suppliers']:
        tab(p, name); p.screenshot(path=f"{SHOTS}/tab-{name.lower()}.png")
    add_inventory(p)
    if not p.is_visible('#impText'): p.click('#manual summary')
    p.click('button[data-m="receive"]'); p.screenshot(path=f'{SHOTS}/tab-import-receive.png')
    tab(p, 'Orders'); p.click('button[data-s="pre"]'); p.screenshot(path=f'{SHOTS}/tab-orders-pre.png')

    # ---- promised beyond stock and incoming; a cancel with nothing kept is a full refund
    check(stock_map(p)['Plain Toy'] == -1 and 'promised beyond supply' not in home(p), 'an item below zero with nothing owed is not counted as promised')
    new_sale(p); pick(p, 'inv.lines.0', 'plain'); p.fill('[data-b="inv.lines.0.qty"]', '5'); p.fill('[data-b="inv.lines.0.price"]', '300'); p.fill('[data-b="inv.cust"]', 'Eva Cruz'); p.fill('[data-b="inv.contact"]', '0917 111 2222'); p.fill('[data-b="inv.paid"]', '100')
    p.click('button:has-text("Save pre-order · receipt no. 8")'); close(p)
    h = home(p)
    check('Order stock for 1 product promised beyond supply\nMore owed than on hand plus incoming' in h and 'Collect ₱1,400 on 1 pre-order' in h, 'Home: a pre-order beyond stock and incoming')
    p.click('#view .item:has-text("promised beyond supply")')
    check('Showing only: Promised beyond supply' in p.inner_text('#view') and stock_names(p) == ['Plain Toy'], 'the row opens Stock filtered to that item')
    p.click('#view button:has-text("Show all")')
    tab(p, 'Orders'); p.click('.item:has-text("Eva Cruz")'); p.click('#sheet button.danger:has-text("Cancel")'); p.click('button:has-text("Cancel the pre-order")')
    check('Cancelled, refunded in full' in p.inner_text('#sheet'), 'blank deposit kept means a full refund'); close(p); synced(p)
    ep = [r for r in rows('Pre-orders') if r[3] == 'Eva Cruz'][0]
    check(ep[11:13] == ['Cancelled', 0], f'full refund in the sheet: {ep[11:13]}')
    check('promised beyond supply' not in home(p), 'a cancelled pre-order is no longer owed')

    # ---- the invoice image is drawn with literal colours: the same bytes in light and dark
    png_bytes = "async t => { prefs.theme = t; applyTheme(); const v = live().invs.find(x => x.no === 3); const [b] = await docPngs(drawDoc(v)); return Array.from(new Uint8Array(await b.arrayBuffer())); }"
    light, dark = p.evaluate(png_bytes, 'light'), p.evaluate(png_bytes, 'dark')
    check(len(light) > 1000 and light == dark and png_size(bytes(light)) is not None, f'image bytes identical in light and dark ({len(light)} bytes)')
    p.evaluate("prefs.theme = 'auto'; applyTheme()")

    # ---- a 40-line invoice continues on a second image: both download with no tab, the second repeats the column header with its page number
    cl = b.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True); q = page(cl, 'long '); q.goto(APP); q.wait_for_selector('#tabs button')
    q.evaluate("""() => {
      for (let i = 1; i <= 40; i++) qItem({ sku: 'L' + i, name: 'Grandista figure ' + i, price: 100, active: true }, false);
      dirty(); qAdd('invoice', { invoice: { id: 'vlong', no: nextNo(), date: todayISO(), custId: custFor('Ana Reyes', ''), lines: Array.from({ length: 40 }, (_, i) => ({ sku: 'L' + (i + 1), qty: 1, list: 100, price: 100, cost: null })), preId: '' } }); commit();
      const fill = CanvasRenderingContext2D.prototype.fillText; window._drawn = [];
      CanvasRenderingContext2D.prototype.fillText = function (s, ...a) { window._drawn.push(String(s)); return fill.call(this, s, ...a); };
    }""")
    tab(q, 'Sales'); q.click('.item:has-text("No. 1")')
    got, tabs = [], []; q.on('download', lambda d: got.append(d)); cl.on('page', lambda t: tabs.append(t))
    q.click('button:has-text("Save image")')
    for _ in range(200):   # up to 20 s: drawing and encoding two large PNGs can be slow on a busy machine
        if len(got) == 2: break
        q.wait_for_timeout(100)
    for d in got: d.save_as(f'{SHOTS}/{d.suggested_filename}')
    sizes = [png_size(open(f'{SHOTS}/{d.suggested_filename}', 'rb').read()) for d in got]
    check([d.suggested_filename for d in got] == ['Invoice-1-1.png', 'Invoice-1-2.png'] and not tabs and '2 images downloaded' in q.inner_text('#toast'), f'a 40-line invoice downloads two images and opens no tab: {[d.suggested_filename for d in got]}')
    check(all(s and s[0] == 1190 and s[1] <= 2048 for s in sizes) and len(sizes) == 2, f'each image is a PNG 1190 px wide and at most 2048 px tall: {sizes}')
    drawn = q.evaluate('window._drawn')
    check(drawn.count('ITEM') == 2 and 'Page 1 of 2' in drawn and 'Page 2 of 2' in drawn, 'the second image repeats the column header and both carry their page number')
    check(q.evaluate('canCopyImg') and not q.is_visible('#sheet button:has-text("Copy image")'), 'Copy image is hidden for a document with several images')
    cl.close()

    # ---- Needs you: fixed order, one badge per row, capped at four on a phone with See more and See less
    cx = b.new_context(viewport={'width': 390, 'height': 844}); q = page(cx, 'needs '); q.goto(APP); q.wait_for_selector('#tabs button')
    q.evaluate("""() => {
      const it = (sku, name, extra) => qItem(Object.assign({ sku, name, price: 100, active: true }, extra), false);
      const mv = (sku, qty) => qMove({ id: 'm' + uid(), date: todayISO(), sku, dir: 'In', qty, reason: 'Opening', ref: '', note: '', cost: null });
      const pre = (sku, cust, qty, paid) => { const c = custFor(cust, '0917'); qAdd('pre', { pre: { id: 'p' + uid(), date: todayISO(), custId: c, sku, qty, price: 100, paid, note: '', invId: 'v' + uid(), no: nextNo() } }); dirty(); };
      it('A', 'Alpha'); mv('A', 9); it('B', 'Bravo', { price: null }); mv('B', 1); it('C', 'Charlie', { relCheck: true, rel: '2024' }); mv('C', 5); it('D', 'Delta'); dirty();
      pre('A', 'Ana', 1, 100); pre('A', 'Ben', 1, 50); pre('D', 'Cy', 3, 0);
      qAdd('order', { order: { id: 'o1', date: todayISO(), supId: 's1', expected: todayISO(), note: '', lines: [{ id: 'l1', sku: 'D', qty: 1, cost: null }] } });
      docs.inbox = [{ row: 2, type: 'count', name: 'Alpha', qty: '9' }];
      qMove({ id: 'mx', date: todayISO(), sku: 'A', dir: 'In', qty: 1, reason: 'Opening', ref: '', note: '', cost: null }); queue[queue.length - 1].status = 'failed';
      commit();
    }""")
    names = lambda: [e.inner_text() for e in q.query_selector_all('#view .sec:has-text("Needs you") .item .name')]
    want = ['Fix 1 entry the sheet refused', 'Ship Ana’s pre-order', 'Ship Ben’s pre-order', 'Review 1 row from Claude', 'Order stock for 1 product promised beyond supply', 'Receive 1 supplier order line due', 'Collect ₱350 on 2 pre-orders', 'Price 1 product', 'Add the cost of 15 units', 'Check 1 release date']
    check(names() == want[:4] and q.inner_text('#view .badge') == '10' and q.inner_text('#view .more') == 'See 6 more', f'phone shows the first four rows, the badge counts all ten jobs: {names()}')
    q.screenshot(path=f'{SHOTS}/20-needs-collapsed.png')
    q.click('#view .more'); check(names() == want and q.inner_text('#view .more') == 'See less', f'See 6 more shows every row in the fixed order: {names()}')
    q.screenshot(path=f'{SHOTS}/20-needs-expanded.png', full_page=True)
    q.evaluate('render()'); check(len(names()) == 10, 'the expanded list survives a re-render')
    tab(q, 'Inventory'); tab(q, 'Home'); check(len(names()) == 4, 'entering Home from the tab bar collapses it again')
    q.click('#view .item:has-text("Ship Ben")'); check(q.input_value('[data-b="inv.cust"]') == 'Ben' and 'For the pre-order of Ben' in q.inner_text('#view'), 'a ready row opens New sale pre-filled from that pre-order')
    q.click('#backBtn')
    q.evaluate("() => { ['Di', 'Ed'].forEach(n => { const c = custFor(n, '0918'); qAdd('pre', { pre: { id: 'p' + uid(), date: todayISO(), custId: c, sku: 'A', qty: 1, price: 100, paid: 100, note: '', invId: 'v' + uid(), no: nextNo() } }); dirty(); }); commit(); }")
    tab(q, 'Home'); n = names()
    check(n[1] == 'Ship 4 pre-orders now in stock' and not any(x.startswith('Ship ') and 'pre-orders' not in x for x in n), f'four ready pre-orders collapse into one row: {n[:3]}')
    q.click('#view .item:has-text("Ship 4 pre-orders")'); check(q.inner_text('#title') == 'Orders' and q.get_attribute('#view button[data-s="pre"]', 'class') == 'on', 'that row opens the pre-order list')
    q.set_viewport_size({'width': 1280, 'height': 800}); tab(q, 'Home')
    check(len(names()) == 9 == int(q.inner_text('#view .badge')) and not q.is_visible('#view .more'), 'a desktop window shows every row')
    cx.close()

    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
