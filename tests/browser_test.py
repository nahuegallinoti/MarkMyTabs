"""UI and real Manifest V3 checks, using disposable browser profiles only.

Run with tools/dev-server.js listening on port 5173. No personal data is read.
Optional: MMT_TEST_CHROMIUM points to a Chromium binary already installed.
"""
import json
import os
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://localhost:5173'
SHOTS = ROOT / 'store-assets'


def check(condition, message):
    assert condition, message
    print('PASS', message)


def launch_options():
    binary = os.environ.get('MMT_TEST_CHROMIUM')
    if binary:
        return dict(headless=True, executable_path=binary)
    return dict(headless=True)


with sync_playwright() as p:
    browser = p.chromium.launch(**launch_options())
    context = browser.new_context(locale='en-US', viewport=dict(width=1365, height=900))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.goto(BASE + '/manager/manager.html')
    page.wait_for_load_state('networkidle')
    expect(page.locator('.card')).to_have_count(6)

    # Dialog focus, unsafe URL validation, and a full create/edit/delete/undo cycle.
    page.locator('#btnAdd').click()
    page.get_by_role('menuitem', name='New bookmark', exact=True).click()
    for _ in range(15):
        page.keyboard.press('Tab')
        assert page.locator('#modalRoot').evaluate('(n) => n.contains(document.activeElement)')
    check(True, 'dialog keeps keyboard focus inside')
    page.get_by_label('Name', exact=True).fill('A test bookmark')
    page.get_by_label('URL', exact=True).fill('javascript:alert(1)')
    page.get_by_role('button', name='Add', exact=True).last.click()
    expect(page.locator('.field.invalid')).to_be_visible()
    page.get_by_label('URL', exact=True).fill('example.com/Docs#First')
    page.get_by_role('button', name='Add', exact=True).last.click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    bookmark = page.locator('.card').filter(has=page.locator('.title', has_text='A test bookmark'))
    expect(bookmark).to_be_visible()
    bookmark.focus()
    page.keyboard.press('F2')
    page.get_by_label('Name', exact=True).fill('Renamed bookmark')
    page.get_by_role('button', name='Save', exact=True).click()
    bookmark = page.locator('.card').filter(has=page.locator('.title', has_text='Renamed bookmark'))
    expect(bookmark).to_be_visible()
    bookmark.focus()
    page.keyboard.press('Delete')
    expect(bookmark).to_have_count(0)
    page.locator('.toast').filter(has_text='Deleted').get_by_role('button', name='Undo').click()
    expect(bookmark).to_be_visible()
    check(True, 'create, validate, edit, delete and restore a bookmark')

    page.get_by_role('button', name='Pin folder', exact=True).click()
    expect(page.locator('#views .side-item').filter(has_text='Bookmarks bar')).to_have_count(1)
    page.reload()
    expect(page.locator('#views .side-item').filter(has_text='Bookmarks bar')).to_have_count(1)
    check(True, 'pinned folders survive reload')

    # 1.2: search operators.
    page.locator('#search').fill('site:github.com')
    expect(page.locator('#viewCount')).to_contain_text('2 results')
    page.locator('#search').fill('is:folder dev')
    expect(page.locator('#viewCount')).to_contain_text('1 result for')
    page.locator('#search').fill('in:recipes -milanesa')
    expect(page.locator('#viewCount')).to_contain_text('2 results')
    page.locator('#btnClearSearch').click()
    check(True, 'search operators site:, is:, in: and exclusions')

    # Move dialog: type to filter folders, Enter to move, Ctrl+Z to undo.
    gmail = page.locator('.card').filter(has=page.locator('.title', has_text='Gmail'))
    gmail.click(button='right')
    page.get_by_role('menuitem', name='Move to…').click()
    page.keyboard.type('travel')
    page.keyboard.press('Enter')
    expect(page.locator('.toast').filter(has_text='Moved to “Travel”')).to_be_visible()
    expect(gmail).to_have_count(0)
    page.keyboard.press('Control+z')
    expect(gmail).to_be_visible()
    check(True, 'move dialog filters folders by typing and Ctrl+Z undoes the move')

    # Permanent sort with undo, pasted links and links dropped from another page.
    page.evaluate('''async () => {
      const {bm} = await import('/common/utils.js'); const [root] = await bm.getTree();
      const f = await bm.create({parentId: root.children[1].id, title: 'Sort me'});
      for (const t of ['Zeta', 'alpha', 'Mango']) await bm.create({parentId: f.id, title: t, url: 'https://example.net/' + t});
    }''')
    sort_row = page.locator('#tree .tree-row', has_text='Sort me')
    sort_row.click()
    sort_row.click(button='right')
    page.get_by_role('menuitem', name='Sort by name').click()
    expect(page.locator('#content .card .title')).to_have_text(['alpha', 'Mango', 'Zeta'])
    page.keyboard.press('Control+z')
    expect(page.locator('#content .card .title')).to_have_text(['Zeta', 'alpha', 'Mango'])
    page.evaluate('''() => {
      const dt = new DataTransfer(); dt.setData('text/plain', 'https://example.com/one https://example.com/two');
      document.body.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
    }''')
    expect(page.locator('.toast').filter(has_text='2 bookmarks added')).to_be_visible()
    expect(page.locator('#content .card')).to_have_count(5)
    page.evaluate('''() => {
      const dt = new DataTransfer(); dt.setData('text/uri-list', 'https://example.com/dropped');
      dt.setData('text/html', '<a href="https://example.com/dropped">Dropped link</a>');
      const c = document.querySelector('#content');
      c.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true}));
      c.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
    }''')
    expect(page.locator('#content .card .title', has_text='Dropped link')).to_be_visible()
    check(True, 'sort a folder by name with undo, paste links and drop links from other pages')

    # Cleanup: empty folders and the (simulated) broken link check.
    page.evaluate('''async () => {
      const {bm} = await import('/common/utils.js'); const [root] = await bm.getTree();
      const f = await bm.create({parentId: root.children[1].id, title: 'Hollow'});
      await bm.create({parentId: f.id, title: 'Inner hollow'});
    }''')
    page.locator('#views .side-item', has_text='Cleanup').click()
    page.locator('.cleanup-tabs').get_by_role('button', name='Empty folders').click()
    expect(page.locator('#content').get_by_text('Hollow', exact=True)).to_have_count(1)
    expect(page.locator('#content').get_by_text('Inner hollow', exact=True)).to_have_count(0)
    page.get_by_role('button', name='Delete empty folders (1)').click()
    expect(page.locator('#tree .tree-row', has_text='Hollow')).to_have_count(0)
    page.locator('.cleanup-tabs').get_by_role('button', name='Broken links').click()
    page.locator('#headActions').get_by_role('button', name=re.compile(r'Check \d+ links')).click()
    expect(page.get_by_text('Not found · 2')).to_be_visible(timeout=15000)
    page.locator('.link-item').filter(has_text='Booking.com').get_by_role('button', name='Use new address').click()
    expect(page.locator('.toast').filter(has_text='Address updated')).to_be_visible()
    check(page.evaluate('''async () => {
      const {bm} = await import('/common/utils.js'); const [root] = await bm.getTree();
      return JSON.stringify(root).includes('index.es.html');
    }'''), 'cleanup finds empty folders, reports broken links and updates moved ones')

    # Save open tabs (simulated tabs outside the extension).
    page.locator('#btnAdd').click()
    page.get_by_role('menuitem', name='Save open tabs…').click()
    expect(page.locator('.tab-row')).to_have_count(4)
    page.locator('.tab-row').nth(3).locator('input').uncheck()
    page.get_by_label('New folder name', exact=True).fill('Research session')
    page.get_by_role('button', name='Save 3 tabs').click()
    expect(page.locator('.toast').filter(has_text='3 tabs saved')).to_be_visible()
    expect(page.locator('#viewTitle')).to_have_text('Research session')
    expect(page.locator('#content .card')).to_have_count(3)
    check(True, 'save open tabs into a new folder')

    # Import/export transformations, validation, nesting, and distinct URLs.
    pure = page.evaluate('''async () => {
      const m = await import('/common/backup.js');
      const u = await import('/common/utils.js');
      const nodes = [{title:'Outer <&>',children:[{title:'Empty',children:[]},{title:'Nested',children:[{title:'Safe <img>',url:'https://example.com/Docs#A'}]}]}];
      const json = m.parseBackup(m.exportJson(nodes));
      const html = m.parseBackup(m.exportHtml(nodes), true);
      let rejects = 0;
      for (const text of ['{}', '{bad', '{"children":[{"title":"x","url":"javascript:alert(1)"}]}', '{"children":[{"title":"x","url":5}]}']) {
        try { m.parseBackup(text); } catch { rejects++; }
      }
      return { json, html, rejects,
        distinct: u.bookmarkUrlKey('https://EXAMPLE.com/Docs#A') !== u.bookmarkUrlKey('https://example.com/docs#A'),
        fragment: u.bookmarkUrlKey('https://example.com/Docs#A') !== u.bookmarkUrlKey('https://example.com/Docs#B') };
    }''')
    check(pure['json'] == pure['html'] and pure['json']['folders'] == 3, 'HTML and JSON round trips preserve folders and escaped text')
    check(pure['rejects'] == 4 and pure['distinct'] and pure['fragment'], 'invalid backups rejected and distinct URL paths/fragments preserved')

    upload = dict(name='collection.json', mimeType='application/json', buffer=json.dumps(dict(children=[
        dict(title='Imported group', children=[dict(title='Imported entry', url='https://example.com/imported')]),
        dict(title='Repeated GitHub', url='https://github.com/')])).encode())
    page.locator('#importFile').set_input_files(upload)
    expect(page.get_by_role('dialog')).to_be_visible()
    expect(page.get_by_text('2 bookmarks · 1 folder')).to_be_visible()
    page.get_by_role('button', name='Import', exact=True).click()
    expect(page.get_by_role('dialog')).to_have_count(0)
    expect(page.locator('.toast').filter(has_text='1 bookmark imported · 1 skipped')).to_be_visible()
    imported_id = page.locator('#tree .active').get_attribute('data-id')
    page.locator('.toast').filter(has_text='imported').get_by_role('button', name='Undo').click()
    expect(page.locator(f'#tree [data-id="{imported_id}"]')).to_have_count(0)
    check(True, 'import preview, duplicate skipping and undo remove only the imported collection')

    # A failure after creating part of an import rolls back the new folder.
    page.evaluate('''async () => {
      const {bm} = await import('/common/utils.js'); window.normalCreate = bm.create;
      bm.create = async o => { if (o.url) throw new Error('Import write failure'); return window.normalCreate(o); };
    }''')
    page.locator('#importFile').set_input_files(upload)
    page.get_by_label('New folder name', exact=True).fill('Rollback collection')
    page.get_by_role('button', name='Import', exact=True).click()
    expect(page.locator('.toast').filter(has_text='Import write failure')).to_be_visible()
    expect(page.get_by_role('dialog')).to_be_visible()
    check(page.evaluate('''async () => {
      const {bm} = await import('/common/utils.js'); const [root] = await bm.getTree();
      return !JSON.stringify(root).includes('Rollback collection');
    }'''), 'failed import rolls back its partial collection and keeps the dialog open')
    page.evaluate("async () => { const {bm} = await import('/common/utils.js'); bm.create = window.normalCreate; }")
    page.keyboard.press('Escape')

    with page.expect_download() as download:
        page.locator('#btnBackup').click()
        page.get_by_role('menuitem', name='Export all · JSON backup').click()
    path = download.value.path()
    check(json.loads(Path(path).read_text())['format'] == 'mark-my-tabs', 'JSON export downloads a usable backup')

    # Search pagination beyond the previous 300 result limit.
    page.evaluate('''async () => {
      const {bm} = await import('/common/utils.js'); const [root] = await bm.getTree();
      const folder = await bm.create({parentId:root.children[0].id,title:'Collection Omega'});
      for (let i=0;i<405;i++) await bm.create({parentId:folder.id,title:'BulkResult '+i,url:'https://example.org/'+i});
    }''')
    page.locator('#search').fill('BulkResult')
    expect(page.locator('#viewCount')).to_contain_text('405 results')
    expect(page.locator('#content .card')).to_have_count(400)
    page.get_by_role('button', name='Show 5 more', exact=True).click()
    expect(page.locator('#content .card')).to_have_count(405)
    page.locator('#search').fill('Omega')
    expect(page.locator('#viewCount')).to_contain_text('406 results')
    page.locator('#searchFilters').get_by_role('button', name='Folders', exact=True).click()
    expect(page.locator('#content .card')).to_have_count(1)
    check(True, 'search includes folder paths, filters by type and paginates all 405 results')

    page.locator('#btnClearSearch').click()
    expect(page.locator('#searchFilters')).to_be_hidden()
    page.locator('#btnTheme').click()
    page.wait_for_timeout(200)
    page.screenshot(path=str(SHOTS / 'qa-manager-dark.png'))
    page.locator('#btnTheme').click()
    page.wait_for_timeout(200)
    page.screenshot(path=str(SHOTS / 'qa-manager-light.png'))
    for width in [390, 768]:
        page.set_viewport_size(dict(width=width, height=844))
        page.wait_for_timeout(250)  # Let the sidebar's responsive transition finish before screenshots.
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'manager fits {width}px width')
    page.screenshot(path=str(SHOTS / 'qa-manager-mobile.png'))
    page.set_viewport_size(dict(width=1365, height=900))

    # Popup save/edit/undo and actual folder collapse persistence.
    page.goto(BASE + '/popup/popup.html')
    page.wait_for_load_state('networkidle')
    page.locator('.star').click()
    expect(page.locator('.star')).to_have_attribute('aria-pressed', 'true')
    page.locator('#notice').get_by_role('button', name='Undo').click()
    expect(page.locator('.star')).to_have_attribute('aria-pressed', 'false')
    page.locator('.edit-current').click()
    page.locator('.current-editor .name-input').fill('Saved from popup')
    selected = page.locator('.current-editor .fp-row').nth(1).get_attribute('data-id')
    page.locator('.current-editor .fp-row').nth(1).click()
    page.locator('.save-current').click()
    expect(page.locator('.star')).to_have_attribute('aria-pressed', 'true')
    check(page.evaluate("JSON.parse(localStorage.getItem('mp-last-save-folder'))") == selected, 'popup remembers the selected save folder')
    page.locator('#btnCollapse').click()
    expect(page.locator('.row.tree[data-folder="1"]')).to_have_count(2)
    page.reload()
    expect(page.locator('.row.tree[data-folder="1"]')).to_have_count(2)
    page.locator('#popupViews').get_by_role('button', name='Recent', exact=True).click()
    expect(page.get_by_text('Recently saved', exact=True)).to_be_visible()
    page.set_viewport_size(dict(width=400, height=660))
    page.screenshot(path=str(SHOTS / 'qa-popup-light.png'))
    page.locator('#btnTheme').click()
    page.wait_for_timeout(200)
    page.screenshot(path=str(SHOTS / 'qa-popup-dark.png'))
    check(True, 'popup save, undo, edit, collapse persistence, recents and theme')

    # Storage/API failures must preserve drafts and permit retry.
    page.goto(BASE + '/save/save.html?url=https://example.com/retry&title=Retry')
    page.wait_for_load_state('networkidle')
    page.evaluate('''async () => {
      const {bm} = await import('/common/utils.js'); window.originalCreate = bm.create;
      bm.create = async () => { throw new Error('Simulated write failure'); };
      window.close = () => { window.closedByApp = true; };
    }''')
    page.locator('#name').fill('Keep my draft')
    page.locator('#btnSave').click()
    expect(page.locator('#error')).to_contain_text('Simulated write failure')
    expect(page.locator('#name')).to_have_value('Keep my draft')
    expect(page.locator('#btnSave')).to_be_enabled()
    check(not page.evaluate('Boolean(window.closedByApp)'), 'save failure keeps window open with draft intact')
    page.evaluate("async () => { const {bm} = await import('/common/utils.js'); bm.create = window.originalCreate; }")
    page.locator('#btnSave').click()
    check(page.evaluate('Boolean(window.closedByApp)'), 'save retries successfully')

    page.goto(BASE + '/save/save.html?url=https://example.com/picked&title=Picked')
    page.wait_for_load_state('networkidle')
    page.evaluate("window.close = () => { window.closedByApp = true; }")
    page.get_by_role('combobox').fill('desig')
    page.keyboard.press('Enter')
    page.wait_for_function('window.closedByApp === true')
    check(page.evaluate('''async () => {
      const {bm} = await import('/common/utils.js'); const [root] = await bm.getTree();
      const find = n => n.title === 'Design' ? n : (n.children || []).map(find).find(Boolean);
      return find(root).children.some(c => c.url === 'https://example.com/picked');
    }'''), 'save dialog picks a folder by typing and saves with Enter')
    check(not errors, 'no uncaught browser errors: ' + ', '.join(errors))
    browser.close()

    # Test the packaged extension against Chrome APIs, in a temporary profile.
    with TemporaryDirectory(prefix='mmt-test-', ignore_cleanup_errors=True) as profile:
        context = p.chromium.launch_persistent_context(profile, **launch_options(), locale='en-US',
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'])
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension = worker.url.rsplit('/', 1)[0]
        page = context.new_page()
        page.goto(extension + '/manager/manager.html')
        page.wait_for_load_state('networkidle')
        for other in context.pages:
            if other != page:
                other.close()
        check(page.evaluate('Boolean(chrome.runtime.id && chrome.bookmarks)'), 'Manifest V3 loads with the real bookmarks API')
        page.evaluate('''async () => {
          const [root] = await chrome.bookmarks.getTree();
          await chrome.bookmarks.create({parentId:root.children[0].id,title:'Real API bookmark',url:'https://example.com/real'});
        }''')
        page.get_by_role('button', name='All bookmarks', exact=False).click()
        expect(page.get_by_text('Real API bookmark', exact=True)).to_be_visible()
        # Force a deterministic tracked tab, then request a query on the same manager.
        page.evaluate("chrome.runtime.sendMessage({type:'manager-ready'})")
        page.wait_for_function("async () => (await chrome.storage.session.get('managerTabId')).managerTabId === (await chrome.tabs.getCurrent()).id")
        tab_id = page.evaluate("async () => (await chrome.storage.session.get('managerTabId')).managerTabId")
        page.evaluate("chrome.runtime.sendMessage({type:'open-manager',params:'?q=Real'})")
        page.wait_for_url('**/manager/manager.html?q=Real')
        check(page.evaluate("async () => (await chrome.storage.session.get('managerTabId')).managerTabId") == tab_id, 'manager reuses its tab for popup searches')
        check(worker.evaluate("chrome.runtime.getManifest().version") == '1.2.0'
              and worker.evaluate("typeof chrome.omnibox.onInputChanged.addListener") == 'function'
              and not page.evaluate("chrome.permissions.contains({permissions: ['tabs']})"),
              'service worker module loads with omnibox; tabs stays an optional permission')
        groups = page.evaluate('''async () => {
          const {openUrls} = await import('/common/utils.js');
          await openUrls(['about:blank#one', 'about:blank#two'], {group: 'Test group'});
          return (await chrome.tabGroups.query({title: 'Test group'})).length;
        }''')
        check(groups == 1, 'folders open as a named tab group')
        expect(page.get_by_text('Real API bookmark', exact=True)).to_be_visible()
        context.close()
    print('All checks passed.')
