/*
 * Settings: schema, defaults and storage.
 * Shared by the content script, popup and background worker. Stored in chrome.storage.sync,
 * so they follow the user's browser account.
 */
(function (global) {
  'use strict';

  /** Sections of YouTube the user can toggle individually. Order = popup order. */
  const SECTIONS = [
    { id: 'home', label: 'Home', hint: 'Home page recommendations' },
    { id: 'watch', label: 'Video sidebar', hint: 'Up next and related videos' },
    { id: 'search', label: 'Search', hint: 'Search results' },
    { id: 'playlists', label: 'Playlists', hint: 'Playlist pages and queues' },
    { id: 'other', label: 'Other pages', hint: 'Trending, Gaming, topics and more' },
    { id: 'channels', label: 'Channels', hint: 'Channel pages' },
    { id: 'subscriptions', label: 'Subscriptions', hint: 'Subscriptions feed' },
    { id: 'history', label: 'History', hint: 'Watch history and the You page' },
  ];

  const DEFAULTS = Object.freeze({
    enabled: true,
    sections: Object.freeze({
      home: true,
      watch: true,
      search: true,
      channels: false,
      playlists: true,
      other: true,
      subscriptions: false,
      history: false,
    }),
    /** Hide a video once it has been watched at least this many percent. 0 = any progress. */
    threshold: 0,
    /** 'hide' removes watched videos from the layout, 'dim' fades them out. */
    mode: 'hide',
  });

  const STORAGE_KEY = 'settings';

  function clampThreshold(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULTS.threshold;
    return Math.min(100, Math.max(0, Math.round(n)));
  }

  /** Merge whatever is stored with the defaults so new options always have a value. */
  function normalize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const sections = {};
    for (const { id } of SECTIONS) {
      const v = src.sections && src.sections[id];
      sections[id] = typeof v === 'boolean' ? v : DEFAULTS.sections[id];
    }
    return {
      enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled,
      sections,
      threshold: src.threshold === undefined ? DEFAULTS.threshold : clampThreshold(src.threshold),
      mode: src.mode === 'dim' ? 'dim' : 'hide',
    };
  }

  function storageArea() {
    const api = global.chrome;
    if (!api || !api.storage) return null;
    return api.storage.sync || api.storage.local;
  }

  async function load() {
    const area = storageArea();
    if (!area) return normalize(null);
    try {
      const data = await area.get(STORAGE_KEY);
      return normalize(data && data[STORAGE_KEY]);
    } catch (err) {
      // storage.sync can be unavailable (e.g. sync disabled by policy); fall back to local.
      try {
        const data = await global.chrome.storage.local.get(STORAGE_KEY);
        return normalize(data && data[STORAGE_KEY]);
      } catch (_) {
        return normalize(null);
      }
    }
  }

  async function save(settings) {
    const value = normalize(settings);
    const area = storageArea();
    if (!area) return value;
    try {
      await area.set({ [STORAGE_KEY]: value });
    } catch (err) {
      await global.chrome.storage.local.set({ [STORAGE_KEY]: value });
    }
    return value;
  }

  async function update(mutator) {
    const current = await load();
    const next = normalize(mutator(structuredCloneSafe(current)) || current);
    return save(next);
  }

  function structuredCloneSafe(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /** Subscribe to settings changes from any context (including other synced browsers). */
  function onChange(callback) {
    const api = global.chrome;
    if (!api || !api.storage || !api.storage.onChanged) return () => {};
    const listener = (changes, areaName) => {
      if ((areaName === 'sync' || areaName === 'local') && changes[STORAGE_KEY]) {
        callback(normalize(changes[STORAGE_KEY].newValue));
      }
    };
    api.storage.onChanged.addListener(listener);
    return () => api.storage.onChanged.removeListener(listener);
  }

  global.WBSettings = { SECTIONS, DEFAULTS, STORAGE_KEY, normalize, load, save, update, onChange };
})(typeof globalThis !== 'undefined' ? globalThis : this);
