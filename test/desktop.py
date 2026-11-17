# Desktop layout check: side navigation, sheets as dialogs, the tables (Inventory, Sales, Orders, Activity, Add inventory) with
# their sort and filters in the header cells, the cost typed in a review row, and no page that scrolls sideways.
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
    check(labels == ['Home', 'Inventory · 3', 'Sales', 'Orders', 'Activity'] and p.inner_text('#tabs .brand') == 'Bodega', f"side bar: Home, Inventory with the waiting count, Sales, Orders, Activity: {labels}")
    check(p.eval_on_selector('#tabs button.on', 'e => getComputedStyle(e).color') == p.evaluate("getComputedStyle(document.body).color"), 'the current page in the side bar is in the text colour')
    # Side bar collapses to icons (kept on the device); the phone layout is untouched.
    full = p.eval_on_selector('nav.tabs', 'e => e.getBoundingClientRect().width')
    p.click('#navTog'); mini = p.eval_on_selector('nav.tabs', 'e => e.getBoundingClientRect().width'); main_l = p.eval_on_selector('.app', 'e => e.getBoundingClientRect().left')
    check(mini < 80 and main_l == mini and p.inner_text('#tabs .on').strip() == '' and p.get_attribute('#tabs button[data-t="stock"]', 'title') == 'Inventory' and p.get_attribute('#tabs button[data-t="stock"]', 'aria-label') == 'Inventory · 3' and p.inner_text('#tabs .bd') == '3' and fits(), f'the toggle collapses the side bar to icons with tooltips and a count badge: {full} -> {mini}')
    p.reload(); p.wait_for_selector('#tabs button')
    check(p.eval_on_selector('nav.tabs', 'e => e.getBoundingClientRect().width') == mini, 'the collapsed side bar survives a reload')
    p.click('#navTog'); check(p.eval_on_selector('nav.tabs', 'e => e.getBoundingClientRect().width') == full and 'Inventory · 3' in p.inner_text('#tabs'), 'the toggle expands the side bar again')
    p.click('#navTog'); p.set_viewport_size({'width': 390, 'height': 780}); p.wait_for_timeout(300)
    check(p.is_hidden('#navTog') and p.eval_on_selector('.app', 'e => e.getBoundingClientRect().left') == 0 and p.inner_text('#tabs').split() == ['Home', 'Inventory', 'Sales', 'Orders'], 'a collapsed side bar leaves the phone layout unchanged')
    p.set_viewport_size({'width': 1280, 'height': 800}); p.click('#navTog'); p.wait_for_timeout(200)
    # Add inventory, the last status tab of Inventory: each group of the review is a table; a row opens Correct this row, the tick box only ticks.
    tab(p, 'Inventory'); p.click('#view [data-f="add"]:has-text("Add inventory · 3")')   # no products yet: the button under "No products yet"
    check(p.inner_text('#view .seg button.on') == 'Add inventory · 3' and not p.is_visible('#q') and 'on' in p.get_attribute('#tabs button[data-t="stock"]', 'class') and p.is_visible('[data-tbl="imp.check"]') and p.is_visible('[data-tbl="imp.ready"]') and heads('imp.ready') == ['', 'Name', 'Status', 'Count', 'Cost', 'Price', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Note'], f"Add inventory shows each group as a table, with no search box: {heads('imp.ready')}")
    p.click('#impOut details[data-grp="check"] summary'); folded = p.is_hidden('[data-tbl="imp.check"]'); p.click('#impOut details[data-grp="check"] summary')
    check(folded and p.is_visible('[data-tbl="imp.check"]'), 'Check these folds like Needs a name')
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
    check([x.inner_text().strip() for x in p.query_selector_all('#sellBody thead th')] == ['Product', '', 'Quantity', f'Price each (₱)', 'Cost each', 'Amount', ''] and p.is_visible('#sellBody tbody tr [data-pk="inv.lines.0"]'), 'the sale lines are rows of a table')
    pick(p, 'inv.lines.0', 'goku'); p.fill('[data-b="inv.lines.0.qty"]', '2')
    check(p.inner_text('#amt0') == '₱3,600' and '3 in stock' in p.inner_text('#sellBody tbody tr:first-child'), f"a line shows its stock hint and its amount: {p.inner_text('#amt0')}")
    p.click('button:has-text("Add another product")'); check(p.is_visible('#sellBody tbody tr [data-pk="inv.lines.1"]'), 'Add another product adds a row'); p.click('#sellBody button:has-text("Remove") >> nth=1')
    p.fill('[data-b="inv.lines.0.qty"]', '1')
    form, btn = [p.eval_on_selector(sel, 'e => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; }') for sel in ['#sellBody', '#sellBody [data-act="invIssue"]']]
    check(abs(btn[1] - form[1]) < 2 and btn[0] > (form[0] + form[1]) / 2, f'the total and the issue button sit at the right under the lines: {btn} in {form}')
    p.fill('[data-b="inv.cust"]', 'Ben Cruz'); p.click('button:has-text("Issue invoice no. 1")'); p.screenshot(path=f'{SHOTS}/invoice-dialog.png'); p.click('button[aria-label="Close"]'); synced(p)
    check(heads('invs') == ['No', 'Date', 'Customer', 'Products', 'Total', 'Margin', 'Delivered'] and p.is_visible('button:has-text("Issue invoice no. 2")') and fits(), f"the new invoice appears in the invoice table under a fresh form: {heads('invs')}")
    inv = p.eval_on_selector('#invList', 'e => e.getBoundingClientRect().top') > p.eval_on_selector('#sellBody', 'e => e.getBoundingClientRect().bottom')
    row1 = [c.inner_text().strip() for c in p.query_selector_all('[data-tbl="invs"] tbody tr:first-child td')]
    check(inv and row1[0] == '1' and row1[2] == 'Ben Cruz' and row1[3] == 'Grandista Son Goku' and row1[4] == '₱1,800' and row1[6] == 'No', f'the invoice list is a table under the form: {row1}')
    p.click('[data-tbl="invs"] tbody tr:first-child'); check(p.inner_text('#sheet h2') == 'Invoice no. 1', 'clicking an invoice row opens the invoice'); p.click('#sheet button[aria-label="Close"]')
    p.screenshot(path=f'{SHOTS}/sell.png')
    # A pre-order that stays waiting, then one whose item arrives: ready rows list first.
    pick(p, 'inv.lines.0', 'zoro'); p.fill('[data-b="inv.lines.0.qty"]', '5'); p.fill('[data-b="inv.lines.0.price"]', '700'); p.fill('[data-b="inv.cust"]', 'Cy Lim'); p.fill('[data-b="inv.contact"]', 'cy.lim')
    t = tops('#iCust, #iContact, #iDate, #iPaid, #iNote'); check(len(t) == 5 and len(set(t)) == 1, f'in pre-order mode Paid now and Note join the top row: {t}')
    check(p.eval_on_selector('#invNotice', 'e => e.closest("td").colSpan') == 7, 'the pre-order notice spans the full width under its line')
    p.click('button:has-text("Save pre-order")'); p.click('button[aria-label="Close"]')
    pick(p, 'inv.lines.0', 'luffy'); p.fill('[data-b="inv.cust"]', 'Ana Reyes'); p.fill('[data-b="inv.contact"]', '+63 917 000 0000'); p.fill('[data-b="inv.paid"]', '500')
    check(p.is_visible('#invNotice'), 'an item not in stock turns the form into a pre-order')
    p.click('button:has-text("Save pre-order")'); p.click('button[aria-label="Close"]')
    tab(p, 'Orders')
    check(p.is_visible('button:has-text("New supplier order")') and 'To take a pre-order, start a New sale' in p.inner_text('#view') and not p.is_visible('button:has-text("New pre-order")') and fits(), 'Orders shows pre-orders and supplier orders together')
    p.click('button:has-text("New supplier order")'); pick(p, 'f', 'luffy'); p.fill('[data-b="f.qty"]', '4'); p.click('button:has-text("Save order")'); synced(p)
    check(heads('pres') == ['Date', 'Customer', 'Contact', 'Product', 'Qty', 'Price', 'Paid', 'Balance', 'Status'] and heads('ords') == ['Date', 'Product', 'Qty', 'Expected', 'Status'], f"Orders shows a pre-order table and a supplier order table: {heads('pres')} {heads('ords')}")
    v = p.inner_text('#view'); check('Ana Reyes' in v and 'Maximatic Monkey D. Luffy' in v and 'ON THE WAY' in v.upper(), 'both tables fill in')
    p.click('[data-tbl="ords"] tbody tr:has-text("Luffy")'); check(p.is_visible('#sheet button:has-text("Received · add to stock")'), 'clicking a supplier order row opens its sheet')
    p.click('#sheet button:has-text("Received · add to stock")'); synced(p)
    pres = [[c.inner_text().strip() for c in r.query_selector_all('td')] for r in p.query_selector_all('[data-tbl="pres"] tbody tr')]
    check([r[1] for r in pres] == ['Ana Reyes', 'Cy Lim'] and pres[0][8] == 'Ready to ship' and pres[1][8] == 'Waiting for stock' and pres[0][7] == '₱1,000', f'ready-to-ship pre-orders come first: {pres}')
    p.click('[data-tbl="pres"] tbody tr:has-text("Cy Lim")'); check(p.inner_text('#sheet h2') == 'Pre-order · Cy Lim', 'clicking a pre-order row opens it'); p.click('#sheet button[aria-label="Close"]')
    p.click('button:has-text("New supplier order")'); pick(p, 'f', 'zoro'); p.fill('[data-b="f.qty"]', '3'); p.click('button:has-text("Save order")'); synced(p)
    p.screenshot(path=f'{SHOTS}/orders.png')
    # More items for the stock table: blanks, a lower-case name, release dates of every precision, a unit cost range.
    post_inbox([{'type': 'Count', 'name': 'alpha Plush', 'qty': 2, 'mfr': 'Bandai', 'rel': '2024'},
                {'type': 'Count', 'name': 'Beta Figure', 'qty': 1, 'brand': 'banpresto', 'rel': '2024-07'},
                {'type': 'Count', 'name': 'Delta Bust', 'qty': 3, 'cost': 250, 'mfr': 'Bandai', 'chr': 'Son Goku', 'rel': '2024-07-15'},
                {'type': 'Count', 'name': 'Epsilon Statue', 'qty': 1, 'cost': 100, 'rel': '2023-12-31'}])
    p.click('#syncBtn'); p.wait_for_function("document.querySelector('#tabs').innerText.includes('Inventory · 4')"); add_inventory(p)
    # The cost each of a review row is typed in place for every unit it adds; units with different costs show the range, which opens Correct this row.
    A = '[data-tbl="imp.ready"] tbody tr:has-text("alpha Plush")'
    p.click(f'{A} input[data-rcost]'); check(p.is_hidden('#layer'), 'a click in the cost field of a review row does not open the row')
    p.fill(f'{A} input[data-rcost]', '300'); p.press(f'{A} input[data-rcost]', 'Tab')
    p.fill(f'{A} input[data-rprice]', '650'); p.press(f'{A} input[data-rprice]', 'Tab')
    p.click(f'{A} td:nth-child(2)'); costs = [p.input_value(f'#sheet [data-cost="f.c"][data-k="{k}"]') for k in (0, 1)]
    p.fill('#sheet [data-cost="f.c"][data-k="1"]', '400'); p.click('#sheet button:has-text("Save")'); rng = p.inner_text(f'{A} td:nth-child(5)'); p.click(f'{A} td:nth-child(5) button')
    check(costs == ['300', '300'] and rng == '₱300 to 400' and p.inner_text('#sheet h2') == 'Correct this row', f'the cost typed in a review row goes to every unit; different costs show the range, which opens Correct this row: {costs} {rng}')
    p.fill('#sheet [data-cost="f.c"][data-k="1"]', '300'); p.click('#sheet button:has-text("Save")'); apply(p, 'Apply 4 changes'); synced(p)
    check(any(r[1].lower() == 'alpha plush' and str(r[2]) == '650' for r in rows('Products')), 'a price typed in a review row reaches the product')
    p.click('#stockList tbody tr:has-text("Delta Bust")'); p.click('#sheet button:has-text("Stock in")'); p.fill('[data-cost="mv.c"][data-k="0"]', '500'); p.click('button:has-text("Record stock in")'); synced(p)
    # Inventory: a read-only table of every field; a header sorts and a second click reverses; filters open from the headers.
    tab(p, 'Inventory'); T = '[data-tbl="stock"]'; cols = heads('stock')
    cells = lambda k: p.eval_on_selector_all(f'{T} tbody tr', f'rs => rs.map(r => r.cells.length > 1 ? r.cells[{k}].innerText.trim() : "")')
    names = lambda: [x for x in cells(0) if x]
    th = lambda h: f'{T} thead tr:first-child th:nth-child({cols.index(h) + 1})'
    def sort(h, d):   # clicks the header until it sorts that way
        for _ in range(2):
            if p.get_attribute(th(h), 'aria-sort') != d: p.click(th(h) + ' button')
    check(cols == ['Name', 'Manufacturer', 'Brand', 'Product line', 'Character', 'Release date', 'Price', 'On hand', 'Incoming', 'Owed', 'Left to promise', 'Unit cost', 'Stock cost'], f'the inventory table has the 13 columns in order: {cols}')
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
    # Filters: tick boxes for the values in use plus Blank (All and None; nothing ticked is no filter), a from and to for Release date.
    on = lambda k: 'on' in p.get_attribute(f'{T} [data-k="{k}"]', 'class')
    def filt(k, *vals):   # ticks exactly vals in column k's filter (from and to for 'rel'); the filter stays open
        if p.is_hidden('#pop') or p.get_attribute('#pop', 'data-k') != k: p.click(f'{T} [data-act="tfOpen"][data-k="{k}"]')
        if k == 'rel': p.fill('#tfFrom', (vals + ('', ''))[0]); p.fill('#tfTo', (vals + ('', ''))[1]); return
        p.click('#pop button:has-text("None")')
        for v in vals: p.check(f'#pop input[value="{v}"]')
    def shown(f, q):
        for k, v in f.items(): filt(k, *v)
        p.fill('#q', q); out = set(names()) - {'Nothing matches.'}
        for k in f: filt(k)
        p.fill('#q', ''); return out
    filt('mfr'); opts = p.eval_on_selector_all('#pop label', 'ls => ls.map(l => l.innerText.trim())')
    check(opts == ['Bandai', 'Sega', 'Blank'], f'a filter lists the values in use, then Blank: {opts}')
    for f, q, want in [({'mfr': ['Bandai']}, '', {'alpha Plush', 'Delta Bust'}), ({'mfr': ['Bandai', 'Sega']}, 'a', {'alpha Plush', 'Delta Bust', 'Gigo Roronoa Zoro'}), ({'mfr': ['']}, '', {'Grandista Son Goku', 'Maximatic Monkey D. Luffy', 'Beta Figure', 'Epsilon Statue'}),
                       ({'brand': ['Banpresto']}, 'luffy', {'Maximatic Monkey D. Luffy'}), ({'line': ['Grandista']}, 'zoro', set()), ({'chr': ['Son Goku', 'Roronoa Zoro']}, '', {'Grandista Son Goku', 'Delta Bust', 'Gigo Roronoa Zoro'}),
                       ({'rel': ['2024', '2024-07']}, '', {'alpha Plush', 'Beta Figure', 'Delta Bust'}), ({'rel': ['2024-07-15']}, '', {'Delta Bust'}), ({'rel': ['', '2023']}, '', {'Grandista Son Goku', 'Epsilon Statue'}), ({'mfr': ['Bandai'], 'rel': ['2024-07']}, '', {'Delta Bust'})]:
        got = shown(f, q); check(got == want, f'filter {f} with search "{q}" shows {sorted(want)}: {sorted(got)}')
    filt('mfr', 'Sega'); p.click('#pop button:has-text("All")'); every = len(names()) == 7 and p.eval_on_selector_all('#pop input', 'xs => xs.every(x => x.checked)') and on('mfr')
    p.click('#pop button:has-text("None")'); check(every and len(names()) == 7 and not on('mfr'), 'All ticks every value, Blank included; None clears the filter')
    p.evaluate(f"document.querySelector('{T} thead').dataset.keep = document.querySelector('#q').dataset.keep = '1'"); widths = lambda: p.eval_on_selector_all(f'{T} thead th', 'ths => ths.map(t => t.offsetWidth)'); w0 = widths()
    filt('mfr', 'Sega'); p.check('#pop input[value="Bandai"]'); open_ = p.is_visible('#pop') and on('mfr'); p.keyboard.press('Escape'); sort('Name', 'descending')
    kept = p.evaluate(f"document.querySelector('{T} thead').dataset.keep === '1' && document.querySelector('#q').dataset.keep === '1'")
    check(open_ and names() == ['Gigo Roronoa Zoro', 'Delta Bust', 'alpha Plush'] and kept and widths() == w0 and p.is_hidden('#pop'), f'the filter stays open while ticking; a filter or a sort redraws only the rows, and no column changes width: {names()}')
    p.fill('#q', 'zzz'); check(p.inner_text(f'{T} tbody') == 'Nothing matches.' and on('mfr'), 'when nothing matches, the header keeps its filter so it can be undone'); p.fill('#q', ''); filt('mfr')
    tab(p, 'Home'); p.click('#view [data-to="nocost"]'); a = set(names()); filt('brand', 'Banpresto'); b2 = set(names()); p.fill('#q', 'luffy'); c = set(names())
    check(a == {'Grandista Son Goku', 'Maximatic Monkey D. Luffy', 'Gigo Roronoa Zoro', 'Beta Figure'} and b2 == {'Grandista Son Goku', 'Maximatic Monkey D. Luffy'} and c == {'Maximatic Monkey D. Luffy'}, f'a Home shortcut, a column filter and the search combine: {a} {b2} {c}')
    filt('brand'); p.fill('#q', ''); p.click('#view button:has-text("Show all")')
    sort('Release date', 'descending'); filt('mfr', 'Bandai'); filt('rel', '2023')
    p.evaluate(f"document.querySelector('{T}').dataset.old = '1'"); p.click('#syncBtn'); p.wait_for_function(f"!document.querySelector('{T}').dataset.old")
    check(names() == ['Delta Bust', 'alpha Plush'] and p.get_attribute(th('Release date'), 'aria-sort') == 'descending' and on('mfr') and on('rel'), f'sort and filters survive the re-render after a sync: {names()}')
    filt('mfr'); filt('rel'); p.keyboard.press('Escape')
    wide_box = p.eval_on_selector(T, 'e => e.scrollWidth > e.clientWidth')
    p.eval_on_selector(T, 'e => e.scrollLeft = e.scrollWidth'); p.click(th('Stock cost') + ' button')
    check(wide_box and fits() and p.eval_on_selector(T, 'e => e.scrollLeft') > 0, 'the table scrolls sideways in its own box, and keeps its place when sorted')
    p.set_viewport_size({'width': 1280, 'height': 340}); p.wait_for_timeout(200)
    top = p.eval_on_selector(T, 'e => { e.scrollTop = 150; return [e.scrollTop, e.getBoundingClientRect().top, e.querySelector("thead th").getBoundingClientRect().top]; }')
    check(top[0] > 0 and abs(top[2] - top[1] - 1) < 2, f'the header row stays in view while the table scrolls down: {top}')
    p.set_viewport_size({'width': 1280, 'height': 800}); p.wait_for_timeout(200)
    p.click(f'{T} tbody tr:has-text("Delta Bust")'); check(p.inner_text('#sheet h2') == 'Delta Bust' and len(p.query_selector_all('#sheet [data-unit]')) == 4, 'clicking a row opens the item sheet'); p.click('#sheet button[aria-label="Close"]')
    check(p.query_selector(f'{T} input, {T} [contenteditable]') is None, 'no cell of the table can be edited')
    p.screenshot(path=f'{SHOTS}/stock-table.png')
    tab(p, 'Home')
    cols = p.eval_on_selector_all('.cols > div', 'els => els.map(e => Math.round(e.getBoundingClientRect().left))')
    check(len(cols) == 2 and cols[1] > cols[0] + 300 and 'Today' in p.inner_text('.cols > div:nth-child(1)') and 'New sale' in p.inner_text('.cols > div:nth-child(1)') and 'Needs you' in p.inner_text('.cols > div:nth-child(2)') and fits(), f'Home puts the numbers and buttons beside what needs doing: {cols}'); p.screenshot(path=f'{SHOTS}/home.png')
    check(p.inner_text('header.top h1') == 'Bodega', 'Home on desktop is headed by the app name')
    nrows = p.eval_on_selector_all('.cols > div:nth-child(2) .list > *', 'els => els.length'); badge = p.inner_text('.cols > div:nth-child(2)')
    check(nrows >= 3 and 'See ' not in badge and p.query_selector('[data-act="homeMore"]') is None and all(p.is_visible(f'.cols > div:nth-child(2) .list > *:nth-child({i + 1})') for i in range(nrows)), f'Home on a 1280px window shows all {nrows} Needs-you rows with no See more')
    no_toy(p, 'desktop Home')
    tab(p, 'Inventory'); no_toy(p, 'Inventory'); tab(p, 'Orders'); no_toy(p, 'Orders'); tab(p, 'Sales'); no_toy(p, 'Sales'); add_inventory(p); no_toy(p, 'Add inventory')
    tab(p, 'Activity'); no_toy(p, 'Activity'); check(p.inner_text('header.top h1') == 'Activity' and 'Sale' in p.inner_text('#actList') and fits(), 'Activity opens from the side bar')
    check(heads('moves') == ['Date', 'Product', 'Reason', 'In or Out', 'Qty', 'Cost', 'Ref', 'Note'], f"Activity is a table: {heads('moves')}")
    p.click('[data-tbl="moves"] tbody tr:has-text("Sale")'); check('Grandista Son Goku' in p.inner_text('#sheet h2') and p.is_visible('#sheet button:has-text("Reverse this movement")'), 'clicking a movement row opens the movement'); p.click('#sheet button[aria-label="Close"]')
    p.focus('[data-tbl="moves"] tbody tr:first-child'); p.keyboard.press('Enter'); check(p.is_visible('#sheet button[aria-label="Close"]'), 'Enter on a focused row opens it too'); p.click('#sheet button[aria-label="Close"]')
    p.screenshot(path=f'{SHOTS}/activity.png')
    for w in (1280, 900):
        p.set_viewport_size({'width': w, 'height': 800}); p.wait_for_timeout(200); bad = []
        for pg in ['Home', 'Inventory', 'Sales', 'Orders', 'Add inventory', 'Activity']:
            add_inventory(p) if pg == 'Add inventory' else tab(p, pg); bad += [] if fits() else [pg]
        check(not bad, f'no page scrolls sideways at {w} px wide, only the tables in their own boxes: {bad}')
    p.set_viewport_size({'width': 390, 'height': 780}); p.wait_for_timeout(300)
    check(p.inner_text('header.top h1') == 'Activity' and [x.inner_text().strip() for x in p.query_selector_all('#tabs button')] == ['Home', 'Inventory', 'Sales', 'Orders'] and p.eval_on_selector('nav.tabs', 'e => e.getBoundingClientRect().top') > 600, 'narrowing the window returns to the phone layout with four tabs')
    tab(p, 'Sales'); check(p.is_visible('[data-act="sellNew"]'), 'on a phone Sales opens the invoice list with a New sale button')
    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
