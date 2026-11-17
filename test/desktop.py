# Desktop layout check: side navigation, sheets as dialogs, the tables (Inventory, Sales, Orders, Activity, Update inventory) with
# their sort and the Stock filter row, and no page that scrolls sideways.
# python3 test/desktop.py  (needs static server on 8765, mock backend on 8766, Chrome)
import os, re
from playwright.sync_api import sync_playwright
from common import *
SHOTS = '/tmp/shots-desktop'
os.makedirs(SHOTS, exist_ok=True)
post_inbox([{'type': 'Count', 'name': 'Grandista Son Goku', 'qty': 3, 'brand': 'Banpresto', 'line': 'Grandista', 'chr': 'Son Goku', 'rel': '2019-06', 'verify': 'Y'},
            {'type': 'Count', 'name': 'Maximatic Monkey D. Luffy', 'qty': 0, 'brand': 'Banpresto', 'line': 'Maximatic', 'chr': 'Monkey D. Luffy'},
            {'type': 'Count', 'name': 'Gigo Roronoa Zoro', 'qty': 2, 'mfr': 'Sega', 'brand': 'Gigo', 'chr': 'Roronoa Zoro'}])
with sync_playwright() as pw:
    b = launch(pw)
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}); p = page(ctx)
    fits = lambda: p.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    heads = lambda t: [x.inner_text().strip() for x in p.query_selector_all(f'[data-tbl="{t}"] thead tr:first-child th')]
    p.goto(APP); p.click('button[aria-label="Settings"]')
    box = p.eval_on_selector('#sheet', 'e => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom, innerWidth, innerHeight]; }')
    check(box[1] - box[0] <= 560 and abs((box[0] + box[1]) / 2 - box[4] / 2) < 2 and box[3] < box[5] - 10, f'a sheet opens as a centred dialog: {box}')
    p.fill('#sCode', CODE); p.click('button:has-text("Test and save")'); synced(p)
    side = p.eval_on_selector('nav.tabs', 'e => { const r = e.getBoundingClientRect(); return [r.left, r.width, r.height, innerHeight]; }')
    check(side[0] == 0 and 200 < side[1] < 260 and side[2] == side[3], f'navigation is a full-height side bar: {side}')
    labels = [x.inner_text().strip() for x in p.query_selector_all('#tabs button')]
    check(labels == ['Home', 'Inventory', 'Sales', 'Orders', 'Update inventory · 3', 'Activity'] and p.inner_text('#tabs .brand') == 'Bodega', f"side bar: Home, Inventory, Sales, Orders, Update inventory with its count, Activity: {labels}")
    check(p.eval_on_selector('#tabs button.on', 'e => getComputedStyle(e).color') == p.evaluate("getComputedStyle(document.body).color"), 'the current page in the side bar is in the text colour')
    # Update inventory: each group of the review is a table; a row opens Correct this row, the tick box only ticks.
    tab(p, 'Update inventory')
    check(p.is_visible('[data-tbl="imp.check"]') and p.is_visible('[data-tbl="imp.ready"]') and heads('imp.ready') == ['', 'Name', 'Status', 'Count', 'Cost', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Note'], f"Update inventory shows each group as a table: {heads('imp.ready')}")
    p.click('[data-tbl="imp.check"] tbody tr:has-text("Grandista") td:nth-child(2)')
    check(p.inner_text('#sheet h2') == 'Correct this row', 'clicking a review row opens Correct this row'); p.click('#sheet button[aria-label="Close"]')
    p.click('[data-tbl="imp.check"] tbody tr:has-text("Grandista") input[type=checkbox]')
    check(p.is_hidden('#layer') and p.is_visible('button:has-text("Apply 2 changes")'), 'the tick box in a review row unticks it without opening the modal')
    p.click('[data-tbl="imp.check"] tbody tr:has-text("Grandista") input[type=checkbox]')
    apply(p, 'Apply 3 changes'); synced(p)
    check(p.inner_text('header.top h1') == 'Inventory' and fits(), 'header names the page; Inventory fits the window')
    for nm, pr in [('Grandista', '1800'), ('Maximatic', '1500')]:
        p.click(f'#stockList tbody tr:has-text("{nm}")'); p.click('button:has-text("Edit details")'); p.fill('#fPrice', pr); p.click('#sheet button.primary:has-text("Save")')
    p.screenshot(path=f'{SHOTS}/stock.png')
    # Sales: the New sale form across the page, its lines as table rows, the invoice list as a table under it.
    tab(p, 'Sales')
    check(p.is_visible('#sellBody button:has-text("Issue invoice")') and p.is_visible('#invList') and not p.is_visible('[data-act="sellNew"]') and p.inner_text('header.top h1') == 'Sales', 'Sales shows the New sale form and the invoice list together')
    tops = lambda sel: p.eval_on_selector_all(sel, 'els => els.map(e => Math.round(e.getBoundingClientRect().top))')
    t = tops('#iCust, #iContact, #iDate'); check(len(t) == 3 and len(set(t)) == 1, f'Customer, Phone or Messenger and Date sit in one row: {t}')
    check([x.inner_text().strip() for x in p.query_selector_all('#sellBody thead th')] == ['Product', '', 'Quantity', f'Price each (₱)', 'Amount', ''] and p.is_visible('#sellBody tbody tr [data-pk="inv.lines.0"]'), 'the sale lines are rows of a table')
    pick(p, 'inv.lines.0', 'goku'); p.fill('[data-b="inv.lines.0.qty"]', '2')
    check(p.inner_text('#amt0') == '₱3,600' and '3 in stock' in p.inner_text('#sellBody tbody tr:first-child'), f"a line shows its stock hint and its amount: {p.inner_text('#amt0')}")
    p.click('button:has-text("Add another product")'); check(p.is_visible('#sellBody tbody tr [data-pk="inv.lines.1"]'), 'Add another product adds a row'); p.click('#sellBody button:has-text("Remove") >> nth=1')
    p.fill('[data-b="inv.lines.0.qty"]', '1')
    form, btn = [p.eval_on_selector(sel, 'e => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; }') for sel in ['#sellBody', '#sellBody [data-act="invIssue"]']]
    check(abs(btn[1] - form[1]) < 2 and btn[0] > (form[0] + form[1]) / 2, f'the total and the issue button sit at the right under the lines: {btn} in {form}')
    p.fill('[data-b="inv.cust"]', 'Ben Cruz'); p.click('button:has-text("Issue invoice no. 1")'); p.screenshot(path=f'{SHOTS}/invoice-dialog.png'); p.click('button[aria-label="Close"]'); synced(p)
    check(heads('invs') == ['No', 'Date', 'Customer', 'Items', 'Total', 'Margin', 'Delivered'] and p.is_visible('button:has-text("Issue invoice no. 2")') and fits(), f"the new invoice appears in the invoice table under a fresh form: {heads('invs')}")
    inv = p.eval_on_selector('#invList', 'e => e.getBoundingClientRect().top') > p.eval_on_selector('#sellBody', 'e => e.getBoundingClientRect().bottom')
    row1 = [c.inner_text().strip() for c in p.query_selector_all('[data-tbl="invs"] tbody tr:first-child td')]
    check(inv and row1[0] == '1' and row1[2] == 'Ben Cruz' and row1[3] == 'Grandista Son Goku' and row1[4] == '₱1,800' and row1[6] == 'No', f'the invoice list is a table under the form: {row1}')
    p.click('[data-tbl="invs"] tbody tr:first-child'); check(p.inner_text('#sheet h2') == 'Invoice no. 1', 'clicking an invoice row opens the invoice'); p.click('#sheet button[aria-label="Close"]')
    p.screenshot(path=f'{SHOTS}/sell.png')
    # A pre-order that stays waiting, then one whose item arrives: ready rows list first.
    pick(p, 'inv.lines.0', 'zoro'); p.fill('[data-b="inv.lines.0.qty"]', '5'); p.fill('[data-b="inv.lines.0.price"]', '700'); p.fill('[data-b="inv.cust"]', 'Cy Lim'); p.fill('[data-b="inv.contact"]', 'cy.lim')
    t = tops('#iCust, #iContact, #iDate, #iPaid, #iNote'); check(len(t) == 5 and len(set(t)) == 1, f'in pre-order mode Paid now and Note join the top row: {t}')
    check(p.eval_on_selector('#invNotice', 'e => e.closest("td").colSpan') == 6, 'the pre-order notice spans the full width under its line')
    p.click('button:has-text("Save pre-order")'); p.click('button[aria-label="Close"]')
    pick(p, 'inv.lines.0', 'luffy'); p.fill('[data-b="inv.cust"]', 'Ana Reyes'); p.fill('[data-b="inv.contact"]', '+63 917 000 0000'); p.fill('[data-b="inv.paid"]', '500')
    check(p.is_visible('#invNotice'), 'an item not in stock turns the form into a pre-order')
    p.click('button:has-text("Save pre-order")'); p.click('button[aria-label="Close"]')
    tab(p, 'Orders')
    check(p.is_visible('button:has-text("New supplier order")') and 'To take a pre-order, start a New sale' in p.inner_text('#view') and not p.is_visible('button:has-text("New pre-order")') and fits(), 'Orders shows pre-orders and supplier orders together')
    p.click('button:has-text("New supplier order")'); pick(p, 'f', 'luffy'); p.fill('[data-b="f.qty"]', '4'); p.click('button:has-text("Save order")'); synced(p)
    check(heads('pres') == ['Date', 'Customer', 'Contact', 'Item', 'Qty', 'Price', 'Paid', 'Balance', 'Status'] and heads('ords') == ['Date', 'Item', 'Qty', 'Expected', 'Status'], f"Orders shows a pre-order table and a supplier order table: {heads('pres')} {heads('ords')}")
    v = p.inner_text('#view'); check('Ana Reyes' in v and 'Maximatic Monkey D. Luffy' in v and 'ON THE WAY' in v.upper(), 'both tables fill in')
    p.click('[data-tbl="ords"] tbody tr:has-text("Luffy")'); check(p.is_visible('#sheet button:has-text("Received · add to stock")'), 'clicking a supplier order row opens its sheet')
    p.click('#sheet button:has-text("Received · add to stock")'); synced(p)
    pres = [[c.inner_text().strip() for c in r.query_selector_all('td')] for r in p.query_selector_all('[data-tbl="pres"] tbody tr')]
    check([r[1] for r in pres] == ['Ana Reyes', 'Cy Lim'] and pres[0][8] == 'Ready to ship' and pres[1][8] == 'Waiting for stock' and pres[0][7] == '₱1,000', f'ready-to-ship pre-orders come first: {pres}')
    p.click('[data-tbl="pres"] tbody tr:has-text("Cy Lim")'); check(p.inner_text('#sheet h2') == 'Pre-order · Cy Lim', 'clicking a pre-order row opens it'); p.click('#sheet button[aria-label="Close"]')
    p.click('button:has-text("New supplier order")'); pick(p, 'f', 'zoro'); p.fill('[data-b="f.qty"]', '3'); p.click('button:has-text("Save order")'); synced(p)
    p.screenshot(path=f'{SHOTS}/orders.png')
    # More items for the stock table: blanks, a lower-case name, release dates of every precision, a unit cost range.
    post_inbox([{'type': 'Count', 'name': 'alpha Plush', 'qty': 2, 'cost': 300, 'mfr': 'Bandai', 'rel': '2024'},
                {'type': 'Count', 'name': 'Beta Figure', 'qty': 1, 'brand': 'banpresto', 'rel': '2024-07'},
                {'type': 'Count', 'name': 'Delta Bust', 'qty': 3, 'cost': 250, 'mfr': 'Bandai', 'chr': 'Son Goku', 'rel': '2024-07-15'},
                {'type': 'Count', 'name': 'Epsilon Statue', 'qty': 1, 'cost': 100, 'rel': '2023-12-31'}])
    p.click('#syncBtn'); p.wait_for_function("document.querySelector('#tabs').innerText.includes('Update inventory · 4')"); tab(p, 'Update inventory'); apply(p, 'Apply 4 changes'); synced(p)
    p.click('#stockList tbody tr:has-text("alpha Plush")'); p.click('button:has-text("Edit details")'); p.fill('#fCat', 'Plush'); p.click('#sheet button.primary:has-text("Save")')
    p.click('#stockList tbody tr:has-text("Delta Bust")'); p.click('#sheet button:has-text("Stock in")'); p.fill('[data-cost="mv.c"][data-k="0"]', '500'); p.click('button:has-text("Record stock in")'); synced(p)
    # Stock: a read-only table of every field; a header sorts and a second click reverses; a filter row under the header.
    tab(p, 'Inventory'); T = '[data-tbl="stock"]'; cols = heads('stock')
    cells = lambda k: p.eval_on_selector_all(f'{T} tbody tr', f'rs => rs.map(r => r.cells.length > 1 ? r.cells[{k}].innerText.trim() : "")')
    names = lambda: [x for x in cells(0) if x]
    th = lambda h: f'{T} thead tr:first-child th:nth-child({cols.index(h) + 1})'
    def sort(h, d):   # clicks the header until it sorts that way
        for _ in range(2):
            if p.get_attribute(th(h), 'aria-sort') != d: p.click(th(h) + ' button')
    check(cols == ['Name', 'SKU', 'Category', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Price', 'On hand', 'Incoming', 'Owed', 'Left to promise', 'Unit cost', 'Stock cost'], f'the stock table has the 15 columns in order: {cols}')
    check(p.get_attribute(th('Left to promise') + ' [title]', 'title').startswith('Left to promise is on hand, plus incoming supplier orders'), 'the Left to promise header carries the explanation as a hover hint')
    NUM = {'Price', 'On hand', 'Incoming', 'Owed', 'Left to promise', 'Unit cost', 'Stock cost'}
    key = lambda h, v: float(re.search(r'-?[\d,]+(\.\d+)?', v.replace('₱', '')).group().replace(',', '')) if h in NUM else re.match(r'\d{4}(-\d\d){0,2}', v).group() if h == 'Release date' else v.casefold()
    for h in cols:
        seen = []
        for d in ('ascending', 'descending'):
            p.click(th(h) + ' button'); vals = cells(cols.index(h)); blank = [v in ('', '–') for v in vals]; keys = [key(h, v) for v in vals if v not in ('', '–')]
            seen.append(p.get_attribute(th(h), 'aria-sort') == d and blank == sorted(blank) and keys == sorted(keys, reverse=d == 'descending') and len(set(keys)) > 1)
        check(all(seen), f'sorting by {h} works both ways with blanks last: {vals}')
    sort('Release date', 'ascending'); r = names()
    check(r[:5] == ['Grandista Son Goku', 'Epsilon Statue', 'alpha Plush', 'Beta Figure', 'Delta Bust'] and set(r[5:]) == {'Maximatic Monkey D. Luffy', 'Gigo Roronoa Zoro'}, f'release dates sort by time, a year or month before the days in it, blanks last: {r}')
    sort('Release date', 'descending'); r = names(); check(r[:5] == ['Delta Bust', 'Beta Figure', 'alpha Plush', 'Epsilon Statue', 'Grandista Son Goku'] and len(r) == 7, f'and the other way, still with blanks last: {r}')
    sort('Unit cost', 'ascending'); r = names(); uc = cells(cols.index('Unit cost'))
    check(r[:3] == ['Epsilon Statue', 'Delta Bust', 'alpha Plush'] and uc[:3] == ['₱100', '₱250 to 500', '₱300'] and uc[3:] == ['–'] * 4, f'Unit cost shows one value or a range, sorts by the lowest, and shows a dash with no cost: {r} {uc}')
    sc = cells(cols.index('Stock cost')); check(sc[:3] == ['₱100', '₱1,250', '₱600'], f'Stock cost is the sum of the costs of the units on hand: {sc}')
    tf = lambda k, v: p.fill(f'[data-tf="{k}"]', v) if k in ('from', 'to') else p.select_option(f'[data-tf="{k}"]', v)
    def shown(f, q):
        for k, v in f.items(): tf(k, v)
        p.fill('#q', q); out = set(names()) - {'Nothing matches.'}
        for k in f: tf(k, '')
        p.fill('#q', ''); return out
    opts = p.eval_on_selector('[data-tf="mfr"]', 'e => [...e.options].map(o => o.textContent)')
    check(opts == ['Any', 'Bandai', 'Sega'], f'a filter offers the values in use plus Any: {opts}')
    for f, q, want in [({'cat': 'Plush'}, '', {'alpha Plush'}), ({'cat': 'General'}, 'goku', {'Grandista Son Goku', 'Delta Bust'}), ({'cat': 'Plush'}, 'goku', set()), ({'mfr': 'Bandai'}, '', {'alpha Plush', 'Delta Bust'}), ({'mfr': 'Bandai'}, 'delta', {'Delta Bust'}),
                       ({'brand': 'Banpresto'}, 'luffy', {'Maximatic Monkey D. Luffy'}), ({'line': 'Grandista'}, 'zoro', set()), ({'chr': 'Son Goku'}, 'bust', {'Delta Bust'}),
                       ({'from': '2024', 'to': '2024-07'}, '', {'alpha Plush', 'Beta Figure', 'Delta Bust'}), ({'from': '2024-07-15'}, '', {'Delta Bust'}), ({'to': '2023'}, '', {'Grandista Son Goku', 'Epsilon Statue'}), ({'from': '2024'}, 'beta', {'Beta Figure'})]:
        got = shown(f, q); check(got == want, f'filter {f} with search "{q}" shows {sorted(want)}: {sorted(got)}')
    tf('cat', 'Plush'); p.fill('#q', 'goku')
    check(p.inner_text(f'{T} tbody') == 'Nothing matches.' and p.input_value('[data-tf="cat"]') == 'Plush', 'when nothing matches, the filter row stays so the filter can be undone'); tf('cat', ''); p.fill('#q', '')
    tab(p, 'Home'); p.click('#view [data-to="nocost"]'); a = set(names()); tf('brand', 'Banpresto'); b2 = set(names()); p.fill('#q', 'luffy'); c = set(names())
    check(a == {'Grandista Son Goku', 'Maximatic Monkey D. Luffy', 'Gigo Roronoa Zoro', 'Beta Figure'} and b2 == {'Grandista Son Goku', 'Maximatic Monkey D. Luffy'} and c == {'Maximatic Monkey D. Luffy'}, f'a Home shortcut, a column filter and the search combine: {a} {b2} {c}')
    tf('brand', ''); p.fill('#q', ''); p.click('#view button:has-text("Show all")')
    sort('Release date', 'descending'); tf('mfr', 'Bandai'); p.fill('[data-tf="from"]', '2023')
    p.evaluate(f"document.querySelector('{T}').dataset.old = '1'"); p.click('#syncBtn'); p.wait_for_function(f"!document.querySelector('{T}').dataset.old")
    check(names() == ['Delta Bust', 'alpha Plush'] and p.get_attribute(th('Release date'), 'aria-sort') == 'descending' and p.input_value('[data-tf="mfr"]') == 'Bandai' and p.input_value('[data-tf="from"]') == '2023', f'sort and filter survive the re-render after a sync: {names()}')
    tf('mfr', ''); tf('from', '')
    wide_box = p.eval_on_selector(T, 'e => e.scrollWidth > e.clientWidth')
    p.eval_on_selector(T, 'e => e.scrollLeft = e.scrollWidth'); p.click(th('Stock cost') + ' button')
    check(wide_box and fits() and p.eval_on_selector(T, 'e => e.scrollLeft') > 0, 'the table scrolls sideways in its own box, and keeps its place when sorted')
    p.set_viewport_size({'width': 1280, 'height': 450}); p.wait_for_timeout(200)
    top = p.eval_on_selector(T, 'e => { e.scrollTop = 150; return [e.scrollTop, e.getBoundingClientRect().top, e.querySelector("thead th").getBoundingClientRect().top]; }')
    check(top[0] > 0 and abs(top[2] - top[1] - 1) < 2, f'the header row stays in view while the table scrolls down: {top}')
    p.set_viewport_size({'width': 1280, 'height': 800}); p.wait_for_timeout(200)
    p.click(f'{T} tbody tr:has-text("Delta Bust")'); check(p.inner_text('#sheet h2') == 'Delta Bust' and len(p.query_selector_all('#sheet [data-unit]')) == 4, 'clicking a row opens the item sheet'); p.click('#sheet button[aria-label="Close"]')
    check(p.query_selector(f'{T} input:not([data-tf]), {T} tbody [contenteditable]') is None, 'no cell of the table can be edited')
    p.screenshot(path=f'{SHOTS}/stock-table.png')
    tab(p, 'Home')
    cols = p.eval_on_selector_all('.cols > div', 'els => els.map(e => Math.round(e.getBoundingClientRect().left))')
    check(len(cols) == 2 and cols[1] > cols[0] + 300 and 'Today' in p.inner_text('.cols > div:nth-child(1)') and 'New sale' in p.inner_text('.cols > div:nth-child(1)') and 'Needs you' in p.inner_text('.cols > div:nth-child(2)') and fits(), f'Home puts the numbers and buttons beside what needs doing: {cols}'); p.screenshot(path=f'{SHOTS}/home.png')
    check(p.inner_text('header.top h1') == 'Bodega', 'Home on desktop is headed by the app name')
    nrows = p.eval_on_selector_all('.cols > div:nth-child(2) .list > *', 'els => els.length'); badge = p.inner_text('.cols > div:nth-child(2)')
    check(nrows >= 3 and 'See ' not in badge and p.query_selector('[data-act="homeMore"]') is None and all(p.is_visible(f'.cols > div:nth-child(2) .list > *:nth-child({i + 1})') for i in range(nrows)), f'Home on a 1280px window shows all {nrows} Needs-you rows with no See more')
    no_toy(p, 'desktop Home')
    tab(p, 'Inventory'); no_toy(p, 'Inventory'); tab(p, 'Orders'); no_toy(p, 'Orders'); tab(p, 'Sales'); no_toy(p, 'Sales'); tab(p, 'Update inventory'); no_toy(p, 'Update inventory')
    tab(p, 'Activity'); no_toy(p, 'Activity'); check(p.inner_text('header.top h1') == 'Activity' and 'Sale' in p.inner_text('#actList') and fits(), 'Activity opens from the side bar')
    check(heads('moves') == ['Date', 'Item', 'Reason', 'In or Out', 'Qty', 'Cost', 'Ref', 'Note'], f"Activity is a table: {heads('moves')}")
    p.click('[data-tbl="moves"] tbody tr:has-text("Sale")'); check('Grandista Son Goku' in p.inner_text('#sheet h2') and p.is_visible('#sheet button:has-text("Reverse this movement")'), 'clicking a movement row opens the movement'); p.click('#sheet button[aria-label="Close"]')
    p.focus('[data-tbl="moves"] tbody tr:first-child'); p.keyboard.press('Enter'); check(p.is_visible('#sheet button[aria-label="Close"]'), 'Enter on a focused row opens it too'); p.click('#sheet button[aria-label="Close"]')
    p.screenshot(path=f'{SHOTS}/activity.png')
    for w in (1280, 900):
        p.set_viewport_size({'width': w, 'height': 800}); p.wait_for_timeout(200); bad = []
        for pg in ['Home', 'Inventory', 'Sales', 'Orders', 'Update inventory', 'Activity']:
            tab(p, pg); bad += [] if fits() else [pg]
        check(not bad, f'no page scrolls sideways at {w} px wide, only the tables in their own boxes: {bad}')
    p.set_viewport_size({'width': 390, 'height': 780}); p.wait_for_timeout(300)
    check(p.inner_text('header.top h1') == 'Activity' and [x.inner_text().strip() for x in p.query_selector_all('#tabs button')] == ['Home', 'Inventory', 'Sales', 'Orders'] and p.eval_on_selector('nav.tabs', 'e => e.getBoundingClientRect().top') > 600, 'narrowing the window returns to the phone layout with four tabs')
    tab(p, 'Sales'); check(p.is_visible('[data-act="sellNew"]'), 'on a phone Sales opens the invoice list with a New sale button')
    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
