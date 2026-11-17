# Helpers shared by the browser tests (from common import *). Importing it resets the mock backend, so each test starts on an empty sheet.
import json, os, sys, urllib.request

APP_PORT, API_PORT = os.environ.get('APP_PORT', '8765'), os.environ.get('API_PORT', '8766')
APP, API = f'http://localhost:{APP_PORT}/index.html', f'http://localhost:{API_PORT}'
fails, errors = [], []   # failed checks, and errors thrown in the pages made by page()
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)
def finish():
    print('\nFAILED:' if fails else '\nALL PASSED', *fails, sep='\n')
    sys.exit(1 if fails else 0)
def dump(): return json.load(urllib.request.urlopen(API + '/_dump'))
def rows(name): return dump()[name]['rows'][1:]
def post_inbox(rs): urllib.request.urlopen(urllib.request.Request(API + '/_inbox', data=json.dumps(rs).encode(), method='POST')).read()
key = urllib.request.urlopen(API + '/_reset').read().decode()
CODE = f'{API}/exec#{key}'

def launch(pw): return pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
def page(ctx, tag=''):
    """A new page that accepts every confirm and keeps its errors in errors, each starting with tag."""
    p = ctx.new_page(); p.on('pageerror', lambda e: errors.append(tag + str(e))); p.on('dialog', lambda d: d.accept()); return p
def tab(p, name): p.click(f'#tabs button:has-text("{name}")')
def home(p): tab(p, 'Home'); return p.inner_text('#view')
def add_inventory(p): tab(p, 'Home'); p.click('#view .actions button[data-to="add"]')   # Inventory with its Add inventory tab chosen
def new_sale(p): tab(p, 'Sales'); p.click('#view [data-act="sellNew"]') if p.is_visible('#view [data-act="sellNew"]') else None
def synced(p): p.wait_for_function("document.querySelector('#syncTxt').textContent.startsWith('Synced')", timeout=8000)
def connect(p, code=CODE): p.click('button[aria-label="Settings"]'); p.fill('#sCode', code); p.click('button:has-text("Test and save")')
def pick(p, key, text): p.fill(f'[data-pk="{key}"]', text); p.click(f'[data-sug="{key}"] button')
def close(p): p.click('button[aria-label="Close"]')
def stock_names(p): return [e.inner_text().strip() for e in p.query_selector_all('#stockList .item .name')]
def stock_map(p):
    tab(p, 'Inventory'); p.click('#view .seg button[data-f="all"]')
    return {r.query_selector('.name').inner_text().strip(): int(r.query_selector('.qty').inner_text()) for r in p.query_selector_all('#stockList .item')}
def paste_import(p, mode, text):
    add_inventory(p)
    if not p.is_visible('#impText'): p.click('#manual summary')
    p.click(f'button[data-m="{mode}"]'); p.fill('#impText', text); p.click('button:has-text("Preview")')
def apply(p, label):
    """Taps Apply, reads the result sheet that stays until closed, and closes it."""
    p.click(f'button:has-text("{label}")'); p.wait_for_selector('#sheet h2:has-text("Applied")'); out = p.inner_text('#sheet')
    p.click('#sheet .btn[data-act="close"]'); return out
# Product names in the test data that contain the word; everything else on screen must not say it.
DATA_NAMES = ['Plain Toy', 'Toy Train Set']
def no_toy(p, where):
    txt = p.evaluate("() => document.body.innerText + ' ' + [...document.querySelectorAll('[placeholder],[aria-label]')].filter(e => e.offsetParent || e.closest('#sheet')).map(e => (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || '')).join(' ')")
    for n in DATA_NAMES: txt = txt.replace(n, '')
    check('toy' not in txt.lower(), f'no “toy” in the text of {where}')
