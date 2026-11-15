/*
 * End-to-end tests: loads the real unpacked extension into Chromium and drives it.
 *  - Fixture pages are served at real https://www.youtube.com URLs (via request interception)
 *    so the content script injects exactly like it does on YouTube.
 *  - The final suite runs against the live youtube.com site.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// WB_EXTENSION_DIR lets the suite run against an unzipped release build.
const extensionPath = process.env.WB_EXTENSION_DIR ? path.resolve(process.env.WB_EXTENSION_DIR) : path.join(root, 'extension');
const fixture = (name) => readFileSync(path.join(root, 'tests', 'fixtures', name), 'utf8');
const LIVE = process.env.WB_SKIP_LIVE !== '1';

const FIXTURES = [
  [/^\/$/, 'home.html'],
  [/^\/watch$/, 'watch.html'],
  [/^\/results$/, 'search.html'],
  [/^\/feed\/subscriptions$/, 'subscriptions.html'],
  [/^\/feed\/history$/, 'history.html'],
  [/^\/@[^/]+(\/videos)?$/, 'channel.html'],
];

let context;
let userDataDir;
let worker;
let extensionId;
const extensionErrors = [];

async function routeFixtures(page) {
  await page.route('https://www.youtube.com/**', (route) => {
    const url = new URL(route.request().url());
    const hit = FIXTURES.find(([re]) => re.test(url.pathname));
    if (!hit || route.request().resourceType() !== 'document') {
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture(hit[1]) });
  });
  await page.route('https://example.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Elsewhere</title><p>Not YouTube</p>' })
  );
}

async function openFixture(urlPath) {
  const page = await context.newPage();
  page.on('pageerror', (err) => extensionErrors.push(`pageerror: ${err.message}`));
  await routeFixtures(page);
  await page.goto(`https://www.youtube.com${urlPath}`);
  await waitForScan(page);
  return page;
}

/** Wait until the content script is alive and has done its first scan. */
async function waitForScan(page) {
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-wb-ready'));
  await page.evaluate(() => document.documentElement.dispatchEvent(new Event('wb:scan-now')));
  await page.waitForTimeout(50);
}

const hiddenIds = (page) =>
  page.evaluate(() => [...document.querySelectorAll('[data-wb-hidden]')].map((e) => e.id).sort());

async function tabIdFor(page) {
  const url = page.url();
  return worker.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === u);
    return t ? t.id : null;
  }, url);
}

async function openPopup(forPage) {
  const tabId = await tabIdFor(forPage);
  const popup = await context.newPage();
  popup.on('pageerror', (err) => extensionErrors.push(`popup: ${err.message}`));
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html?tabId=${tabId}`);
  await popup.waitForSelector('body[data-ready="true"]');
  return popup;
}

const getSettings = () => worker.evaluate(async () => (await chrome.storage.sync.get('settings')).settings);
const resetSettings = () => worker.evaluate(async () => chrome.storage.sync.clear());
const badgeFor = async (page) => {
  const tabId = await tabIdFor(page);
  return worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
};

/** Poll the badge until it shows `expected` (the count is sent asynchronously). */
async function waitForBadge(page, expected, timeout = 5000) {
  const end = Date.now() + timeout;
  let text;
  while (Date.now() < end) {
    text = await badgeFor(page);
    if (text === expected) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  return text;
}

/**
 * WB_BROWSER=<path to brave.exe / msedge.exe / chrome.exe> runs the suite in that browser instead
 * of Playwright's bundled Chromium. Those browsers are started as a normal process, attached over
 * CDP, and the extension is loaded with Extensions.loadUnpacked.
 */
async function launchExternal(executable) {
  const proc = spawn(
    executable,
    [
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=en-US',
      '--window-size=1400,1000',
      ...(process.env.HEADED === '1' ? [] : ['--headless=new']),
      '--enable-unsafe-extension-debugging',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  // Load the extension through CDP. Brave quits a few seconds after start-up when an extension
  // is passed with --load-extension (even an empty one), so the flag can't be used there.
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  return { proc, browser, context: browser.contexts()[0] };
}

let externalProc;

before(async () => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'));
  if (process.env.WB_BROWSER) {
    const launched = await launchExternal(process.env.WB_BROWSER);
    externalProc = launched.proc;
    context = launched.context;
  } else {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: process.env.HEADED !== '1',
      locale: 'en-US',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
  }
  worker =
    context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ||
    (await context.waitForEvent('serviceworker', { predicate: (w) => w.url().startsWith('chrome-extension://') }));
  extensionId = new URL(worker.url()).host;
  worker.on('console', (msg) => {
    if (msg.type() === 'error') extensionErrors.push(`sw: ${msg.text()}`);
  });
});

after(async () => {
  if (externalProc) {
    await context?.browser()?.close().catch(() => {});
    externalProc.kill();
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    await context?.close();
  }
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

describe('extension loads', () => {
  test('service worker and manifest', async () => {
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.name, 'Watched Blocked');
    assert.equal(manifest.manifest_version, 3);
    assert.ok(extensionId.length > 10);
  });
});

describe('home feed (fixture)', () => {
  let page;
  before(async () => {
    await resetSettings();
    page = await openFixture('/');
  });
  after(() => page.close());

  test('hides every watched card and empty shelf, keeps unwatched ones', async () => {
    assert.deepEqual(await hiddenIds(page), [
      'home-classic-10', 'home-vm-30', 'home-vm-watched', 'home-ytw-40', 'shelf1-a', 'shelf1-b', 'shelf2-a',
    ]);
    assert.equal(await page.isVisible('#home-vm-watched'), false);
    assert.equal(await page.isVisible('#shelf-all-watched'), false);
    assert.equal(await page.isVisible('#shelf-mixed'), true);
    assert.equal(await page.isVisible('#home-vm-unwatched'), true);
    assert.equal(await page.isVisible('#home-ytw-recycled'), true);
  });

  test('toolbar badge shows the hidden count', async () => {
    assert.equal(await waitForBadge(page, '7'), '7');
  });

  test('popup shows the count and highlights the current section', async () => {
    const popup = await openPopup(page);
    await popup.waitForFunction(() => document.getElementById('status-count').textContent === '7');
    assert.match(await popup.textContent('#status-text'), /^hidden on this page$/);
    assert.equal(await popup.getAttribute('.row[data-section="home"]', 'class'), 'row is-current');
    // Defaults rendered in the popup.
    assert.equal(await popup.isChecked('#enabled'), true);
    assert.equal(await popup.isChecked('#section-subscriptions'), false);
    assert.equal(await popup.isChecked('#section-history'), false);
    assert.equal(await popup.isChecked('#section-home'), true);
    await popup.close();
  });

  test('master switch turns everything off and back on, live', async () => {
    const popup = await openPopup(page);
    await popup.click('label.switch--lg');
    await page.waitForFunction(() => document.querySelectorAll('[data-wb-hidden]').length === 0);
    assert.equal(await page.isVisible('#home-vm-watched'), true);
    assert.equal((await getSettings()).enabled, false);
    await popup.waitForFunction(() => document.getElementById('status-text').textContent.includes('Paused'));
    assert.equal(await waitForBadge(page, ''), '');

    await popup.click('label.switch--lg');
    await page.waitForFunction(() => document.querySelectorAll('[data-wb-hidden]').length === 7);
    assert.equal(await page.isVisible('#home-vm-watched'), false);
    await popup.close();
  });

  test('per-section toggle (home) turns hiding off only for that section', async () => {
    const popup = await openPopup(page);
    await popup.click('.row[data-section="home"] .row__label');
    await page.waitForFunction(() => document.querySelectorAll('[data-wb-hidden]').length === 0);
    const s = await getSettings();
    assert.equal(s.sections.home, false);
    assert.equal(s.sections.watch, true);
    await popup.waitForFunction(() => document.getElementById('status-text').textContent.includes('Off for Home'));
    await popup.click('.row[data-section="home"] .row__label');
    await page.waitForFunction(() => document.querySelectorAll('[data-wb-hidden]').length === 7);
    await popup.close();
  });

  test('threshold slider only hides videos watched past the chosen percent', async () => {
    const popup = await openPopup(page);
    await popup.$eval('#threshold', (el) => {
      el.value = '50';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await popup.textContent('#threshold-value'), '50%');
    await page.waitForFunction(() => document.querySelectorAll('[data-wb-hidden]').length === 4);
    assert.deepEqual(await hiddenIds(page), ['home-vm-watched', 'shelf1-a', 'shelf1-b', 'shelf2-a']);
    assert.equal(await page.isVisible('#home-vm-30'), true);
    // The slider goes all the way to 100%: only fully watched videos are hidden.
    assert.equal(await popup.getAttribute('#threshold', 'max'), '100');
    await popup.$eval('#threshold', (el) => {
      el.value = '100';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await popup.textContent('#threshold-value'), '100%');
    await page.waitForFunction(() => document.querySelectorAll('[data-wb-hidden]').length === 3);
    assert.deepEqual(await hiddenIds(page), ['home-vm-watched', 'shelf1-a', 'shelf2-a']);
    assert.equal((await getSettings()).threshold, 100);
    await popup.$eval('#threshold', (el) => {
      el.value = '0';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-wb-hidden]').length === 7);
    await popup.close();
  });

  test('dim mode fades watched videos instead of hiding them', async () => {
    const popup = await openPopup(page);
    await popup.click('.segmented label:has(input[value="dim"])');
    await page.waitForFunction(() => document.getElementById('home-vm-watched').getAttribute('data-wb-hidden') === 'dim');
    assert.equal(await page.isVisible('#home-vm-watched'), true);
    const opacity = await page.$eval('#home-vm-watched', (el) => getComputedStyle(el).opacity);
    assert.equal(opacity, '0.25');
    // Shelves are not collapsed in dim mode.
    assert.equal(await page.isVisible('#shelf-all-watched'), true);
    await popup.waitForFunction(() => document.getElementById('status-text').textContent.includes('dimmed'));
    await popup.click('.segmented label:has(input[value="hide"])');
    await page.waitForFunction(() => document.getElementById('home-vm-watched').getAttribute('data-wb-hidden') === 'hide');
    assert.equal(await page.isVisible('#shelf-all-watched'), false);
    await popup.close();
  });

  test('infinite scroll: newly added watched cards get hidden', async () => {
    await page.evaluate(() => {
      const grid = document.querySelector('ytd-rich-grid-renderer #contents');
      const tpl = document.getElementById('home-vm-watched').cloneNode(true);
      tpl.id = 'late-watched';
      tpl.removeAttribute('data-wb-hidden');
      grid.appendChild(tpl);
      const fresh = document.getElementById('home-vm-unwatched').cloneNode(true);
      fresh.id = 'late-unwatched';
      grid.appendChild(fresh);
    });
    await page.waitForFunction(() => document.getElementById('late-watched').getAttribute('data-wb-hidden') === 'hide');
    assert.equal(await page.isVisible('#late-unwatched'), true);
  });

  test('recycled cards: un-hides when YouTube reuses the element for an unwatched video', async () => {
    await page.evaluate(() => {
      document.querySelector('#late-watched .ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment').style.width = '0%';
    });
    await page.waitForFunction(() => !document.getElementById('late-watched').hasAttribute('data-wb-hidden'));
    assert.equal(await page.isVisible('#late-watched'), true);
    // And the other way round: an unwatched card gets a progress bar.
    await page.evaluate(() => {
      const host = document.querySelector('#home-ytw-recycled ytw-thumbnail-overlay-resume-playback-renderer');
      host.style.display = '';
      host.firstElementChild.style.width = '64%';
    });
    await page.waitForFunction(() => document.getElementById('home-ytw-recycled').getAttribute('data-wb-hidden') === 'hide');
  });

  test('in-app (SPA) navigation to Subscriptions updates the count', async () => {
    await page.evaluate(() => {
      document.querySelector('ytd-browse[page-subtype="home"]').setAttribute('hidden', '');
      document.querySelector('ytd-browse[page-subtype="subscriptions"]').removeAttribute('hidden');
      history.pushState({}, '', '/feed/subscriptions');
      window.dispatchEvent(new Event('yt-navigate-finish'));
    });
    await page.waitForTimeout(400);
    assert.equal(await page.isVisible('#stale-subs-watched'), true);
    assert.equal(await badgeFor(page), '');
  });
});

describe('release checks', () => {
  before(resetSettings);

  test('badge clears when the tab leaves YouTube', async () => {
    const page = await openFixture('/');
    assert.equal(await waitForBadge(page, '7'), '7');
    await page.goto('https://example.com/');
    assert.equal(await waitForBadge(page, ''), '');
    await page.close();
  });

  test('new watched cards are hidden before they are ever painted', async () => {
    const page = await openFixture('/');
    // Insert a watched card, then check on the very next animation frame (i.e. before paint).
    const paintedVisible = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const grid = document.querySelector('ytd-rich-grid-renderer #contents');
          const card = document.getElementById('home-vm-watched').cloneNode(true);
          card.id = 'flash-test';
          card.removeAttribute('data-wb-hidden');
          grid.appendChild(card);
          requestAnimationFrame(() => {
            // Runs after other rAF callbacks queued in this frame, just before paint.
            setTimeout(() => {}, 0);
            resolve(getComputedStyle(card).display !== 'none');
          });
        })
    );
    assert.equal(paintedVisible, false, 'watched card was painted visible before being hidden');
    await page.close();
  });

  test('performance: full scan of a 1,000-video page stays fast', async () => {
    const page = await openFixture('/');
    const timing = await page.evaluate(() => {
      const grid = document.querySelector('ytd-rich-grid-renderer #contents');
      const watched = document.getElementById('home-vm-watched');
      const unwatched = document.getElementById('home-vm-unwatched');
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 1000; i++) {
        const card = (i % 10 < 3 ? watched : unwatched).cloneNode(true);
        card.id = `perf-${i}`;
        card.removeAttribute('data-wb-hidden');
        frag.appendChild(card);
      }
      const t0 = performance.now();
      grid.appendChild(frag); // MutationObserver fast path runs as a microtask after this
      return new Promise((resolve) =>
        queueMicrotask(() =>
          queueMicrotask(() => {
            const insertMs = performance.now() - t0;
            const t1 = performance.now();
            document.documentElement.dispatchEvent(new Event('wb:scan-now'));
            const fullScanMs = performance.now() - t1;
            resolve({ insertMs, fullScanMs, hidden: document.querySelectorAll('[id^="perf-"][data-wb-hidden]').length });
          })
        )
      );
    });
    console.log(`    (1,000 cards: insert + fast path ${timing.insertMs.toFixed(1)}ms, full scan ${timing.fullScanMs.toFixed(1)}ms)`);
    assert.equal(timing.hidden, 300);
    assert.ok(timing.fullScanMs < 100, `full scan took ${timing.fullScanMs}ms`);
    await page.close();
  });

  test('popup works on a non-YouTube tab', async () => {
    const page = await context.newPage();
    await routeFixtures(page);
    await page.goto('https://example.com/');
    const popup = await openPopup(page);
    await popup.waitForFunction(() => document.getElementById('status-text').textContent.length > 0);
    assert.equal(await popup.textContent('#status-text'), 'Not on YouTube');
    assert.match(await popup.textContent('#version'), /^v1\.0$/);
    await popup.close();
    await page.close();
  });
});

describe('other pages (fixtures)', () => {
  before(resetSettings);

  test('watch page: sidebar + playlist queue, never the playing item or the player', async () => {
    const page = await openFixture('/watch?v=abc&list=PL1');
    assert.deepEqual(await hiddenIds(page), ['pl-watched', 'side-classic-watched', 'side-vm-watched']);
    assert.equal(await page.isVisible('#pl-selected'), true);
    assert.equal(await page.isVisible('#player-endscreen'), true);
    const popup = await openPopup(page);
    await popup.waitForFunction(() => document.getElementById('status-count').textContent === '3');
    assert.equal(await popup.getAttribute('.row[data-section="watch"]', 'class'), 'row is-current');
    await popup.close();
    await page.close();
  });

  test('search results', async () => {
    const page = await openFixture('/results?search_query=x');
    assert.deepEqual(await hiddenIds(page), ['grid-watched', 'search-watched']);
    // The shelf only had one (watched) video, so it collapses.
    assert.equal(await page.isVisible('#search-shelf'), false);
    await page.close();
  });

  test('subscriptions feed is untouched by default', async () => {
    const page = await openFixture('/feed/subscriptions');
    assert.deepEqual(await hiddenIds(page), []);
    assert.equal(await page.isVisible('#subs-watched'), true);
    await page.close();
  });

  test('watch history is untouched by default', async () => {
    const page = await openFixture('/feed/history');
    assert.deepEqual(await hiddenIds(page), []);
    await page.close();
  });

  test('channel pages are untouched by default; the Channels switch turns hiding on', async () => {
    const page = await openFixture('/@SomeChannel/videos');
    assert.deepEqual(await hiddenIds(page), []);
    assert.equal(await page.isVisible('#chan-watched'), true);
    const popup = await openPopup(page);
    await popup.waitForFunction(() => document.getElementById('status-text').textContent === 'Off for Channels');
    assert.equal(await popup.isChecked('#section-channels'), false);
    await popup.click('.row[data-section="channels"] .row__label');
    await page.waitForFunction(() => document.getElementById('chan-watched').getAttribute('data-wb-hidden') === 'hide');
    assert.equal(await page.isVisible('#chan-unwatched'), true);
    await popup.close();
    await page.close();
    await resetSettings();
  });

  test('turning on subscriptions in the popup applies to the open tab', async () => {
    const page = await openFixture('/feed/subscriptions');
    const popup = await openPopup(page);
    await popup.click('.row[data-section="subscriptions"] .row__label');
    await page.waitForFunction(() => document.getElementById('subs-watched').getAttribute('data-wb-hidden') === 'hide');
    await popup.close();
    await page.close();
    await resetSettings();
  });
});

describe('settings storage & sync', () => {
  before(resetSettings);

  test('settings are written to chrome.storage.sync (browser-account sync)', async () => {
    const page = await openFixture('/');
    const popup = await openPopup(page);
    await popup.click('.row[data-section="search"] .row__label');
    await popup.waitForTimeout(200);
    const synced = await worker.evaluate(async () => (await chrome.storage.sync.get('settings')).settings);
    assert.equal(synced.sections.search, false);
    const local = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert.equal(local, undefined, 'should not be stored only locally');
    await popup.close();
    await page.close();
  });

  test('a change arriving from another synced browser applies live to open tabs and popup', async () => {
    const page = await openFixture('/');
    const popup = await openPopup(page);
    // Simulate Chrome Sync delivering new settings written by another browser.
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...settings, enabled: false } });
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-wb-hidden]').length === 0);
    await popup.waitForFunction(() => !document.getElementById('enabled').checked);
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...settings, enabled: true } });
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-wb-hidden]').length === 7);
    await popup.waitForFunction(() => document.getElementById('enabled').checked);
    await popup.close();
    await page.close();
  });

  test('keyboard-shortcut handler toggles the setting', async () => {
    await resetSettings();
    // chrome.commands can't be pressed in automation; run the same update the handler runs.
    await worker.evaluate(() => self.WBSettings.update((s) => ({ ...s, enabled: !s.enabled })));
    assert.equal((await getSettings()).enabled, false);
    await worker.evaluate(() => self.WBSettings.update((s) => ({ ...s, enabled: !s.enabled })));
    assert.equal((await getSettings()).enabled, true);
  });
});

describe('live youtube.com', { skip: !LIVE && 'WB_SKIP_LIVE=1' }, () => {
  let page;
  before(async () => {
    await resetSettings();
    page = await context.newPage();
    page.on('pageerror', (err) => extensionErrors.push(`live pageerror: ${err.message}`));
    await context.addCookies([{ name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' }]);
  });
  after(() => page.close());

  test('content script runs on the real watch page and leaves unwatched videos alone', async () => {
    await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-wb-instance'));
    await page.waitForSelector('#secondary yt-lockup-view-model, #secondary ytd-compact-video-renderer', { timeout: 30000 });
    await page.waitForTimeout(1500);
    // Logged out: YouTube shows no watch progress, so nothing should be hidden.
    assert.deepEqual(await hiddenIds(page), []);
  });

  test('a watched bar on a real sidebar card hides that card', async () => {
    const id = await page.evaluate(() => {
      const card = document.querySelector('#secondary yt-lockup-view-model');
      card.id = 'wb-live-target';
      const thumb = card.querySelector('yt-thumbnail-view-model');
      const bar = document.createElement('yt-thumbnail-overlay-progress-bar-view-model');
      bar.className = 'ytThumbnailOverlayProgressBarHost';
      // youtube.com enforces Trusted Types, so build the nodes instead of using innerHTML.
      const track = document.createElement('div');
      track.className = 'ytThumbnailOverlayProgressBarHostWatchedProgressBar';
      const segment = document.createElement('div');
      segment.className = 'ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment';
      segment.style.width = '100%';
      track.appendChild(segment);
      bar.appendChild(track);
      thumb.appendChild(bar);
      return card.id;
    });
    await page.waitForFunction((i) => document.getElementById(i).getAttribute('data-wb-hidden') === 'hide', id, { timeout: 5000 });
    assert.equal(await page.isVisible(`#${id}`), false);
    // Other sidebar cards stay.
    const visible = await page.$$eval('#secondary yt-lockup-view-model', (els) => els.filter((e) => e.offsetParent !== null).length);
    assert.ok(visible > 0);
  });

  test('real search results: a watched bar hides the result (either search layout)', async () => {
    await page.goto('https://www.youtube.com/results?search_query=lofi+hip+hop', { waitUntil: 'domcontentloaded' });
    // YouTube A/B-tests two search layouts: classic ytd-video-renderer (with a hidden ytw resume
    // overlay already in place) and yt-lockup-view-model cards. Exercise whichever one we get.
    await page.waitForSelector(
      'ytd-video-renderer ytw-thumbnail-overlay-resume-playback-renderer, ytd-search yt-lockup-view-model yt-thumbnail-view-model',
      { state: 'attached', timeout: 30000 }
    );
    await page.waitForTimeout(1000);
    assert.deepEqual(await hiddenIds(page), []);
    const layout = await page.evaluate(() => {
      const host = document.querySelector('ytd-video-renderer ytw-thumbnail-overlay-resume-playback-renderer');
      if (host) {
        host.closest('ytd-video-renderer').id = 'wb-live-search';
        host.style.display = '';
        host.firstElementChild.style.width = '73%';
        return 'classic';
      }
      const card = document.querySelector('ytd-search yt-lockup-view-model');
      const target = card.closest('ytd-video-renderer, ytd-rich-item-renderer') || card;
      target.id = 'wb-live-search';
      const bar = document.createElement('yt-thumbnail-overlay-progress-bar-view-model');
      const track = document.createElement('div');
      const segment = document.createElement('div');
      segment.className = 'ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment';
      segment.style.width = '73%';
      track.appendChild(segment);
      bar.appendChild(track);
      card.querySelector('yt-thumbnail-view-model').appendChild(bar);
      return 'lockup';
    });
    await page.waitForFunction(() => document.getElementById('wb-live-search').getAttribute('data-wb-hidden') === 'hide', null, { timeout: 5000 });
    console.log(`    (live search layout: ${layout})`);
  });
});

describe('no errors', () => {
  test('extension produced no uncaught errors', () => {
    const ours = extensionErrors.filter((e) => /wb|Watched Blocked|detect\.js|content\.js|popup|sw:/.test(e));
    assert.deepEqual(ours, []);
  });
});
