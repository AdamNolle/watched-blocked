import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const detectSrc = read('extension/content/detect.js');
const settingsSrc = read('extension/shared/settings.js');

function load(fixture, url) {
  const dom = new JSDOM(read(`tests/fixtures/${fixture}`), { url, runScripts: 'outside-only' });
  dom.window.eval(settingsSrc);
  dom.window.eval(detectSrc);
  return dom.window;
}

function hiddenIds(win, overrides = {}) {
  const settings = win.WBSettings.normalize({ ...overrides });
  const hidden = win.WBDetect.computeHidden(win.document, win.location.href, settings);
  return new Set([...hidden].map((el) => el.id));
}

describe('settings', () => {
  const win = load('home.html', 'https://www.youtube.com/');
  const S = win.WBSettings;

  test('defaults: on, everything except channels, subscriptions & history', () => {
    const s = S.normalize(null);
    assert.equal(s.enabled, true);
    assert.equal(s.threshold, 0);
    assert.equal(s.mode, 'hide');
    for (const id of ['home', 'watch', 'search', 'playlists', 'other']) assert.equal(s.sections[id], true, id);
    assert.equal(s.sections.channels, false);
    assert.equal(s.sections.subscriptions, false);
    assert.equal(s.sections.history, false);
  });

  test('normalize keeps valid values and repairs bad ones', () => {
    const s = S.normalize({ enabled: false, threshold: 250, mode: 'weird', sections: { home: false, watch: 'yes' } });
    assert.equal(s.enabled, false);
    assert.equal(s.threshold, 100);
    assert.equal(s.mode, 'hide');
    assert.equal(s.sections.home, false);
    assert.equal(s.sections.watch, true);
    assert.equal(S.normalize({ threshold: -5 }).threshold, 0);
    assert.equal(S.normalize({ threshold: 'abc' }).threshold, 0);
    assert.equal(S.normalize({ mode: 'dim' }).mode, 'dim');
  });

  test('every section has a default', () => {
    for (const { id } of S.SECTIONS) assert.equal(typeof S.DEFAULTS.sections[id], 'boolean', id);
  });
});

describe('sectionFromUrl', () => {
  const win = load('home.html', 'https://www.youtube.com/');
  const f = win.WBDetect.sectionFromUrl;
  const cases = {
    'https://www.youtube.com/': 'home',
    'https://www.youtube.com/?bp=abc': 'home',
    'https://www.youtube.com/watch?v=abc&list=PL1': 'watch',
    'https://www.youtube.com/results?search_query=cats': 'search',
    'https://www.youtube.com/feed/subscriptions': 'subscriptions',
    'https://www.youtube.com/feed/history': 'history',
    'https://www.youtube.com/feed/history/search_history': 'history',
    'https://www.youtube.com/feed/you': 'history',
    'https://www.youtube.com/playlist?list=WL': 'playlists',
    'https://www.youtube.com/@MrBeast': 'channels',
    'https://www.youtube.com/@MrBeast/videos': 'channels',
    'https://www.youtube.com/channel/UC123/featured': 'channels',
    'https://www.youtube.com/c/Name': 'channels',
    'https://www.youtube.com/user/Name/videos': 'channels',
    'https://www.youtube.com/feed/trending': 'other',
    'https://www.youtube.com/gaming': 'other',
    'not a url at all': 'other',
  };
  for (const [url, expected] of Object.entries(cases)) {
    test(`${url} → ${expected}`, () => assert.equal(f(url), expected));
  }
});

describe('home page', () => {
  const win = load('home.html', 'https://www.youtube.com/');

  test('hides watched cards across all three markup generations', () => {
    const ids = hiddenIds(win);
    for (const id of ['home-vm-watched', 'home-vm-30', 'home-ytw-40', 'home-classic-10', 'shelf1-a', 'shelf1-b', 'shelf2-a']) {
      assert.ok(ids.has(id), `${id} should be hidden`);
    }
  });

  test('keeps unwatched and recycled (display:none, 0%) cards', () => {
    const ids = hiddenIds(win);
    for (const id of ['home-vm-unwatched', 'home-ytw-recycled', 'shelf2-b']) assert.ok(!ids.has(id), `${id} should stay`);
  });

  test('hides the outer ytd-rich-item-renderer, not the inner lockup', () => {
    const ids = hiddenIds(win);
    assert.ok(!ids.has('home-vm-watched-lockup'));
  });

  test('cached hidden subscriptions page keeps its own section rules', () => {
    assert.ok(!hiddenIds(win).has('stale-subs-watched'));
    assert.ok(hiddenIds(win, { sections: { subscriptions: true } }).has('stale-subs-watched'));
  });

  test('threshold filters partially watched videos', () => {
    const ids = hiddenIds(win, { threshold: 35 });
    assert.ok(ids.has('home-vm-watched'));
    assert.ok(ids.has('home-ytw-40'));
    assert.ok(!ids.has('home-vm-30'));
    assert.ok(!ids.has('home-classic-10'));
    const ids90 = hiddenIds(win, { threshold: 90 });
    assert.deepEqual([...ids90].sort(), ['home-vm-watched', 'shelf1-a', 'shelf2-a'].sort());
  });

  test('master switch off hides nothing', () => {
    assert.equal(hiddenIds(win, { enabled: false }).size, 0);
  });

  test('home section off hides nothing on home', () => {
    const ids = hiddenIds(win, { sections: { home: false } });
    assert.equal(ids.size, 0);
  });

  test('shelves are hidden only when every card in them is hidden', () => {
    const settings = win.WBSettings.normalize(null);
    const hidden = win.WBDetect.computeHidden(win.document, win.location.href, settings);
    const shelves = [...win.WBDetect.emptyShelves(hidden)].map((el) => el.id);
    assert.deepEqual(shelves, ['shelf-all-watched']);
  });

  test('isOnActivePage ignores cards in hidden (cached) pages', () => {
    const d = win.WBDetect;
    assert.equal(d.isOnActivePage(win.document.getElementById('home-vm-watched')), true);
    assert.equal(d.isOnActivePage(win.document.getElementById('stale-subs-watched')), false);
  });
});

describe('watch page', () => {
  const win = load('watch.html', 'https://www.youtube.com/watch?v=abc&list=PL1');

  test('hides watched sidebar videos (view-model and classic)', () => {
    const ids = hiddenIds(win);
    assert.ok(ids.has('side-vm-watched'));
    assert.ok(ids.has('side-classic-watched'));
    assert.ok(!ids.has('side-vm-unwatched'));
  });

  test('playlist queue: hides watched, never the currently playing item', () => {
    const ids = hiddenIds(win);
    assert.ok(ids.has('pl-watched'));
    assert.ok(!ids.has('pl-selected'));
    assert.ok(!ids.has('pl-unwatched'));
  });

  test('playlist queue follows the playlists toggle, sidebar follows the watch toggle', () => {
    const noPl = hiddenIds(win, { sections: { playlists: false } });
    assert.ok(!noPl.has('pl-watched'));
    assert.ok(noPl.has('side-vm-watched'));
    const noWatch = hiddenIds(win, { sections: { watch: false } });
    assert.ok(noWatch.has('pl-watched'));
    assert.ok(!noWatch.has('side-vm-watched'));
  });

  test('never touches anything inside the video player', () => {
    assert.ok(!hiddenIds(win).has('player-endscreen'));
  });
});

describe('search page', () => {
  const win = load('search.html', 'https://www.youtube.com/results?search_query=x');

  test('hides watched results and shelf items', () => {
    const ids = hiddenIds(win);
    assert.ok(ids.has('search-watched'));
    assert.ok(ids.has('grid-watched'));
    assert.ok(!ids.has('search-unwatched'));
  });

  test('search toggle off', () => {
    assert.equal(hiddenIds(win, { sections: { search: false } }).size, 0);
  });
});

describe('excluded by default', () => {
  test('subscriptions feed is left alone by default', () => {
    const win = load('subscriptions.html', 'https://www.youtube.com/feed/subscriptions');
    assert.equal(hiddenIds(win).size, 0);
    assert.ok(hiddenIds(win, { sections: { subscriptions: true } }).has('subs-watched'));
  });

  test('channel pages are left alone by default', () => {
    const win = load('channel.html', 'https://www.youtube.com/@SomeChannel/videos');
    assert.equal(hiddenIds(win).size, 0);
    const opted = hiddenIds(win, { sections: { channels: true } });
    assert.ok(opted.has('chan-watched'));
    assert.ok(!opted.has('chan-unwatched'));
  });

  test('watch history is left alone by default', () => {
    const win = load('history.html', 'https://www.youtube.com/feed/history');
    assert.equal(hiddenIds(win).size, 0);
    const opted = hiddenIds(win, { sections: { history: true } });
    assert.ok(opted.has('hist-ytw'));
    assert.ok(opted.has('hist-vm'));
  });
});

describe('progressPercent', () => {
  const win = load('home.html', 'https://www.youtube.com/');
  const pct = win.WBDetect.progressPercent;
  const bar = (style) => {
    const el = win.document.createElement('div');
    el.setAttribute('style', style);
    return el;
  };
  test('parses percentages', () => {
    assert.equal(pct(bar('width: 42%')), 42);
    assert.equal(pct(bar('width: 12.5%;')), 12.5);
    assert.equal(pct(bar('width: 0%')), 0);
    assert.equal(pct(bar('width: 140%')), 100);
  });
  test('bar without an inline width counts as watched', () => {
    assert.equal(pct(bar('')), 100);
  });
});
