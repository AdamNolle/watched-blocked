/*
 * Background service worker.
 * - Shows the number of hidden videos on the toolbar badge (per tab).
 * - Greys out the toolbar icon while the extension is turned off.
 * - Handles the Alt+Shift+W keyboard shortcut.
 * - Injects the content script into YouTube tabs that were already open at install/update time.
 */
importScripts('../shared/settings.js');

const Settings = self.WBSettings;

const ICONS_ON = {
  16: '/icons/icon-16.png',
  32: '/icons/icon-32.png',
  48: '/icons/icon-48.png',
  128: '/icons/icon-128.png',
};
const ICONS_OFF = {
  16: '/icons/icon-off-16.png',
  32: '/icons/icon-off-32.png',
  48: '/icons/icon-off-48.png',
  128: '/icons/icon-off-128.png',
};

const CONTENT_FILES = ['shared/settings.js', 'content/detect.js', 'content/content.js'];

async function applyEnabledState(settings) {
  const enabled = settings.enabled;
  try {
    await chrome.action.setIcon({ path: enabled ? ICONS_ON : ICONS_OFF });
    await chrome.action.setTitle({
      title: enabled ? 'Watched Blocked' : 'Watched Blocked (off)',
    });
  } catch (err) {
    console.warn('[Watched Blocked] could not update icon', err);
  }
}

async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  } catch (_) {
    return;
  }
  for (const tab of tabs) {
    if (tab.id === undefined || tab.discarded) continue;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    } catch (_) {
      // Tab may be loading, crashed, or otherwise unavailable; it will get the script on next load.
    }
  }
}

chrome.action.setBadgeBackgroundColor({ color: '#cc0000' }).catch(() => {});
if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Don't write defaults here: on a freshly installed browser that would race with (and could
  // overwrite) the settings arriving from the user's other synced browsers.
  await applyEnabledState(await Settings.load());
  // On a fresh install or an extension update, already-open YouTube tabs don't have the
  // (new) content script yet. A browser update keeps the existing scripts, so skip it then.
  if (reason === 'install' || reason === 'update') await injectIntoOpenTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await applyEnabledState(await Settings.load());
});

Settings.onChange((settings) => {
  applyEnabledState(settings);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'wb:count' || !sender.tab || sender.tab.id === undefined) return;
  const text = msg.count > 0 ? (msg.count > 999 ? '999+' : String(msg.count)) : '';
  chrome.action.setBadgeText({ tabId: sender.tab.id, text }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-enabled') return;
  await Settings.update((s) => {
    s.enabled = !s.enabled;
    return s;
  });
});
