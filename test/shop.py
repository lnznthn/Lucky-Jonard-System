# Release 2.7 in the app: the shop's details live in the sheet and reach every device (the logo too), a device's details from 2.6 move
# up with fill without overwriting the sheet's, the New shop guide while not connected, and the version guard that holds entries for a
# back end older than the app. Two browser contexts are two devices. Drives the app at phone size.
# python3 test/shop.py  (needs the static server on APP_PORT and the mock backend on API_PORT, Chrome)
import base64, json, tempfile, urllib.request
from playwright.sync_api import sync_playwright
from common import *

def post(path, body): urllib.request.urlopen(urllib.request.Request(API + path, data=body.encode(), method='POST')).read()
def shop_tab(): return {r[0]: r[1] for r in rows('Shop') if r[0]}
def settings(p): p.click('button[aria-label="Settings"]')
def shop(p): return p.evaluate('[prefs.shop, prefs.cur]')

with sync_playwright() as pw:
    b = launch(pw)
    phone = dict(viewport={'width': 390, 'height': 844})
    a = page(b.new_context(**phone), 'A '); a.goto(APP); connect(a); synced(a)

    # ---- device A: the Shop group saves the fields that changed in one entry, and they reach the Shop tab
    settings(a)
    check([h.inner_text() for h in a.query_selector_all('#sheet .sec > h2')] == ['Connection', 'Shop', 'Preferences', 'Data'] and a.query_selector('#guide') is None, 'Settings: Connection, Shop, Preferences, Data; no New shop guide once connected')
    check('Shared by every device on this shop’s sheet' in a.inner_text('#shopHint') and a.query_selector('#sheet .sec:has(h2:text-is("Preferences")) input') is None, 'the Shop group says it is shared; Preferences keeps the theme only')
    a.evaluate("$('#sShop').value = 'x'.repeat(121)"); a.click('#sheet [data-act="saveShop"]')
    check('Shop name is too long' in a.inner_text('#toast') and not a.evaluate('queue') and a.is_visible('#sShop'), 'a name longer than the sheet takes is refused before it is queued')
    a.fill('#sShop', 'Ana Shop'); a.fill('#sContact', '12 Main St\nManila'); a.fill('#sCur', '$'); a.click('#sheet [data-act="saveShop"]')
    check([(q['kind'], q['shop'], q.get('fill')) for q in a.evaluate('queue')] == [('shop', {'name': 'Ana Shop', 'contact': '12 Main St\nManila', 'cur': '$'}, None)], f"one shop entry with the changed fields: {a.evaluate('queue')}")
    synced(a)
    check(shop_tab() == {'Shop name': 'Ana Shop', 'Address': '12 Main St\nManila', 'Notes': '', 'Currency': '$'}, f'the Shop tab has them: {shop_tab()}')
    # a large photo as the logo is scaled down under the back end's 120,000-character limit
    a.evaluate("""() => { const c = document.createElement('canvas'); c.width = c.height = 1000; const x = c.getContext('2d'), d = x.createImageData(1000, 1000);
      for (let i = 0; i < d.data.length; i++) d.data[i] = i % 4 === 3 ? 255 : Math.random() * 256; x.putImageData(d, 0, 0); window._pic = c.toDataURL('image/png'); }""")
    pic = tempfile.mktemp(suffix='.png'); open(pic, 'wb').write(base64.b64decode(a.evaluate('window._pic').split(',')[1]))
    settings(a); a.set_input_files('#sLogo', pic); a.wait_for_selector('#sheet img.logo'); close(a); synced(a)
    logo = shop(a)[0]['logo']
    check(logo.startswith('data:image/jpeg;base64,') and len(logo) <= 120000 and not a.evaluate('queue'), f'the logo is a JPEG under 120,000 characters, and the sheet took it ({len(logo)})')

    # ---- device B, a fresh device: the details and the logo arrive with its first sync; later syncs send have.logoRev and get no logo
    bb = page(b.new_context(**phone), 'B '); bb.goto(APP); connect(bb); synced(bb)
    check(shop(bb) == [{'name': 'Ana Shop', 'contact': '12 Main St\nManila', 'foot': '', 'logo': logo}, '$'] and bb.inner_text('#title') == 'Ana Shop', 'device B has the shop’s details, logo and currency, and Home is headed by the name')
    with bb.expect_response(lambda r: r.url.startswith(API) and r.request.method == 'POST') as res: bb.click('#syncBtn')
    check(json.loads(res.value.request.post_data)['have']['logoRev'] == bb.evaluate('meta.logoRev') and 'logo' not in res.value.json()['data'], 'the next sync sends have.logoRev and the logo does not come again')

    # ---- while a shop entry waits, a snapshot does not overwrite the values typed here; once it lands the sheet has them
    settings(bb); bb.fill('#sShop', 'Typed here')
    kept = bb.evaluate("async () => { const rev = meta.logoRev; saveShop(); applySnapshot(await api('sync', { have: meta })); return [prefs.shop.name, meta.logoRev === rev]; }")
    check(kept == ['Typed here', True], f'a snapshot taken while the entry waits keeps the typed name: {kept}')
    close(bb); synced(bb); check(shop_tab()['Shop name'] == 'Typed here', 'then the name reaches the sheet')

    # ---- device C still holds its details from 2.6 (kept per device then): they move up once with fill, which sets only blank fields
    c = page(b.new_context(**phone), 'C '); c.goto(APP)
    c.evaluate("() => { const x = document.createElement('canvas'); x.width = x.height = 40; x.getContext('2d').fillRect(0, 0, 40, 40); localStorage.setItem('toys.prefs', JSON.stringify({ tab: 'home', cur: '€', theme: 'auto', shop: { name: 'Old Name', contact: 'Old Street', foot: 'Old notes', logo: x.toDataURL('image/png') } })); }")
    c.reload(); c.wait_for_selector('#tabs button'); q = c.evaluate('queue')
    check(len(q) == 1 and q[0]['fill'] is True and {k: v for k, v in q[0]['shop'].items() if k != 'logo'} == {'name': 'Old Name', 'contact': 'Old Street', 'foot': 'Old notes', 'cur': '€'} and q[0]['shop']['logo'].startswith('data:image/png'), f"one shop entry with fill carries the device’s details: {[(x['kind'], x.get('fill'), sorted(x['shop'])) for x in q]}")
    settings(c); check(c.is_visible('#guide') and c.get_attribute('#guide a', 'href') == 'https://github.com/lnznthn/bodega-app/blob/main/apps-script/Code.gs', 'not connected: Settings shows the New shop guide, linking Code.gs'); no_toy(c, 'Settings with the New shop guide'); close(c)
    connect(c); synced(c)
    check(shop_tab() == {'Shop name': 'Typed here', 'Address': '12 Main St\nManila', 'Notes': 'Old notes', 'Currency': '$'}, f'fill set only the blank Notes: {shop_tab()}')
    check(shop(c) == [{'name': 'Typed here', 'contact': '12 Main St\nManila', 'foot': 'Old notes', 'logo': logo}, '$'], 'device C now shows the sheet’s details and keeps the stored logo')
    c.reload(); c.wait_for_selector('#tabs button'); check(not c.evaluate('queue'), 'the move-up happens once')

    # ---- a logo removed on one device is removed on the others
    settings(bb); bb.click('#sheet [data-act="logoOff"]'); close(bb); synced(bb)
    a.click('#syncBtn'); synced(a); check(shop(a)[0]['logo'] == '' and shop(a)[0]['name'] == 'Typed here', 'device A loses the logo and has the new name')

    # ---- version guard: a back end older than the app gets no entries; they wait, the reason shows, and they go once it is updated
    post('/_ver', '"2.6.0"'); a.click('#syncBtn'); synced(a)
    check(a.evaluate('meta.ver') == '2.6.0' and 'Update the sheet' not in home(a), 'the version comes with every sync; with nothing to send, nothing is held')
    settings(a); a.fill('#sFoot', 'Held note'); a.click('#sheet [data-act="saveShop"]')
    a.wait_for_function("document.querySelector('#syncTxt').textContent === 'Sheet out of date'", timeout=8000)
    tab(a, 'Home'); top = a.inner_text('#view .list .item')
    check(top == 'Update the sheet: it runs back end 2.6.0, this app needs 2.7.0\nPaste the new Code.gs, run Bodega > Set up or upgrade this sheet, publish a new version. 1 entry waits here until then.', f'the top Home row says why entries wait: {top!r}')
    check([x['status'] for x in a.evaluate('queue')] == ['pending'] and shop_tab()['Notes'] == 'Old notes', 'the entry stays queued and the sheet is untouched')
    settings(a); check('This shop’s sheet runs back end 2.6.0; this app needs 2.7.0.' in a.inner_text('#sheet'), 'Settings > Connection gives the reason'); close(a)
    post('/_ver', '"2.7.0"'); a.click('#syncBtn'); synced(a)
    check(not a.evaluate('queue') and shop_tab()['Notes'] == 'Held note' and 'Update the sheet' not in home(a), 'once the back end is updated the entry goes and the row is gone')

    check(not errors, f'no page errors: {errors}')
    b.close()
finish()
