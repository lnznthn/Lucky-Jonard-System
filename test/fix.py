# End-to-end test of Correct this row (spec item 5): every field a Count or Receive row carries, one cost field per unit
# the row adds, typed values overwriting the item on file while Claude's values only fill blanks, the cost on the row's line,
# and the Inbox row left as Claude wrote it. Drives the app at phone size against the mock backend.
# python3 test/fix.py  (needs the static server on APP_PORT and the mock backend on API_PORT, Chrome)
import json, os
from playwright.sync_api import sync_playwright
from common import *

SHOTS = '/tmp/shots-fix'
os.makedirs(SHOTS, exist_ok=True)
def review(p): p.click('#syncBtn'); synced(p); update_stock(p)
def idx(p, name): return p.evaluate(f"ui.imp.rows.findIndex(r => r.name === {json.dumps(name)})")
def line(p, name): return p.inner_text(f'.prow:has(#imp{idx(p, name)})')
def fix(p, name): p.click(f'#impOut [data-act="impFix"][data-i="{idx(p, name)}"]')
def labels(p): return [e.inner_text().strip() for e in p.query_selector_all('#sheet label')]
def costs(p): return [e.input_value() for e in p.query_selector_all('#sheet [data-cost="f.c"]')]
def cost(p, k, v): p.fill(f'#sheet [data-cost="f.c"][data-k="{k}"]', str(v))
def save(p): p.click('#sheet button:has-text("Save")')
def units(p, name):
    tab(p, 'Inventory'); p.click('#view .seg button[data-f="all"]'); p.click(f'#stockList .item:has-text("{name}")')
    out = [e.input_value() for e in p.query_selector_all('#sheet [data-unit]')]; close(p); return out
def moves(name, reason): return [r for r in rows('Movements') if r[3] == name and r[6] == reason]
def item(name): return next(r for r in rows('Items') if r[1] == name)
def inbox(): return [r[:12] for r in rows('Inbox')]   # every column Claude wrote, without Status
FIELDS = ['Category', 'Price (₱)', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Release date still needs checking', 'Note']

with sync_playwright() as pw:
    b = launch(pw)
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    p = page(ctx)
    p.goto(APP); connect(p); synced(p)

    # ---- new items: Cost each prefills the fields, a row without a cost says so, typed costs and price are recorded
    post_inbox([{'type': 'Count', 'name': 'Fix Alpha', 'qty': 2, 'cost': 100, 'brand': 'Old Brand', 'line': 'Line A'},
                {'type': 'Count', 'name': 'Fix Bravo', 'qty': 3}])
    review(p); before = inbox()
    check('opening stock 2 at ₱100 each' in line(p, 'Fix Alpha') and 'opening stock 3 · no cost yet' in line(p, 'Fix Bravo'), f"each row shows its cost next to the quantity, or no cost yet: {line(p, 'Fix Alpha')!r} {line(p, 'Fix Bravo')!r}")
    fix(p, 'Fix Alpha')
    check(labels(p) == ['Name', 'Count', 'Unit 1 cost', 'Unit 2 cost'] + FIELDS, f'a Count row shows every field it can carry, one cost field per unit: {labels(p)}')
    check(costs(p) == ['100', '100'], f'the cost fields start with the row’s Cost each: {costs(p)}')
    p.screenshot(path=f'{SHOTS}/01-count-new.png', full_page=True)
    cost(p, 1, 150); p.fill('#fxPrice', '500'); save(p)
    check(inbox() == before, 'saving the correction leaves the Inbox row in the sheet as Claude wrote it')
    check('opening stock 2 at ₱100 to 150 each' in line(p, 'Fix Alpha') and 'Corrected here' in line(p, 'Fix Alpha'), f"the row shows the typed costs as a range: {line(p, 'Fix Alpha')!r}")
    fix(p, 'Fix Bravo'); check(costs(p) == ['', '', ''], 'a row without a cost has blank fields')
    cost(p, 0, 10); check(costs(p) == ['10'] * 3, 'typing in the first field fills the others')
    cost(p, 1, 20); cost(p, 2, 30); save(p)
    apply(p, 'Apply 2 changes'); synced(p)
    check([r[9] for r in moves('Fix Alpha', 'Opening')] == [100, 150] and [r[9] for r in moves('Fix Bravo', 'Opening')] == [10, 20, 30], 'the opening units carry the costs typed in the modal')
    check(item('Fix Alpha')[3] == 500 and item('Fix Alpha')[8:10] == ['Old Brand', 'Line A'], f"the new item has the typed price and Claude's details: {item('Fix Alpha')}")

    # ---- items on file: a count that raises stock adds units at the typed costs; one that lowers it has no cost fields
    post_inbox([{'type': 'Count', 'name': 'Fix Alpha', 'qty': 5, 'cost': 300, 'mfr': 'Maker', 'brand': 'New Brand', 'line': 'Line B', 'rel': '2022', 'verify': 'Y'},
                {'type': 'Count', 'name': 'Fix Bravo', 'qty': 1},
                {'type': 'Count', 'name': 'Fix Alpha Big', 'qty': 4}])
    review(p); before = inbox()
    fix(p, 'Fix Alpha')
    check(p.input_value('#fxCount') == '5' and costs(p) == ['300'] * 3 and p.is_checked('#fxRelCheck'), f'counted 5 with 2 on hand: three cost fields at Cost each: {costs(p)}')
    p.fill('#fxCount', '6'); n6 = len(costs(p)); p.fill('#fxCount', '5')
    check(n6 == 4 and len(costs(p)) == 3, 'the fields follow the count, less the stock on hand')
    cost(p, 0, 310); cost(p, 2, 330); check(costs(p) == ['310', '310', '330'], f'typed costs: {costs(p)}')
    p.fill('#fxLine', 'Line Typed'); p.fill('#fxPrice', '650'); p.uncheck('#fxRelCheck')
    p.screenshot(path=f'{SHOTS}/02-count-on-file.png', full_page=True); save(p)
    txt = line(p, 'Fix Alpha')
    check('stock 2 → counted 5 (+3) at ₱310 to 330 each' in txt and 'adds price, manufacturer, product line, release date' in txt, f'the row shows the units it adds at their costs and what it changes: {txt!r}')
    fix(p, 'Fix Bravo')
    check(p.input_value('#fxCount') == '1' and costs(p) == [] and 'Unit 1 cost' not in labels(p), f'a count that lowers stock shows no cost fields: {labels(p)}')
    close(p)
    txt = line(p, 'Fix Bravo'); check('stock 3 → counted 1 (−2)' in txt and ' at ' not in txt and 'no cost yet' not in txt, f'its row shows no cost: {txt!r}')
    fix(p, 'Fix Alpha Big'); n_new = len(costs(p)); p.check('#fxUse'); n_use = len(costs(p)); p.uncheck('#fxUse')
    check(n_new == 4 and n_use == 2 and len(costs(p)) == 4, f'Use the existing item counts only the units above its stock: {n_new} {n_use}')
    close(p)
    check(inbox() == before, 'the Inbox rows are still as Claude wrote them')
    apply(p, 'Apply 2 changes'); synced(p)
    cnt = moves('Fix Alpha', 'Count')
    check([r[4:6] for r in cnt] == [['In', 1]] * 3 and [r[9] for r in cnt] == [310, 310, 330], f'one In row per unit added, at the typed costs: {[(r[4], r[5], r[9]) for r in cnt]}')
    check([r[4:6] for r in moves('Fix Bravo', 'Count')] == [['Out', 2]], 'the lower count is one Out row of 2')
    a = item('Fix Alpha')
    check(a[3] == 650 and a[9] == 'Line Typed', f'typed values overwrite the item on file: {a}')
    check(a[8] == 'Old Brand' and a[7] == 'Maker' and a[11] == '2022' and a[12] == '', f"Claude's values only fill blanks, and the unticked check is kept: {a}")
    check(units(p, 'Fix Alpha') == ['100', '150', '310', '310', '330'], 'the added units join the back of the queue')
    check(units(p, 'Fix Bravo') == ['30'], 'the lower count removed the two oldest units')
    check(inbox() == before and [r[12] for r in rows('Inbox')][2:] == ['Done', 'Done', ''], 'after Apply the Inbox rows keep what Claude wrote; only the recorded ones are Done')
    update_stock(p); p.click('#view button[data-act="inboxDismiss"]'); synced(p)

    # ---- a Receive row: Qty in place of Count; a typed price and category make the new item
    post_inbox([{'type': 'Receive', 'name': 'Fix Alpha', 'qty': 2, 'cost': 400}, {'type': 'Receive', 'name': 'Fix Delta', 'qty': 1}])
    review(p)
    check('Fix Alpha: +2 at ₱400 each' in line(p, 'Fix Alpha') and 'New · General · +1 · no cost yet' in line(p, 'Fix Delta'), f"receive rows show their cost: {line(p, 'Fix Delta')!r}")
    fix(p, 'Fix Alpha')
    check(labels(p) == ['Name', 'Qty', 'Unit 1 cost', 'Unit 2 cost'] + FIELDS and costs(p) == ['400', '400'], f'a Receive row shows Qty in place of Count: {labels(p)}')
    p.screenshot(path=f'{SHOTS}/03-receive.png', full_page=True); close(p)
    fix(p, 'Fix Delta'); p.fill('#fxCat', 'Figures'); p.fill('#fxPrice', 'abc'); save(p)
    check('Price must be zero or more.' in p.inner_text('#toast'), 'a price that is not a number is refused')
    p.fill('#fxPrice', '900'); cost(p, 0, 50); save(p)
    check('New · Figures · +1 at ₱50 each' in line(p, 'Fix Delta'), f"the typed category and cost show on the row: {line(p, 'Fix Delta')!r}")
    apply(p, 'Apply 2 changes'); synced(p)
    d = item('Fix Delta')
    check(d[2:4] == ['Figures', 900] and [r[9] for r in moves('Fix Delta', 'Restock')] == [50] and [r[9] for r in moves('Fix Alpha', 'Restock')] == [400, 400], f'the receipt records the typed price, category and costs: {d}')

    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
