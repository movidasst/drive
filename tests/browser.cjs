// Run with PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE when using a managed runtime.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const fixturePath = process.env.CATALOG_FIXTURE;
if (!fixturePath) throw new Error('CATALOG_FIXTURE must point to a captured catalog, outside the repository.');
const catalog = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
catalog.refreshing = false;
const output = process.env.QA_OUTPUT || path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html'); res.end(fs.readFileSync(file)); } catch { res.writeHead(404).end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const errors = [];
  try {
    for (const width of [360, 390, 768, 1440]) {
      browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--disable-gpu'] });
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      let rejectSession = false; let memberScope = 'test-member'; let mockAdded = false;
      const actions = [];
      await page.route('https://lfdmbkzghnwvsapxypvt.supabase.co/functions/v1/drive-api', async route => {
        const request = route.request(); const input = request.postDataJSON(); actions.push(input.action);
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
        if (input.action === 'catalog') return route.fulfill({ status: 200, headers, body: JSON.stringify(mockAdded ? { ...catalog, items: catalog.items.map((file,index) => index === catalog.items.findIndex(f => f.mimeType === 'application/pdf') ? { ...file, addedAt: new Date().toISOString() } : file) } : catalog) });
        if (rejectSession && input.action === 'session') return route.fulfill({ status: 401, headers, body: JSON.stringify({ message: 'Sesión inválida' }) });
        return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, token: 'a'.repeat(64), name: 'Integrante de prueba', favoritesScope: memberScope, expiresAt: Date.now() + 7200000 }) });
      });
      await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
      await page.route('https://lh3.googleusercontent.com/**', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#007b85"/><text x="20" y="25" text-anchor="middle" fill="white" font-size="12">SST+</text></svg>' }));
      await page.route('https://drive.google.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Vista previa de prueba</p>' }));
      await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.testCopiedLink = text; } } }); Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); });
      await page.goto(base);
      await page.locator('#login-cedula').fill('12345678'); await page.locator('#login-code').fill('TEST'); await page.locator('#login-button').click();
      await page.waitForFunction(() => document.getElementById('home-file-count').textContent === '753');
      assert.equal(await page.locator('#home-folder-count').textContent(), '53');
      assert.equal(await page.locator('#folder-container > article').count(), 47);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}`);
      for (const control of await page.locator('.collection-tab, #type-filter, #toggle-full-names').all()) { const box = await control.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width, `Control cut off at ${width}`); }
      assert.equal(await page.locator('#recent-mode-control').isVisible(), false);
      await page.screenshot({ path: path.join(output, `inicio-default-${width}.png`), fullPage: false });
      await page.locator('#folder-container > article').filter({ hasText: 'GRUPO DE ESTUDIO' }).locator('.share-folder').click();
      assert.match(await page.evaluate(() => window.testCopiedLink), /^https:\/\/drive\.movidasst\.com\/#folder=/);
      // Folder totals include every nested level.
      assert.match(await page.locator('#folder-container > article').filter({ hasText: 'GRUPO DE ESTUDIO' }).textContent(), /462 archivos en total/);
      await page.locator('#folder-container > article').filter({ hasText: 'GRUPO DE ESTUDIO' }).locator('.favorite-button').click();
      await page.locator('[data-collection="favorites"]').click();
      assert.equal(await page.locator('#folder-container > article').count(), 1);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('home-file-count').textContent === '753');
      await page.locator('[data-collection="favorites"]').click();
      assert.equal(await page.locator('#folder-container > article').count(), 1, 'Favorites must survive reload');
      await page.locator('[data-collection="recent"]').click();
      assert.ok(await page.locator('#file-container > article').count() > 0);
      await page.locator('#recent-mode').selectOption('added');
      assert.equal(await page.locator('#empty-title').textContent(), 'Aquí aparecerán las nuevas incorporaciones');
      mockAdded = true; await page.locator('#refresh-catalog').click();
      await page.waitForFunction(() => document.getElementById('file-container').textContent.includes('Incorporado'));
      assert.equal(await page.locator('#file-container > article').count(), 1);
      mockAdded = false;
      await page.locator('[data-collection="browse"]').click();
      await page.locator('#toggle-full-names').click();
      assert.ok(await page.locator('#folder-container .full-resource-name').count() > 0);

      await page.screenshot({ path: path.join(output, `inicio-${width}.png`), fullPage: false });
      await page.locator('#search-input').fill('covenin');
      await page.waitForTimeout(200);
      assert.ok(await page.locator('#file-container > article').count() > 0, 'Global search must find nested documents');
      assert.match(await page.locator('#results-status').textContent(), /toda la biblioteca/);
      assert.match(await page.locator('#file-container').textContent(), /Inicio \//);
      await page.locator('#search-scope').selectOption('current');
      assert.match(await page.locator('#results-status').textContent(), /esta carpeta/);
      await page.locator('#clear-search').click();
      await page.locator('#search-scope').selectOption('all');
      await page.locator('#folder-container > article').filter({ hasText: 'GRUPO DE ESTUDIO' }).locator('.folder-open').click();
      await page.locator('#folder-container > article').filter({ hasText: 'Estudio Norma MMC' }).locator('.folder-open').click();
      assert.equal(await page.locator('#current-item-count').textContent(), '461');
      assert.equal(await page.locator('#home-hero').isVisible(), false);
      assert.equal(await page.locator('#file-container > article').count(), 60);
      await page.locator('#load-more').click();
      assert.equal(await page.locator('#file-container > article').count(), 120);
      const deepUrl = page.url(); await page.reload();
      await page.waitForFunction(() => document.getElementById('current-item-count').textContent === '461');
      assert.equal(page.url(), deepUrl);
      await page.locator('#type-filter').selectOption('pdf');
      await page.locator('#file-container button').filter({ hasText: /^Abrir$/ }).first().click();
      await page.waitForTimeout(50);
      assert.equal(await page.locator('#preview-modal').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#preview-modal').isVisible(), false);
      await page.locator('#back-folder-button').click();
      assert.equal(await page.locator('#current-folder-title').textContent(), 'GRUPO DE ESTUDIO');
      await page.locator('#profile-button').click(); await page.locator('#logout-button').click();
      assert.ok(actions.includes('logout'));
      assert.equal(await page.locator('#auth-screen').isVisible(), true);
      assert.equal(await page.locator('#file-container > article').count(), 0);
      // A locally forged storage record must be rejected by the server validation.
      await page.evaluate(() => sessionStorage.setItem('movida_drive_session_v2', JSON.stringify({ token: 'f'.repeat(64), name: 'Forged', expiresAt: Date.now() + 7200000 })));
      rejectSession = true; await page.reload();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#auth-screen').isVisible(), true);
      rejectSession = false; memberScope = 'second-member'; await page.locator('#login-cedula').fill('87654321'); await page.locator('#login-code').fill('TEST'); await page.locator('#login-button').click();
      await page.waitForFunction(() => document.getElementById('home-file-count').textContent === '753');
      await page.locator('[data-collection="favorites"]').click(); assert.equal(await page.locator('#favorites-count').textContent(), '0', 'Favorites cannot leak to another account');
      await browser.close(); browser = null;
      console.log(`UI passed: ${width}px, favorites, recursive folder counts, recent modes, full names, global search, pagination, deep link, preview, logout`);
    }
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
