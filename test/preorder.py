# Release 2.8: a pre-order line picks its condition and cost, kept on the supplier order line it waits for. New supplier order makes that line
# (with a supplier when one is typed), a line linked to an open order line edits it, the order sheet sets a supplier, Receive starts at the
# line's condition, and shipping carries it to the invoice line. Drives the app at phone size.
# python3 test/preorder.py  (needs the static server on APP_PORT and the mock backend on API_PORT, Chrome)
import datetime
from playwright.sync_api import sync_playwright
from common import *

TODAY = datetime.date.today()
EXP, EXP2 = (TODAY + datetime.timedelta(days=20)).isoformat(), (TODAY + datetime.timedelta(days=30)).isoformat()
def kinds(p): return [q['kind'] for q in p.evaluate('queue')]
def line_of(name): return next(r for r in rows('Supplier orders') if r[6] == name)
def day(p, iso): return p.evaluate(f'fmtDay("{iso}")')
def inv_sheet(p, no): tab(p, 'Sales'); p.click(f'#invList .item:has-text("No. {no}")'); return p.inner_text('#sheet')

with sync_playwright() as pw:
    b = launch(pw)
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); p = page(ctx)
    p.goto(APP); connect(p); synced(p)
    paste_import(p, 'count', 'Kai Figure\t1\t1500\t\t\t\t\t\t\t\t800\nRen Figure\t0\t1200\nSora Figure\t0\t900'); apply(p, 'Apply 3 changes'); synced(p)

    # ---- one sale: a line in stock, and two pre-orders on New supplier order, one with its picks and no supplier, one from a new supplier
    new_sale(p); pick(p, 'inv.lines.0', 'kai')
    p.click('button:has-text("Add another product")'); pick(p, 'inv.lines.1', 'ren'); p.fill('[data-b="inv.lines.1.qty"]', '2')
    check(p.eval_on_selector('#o1', 'e => [...e.options].map(o => o.text)') == ['New supplier order'] and p.input_value('#c1') == 'MIB' and p.input_value('#k1') == '' and p.is_visible('#e1') and p.is_visible('#s1'),
          'a pre-order with no open order line: New supplier order with its expected date and supplier, Condition MIB and Cost each blank')
    p.select_option('#c1', 'Loose'); p.fill('#k1', '-5'); p.fill('#e1', EXP)
    p.click('button:has-text("Add another product")'); pick(p, 'inv.lines.2', 'sora'); p.fill('#e2', EXP2); p.fill('#s2', 'Kanto Hobby')
    p.fill('[data-b="inv.cust"]', 'Ana Reyes'); p.fill('[data-b="inv.contact"]', '0917 000 0000'); no_toy(p, 'New sale with pre-order lines')
    p.click('#view [data-act="invIssue"]')
    check('Cost each for “Ren Figure” must be zero or more' in p.inner_text('#toast') and 'invoice' not in kinds(p), 'a negative cost each is refused before anything is queued')
    p.fill('#k1', '450'); p.click('#view [data-act="invIssue"]'); k = kinds(p)
    check(k[-4:] == ['order', 'supplier', 'order', 'invoice'], f'each new order line is queued before the invoice, a new supplier before its order: {k}')
    sheet = p.inner_text('#sheet')   # issuing opens the invoice
    check('1 × ₱1,500 · MIB' in sheet and '2 × ₱1,200 · Loose' in sheet and '1 × ₱900 · MIB' in sheet, f'the invoice shows each to-follow line in its order line’s condition: {sheet!r}')
    drawn = p.evaluate("""() => { const f = CanvasRenderingContext2D.prototype.fillText, out = []; CanvasRenderingContext2D.prototype.fillText = function (s, ...a) { out.push(String(s)); return f.call(this, s, ...a); };
      try { drawDoc(live().invs[0]); } finally { CanvasRenderingContext2D.prototype.fillText = f; } return out; }""")
    check(drawn.count('MIB') == 2 and drawn.count('Loose') == 1, f'so does the image’s Condition column: {drawn}')
    close(p); synced(p)
    ren, sora, ln = line_of('Ren Figure'), line_of('Sora Figure'), rows('Invoice lines')
    kanto = [r for r in rows('Suppliers') if r[1] == 'Kanto Hobby']
    check(ren[3:5] == ['', ''] and ren[7:10] == [2, 450, EXP] and ren[11] == 'Ordered' and ren[13] == 'Loose', f'the sheet has the new order line with no supplier, its cost each and condition: {ren}')
    check(len(kanto) == 1 and sora[3:5] == [kanto[0][0], 'Kanto Hobby'] and sora[8:10] == ['', EXP2] and sora[13] == 'MIB', f'the typed supplier is made and its order carries it: {sora}')
    check(ln[1][9:12] == ['To follow', EXP, ren[0]] and ln[1][13] == '' and ln[2][11] == sora[0], f'the to-follow lines link their order lines and store no condition: {ln[1:]}')

    # ---- a pre-order linked to that open line shows and edits its condition and cost each, for every pre-order waiting on it
    new_sale(p); pick(p, 'inv.lines.0', 'ren')
    check(p.input_value('#o0') == ren[0] and p.eval_on_selector('#o0', 'e => e.selectedOptions[0].text') == f'{day(p, EXP)} · No supplier yet' and p.input_value('#c0') == 'Loose' and p.input_value('#k0') == '450',
          'a pre-order linked to an open order line shows its condition and cost each')
    p.select_option('#c0', 'Box damage'); p.fill('#k0', '500'); p.press('#k0', 'Tab')
    ol = [q for q in p.evaluate('queue') if q['kind'] == 'orderLine']
    check('Saved on the supplier order' in p.inner_text('#toast') and [(q['lineId'], q.get('cond'), q.get('cost')) for q in ol] == [(ren[0], 'Box damage', 500)], f'each change is saved on the order line at once, merged into one entry: {ol}')
    p.click('#backBtn'); synced(p)
    check(line_of('Ren Figure')[8] == 500 and line_of('Ren Figure')[13] == 'Box damage' and '2 × ₱1,200 · Box damage' in inv_sheet(p, 1), 'the order line changes in the sheet, and so does the pre-order already waiting on it'); close(p)

    # ---- the order sheet: an order with no supplier gets one; its open line's cost each and condition are fields
    tab(p, 'Suppliers'); p.click('#view button[data-s="orders"]')
    check('No supplier yet' in p.inner_text('#view .item:has-text("Ren Figure")'), 'Orders says an order made by a pre-order has no supplier yet')
    p.click('#view .item:has-text("Ren Figure")')
    check(p.inner_text('#sheet h2') == 'Supplier order' and p.eval_on_selector('#ordSup', 'e => [...e.options].map(o => o.text)') == ['No supplier yet', 'Kanto Hobby'] and p.input_value('#sheet [data-olcost]') == '500' and p.input_value('#sheet [data-olcond]') == 'Box damage',
          'its order sheet has a Supplier dropdown and the line’s cost each and condition as fields')
    p.select_option('#ordSup', label='Kanto Hobby'); synced(p)
    check(p.inner_text('#sheet h2') == 'Order from Kanto Hobby' and line_of('Ren Figure')[3:5] == [kanto[0][0], 'Kanto Hobby'], f"picking a supplier sets it on the order: {line_of('Ren Figure')}")

    # ---- Receive starts each unit at the line's condition and cost each; shipping the pre-order carries the condition to its invoice line
    check([e.input_value() for e in p.query_selector_all('#sheet [data-cond="sub.c"]')] == ['Box damage'] * 2 and [e.input_value() for e in p.query_selector_all('#sheet [data-cost="sub.c"]')] == ['500'] * 2,
          'receiving starts each unit at the line’s condition and cost each')
    p.click('#sheet button:has-text("Received · add to stock")'); close(p); synced(p)
    check([(r[9], r[11]) for r in rows('Movements') if str(r[0]).startswith('rcv-' + ren[0])] == [(500, 'Box damage')] * 2, 'the units come in at the line’s cost and condition')
    inv_sheet(p, 1); p.click('#sheet [data-act="lineShip"]'); close(p); synced(p)
    ln = rows('Invoice lines')[1]; sale = [r for r in rows('Movements') if r[0] == ln[1] + '-2']
    check(ln[8:10] == [500, 'Delivered'] and ln[13] == 'Box damage' and len(sale) == 1 and sale[0][11] == 'Box damage', f'the shipped line and its Sale movement carry the condition: {ln}')
    check('2 × ₱1,200 · Box damage' in inv_sheet(p, 1) and not [q for q in p.evaluate('queue')], 'the invoice shows it, and the sheet took every entry'); close(p)

    tab(p, 'Suppliers'); p.click('#view button[data-s="orders"]'); no_toy(p, 'Suppliers > Orders')
    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
