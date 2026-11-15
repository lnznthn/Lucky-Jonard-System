# Desktop layout check: side navigation, two-column Sell and Orders, sheets as dialogs, no sideways scroll.
# python3 test/desktop.py  (needs static server on 8765, mock backend on 8766, Chrome)
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright
APP, API, SHOTS = f"http://localhost:{os.environ.get('APP_PORT', '8765')}/index.html", f"http://localhost:{os.environ.get('API_PORT', '8766')}", '/tmp/shots-desktop'
os.makedirs(SHOTS, exist_ok=True)
fails = []
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)
key = urllib.request.urlopen(API + '/_reset').read().decode()
def post_inbox(rows): urllib.request.urlopen(urllib.request.Request(API + '/_inbox', data=json.dumps(rows).encode(), method='POST')).read()
post_inbox([{'type': 'Count', 'name': 'Grandista Son Goku', 'qty': 3, 'brand': 'Banpresto', 'line': 'Grandista', 'chr': 'Son Goku', 'rel': '2019-06', 'verify': 'Y'},
            {'type': 'Count', 'name': 'Maximatic Monkey D. Luffy', 'qty': 0, 'brand': 'Banpresto', 'line': 'Maximatic', 'chr': 'Monkey D. Luffy'},
            {'type': 'Count', 'name': 'Gigo Roronoa Zoro', 'qty': 2, 'mfr': 'Sega', 'brand': 'Gigo', 'chr': 'Roronoa Zoro'}])
def apply(p, label):
    """Taps Apply, reads the result sheet that stays until closed, and closes it."""
    p.click(f'button:has-text("{label}")'); p.wait_for_selector('#sheet h2:has-text("Applied")'); out = p.inner_text('#sheet')
    p.click('#sheet .btn[data-act="close"]'); return out
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}); p = ctx.new_page(); errors = []
    p.on('pageerror', lambda e: errors.append(str(e))); p.on('dialog', lambda d: d.accept())
    synced = lambda: p.wait_for_function("document.querySelector('#syncTxt').textContent.startsWith('Synced')", timeout=8000)
    nav = lambda name: p.click(f'#tabs button:has-text("{name}")')
    fits = lambda: p.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    pick = lambda k, t: (p.fill(f'[data-pk="{k}"]', t), p.click(f'[data-sug="{k}"] button'))
    p.goto(APP); p.click('button[aria-label="Settings"]')
    box = p.eval_on_selector('#sheet', 'e => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom, innerWidth, innerHeight]; }')
    check(box[1] - box[0] <= 560 and abs((box[0] + box[1]) / 2 - box[4] / 2) < 2 and box[3] < box[5] - 10, f'a sheet opens as a centred dialog: {box}')
    p.fill('#sCode', f'{API}/exec#{key}'); p.click('button:has-text("Test and save")'); synced()
    side = p.eval_on_selector('nav.tabs', 'e => { const r = e.getBoundingClientRect(); return [r.left, r.width, r.height, innerHeight]; }')
    check(side[0] == 0 and 200 < side[1] < 260 and side[2] == side[3], f'navigation is a full-height side bar: {side}')
    labels = [x.inner_text().strip() for x in p.query_selector_all('#tabs button')]
    check(labels == ['Home', 'Stock', 'Sales', 'Orders', 'Update stock · 3', 'Activity'] and p.inner_text('#tabs .brand') == 'Bodega', f"side bar: Home, Stock, Sales, Orders, Update stock with its count, Activity: {labels}")
    check(p.eval_on_selector('#tabs button.on', 'e => getComputedStyle(e).color') == p.evaluate("getComputedStyle(document.body).color"), 'the current page in the side bar is in the text colour')
    nav('Update stock'); apply(p, 'Apply 3 changes'); synced()
    check(p.inner_text('header.top h1') == 'Stock' and fits(), 'header names the page; Stock fits the window')
    for nm, pr in [('Grandista', '1800'), ('Maximatic', '1500')]:
        p.click(f'.item:has-text("{nm}")'); p.click('button:has-text("Edit details")'); p.fill('#fPrice', pr); p.click('#sheet button.primary:has-text("Save")')
    p.screenshot(path=f'{SHOTS}/stock.png')
    nav('Sales')
    check(p.is_visible('#sellBody button:has-text("Issue invoice")') and p.is_visible('#invList') and not p.is_visible('[data-act="sellNew"]') and p.inner_text('header.top h1') == 'Sales', 'Sales shows the New sale form and the invoice list together')
    pick('inv.lines.0', 'goku'); p.fill('[data-b="inv.cust"]', 'Ben Cruz'); p.click('button:has-text("Issue invoice no. 1")'); p.screenshot(path=f'{SHOTS}/invoice-dialog.png'); p.click('button[aria-label="Close"]'); synced()
    check('No. 1 · Ben Cruz' in p.inner_text('#invList') and p.is_visible('button:has-text("Issue invoice no. 2")') and fits(), 'the new invoice appears in the list beside a fresh form')
    cols = p.eval_on_selector_all('.cols > div', 'els => els.map(e => Math.round(e.getBoundingClientRect().left))')
    check(len(cols) == 2 and cols[1] > cols[0] + 300, f'two columns on Sales: {cols}'); p.screenshot(path=f'{SHOTS}/sell.png')
    pick('inv.lines.0', 'luffy'); p.fill('[data-b="inv.cust"]', 'Ana Reyes'); p.fill('[data-b="inv.contact"]', '+63 917 000 0000'); p.fill('[data-b="inv.paid"]', '500')
    check(p.is_visible('#invNotice'), 'an item not in stock turns the form beside the list into a pre-order')
    p.click('button:has-text("Save pre-order")'); p.click('button[aria-label="Close"]')
    nav('Orders')
    check(p.is_visible('button:has-text("New supplier order")') and 'To take a pre-order, start a New sale' in p.inner_text('#view') and not p.is_visible('button:has-text("New pre-order")') and fits(), 'Orders shows pre-orders and supplier orders together')
    p.click('button:has-text("New supplier order")'); pick('f', 'luffy'); p.fill('[data-b="f.qty"]', '4'); p.click('button:has-text("Save order")'); synced()
    v = p.inner_text('#view'); check('Ana Reyes' in v and 'Maximatic Monkey D. Luffy' in v and 'ON THE WAY' in v.upper(), 'both lists fill in side by side'); p.screenshot(path=f'{SHOTS}/orders.png')
    nav('Home')
    cols = p.eval_on_selector_all('.cols > div', 'els => els.map(e => Math.round(e.getBoundingClientRect().left))')
    check(len(cols) == 2 and cols[1] > cols[0] + 300 and 'Today' in p.inner_text('.cols > div:nth-child(1)') and 'New sale' in p.inner_text('.cols > div:nth-child(1)') and 'Needs you' in p.inner_text('.cols > div:nth-child(2)') and fits(), f'Home puts the numbers and buttons beside what needs doing: {cols}'); p.screenshot(path=f'{SHOTS}/home.png')
    check(p.inner_text('header.top h1') == 'Bodega', 'Home on desktop is headed by the app name')
    nrows = p.eval_on_selector_all('.cols > div:nth-child(2) .list > *', 'els => els.length'); badge = p.inner_text('.cols > div:nth-child(2)')
    check(nrows >= 3 and 'See ' not in badge and p.query_selector('[data-act="homeMore"]') is None and all(p.is_visible(f'.cols > div:nth-child(2) .list > *:nth-child({i + 1})') for i in range(nrows)), f'Home on a 1280px window shows all {nrows} Needs-you rows with no See more')
    no_toy = lambda where: check('toy' not in p.evaluate("document.body.innerText").replace('Plain Toy', '').lower(), f'no toy wording on {where}')
    no_toy('desktop Home')
    nav('Stock'); no_toy('Stock'); nav('Orders'); no_toy('Orders'); nav('Sales'); no_toy('Sales'); nav('Update stock'); no_toy('Update stock')
    nav('Activity'); no_toy('Activity'); check(p.inner_text('header.top h1') == 'Activity' and 'Sale' in p.inner_text('#actList') and fits(), 'Activity opens from the side bar')
    p.set_viewport_size({'width': 390, 'height': 780}); p.wait_for_timeout(300)
    check(p.inner_text('header.top h1') == 'Activity' and [x.inner_text().strip() for x in p.query_selector_all('#tabs button')] == ['Home', 'Stock', 'Sales', 'Orders'] and p.eval_on_selector('nav.tabs', 'e => e.getBoundingClientRect().top') > 600, 'narrowing the window returns to the phone layout with four tabs')
    nav('Sales'); check(p.is_visible('[data-act="sellNew"]'), 'on a phone Sales opens the invoice list with a New sale button')
    check(not errors, f'no page errors: {errors}')
    b.close()
print('\nFAILED:' if fails else '\nALL PASSED', *fails, sep='\n')
sys.exit(1 if fails else 0)
