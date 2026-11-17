# Release 2.6 in the app: each unit's condition beside its cost (stock in, the product sheet, a sale line that edits its units),
# a discount and a shipping fee on New sale, and the payment details that come from the sheet. Drives the app at phone size.
# python3 test/condition.py  (needs the static server on APP_PORT and the mock backend on API_PORT, Chrome)
import json, urllib.request
from playwright.sync_api import sync_playwright
from common import *

def post_pay(rs): urllib.request.urlopen(urllib.request.Request(API + '/_pay', data=json.dumps(rs).encode(), method='POST')).read()
def open_item(p, name): tab(p, 'Inventory'); p.click('#view .seg button[data-f="all"]'); p.click(f'#stockList .item:has-text("{name}")')
def conds(p): return [e.input_value() for e in p.query_selector_all('#sheet [data-ucond]')]
def moved(name): return [r for r in rows('Movements') if r[3] == name]

with sync_playwright() as pw:
    b = launch(pw)
    ctx = b.new_context(viewport={'width': 390, 'height': 844})
    p = page(ctx)
    p.goto(APP); connect(p); synced(p)

    # ---- Stock in: each unit has its condition beside its cost; the first unit's pick fills the units not picked yet
    tab(p, 'Inventory'); p.click('#view [data-act="newItem"]'); p.fill('#fName', 'Cond Alpha'); p.fill('#fPrice', '1000'); p.click('#sheet button.primary:has-text("Save")')
    open_item(p, 'Cond Alpha'); p.click('#sheet button:has-text("Stock in")'); p.fill('#mvQty', '3')
    labels = [e.inner_text() for e in p.query_selector_all('[data-costbox] label')]
    check(labels[:4] == ['Unit 1 cost', 'Unit 1 condition', 'Unit 2 cost', 'Unit 2 condition'] and [p.input_value(f'[data-cond="mv.c"][data-k="{k}"]') for k in range(3)] == ['MIB'] * 3, f'each unit has a condition beside its cost, MIB to start: {labels}')
    check(p.get_attribute('[data-cond="mv.c"][data-k="0"] option[value="MOC"]', 'title') == 'Mint on card: still on its blister card', 'each condition carries its meaning as a title')
    p.select_option('[data-cond="mv.c"][data-k="1"]', 'Loose'); p.select_option('[data-cond="mv.c"][data-k="0"]', 'MISB')
    check([p.input_value(f'[data-cond="mv.c"][data-k="{k}"]') for k in range(3)] == ['MISB', 'Loose', 'MISB'], 'the first unit’s pick fills the units not picked yet')
    for k, c in enumerate(('100', '200', '300')): p.fill(f'[data-cost="mv.c"][data-k="{k}"]', c)
    p.click('button:has-text("Record stock in")'); synced(p)
    check([(r[9], r[11]) for r in moved('Cond Alpha')] == [(100, 'MISB'), (200, 'Loose'), (300, 'MISB')], f"each unit’s In row has its cost and condition: {[(r[9], r[11]) for r in moved('Cond Alpha')]}")
    open_item(p, 'Cond Alpha')
    check(conds(p) == ['MISB', 'Loose', 'MISB'] and [e.input_value() for e in p.query_selector_all('#sheet [data-unit]')] == ['100', '200', '300'], f'the product sheet shows each unit’s condition beside its cost: {conds(p)}')

    # ---- a unit's condition changed on the product sheet reaches its Condition cell in Movements
    p.select_option('#sheet [data-ucond] >> nth=2', 'CIB')
    check([(q['kind'], q['cond']) for q in p.evaluate('queue')] == [('cond', 'CIB')] and conds(p) == ['MISB', 'Loose', 'CIB'], 'picking a condition queues one cond entry and shows at once')
    close(p); synced(p)
    check([r[11] for r in moved('Cond Alpha')] == ['MISB', 'Loose', 'CIB'], f"the condition reached the unit’s row: {[r[11] for r in moved('Cond Alpha')]}")

    # ---- New sale: the line shows the condition of the units it takes; a pick there edits those units
    new_sale(p); pick(p, 'inv.lines.0', 'cond alpha')
    check(p.input_value('#c0') == 'MISB', 'one unit: the line shows the oldest unit’s condition')
    p.fill('[data-b="inv.lines.0.qty"]', '2')
    check(p.eval_on_selector('#c0', 'e => e.selectedOptions[0].text') == 'Mixed' and p.evaluate('document.activeElement.dataset.b') == 'inv.lines.0.qty', 'two units in different conditions show Mixed; the quantity keeps focus')
    p.select_option('#c0', 'MIB')
    check('Condition saved on Cond Alpha' in p.inner_text('#toast') and p.input_value('#c0') == 'MIB', 'picking one saves it on the product')
    check([u['cond'] for u in p.evaluate("onHand(live().list.find(i => i.name === 'Cond Alpha').sku).units")] == ['MIB', 'MIB', 'CIB'], 'the two units the line takes are now MIB')

    # ---- a 10% discount fills the amount and follows the subtotal; a shipping fee is added after it
    p.fill('#iPct', '10'); check(p.input_value('#iDisc') == '200', f"10% of ₱2,000 fills Discount: {p.input_value('#iDisc')}")
    p.fill('#iFee', '150'); p.fill('[data-b="inv.lines.0.price"]', '1100')
    tot = p.inner_text('#invTot')
    check(p.input_value('#iDisc') == '220' and 'Subtotal\n₱2,200' in tot and 'Discount\n−₱220' in tot and 'Shipping fee\n₱150' in tot and p.inner_text('#invTotal') == '₱2,130', f'the % keeps the amount up to date; Total is ₱2,200 − ₱220 + ₱150: {tot!r}')
    p.fill('#iDisc', '3000'); p.fill('[data-b="inv.cust"]', 'Ana Cruz'); p.click('#view [data-act="invIssue"]')
    check('more than the subtotal' in p.inner_text('#toast') and p.input_value('#iPct') == '136.36', 'a discount above the subtotal is refused')
    p.fill('#iPct', '10'); p.click('#view [data-act="invIssue"]'); sheet = p.inner_text('#sheet')
    check('2 × ₱1,100 (listed ₱1,000) · MIB' in sheet and 'Discount\n−₱220' in sheet and 'Shipping fee\n₱150' in sheet and 'Total\n₱2,130' in sheet and 'Margin ₱1,680' in sheet, f'the invoice shows the line’s condition, the discount, the fee, the total, and the margin without the fee: {sheet!r}')
    close(p); synced(p)
    inv, ln = rows('Invoices')[0], rows('Invoice lines')[0]
    check(inv[6:9] == [2130, 2130, 0] and inv[10:12] == [220, 150], f'the Invoices row has Total, Discount and Shipping fee: {inv[:12]}')
    check(ln[13] == 'MIB' and [r[11] for r in moved('Cond Alpha') if r[6] == 'Sale'] == ['MIB'], f'the line and its Sale movement carry its condition: {ln[:14]}')

    # ---- payment details come from the sheet and show in Settings
    p.click('button[aria-label="Settings"]'); check('None yet. Add rows (Method, Number, Name)' in p.inner_text('#sheet'), 'with none in the sheet, Settings says where to add them'); close(p)
    post_pay([['GCash', '0917 123 4567', 'Ana Shop'], ['BPI', '1234 5678', 'Ana Shop']]); p.click('#syncBtn'); synced(p)
    p.click('button[aria-label="Settings"]'); pay = p.inner_text('#payList')
    check(pay == 'GCash\n0917 123 4567 · Ana Shop\nBPI\n1234 5678 · Ana Shop' and p.query_selector('#payList input') is None, f'Settings lists them, read only: {pay!r}'); close(p)

    no_toy(p, 'Home')
    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
