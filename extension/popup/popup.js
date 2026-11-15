(function () {
  'use strict';

  const Settings = window.WBSettings;
  const $ = (id) => document.getElementById(id);

  let settings = Settings.normalize(null);
  let targetTabId = null;
  let currentSection = null;
  let statusTimer = 0;

  // --- Rendering -----------------------------------------------------------

  function buildSections() {
    const list = $('sections');
    const tpl = $('section-row');
    for (const section of Settings.SECTIONS) {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.dataset.section = section.id;
      row.querySelector('.row__name').textContent = section.label;
      row.querySelector('.row__label').title = section.hint;
      const input = row.querySelector('input');
      input.id = `section-${section.id}`;
      input.setAttribute('aria-label', section.label);
      input.addEventListener('change', () => {
        settings.sections[section.id] = input.checked;
        persist();
      });
      list.appendChild(row);
    }
  }

  const thresholdLabel = (value) => (value <= 0 ? 'Any' : `${value}%`);

  function render() {
    $('enabled').checked = settings.enabled;
    document.body.classList.toggle('is-off', !settings.enabled);

    for (const row of document.querySelectorAll('.row')) {
      const id = row.dataset.section;
      row.querySelector('input').checked = Boolean(settings.sections[id]);
      row.classList.toggle('is-current', id === currentSection);
    }

    $('threshold').value = String(settings.threshold);
    $('threshold-value').textContent = thresholdLabel(settings.threshold);

    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.checked = radio.value === settings.mode;
    }
  }

  function setStatus(count, text, neutral) {
    $('status-count').textContent = count;
    $('status-text').textContent = text;
    $('status').classList.toggle('is-neutral', Boolean(neutral));
  }

  // --- Tab status ----------------------------------------------------------

  async function resolveTargetTab() {
    // ?tabId= lets the test suite point the popup at a specific tab.
    const forced = Number(new URLSearchParams(location.search).get('tabId'));
    if (Number.isInteger(forced) && forced > 0) return forced;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https:\/\/www\.youtube\.com\//.test(tab.url)) return null;
    return tab.id;
  }

  function requestStatus() {
    if (targetTabId === null) {
      currentSection = null;
      setStatus('–', 'Not on YouTube', true);
      render();
      return;
    }
    chrome.tabs.sendMessage(targetTabId, { type: 'wb:status' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        currentSection = null;
        setStatus('–', 'Reload the page to start', true);
        render();
        return;
      }
      currentSection = res.section;
      const label = (Settings.SECTIONS.find((s) => s.id === res.section) || {}).label || 'this page';
      if (!settings.enabled) {
        setStatus('–', 'Paused', true);
      } else if (!res.sectionEnabled) {
        setStatus('–', `Off for ${label}`, true);
      } else {
        const verb = settings.mode === 'dim' ? 'dimmed' : 'hidden';
        setStatus(String(res.count), `${verb} on this page`, res.count === 0);
      }
      render();
    });
  }

  function refreshStatusSoon() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(requestStatus, 150);
  }

  // --- Persistence ---------------------------------------------------------

  async function persist() {
    render();
    settings = await Settings.save(settings);
    refreshStatusSoon();
  }

  // --- Footer --------------------------------------------------------------

  async function renderFooter() {
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
    try {
      const commands = await chrome.commands.getAll();
      const toggle = commands.find((c) => c.name === 'toggle-enabled');
      if (toggle && toggle.shortcut) $('shortcut').textContent = `${toggle.shortcut} to toggle`;
    } catch (_) {
      // commands API unavailable; leave the footer without a shortcut.
    }
  }

  // --- Wiring --------------------------------------------------------------

  function wire() {
    $('enabled').addEventListener('change', (e) => {
      settings.enabled = e.target.checked;
      persist();
    });

    const threshold = $('threshold');
    threshold.addEventListener('input', () => {
      $('threshold-value').textContent = thresholdLabel(Number(threshold.value));
    });
    threshold.addEventListener('change', () => {
      settings.threshold = Number(threshold.value);
      persist();
    });

    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          settings.mode = radio.value;
          persist();
        }
      });
    }

    // Changes made elsewhere (another synced browser, the keyboard shortcut) show up live.
    Settings.onChange((next) => {
      settings = next;
      render();
      refreshStatusSoon();
    });
  }

  async function init() {
    buildSections();
    wire();
    renderFooter();
    settings = await Settings.load();
    render();
    try {
      targetTabId = await resolveTargetTab();
    } catch (_) {
      targetTabId = null;
    }
    requestStatus();
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('animate')));
    document.body.dataset.ready = 'true';
  }

  init();
})();
