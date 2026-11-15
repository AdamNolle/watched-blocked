/*
 * Finds watched video cards in the page.
 * Pure DOM functions with no chrome.* dependencies so they can be unit tested.
 */
(function (global) {
  'use strict';

  /**
   * Elements that render the red "you watched this much" bar on a thumbnail.
   * YouTube ships several generations of markup at once, so we match all of them.
   */
  const PROGRESS_SELECTOR = [
    // Classic Polymer thumbnails (ytd-thumbnail).
    'ytd-thumbnail-overlay-resume-playback-renderer #progress',
    // Wiz-style overlay used inside ytd-thumbnail (2025+).
    '.ytwThumbnailOverlayResumePlaybackRendererThumbnailOverlayResumePlaybackProgress',
    // View-model thumbnails used by yt-lockup-view-model (2025+).
    '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment',
    // Defensive catch-alls for renamed variants of the above.
    'yt-thumbnail-overlay-progress-bar-view-model [class*="WatchedProgressBarSegment"]',
    '[class*="ResumePlaybackProgress"]',
  ].join(',');

  /** Video cards we can hide. */
  const ITEM_TAGS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-reel-item-renderer',
    'ytd-movie-renderer',
    'ytd-compact-movie-renderer',
    'ytd-video-with-context-renderer',
    'ytm-shorts-lockup-view-model-v2',
    'ytm-shorts-lockup-view-model',
    'yt-lockup-view-model',
  ];
  const ITEM_SELECTOR = ITEM_TAGS.join(',');

  /** Containers that become empty boxes once every video inside is hidden. */
  const SHELF_SELECTOR = [
    'ytd-rich-section-renderer',
    'ytd-shelf-renderer',
    'ytd-reel-shelf-renderer',
  ].join(',');

  /** Never touch anything inside the video player itself. */
  const PLAYER_SELECTOR = '.html5-video-player, #movie_player';

  /** ytd-browse page-subtype → section id. */
  const BROWSE_SUBTYPES = {
    home: 'home',
    subscriptions: 'subscriptions',
    history: 'history',
    you: 'history',
    library: 'history',
    playlist: 'playlists',
    channels: 'channels',
    trending: 'other',
    explore: 'other',
  };

  /** Determine a section id from a URL (fallback when the DOM doesn't tell us). */
  function sectionFromUrl(href) {
    let url;
    try {
      url = new URL(href, 'https://www.youtube.com/');
    } catch (_) {
      return 'other';
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || path === '/feed/recommended') return 'home';
    if (path === '/watch') return 'watch';
    if (path === '/results') return 'search';
    if (path === '/feed/subscriptions' || path.startsWith('/feed/subscriptions/')) return 'subscriptions';
    if (path === '/feed/history' || path.startsWith('/feed/history/')) return 'history';
    if (path === '/feed/you' || path === '/feed/library') return 'history';
    if (path === '/playlist' || path === '/feed/playlists') return 'playlists';
    if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/|$)/.test(path)) return 'channels';
    return 'other';
  }

  /** Determine which section a video card belongs to. */
  function sectionForElement(el, href) {
    if (el.closest('ytd-playlist-panel-renderer')) return 'playlists';
    if (el.closest('ytd-watch-flexy, ytd-watch-grid, ytd-watch')) return 'watch';
    if (el.closest('ytd-search')) return 'search';
    const browse = el.closest('ytd-browse');
    if (browse) {
      const subtype = browse.getAttribute('page-subtype');
      if (subtype && Object.prototype.hasOwnProperty.call(BROWSE_SUBTYPES, subtype)) {
        return BROWSE_SUBTYPES[subtype];
      }
      // Unknown subtype: only trust the URL if this browse page is the visible one.
      if (!browse.hasAttribute('hidden')) return sectionFromUrl(href);
      return 'other';
    }
    return sectionFromUrl(href);
  }

  /** True if an element (or an ancestor up to `stop`) is hidden by YouTube itself. */
  function hiddenByYouTube(el, stop) {
    for (let node = el; node && node !== stop; node = node.parentElement) {
      if (node.hasAttribute('hidden')) return true;
      const style = node.style;
      if (style && style.display === 'none') return true;
    }
    return false;
  }

  /**
   * Read the watched percentage of a progress element.
   * Returns a number 0..100, or null if the bar isn't a real/visible one.
   */
  function progressPercent(bar) {
    const width = bar.style ? bar.style.width : '';
    if (width) {
      const m = /^\s*([\d.]+)\s*%\s*$/.exec(width);
      if (m) return Math.min(100, parseFloat(m[1]));
      // Pixel widths: compare against the track.
      const px = /^\s*([\d.]+)\s*px\s*$/.exec(width);
      const track = bar.parentElement;
      if (px && track && track.clientWidth > 0) {
        return Math.min(100, (parseFloat(px[1]) / track.clientWidth) * 100);
      }
    }
    // No inline width: the bar exists but YouTube sizes it some other way.
    // Fall back to layout, and if we can't measure (e.g. we hid the card), assume fully watched.
    const track = bar.parentElement;
    if (bar.clientWidth > 0 && track && track.clientWidth > 0) {
      return Math.min(100, (bar.clientWidth / track.clientWidth) * 100);
    }
    return width === '' ? 100 : 0;
  }

  /** Climb from the innermost matching card to the outermost wrapper card (e.g. rich-item > lockup). */
  function outermostItem(el) {
    let item = el.closest(ITEM_SELECTOR);
    if (!item) return null;
    for (;;) {
      const parent = item.parentElement;
      const up = parent && parent.closest(ITEM_SELECTOR);
      if (!up) break;
      let depth = 0;
      for (let n = item; n && n !== up; n = n.parentElement) depth++;
      if (depth > 6) break;
      item = up;
    }
    return item;
  }

  /**
   * Find every watched video card in `root`.
   * Returns Map<Element, { percent, section }>.
   */
  function findWatched(root, href) {
    const result = new Map();
    const bars = root.querySelectorAll(PROGRESS_SELECTOR);
    for (const bar of bars) {
      if (bar.closest(PLAYER_SELECTOR)) continue;
      const item = outermostItem(bar);
      if (!item) continue;
      if (hiddenByYouTube(bar, item)) continue;
      const percent = progressPercent(bar);
      if (percent === null || percent <= 0) continue;
      const prev = result.get(item);
      if (prev && prev.percent >= percent) continue;
      result.set(item, { percent, section: prev ? prev.section : sectionForElement(item, href) });
    }
    return result;
  }

  /** Decide whether a watched card should be hidden under the given settings. */
  function shouldHide(item, info, settings) {
    if (!settings.enabled) return false;
    if (!settings.sections[info.section]) return false;
    const threshold = settings.threshold || 0;
    if (info.percent < Math.max(threshold, 0.0001)) return false;
    // Never hide the video that is currently playing in a playlist queue.
    if (item.matches('ytd-playlist-panel-video-renderer') && item.hasAttribute('selected')) return false;
    return true;
  }

  function computeHidden(root, href, settings) {
    const hide = new Set();
    if (!settings.enabled) return hide;
    for (const [item, info] of findWatched(root, href)) {
      if (shouldHide(item, info, settings)) hide.add(item);
    }
    return hide;
  }

  /** Shelves whose every video card is in `hidden`. */
  function emptyShelves(hidden) {
    const shelves = new Set();
    const checked = new Set();
    for (const item of hidden) {
      const shelf = item.parentElement && item.parentElement.closest(SHELF_SELECTOR);
      if (!shelf || checked.has(shelf)) continue;
      checked.add(shelf);
      const cards = [...shelf.querySelectorAll(ITEM_SELECTOR)].filter((c) => outermostItem(c) === c);
      if (cards.length > 0 && cards.every((c) => hidden.has(c))) shelves.add(shelf);
    }
    return shelves;
  }

  /** Is this card on the page the user is currently looking at? (for the badge count) */
  function isOnActivePage(el) {
    for (let node = el; node; node = node.parentElement) {
      if (node.hasAttribute && node.hasAttribute('hidden')) return false;
    }
    return true;
  }

  global.WBDetect = {
    PROGRESS_SELECTOR,
    ITEM_SELECTOR,
    SHELF_SELECTOR,
    sectionFromUrl,
    sectionForElement,
    progressPercent,
    outermostItem,
    findWatched,
    shouldHide,
    computeHidden,
    emptyShelves,
    isOnActivePage,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
