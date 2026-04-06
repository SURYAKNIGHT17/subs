(() => {
  'use strict';

  const LOG_PREFIX = '[PointPerfectSubtitles:Popup]';

  const loadButton = document.getElementById('loadVttBtn');
  const clearButton = document.getElementById('clearBtn');
  const statusEl = document.getElementById('status');

  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const error = (...args) => console.error(LOG_PREFIX, ...args);

  function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.style.color = isError ? '#b3261e' : '#555';
  }

  async function getActiveTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No active tab found.');
    }

    return tab.id;
  }

  async function sendMessageToContentScript(type) {
    const tabId = await getActiveTabId();

    try {
      const response = await chrome.tabs.sendMessage(tabId, { type });
      return response;
    } catch (err) {
      error('Message dispatch failed:', err);
      throw new Error('Could not communicate with content script on this page.');
    }
  }

  loadButton.addEventListener('click', async () => {
    setStatus('Opening file picker...');
    log('Load button clicked.');

    try {
      const response = await sendMessageToContentScript('PPS_LOAD_VTT');
      if (!response?.ok) {
        throw new Error(response?.error || 'Load request was rejected.');
      }
      setStatus('Select a .vtt file in the page context.');
    } catch (err) {
      error('Load action failed:', err);
      setStatus(err.message, true);
    }
  });

  clearButton.addEventListener('click', async () => {
    setStatus('Clearing subtitles...');
    log('Clear button clicked.');

    try {
      const response = await sendMessageToContentScript('PPS_CLEAR_SUBTITLES');
      if (!response?.ok) {
        throw new Error(response?.error || 'Clear request was rejected.');
      }
      setStatus('Subtitles cleared.');
    } catch (err) {
      error('Clear action failed:', err);
      setStatus(err.message, true);
    }
  });
})();
