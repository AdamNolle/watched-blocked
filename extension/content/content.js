/*
 * Content script.
 * Watches the YouTube DOM and flags watched video cards so content.css can hide or dim them.
 */
(function () {
  'use strict';

  const Detect = globalThis.WBDetect;
  const { computeHidden, emptyShelves, isOnActivePage, sectionFromUrl, PROGRESS_SELECTOR } = Detect;
  const Settings = globalThis.WBSettings;

  const ITEM_ATTR = 'data-wb-hidden';
  const SHELF_ATTR = 'data-wb-shelf-hidden';
  // Full pass (shelves, cleanup, badge count) runs this long after the page stops changing.
  const SCAN_DELAY_MS = 150;
  // Attribute changes inside these can turn a progress bar on or off.
  const THUMB_SELECTOR =
    'ytd-thumbnail, yt-thumbnail-view-model, ytw-thumbnail-overlay-resume-playback-renderer, ytd-thumbnail-overlay-resume-playback-renderer';
  const PLAYER_SELECTOR = '.html5-video-player';

  // If the extension was reloaded/updated, a fresh copy gets injected. Retire the old one.
  const instanceId = Math.random().toString(36).slice(2);
  document.documentElement.setAttribute('data-wb-instance', instanceId);

  let settings = Settings.normalize(null);
  let settingsLoaded = false;
  let hiddenItems = new Set();
  let hiddenShelves = new Set();
  let lastReportedCount = -1;
  let scanTimer = 0;
  let observer = null;
  let stopped = false;
  let unsubscribe = () => {};

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id) &&
        document.documentElement.getAttribute('data-wb-instance') === instanceId;
    } catch (_) {
      return false;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (observer) observer.disconnect();
    clearTimeout(scanTimer);
    unsubscribe();
    window.removeEventListener('yt-navigate-finish', scheduleScan, true);
    window.removeEventListener('yt-page-data-updated', scheduleScan, true);
    window.removeEventListener('popstate', scheduleScan, true);
  }

  function scan() {
    scanTimer = 0;
    if (stopped) return;
    if (!extensionAlive()) {
      stop();
      return;
    }
    if (!settingsLoaded) return;

    const mode = settings.mode === 'dim' ? 'dim' : 'hide';
    const nextItems = computeHidden(document, location.href, settings);
    const nextShelves = mode === 'hide' ? emptyShelves(nextItems) : new Set();

    for (const el of hiddenItems) if (!nextItems.has(el)) el.removeAttribute(ITEM_ATTR);
    for (const el of nextItems) if (el.getAttribute(ITEM_ATTR) !== mode) el.setAttribute(ITEM_ATTR, mode);
    for (const el of hiddenShelves) if (!nextShelves.has(el)) el.removeAttribute(SHELF_ATTR);
    for (const el of nextShelves) if (!el.hasAttribute(SHELF_ATTR)) el.setAttribute(SHELF_ATTR, '');

    // Recycled elements YouTube moved around may still carry our attribute; clean them up.
    for (const el of document.querySelectorAll(`[${ITEM_ATTR}]`)) {
      if (!nextItems.has(el)) el.removeAttribute(ITEM_ATTR);
    }
    for (const el of document.querySelectorAll(`[${SHELF_ATTR}]`)) {
      if (!nextShelves.has(el)) el.removeAttribute(SHELF_ATTR);
    }

    hiddenItems = nextItems;
    hiddenShelves = nextShelves;
    reportCount();
  }

  function visibleCount() {
    let n = 0;
    for (const el of hiddenItems) if (el.isConnected && isOnActivePage(el)) n++;
    return n;
  }

  function reportCount() {
    const count = visibleCount();
    if (count === lastReportedCount) return;
    lastReportedCount = count;
    try {
      chrome.runtime.sendMessage({ type: 'wb:count', count }, () => void chrome.runtime.lastError);
    } catch (_) {
      stop();
    }
  }

  function scheduleScan() {
    if (stopped || scanTimer) return;
    scanTimer = setTimeout(scan, SCAN_DELAY_MS);
  }

  function isPlayerNode(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return Boolean(el && el.closest && el.closest(PLAYER_SELECTOR));
  }

  /**
   * Fast path: check only the cards touched by these mutations. MutationObserver callbacks run
   * before the browser paints, so new watched videos are hidden before they are ever shown.
   */
  function quickCheck(records) {
    const cards = new Set();
    const addCard = (bar) => {
      if (bar.closest(PLAYER_SELECTOR)) return;
      const card = Detect.outermostItem(bar);
      if (card) cards.add(card);
    };
    for (const r of records) {
      if (r.type === 'childList') {
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches(PROGRESS_SELECTOR)) addCard(node);
          else if (node.firstElementChild) node.querySelectorAll(PROGRESS_SELECTOR).forEach(addCard);
        }
      } else if (r.type === 'attributes' && r.attributeName !== ITEM_ATTR && r.attributeName !== SHELF_ATTR) {
        const t = r.target;
        if (t.matches(PROGRESS_SELECTOR)) addCard(t);
        else if (t.closest(THUMB_SELECTOR)) t.querySelectorAll(PROGRESS_SELECTOR).forEach(addCard);
      }
    }
    if (cards.size === 0) return;
    const mode = settings.mode === 'dim' ? 'dim' : 'hide';
    for (const card of cards) {
      const info = Detect.findWatched(card, location.href).get(card);
      if (info && Detect.shouldHide(card, info, settings)) {
        if (card.getAttribute(ITEM_ATTR) !== mode) card.setAttribute(ITEM_ATTR, mode);
        hiddenItems.add(card);
      } else if (card.hasAttribute(ITEM_ATTR)) {
        card.removeAttribute(ITEM_ATTR);
        hiddenItems.delete(card);
      }
    }
  }

  function onMutations(records) {
    if (stopped) return;
    let relevant = false;
    const pageRecords = [];
    for (const r of records) {
      // The player updates its own progress bar many times a second; ignore it.
      if (isPlayerNode(r.target)) continue;
      // Ignore our own attribute writes.
      if (r.type === 'attributes' && (r.attributeName === ITEM_ATTR || r.attributeName === SHELF_ATTR)) continue;
      relevant = true;
      pageRecords.push(r);
    }
    if (!relevant) return;
    if (settingsLoaded && extensionAlive()) quickCheck(pageRecords);
    scheduleScan();
  }

  function startObserver() {
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'hidden', 'selected', 'page-subtype', 'class'],
    });
    window.addEventListener('yt-navigate-finish', scheduleScan, true);
    window.addEventListener('yt-page-data-updated', scheduleScan, true);
    window.addEventListener('popstate', scheduleScan, true);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (stopped || !msg || msg.type !== 'wb:status') return undefined;
    if (!extensionAlive()) {
      // A newer copy of this script took over (extension updated); let it answer.
      stop();
      return undefined;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scan();
    }
    const section = sectionFromUrl(location.href);
    sendResponse({
      count: visibleCount(),
      section,
      sectionEnabled: Boolean(settings.sections[section]),
      enabled: settings.enabled,
    });
    return undefined;
  });

  unsubscribe = Settings.onChange((next) => {
    settings = next;
    settingsLoaded = true;
    clearTimeout(scanTimer);
    scan();
  });

  startObserver();
  Settings.load().then((loaded) => {
    settings = loaded;
    settingsLoaded = true;
    scan();
    // Signals that settings are loaded and the first pass is done (used by the tests).
    document.documentElement.setAttribute('data-wb-ready', '');
  });

  // Test hook: lets the e2e suite force a synchronous scan.
  document.documentElement.addEventListener('wb:scan-now', () => {
    clearTimeout(scanTimer);
    scan();
  });
})();
