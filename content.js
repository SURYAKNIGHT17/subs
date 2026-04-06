(() => {
  'use strict';

  const LOG_PREFIX = '[PointPerfectSubtitles]';
  const VIDEO_RETRY_INTERVAL_MS = 500;
  const VIDEO_RETRY_MAX_ATTEMPTS = 60;

  let videoElement = null;
  let overlayElement = null;
  let hiddenFileInput = null;
  let cues = [];
  let rafId = null;
  let syncRunning = false;
  let currentCueIndex = -1;
  let retries = 0;

  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);
  const error = (...args) => console.error(LOG_PREFIX, ...args);

  function ensureOverlayStyles() {
    if (document.getElementById('pps-overlay-style')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'pps-overlay-style';
    style.textContent = `
      .pps-subtitle-overlay {
        position: absolute;
        left: 50%;
        bottom: 15%;
        transform: translateX(-50%);
        max-width: 80%;
        background: rgba(0, 0, 0, 0.88);
        color: #fff;
        font-size: clamp(22px, 2.4vw, 40px);
        line-height: 1.4;
        padding: 10px 16px;
        border-radius: 6px;
        text-align: center;
        white-space: pre-wrap;
        pointer-events: none;
        z-index: 2147483647;
        font-family: Arial, Helvetica, sans-serif;
        text-shadow: 0 1px 2px rgba(0,0,0,0.75);
        box-sizing: border-box;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function findVideo() {
    const found = document.querySelector('video');
    return found instanceof HTMLVideoElement ? found : null;
  }

  function createOverlayForVideo(video) {
    ensureOverlayStyles();

    if (overlayElement && overlayElement.isConnected) {
      return overlayElement;
    }

    const parent = video.parentElement;
    if (!parent) {
      warn('Video has no parent element. Cannot create overlay yet.');
      return null;
    }

    const parentComputedStyle = window.getComputedStyle(parent);
    if (parentComputedStyle.position === 'static') {
      parent.style.position = 'relative';
    }

    overlayElement = document.createElement('div');
    overlayElement.className = 'pps-subtitle-overlay';
    overlayElement.setAttribute('aria-live', 'polite');
    overlayElement.textContent = '';

    parent.appendChild(overlayElement);
    log('Subtitle overlay created.');
    return overlayElement;
  }

  function ensureFileInput() {
    if (hiddenFileInput && hiddenFileInput.isConnected) {
      return;
    }

    hiddenFileInput = document.createElement('input');
    hiddenFileInput.type = 'file';
    hiddenFileInput.accept = '.vtt,text/vtt';
    hiddenFileInput.style.display = 'none';

    hiddenFileInput.addEventListener('change', async () => {
      const file = hiddenFileInput.files && hiddenFileInput.files[0];
      if (!file) {
        warn('File selection canceled or no file selected.');
        hiddenFileInput.value = '';
        return;
      }

      try {
        const text = await file.text();
        const parsedCues = parseWebVTT(text);
        cues = parsedCues;
        currentCueIndex = -1;
        log(`Loaded ${cues.length} cue(s) from ${file.name}.`);
      } catch (err) {
        error('Failed to parse VTT file:', err);
        cues = [];
        currentCueIndex = -1;
      } finally {
        hiddenFileInput.value = '';
        updateOverlayText('');
        if (videoElement && !videoElement.paused && !videoElement.ended) {
          startSyncLoop();
        }
      }
    });

    document.documentElement.appendChild(hiddenFileInput);
    log('Hidden file input injected.');
  }

  function timestampToSeconds(timestamp) {
    const trimmed = timestamp.trim();
    const match = trimmed.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
    if (!match) {
      throw new Error(`Invalid timestamp format: "${timestamp}"`);
    }

    const [, hh, mm, ss, mmm] = match;
    const hours = Number(hh);
    const minutes = Number(mm);
    const seconds = Number(ss);
    const millis = Number(mmm);

    if (minutes > 59 || seconds > 59) {
      throw new Error(`Invalid timestamp ranges: "${timestamp}"`);
    }

    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
  }

  function parseWebVTT(vttText) {
    if (typeof vttText !== 'string' || !vttText.trim()) {
      throw new Error('VTT text is empty.');
    }

    const normalized = vttText.replace(/^\uFEFF/, '');
    const lines = normalized.split(/\r?\n/);
    let i = 0;

    if (lines[i] && lines[i].trim().toUpperCase().startsWith('WEBVTT')) {
      i += 1;
      while (i < lines.length && lines[i].trim() !== '') {
        i += 1;
      }
    }

    const parsed = [];

    while (i < lines.length) {
      while (i < lines.length && lines[i].trim() === '') {
        i += 1;
      }
      if (i >= lines.length) {
        break;
      }

      let timingLine = lines[i].trim();

      if (!timingLine.includes('-->')) {
        i += 1;
        if (i >= lines.length) {
          break;
        }
        timingLine = lines[i].trim();
      }

      if (!timingLine.includes('-->')) {
        warn('Skipping malformed cue block near line', i + 1);
        i += 1;
        continue;
      }

      const [rawStart, rawEndWithSettings] = timingLine.split('-->');
      const rawEnd = rawEndWithSettings.trim().split(/\s+/)[0];

      let start;
      let end;
      try {
        start = timestampToSeconds(rawStart);
        end = timestampToSeconds(rawEnd);
      } catch (err) {
        warn('Skipping cue due to invalid timestamp:', err.message);
        i += 1;
        while (i < lines.length && lines[i].trim() !== '') {
          i += 1;
        }
        continue;
      }

      if (!(end > start)) {
        warn('Skipping cue where end <= start at line', i + 1);
        i += 1;
        while (i < lines.length && lines[i].trim() !== '') {
          i += 1;
        }
        continue;
      }

      i += 1;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i]);
        i += 1;
      }

      const text = textLines.join('\n').trim();
      if (!text) {
        warn('Skipping cue with empty text near line', i + 1);
        continue;
      }

      parsed.push({ start, end, text });
    }

    parsed.sort((a, b) => a.start - b.start);

    if (parsed.length === 0) {
      throw new Error('No valid cues found in VTT file.');
    }

    return parsed;
  }

  function updateOverlayText(text) {
    if (!overlayElement) {
      return;
    }
    overlayElement.textContent = text || '';
  }

  function findActiveCueIndex(currentTime) {
    if (!cues.length) {
      return -1;
    }

    if (currentCueIndex >= 0) {
      const currentCue = cues[currentCueIndex];
      if (currentCue && currentTime >= currentCue.start && currentTime <= currentCue.end) {
        return currentCueIndex;
      }

      const nextCue = cues[currentCueIndex + 1];
      if (nextCue && currentTime >= nextCue.start && currentTime <= nextCue.end) {
        return currentCueIndex + 1;
      }
    }

    for (let idx = 0; idx < cues.length; idx += 1) {
      const cue = cues[idx];
      if (currentTime >= cue.start && currentTime <= cue.end) {
        return idx;
      }
      if (cue.start > currentTime) {
        break;
      }
    }

    return -1;
  }

  function syncSubtitles() {
    if (!syncRunning || !videoElement) {
      return;
    }

    if (videoElement.ended || videoElement.paused) {
      stopSyncLoop();
      return;
    }

    const activeIndex = findActiveCueIndex(videoElement.currentTime);
    if (activeIndex !== currentCueIndex) {
      currentCueIndex = activeIndex;
      updateOverlayText(activeIndex >= 0 ? cues[activeIndex].text : '');
    }

    rafId = window.requestAnimationFrame(syncSubtitles);
  }

  function startSyncLoop() {
    if (syncRunning) {
      return;
    }

    if (!videoElement) {
      warn('Cannot start sync loop: no video element.');
      return;
    }

    syncRunning = true;
    rafId = window.requestAnimationFrame(syncSubtitles);
    log('Subtitle sync loop started.');
  }

  function stopSyncLoop() {
    if (!syncRunning) {
      return;
    }

    syncRunning = false;
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    log('Subtitle sync loop stopped.');
  }

  function clearSubtitles() {
    cues = [];
    currentCueIndex = -1;
    updateOverlayText('');
    log('Cleared loaded subtitles.');
  }

  function attachVideoListeners(video) {
    video.addEventListener('play', startSyncLoop);
    video.addEventListener('pause', stopSyncLoop);
    video.addEventListener('ended', () => {
      stopSyncLoop();
      updateOverlayText('');
      currentCueIndex = -1;
    });
    video.addEventListener('seeking', () => {
      currentCueIndex = -1;
    });
  }

  function initialize() {
    videoElement = findVideo();

    if (!videoElement) {
      retries += 1;
      if (retries <= VIDEO_RETRY_MAX_ATTEMPTS) {
        log(`No <video> found yet. Retrying (${retries}/${VIDEO_RETRY_MAX_ATTEMPTS})...`);
        window.setTimeout(initialize, VIDEO_RETRY_INTERVAL_MS);
      } else {
        warn('No <video> found after maximum retries. Extension remains idle.');
      }
      return;
    }

    log('Video element found. Initializing subtitle system.');
    createOverlayForVideo(videoElement);
    ensureFileInput();
    attachVideoListeners(videoElement);

    if (!videoElement.paused && !videoElement.ended) {
      startSyncLoop();
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (!videoElement || !videoElement.isConnected) {
      videoElement = findVideo();
      if (videoElement && !overlayElement) {
        createOverlayForVideo(videoElement);
        attachVideoListeners(videoElement);
      }
    }

    switch (message.type) {
      case 'PPS_LOAD_VTT':
        ensureFileInput();
        if (!videoElement) {
          warn('Load requested but no video element is available on this page.');
          sendResponse({ ok: false, error: 'No video element found on this page.' });
          return true;
        }
        hiddenFileInput.click();
        sendResponse({ ok: true });
        return true;

      case 'PPS_CLEAR_SUBTITLES':
        clearSubtitles();
        sendResponse({ ok: true });
        return true;

      default:
        warn('Unknown message type:', message.type);
        sendResponse({ ok: false, error: 'Unknown message type.' });
        return true;
    }
  });

  initialize();
})();
