# Pre-order lines on an invoice: a mixed sale (one line delivered, one to follow with an expected date), linking the line to a
# supplier-order line, a payment, the invoice image, shipping the line once stock covers it, and cancelling a to-follow line.
# python3 test/follow.py  (needs static server on 8765, mock backend on 8766, Chrome)
import datetime, re
from playwright.sync_api import sync_playwright
from common import *

TODAY = datetime.date.today()
EXP, EXP2 = (TODAY + datetime.timedelta(days=20)).isoformat(), (TODAY + datetime.timedelta(days=30)).isoformat()
def on(p, i): return p.is_checked(f'[data-act="invFollow"][data-i="{i}"]')
def day(p, iso): return p.evaluate(f'fmtDay("{iso}")')

with sync_playwright() as pw:
    b = launch(pw)
    ctx = b.new_context(viewport={'width': 390, 'height': 844})
    p = page(ctx)
    p.goto(APP); connect(p); synced(p)
    paste_import(p, 'count', 'Luffy Figure\t1\t1500\t\t\t\t\t\t\t\t800\nZoro Figure\t0\t1100'); apply(p, 'Apply 2 changes'); synced(p)

    # ---- one invoice: the unit on hand leaves stock now, two more are to follow
    home(p); p.click('#view button:has-text("New sale")'); pick(p, 'inv.lines.0', 'luffy')
    check(not on(p, 0) and not p.is_visible('#iPaid') and p.inner_text('#invHint') == 'Takes 1 Luffy Figure out of stock and opens the invoice.', 'a line the stock covers is sold now')
    p.fill('[data-b="inv.lines.0.qty"]', '3')
    check(on(p, 0) and p.is_visible('#iPaid') and p.evaluate('document.activeElement.dataset.b') == 'inv.lines.0.qty', 'asking more than is free to sell turns Pre-order on and shows Paid now; the quantity keeps focus')
    p.fill('[data-b="inv.lines.0.qty"]', '1'); p.click('button:has-text("Add another product")'); pick(p, 'inv.lines.1', 'luffy'); p.fill('[data-b="inv.lines.1.qty"]', '2')
    check(not on(p, 0) and on(p, 1) and p.inner_text('#invHint') == 'Takes 1 Luffy Figure out of stock, leaves 2 Luffy Figure to follow, and opens the invoice.', 'the same product on a second line is to follow')
    p.fill('#e1', EXP); p.fill('[data-b="inv.cust"]', 'Ana Reyes'); p.click('#view [data-act="invIssue"]')
    check('phone or Messenger' in p.inner_text('#toast'), 'a to-follow line needs the contact')
    p.fill('[data-b="inv.contact"]', '0917 000 0000'); p.fill('[data-b="inv.paid"]', '1000')
    check(p.inner_text('#invTotal') == '₱4,500' and p.inner_text('#invBal') == '₱3,500', 'the form shows the total and the balance')
    p.click('button:has-text("Issue invoice no. 1")'); sheet = p.inner_text('#sheet')
    check(f'To follow · expected {day(p, EXP)}' in sheet and 'Paid ₱1,000 · balance ₱3,500' in sheet and 'Margin known once the to-follow lines ship' in sheet, 'the invoice shows the line to follow, paid and balance')
    close(p); synced(p)
    inv = rows('Invoices')[0]; vid = inv[1]; ln = rows('Invoice lines'); sales = [r for r in rows('Movements') if r[6] == 'Sale']
    check(inv[4] == 'Ana Reyes' and inv[6:10] == [4500, 1000, 3500, ''], f'one invoice with paid and balance: {inv}')
    check([r[2] for r in ln] == [1, 2] and ln[0][8:10] == [800, 'Delivered'] and ln[1][8:12] == ['', 'To follow', EXP, ''], f'one line delivered, one to follow: {ln}')
    check([(r[0], r[5]) for r in sales] == [(f'{vid}-1', 1)], f'only the delivered line left stock: {sales}')
    tab(p, 'Inventory'); p.click('.item:has-text("Luffy Figure")')
    check(re.search(r'On hand\s+0\s+Incoming\s+0\s+Owed\s+2\s+Left to promise\s+-2', p.inner_text('#sheet')) is not None, 'the to-follow units are owed'); close(p)

    # ---- an open supplier-order line for the product: the to-follow line can wait for it
    p.evaluate(f"""() => {{ qAdd('supplier', {{ supplier: {{ id: 's1', name: 'Shop Supply', contact: '', note: '' }} }});
      qAdd('order', {{ order: {{ id: 'o1', date: todayISO(), supId: 's1', expected: '{EXP2}', note: '', lines: [{{ id: 'ol1', sku: live().list.find(i => i.name === 'Luffy Figure').sku, qty: 4, cost: 700 }}] }} }}); commit(); }}""")
    synced(p)
    new_sale(p); pick(p, 'inv.lines.0', 'luffy')
    check(on(p, 0) and p.input_value('#o0') == 'ol1' and p.eval_on_selector('#o0', 'e => e.selectedOptions[0].text') == f'{day(p, EXP2)} · Shop Supply', 'nothing free to sell: Pre-order is on, waiting for the open supplier-order line')
    p.click('#backBtn')
    tab(p, 'Sales'); p.click('.item:has-text("No. 1")'); p.click('#sheet button:has-text("Change expected date")')
    check(p.input_value('#oS') == '' and p.input_value('#eS') == EXP, 'the line keeps its typed date until another is picked')
    p.select_option('#oS', 'ol1'); p.click('#sheet [data-act="followSave"]')
    check(f'To follow · expected {day(p, EXP2)}' in p.inner_text('#sheet'), 'linked to the order line, the line follows its date'); close(p); synced(p)
    check(rows('Invoice lines')[1][9:12] == ['To follow', EXP2, 'ol1'], f"the link reached the sheet: {rows('Invoice lines')[1]}")
    tab(p, 'Suppliers'); p.click('#view button[data-s="orders"]')
    check('2 waiting' in p.inner_text('#view .item:has-text("Luffy Figure")'), 'the order line counts the to-follow units waiting for it')

    # ---- a payment, then Home asks to collect the rest
    check('Collect ₱3,500 on 1 invoice\nBalances still open' in home(p), 'Home: collect the balance')
    p.click('#view .item:has-text("Collect ₱3,500")')
    check(p.get_attribute('#invSeg button[data-f="unpaid"]', 'class') == 'on' and len(p.query_selector_all('#invList .item')) == 1, 'the row opens Sales filtered to unpaid')
    p.click('.item:has-text("No. 1")'); p.click('#sheet button:has-text("Add a payment")'); p.fill('[data-b="sub.paid"]', '5000'); p.click('#sheet [data-act="paySave"]')
    check('more than the balance' in p.inner_text('#toast'), 'a payment cannot exceed the balance')
    p.fill('[data-b="sub.paid"]', '1000'); p.click('#sheet [data-act="paySave"]')
    check('Paid ₱2,000 · balance ₱2,500' in p.inner_text('#sheet'), 'the payment lowers the balance')
    drawn = p.evaluate("""() => { const f = CanvasRenderingContext2D.prototype.fillText, out = []; CanvasRenderingContext2D.prototype.fillText = function (s, ...a) { out.push(String(s)); return f.call(this, s, ...a); };
      try { drawDoc(live().invs[0]); } finally { CanvasRenderingContext2D.prototype.fillText = f; } return out; }""")
    d2 = datetime.date.fromisoformat(EXP2); has = lambda t: any(t in s for s in drawn)   # amounts by their start: the image may add decimals
    check('Invoice' in drawn and 'Expected arrival' in drawn and f'{d2.month}/{d2.day}/{d2.year}' in drawn and 'Paid' in drawn and has('₱2,000') and has('₱2,500'), f'the image gives the to-follow line its expected arrival and shows Paid and the balance: {drawn}')
    close(p); synced(p)
    check(rows('Invoices')[0][7:9] == [2000, 2500], f"the payment reached the sheet: {rows('Invoices')[0]}")

    # ---- stock arrives: Home asks to ship the line, which leaves stock under the same invoice number
    tab(p, 'Inventory'); p.click('.item:has-text("Luffy Figure")'); p.click('#sheet button:has-text("Stock in")'); p.fill('#mvQty', '2')
    for k in (0, 1): p.fill(f'[data-cost="mv.c"][data-k="{k}"]', '900')
    p.click('button:has-text("Record stock in")'); synced(p)
    check('Ship Ana Reyes’s to-follow lines\nLuffy Figure × 2 · balance ₱2,500' in home(p), 'Home lists the ready line as a job')
    p.click('#view .item:has-text("Ship Ana Reyes")')
    check('ready to ship' in p.inner_text('#sheet') and p.is_visible('#sheet [data-act="lineShip"]'), 'the row opens the invoice, where the line can ship')
    p.click('#sheet [data-act="lineShip"]'); sheet = p.inner_text('#sheet')
    check('To follow' not in sheet and 'Margin ₱1,900' in sheet, 'shipped: the line is delivered at its FIFO cost'); close(p); synced(p)
    ln = rows('Invoice lines')[1]; mv = [r for r in rows('Movements') if r[0] == f'{vid}-2']
    check(ln[8:10] == [900, 'Delivered'] and ln[12] == TODAY.isoformat(), f'the line is delivered in the sheet: {ln}')
    check(len(mv) == 1 and mv[0][4:10] == ['Out', 2, 'Sale', '1', '', 900], f'one Sale movement under the invoice number: {mv}')
    check('Ship ' not in home(p) and stock_map(p)['Luffy Figure'] == 0, 'nothing left to ship')

    # ---- cancelling a to-follow line takes it off the total and refunds what was paid beyond it
    new_sale(p); pick(p, 'inv.lines.0', 'zoro'); p.fill('[data-b="inv.cust"]', 'Ben Cruz'); p.fill('[data-b="inv.contact"]', 'm.me/ben')
    check(on(p, 0), 'a product not in stock starts as a pre-order')
    p.click('button:has-text("Issue invoice no. 2")')
    check(not p.is_visible('#sheet button:has-text("Record a return")'), 'a line still to follow takes no return')
    p.click('#sheet [data-act="invSub"][data-m="lineCancel"]')
    check(p.get_attribute('[data-b="sub.refund"]', 'placeholder') == 'Leave blank for ₱1,100', 'cancelling asks what was refunded, the amount paid beyond the new total by default')
    p.fill('[data-b="sub.refund"]', '2000'); p.click('button:has-text("Cancel this line")'); check('more than the ₱1,100 paid' in p.inner_text('#toast'), 'the refund cannot exceed what was paid')
    p.fill('[data-b="sub.refund"]', ''); p.click('button:has-text("Cancel this line")'); sheet = p.inner_text('#sheet')
    check('cancelled' in sheet and 'Total\n₱0' in sheet and 'balance' not in sheet, 'the line is cancelled and off the total'); close(p); synced(p)
    inv2 = rows('Invoices')[1]; check(inv2[6:9] == [0, 0, 0] and rows('Invoice lines')[2][9] == 'Cancelled', f'the sheet has the cancelled line and the refund: {inv2}')
    tab(p, 'Sales'); p.click('.item:has-text("No. 1")'); check(p.is_visible('#sheet button:has-text("Record a return")'), 'a delivered line takes a return'); close(p)

    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
