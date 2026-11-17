# The app must open with no network after one visit, fonts included. python3 test/offline.py
import os
from playwright.sync_api import sync_playwright
APP = f"http://localhost:{os.environ.get('APP_PORT', '8765')}/index.html"
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(); p = ctx.new_page(); p.goto(APP)
    p.evaluate("navigator.serviceWorker.ready.then(() => 1)"); p.wait_for_timeout(1500)
    p.reload(); p.wait_for_timeout(800)   # now controlled by the worker
    ctx.set_offline(True)
    p.goto(APP); p.wait_for_selector('#tabs button')
    fonts = p.evaluate("document.fonts.ready.then(() => ['400 16px Geist', '500 16px Geist', '600 16px Geist', '28px \"Bebas Neue\"'].every(f => document.fonts.check(f) && [...document.fonts].some(x => x.status === 'loaded')))")
    loaded = p.evaluate("Promise.all([document.fonts.load('28px \"Bebas Neue\"'), document.fonts.load('600 16px Geist')]).then(r => r.every(x => x.length > 0))")
    ok = p.title() == 'Bodega' and p.query_selector('#tabs button') and fonts and loaded
    print('OFFLINE LOAD OK' if ok else f'OFFLINE LOAD FAILED (title {p.title()!r}, fonts {fonts}, loaded {loaded})')
    b.close()
