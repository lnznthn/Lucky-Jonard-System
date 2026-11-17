# End-to-end test of units and cost (spec items 4 and 6): one cost per unit, FIFO sales, cost changes, deficits,
# returns, reversals, the Needs you row and its Stock filter. Drives the app at phone size against the mock backend.
# python3 test/cost.py  (needs the static server on APP_PORT and the mock backend on API_PORT, Chrome)
import json, os
from playwright.sync_api import sync_playwright
from common import *

SHOTS = '/tmp/shots-cost'
os.makedirs(SHOTS, exist_ok=True)
def open_item(p, name): tab(p, 'Stock'); p.click('#view .seg button[data-f="all"]'); p.click(f'#stockList .item:has-text("{name}")')
def units(p): return [e.input_value() for e in p.query_selector_all('#sheet [data-unit]')]
def unit_cost(p, k, value): f = p.locator('#sheet [data-unit]').nth(k); f.fill(value); f.blur()   # a changed field saves when it loses focus
def cost_fields(p, path): return [e.input_value() for e in p.query_selector_all(f'[data-cost="{path}"]')]
def add_item(p, name, price=None, start=0, costs=()):
    tab(p, 'Stock'); p.click('#view [data-act="newItem"]'); p.fill('#fName', name)
    if price is not None: p.fill('#fPrice', str(price))
    p.fill('#fStart', str(start))
    for k, c in enumerate(costs): p.fill(f'#sheet [data-cost="f.c"][data-k="{k}"]', str(c))
    p.click('#sheet button.primary:has-text("Save")')
def stock_in(p, name, costs):
    open_item(p, name); p.click('#sheet button:has-text("Stock in")'); p.fill('#mvQty', str(len(costs)))
    for k, c in enumerate(costs): p.fill(f'[data-cost="mv.c"][data-k="{k}"]', str(c))
    p.click('button:has-text("Record stock in")')
def sell(p, name, price, cust, qty=1):
    new_sale(p); pick(p, 'inv.lines.0', name); p.fill('[data-b="inv.lines.0.qty"]', str(qty)); p.fill('[data-b="inv.lines.0.price"]', str(price)); p.fill('[data-b="inv.cust"]', cust)
def issue(p): p.click('#view [data-act="invIssue"]'); text = p.inner_text('#sheet'); close(p); return text
def sku_of(p, name): return p.evaluate(f"live().list.find(i => i.name === {json.dumps(name)}).sku")

with sync_playwright() as pw:
    b = launch(pw)
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    p = page(ctx)
    p.goto(APP); connect(p); synced(p)

    # ---- more than 12 units: one Cost each field that opens into one field per unit
    tab(p, 'Stock'); p.click('#view [data-act="newItem"]'); p.fill('#fName', 'Cost Many'); p.fill('#fStart', '13')
    check([e.inner_text() for e in p.query_selector_all('#sheet [data-costbox] label')] == ['Cost each'] and p.is_visible('#sheet button:has-text("Different costs per unit")'), 'thirteen units show one Cost each field and Different costs per unit')
    p.fill('#sheet [data-cost="f.c"][data-k="0"]', '25'); p.click('#sheet button:has-text("Different costs per unit")')
    labels = [e.inner_text() for e in p.query_selector_all('#sheet [data-costbox] label')]
    check(labels == [f'Unit {k} cost' for k in range(1, 14)] and cost_fields(p, 'f.c') == ['25'] * 13, f'it opens into thirteen fields holding the cost typed: {labels[:2]}…')
    p.screenshot(path=f'{SHOTS}/01-many-units.png'); close(p)

    # ---- four units in at four costs: one field per unit, the first fills the ones not typed in
    add_item(p, 'Cost Alpha', price=1000)
    open_item(p, 'Cost Alpha'); sheet = p.inner_text('#sheet')
    check('Left to promise is on hand, plus incoming supplier orders, minus units owed to open pre-orders.' in sheet and 'None on hand.' in sheet, 'the item sheet explains Left to promise and has no units on hand yet')
    p.click('#sheet button:has-text("Stock in")'); p.fill('#mvQty', '4')
    check([e.inner_text() for e in p.query_selector_all('[data-costbox] label')] == ['Unit 1 cost', 'Unit 2 cost', 'Unit 3 cost', 'Unit 4 cost'], 'Stock in shows one cost field per unit')
    p.fill('[data-cost="mv.c"][data-k="0"]', '100'); check(cost_fields(p, 'mv.c') == ['100'] * 4, 'typing in the first field fills the others')
    for k, c in ((1, '200'), (2, '300'), (3, '400')): p.fill(f'[data-cost="mv.c"][data-k="{k}"]', c)
    p.fill('[data-cost="mv.c"][data-k="0"]', '150'); check(cost_fields(p, 'mv.c') == ['150', '200', '300', '400'], 'the first field leaves alone the fields typed in')
    p.fill('[data-cost="mv.c"][data-k="0"]', '100'); p.screenshot(path=f'{SHOTS}/02-stock-in.png'); p.click('button:has-text("Record stock in")'); synced(p)
    mv = [r for r in rows('Movements') if r[3] == 'Cost Alpha']; base = mv[0][0][:-2]
    check([r[0] for r in mv] == [f'{base}-{k}' for k in (1, 2, 3, 4)] and [r[4:7] for r in mv] == [['In', 1, 'Restock']] * 4 and [r[9] for r in mv] == [100, 200, 300, 400], f'one In row per unit, Qty 1, with its cost: {[(r[0], r[9]) for r in mv]}')
    open_item(p, 'Cost Alpha'); sheet = p.inner_text('#sheet'); p.screenshot(path=f'{SHOTS}/03-units-on-hand.png', full_page=True)
    check(units(p) == ['100', '200', '300', '400'] and 'Restock · Next to leave' in sheet and sheet.count('Next to leave') == 1 and 'Cost of stock on hand ₱1,000.' in sheet, 'Units on hand lists each unit oldest first, the first marked Next to leave')
    close(p)

    # ---- two sales: each carries the cost of the oldest unit
    sell(p, 'cost alpha', 1000, 'Ana Cruz'); check('no cost yet' not in p.inner_text('#sellBody'), 'no no-cost line when the units have a cost')
    check('Margin ₱900' in issue(p), 'the first sale takes the ₱100 unit: Margin ₱900')
    sell(p, 'cost alpha', 1000, 'Ben Cruz'); check('Margin ₱800' in issue(p), 'the second sale takes the ₱200 unit: Margin ₱800')
    synced(p)
    check([r[7] for r in rows('Invoice lines') if r[3] == 'Cost Alpha'] == [100, 200] and [r[9] for r in rows('Movements') if r[3] == 'Cost Alpha' and r[6] == 'Sale'] == [100, 200], 'invoice lines and Sale movements carry the oldest units’ costs')
    open_item(p, 'Cost Alpha'); check(units(p) == ['300', '400'] and 'Cost of stock on hand ₱700.' in p.inner_text('#sheet'), f'the item sheet lists the two units that remain: {units(p)}'); close(p)
    check('Margin\n₱1,700' in home(p), 'Home adds the margin of both sales')

    # ---- a cost changed on a unit on hand shows on the item sheet, in Browse and on a second device
    ctx2 = b.new_context(viewport={'width': 390, 'height': 844}); p2 = page(ctx2, 'p2 ')
    p2.goto(APP); connect(p2); synced(p2)
    open_item(p2, 'Cost Alpha'); check(units(p2) == ['300', '400'], 'device 2 sees the two units'); close(p2)
    open_item(p, 'Cost Alpha'); unit_cost(p, 0, '350')
    check([(q['kind'], q['cost']) for q in p.evaluate('queue')] == [('cost', 350)], 'saving the field queues one cost entry')
    check(units(p) == ['350', '400'] and 'Cost of stock on hand ₱750.' in p.inner_text('#sheet'), 'a changed cost shows on the item sheet at once')
    close(p); synced(p)
    alpha = [r for r in rows('Movements') if r[3] == 'Cost Alpha' and r[4] == 'In']
    check([r[9] for r in alpha] == [100, 200, 350, 400], f'the cost reached that unit’s row in Movements: {[r[9] for r in alpha]}')
    check([r[10] for r in rows('Browse') if r[1] == 'Cost Alpha'] == ['350, 400'], f"Browse lists the unit costs: {[r[10] for r in rows('Browse') if r[1] == 'Cost Alpha']}")
    p2.click('#syncBtn'); synced(p2)
    open_item(p2, 'Cost Alpha'); check(units(p2) == ['350', '400'], f'device 2 has the new cost after its next sync: {units(p2)}'); close(p2)

    # ---- a cost change on a unit that has left stock is refused; issued invoices keep their cost
    ctx2.set_offline(True)
    sell(p, 'cost alpha', 1000, 'Cy Cruz'); check('Margin ₱650' in issue(p), 'the third sale takes the ₱350 unit'); synced(p)
    open_item(p2, 'Cost Alpha'); unit_cost(p2, 0, '999'); close(p2)   # device 2 has not heard of the sale yet
    ctx2.set_offline(False); p2.click('#syncBtn'); p2.wait_for_function("document.querySelector('#syncTxt').textContent.includes('need attention')", timeout=8000)
    tab(p2, 'Home'); p2.click('#view .item:has-text("the sheet refused")'); p2.screenshot(path=f'{SHOTS}/04-refused.png')
    check('That unit has already left stock, so its cost can no longer be changed.' in p2.inner_text('#view'), 'the change is refused with the reason')
    p2.click('#view .banner.bad button:has-text("Delete")'); synced(p2)
    check([r[7] for r in rows('Invoice lines') if r[3] == 'Cost Alpha'] == [100, 200, 350] and [r[9] for r in rows('Movements') if r[3] == 'Cost Alpha' and r[4] == 'In'] == [100, 200, 350, 400], 'issued invoices and the unit’s row are unchanged')
    open_item(p2, 'Cost Alpha'); check(units(p2) == ['400'], f'device 2 now lists the one unit left: {units(p2)}'); close(p2)

    # ---- a sale of a unit with no cost: the form says so, and the margin stays unknown after the cost is typed later
    add_item(p, 'Cost Bravo', price=500, start=2)
    sell(p, 'cost bravo', 500, 'Di Cruz', qty=2)
    check('2 units of this item have no cost yet, so the margin on this sale will stay unknown.' in p.inner_text('#sellBody'), 'the form counts the units with no cost')
    p.fill('[data-b="inv.lines.0.qty"]', '1')
    check('1 unit of this item has no cost yet, so the margin on this sale will stay unknown.' in p.inner_text('#sellBody') and p.evaluate('document.activeElement.dataset.b') == 'inv.lines.0.qty', 'one unit: the line says so, and the quantity keeps focus')
    p.screenshot(path=f'{SHOTS}/05-no-cost-line.png')
    p.click('#sellBody button:has-text("Add the cost")'); check(p.inner_text('#sheet h2') == 'Cost Bravo' and len(units(p)) == 2, 'Add the cost opens the item sheet'); close(p)
    check('Margin unknown: an item has no cost' in issue(p), 'the invoice has an unknown margin')
    open_item(p, 'Cost Bravo'); unit_cost(p, 0, '300'); check(units(p) == ['300'], 'the cost of the unit left is typed'); close(p)
    tab(p, 'Sales'); p.click('#invList .item:has-text("Di Cruz")')
    check('Margin unknown: an item has no cost' in p.inner_text('#sheet'), 'the margin of the sale stays unknown'); close(p); synced(p)
    check([r[7] for r in rows('Invoice lines') if r[3] == 'Cost Bravo'] == [''], 'its invoice line has no cost in the sheet')

    # ---- a sale below zero, then a receipt: the first unit in covers the deficit
    add_item(p, 'Cost Charlie', price=800)
    sell(p, 'cost charlie', 800, 'Ed Cruz'); p.click('button:has-text("It is here, sell it now")')
    check('no cost yet' not in p.inner_text('#sellBody'), 'a sale below zero has no no-cost line')
    check('Margin unknown' in issue(p), 'a line that takes stock below zero has no cost')
    open_item(p, 'Cost Charlie'); check('Below zero by 1. Units that arrive next cover this first.' in p.inner_text('#sheet') and not units(p), 'the item sheet says what is owed to the next units'); close(p)
    stock_in(p, 'Cost Charlie', [700, 750]); synced(p)
    open_item(p, 'Cost Charlie'); check(units(p) == ['750'] and p.inner_text('#sheet .onhand') == '1', f'the ₱700 unit covered the deficit; one unit at ₱750 is on hand: {units(p)}'); close(p)
    check(stock_map(p)['Cost Charlie'] == 1 and [r[6] for r in rows('Items') if r[1] == 'Cost Charlie'] == [1] and [r[7] for r in rows('Invoice lines') if r[3] == 'Cost Charlie'] == [''], 'stock is 1 here and in the sheet; the sale line stays without a cost')

    # ---- a Restock return comes back at the invoice line's cost, at the back of the queue
    ctx.set_offline(True)
    tab(p, 'Sales'); p.click('#invList .item:has-text("Ana Cruz")'); p.click('button:has-text("Record a return")'); p.click('button:has-text("Record return")'); close(p)
    open_item(p, 'Cost Alpha')
    check(units(p) == ['400', '100'] and p.inner_text('#sheet .units .item:last-child .sub') == 'Return', f'before syncing, the returned unit is last at the line’s ₱100: {units(p)}'); close(p)
    ctx.set_offline(False); p.click('#syncBtn'); synced(p)
    ret = [r for r in rows('Movements') if r[6] == 'Return']; rid = rows('Returns')[0][0]
    check([r[0] for r in ret] == [f'ret-{rid}-1'] and ret[0][5] == 1 and ret[0][9] == 100, f'the sheet has one Return row for the unit at ₱100: {ret}')
    open_item(p, 'Cost Alpha'); check(units(p) == ['400', '100'], 'after syncing the unit keeps its cost'); close(p)

    # ---- reversing a receipt takes out that receipt's unit; reversing a sale brings its unit back at its cost
    add_item(p, 'Cost Delta', price=90); stock_in(p, 'Cost Delta', [10, 20, 30]); synced(p)
    mid = p.evaluate(f"live().all.find(m => m.sku === {json.dumps(sku_of(p, 'Cost Delta'))} && m.cost === 20).id")
    tab(p, 'Stock'); p.click('#view button[data-t="activity"]'); p.click(f'#actList [data-id="{mid}"]'); p.click('button:has-text("Reverse this movement")'); synced(p)
    open_item(p, 'Cost Delta'); check(units(p) == ['10', '30'], f'the reversed receipt’s unit is gone, the others stay: {units(p)}'); close(p)
    cor = [r for r in rows('Movements') if r[6] == 'Correction' and r[7] == mid]
    check(len(cor) == 1 and cor[0][4:6] == ['Out', 1], f'one Out Correction refers to the receipt: {cor}')
    sale = [r for r in rows('Movements') if r[3] == 'Cost Alpha' and r[6] == 'Sale' and r[7] == '2'][0]
    tab(p, 'Stock'); p.click('#view button[data-t="activity"]'); p.click(f'#actList [data-id="{sale[0]}"]'); p.click('button:has-text("Reverse this movement")'); synced(p)
    open_item(p, 'Cost Alpha'); check(units(p) == ['400', '100', '200'], f'a reversed sale brings its unit back at ₱200: {units(p)}'); close(p)

    # ---- Needs you asks for the cost of units with none, and opens Stock filtered to them
    add_item(p, 'Cost Echo', start=2); synced(p)
    h = home(p); titles = [e.inner_text() for e in p.query_selector_all('#view .sec:has-text("Needs you") .item .name')]
    check('Add the cost of 2 units' in titles and titles.index('Add the cost of 2 units') == titles.index('Price 1 item') + 1, f'Needs you: Add the cost of 2 units follows Price 1 item: {titles}')
    p.screenshot(path=f'{SHOTS}/06-needs-you.png')
    p.click('#view .item:has-text("Add the cost of 2 units")')
    check('Showing only: No cost yet' in p.inner_text('#view') and stock_names(p) == ['Cost Echo'], f'it opens Stock showing only items with a unit that has no cost: {stock_names(p)}')
    p.click('#stockList .item:has-text("Cost Echo")'); unit_cost(p, 0, '50')
    check('Cost of stock on hand ₱50. 1 unit has no cost yet.' in p.inner_text('#sheet'), 'the line under the list counts the unit with no cost'); close(p)
    check('Add the cost of 1 unit' in home(p), 'the row counts down as costs are typed')
    open_item(p, 'Cost Echo'); unit_cost(p, 1, '55'); close(p)
    check('Add the cost of' not in home(p), 'with every cost typed the row goes')
    synced(p)

    # ---- both devices end up with the same stock
    p2.click('#syncBtn'); synced(p2)
    check(stock_map(p2) == stock_map(p), f'device 2 stock matches: {stock_map(p2)}')
    open_item(p2, 'Cost Delta'); check(units(p2) == ['10', '30'], 'device 2 replays the same units'); close(p2)

    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
