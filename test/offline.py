# The app must open with no network after one visit. python3 test/offline.py
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(); p = ctx.new_page(); p.goto('http://localhost:8765/index.html')
    p.evaluate("navigator.serviceWorker.ready.then(() => 1)"); p.wait_for_timeout(1500)
    p.reload(); p.wait_for_timeout(800)   # now controlled by the worker
    ctx.set_offline(True)
    p.goto('http://localhost:8765/index.html'); p.wait_for_selector('#tabs button')
    print('OFFLINE LOAD OK' if 'Toy Stock' in p.title() and p.query_selector('#tabs button') else 'OFFLINE LOAD FAILED')
    b.close()
