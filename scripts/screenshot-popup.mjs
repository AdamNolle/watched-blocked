// Captures assets/popup-light.png and assets/popup-dark.png for the README.
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-shot-'));
const ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chromium',
  headless: true,
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const id = new URL(sw.url()).host;
const yt = await ctx.newPage();
await yt.route('https://www.youtube.com/**', (r) =>
  r.request().resourceType() === 'document'
    ? r.fulfill({ contentType: 'text/html', body: readFileSync(path.join(root, 'tests/fixtures/home.html'), 'utf8') })
    : r.fulfill({ status: 204, body: '' })
);
await yt.goto('https://www.youtube.com/');
await yt.waitForTimeout(500);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);
for (const scheme of ['light', 'dark']) {
  const p = await ctx.newPage();
  await p.emulateMedia({ colorScheme: scheme });
  await p.setViewportSize({ width: 340, height: 700 });
  await p.goto(`chrome-extension://${id}/popup/popup.html?tabId=${tabId}`);
  await p.waitForFunction(() => document.getElementById('status-count').textContent === '7');
  await p.locator('body').screenshot({ path: path.join(root, 'assets', `popup-${scheme}.png`) });
  await p.close();
}
await ctx.close();
rmSync(dir, { recursive: true, force: true });
console.log('done');
