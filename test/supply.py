# Supplier orders: an Ordered batch in Add inventory, the Suppliers page, receiving per line (partial, then the rest), Cancel the rest,
# and an Inbox Order row. Runs on the device first; the last block syncs and reads the sheet.
# python3 test/supply.py  (needs static server on 8765, mock backend on 8766, Chrome)
import datetime
from playwright.sync_api import sync_playwright
from common import *

TODAY = datetime.date.today().isoformat()
with sync_playwright() as pw:
    b = launch(pw)
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); p = page(ctx)
    p.goto(APP); p.wait_for_selector('#tabs button')
    p.evaluate("() => { qItem({ sku: 'T0001', name: 'Alpha Figure', price: 900, active: true }, true); qItem({ sku: 'T0002', name: 'Bravo Figure', price: 700, active: true }, true); commit(); }")
    kinds = lambda k: [q for q in p.evaluate('queue') if q['kind'] == k]
    line = lambda name: p.evaluate(f"live().orders.find(o => o.name === '{name}')")

    # ---- an Ordered batch of two products: one order with two lines, no stock
    tab(p, 'Inventory'); p.click('.item:has-text("Alpha Figure")'); p.click('#sheet button:has-text("Order stock")')
    check(p.inner_text('#title') == 'Inventory' and 'on' in p.get_attribute('#view .seg button[data-f="add"]', 'class') and p.get_attribute('#impOut button[data-act="ordOn"][data-v="1"]', 'class') == 'on' and 'Alpha Figure' in p.inner_text('#impOut'), 'Order stock opens Add inventory set to Ordered with the product as a row')
    p.click('#impOut [data-act="impFix"]:has-text("Alpha Figure")'); p.fill('#fxCount', '3'); p.fill('#fxCost', '500')
    check(p.query_selector('#sheet [data-costbox]') is None, 'Correct this row in an Ordered batch has one Cost each field'); p.click('#sheet button:has-text("Save")')
    p.click('#impOut button:has-text("Add a row")'); check(p.inner_text('#sheet h2') == 'Correct this row' and p.input_value('#fxName') == '', 'Add a row opens Correct this row on an empty row')
    p.fill('#fxName', 'Bravo Figure'); p.fill('#fxCount', '2'); p.fill('#fxCost', '300'); p.click('#sheet button:has-text("Save")')
    check('Alpha Figure: 3 ordered at ₱500 each' in p.inner_text('#impOut') and 'Bravo Figure: 2 ordered at ₱300 each' in p.inner_text('#impOut'), 'saving adds the row to the review')
    p.click('button:has-text("Apply 2 changes")'); check('supplier’s name' in p.inner_text('#toast') and not kinds('order'), 'Ordered needs the supplier')
    p.fill('#oSup', 'Toyline Trading'); p.fill('#oExp', TODAY)
    out = apply(p, 'Apply 2 changes')
    o = kinds('order'); sup = kinds('supplier')
    check('Recorded: a supplier order of 2 lines' in out and len(o) == 1 and len(sup) == 1 and sup[0]['supplier']['name'] == 'Toyline Trading' and o[0]['order']['supId'] == sup[0]['supplier']['id'], f'Apply Ordered queues the new supplier and one order: {o}')
    check([(l['sku'], l['qty'], l['cost']) for l in o[0]['order']['lines']] == [('T0001', 3, 500), ('T0002', 2, 300)] and o[0]['order']['expected'] == TODAY and not kinds('move'), 'the order has one line per row with its cost each, and moves no stock')
    check(p.evaluate("[stockOf('T0001'), nums('T0001').inc, nums('T0002').inc]") == [0, 3, 2], 'the lines count as incoming')

    # ---- the Suppliers page: the supplier list, and Home's due row opening the order lines
    tab(p, 'Suppliers'); check(p.inner_text('#title') == 'Suppliers' and 'Toyline Trading\n2 open lines' in p.inner_text('#view'), 'the Suppliers tab lists the supplier with its open lines')
    p.click('#view .item:has-text("Toyline Trading")'); p.fill('#spContact', 'm.me/toyline'); p.click('#sheet button:has-text("Save")')
    check(kinds('supplier')[-1]['supplier'] == {**sup[0]['supplier'], 'contact': 'm.me/toyline'}, 'the supplier sheet edits its details')
    check('Receive 2 supplier order lines due\nAlpha Figure, Bravo Figure' in home(p), 'Home: the order lines expected today are due')
    p.click('#view .item:has-text("supplier order lines due")')
    check(p.inner_text('#title') == 'Suppliers' and p.get_attribute('#view button[data-s="orders"]', 'class') == 'on' and 'On the way' in p.inner_text('#view'), 'the due row opens Suppliers > Orders')

    # ---- a partial receive, then the rest
    p.click('#view .item:has-text("Alpha Figure")'); check('Order from Toyline Trading' in p.inner_text('#sheet h2') and p.is_visible('#sheet button:has-text("Receive all")'), 'a line opens its order with every line and Receive all')
    p.click('#sheet .item:has-text("Alpha Figure") button:has-text("Receive")')
    check(p.input_value('#rcQty') == '3' and [e.input_value() for e in p.query_selector_all('#sheet [data-cost="sub.c"]')] == ['500'] * 3, 'receiving starts at the quantity due, each unit at the cost each')
    p.fill('#rcQty', '1'); p.click('#sheet button:has-text("Received")')
    a = line('Alpha Figure'); r = kinds('receive')
    check(r[0]['lineId'] == a['id'] and r[0]['from'] == 0 and r[0]['costs'] == [500] and a['status'] == 'Ordered' and a['recQty'] == 1, f'a partial receive leaves the line open: {r} {a["status"]}')
    check(p.evaluate("[stockOf('T0001'), nums('T0001').inc, live().all.filter(m => m.id.startsWith('rcv-')).map(m => [m.id, m.cost, m.ref])]") == [1, 2, [[f"rcv-{a['id']}-1", 500, a['orderId']]]], 'it writes one In per unit with the line cost, Ref the order')
    p.click('#sheet .item:has-text("Alpha Figure") button:has-text("Receive")'); check(p.input_value('#rcQty') == '2', 'the rest is what is still due')
    p.click('#sheet button:has-text("Received")'); a = line('Alpha Figure')
    check(kinds('receive')[1]['from'] == 1 and a['status'] == 'Received' and p.evaluate("[stockOf('T0001'), nums('T0001').inc, live().all.filter(m => m.id.startsWith('rcv-')).length]") == [3, 0, 3], 'receiving the rest closes the line')

    # ---- Cancel the rest
    check(p.input_value('#rcQty') == '2' and 'Receive Bravo Figure' in p.inner_text('#sheet'), 'with one line left its receive form shows at once')
    p.fill('#rcQty', '1'); p.click('#sheet button:has-text("Received")'); p.click('#sheet .item:has-text("Bravo Figure") button:has-text("Cancel the rest")')
    bv = line('Bravo Figure')
    check(kinds('orderCancel')[0]['lineId'] == bv['id'] and bv['status'] == 'Cancelled' and bv['recQty'] == 1 and p.evaluate("[stockOf('T0002'), nums('T0002').inc]") == [1, 0], 'Cancel the rest closes the line; the received part stays')
    close(p); check('supplier order line' not in home(p), 'nothing is due once every line is closed')

    # ---- an Inbox Order row opens as Ordered with its Supplier and Expected
    p.evaluate("() => { docs.inbox = [{ row: 2, type: 'order', added: '', name: 'Alpha Figure', qty: '4', cost: '450', supplier: 'Kanto Hobby', expected: '2026-12-01', note: '' }]; dirty(); render(); }")
    add_inventory(p)
    check(p.get_attribute('#impOut button[data-act="ordOn"][data-v="1"]', 'class') == 'on' and p.input_value('#oSup') == 'Kanto Hobby' and p.input_value('#oExp') == '2026-12-01' and 'Alpha Figure: 4 ordered at ₱450 each' in p.inner_text('#impOut'), 'an Inbox Order row opens as Ordered with Supplier and Expected pre-filled')
    apply(p, 'Apply 1 change')
    o = kinds('order')[-1]['order']; d = kinds('inboxDone')[-1]
    check(len(kinds('order')) == 2 and [(l['sku'], l['qty'], l['cost']) for l in o['lines']] == [('T0001', 4, 450)] and o['expected'] == '2026-12-01' and d['rows'][0]['row'] == 2 and d['mark'] == 'Done', 'applying it records the order and marks the Inbox row done')
    no_toy(p, 'Add inventory')
    tab(p, 'Suppliers'); no_toy(p, 'Suppliers'); p.click('#view button[data-s="orders"]'); no_toy(p, 'Suppliers > Orders')
    check(not errors, f'no page errors: {errors}')

    # ---- the sheet (needs the 2.5 Code.gs): suppliers, one row per order line, the receipts as per-unit movements
    connect(p); p.wait_for_function("!ui.busy && (document.querySelector('#syncTxt').textContent.startsWith('Synced') || queue.some(q => q.status === 'failed'))", timeout=8000)
    check(not [q for q in p.evaluate('queue') if q['status'] == 'failed'], f"the sheet takes the supplier, order, receive and orderCancel entries: {[q['kind'] + ': ' + q.get('error', '') for q in p.evaluate('queue')]}")
    tabs = dump(); tab_rows = lambda n: tabs[n]['rows'][1:] if n in tabs else []
    so = tab_rows('Supplier orders'); mv = [r for r in tab_rows('Movements') if str(r[0]).startswith('rcv-')]
    check(sorted(r[1] for r in tab_rows('Suppliers')) == ['Kanto Hobby', 'Toyline Trading'], f"the sheet has both suppliers: {tab_rows('Suppliers')}")
    check(len(so) == 3 and so[0][1] == so[1][1] != so[2][1] and [(r[5], r[6], r[7], r[8], r[10] or 0, r[11]) for r in so] == [('T0001', 'Alpha Figure', 3, 500, 3, 'Received'), ('T0002', 'Bravo Figure', 2, 300, 1, 'Cancelled'), ('T0001', 'Alpha Figure', 4, 450, 0, 'Ordered')], f'the sheet has one row per order line: {so}')
    check(len(so) == 3 and sorted(r[0] for r in mv) == sorted([f'rcv-{so[0][0]}-{k}' for k in (1, 2, 3)] + [f'rcv-{so[1][0]}-1']) and all(r[7] == so[0][1] for r in mv), f'the receipts reached the sheet once, Ref the order: {mv}')
    b.close()
finish()
