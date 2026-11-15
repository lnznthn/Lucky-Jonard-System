# End-to-end test of the v2 flows: toy details, receipt cost, supplier orders, pre-orders, invoices with PDF, returns.
# python3 test/e2e_v2.py  (needs static server on 8765, mock backend on 8766, Chrome)
import datetime, json, os, re, subprocess, sys, urllib.request
from playwright.sync_api import sync_playwright

APP, API = 'http://localhost:8765/index.html', 'http://localhost:8766'
SHOTS = '/tmp/shots2'
os.makedirs(SHOTS, exist_ok=True)
fails = []
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)
def dump(): return json.load(urllib.request.urlopen(API + '/_dump'))
def rows(name): return dump()[name]['rows'][1:]
key = urllib.request.urlopen(API + '/_reset').read().decode()
CODE = f'{API}/exec#{key}'

def tab(p, name): p.click(f'#tabs button:has-text("{name}")')
def home(p): tab(p, 'Home'); return p.inner_text('#view')
def stock_names(p): return [e.inner_text().strip() for e in p.query_selector_all('#stockList .item .name')]
TODAY = datetime.date.today().isoformat()
def synced(p): p.wait_for_function("document.querySelector('#syncTxt').textContent.startsWith('Synced')", timeout=8000)
def stock_map(p):
    tab(p, 'Stock'); p.click('#view .seg button[data-f="all"]'); out = {}
    for row in p.query_selector_all('#stockList .item'):
        out[row.query_selector('.name').inner_text().strip()] = int(row.query_selector('.qty').inner_text())
    return out
def paste_import(p, mode, text):
    tab(p, 'Import')
    if not p.is_visible('#impText'): p.click('#manual summary')
    p.click(f'button[data-m="{mode}"]'); p.fill('#impText', text); p.click('button:has-text("Preview")')
def connect(p, code=CODE):
    p.click('button[aria-label="Settings"]'); p.fill('#sCode', code); p.click('button:has-text("Test and save")')
def pick(p, key, text):
    p.fill(f'[data-pk="{key}"]', text); p.click(f'[data-sug="{key}"] button')
def close(p): p.click('button[aria-label="Close"]')
def pdf(p, name):
    with p.expect_download() as d: p.click('button:has-text("Share PDF")')
    path = f'{SHOTS}/{name}.pdf'; d.value.save_as(path)
    info = subprocess.run(['pdfinfo', path], capture_output=True, text=True)
    subprocess.run(['pdftoppm', '-r', '70', '-png', path, f'{SHOTS}/{name}'])
    return d.value.suggested_filename, open(path, 'rb').read(5), info.returncode == 0 and re.search(r'Pages:\s+(\d+)', info.stdout).group(1)

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, accept_downloads=True)
    p = ctx.new_page(); errors = []
    p.on('pageerror', lambda e: errors.append(str(e))); p.on('dialog', lambda d: d.accept())
    p.goto(APP); connect(p); synced(p)

    # ---- photo import carries the toy details; the release-date flag is its own field
    T = '\t'
    paste_import(p, 'count', T.join(['Grandista Son Goku', 'Figures', '2', '', '', 'Bandai Spirits', 'Banpresto', 'Grandista', 'Son Goku', '2019-06', 'Y']) + '\n'
        + T.join(['Maximatic Luffy', 'Figures', '1', '', 'name guessed from artwork', 'Bandai Spirits', 'Banpresto', 'Maximatic', 'Monkey D. Luffy', 'sometime', '']) + '\n'
        + 'Plain Toy\tFigures\t1')
    txt = p.inner_text('#impOut'); p.screenshot(path=f'{SHOTS}/01-import-details.png')
    check('Banpresto / Grandista / Son Goku · released 2019-06 (to verify)' in txt, 'preview shows brand, line, character and the verify flag')
    check('Release date “sometime” not understood' in txt and 'Apply 3 changes' in txt, 'an unreadable release date is left blank, row still applies')
    p.click('button:has-text("Apply 3 changes")'); synced(p)
    it = {r[1]: r for r in rows('Items')}
    check(it['Grandista Son Goku'][7:13] == ['Bandai Spirits', 'Banpresto', 'Grandista', 'Son Goku', '2019-06', 'Verify'], f"details reached the sheet: {it['Grandista Son Goku'][7:13]}")
    check(it['Maximatic Luffy'][11:13] == ['', ''], 'no release date, no flag')
    h = home(p); p.screenshot(path=f'{SHOTS}/01a-home.png')
    check('Release dates to verify\n1' in h and 'Toys with no price yet\nA sale needs the price typed each time\n3' in h and 'Toys low or out of stock\n3' in h, 'Home: release date to verify, no price and low stock rows')
    check('Pre-orders with a balance' not in h and 'Supplier orders due' not in h and 'Promised beyond stock' not in h and 'ready to ship' not in h.lower(), 'Home leaves out rows that are zero')
    p.click('#view .item:has-text("Release dates to verify")')
    check('on' in p.get_attribute('#tabs button[data-t="stock"]', 'class') and p.is_visible('#view .chip.on:has-text("Release date to verify ✕")') and stock_names(p) == ['Grandista Son Goku'], 'the verify row opens Stock with its filter chip')
    p.click('#view .chip.on:has-text("✕")')
    check(not p.is_visible('#view .chip:has-text("Release date to verify")') and len(stock_names(p)) == 3, 'the chip’s ✕ clears the filter')
    home(p); p.click('#view .item:has-text("Toys with no price yet")')
    check(p.is_visible('#view .chip.on:has-text("No price yet ✕")') and len(stock_names(p)) == 3, 'the no-price row opens Stock filtered')
    p.click('#view .seg button[data-f="attn"]')
    check(not p.is_visible('#view .chip:has-text("No price yet")') and p.get_attribute('#view .seg button[data-f="attn"]', 'class') == 'on', 'a normal filter button replaces the special filter')
    p.click('#view .seg button[data-f="all"]')
    tab(p, 'Stock'); p.click('.item:has-text("Grandista Son Goku")'); sheet = p.inner_text('#sheet')
    check('Banpresto' in sheet and 'to verify' in sheet and 'No cost recorded yet' in sheet, 'toy sheet shows details, flag and missing cost')
    p.screenshot(path=f'{SHOTS}/02-toy-sheet.png')
    p.click('button:has-text("Edit")'); p.fill('#fPrice', '1800'); p.uncheck('#fRelCheck'); p.fill('#fRel', '2019-06-20'); p.click('#sheet button.primary:has-text("Save")'); synced(p)
    it = {r[1]: r for r in rows('Items')}
    check(it['Grandista Son Goku'][3] == 1800 and it['Grandista Son Goku'][11:13] == ['2019-06-20', ''], 'edit clears the flag and sets the verified date')

    # ---- a later paste fills blank details only, and never overwrites what is on file
    paste_import(p, 'count', T.join(['Plain Toy', 'Figures', '1', '', '', 'Sega', 'Gigo', '', 'Zoro', '2023', '']) + '\n' + T.join(['Grandista Son Goku', 'Figures', '2', '', '', 'Other Maker', '', '', '', '', '']))
    txt = p.inner_text('#impOut')
    check('Details' in txt and 'adds manufacturer, brand, character, release date' in txt and 'Apply 1 change' in txt, 'blank details are offered, existing ones are not')
    p.click('button:has-text("Apply 1 change")'); synced(p)
    it = {r[1]: r for r in rows('Items')}
    check(it['Plain Toy'][7:9] == ['Sega', 'Gigo'] and it['Grandista Son Goku'][7] == 'Bandai Spirits', 'details filled without overwriting')

    # ---- receive mode: supplier paperwork adds stock at its cost and sets the average
    paste_import(p, 'receive', 'Grandista Son Goku\t3\t1,200\nGigo Zoro\t2\t900\tFigures\tSega\tGigo\t\tRoronoa Zoro\t2023-11\t\nBad Row\tx\t5')
    txt = p.inner_text('#impOut'); p.screenshot(path=f'{SHOTS}/03-receive-preview.png')
    check('+3 at ₱1,200 each' in txt and 'New toy' in txt and 'Problem' in txt and 'Apply 2 changes' in txt, 'receive preview')
    p.click('button:has-text("Apply 2 changes")'); synced(p)
    sm = stock_map(p)
    check(sm['Grandista Son Goku'] == 5 and sm['Gigo Zoro'] == 2, f'stock after receiving: {sm}')
    mv = [r for r in rows('Movements') if r[6] == 'Restock']
    check(sorted(r[9] for r in mv) == [900, 1200], f'cost recorded on each receipt: {[r[9] for r in mv]}')
    p.click('.item:has-text("Grandista Son Goku")'); check('₱1,200' in p.inner_text('#sheet .kv'), 'average cost shown on the toy'); close(p)

    # ---- supplier order counts as incoming
    tab(p, 'Orders'); p.click('button[data-s="sup"]'); p.click('button:has-text("New supplier order")')
    pick(p, 'f', 'luffy'); p.fill('[data-b="f.qty"]', '4'); p.fill('[data-b="f.expected"]', TODAY); p.screenshot(path=f'{SHOTS}/04-supplier-order.png'); p.click('button:has-text("Save order")'); synced(p)
    check(rows('Supplier orders')[0][2:7] == ['T0002', 'Maximatic Luffy', 4, TODAY, 'Ordered'], f"supplier order in the sheet: {rows('Supplier orders')[0]}")
    tab(p, 'Stock'); check('4 incoming' in p.inner_text('.item:has-text("Maximatic Luffy")'), 'stock list shows incoming')
    check('Supplier orders due to arrive\nMaximatic Luffy\n1' in home(p), 'Home: a supplier order expected today is due')
    p.click('#view .item:has-text("Supplier orders due")')
    check('on' in p.get_attribute('#tabs button[data-t="orders"]', 'class') and p.get_attribute('#view button[data-s="sup"]', 'class') == 'on' and 'on the way' in p.inner_text('#view').lower(), 'the due row opens Orders > Supplier orders')
    home(p); p.click('#view button:has-text("New pre-order")')
    check('on' in p.get_attribute('#tabs button[data-t="orders"]', 'class') and p.get_attribute('#view button[data-s="pre"]', 'class') == 'on' and 'New pre-order' in p.inner_text('#sheet'), 'New pre-order on Home opens the form on Orders > Pre-orders'); close(p)
    home(p); p.click('#view button:has-text("New Sale")')
    check('on' in p.get_attribute('#tabs button[data-t="sell"]', 'class') and p.is_visible('button:has-text("Issue invoice no. 1")'), 'New Sale on Home opens the Sell form')

    # ---- customer pre-order: partial payment, receipt PDF, no stock movement, four numbers
    n_moves = len(rows('Movements'))
    tab(p, 'Orders'); p.click('button[data-s="pre"]'); p.click('button:has-text("New pre-order")')
    pick(p, 'f', 'luffy'); p.fill('[data-b="f.qty"]', '2'); p.fill('[data-b="f.price"]', '1500')
    p.click('button:has-text("Save and make receipt")'); check('customer’s name' in p.inner_text('#toast'), 'pre-order needs a name')
    p.fill('[data-b="f.cust"]', 'Ana Reyes'); p.click('button:has-text("Save and make receipt")'); check('phone or Messenger' in p.inner_text('#toast'), 'pre-order needs a contact')
    p.fill('[data-b="f.contact"]', '+63 917 000 0000'); p.fill('[data-b="f.paid"]', '1000')
    check('Total ₱3,000 · balance ₱2,000' in p.inner_text('#preHint'), 'pre-order form shows total and balance')
    p.screenshot(path=f'{SHOTS}/05-preorder-form.png')
    p.click('button:has-text("Save and make receipt no. 1")')
    sheet = p.inner_text('#sheet'); p.screenshot(path=f'{SHOTS}/06-receipt.png')
    check('Pre-order receipt no. 1' in sheet and 'Paid ₱1,000 · balance ₱2,000' in sheet, 'receipt opens straight after saving')
    name, magic, pages = pdf(p, 'receipt-1')
    check(name == 'Receipt-1.pdf' and magic == b'%PDF-' and pages == '1', f'receipt PDF is a valid one-page PDF: {name} {magic} {pages}')
    close(p); synced(p)
    check(len(rows('Movements')) == n_moves, 'pre-order moved no stock')
    pre = rows('Pre-orders')[0]
    check(pre[3:5] == ['Ana Reyes', '+63 917 000 0000'] and pre[7:12] == [2, 1500, 1000, 2000, 'Open'] and pre[13] == 1, f'pre-order row: {pre}')
    check(rows('Customers')[0][1:3] == ['Ana Reyes', '+63 917 000 0000'], 'customer kept in its own tab, phone stored as text')
    check(rows('Invoices')[0][0] == 1 and rows('Invoices')[0][3] == 'Pre-order receipt', 'receipt took number 1')
    tab(p, 'Stock'); p.click('.item:has-text("Maximatic Luffy")'); sheet = p.inner_text('#sheet')
    check(re.search(r'Incoming\s+4\s+Owed to customers\s+2\s+Left to promise\s+3', sheet) is not None and p.inner_text('#sheet .bigqty') == '1', f'four numbers: on hand 1, incoming 4, owed 2, left to promise 3')
    p.screenshot(path=f'{SHOTS}/07-four-numbers.png'); close(p)
    tab(p, 'Orders'); check('waiting for stock' in p.inner_text('#view').lower() and 'ready to ship' not in p.inner_text('#view').lower(), 'pre-order waits while stock is short')
    check('Pre-orders with a balance\n₱2,000 still to collect\n1' in home(p), 'Home: pre-order with a balance')
    p.click('#view .item:has-text("Pre-orders with a balance")')
    check('on' in p.get_attribute('#tabs button[data-t="orders"]', 'class') and p.get_attribute('#view button[data-s="pre"]', 'class') == 'on' and 'Ana Reyes' in p.inner_text('#view'), 'the balance row opens Orders > Pre-orders')

    # ---- add a payment
    p.click('.item:has-text("Ana Reyes")'); p.click('button:has-text("Add payment")'); p.fill('[data-b="sub.paid"]', '2500'); p.click('button:has-text("Save payment")'); check('more than the balance' in p.inner_text('#toast'), 'a payment cannot exceed the balance')
    p.fill('[data-b="sub.paid"]', '1000'); p.click('button:has-text("Save payment")')
    check('₱1,000' in p.inner_text('#sheet .kv') and 'Add payment' in p.inner_text('#sheet'), 'payment updates the balance'); close(p); synced(p)
    check(rows('Pre-orders')[0][9:11] == [2000, 1000], 'payment reached the sheet')

    # ---- supplier stock arrives: cost typed at receipt, pre-order becomes ready to ship
    p.click('button[data-s="sup"]'); p.click('.item:has-text("Maximatic Luffy")')
    p.click('button:has-text("Received")'); check('cost each' in p.inner_text('#toast'), 'receiving asks for the cost')
    p.fill('[data-b="sub.cost"]', '800'); p.screenshot(path=f'{SHOTS}/08-receive-order.png'); p.click('button:has-text("Received")')
    check('1 pre-order is ready to ship' in p.inner_text('#toast'), 'receiving announces the waiting customer')
    view = p.inner_text('#view'); p.screenshot(path=f'{SHOTS}/09-ready-to-ship.png')
    check('ready to ship' in view.lower() and 'Ana Reyes' in view and '+63 917 000 0000' in view, 'ready-to-ship list shows the customer and contact')
    synced(p)
    so = rows('Supplier orders')[0]; rc = [r for r in rows('Movements') if r[0].startswith('rcv-')][0]
    check(so[6:8] == ['Received', 4] and rc[4:8] == ['In', 4, 'Restock', so[0]] and rc[9] == 800, f'order received, movement refers to it with its cost: {rc}')

    # ---- ready to ship -> one tap pre-fills the invoice; stock leaves when the invoice is issued
    h = home(p); p.screenshot(path=f'{SHOTS}/09a-home-ready.png')
    check('ready to ship' in h.lower() and 'Ana Reyes' in h and '+63 917 000 0000' in h and 'Maximatic Luffy × 2 · balance ₱1,000' in h and p.is_visible('#view .item:has-text("Ana Reyes") button:has-text("Invoice")'), 'Home lists the ready-to-ship pre-order with an Invoice button')
    check('Supplier orders due' not in h, 'a received supplier order is no longer due')
    p.click('#view .item:has-text("Ana Reyes") button:has-text("Invoice")')
    check('For the pre-order of Ana Reyes' in p.inner_text('#view') and p.input_value('[data-b="inv.cust"]') == 'Ana Reyes' and p.input_value('[data-b="inv.lines.0.price"]') == '1500', 'invoice form is pre-filled from the pre-order')
    p.click('button:has-text("Issue invoice no. 2")')
    check('Invoice no. 2' in p.inner_text('#sheet'), 'sale invoice 2 opens'); close(p); synced(p)
    check(stock_map(p)['Maximatic Luffy'] == 3, 'pre-ordered toys left stock on invoice')
    check(rows('Pre-orders')[0][11] == 'Fulfilled' and rows('Pre-orders')[0][14] == 2, 'pre-order fulfilled by invoice 2')
    check(rows('Pre-orders')[0][9:11] == [3000, 0], f"issuing the invoice settled the balance: {rows('Pre-orders')[0][9:11]}")
    tab(p, 'Sell'); check(p.is_visible('button:has-text("Issue invoice no. 3")') and 'New Sale' in p.inner_text('#view'), 'after a sale the Sell tab is ready for the next one')

    # ---- from a toy's sheet: Sell, Pre-order and Order stock start with the toy already picked
    tab(p, 'Stock'); p.click('.item:has-text("Gigo Zoro")'); p.screenshot(path=f'{SHOTS}/19-toy-actions.png'); p.click('#sheet button:has-text("Sell")')
    check('Gigo Zoro' in p.inner_text('#sellBody') and p.is_visible('button:has-text("Issue invoice no. 3")'), 'Sell on a toy opens New Sale with it picked')
    p.screenshot(path=f'{SHOTS}/17-new-sale-from-toy.png')
    p.click('button:has-text("Change")')
    tab(p, 'Stock'); p.click('.item:has-text("Gigo Zoro")'); p.click('#sheet button:has-text("Pre-order")')
    check('New pre-order' in p.inner_text('#sheet') and 'Gigo Zoro' in p.inner_text('#sheet'), 'Pre-order on a toy opens the form with it picked'); p.screenshot(path=f'{SHOTS}/18-preorder-from-toy.png'); close(p)
    tab(p, 'Stock'); p.click('.item:has-text("Gigo Zoro")'); p.click('#sheet button:has-text("Order stock")')
    check('New supplier order' in p.inner_text('#sheet') and 'Gigo Zoro' in p.inner_text('#sheet'), 'Order stock on a toy opens the form with it picked'); close(p)

    # ---- ordinary chat sale: one toy, listed price prefilled, overridden, margin at average cost
    tab(p, 'Sell'); p.click('button[data-s="new"]')
    p.click('button:has-text("Issue invoice")'); check('Pick a toy' in p.inner_text('#toast'), 'invoice needs a toy')
    pick(p, 'inv.lines.0', 'goku')
    check(p.input_value('[data-b="inv.lines.0.price"]') == '1800' and 'On hand 5 · Incoming 0 · Owed 0 · Left to promise 5' in p.inner_text('#view'), 'picking a toy fills the listed price and shows the four numbers')
    p.fill('[data-b="inv.lines.0.price"]', '1700'); p.fill('[data-b="inv.cust"]', 'Ben Cruz')
    check(p.inner_text('#invTotal') == '₱1,700', 'total follows the overridden price'); p.screenshot(path=f'{SHOTS}/10-invoice-form.png')
    p.click('button:has-text("Issue invoice no. 3")')
    sheet = p.inner_text('#sheet'); p.screenshot(path=f'{SHOTS}/11-invoice.png')
    check('Invoice no. 3' in sheet and '(listed ₱1,800)' in sheet and 'Margin ₱500 at average cost' in sheet, 'invoice sheet shows override and margin')
    name, magic, pages = pdf(p, 'invoice-3'); check(name == 'Invoice-3.pdf' and magic == b'%PDF-' and pages == '1', 'invoice PDF is valid')
    p.click('#sheet button:has-text("Mark delivered")'); check(p.is_visible('#sheet button:has-text("✓ Delivered")'), 'Mark delivered turns into ✓ Delivered')
    p.click('#sheet button:has-text("✓ Delivered")'); check(p.is_visible('#sheet button:has-text("Mark delivered")'), 'tapping ✓ Delivered takes the mark off')
    p.click('#sheet button:has-text("Mark delivered")'); close(p); synced(p)
    check(len([q for q in p.evaluate('queue') if q['kind'] == 'ship']) == 0, 'the three taps were sent and cleared')
    inv = [r for r in rows('Invoices') if r[0] == 3][0]; sale = [r for r in rows('Movements') if r[7] == '3']
    check(inv[3] == 'Sale' and inv[5] == 'Ben Cruz' and inv[7] == 1700 and inv[8] == 'Delivered', f'invoice row: {inv}')
    check(len(sale) == 1 and sale[0][4:7] == ['Out', 1, 'Sale'] and sale[0][9] == 1200, f'issuing wrote the stock-out with Ref = invoice number: {sale}')
    ln = [r for r in rows('Invoice lines') if r[0] == 3][0]; check(ln[4:8] == [1, 1800, 1700, 1200], f'line keeps listed price, charged price and cost: {ln}')
    check(stock_map(p)['Grandista Son Goku'] == 4, 'sale took one out of stock')
    tab(p, 'Sell'); p.click('button[data-s="list"]'); check('delivered' in p.inner_text('.item:has-text("No. 3")'), 'the invoice list shows the delivered tag')
    h = home(p)
    check('Sales today\n₱4,700' in h and 'Sales this month\n₱4,700' in h and 'Margin this month\n₱1,900' in h and '2 invoices this month.' in h, f'Home cards after two sales: {h[-200:]!r}')

    # ---- several toys on one invoice; known customer brings the contact; many lines paginate
    tab(p, 'Sell'); p.click('button[data-s="new"]')
    pick(p, 'inv.lines.0', 'zoro'); p.fill('[data-b="inv.lines.0.price"]', '1100')
    p.click('button:has-text("Add another toy")'); pick(p, 'inv.lines.1', 'plain'); p.fill('[data-b="inv.lines.1.price"]', '300'); p.fill('[data-b="inv.lines.1.qty"]', '2')
    p.fill('[data-b="inv.cust"]', 'ana reyes'); p.dispatch_event('[data-b="inv.cust"]', 'change')
    check(p.input_value('[data-b="inv.contact"]') == '+63 917 000 0000' and p.inner_text('#invTotal') == '₱1,700', 'contact filled from the customer tracker; two-line total')
    p.click('button:has-text("Issue invoice no. 4")'); close(p); synced(p)
    check(len([r for r in rows('Movements') if r[7] == '4']) == 2 and len(rows('Customers')) == 2, 'two movements for two lines, no duplicate customer')
    check(stock_map(p)['Plain Toy'] == -1, 'overselling is allowed after the confirm, as before')

    # ---- return: restock brings the toy back, capped at what was sold
    tab(p, 'Sell'); p.click('button[data-s="list"]'); p.screenshot(path=f'{SHOTS}/12-invoice-list.png')
    p.click('.item:has-text("No. 3")'); p.click('button:has-text("Record a return")'); p.fill('[data-b="sub.refund"]', '1700'); p.screenshot(path=f'{SHOTS}/13-return.png')
    p.fill('[data-b="sub.qty"]', '2'); p.click('button:has-text("Record return")'); check('Only 1 can still be returned' in p.inner_text('#toast'), 'return is capped')
    p.fill('[data-b="sub.qty"]', '1'); p.click('button:has-text("Record return")')
    check('Restock' in p.inner_text('#sheet') and 'refunded ₱1,700' in p.inner_text('#sheet') and not p.is_visible('button:has-text("Record a return")'), 'return listed on the invoice; nothing left to return')
    close(p); synced(p)
    rt = rows('Returns')[0]; back = [r for r in rows('Movements') if r[6] == 'Return']
    check(rt[2] == 3 and rt[7:10] == [1, 'Restock', 1700] and len(back) == 1 and back[0][7] == rt[0], f'return row and its In movement: {rt}')
    check(stock_map(p)['Grandista Son Goku'] == 5, 'restocked toy is back on hand')
    tab(p, 'Sell'); p.click('.item:has-text("No. 4")'); p.click('button:has-text("Record a return")'); p.click('#sheet button[data-v="Write-off"]'); p.click('button:has-text("Record return")'); close(p); synced(p)
    check(len([r for r in rows('Movements') if r[6] == 'Return']) == 1 and rows('Returns')[1][8] == 'Write-off', 'a write-off records the return without a stock movement')

    # ---- cancellation: kept deposit typed each time, no stock movement
    n_moves = len(rows('Movements'))
    tab(p, 'Orders'); p.click('button[data-s="pre"]'); p.click('button:has-text("New pre-order")')
    pick(p, 'f', 'zoro'); p.fill('[data-b="f.cust"]', 'Carla Santos'); p.fill('[data-b="f.contact"]', 'm.me/carla'); p.fill('[data-b="f.price"]', '1100'); p.fill('[data-b="f.paid"]', '500')
    p.click('button:has-text("Save and make receipt no. 5")'); close(p)
    check('ready to ship' in p.inner_text('#view').lower(), 'a pre-order for a toy already on hand is ready at once')
    p.click('.item:has-text("Carla Santos") .name'); p.click('#sheet button.danger:has-text("Cancel")')
    check('Leave blank for a full refund' == p.get_attribute('[data-b="sub.kept"]', 'placeholder'), 'cancel asks only for the deposit kept')
    p.fill('[data-b="sub.kept"]', '600'); p.click('button:has-text("Cancel the pre-order")'); check('more than what was paid' in p.inner_text('#toast'), 'deposit kept cannot exceed what was paid')
    p.fill('[data-b="sub.kept"]', '200'); p.screenshot(path=f'{SHOTS}/14-cancel.png'); p.click('button:has-text("Cancel the pre-order")')
    check('Cancelled, kept ₱200' in p.inner_text('#sheet'), 'cancelled with the typed deposit'); close(p); synced(p)
    cp = [r for r in rows('Pre-orders') if r[3] == 'Carla Santos'][0]
    check(cp[11] == 'Cancelled' and cp[12] == 200 and len(rows('Movements')) == n_moves, f'cancellation in the sheet, stock untouched: {cp[11:13]}')

    # ---- a second phone sees the same documents
    ctx2 = b.new_context(viewport={'width': 390, 'height': 844}); p2 = ctx2.new_page(); p2.on('dialog', lambda d: d.accept()); p2.on('pageerror', lambda e: errors.append('p2 ' + str(e)))
    p2.goto(APP); connect(p2); synced(p2)
    check(stock_map(p2) == stock_map(p), f'device 2 stock matches: {stock_map(p2)}')
    tab(p2, 'Sell'); p2.click('button[data-s="list"]'); check(len(p2.query_selector_all('#invList .item')) == 5, 'device 2 lists all five documents')
    p2.click('.item:has-text("No. 3")'); check('Margin ₱500' in p2.inner_text('#sheet') and 'Restock' in p2.inner_text('#sheet'), 'device 2 sees margin and the return'); close(p2)

    # ---- offline: invoice issued with no signal waits, then lands once
    ctx.set_offline(True)
    tab(p, 'Sell'); p.click('button[data-s="new"]'); pick(p, 'inv.lines.0', 'goku'); p.fill('[data-b="inv.cust"]', 'Ben Cruz'); p.click('button:has-text("Issue invoice no. 6")')
    check('waiting' in p.inner_text('#sheet') and 'Delete this invoice' in p.inner_text('#sheet'), 'offline invoice is marked waiting and can still be deleted')
    name, magic, pages = pdf(p, 'invoice-6-offline'); check(magic == b'%PDF-', 'PDF works offline'); close(p)
    check(stock_map(p)['Grandista Son Goku'] == 4, 'offline invoice already counts against stock')
    ctx.set_offline(False); p.click('#syncBtn'); synced(p)
    check(len([r for r in rows('Invoices') if r[0] == 6]) == 1 and len([r for r in rows('Movements') if r[7] == '6']) == 1, 'offline invoice reached the sheet once')

    # ---- shop details and logo appear on the PDF; long invoices paginate
    logo = f'{SHOTS}/logo.png'
    p.evaluate("""() => { const c = document.createElement('canvas'); c.width = 300; c.height = 120; const x = c.getContext('2d'); x.fillStyle = '#e4572e'; x.fillRect(0, 0, 300, 120); x.fillStyle = '#fff'; x.font = '700 48px sans-serif'; x.fillText('SHOP', 70, 78); window._logo = c.toDataURL('image/png'); }""")
    import base64; open(logo, 'wb').write(base64.b64decode(p.evaluate('window._logo').split(',')[1]))
    p.click('button[aria-label="Settings"]'); p.fill('#sShop', 'Sample Toy Shop'); p.fill('#sContact', 'm.me/sampletoys\n0917 000 0000'); p.fill('#sFoot', 'Thank you for your order.')
    p.set_input_files('#sLogo', logo); p.wait_for_selector('#sheet img.logo')
    check(p.input_value('#sShop') == 'Sample Toy Shop', 'typed shop fields survive the logo upload'); p.screenshot(path=f'{SHOTS}/15-settings.png')
    p.click('#sheet button.primary:has-text("Save")')
    tab(p, 'Sell'); p.click('button[data-s="list"]'); p.click('.item:has-text("No. 4")'); pdf(p, 'invoice-4-branded'); close(p)
    p.click('.item:has-text("No. 1")'); pdf(p, 'receipt-1-branded'); close(p)
    many = p.evaluate("""async () => { const v = live().invs.find(x => x.no === 4); const big = { ...v, lines: Array.from({ length: 45 }, (_, i) => ({ ...v.lines[0], name: 'Sample toy with a fairly long product name, variant ' + (i + 1) })) }; const b = await docPdf(big); return Array.from(new Uint8Array(await b.arrayBuffer())); }""")
    open(f'{SHOTS}/long.pdf', 'wb').write(bytes(many)); info = subprocess.run(['pdfinfo', f'{SHOTS}/long.pdf'], capture_output=True, text=True).stdout
    subprocess.run(['pdftoppm', '-r', '50', '-png', f'{SHOTS}/long.pdf', f'{SHOTS}/long'])
    check(int(re.search(r'Pages:\s+(\d+)', info).group(1)) >= 2, 'a 45-line invoice runs onto more pages')

    # ---- invoice number already used in the sheet (second phone): renumbered, both kept
    ctx2.set_offline(True)
    tab(p2, 'Sell'); p2.click('button[data-s="new"]'); pick(p2, 'inv.lines.0', 'luffy'); p2.fill('[data-b="inv.lines.0.price"]', '1500'); p2.fill('[data-b="inv.cust"]', 'Dan Lim'); p2.click('button:has-text("Issue invoice no. 6")'); close(p2)
    ctx2.set_offline(False); p2.click('#syncBtn'); p2.wait_for_function("document.querySelector('#toast').textContent.includes('now no. 7')", timeout=8000)
    nos = sorted(r[0] for r in rows('Invoices')); check(nos == [1, 2, 3, 4, 5, 6, 7], f'numbers stay unique and sequential: {nos}')
    check([r[7] for r in rows('Movements') if r[2] == 'T0002' and r[6] == 'Sale'][-1] == '7', 'the renumbered invoice’s movement carries the new number')

    # ---- activity shows document movements; a refused document is explained
    home(p); p.click('#view button:has-text("All stock activity")'); p.click('#syncBtn'); synced(p); p.screenshot(path=f'{SHOTS}/16-activity.png')
    check('invoice 3' in p.inner_text('#view'), 'activity names the invoice behind a sale')
    for name in ['Home', 'Stock', 'Sell', 'Orders', 'Import']:
        tab(p, name); p.screenshot(path=f"{SHOTS}/tab-{name.lower()}.png")
    if not p.is_visible('#impText'): p.click('#manual summary')
    p.click('button[data-m="receive"]'); p.screenshot(path=f'{SHOTS}/tab-import-receive.png')
    tab(p, 'Orders'); p.click('button[data-s="pre"]'); p.screenshot(path=f'{SHOTS}/tab-orders-pre.png')

    # ---- promised beyond stock and incoming; a cancel with nothing kept is a full refund
    check(stock_map(p)['Plain Toy'] == -1 and 'Promised beyond stock' not in home(p), 'a toy below zero with nothing owed is not counted as promised')
    tab(p, 'Orders'); p.click('button[data-s="pre"]'); p.click('button:has-text("New pre-order")')
    pick(p, 'f', 'plain'); p.fill('[data-b="f.qty"]', '5'); p.fill('[data-b="f.price"]', '300'); p.fill('[data-b="f.cust"]', 'Eva Cruz'); p.fill('[data-b="f.contact"]', '0917 111 2222'); p.fill('[data-b="f.paid"]', '100')
    p.click('button:has-text("Save and make receipt no. 8")'); close(p)
    h = home(p)
    check('Promised beyond stock\nMore owed than on hand plus incoming\n1' in h and 'Pre-orders with a balance\n₱1,400 still to collect\n1' in h, 'Home: a pre-order beyond stock and incoming')
    p.click('#view .item:has-text("Promised beyond stock")')
    check(p.is_visible('#view .chip.on:has-text("Promised beyond stock ✕")') and stock_names(p) == ['Plain Toy'], 'the row opens Stock filtered to that toy')
    p.click('#view .chip.on:has-text("✕")')
    tab(p, 'Orders'); p.click('.item:has-text("Eva Cruz")'); p.click('#sheet button.danger:has-text("Cancel")'); p.click('button:has-text("Cancel the pre-order")')
    check('Cancelled, refunded in full' in p.inner_text('#sheet'), 'blank deposit kept means a full refund'); close(p); synced(p)
    ep = [r for r in rows('Pre-orders') if r[3] == 'Eva Cruz'][0]
    check(ep[11:13] == ['Cancelled', 0], f'full refund in the sheet: {ep[11:13]}')
    check('Promised beyond stock' not in home(p), 'a cancelled pre-order is no longer owed')

    check(not errors, f'no page errors: {errors}')
    b.close()
print('\nFAILED:' if fails else '\nALL PASSED', *fails, sep='\n')
sys.exit(1 if fails else 0)
